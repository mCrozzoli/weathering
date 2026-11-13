"""The simulated room, in Python (same model as app/static/js/room.js).

A white box with windows, gallery lights 10–18 h and visitors: plausible
CO2, temperature, humidity, light and sound level, deterministic per seed.
"""
from __future__ import annotations

import math
import time


def mulberry32(seed: int):
    a = seed & 0xFFFFFFFF

    def imul(x, y):
        return (x * y) & 0xFFFFFFFF

    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rnd


def _smooth(seed: int, unix: float, period: float) -> float:
    k = math.floor(unix / period)
    f = unix / period - k

    def r(i):
        return mulberry32((seed * 7919 + i * 104729) & 0xFFFFFFFF)()
    w = (1 - math.cos(math.pi * f)) / 2
    return r(k) * (1 - w) + r(k + 1) * w


class Room:
    def __init__(self, seed: int = 1, tz_offset_h: float | None = None, open_hours=(10, 18)):
        self.seed = seed
        if tz_offset_h is None:
            tz_offset_h = -time.timezone / 3600 + (1 if time.localtime().tm_isdst else 0)
        self.tz = tz_offset_h
        self.open = open_hours
        self.co2 = 430.0
        self.visitors = 0.0
        self.last = None
        self.rand = mulberry32(seed)

    def read(self, unix: float) -> dict:
        h = ((unix / 3600 + self.tz) % 24 + 24) % 24
        dt = 300 if self.last is None else max(0, min(3600, unix - self.last))
        self.last = unix
        is_open = self.open[0] <= h < self.open[1]
        crowd = 1 + 9 * _smooth(self.seed + 11, unix, 2400) ** 2 if is_open else 0
        self.visitors += (crowd - self.visitors) * min(1, dt / 900)
        v = max(0.0, self.visitors + ((self.rand() - 0.5) * 1.5 if is_open else 0))
        sun = max(0.0, math.sin(((h - 6.5) / 13) * math.pi))
        cloud = 0.35 + 0.65 * _smooth(self.seed + 3, unix, 5400)
        lux = 2 + 260 * sun * cloud + (380 if is_open else 0) + (self.rand() - 0.5) * 6
        drift = (_smooth(self.seed + 5, unix, 86400 * 3) - 0.5) * 2.0
        t = 20 + 1.4 * math.sin(((h - 9) / 24) * 2 * math.pi) + 0.12 * v + drift + (self.rand() - 0.5) * 0.1
        rh = 46 - (t - 20) * 2.2 + (_smooth(self.seed + 7, unix, 86400) - 0.5) * 8 + (self.rand() - 0.5) * 0.6
        target = 420 + 45 * v
        self.co2 += (target - self.co2) * (1 - math.exp(-dt / 2400))
        co2 = self.co2 + (self.rand() - 0.5) * 6
        db = -62 + 9 * math.log10(1 + 3 * v) + (self.rand() - 0.5) * 2
        return {"co2": round(co2), "t": round(t, 2), "rh": round(max(15, min(85, rh)), 1),
                "lux": round(max(0, lux)), "db": round(db)}
