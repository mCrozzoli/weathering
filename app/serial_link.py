"""The hub on USB: a reader thread hands every line to `on_line`; `send`
writes one. If the hub is unplugged, the link keeps trying the same port
every 2 s, so plugging it back in just continues. On every (re)connect, and
every 5 minutes, it sends TIME: the sensor stamps readings with it, and the
hub only forwards readings while the computer has spoken in the last 30 min
(otherwise they wait safely in the sensor's backlog).
"""
from __future__ import annotations

import threading
import time
from typing import Callable

try:
    import serial                                    # pyserial
    from serial.tools import list_ports
except ImportError:                                  # tests without pyserial
    serial = None
    list_ports = None

BAUD = 115200
TIME_EVERY_S = 300
ESP_VIDS = {0x10C4, 0x1A86, 0x0403, 0x303A}         # CP210x, CH340, FTDI, Espressif


def ports() -> list[dict]:
    if list_ports is None:
        return []
    out = []
    for p in list_ports.comports():
        if "Bluetooth" in (p.device or "") or "debug-console" in (p.device or ""):
            continue
        out.append({
            "device": p.device,
            "label": p.description or p.device,
            "esp": (p.vid in ESP_VIDS) if p.vid else False,
        })
    out.sort(key=lambda p: (not p["esp"], p["device"]))
    return out


class SerialLink:
    def __init__(self, on_line: Callable[[str], None], on_status: Callable[[dict], None]):
        self.on_line = on_line
        self.on_status = on_status
        self.port = None
        self._ser = None
        self._stop = threading.Event()
        self._thread = None
        self._wlock = threading.Lock()
        self.connected = False

    def status(self) -> dict:
        return {"connected": self.connected, "port": self.port}

    def open(self, port: str) -> None:
        self.close()
        self.port = port
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="hub-serial")
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._ser = None
        self._thread = None
        self.port = None
        self._set_connected(False)

    def send(self, line: str) -> bool:
        ser = self._ser
        if ser is None:
            return False
        try:
            with self._wlock:
                ser.write((line.strip() + "\n").encode())
            return True
        except Exception:
            return False

    # ------------------------------------------------------------ inside
    def _set_connected(self, ok: bool) -> None:
        if ok != self.connected:
            self.connected = ok
            self.on_status(self.status())

    def _run(self) -> None:
        last_time = 0.0
        while not self._stop.is_set():
            if self._ser is None:
                try:
                    if serial is None:
                        raise OSError("pyserial is not installed")
                    # dsrdtr/rtscts off and DTR/RTS low: opening the port must not
                    # reset the ESP32 into its bootloader
                    s = serial.Serial()
                    s.port, s.baudrate, s.timeout = self.port, BAUD, 0.5
                    s.dtr = False
                    s.rts = False
                    s.open()
                    self._ser = s
                    self._set_connected(True)
                    last_time = 0.0
                except Exception as e:
                    self._set_connected(False)
                    self.on_line(f"LOG (app) waiting for the hub on {self.port}: {e}")
                    self._stop.wait(2.0)
                    continue
            now = time.time()
            if now - last_time > TIME_EVERY_S:
                first = not last_time
                last_time = now
                if first:
                    self.send("NODES")
                self.send(f"TIME {int(now)}")
            try:
                raw = self._ser.readline()
            except Exception:
                try:
                    self._ser.close()
                except Exception:
                    pass
                self._ser = None
                self._set_connected(False)
                continue
            if raw:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    self.on_line(line)
