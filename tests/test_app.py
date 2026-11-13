"""Local app: protocol, the show on disk, and the whole chain with the
pretend hub on a pseudo-port (no hardware)."""
from __future__ import annotations

import json
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from app import protocol, store
from app.server import App, serve
from sim.fake_hub import start_pty
from sim.room import Room

REPO = Path(__file__).resolve().parents[1]


# ------------------------------------------------------------- protocol
def test_parse_reading():
    r = protocol.parse_reading("R 1790000000 12 co2=812 t=21.40 rh=44 lux=410 db=-51 sim=lux,db old")
    assert r["unix"] == 1790000000 and r["seq"] == 12
    assert r["co2"] == 812 and r["t"] == 21.4 and r["db"] == -51
    assert r["sim"] == ["lux", "db"] and r["old"] is True
    assert protocol.parse_reading("BODY 0 0 0 0 0 0") is None
    assert protocol.parse_reading("R x y") is None
    missing = protocol.parse_reading("R 5 1 co2=500")
    assert missing["lux"] is None


def test_csv_matches_the_browser():
    js = (REPO / "app/static/js/protocol.js").read_text()
    assert f'CSV_HEADER = "{protocol.CSV_HEADER}"' in js
    r = protocol.parse_reading("R 10 2 co2=500 t=20.5 rh=40 lux=3 db=-60")
    assert protocol.reading_to_csv(r) == "10,2,500,20.5,40,3,-60,,0"


def test_python_room_matches_javascript_room():
    script = (
        "import {Room} from './app/static/js/room.js';"
        "const r=new Room({seed:3,tzOffsetH:0});const out=[];"
        "for(let u=1790000000;u<1790000000+86400;u+=3600)out.push(r.read(u));"
        "console.log(JSON.stringify(out));"
    )
    try:
        js = subprocess.run(["node", "--input-type=module", "-e", script], cwd=REPO,
                            capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        pytest.skip("node not installed")
    want = json.loads(js.stdout)
    room = Room(seed=3, tz_offset_h=0)
    got = [room.read(u) for u in range(1790000000, 1790000000 + 86400, 3600)]
    for w, g in zip(want, got):
        for k in ("co2", "lux", "db"):
            assert abs(w[k] - g[k]) <= 1, (k, w, g)
        for k in ("t", "rh"):
            assert abs(w[k] - g[k]) < 0.06, (k, w, g)


# -------------------------------------------------------------- store
def test_show_keeps_everything(tmp_path):
    s = store.Show("Athens 2026!", tmp_path)
    assert s.name == "Athens 2026"
    r = protocol.parse_reading("R 100 1 co2=500 t=20 rh=40 lux=3 db=-60")
    assert s.add_reading(r) is True
    assert s.add_reading(r) is False                 # a re-sent backlog reading
    s.add_run({"run": 1, "sent": [0] * 6})
    with open(s.runs_path, "a") as f:
        f.write('{"run": 2, "sent"')                 # torn by a power cut
    again = store.Show("Athens 2026", tmp_path)
    assert again.count() == 1
    assert [x["run"] for x in again.runs()] == [1]
    m = again.update_meta({"driving": "clusters", "evil": 1})
    assert m["driving"] == "clusters" and "evil" not in m
    assert store.list_shows(tmp_path)[0]["readings"] == 1


# ---------------------------------------------------- the whole chain
def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())


def _post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def _sse(url, out: list, stop: threading.Event):
    with urllib.request.urlopen(url, timeout=10) as r:
        for raw in r:
            if stop.is_set():
                return
            line = raw.decode().strip()
            if line.startswith("data: "):
                out.append(json.loads(line[6:]))


def test_local_app_with_the_pretend_hub(tmp_path):
    fake = start_pty(speed=3600)                    # an hour of room per second
    app = App("e2e", tmp_path)
    httpd = serve(app, port=8890)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    events, stop = [], threading.Event()
    threading.Thread(target=_sse, args=(base + "/events", events, stop), daemon=True).start()
    try:
        _post(base + "/api/connect", {"port": fake.port_name})
        deadline = time.time() + 15
        while time.time() < deadline and app.show.count() < 20:
            time.sleep(0.2)
        assert app.show.count() >= 20, "readings reach the disk without the page"
        st = _get(base + "/api/state")
        assert st["link"]["connected"] and st["show"]["name"] == "e2e"

        assert _post(base + "/api/send", {"line": "POSE 9 0.1 0.2 0.3 0.4 0.5 0.6 0"})["ok"]
        deadline = time.time() + 5
        while time.time() < deadline and not any(e.get("line") == "ACK body 9" for e in events):
            time.sleep(0.1)
        assert any(e.get("line") == "ACK body 9" for e in events)
        assert any(e.get("type") == "line" and e["line"].startswith("R ") for e in events)

        _post(base + "/api/run", {"run": {"run": 1, "sent": [0.1] * 6}})
        show = _get(base + "/api/show")
        assert show["runs"][0]["run"] == 1
        assert show["readings"].startswith(protocol.CSV_HEADER)
        n = app.show.count()

        # restart: a new app on the same show finds everything
        again = App("e2e", tmp_path)
        assert again.show.count() >= n and again.show.runs()[0]["run"] == 1

        assert _post(base + "/api/send", {"line": "BAD\nLINE"}) is not None
    except urllib.error.HTTPError as e:
        assert e.code == 400                         # multi-line sends are refused
    finally:
        stop.set()
        app.link.close()
        fake.stop()
        httpd.shutdown()


def test_static_files_and_traversal(tmp_path):
    app = App("s", tmp_path)
    httpd = serve(app, port=8910)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with urllib.request.urlopen(base + "/js/protocol.js", timeout=5) as r:
            assert r.headers["Content-Type"].startswith("text/javascript")
        with pytest.raises(urllib.error.HTTPError):
            urllib.request.urlopen(base + "/../app/server.py", timeout=5)
    finally:
        httpd.shutdown()
