# Credits

## People

- **Florian Goeschke** — sculpture (NPTX), concept; the jitterbug
  geometry and uneven-pull solver the twin here uses (his "Possibility Space" page), and the Dynamixel wiring and packet
  code the sculpture's firmware is built on (his TTGO tests).
- **Miguel Angel Crozzoli** — data, algorithms, software, firmware design.
- Built with **Claude** (Anthropic) as a co-designing agent.

☐ Florian to confirm his credit line and affiliation.

## Ideas and methods

- The jitterbug (vector equilibrium → icosahedron → octahedron):
  R. Buckminster Fuller, *Synergetics* (1975). NPTX, from *anaptyxe*
  (unfold), is Florian's four-string version. `app/static/js/twin.js`
  ports his geometry and position-based solver from three.js to plain
  canvas.
- Dynamixel Protocol 2.0 (ROBOTIS): packets, CRC-16 (poly 0x8005) and Sync
  Write, hand-written after Florian's sketch; no ROBOTIS library is used.
- Sensirion SCD30 / SCD41 I²C commands from Sensirion's datasheets, written
  with Wire (no driver library).
- PCA, k-means (with k-means++ seeding: Arthur & Vassilvitskii, 2007),
  Jacobi eigenvalue rotations — textbook methods, implemented in
  `app/static/js/pipeline.js`.
- Isolation forest: Fei Tony Liu, Kai Ming Ting, Zhi-Hua Zhou, *Isolation
  Forest*, ICDM 2008 — written from scratch in `pipeline.js`.
- Self-organising map: Teuvo Kohonen, *Self-organized formation of
  topologically correct feature maps*, Biological Cybernetics 43 (1982).
- Teaching by example (a few input → shape pairs, a small network learns
  the rest): after Rebecca Fiebrink's **Wekinator** (Fiebrink, Trueman &
  Cook, NIME 2009). The network and its training (Adam: Kingma & Ba, 2015)
  are written from scratch in `app/static/js/mlp.js`.
- **CoFlo**: complexity-controlled feedback gain — Chris Kiefer, Dan
  Overholt, Alice Eldridge, *Shaping the behaviour of feedback instruments
  with complexity-controlled gain dynamics*, NIME 2020. Complexity measured
  with random projection (Chris Kiefer, SMC 2023).
- **Polyharpye** — Alberto de Campo, *Polyharpye Reclaimed*, xCoAx 2020
  (<https://2020.xcoax.org/adc/>): an Xstrument whose resonating processes
  are informed by piezo pickups on suspended strings. The three resonator
  voices in `sc/weathering_sound.scd` (ringPaz, tabloid, sitar) are
  Alberto de Campo's Polyharpye code, here fed by the panels' own piezos
  instead of played. ☐ licence of this code to confirm with Alberto de Campo.
- The app's shape (browser over Web Serial, firmware installed from the
  page, ESP-NOW boards that find each other) follows Miguel's
  [calum-organ](https://github.com/mCrozzoli/calum-organ).

## Software

| What | Where | Licence |
|---|---|---|
| esptool-js 0.5.7 (Espressif) | loaded from unpkg.com, only when installing firmware | Apache-2.0 |
| pyserial | installed by `Weathering.command` | BSD-3-Clause |
| SuperCollider 3.13 | the sound engine; installed separately | GPL-3.0 |
| libcccrt / CccRPC (Chris Kiefer) | built on each machine by `tools/build_cccrpc.sh`, not shipped | MIT |
| Arduino-ESP32 core 2.0.14 (Espressif) | compiled into `app/static/firmware/*` | LGPL-2.1 |
| ESP-IDF (Espressif): bootloader, ESP-NOW | compiled into `app/static/firmware/*` | Apache-2.0 |

No other third-party code: the page is plain JavaScript, the firmware uses
no extra Arduino libraries.

## Hardware

Sensirion SCD30 (or SCD41), ROBOTIS Dynamixel XL430-W250, ESP32
(Espressif); optional ROHM BH1750 and MAX4466/MAX9814 microphone modules — see [docs/HARDWARE.md](docs/HARDWARE.md).

## Licence

☐ To be decided with Florian. Until then all rights are reserved, except
the third-party parts above under their own licences (the Polyharpye voices:
☐ as Alberto de Campo grants).
