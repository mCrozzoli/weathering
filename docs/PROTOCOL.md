# Weathering — protocol contract v0.2

The one document the firmware and the app both build against. Change it
first, then both sides, and bump `FW_VERSION`. Patterns are taken from
calum-organ 1.4 (Web Serial + esptool-js + line protocol + ESP-NOW with
HELLO discovery).

## The boards (roles)

| Role | Sketch | Where | Does |
|---|---|---|---|
| `sensor` | `firmware/weathering_sensor` | in the room, battery or USB power | reads the room every `interval` s, sends readings to the hub over ESP-NOW, keeps a backlog while nobody listens |
| `hub` | `firmware/weathering_hub` | on USB to the show computer | bridges USB serial ⇄ ESP-NOW, finds the other boards, relays time, poses and config |
| `body` | `firmware/weathering_body` | inside the sculpture | drives 4 Dynamixel XL430 motors that wind the strings, to the pulls it's told, gliding slowly; remembers where it is and refuses to move if it can't be sure |

All three are plain ESP32 (ESP32 Dev Module, `esp32:esp32:esp32`), Arduino
core 2.0.14 (the one the IDE ships and the published binaries are built
with). No board needs a MAC table: they find each other by HELLO
broadcasts. Several installations in one place are kept apart by the
`group` number (1–250, default 1), stored on every board.

## Boot line (all boards, USB, 115200 baud)

```
FW weathering_<role> <version> mac <AA:BB:CC:DD:EE:FF> group <g>
```

The app reads this after resetting a board to identify it (as calum-organ's
Boards panel does).

## Common USB commands (every board)

```
host → board:  INFO
board → host:  INFO <role> fw <version> mac <mac> group <g> [role-specific key=value ...]
host → board:  SET <key>=<value> [<key>=<value> ...]     (stored in flash, survives power cuts)
board → host:  OK SET   |   ERR <reason>
host → board:  PING     → PONG
board → host:  LOG <free text>     (anything human-readable; the app shows it in the console)
```

Keys common to all boards: `group` (1–250).

## Sensor board

INFO extras: `interval=<s> sensors=<list> sim=<list>` where `sensors` is
what was detected at boot and `sim` what is simulated because it's missing.

Sensors detected on I2C at boot (default pins SDA 21, SCL 22):
- **SCD30** (0x61, the sculpture's kit; the bus runs at 50 kHz because it
  stretches the clock): `co2` (ppm), `t` (°C), `rh` (%)
- **SCD41** (0x62), the same three channels, if there's no SCD30
- **BH1750** (0x23 or 0x5C): `lux`
- **Analog mic module** on `mic_pin` (default 34): `db` (relative sound
  level, dB re. full scale, measured over 1 s; 0 = loudest)

`channels` (default `co2,t,rh`) says which channels are part of the show;
the others are neither sent nor simulated, so more dimensions can be added
later with `SET channels=co2,t,rh,lux,db` and the matching sensor. A
listed channel without a sensor is SIMULATED (plausible indoor values with
a day/night cycle) and listed in `sim=`, so a board with no sensors still
works for testing. SET keys: `channels`, `interval` (10–3600 s, default
300), `sda`, `scl`, `mic_pin`, `simulate` (`auto` = simulate only what's
missing, `all`, `none`).

USB commands: `READ` → prints one reading line now (format as below).

Backlog: readings that the hub hasn't acknowledged stay in a ring buffer
(≥ 1 day at 300 s, RAM; lost only on a power cut of the sensor board) and
are re-sent oldest first once the hub is back, flagged `old`.

## Hub board — USB protocol (the app ⇄ hub)

```
host → hub:  TIME <unix_seconds>           the computer's clock; the hub relays it to the sensor
             POSE <seq> <p1> <p2> <p3> <p4> <glide_s>
             RELAX                          body motors stop holding (torque off: the structure opens by itself)
             TEST <k>                       body winds motor k (1..4) a little in and back
             READ                           ask the sensor for a reading now
             CFG sensor <key>=<value> ...   forward SET to the sensor board over the radio
             CFG body <key>=<value> ...     forward SET to the body board over the radio
             NODES                          list the boards the hub hears

hub → host:  OK POSE <seq>                  hub accepted the pose
             ACK body <seq>  |  NAK body <seq>     the body got it (or not, after 3 tries)
             R <unix> <seq> co2=<v> t=<v> rh=<v> lux=<v> db=<v> [sim=<list>] [old]
             BODY <p1> … <p4> moving=<0|1> homed=<0|1> found=<mask>
                                            the body's current pulls (every 2 s while moving, and on change)
             NODE <role> <mac> fw <version> rssi <dBm>    a board heard (answer to NODES, and when first heard)
             LOST <role>                    not heard for 30 s
             OK <cmd>  |  ERR <reason>  |  LOG <text>
```

- **Readings** (`R`): `seq` counts readings on the sensor board (gaps =
  lost readings). `unix` is the reading's own time: the sensor stamps it
  with the time the hub last sent it, so backlog readings keep their real
  time. A value is missing (key absent) if that channel has neither a
  sensor nor simulation. `sim=co2,lux` names simulated channels. `old`
  means a backlog reading arriving late.
- **Poses** are four **pulls** `p1..p4` in [0, 1] with 3 decimals, one per
  motor (Dynamixel IDs 1–4 by default). **0 = string slack, structure open
  (cuboctahedron); 1 = string wound to its calibrated closed point,
  structure closed (octahedron).** The show starts closed (all 1) and opens
  as it lives. `glide_s` (0–3600) is how long the body takes to get there;
  the default for data poses is 60 s (weathering is slow).
- `homed=0` means the body isn't sure where the strings are (see Body
  board): it holds no torque and ignores poses until someone sets it again.
  `found` is a bitmask of the motors that answer (bit 0 = motor 1).
- The hub keeps no data: the computer is the memory.

## Body board

Four Dynamixel XL430-W250 on one half-duplex TTL line: ESP32 TX (GPIO 32)
through 1 kΩ to the data line, RX (GPIO 33) straight on it; 57600 baud,
Protocol 2.0, extended position mode (multi-turn); motors on their own
12 V supply, grounds joined. Every byte sent echoes back; the firmware
looks for the status packet instead of assuming where the echo ends.

**Calibration** (stored in flash; all of it can be done from the Boards
page or with `CFG body …` through the hub, since it is all `SET`):

| SET | Does |
|---|---|
| `jog=<k>,<ticks>` | turns motor k (1–4) by ±ticks (≤ 1024 = ¼ turn per command), torque on that motor only; for finding the slack and closed points by hand |
| `slack=all` | "the structure is open and every string just slack, now": stores each motor's present position as its zero (pull 0) and marks the body homed |
| `closed=<k>` | "motor k has drawn its triangle fully in, now": stores travel = present − zero (the sign is the direction). Travel must be ¼–8 turns |
| `ids=<i1>,<i2>,<i3>,<i4>` | the Dynamixel ID of motor 1..4 (default 1,2,3,4) |
| `setid=<old>,<new>` | changes a motor's ID (do it with that motor ALONE on the line: new XL430s all ship as ID 1) |
| `speed=<1–100>` | profile velocity limit in % of 60 rpm (default 30) |
| `group=<g>` | as every board |

USB-only commands: `SCAN` (pings IDs 0–252 at 57600 and 1 000 000 baud,
prints `LOG motor id <id> baud <b> model <m>` for each), `POSE <p1> … <p4>
<glide_s>`, `TEST <k>`, `RELAX`.

INFO extras: `pose=<p1>,…,<p4> m1=<id>,<travel> … m4=… homed=<0|1>
found=<mask> moving= relaxed= hub=`.

**Safety** (built in, not settings):
- A motor is driven only when it answers, the body is homed and its travel
  is calibrated. Goals are clamped to zero − 2 % … zero + 102 % of travel,
  whatever arrives. Glides are linear in pull; the motors' own profile
  velocity/acceleration smooth the start and end.
- The body stores zero, travel and the last pull it settled on. At boot it
  reads where the motors are and compares: within 1/16 turn of where they
  should be (an ESP32 reset), it carries on; if the motors lost their
  multi-turn count (their 12 V went off) it tries whole turns; if neither
  matches, it is **not homed**: torque off, poses ignored, `homed=0`, until
  `slack=all` is set again with the structure open. It never assumes "where
  I am at power-up is slack".
- `RELAX` (torque off) lets the structure open by itself; the body keeps
  counting, so poses work again afterwards.
- No streaming needed: the body holds the last pose for as long as it has
  power. TEST winds motor k in by 5 % of its travel (⅛ turn before
  calibration) and back, to check the direction.

## Radio (ESP-NOW), one fixed packet

```c
#define WX_MAGIC 0xA8      // 0xA7 was v0.1 (six servos)
typedef struct __attribute__((packed)) {
  uint8_t  magic;      // WX_MAGIC (bump on incompatible change)
  uint8_t  type;       // WX_*
  uint8_t  group;      // installation group; others ignored
  uint8_t  role;       // sender's role: 1 sensor, 2 hub, 3 body
  uint16_t fw;         // major<<8 | minor
  uint16_t seq;
  uint32_t unix;       // TIME, READING
  uint8_t  flags;      // READING: bit0 old, bits1..5 simulated mask (co2,t,rh,lux,db)
  uint8_t  present;    // READING: bit i = value i present
  float    v[6];       // READING: co2,t,rh,lux,db,(spare); POSE, BODYSTATE: p1..p4 in v[0..3]; CONFIG: unused
  uint16_t glide_s;    // POSE
  char     text[40];   // CONFIG: "key=value key=value"; TEST: "k"
} WxPacket;

enum { WX_HELLO=1, WX_READING=2, WX_ACK=3, WX_TIME=4, WX_POSE=5,
       WX_BODYSTATE=6, WX_CONFIG=7, WX_TEST=8, WX_RELAX=9, WX_READ=10 };
```

- Every board broadcasts `WX_HELLO` every 3 s; the hub answers with its
  own HELLO and `WX_TIME`. Boards then unicast to the MAC they heard.
- Reading → hub replies `WX_ACK(seq)`; the sensor drops it from the
  backlog only after the ACK.
- Pose → body replies `WX_ACK(seq)`; the hub retries 3× (300 ms) then NAKs.
- `WX_BODYSTATE`: body → hub, current pulls in `v[0..3]`; flags bit0 =
  moving, bit1 = homed, bits 4–7 = found mask.
- `WX_TEST`: `text` = "k" (1–4).

## Files the app keeps (local app; the online version keeps the same in the browser)

`~/.weathering/shows/<show>/` (one folder per installation run):

- `readings.csv` — append-only, one line per reading, flushed immediately:
  `unix,seq,co2,t,rh,lux,db,sim,old`
- `runs.jsonl` — one line per 12-hour run:
  `{"run":n,"unix":…,"n_readings":…,"openness":…,"poses":{"<algorithm>":[s1..s4],…},"driving":"<algorithm>","sent":[p1..p4],…}`
  — a pose `s` is how far each string is let out (0 = closed, 1 = open);
  what the body is sent is `p = 1 − openness × s`.
- `show.json` — name, start time, run times (default `["06:00","18:00"]`),
  `moves` (`"runs"`, default: the body moves at the runs only; `"live"`:
  it also follows every new reading, with a short glide; live poses are not
  stored as runs), which algorithm drives the body, taught shapes.

Restart = reopen the show: readings and runs reload from these files; a run
whose time passed while the app was off runs at once.

## Clarifications from the firmware build (v0.1.0)

1. **The computer must keep talking.** The hub forwards readings (and ACKs
   them) only after a `TIME` since boot and while some USB line arrived in
   the last 30 minutes. Otherwise nothing is lost: the readings wait in the
   sensor's backlog. The app sends `TIME` on connect and every 5 minutes.
2. **Duplicates happen.** After a lost ACK the same reading can arrive
   twice; the app drops duplicates by `(unix, seq)` (both the local app and
   the browser do). Readings are sent only once the sensor has a clock
   (`unix` is never 0; readings taken before the first `TIME` get their
   time filled in). `seq` survives reboots (saved in blocks of 64), so a
   reboot can leave a gap of up to 64.
3. `NODE … fw 0.1`: the radio packet carries major.minor only.
4. `CFG` is answered `OK CFG` once sent (or `ERR <role> not heard`); the
   target board's own answer comes back as `LOG <role> OK SET` (or `LOG
   <role> ERR …`), carried over the radio in a `WX_CONFIG` packet. Long CFG
   lines are split over several 40-byte packets. `RELAX`/`READ`/`TEST`
   reply `OK RELAX`/`OK READ`/`OK TEST` (plus a LOG line, and a broadcast,
   if that board hasn't been heard yet).
5. A new `POSE` while one is still being delivered NAKs the older `seq`;
   only the newest pose's ACK/NAK matters.
6. **INFO details.** Sensor: `sensors=scd41,bh1750,mic` (devices found, or
   `none`), `sim=co2,t,rh,lux,db` (simulated channels, or `none`), plus
   `simulate sda scl mic_pin backlog hub time`. Hub: adds `time=<unix>`.
   Body: adds `moving= relaxed= hub=`; its `pose=` is the TARGET. On their
   own USB the sensor echoes scheduled readings as `LOG R …` (a USB `READ`
   prints a plain `R …`) and the body prints `BODY …`.

## Changes in v0.2 (the NPTX sculpture)

Four Dynamixel XL430 winding strings; poses are 4 pulls, 1 = closed; calibration by `jog`, `slack`,
`closed` instead of pins and pulse widths; SCD30 support and the
`channels` key; `WX_MAGIC` 0xA8, firmware 0.2.0. Boards on 0.1 must be
reflashed (they ignore 0.2 packets and vice versa).
