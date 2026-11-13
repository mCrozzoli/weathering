"""A show on disk: everything an installation has lived, kept so that a
crash, a closed tab or a power cut loses nothing.

    ~/.weathering/shows/<show>/
        readings.csv   append-only, one line per reading, flushed at once
        runs.jsonl     one line per 12-hour run (the poses)
        show.json      name, start, run times, driving algorithm, settings

Restart = open the same show again: everything reloads from these files.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from .protocol import CSV_HEADER, reading_to_csv

ROOT = Path(os.environ.get("WEATHERING_HOME", Path.home() / ".weathering")) / "shows"

DEFAULT_SETTINGS = {
    "run_times": ["06:00", "18:00"],
    "driving": "som",
    "examples": [],
    "show_days": 14,
    "glide_s": 60,
}


def safe_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9 _.-]", "", (name or "").strip())[:60].strip(" .")
    return name or "show"


class Show:
    def __init__(self, name: str, root: Path = ROOT):
        self.name = safe_name(name)
        self.dir = Path(root) / self.name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.readings_path = self.dir / "readings.csv"
        self.runs_path = self.dir / "runs.jsonl"
        self.meta_path = self.dir / "show.json"
        self._lock = threading.Lock()
        if not self.readings_path.exists():
            self.readings_path.write_text(CSV_HEADER + "\n")
        if not self.meta_path.exists():
            self._write_meta({"name": self.name, "created": int(time.time()), **DEFAULT_SETTINGS})
        # readings already stored, so a re-sent backlog isn't stored twice
        self._seen = set()
        for line in self.readings_path.read_text().splitlines()[1:]:
            p = line.split(",")
            if len(p) >= 2:
                self._seen.add((p[0], p[1]))

    # -------------------------------------------------------------- meta
    def meta(self) -> dict:
        try:
            m = json.loads(self.meta_path.read_text())
        except (OSError, ValueError):
            m = {"name": self.name}
        return {**DEFAULT_SETTINGS, **m}

    def _write_meta(self, m: dict) -> None:
        tmp = self.meta_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(m, indent=2))
        os.replace(tmp, self.meta_path)          # atomic: never a half-written file

    def update_meta(self, changes: dict) -> dict:
        with self._lock:
            m = self.meta()
            for k, v in changes.items():
                if k in ("run_times", "driving", "show_days", "glide_s", "notes"):
                    m[k] = v
                elif k == "examples" and isinstance(v, list) and len(v) <= 64:
                    m[k] = v                      # taught shapes: [{run, input, output}]
            self._write_meta(m)
            return m

    # ---------------------------------------------------------- readings
    def add_reading(self, r: dict) -> bool:
        key = (str(r["unix"]), str(r["seq"]))
        with self._lock:
            if key in self._seen:
                return False
            self._seen.add(key)
            with open(self.readings_path, "a") as f:
                f.write(reading_to_csv(r) + "\n")
                f.flush()
                os.fsync(f.fileno())
            return True

    def readings_csv(self) -> str:
        return self.readings_path.read_text()

    def count(self) -> int:
        return len(self._seen)

    def last_unix(self) -> int | None:
        return max((int(u) for u, _ in self._seen), default=None)

    # -------------------------------------------------------------- runs
    def add_run(self, run: dict) -> None:
        with self._lock, open(self.runs_path, "a") as f:
            f.write(json.dumps(run, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def runs(self) -> list[dict]:
        if not self.runs_path.exists():
            return []
        out = []
        for line in self.runs_path.read_text().splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass                              # a torn last line after a power cut
        return out


def list_shows(root: Path = ROOT) -> list[dict]:
    root = Path(root)
    if not root.exists():
        return []
    out = []
    for d in sorted(root.iterdir()):
        if (d / "show.json").exists():
            n = max(0, sum(1 for _ in open(d / "readings.csv")) - 1) if (d / "readings.csv").exists() else 0
            out.append({"name": d.name, "readings": n, "modified": int((d / "readings.csv").stat().st_mtime) if n else 0})
    out.sort(key=lambda s: -s["modified"])
    return out
