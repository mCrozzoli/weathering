# Weathering — hardware (NPTX)

Three ESP32 boards talk to each other by radio (ESP-NOW, no Wi-Fi network
needed). They find each other on their own. The protocol is in
[PROTOCOL.md](PROTOCOL.md).

| Board | Where | Powered by |
|---|---|---|
| **sensor** | in the room | USB charger (or a power bank) |
| **hub** | on USB to the show computer | the computer |
| **body** | inside the sculpture, with the four motors | USB charger for the ESP32 **+ a 12 V supply for the motors** |

The firmware needs no extra Arduino libraries. Every board also runs with
nothing attached: missing sensors are simulated (and marked as simulated),
and the body waits for its motors to answer.

## What to buy

| Qty | Part | Notes |
|---|---|---|
| 3 | **ESP32 dev board** (ESP32-WROOM-32, "ESP32 DevKit V1") | a plain ESP32 — not S2, S3 or C3. With a USB data cable each |
| 1 | **Sensirion SCD30** (CO₂ + temperature + humidity) | I²C 0x61. The sculpture's kit. An **SCD41** (0x62) also works instead |
| 4 | **Dynamixel XL430-W250-T** | TTL (3-pin), Protocol 2.0. They ship as **ID 1, 57600 baud**: each needs its own ID (Boards does it) |
| 1 | **12 V supply** for the motors, ≥ 3 A (4 × XL430 at stall ≈ 4 × 1.4 A; they rarely all pull at once) | with a barrel or screw terminal. Never through the ESP32 |
| 1 | 1 kΩ resistor | between the ESP32's TX and the Dynamixel data line |
| 4 | spools + string on the motor shafts |
| 4 + 4 | **piezo discs** (one per pulled triangle) and **exciters** (one per triangle) | for the sound |
| 1 | **audio interface, 4 in / 4 out** (+ a small 4-channel amp for the exciters if the interface can't drive them) | at one sample rate for in and out |
| – | Dynamixel 3-pin cables (daisy chain), jumper wires, terminal block | |

Optional, for more data later: a **BH1750** light sensor (I²C 0x23/0x5C)
and an **analog mic module** (MAX4466/MAX9814) on the sensor box. They are
not part of the show until switched on in Boards (*part of the show:
light, sound level*).

## Wiring

All the pin numbers below are the defaults. The sensor's I²C pins can be
changed later over USB (`SET`, stored on the board).

### Sensor board

| From | To ESP32 | Notes |
|---|---|---|
| SCD30 VIN | 3V3 (or 5V: the SCD30 takes 3.3–5.5 V) | |
| SCD30 GND | GND | |
| SCD30 SDA (RX/SDA) | **GPIO 21** | |
| SCD30 SCL (TX/SCL) | **GPIO 22** | the bus runs at 50 kHz: the SCD30 stretches the clock |
| SCD30 SEL | leave open (or GND) | open/GND = I²C |
| *optional* BH1750 | 3V3, GND, GPIO 21, GPIO 22 | same two wires as the SCD30 |
| *optional* mic AO | **GPIO 34** | an ADC1 pin: 32–36 or 39 |

Place the SCD30 away from the ESP32 and the USB charger (they warm it up
and skew temperature/humidity), out of direct sun and breath. It
recalibrates itself if it sees fresh outdoor-like air (~400 ppm) now and
then.

### Hub board

Nothing to wire: just a USB cable to the show computer.

### Body board (the motors)

Florian's proven wiring (half duplex, one data wire):

| From | To | Notes |
|---|---|---|
| ESP32 **GPIO 32** (TX) | **1 kΩ** → Dynamixel **DATA** | |
| ESP32 **GPIO 33** (RX) | Dynamixel **DATA** (straight) | every byte sent echoes back; the firmware expects that |
| ESP32 **GND** | Dynamixel **GND** and the 12 V supply's **GND** | **join the grounds** |
| 12 V supply + | Dynamixel **VDD** (middle pin of the chain) | never into the ESP32 |

The four motors are daisy-chained on the same three wires. Motor *k*
winds the string of triangle *k* (M1 red, M2 orange, M3 green, M4 blue in
Florian's drawings and in the app's twin).

### Calibrating the sculpture (Boards → Sculpture motors)

Plug the body's ESP32 into the computer by USB, motors on 12 V, open
**Boards → Connect a board…**. Then:

1. **Find motors.** Four should answer, ids 1–4. If fewer answer: new
   XL430s all come as **ID 1**, so two of them on one line answer as one
   (or not at all). Plug one motor in at a time and give it its ID
   (`1 → 2`, then the next `1 → 3`, …).
2. **Set slack here** — with the structure fully open by itself and every
   string just slack. This is pull 0 for every motor.
3. For each motor: wind it with ◂ ▸ until its triangle is fully drawn in,
   then **Set closed**. That records the direction and the travel, so no
   spool radius or millimetres are needed. **Test** winds it in a little and
   back (start with motor 1).

**Safety, built in:** the body never assumes "where I am at power-up is
slack" (that is what could snap a string). It keeps the slack point, the
travel and the last position in flash, and at every start checks the
motors against them. If they don't match (someone turned a spool by hand,
the strings were changed), it holds no torque and ignores poses until
**Set slack** is done again — the app's status says *needs calibrating*.
Goals are clamped to the calibrated travel, whatever arrives.

## Flashing the boards

### With the web app (easiest)

1. Open the Weathering app in Chrome or Edge (Web Serial is needed: not
   Safari/Firefox) and go to **Boards**.
2. Plug in one ESP32 by USB, **Connect a board…**, pick its port, and press
   **Install** for its part (Sensor box, Hub, Sculpture).
3. When it's done the board restarts and prints
   `FW weathering_<role> 0.2.0 mac … group 1`; the panel shows it.
4. Repeat for the other two boards. Keep all three in the same **group**
   (1 by default).

If the port doesn't show up: try another USB cable (many are charge-only),
and on some boards hold the **BOOT** button while installing starts. On
macOS, CP210x/CH340 drivers are built in (macOS 11+).

### With the Arduino IDE

1. Install the Arduino IDE 2, then in *Boards Manager* install **esp32 by
   Espressif Systems, version 2.0.14**.
2. Open `firmware/weathering_<role>/weathering_<role>.ino`.
3. *Tools → Board → ESP32 Dev Module*, choose the port, **Upload**.
4. Serial Monitor at **115200** baud, type `INFO`.

### Rebuilding the published binaries

After changing anything in `firmware/`: `tools/build_firmware.sh` (uses
the Arduino IDE's bundled `arduino-cli`), then commit
`app/static/firmware/`. The three `wx.h` files must stay identical.

## Checking a board by USB (115200 baud, any serial monitor)

```
INFO                      what it is, its settings
PING                      → PONG
READ                      (sensor) one reading now, e.g. R 1763040000 12 co2=612 t=21.40 rh=44.8
SCAN                      (body) which Dynamixel ids answer, at 57600 and 1 000 000 baud
SET slack=all             (body) the structure is open, strings slack: pull 0 here
SET jog=1,256             (body) turn motor 1 by 256 ticks (4096 = one turn)
SET closed=1              (body) motor 1's triangle is fully in: its travel
TEST 1                    (body) motor 1 in a little and back
POSE 1 1 1 1 30           (body) all strings in (closed) over 30 s
RELAX                     (body) torque off: the structure opens by itself
SET channels=co2,t,rh,lux (sensor) add light to the show (with a BH1750)
SET group=2               (any) change a setting; it is kept after power cuts
```

`sim=` lists the channels that are simulated because no sensor was found.
The sensor's INFO shows what it detected (`sensors=scd30`) and which
channels are part of the show (`channels=co2,t,rh`).
