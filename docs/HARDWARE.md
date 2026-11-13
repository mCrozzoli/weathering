# Weathering — hardware

Three ESP32 boards talk to each other by radio (ESP-NOW, no Wi-Fi network
needed). They find each other on their own. The protocol is in
[PROTOCOL.md](PROTOCOL.md).

| Board | Where | Powered by |
|---|---|---|
| **sensor** | in the room | USB charger (or a power bank) |
| **hub** | on USB to the show computer | the computer |
| **body** | inside the sculpture | USB charger for the ESP32 **+ a separate 5–6 V supply for the servos** |

The firmware needs no extra Arduino libraries. Every board also runs with
nothing attached: missing sensors are simulated (and marked as simulated),
and the body just sends pulses to pins with nothing on them.

## What to buy

| Qty | Part | Notes |
|---|---|---|
| 3 | ESP32 dev board (ESP32-WROOM-32, "ESP32 DevKitC" / "ESP32 Dev Module", 30 or 38 pin) | plain ESP32, **not** S2/S3/C3. A USB data cable for each |
| 1 | **Sensirion SCD41** breakout (CO₂ + temperature + humidity) | I²C address 0x62. Adafruit 5190, SparkFun SEN-22396, Seeed Grove, or a cheap clone. Must be **SCD41** (SCD40 also works but reads CO₂ less well; the SCD30 is a different chip and won't work) |
| 1 | **BH1750** light sensor breakout (GY-302) | I²C 0x23 (ADDR pin low/open) or 0x5C (ADDR high) |
| 1 | **Analog microphone module with amplifier**: MAX4466 or MAX9814 breakout | needs an *analog* output that sits at about half the supply in silence. The KY-037/KY-038 "sound sensor" also works (use its **AO** pin), but it's much less sensitive |
| 6 | Standard hobby servos (e.g. MG996R, DS3218 for more torque; SG90/MG90S for a test rig) | 3-wire, 50 Hz, ~1000–2000 µs. Get metal-gear ones for the sculpture |
| 1 | **5–6 V power supply for the servos**, at least **2 A per servo that moves at the same time** (6 × MG996R: 5 V / 10 A is comfortable) | a meanwell-type 5 V brick or a 6 V supply. **Never** power servos from the ESP32's 5V/3V3 pin |
| 1 | 1000 µF / 10 V (or more) electrolytic capacitor | across the servo supply at the servo connector, against brown-outs when servos start |
| – | jumper wires, a terminal block or perfboard for the servo power rail, heat-shrink | |

Optional: a USB power bank for the sensor if there's no socket nearby. The
ESP32 draws about 0.1 A with the radio on, so a 10 000 mAh bank lasts
roughly 3 days.

## Wiring

All the pin numbers below are the defaults. The sensor's I²C and mic pins
and every servo pin can be changed later over USB (`SET`, stored on the
board), so if a pin is awkward on your board, wire it to another one and
tell the app.

### Sensor board

| From | To ESP32 | Notes |
|---|---|---|
| SCD41 VIN (or VCC) | 3V3 | |
| SCD41 GND | GND | |
| SCD41 SDA | **GPIO 21** | most breakouts have pull-ups on board |
| SCD41 SCL | **GPIO 22** | |
| BH1750 VCC | 3V3 | |
| BH1750 GND | GND | |
| BH1750 SDA | **GPIO 21** | same bus as the SCD41 (both on the same two wires) |
| BH1750 SCL | **GPIO 22** | |
| BH1750 ADDR | leave open (or GND) | → 0x23 |
| Mic VCC | **3V3** | not 5 V: the ESP32's analog input must stay below 3.3 V |
| Mic GND | GND | |
| Mic OUT (AO) | **GPIO 34** | must be an ADC1 pin: 32, 33, 34, 35, 36 or 39 (ADC2 pins don't work while the radio is on) |

Place the SCD41 away from the ESP32 and the USB charger (they warm it up
and skew temperature/humidity), out of direct sun and breath. The SCD41
recalibrates itself, assuming it sees fresh outdoor-like air (~400 ppm) at
least once a week. If the room is never aired, CO₂ readings slowly drift
low.

### Hub board

Nothing to wire: just a USB cable to the show computer.

### Body board

| Servo | ESP32 pin (signal) | Servo wires |
|---|---|---|
| s0 | **GPIO 13** | signal (orange/yellow/white) → pin |
| s1 | **GPIO 12** | red → servo supply **+5–6 V** |
| s2 | **GPIO 14** | brown/black → servo supply **GND** |
| s3 | **GPIO 27** | |
| s4 | **GPIO 26** | |
| s5 | **GPIO 25** | |

**Join the grounds**: run a wire from the servo supply's GND to an ESP32
GND pin. Without it the signal has no reference and the servos jitter or
don't move. Put the 1000 µF capacitor across + and GND of the servo rail
(mind the polarity: the stripe is −).

The ESP32 itself is powered from its own USB charger (or from the 5 V
servo supply into the board's **5V/VIN** pin, if that supply is a clean
5 V. Never 6 V into VIN on cheap boards).

GPIO 12 is a "strapping" pin: if something on it pulls it high while the
board starts, the ESP32 won't boot. A servo signal input is fine, but if
the body board refuses to start with the servos plugged in, move s1 to
another pin (e.g. 33) with `SET s1=33,1000,2000,0`.

### Calibrating the servos

Each servo has `s<k>=<pin>,<min_us>,<max_us>,<closed>` (defaults
`1000,2000,0`). The app maps pose 0 → the servo's **closed** end and
1 → its **open** end. `closed=0` means `min_us` is closed; `closed=1` flips
it (for servos mounted the other way round).

1. Before attaching the linkage, `RELAX`, then `POSE 0 0 0 0 0 0 5` and
   `POSE 1 1 1 1 1 1 5` to see the full travel.
2. Find each servo's closed and open pulse widths (start narrow, e.g.
   1200–1800, and widen in small steps: a servo pushed past its mechanical
   stop gets hot and breaks). `TEST <k>` wiggles one servo so you can tell
   which is which.
3. Store them: `SET s0=13,1150,1850,0` etc. (on the body's USB, or from the
   app through the hub with `CFG body s0=13,1150,1850,0`).

## Flashing the boards

### With the web app (easiest)

1. Open the Weathering app in Chrome or Edge (Web Serial is needed: not
   Safari/Firefox) and go to the **Boards** panel.
2. Plug in one ESP32 by USB, choose which role it gets (sensor, hub or
   body) and press **Install**. Pick the board's serial port when the
   browser asks.
3. When it's done the board restarts and prints
   `FW weathering_<role> 0.1.0 mac … group 1`; the panel shows it.
4. Repeat for the other two boards. Keep all three in the same **group**
   (1 by default); a second installation in the same building gets another
   group number.

If the port doesn't show up: try another USB cable (many are charge-only),
and on some boards hold the **BOOT** button while installing starts.
CP210x/CH340 drivers are built into current macOS/Windows; older systems
may need them.

### With the Arduino IDE

1. Install the Arduino IDE 2, then in *Boards Manager* install **esp32 by
   Espressif Systems, version 2.0.14** (newer 3.x versions should work
   too, but the published binaries use 2.0.14).
2. Open `firmware/weathering_<role>/weathering_<role>.ino` (the `wx.h` next
   to it opens as a tab).
3. *Tools → Board → ESP32 Dev Module*, choose the port, **Upload**.
4. Open the Serial Monitor at **115200** baud and type `INFO`.

### Rebuilding the published binaries

After changing anything in `firmware/`: `tools/build_firmware.sh`. It
compiles the three sketches with the Arduino IDE's bundled `arduino-cli`
and writes `app/static/firmware/{sensor,hub,body}/`. Commit the result.
The three `wx.h` files must stay identical, and `FW_VERSION` in `wx.h` is
the version every board reports.

## Checking a board by USB (115200 baud, any serial monitor)

```
INFO                      what it is, its settings
PING                      → PONG
READ                      (sensor) one reading now, e.g. R 1763040000 12 co2=612 t=21.40 rh=44.8 lux=153.3 db=-52.1 sim=db
POSE 0.5 0.5 0.5 0.5 0.5 0.5 10   (body) glide to the middle in 10 s
TEST 2                    (body) wiggle servo 2
RELAX                     (body) servos go limp
SET group=2               (any) change a setting; it is kept after power cuts
```

`sim=` lists the channels that are simulated because no sensor was found.
The sensor's INFO shows what it detected (`sensors=scd41,bh1750,mic`). The
microphone can't really be detected (it's just a voltage): the board
guesses from the voltage on the pin. If it guesses wrong, `SET
simulate=none` makes it always use the mic pin (but then a missing SCD41
or BH1750 is left out instead of simulated).
