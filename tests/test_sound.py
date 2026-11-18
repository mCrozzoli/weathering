"""The sound engine, headless: SuperCollider runs muted (WX_MASTER=0) with the
virtual panel and records what the panels would play. The recording proves
the behaviour the meeting asked for:

  silent until touched → a touch rings → it dies away → silent again,
  and the safety holds even when the loop is driven far too hard.

Skipped when SuperCollider isn't installed.
"""
from __future__ import annotations

import math
import struct
import time
import wave
from pathlib import Path

import pytest

from app.osc import decode, encode
from app.sound import Sound, find_sclang


def test_osc_round_trip():
    pkt = encode("/wx/context", "openness", 0.5, "kind", 2, "label", "busy")
    assert len(pkt) % 4 == 0
    addr, args = decode(pkt)
    assert addr == "/wx/context"
    assert args[0] == "openness" and abs(args[1] - 0.5) < 1e-6 and args[3] == 2 and args[5] == "busy"


def _rms_windows(path: Path, win_s: float = 0.25):
    with wave.open(str(path)) as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = w.readframes(n)
    samples = struct.unpack(f"<{len(raw) // 2}h", raw)
    left = samples[0::ch]
    step = int(sr * win_s)
    rms, peak = [], 0.0
    for i in range(0, len(left) - step, step):
        seg = left[i:i + step]
        rms.append(math.sqrt(sum(x * x for x in seg) / len(seg)) / 32768)
        peak = max(peak, max(abs(x) for x in seg) / 32768)
    return rms, peak, win_s


@pytest.mark.skipif(find_sclang() is None, reason="SuperCollider not installed")
def test_silent_until_touched_then_rings_and_dies(tmp_path):
    rec = tmp_path / "out.wav"
    sound = Sound(tmp_path, mode="virtual",
                  extra_env={"WX_MASTER": "0", "WX_AUTOTOUCH": "0", "WX_RECORD": str(rec)})
    assert sound.start()
    try:
        assert sound.ready.wait(60), (tmp_path / "sound.log").read_text()[-2000:]
        sound.send("/wx/context", "openness", 0.7, "kind", 2.0, "quiet", 0.2,
                   "between", 0.3, "busy", 0.5, "novelty", 0.2)
        time.sleep(3.0)                               # nobody touches: silence
        sound.send("/wx/touch", 0.0)
        time.sleep(14.0)                              # it rings, then dies away
        sound.send("/wx/set", "couple", 4.0)          # far too much feedback…
        sound.send("/wx/set", "fbGain", 4.0)
        sound.send("/wx/set", "makeupDb", 40.0)
        sound.send("/wx/touch", 0.0)
        time.sleep(6.0)
    finally:
        sound.stop(timeout=8)

    log = (tmp_path / "sound.log").read_text()
    assert "ERROR" not in log and "FAILURE" not in log, log[-3000:]
    rms, peak, win = _rms_windows(rec)
    w = lambda seconds: int(seconds / win)
    # anchor on the touch itself: the first window that isn't silence
    loud = [i for i, r in enumerate(rms) if r > 0.004]
    assert loud, "the touch never sounded"
    t = loud[0]
    assert t * win >= 2.5, f"sound before the touch (at {t * win:.1f} s)"
    assert max(rms[:t]) < 0.004
    # the feedback keeps sounding after the knock itself has passed
    ringing = max(rms[t + w(1.0):t + w(4)])
    assert ringing > 0.01, f"the touch didn't ring after the knock: {ringing:.4f}"
    tail = max(rms[t + w(11):t + w(13)])
    assert tail < ringing / 8, f"didn't die away: tail {tail:.4f} vs ring {ringing:.4f}"
    stressed = rms[t + w(14.5):t + w(19.5)]
    assert stressed, "the recording ended early"
    assert peak <= 0.71, f"limiter breached: peak {peak:.3f}"
    assert max(stressed) < 0.35, f"auto gain didn't hold a runaway loop: {max(stressed):.3f}"
    assert "WX context" in log and "WX touch" in log
