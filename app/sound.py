"""SuperCollider, started and watched by the local app.

`Sound.start()` runs sclang with sc/weathering_sound.scd, reads its output
until "WEATHERING SOUND READY … port N", and from then on the app sends it
OSC on that port: the context of each run, the body's pose, touches. Its
output goes to ~/.weathering/sound.log. If SuperCollider isn't installed,
the show runs silently and the page says so.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

from .osc import OscOut

SCD = Path(__file__).resolve().parents[1] / "sc" / "weathering_sound.scd"
CANDIDATES = [
    "/Applications/SuperCollider.app/Contents/MacOS/sclang",
    "/Applications/SuperCollider/SuperCollider.app/Contents/MacOS/sclang",
    "/usr/bin/sclang", "/usr/local/bin/sclang",
]


def find_sclang() -> str | None:
    p = os.environ.get("WX_SCLANG") or shutil.which("sclang")
    if p:
        return p
    return next((c for c in CANDIDATES if os.path.exists(c)), None)


class Sound:
    def __init__(self, log_dir: Path, mode: str = "virtual", on_line=None, extra_env=None):
        self.mode = mode
        self.log_path = Path(log_dir) / "sound.log"
        self.on_line = on_line or (lambda line: None)
        self.extra_env = extra_env or {}
        self.proc = None
        self.port = None
        self.ready = threading.Event()
        self.state = "off"                         # off | missing | starting | ready | stopped
        self.osc = None

    def start(self) -> bool:
        sclang = find_sclang()
        if not sclang:
            self.state = "missing"
            return False
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "WX_MODE": self.mode, **self.extra_env}
        self.proc = subprocess.Popen(
            [sclang, str(SCD)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, text=True, bufsize=1, env=env, start_new_session=True)
        self.state = "starting"
        threading.Thread(target=self._read, daemon=True, name="sclang-out").start()
        return True

    def _read(self) -> None:
        with open(self.log_path, "w") as log:
            for line in self.proc.stdout:
                log.write(line)
                log.flush()
                m = re.search(r"WEATHERING SOUND READY mode (\w+) port (\d+)", line)
                if m:
                    self.port = int(m.group(2))
                    self.osc = OscOut(port=self.port)
                    self.state = "ready"
                    self.ready.set()
                if line.startswith("WX "):
                    self.on_line(line.strip())
        if self.state != "stopped":
            self.state = "stopped"

    def send(self, address: str, *args) -> None:
        if self.osc is not None:
            self.osc.send(address, *args)

    def stop(self, timeout: float = 4.0) -> None:
        if self.proc is None or self.proc.poll() is not None:
            return
        self.send("/wx/quit")
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        # sclang's scsynth child, if anything is left of it
        subprocess.run(["pkill", "-f", f"scsynth.*{os.getpid()}"], capture_output=True)
        self.state = "stopped"
