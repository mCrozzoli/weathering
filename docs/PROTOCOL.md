# Weathering — protocol contract v0.1

The one document the firmware and the app both build against. Change it
first, then both sides, and bump `FW_VERSION`. Patterns are taken from
calum-organ 1.4 (Web Serial + esptool-js + line protocol + ESP-NOW with
HELLO discovery).

## The boards (roles)

| Role | Sketch | Where | Does |
|---|---|---|---|
| `sensor` | `firmware/weathering_sensor` | in the room, battery or USB power | reads the room every `interval` s, sends readings to the hub over ESP-NOW, keeps a backlog while nobody listens |
| `hub` | `firmware/weathering_hub` | on USB to the show computer | bridges USB serial ⇄ ESP-NOW, finds the other boards, relays time, poses and config |
| `body` | `firmware/weathering_body` | inside the sculpture | drives 6 servos to the pose it's told, gliding slowly, stores the last pose and returns to it after a power cut |

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
- **SCD41** (0x62): `co2` (ppm), `t` (°C), `rh` (%)
- **BH1750** (0x23 or 0x5C): `lux`
- **Analog mic module** on `mic_pin` (default 34): `db` (relative sound
  level, dB re. full scale, measured over 1 s; 0 = loudest)

Anything not found is SIMULATED (plausible indoor values with a day/night
cycle) and listed in `sim=`, so a board with no sensors still works for
testing. SET keys: `interval` (10–3600 s, default 300), `sda`, `scl`,
`mic_pin`, `simulate` (`auto` = simulate only what's missing, `all`,
`none`).

USB commands: `READ` → prints one reading line now (format as below).

Backlog: readings that the hub hasn't acknowledged stay in a ring buffer
(≥ 1 day at 300 s, RAM; lost only on a power cut of the sensor board) and
are re-sent oldest first once the hub is back, flagged `old`.

## Hub board — USB protocol (the app ⇄ hub)

```
host → hub:  TIME <unix_seconds>           the computer's clock; the hub relays it to the sensor
             POSE <seq> <a0> <a1> <a2> <a3> <a4> <a5> <glide_s>
             RELAX                          body servos stop holding (detached)
             TEST <k>                       body wiggles servo k (0..5)
             READ                           ask the sensor for a reading now
             CFG sensor <key>=<value> ...   forward SET to the sensor board over the radio
             CFG body <key>=<value> ...     forward SET to the body board over the radio
             NODES                          list the boards the hub hears

hub → host:  OK POSE <seq>                  hub accepted the pose
             ACK body <seq>  |  NAK body <seq>     the body got it (or not, after 3 tries)
             R <unix> <seq> co2=<v> t=<v> rh=<v> lux=<v> db=<v> [sim=<list>] [old]
             BODY <a0> … <a5> moving=<0|1>  the body's current position (every 2 s while moving, and on change)
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
- **Poses**: `a0..a5` in [0, 1] with 3 decimals. **0 = that servo's
  closed end, 1 = its open end**, as calibrated on the body board. `glide_s`
  (0–3600) is how long the body takes to get there; the default for data
  poses is 60 s (weathering is slow).
- The hub keeps no data: the computer is the memory.

## Body board

INFO extras: `pose=<a0>,…,<a5> s0=<pin>,<min_us>,<max_us>,<closed 0|1> … s5=…`

SET keys: `s<k>=<pin>,<min_us>,<max_us>,<closed>` where `closed` says which
end is closed (0: min_us is closed, 1: max_us is closed). Defaults: pins
13, 12, 14, 27, 26, 25, 1000–2000 µs, closed = 0.
USB commands: `POSE <a0> … <a5> <glide_s>`, `TEST <k>`, `RELAX`.

Behaviour: glides linearly from where it is to the target over `glide_s`;
stores the TARGET pose in flash when it arrives; at boot moves to the
stored pose (or all 0 = closed the very first time). Servo outputs are
50 Hz PWM (LEDC). Servos need their own 5–6 V supply with grounds joined
(documented in HARDWARE.md, not enforced by firmware).

## Radio (ESP-NOW), one fixed packet

```c
#define WX_MAGIC 0xA7
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
  float    v[6];       // READING: co2,t,rh,lux,db,(spare); POSE: a0..a5; CONFIG: unused
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
- `WX_BODYSTATE`: body → hub, current position in `v[0..5]`, flags bit0 =
  moving.

## Files the app keeps (local app; the online version keeps the same in the browser)

`~/.weathering/shows/<show>/` (one folder per installation run):

- `readings.csv` — append-only, one line per reading, flushed immediately:
  `unix,seq,co2,t,rh,lux,db,sim,old`
- `runs.jsonl` — one line per 12-hour run:
  `{"run":n,"unix":…,"n_readings":…,"openness":…,"poses":{"<algorithm>":[a0..a5],…},"driving":"<algorithm>","notes":{…}}`
- `show.json` — name, start time, run times (default `["06:00","18:00"]`),
  which algorithm drives the body, settings.

Restart = reopen the show: readings and runs reload from these files; a run
whose time passed while the app was off runs at once.

## Clarifications from the firmware build (v0.1.0)

1. **The computer must keep talking.** The hub forwards readings (and ACKs
   them) only after a `TIME` since boot and while some USB line arrived in
   the last 30 minutes. Otherwise nothing is lost: the readings wait in the
   sensor's backlog. The app sends `TIME` on connect and every 5 minutes.
2. **Duplicates happen.** After a lost ACK the same reading can arrive
   twice; the app drops duplicates by `(unix, seq)` (both the local app and
   the browser do).
3. `NODE … fw 0.1`: the radio packet carries major.minor only.
4. `CFG` is answered `OK CFG` by the hub; the target board's own answer
   comes back as `LOG <role> OK SET` (or `ERR …`), carried over the radio in
   a `WX_CONFIG` packet.
5. A new `POSE` while one is still being delivered NAKs the older `seq`;
   only the newest pose's ACK/NAK matters.
