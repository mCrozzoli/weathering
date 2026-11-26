# Credits

## People

- **Florian Goeschke** — sculpture (NPTX), concept, 
  resonators; the jitterbug geometry and uneven-pull solver the twin here
  uses and the Dynamixel wiring and packet
  code the sculpture's firmware 
- **Miguel Angel Crozzoli** — data, algorithms, software, firmware design.
- Built with **Claude** (Anthropic) as a co-designing agent.

☐ Florian to confirm his credit line and affiliation.

## Ideas and methods

- Based on R. Buckminster Fuller's jitterbug transformation (s. *Synergetics*, 1975) the project features a shape-shifting feedback sculpture (NPTX, from *anaptyxe*
   / unfold). `app/static/js/twin.js` that moves betweenb its icosahedron and octahedron state.
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
- The resonators in `sc/weathering_sound.scd` are based on Alberto DeCampo's POLYHARPYE x-strument (https://2020.xcoax.org/adc/)  
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

Sensirion SCD41, ROHM BH1750, MAX4466/MAX9814 microphone modules, ESP32
(Espressif) — see [docs/HARDWARE.md](docs/HARDWARE.md).

## Licence

☐ To be decided with Florian. Until then all rights are reserved, except
the third-party parts above under their own licences.
