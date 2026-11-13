"""The parts of the hub's USB protocol the local app needs (docs/PROTOCOL.md).

The browser does the rest (app/static/js/protocol.js). The CSV columns are
the same on both sides; tests/test_app.py checks they agree.
"""
from __future__ import annotations

CHANNELS = ("co2", "t", "rh", "lux", "db")
CSV_HEADER = "unix,seq,co2,t,rh,lux,db,sim,old"


def parse_reading(line: str) -> dict | None:
    """'R <unix> <seq> co2=… t=… … [sim=a,b] [old]' -> dict, else None."""
    parts = line.strip().split()
    if len(parts) < 3 or parts[0] != "R":
        return None
    try:
        unix = int(float(parts[1]))
        seq = int(float(parts[2]))
    except ValueError:
        return None
    r = {"unix": unix, "seq": seq, "sim": [], "old": False}
    for c in CHANNELS:
        r[c] = None
    for p in parts[3:]:
        if p == "old":
            r["old"] = True
        elif "=" in p:
            k, v = p.split("=", 1)
            if k == "sim":
                r["sim"] = [s for s in v.split(",") if s]
            elif k in CHANNELS:
                try:
                    r[k] = float(v)
                except ValueError:
                    pass
    return r


def _fmt(x) -> str:
    if x is None:
        return ""
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def reading_to_csv(r: dict) -> str:
    return ",".join([
        str(r["unix"]), str(r["seq"]),
        *(_fmt(r[c]) for c in CHANNELS),
        ";".join(r.get("sim") or []),
        "1" if r.get("old") else "0",
    ])
