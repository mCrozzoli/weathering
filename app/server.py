"""The local app's server: the web page, the hub, and the show on disk.

Standard library only (plus pyserial for the USB port). The page talks to it
over plain HTTP; hub lines reach the page as Server-Sent Events. Readings
are written to disk HERE, as they arrive, so the show keeps accumulating
even when the page is closed. The page runs the 12-hour pipeline and posts
each run back.

    GET  /                     the web page (app/static)
    GET  /events               SSE: {"type":"line","line":…} | {"type":"status",…}
    GET  /api/state            mode, link status, show, ports
    GET  /api/show             {meta, readings (CSV), runs}
    GET  /api/shows            every show on this machine
    POST /api/connect {port}   /api/disconnect
    POST /api/send {line}      a line to the hub
    POST /api/show/open {name} open (or start) a show
    POST /api/run {run}        store a run
    POST /api/settings {...}   run times, driving algorithm, show length
    POST /api/touch            knock on the (virtual) sculpture
    POST /api/quit

Sound: if a `Sound` (app/sound.py) is attached, each run's context and the
body's pose go to SuperCollider over OSC, and are re-sent every 30 s so a
restarted SuperCollider picks the show up where it is.
"""
from __future__ import annotations

import json
import mimetypes
import queue
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import protocol, store
from .serial_link import SerialLink, ports

STATIC = Path(__file__).parent / "static"
VERSION = "0.1.0"


class App:
    def __init__(self, show_name: str = "show", root: Path | None = None):
        self.root = root or store.ROOT
        self.show = store.Show(show_name, self.root)
        self.clients: list[queue.Queue] = []
        self.clients_lock = threading.Lock()
        self.link = SerialLink(self._on_line, self._on_status)
        self.last_lines: list[str] = []          # recent hub lines, for a page that opens late
        self.quit = threading.Event()
        self.sound = None
        self.context = None
        self.pose = None
        self._sound_state = None
        runs = self.show.runs()
        if runs and isinstance(runs[-1].get("context"), dict):
            self.context = runs[-1]["context"]

    # ---------------------------------------------------------- sound
    def attach_sound(self, sound) -> None:
        self.sound = sound
        threading.Thread(target=self._sound_loop, daemon=True, name="sound-resend").start()

    def send_context(self) -> None:
        if self.sound is None or not self.context:
            return
        args = []
        for k in ("openness", "kind", "quiet", "between", "busy", "novelty"):
            try:
                args += [k, float(self.context.get(k, 0) or 0)]
            except (TypeError, ValueError):
                pass
        self.sound.send("/wx/context", *args)

    def send_pose(self) -> None:
        if self.sound is not None and self.pose and len(self.pose) == 6:
            self.sound.send("/wx/pose", *[float(a) for a in self.pose])

    def _sound_loop(self) -> None:
        sent_ready, ticks = False, 0
        while not self.quit.is_set():
            state = self.sound.state
            if state != self._sound_state:
                self._sound_state = state
                self.broadcast({"type": "line", "line": f"LOG (sound) {state}"})
            ticks += 1
            if state == "ready" and (not sent_ready or ticks % 30 == 0):
                sent_ready = True
                self.send_context()
                self.send_pose()
            self.quit.wait(1.0)

    # ----------------------------------------------------------- the hub
    def _on_line(self, line: str) -> None:
        r = protocol.parse_reading(line)
        if r is not None:
            self.show.add_reading(r)               # on disk before anyone sees it
        elif line.startswith("BODY "):
            try:
                self.pose = [float(x) for x in line.split()[1:7]]
                self.send_pose()
            except ValueError:
                pass
        self.last_lines = (self.last_lines + [line])[-200:]
        self.broadcast({"type": "line", "line": line})

    def _on_status(self, status: dict) -> None:
        self.broadcast({"type": "status", **status})

    def broadcast(self, ev: dict) -> None:
        data = json.dumps(ev)
        with self.clients_lock:
            for q in list(self.clients):
                try:
                    q.put_nowait(data)
                except queue.Full:
                    pass

    # ------------------------------------------------------------- state
    def state(self) -> dict:
        return {
            "mode": "local", "version": VERSION,
            "link": self.link.status(),
            "show": self.show.meta() | {"readings": self.show.count(), "dir": str(self.show.dir)},
            "ports": ports(),
            "sound": self.sound.state if self.sound else "off",
        }

    def open_show(self, name: str) -> None:
        self.show = store.Show(name, self.root)
        self.broadcast({"type": "show", "name": self.show.name})


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"Weathering/{VERSION}"

        def log_message(self, *a):            # quiet
            pass

        # ---------------------------------------------------------- utils
        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 2_000_000:
                raise ValueError("too large")
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return {}

        # ------------------------------------------------------------ GET
        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/events":
                return self._events()
            if path == "/api/state":
                return self._json(app.state())
            if path == "/api/show":
                return self._json({"meta": app.show.meta(), "readings": app.show.readings_csv(),
                                   "runs": app.show.runs(), "recent": app.last_lines[-40:]})
            if path == "/api/shows":
                return self._json(store.list_shows(app.root))
            return self._static(path)

        def _static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            f = (STATIC / path.lstrip("/")).resolve()
            if STATIC.resolve() not in f.parents or not f.is_file():
                return self.send_error(HTTPStatus.NOT_FOUND)
            data = f.read_bytes()
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if f.suffix == ".js":
                ctype = "text/javascript"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _events(self):
            q: queue.Queue = queue.Queue(maxsize=2000)
            with app.clients_lock:
                app.clients.append(q)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(f"data: {json.dumps({'type': 'status', **app.link.status()})}\n\n".encode())
                self.wfile.flush()
                while not app.quit.is_set():
                    try:
                        data = q.get(timeout=15)
                        self.wfile.write(f"data: {data}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with app.clients_lock:
                    if q in app.clients:
                        app.clients.remove(q)

        # ----------------------------------------------------------- POST
        def do_POST(self):
            path = self.path.split("?")[0]
            try:
                b = self._body()
            except ValueError:
                return self._json({"error": "too large"}, 413)
            if path == "/api/connect":
                port = str(b.get("port") or "")
                if not port:
                    return self._json({"error": "no port"}, 400)
                app.link.open(port)
                return self._json({"ok": True})
            if path == "/api/disconnect":
                app.link.close()
                return self._json({"ok": True})
            if path == "/api/send":
                line = str(b.get("line") or "").strip()
                if not line or "\n" in line or len(line) > 200:
                    return self._json({"error": "bad line"}, 400)
                return self._json({"ok": app.link.send(line)})
            if path == "/api/show/open":
                app.open_show(str(b.get("name") or "show"))
                return self._json({"ok": True, "name": app.show.name})
            if path == "/api/run":
                run = b.get("run")
                if not isinstance(run, dict):
                    return self._json({"error": "no run"}, 400)
                app.show.add_run(run)
                if isinstance(run.get("context"), dict):
                    app.context = run["context"]
                    app.send_context()
                return self._json({"ok": True})
            if path == "/api/touch":
                ok = app.sound is not None and app.sound.state == "ready"
                if ok:
                    app.sound.send("/wx/touch")
                return self._json({"ok": ok})
            if path == "/api/settings":
                return self._json(app.show.update_meta(b))
            if path == "/api/quit":
                self._json({"ok": True})
                app.quit.set()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return None
            return self._json({"error": "not found"}, 404)

    return Handler


def serve(app: App, host: str = "127.0.0.1", port: int = 8770) -> ThreadingHTTPServer:
    httpd = None
    for p in range(port, port + 20):              # first free port
        try:
            httpd = ThreadingHTTPServer((host, p), make_handler(app))
            break
        except OSError:
            continue
    if httpd is None:
        raise OSError("no free port for the local app")
    httpd.daemon_threads = True
    return httpd
