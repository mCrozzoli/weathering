# Credits

## People

- **Florian Goeschke** — sculpture, concept, the POLYHARPYE resonators and
  the Jessen's-icosahedron digital twin whose kinematics the twin here uses.
- **Miguel Angel Crozzoli** — data, algorithms, software, firmware design.
- Built with **Claude** (Anthropic) as a co-designing agent.

☐ Florian to confirm his credit line and affiliation.

## Ideas and methods

- Jessen's orthogonal icosahedron and its jitterbug family (one parameter
  from octahedron to cuboctahedron): Børge Jessen (1967); the transformation
  after R. Buckminster Fuller. Vertex coordinates and faces as in Florian's
  twin (`extras` of the earlier prototype).
- PCA, k-means (with k-means++ seeding: Arthur & Vassilvitskii, 2007),
  Jacobi eigenvalue rotations — textbook methods, implemented in
  `app/static/js/pipeline.js`.
- The app's shape (browser over Web Serial, firmware installed from the
  page, ESP-NOW boards that find each other) follows Miguel's
  [calum-organ](https://github.com/mCrozzoli/calum-organ).

## Software

| What | Where | Licence |
|---|---|---|
| esptool-js 0.5.7 (Espressif) | loaded from unpkg.com, only when installing firmware | Apache-2.0 |
| pyserial | installed by `Weathering.command` | BSD-3-Clause |
| Arduino-ESP32 core 2.0.14 (Espressif) | compiled into `app/static/firmware/*` | LGPL-2.1 |
| ESP-IDF (Espressif): bootloader, ESP-NOW | compiled into `app/static/firmware/*` | Apache-2.0 |

No other third-party code: the page is plain JavaScript, the firmware uses
no extra Arduino libraries.

## Hardware

Sensirion SCD41, ROHM BH1750, MAX4466/MAX9814 microphone modules, ESP32
(Espressif) — see [docs/HARDWARE.md](docs/HARDWARE.md).

## Licence

☐ To be decided with Florian. Until then all rights are reserved, except
the third-party parts above under their own licences.
