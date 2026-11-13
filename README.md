# Weathering

A data sculpture that unfolds as it lives a room. A small box of sensors
reads the room's air, light and sound every few minutes. Twice a day
everything gathered since the opening is read again, by three different
algorithms, and the sculpture — six servos folding a Jessen's icosahedron —
takes the shape that reading gives. It starts closed; it opens as the show
lives.

By **Florian Goeschke** (sculpture) and **Miguel Angel Crozzoli** (data,
software). Open it online: **<https://mcrozzoli.github.io/weathering/>**
(the demo runs with no hardware; Chrome or Edge to connect boards).

```
 Sensor box ──radio──▶ Hub ══USB══ Computer (this app: keeps the show, runs the data)
 ESP32 + CO₂,          ESP32         │
 light, sound            │           └─ later: sound card ─▶ contact mics + speakers
                         └──radio──▶ Sculpture: ESP32 + 6 servos
```

## Start (Florian)

1. **Install the boards once.** Open the app, go to **Boards**, plug each
   ESP32 in by USB, click **Connect a board…** and install its part:
   *Sensor box*, *Hub*, *Sculpture*. Set the servos' pins, range and closed
   end there, and **Test** each one. Wiring and parts:
   [docs/HARDWARE.md](docs/HARDWARE.md).
2. **Power the sensor box and the sculpture.** They find the hub by
   themselves. The servos need their own 5–6 V supply.
3. **Plug the hub in and double-click `Weathering.command`.** The page
   opens and connects; the dots in the top bar turn green (hub, sensor,
   sculpture). The first time it installs one small thing (pyserial,
   ~15 s).
4. **Leave it.** A reading every 5 minutes, saved at once. At 06:00 and
   18:00 the data is read again from the start and the sculpture moves —
   slowly — to its new shape.

No hardware yet? Double-click **`Weathering demo.command`** (or open the
page online and it starts the demo by itself): a pretend room and
sculpture at 12 hours a minute.

## What you see

- **The twin**: the sculpture as it is now. Each servo opens one of the six
  pairs of corners that meet when the body is closed.
- **The rings**: one ring per day, one arc per hour, coloured by the kind of
  hour the latest run found (quiet · in between · busy). Every run reads the
  whole past again, so the past can change colour.
- **Three readings of the data** — same data, three shapes:
  *Directions* (PCA: where today sits along the room's main directions of
  change, and how much it moves), *Kinds of hours* (k-means: today's and
  all time's share of each kind), *Unusual* (each sensor's percentile in its
  own history, plus how new today is). The highlighted one moves the
  sculpture; click another to switch.
- **Openness**: how far the sculpture may open — mostly how long the show
  has lived, partly how much the room has moved. Closed at the start.
- **History**: slide back through every run; *Show on sculpture* makes the
  body take that day's shape again.

## If something stops

- **Page closed**: the app keeps saving readings. Reopen
  <http://127.0.0.1:8770> or double-click the command again.
- **Computer off or crashed**: double-click `Weathering.command`. The show
  reopens where it was (`~/.weathering/shows/<show>/`), and a run that was
  missed happens at once. Meanwhile the sculpture held its shape (it
  remembers it), and the sensor box kept about a day of readings and sends
  them now.
- **Weeks unattended (Mac mini)**: System Settings → Energy → *Start up
  automatically after a power failure*; add `Weathering.command` to Login
  Items; no sleep.

The show on disk is three plain files: `readings.csv` (every reading),
`runs.jsonl` (every run, with all three poses), `show.json` (settings).
Online, the same lives in the browser; *⚙ → Export data* saves it.

## Two ways to run

| | **Local app** (the installation) | **Online** (try, set up boards) |
|---|---|---|
| Start | `Weathering.command` | <https://mcrozzoli.github.io/weathering/> |
| Talks to the hub | through a small Python program | from Chrome/Edge (Web Serial) |
| Keeps the show | files in `~/.weathering/` — survives anything | this browser (export to keep) |
| Readings while the page is closed | yes | no |

## For developers

```bash
python3 -m venv .venv && .venv/bin/pip install pyserial pytest
node --test tests/js/*.test.mjs      # protocol, room, pipeline, twin, fake hub
.venv/bin/python -m pytest           # local app end to end, firmware contract
.venv/bin/python -m app --fake 720   # local app with the pretend hub
tools/build_firmware.sh              # rebuild app/static/firmware/ after editing firmware/
```

- `docs/PROTOCOL.md` — the contract between boards and app (USB lines,
  radio packet). Change it first, then both sides.
- `app/` — local app (Python, stdlib + pyserial); `app/static/` — the page
  (= the GitHub Pages site, plain ES modules, no build step).
- `app/static/js/pipeline.js` — the twelve-hour run; `twin.js` — the twin's
  geometry; `room.js` / `fakehub.js` — the pretend room and hub (Python
  twins in `sim/`).
- `firmware/` — the three ESP32 sketches (Arduino core 2.0.14, no extra
  libraries).

Every push to `main` runs the tests on GitHub and publishes `app/static`.

## Next

Sound (the sculpture silent until touched, its feedback shaped by the
contextual algorithms) waits for the microphone tests in the panels.
Learned mappings (teach a few data-state ↔ shape pairs, let a small network
find the rest) are planned. See [CREDITS.md](CREDITS.md) for who and what.
