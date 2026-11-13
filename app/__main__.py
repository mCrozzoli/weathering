"""Start the local app:  python -m app   (Weathering.command does this).

    --show NAME      which show to open (default: the last one, else "show")
    --port DEVICE    the hub's USB port (default: found by itself if only one
                     ESP32 is plugged in)
    --fake [SPEED]   no hardware: start the pretend hub (sim/fake_hub.py)
                     on a pseudo-port and connect to it (SPEED × real time)
    --no-browser     don't open the page
    --no-sound       don't start SuperCollider
    --sound-live     sound with the real sculpture: contact mics in, panel
                     speakers out, through the sound card (default: a
                     virtual panel, nothing needed but SuperCollider)
"""
from __future__ import annotations

import argparse
import signal
import sys
import threading
import webbrowser

from . import store
from .server import App, serve
from .serial_link import ports


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="weathering")
    ap.add_argument("--show")
    ap.add_argument("--port")
    ap.add_argument("--fake", nargs="?", const=60.0, type=float)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-sound", action="store_true")
    ap.add_argument("--sound-live", action="store_true")
    ap.add_argument("--http", type=int, default=8770)
    a = ap.parse_args(argv)

    shows = store.list_shows()
    name = a.show or (shows[0]["name"] if shows else "show")
    if a.fake and not a.show:
        name = "demo"
    app = App(name)

    fake = None
    if a.fake:
        from sim.fake_hub import start_pty
        last = app.show.last_unix()          # carry on the show's (fast) clock after a restart
        fake = start_pty(speed=a.fake, start_unix=(last + 300) if last else None)
        app.link.open(fake.port_name)
        print(f"[weathering] pretend hub on {fake.port_name} at ×{a.fake:g}")
    elif a.port:
        app.link.open(a.port)
    else:
        esp = [p for p in ports() if p["esp"]]
        if len(esp) == 1:
            app.link.open(esp[0]["device"])
            print(f"[weathering] hub found on {esp[0]['device']}")
        else:
            print("[weathering] plug the hub in, then pick its port in the page")

    sound = None
    if not a.no_sound:
        from .sound import Sound
        sound = Sound(store.ROOT.parent, mode="live" if a.sound_live else "virtual")
        if sound.start():
            print(f"[weathering] sound: SuperCollider starting ({sound.mode}); log in {sound.log_path}")
        else:
            print("[weathering] sound: SuperCollider not found — the show runs silently")
        app.attach_sound(sound)

    httpd = serve(app, port=a.http)
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    print(f"[weathering] show '{app.show.name}' — {app.show.count()} readings in {app.show.dir}")
    print(f"[weathering] open {url}   (Ctrl+C or the page's Quit to stop)")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    def stop(*_):
        app.quit.set()
        threading.Thread(target=httpd.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        httpd.serve_forever()
    finally:
        app.link.close()
        if sound:
            sound.stop()
        if fake:
            fake.stop()
    print("[weathering] stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
