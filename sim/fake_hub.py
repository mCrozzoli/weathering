"""A pretend hub on a pseudo-USB port, for the local app without hardware.

    python -m sim.fake_hub --speed 720      prints a port like /dev/ttys004

It speaks the hub's USB lines (docs/PROTOCOL.md) and has a pretend sensor
box (sim/room.py) and sculpture behind it. Its clock runs SPEED × real
time, so a 12-hour run comes round in a minute at ×720. The local app
starts one itself with `python -m app --fake`.
"""
from __future__ import annotations

import argparse
import os
import pty
import select
import threading
import time
import tty

from sim.room import Room

FW = "0.2.0-sim"
CHANNELS = ("co2", "t", "rh")              # the SCD30; lux and db are optional
MOTORS = 4


class FakeHub:
    def __init__(self, write, speed: float = 60.0, start_unix: float | None = None,
                 interval: int = 300, seed: int = 1):
        self._write = write
        self.speed = max(1.0, speed)
        self.interval = interval
        self.room = Room(seed=seed)
        self.clock = float(start_unix if start_unix is not None else time.time())
        self.next_reading = self.clock
        self.seq = 0
        self.pose = [1.0] * MOTORS                # pulls: the body starts closed
        self.src = self.pose[:]
        self.target = self.pose[:]
        self.glide_start, self.glide_dur = 0.0, 0.0
        self.last_body = 0.0
        self._lock = threading.Lock()

    def say(self, line: str) -> None:
        self._write((line + "\n").encode())

    def boot(self) -> None:
        self.say(f"FW weathering_hub {FW} mac 5E:AA:00:00:00:02 group 1")
        self.nodes()

    def nodes(self) -> None:
        self.say(f"NODE sensor 5E:AA:00:00:00:01 fw {FW} rssi -48")
        self.say(f"NODE body 5E:AA:00:00:00:03 fw {FW} rssi -55")

    def handle(self, line: str) -> None:
        p = line.strip().split()
        if not p:
            return
        cmd = p[0]
        with self._lock:
            if cmd == "PING":
                self.say("PONG")
            elif cmd == "INFO":
                self.say(f"INFO hub fw {FW} mac 5E:AA:00:00:00:02 group 1")
            elif cmd == "NODES":
                self.nodes()
            elif cmd == "TIME":
                self.say("OK TIME")                  # keeps its own (fast) clock
            elif cmd == "READ":
                self._reading(now=True)
            elif cmd == "POSE" and len(p) == 3 + MOTORS:
                try:
                    seq = int(p[1])
                    vals = [min(1.0, max(0.0, float(x))) for x in p[2:2 + MOTORS]]
                    glide = float(p[2 + MOTORS])
                except ValueError:
                    self.say("ERR bad pose")
                    return
                self.say(f"OK POSE {seq}")
                self.src, self.target = self.pose[:], vals
                self.glide_start, self.glide_dur = self.clock, glide
                self.say(f"ACK body {seq}")
            elif cmd in ("TEST", "RELAX"):
                self.say(f"OK {cmd}")
            elif cmd == "CFG":
                if len(p) > 1 and p[1] == "sensor":
                    for kv in p[2:]:
                        if kv.startswith("interval="):
                            self.interval = max(10, int(kv.split("=")[1]))
                self.say("OK CFG")
            else:
                self.say(f"ERR unknown {cmd}")

    def _reading(self, now: bool = False) -> None:
        unix = int(self.clock if now else self.next_reading)
        v = self.room.read(unix)
        vals = " ".join(f"{c}={v[c]}" for c in CHANNELS)
        self.say(f"R {unix} {self.seq} {vals} sim={','.join(CHANNELS)}")
        self.seq += 1
        if not now:
            self.next_reading += self.interval

    def advance(self, real_dt: float) -> None:
        with self._lock:
            end = self.clock + real_dt * self.speed
            while self.next_reading <= end:
                self.clock = self.next_reading
                self._reading()
            self.clock = end
            k = 1.0 if self.glide_dur <= 0 else min(1.0, (self.clock - self.glide_start) / self.glide_dur)
            new = [a + (b - a) * k for a, b in zip(self.src, self.target)]
            changed = any(abs(a - b) > 1e-4 for a, b in zip(new, self.pose))
            self.pose = new
            if changed and (time.monotonic() - self.last_body > 0.3 or k >= 1):
                self.last_body = time.monotonic()
                self.say("BODY " + " ".join(f"{a:.3f}" for a in self.pose) + f" moving={0 if k >= 1 else 1} homed=1 found=15")


class PtyHub:
    """A FakeHub behind a pseudo-terminal the app can open like a USB port."""

    def __init__(self, speed: float = 60.0, **kw):
        self.master, slave = pty.openpty()
        tty.setraw(slave)
        self.port_name = os.ttyname(slave)
        self._slave = slave                       # keep it open so the port exists
        self.hub = FakeHub(self._write, speed=speed, **kw)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="fake-hub")

    def _write(self, data: bytes) -> None:
        try:
            os.write(self.master, data)
        except OSError:
            pass

    def start(self) -> "PtyHub":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        self.hub.boot()
        buf = b""
        last = time.monotonic()
        while not self._stop.is_set():
            r, _, _ = select.select([self.master], [], [], 0.1)
            if r:
                try:
                    buf += os.read(self.master, 1024)
                except OSError:
                    break
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self.hub.handle(line.decode("utf-8", "replace"))
            now = time.monotonic()
            self.hub.advance(now - last)
            last = now


def start_pty(speed: float = 60.0, **kw) -> PtyHub:
    return PtyHub(speed=speed, **kw).start()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", type=float, default=60.0)
    a = ap.parse_args()
    h = start_pty(a.speed)
    print(f"pretend hub on {h.port_name}  (×{a.speed:g}; Ctrl+C to stop)", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        h.stop()
