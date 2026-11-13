// Weathering — sensor board (in the room)
//
// Reads the room every `interval` seconds and sends the reading to the hub
// over ESP-NOW. Sensors are found at boot (I2C, default SDA 21 / SCL 22):
//   SCD41  (0x62)         co2 (ppm), t (°C), rh (%)
//   BH1750 (0x23 / 0x5C)  lux
//   analog mic module     db (dB re. full scale over 1 s; 0 = loudest), on mic_pin (34)
// Whatever is missing is SIMULATED (indoor values with a day/night cycle) and
// flagged, so a bare board already works. No libraries beyond the core:
// the two I2C sensors take a few lines of Wire each.
//
// Every reading goes into a RAM ring buffer (BACKLOG readings, > 3 days at
// 300 s) and leaves it only when the hub has ACKed it, oldest first; ones
// sent late are flagged old. Readings are stamped with the hub's clock
// (WX_TIME); readings taken before the first WX_TIME are stamped
// retroactively when it comes, and none is sent without a time.
//
// USB (115200): INFO, SET <key>=<value> ..., PING, READ (a reading now,
// printed as an R line). Scheduled readings are echoed as "LOG R ...".
// SET keys: group, interval (10-3600 s), sda, scl, mic_pin, simulate (auto|all|none).

#include <WiFi.h>
#include <esp_now.h>
#include <esp_idf_version.h>
#include <Preferences.h>
#include <Wire.h>
#include <math.h>
#include "wx.h"

#define MY_ROLE        WX_ROLE_SENSOR
#define BACKLOG        1024        // readings kept until the hub ACKs them
#define ACK_WAIT_MS    2000        // resend the oldest reading after this
#define HUB_ALIVE_MS   10000       // the hub counts as there if heard this recently
#define OLD_AFTER_MS   60000       // sent this long after it was taken: "old"
#define SEQ_BLOCK      64          // seq is saved to flash once per block

#define SCD41_ADDR     0x62
#define SCD41_POLL_MS  5000
#define SCD41_STALE_MS 60000       // no fresh data this long: treated as missing

enum { SIM_AUTO = 0, SIM_ALL = 1, SIM_NONE = 2 };
static const char *const SIM_NAMES[] = {"auto", "all", "none"};

// ---- settings (flash) -------------------------------------------------------
static Preferences prefs;
static uint8_t  group    = 1;
static uint16_t interval = 300;
static uint8_t  sda_pin  = 21, scl_pin = 22, mic_pin = 34;
static uint8_t  simulate = SIM_AUTO;
static uint16_t seq      = 0;      // next reading's number
static uint16_t seq_saved = 0;     // flash holds this as the next block start

static WxLine usb = {};

// One reading (declared up here: Arduino puts its function prototypes
// before the first function).
typedef struct {
  uint16_t seq;
  uint32_t ms;        // when taken (millis)
  uint32_t unix;      // when taken (0: no clock yet; stamped when it arrives)
  uint8_t  flags;     // simulated mask (old is decided when sent)
  uint8_t  present;
  float    v[WX_CHANNELS];
} Reading;

// ---- packets from the Wi-Fi task, handled in loop() -------------------------
typedef struct { uint8_t mac[6]; WxPacket p; } RxItem;
#define RX_QUEUE 16
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static RxItem rx_q[RX_QUEUE];
static uint8_t rx_head = 0, rx_n = 0;

static void on_packet(const uint8_t *mac, const uint8_t *data, int len) {
  const WxPacket *p = wx_accept(data, len, group);
  if (!p || p->role != WX_ROLE_HUB) return;   // the sensor only listens to the hub
  portENTER_CRITICAL(&g_mux);
  if (rx_n < RX_QUEUE) {
    RxItem *it = &rx_q[(rx_head + rx_n) % RX_QUEUE];
    memcpy(it->mac, mac, 6);
    it->p = *p;
    rx_n++;
  }
  portEXIT_CRITICAL(&g_mux);
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
static void on_data_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  on_packet(info->src_addr, data, len);
}
#else
static void on_data_recv(const uint8_t *mac, const uint8_t *data, int len) {
  on_packet(mac, data, len);
}
#endif

static bool pop_rx(RxItem *out) {
  bool got = false;
  portENTER_CRITICAL(&g_mux);
  if (rx_n) {
    *out = rx_q[rx_head];
    rx_head = (rx_head + 1) % RX_QUEUE;
    rx_n--;
    got = true;
  }
  portEXIT_CRITICAL(&g_mux);
  return got;
}

static void add_peer(const uint8_t *mac) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t info = {};
  memcpy(info.peer_addr, mac, 6);
  esp_now_add_peer(&info);
}

// ---- hub and clock ----------------------------------------------------------
static uint8_t  hub_mac[6];
static bool     hub_known = false;
static uint32_t hub_ms = 0;
static uint32_t clock_unix = 0, clock_ms = 0;   // hub's time at clock_ms (0: none yet)

static bool hub_alive() { return hub_known && millis() - hub_ms < HUB_ALIVE_MS; }

// Unix time of a moment given in millis() (0 while we have no clock).
static uint32_t unix_at(uint32_t ms) {
  if (!clock_unix) return 0;
  return clock_unix - (uint32_t)((int32_t)(clock_ms - ms) / 1000);
}

// ---- sensors ------------------------------------------------------------------
static bool    have_scd41 = false;
static uint8_t bh1750_addr = 0;        // 0: none
static bool    have_mic = false;

static float    scd_v[3];              // last good co2, t, rh
static uint32_t scd_ms = 0;            // when (0: never)
static uint32_t next_scd_poll_ms = 0;

static bool i2c_present(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static bool i2c_cmd16(uint8_t addr, uint16_t cmd) {
  Wire.beginTransmission(addr);
  Wire.write(cmd >> 8);
  Wire.write(cmd & 0xFF);
  return Wire.endTransmission() == 0;
}

// Sensirion CRC-8 (poly 0x31, init 0xFF) over one 16-bit word.
static uint8_t scd_crc(const uint8_t *d) {
  uint8_t crc = 0xFF;
  for (int i = 0; i < 2; i++) {
    crc ^= d[i];
    for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
  }
  return crc;
}

// Reads n words (each followed by its CRC) after a command.
static bool scd_read_words(uint16_t cmd, uint16_t *words, int n) {
  if (!i2c_cmd16(SCD41_ADDR, cmd)) return false;
  delay(2);
  if (Wire.requestFrom((int)SCD41_ADDR, n * 3) != n * 3) return false;
  for (int i = 0; i < n; i++) {
    uint8_t b[3];
    for (int j = 0; j < 3; j++) b[j] = Wire.read();
    if (scd_crc(b) != b[2]) return false;
    words[i] = (uint16_t)(b[0] << 8 | b[1]);
  }
  return true;
}

static void scd_poll() {
  uint16_t ready, w[3];
  if (!scd_read_words(0xE4B8, &ready, 1)) return;           // get_data_ready_status
  if ((ready & 0x07FF) == 0) return;
  if (!scd_read_words(0xEC05, w, 3)) return;                 // read_measurement
  if (w[0] == 0) return;                                     // not a valid sample
  scd_v[0] = w[0];
  scd_v[1] = -45.0f + 175.0f * w[1] / 65535.0f;
  scd_v[2] = 100.0f * w[2] / 65535.0f;
  scd_ms = millis();
}

static float bh1750_read() {
  if (Wire.requestFrom((int)bh1750_addr, 2) != 2) return -1;
  uint16_t raw = (uint16_t)(Wire.read() << 8);
  raw |= Wire.read();
  return raw / 1.2f;
}

// A mic module (MAX4466, MAX9814, KY-038 analog out...) sits at about half
// the supply when quiet; an unconnected or grounded pin reads near 0 or 4095.
// This is a guess, not a real detection: see docs/HARDWARE.md.
static bool mic_probe() {
  long sum = 0;
  for (int i = 0; i < 64; i++) { sum += analogRead(mic_pin); delayMicroseconds(200); }
  long mean = sum / 64;
  return mean > 600 && mean < 3500;
}

// Sound level over 1 s: RMS of the signal around its mean, in dB re. a
// full-scale square wave (so 0 is the loudest the ADC can see).
static float mic_db() {
  int64_t sum = 0, sumsq = 0;
  uint32_t n = 0, t0 = micros(), next = t0;
  while (micros() - t0 < 1000000UL) {
    if ((int32_t)(micros() - next) < 0) continue;
    next += 125;                                  // ~8 kHz
    int x = analogRead(mic_pin);
    sum += x;
    sumsq += (int64_t)x * x;
    n++;
  }
  if (!n) return -90;
  double mean = (double)sum / n;
  double var = (double)sumsq / n - mean * mean;
  double rms = var > 0 ? sqrt(var) : 0;
  double db = rms > 0 ? 20.0 * log10(rms / 2048.0) : -90.0;
  return db < -90 ? -90 : (float)db;
}

static void detect_sensors() {
  Wire.end();
  Wire.begin((int)sda_pin, (int)scl_pin, (uint32_t)100000);
  have_scd41 = i2c_present(SCD41_ADDR);
  if (have_scd41) {
    i2c_cmd16(SCD41_ADDR, 0x3F86);                // stop_periodic_measurement (if it was running)
    delay(500);
    have_scd41 = i2c_cmd16(SCD41_ADDR, 0x21B1);   // start_periodic_measurement (every 5 s)
    scd_ms = 0;
    next_scd_poll_ms = millis() + SCD41_POLL_MS;
  }
  bh1750_addr = i2c_present(0x23) ? 0x23 : i2c_present(0x5C) ? 0x5C : 0;
  if (bh1750_addr) {
    Wire.beginTransmission(bh1750_addr); Wire.write(0x01); Wire.endTransmission();   // power on
    Wire.beginTransmission(bh1750_addr); Wire.write(0x10); Wire.endTransmission();   // continuous, 1 lx
  }
  analogSetPinAttenuation(mic_pin, ADC_11db);
  have_mic = mic_probe();
}

// Is a channel read from a real sensor right now (else simulated or absent)?
static bool real(int ch) {
  if (simulate == SIM_ALL) return false;
  switch (ch) {
    case WX_CO2: case WX_T: case WX_RH:
      return have_scd41 && scd_ms && millis() - scd_ms < SCD41_STALE_MS;
    case WX_LUX: return bh1750_addr != 0;
    case WX_DB:  return have_mic || simulate == SIM_NONE;   // "none": trust the mic pin
  }
  return false;
}

// ---- simulation: a plausible indoor room ---------------------------------------
static float sim_walk[WX_CHANNELS];

static float frand() { return (esp_random() / 4294967295.0f) * 2 - 1; }   // -1..1

static void simulate_into(float *v) {
  // Local hour (Central Europe, no DST) from the hub's clock, or from
  // power-on as if it were noon.
  uint32_t t = unix_at(millis());
  float hour = t ? fmodf((t % 86400UL) / 3600.0f + 1.0f, 24.0f)
                 : fmodf(12.0f + millis() / 3600000.0f, 24.0f);
  float people = (hour > 9 && hour < 19) ? sinf((float)M_PI * (hour - 9) / 10) : 0;    // visitors
  float sun = (hour > 6 && hour < 20) ? sinf((float)M_PI * (hour - 6) / 14) : 0;       // daylight
  float day = sinf(2 * (float)M_PI * (hour - 9) / 24);                                  // warmest mid-afternoon
  static const float STEP[WX_CHANNELS] = {15, 0.1f, 0.5f, 0.05f, 1.0f};
  static const float LIMIT[WX_CHANNELS] = {80, 0.6f, 4, 0.3f, 4};
  for (int i = 0; i < WX_CHANNELS; i++) {
    sim_walk[i] = constrain(sim_walk[i] * 0.95f + STEP[i] * frand(), -LIMIT[i], LIMIT[i]);
  }
  v[WX_CO2] = 430 + 520 * people + sim_walk[WX_CO2];
  v[WX_T]   = 20.0f + 1.5f * day + 0.8f * people + sim_walk[WX_T];
  v[WX_RH]  = 48 - 5 * day - 2 * people + sim_walk[WX_RH];
  v[WX_LUX] = (3 + 320 * sun + 180 * people) * (1 + sim_walk[WX_LUX]);
  v[WX_DB]  = -64 + 24 * people + sim_walk[WX_DB];
  if (v[WX_CO2] < 400) v[WX_CO2] = 400;
  if (v[WX_LUX] < 0) v[WX_LUX] = 0;
}

// ---- readings and the backlog ---------------------------------------------------

static Reading  backlog[BACKLOG];
static uint16_t bl_head = 0, bl_n = 0;
static bool     bl_inflight = false;
static uint32_t bl_sent_ms = 0;
static uint32_t lost_full = 0;          // readings dropped because the backlog was full
static uint32_t next_read_ms = 0;

static void to_packet(const Reading *r, WxPacket *p, bool old) {
  wx_init(p, WX_READING, group, MY_ROLE);
  p->seq = r->seq;
  p->unix = r->unix;
  p->flags = r->flags | (old ? WX_FLAG_OLD : 0);
  p->present = r->present;
  for (int i = 0; i < WX_CHANNELS; i++) p->v[i] = r->v[i];
}

static Reading take_reading() {
  Reading r = {};
  r.seq = seq++;
  if (seq == seq_saved) {                  // used up the block: reserve the next
    seq_saved = (uint16_t)(seq + SEQ_BLOCK);
    prefs.putUShort("seq", seq_saved);
  }
  float sim[WX_CHANNELS];
  simulate_into(sim);
  for (int i = 0; i < WX_CHANNELS; i++) {
    float v = NAN;
    if (real(i)) {
      if (i <= WX_RH) v = scd_v[i];
      else if (i == WX_LUX) v = bh1750_read();
      else v = mic_db();
      if (i == WX_LUX && v < 0) v = NAN;   // read failed
    }
    if (!isnan(v)) {
      r.v[i] = v;
      r.present |= 1 << i;
    } else if (simulate != SIM_NONE) {
      r.v[i] = sim[i];
      r.present |= 1 << i;
      r.flags |= WX_FLAG_SIM(i);
    }
  }
  r.ms = millis();
  r.unix = unix_at(r.ms);
  if (bl_n == BACKLOG) {                   // full: the oldest is lost
    bl_head = (bl_head + 1) % BACKLOG;
    bl_n--;
    bl_inflight = false;
    lost_full++;
  }
  backlog[(bl_head + bl_n) % BACKLOG] = r;
  bl_n++;
  return r;
}

static void print_reading(const Reading *r, const char *prefix) {
  WxPacket p;
  to_packet(r, &p, false);
  char line[200];
  wx_format_reading(&p, line, sizeof(line));
  Serial.printf("%s%s\n", prefix, line);
}

static void service_backlog() {
  if (!bl_n || !hub_alive() || !clock_unix) return;
  if (bl_inflight && millis() - bl_sent_ms < ACK_WAIT_MS) return;
  Reading *r = &backlog[bl_head];
  WxPacket p;
  to_packet(r, &p, millis() - r->ms > OLD_AFTER_MS);
  esp_now_send(hub_mac, (const uint8_t *)&p, sizeof(p));
  bl_inflight = true;
  bl_sent_ms = millis();
}

static void on_ack(uint16_t s) {
  if (!bl_n || backlog[bl_head].seq != s) return;
  bl_head = (bl_head + 1) % BACKLOG;
  bl_n--;
  bl_inflight = false;                     // the next one goes out right away
}

// ---- HELLO ------------------------------------------------------------------------
static uint32_t next_hello_ms = 0;

static void send_hello() {
  WxPacket p;
  wx_init(&p, WX_HELLO, group, MY_ROLE);
  esp_now_send(WX_BROADCAST, (const uint8_t *)&p, sizeof(p));
  next_hello_ms = millis() + WX_HELLO_MS + (esp_random() % 500);
}

// ---- SET (over USB, or CFG from the hub) ------------------------------------------
static bool adc1_pin(long p) { return p == 32 || p == 33 || (p >= 34 && p <= 36) || p == 39; }
static bool io_pin(long p) { return p >= 0 && p <= 33 && !(p >= 6 && p <= 11) && p != 20 && p != 24 && !(p >= 28 && p <= 31); }

// Applies "key=value ..." (all or nothing); writes "OK SET" or "ERR ..." to out.
static void apply_set(char *args, char *out, size_t size) {
  long g = group, iv = interval, sda = sda_pin, scl = scl_pin, mic = mic_pin, sim = simulate;
  bool any = false;
  for (char *tok = strtok(args, " "); tok; tok = strtok(nullptr, " ")) {
    char *k, *v;
    any = true;
    if (!wx_split_kv(tok, &k, &v)) { snprintf(out, size, "ERR bad pair %s", tok); return; }
    if (strcmp(k, "group") == 0) {
      if (!wx_parse_long(v, WX_GROUP_MIN, WX_GROUP_MAX, &g)) { snprintf(out, size, "ERR group 1-250"); return; }
    } else if (strcmp(k, "interval") == 0) {
      if (!wx_parse_long(v, 10, 3600, &iv)) { snprintf(out, size, "ERR interval 10-3600"); return; }
    } else if (strcmp(k, "sda") == 0 || strcmp(k, "scl") == 0) {
      long p;
      if (!wx_parse_long(v, 0, 39, &p) || !io_pin(p)) { snprintf(out, size, "ERR %s not an I/O pin", k); return; }
      (k[1] == 'd' ? sda : scl) = p;
    } else if (strcmp(k, "mic_pin") == 0) {
      if (!wx_parse_long(v, 0, 39, &mic) || !adc1_pin(mic)) { snprintf(out, size, "ERR mic_pin 32-36 or 39"); return; }
    } else if (strcmp(k, "simulate") == 0) {
      sim = -1;
      for (int i = 0; i < 3; i++) if (strcmp(v, SIM_NAMES[i]) == 0) sim = i;
      if (sim < 0) { snprintf(out, size, "ERR simulate auto|all|none"); return; }
    } else {
      snprintf(out, size, "ERR unknown key %s", k);
      return;
    }
  }
  if (!any) { snprintf(out, size, "ERR nothing to set"); return; }
  if (sda == scl) { snprintf(out, size, "ERR sda and scl are the same pin"); return; }
  bool pins = sda != sda_pin || scl != scl_pin || mic != mic_pin;
  if (iv != interval) next_read_ms = millis() + iv * 1000UL;
  group = g; interval = iv; sda_pin = sda; scl_pin = scl; mic_pin = mic; simulate = sim;
  prefs.putUChar("group", group);
  prefs.putUShort("interval", interval);
  prefs.putUChar("sda", sda_pin);
  prefs.putUChar("scl", scl_pin);
  prefs.putUChar("mic_pin", mic_pin);
  prefs.putUChar("simulate", simulate);
  if (pins) detect_sensors();
  snprintf(out, size, "OK SET");
}

// ---- USB --------------------------------------------------------------------------
static void list_sensors(char *out, size_t size) {
  int n = snprintf(out, size, "%s%s%s", have_scd41 ? ",scd41" : "", bh1750_addr ? ",bh1750" : "",
                   have_mic ? ",mic" : "");
  if (!n) snprintf(out, size, "none");
  else memmove(out, out + 1, n);           // drop the leading comma
}

static void list_sim(char *out, size_t size) {
  int n = 0;
  out[0] = 0;
  for (int i = 0; i < WX_CHANNELS; i++) {
    if (!real(i) && simulate != SIM_NONE) n += snprintf(out + n, size - n, "%s%s", n ? "," : "", WX_CHANNEL_NAMES[i]);
  }
  if (!n) snprintf(out, size, "none");
}

static void print_info() {
  char sensors[32], sim[32];
  list_sensors(sensors, sizeof(sensors));
  list_sim(sim, sizeof(sim));
  Serial.printf("INFO sensor fw %s mac %s group %u interval=%u sensors=%s sim=%s simulate=%s "
                "sda=%u scl=%u mic_pin=%u backlog=%u hub=%d time=%lu\n",
                FW_VERSION, WiFi.macAddress().c_str(), group, interval, sensors, sim,
                SIM_NAMES[simulate], sda_pin, scl_pin, mic_pin, bl_n, hub_alive() ? 1 : 0,
                (unsigned long)unix_at(millis()));
}

static void handle_command(char *line) {
  while (*line == ' ') line++;
  char *args = strchr(line, ' ');
  if (args) *args++ = 0;
  else args = line + strlen(line);
  if (strcmp(line, "PING") == 0) {
    Serial.println("PONG");
  } else if (strcmp(line, "INFO") == 0) {
    print_info();
  } else if (strcmp(line, "SET") == 0) {
    char out[64];
    apply_set(args, out, sizeof(out));
    Serial.println(out);
  } else if (strcmp(line, "READ") == 0) {
    Reading r = take_reading();
    print_reading(&r, "");
  } else if (*line) {
    Serial.printf("ERR unknown command %s\n", line);
  }
}

// ---- radio --------------------------------------------------------------------------
static void handle_radio(const RxItem *it) {
  const WxPacket *p = &it->p;
  if (!hub_known || memcmp(hub_mac, it->mac, 6) != 0) {
    if (hub_alive() && p->type != WX_HELLO) return;   // stay with the hub we have
    memcpy(hub_mac, it->mac, 6);
    hub_known = true;
    add_peer(hub_mac);
    char mac[18];
    wx_mac_str(hub_mac, mac);
    Serial.printf("LOG hub %s\n", mac);
    bl_inflight = false;
  }
  hub_ms = millis();
  switch (p->type) {
    case WX_TIME:
      if (p->unix > 1000000000UL) {
        bool first = !clock_unix;
        clock_unix = p->unix;
        clock_ms = millis();
        if (first) {                       // stamp what was read before we knew the time
          for (uint16_t i = 0; i < bl_n; i++) {
            Reading *r = &backlog[(bl_head + i) % BACKLOG];
            if (!r->unix) r->unix = unix_at(r->ms);
          }
          Serial.printf("LOG time %lu\n", (unsigned long)clock_unix);
        }
      }
      break;
    case WX_ACK:
      on_ack(p->seq);
      break;
    case WX_READ: {
      Reading r = take_reading();
      print_reading(&r, "LOG ");
      break;
    }
    case WX_CONFIG: {
      char text[WX_TEXT_LEN + 1];
      memcpy(text, p->text, WX_TEXT_LEN);
      text[WX_TEXT_LEN] = 0;
      Serial.printf("LOG CFG from hub: %s\n", text);
      WxPacket a;
      wx_init(&a, WX_CONFIG, group, MY_ROLE);   // the answer goes out in the old group
      apply_set(text, a.text, sizeof(a.text));
      Serial.printf("LOG %s\n", a.text);
      esp_now_send(it->mac, (const uint8_t *)&a, sizeof(a));
      break;
    }
    default:
      break;
  }
}

// ---- setup / loop ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  prefs.begin("weathering", false);
  group    = prefs.getUChar("group", 1);
  interval = prefs.getUShort("interval", 300);
  sda_pin  = prefs.getUChar("sda", 21);
  scl_pin  = prefs.getUChar("scl", 22);
  mic_pin  = prefs.getUChar("mic_pin", 34);
  simulate = prefs.getUChar("simulate", SIM_AUTO);
  if (group < WX_GROUP_MIN || group > WX_GROUP_MAX) group = 1;
  if (interval < 10 || interval > 3600) interval = 300;
  if (!io_pin(sda_pin) || !io_pin(scl_pin) || sda_pin == scl_pin) { sda_pin = 21; scl_pin = 22; }
  if (!adc1_pin(mic_pin)) mic_pin = 34;
  if (simulate > SIM_NONE) simulate = SIM_AUTO;
  // seq continues after a reboot: start at the reserved block, reserve the next.
  seq = prefs.getUShort("seq", 0);
  seq_saved = (uint16_t)(seq + SEQ_BLOCK);
  prefs.putUShort("seq", seq_saved);

  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) Serial.println("ERR esp_now_init");
  esp_now_register_recv_cb(on_data_recv);
  add_peer(WX_BROADCAST);

  detect_sensors();
  Serial.printf("FW weathering_sensor %s mac %s group %u\n", FW_VERSION, WiFi.macAddress().c_str(), group);
  char sensors[32], sim[32];
  list_sensors(sensors, sizeof(sensors));
  list_sim(sim, sizeof(sim));
  Serial.printf("LOG sensors=%s sim=%s (the SCD41's first value comes after ~5 s)\n", sensors, sim);
  send_hello();
  next_read_ms = millis() + 10000;         // first reading soon after boot
}

void loop() {
  if (wx_read_line(Serial, &usb)) handle_command(usb.buf);
  RxItem it;
  while (pop_rx(&it)) handle_radio(&it);

  uint32_t now = millis();
  if (have_scd41 && simulate != SIM_ALL && (int32_t)(now - next_scd_poll_ms) >= 0) {
    scd_poll();
    next_scd_poll_ms = now + SCD41_POLL_MS;
  }
  if ((int32_t)(now - next_read_ms) >= 0) {
    next_read_ms += interval * 1000UL;
    if ((int32_t)(millis() - next_read_ms) >= 0) next_read_ms = millis() + interval * 1000UL;
    Reading r = take_reading();
    print_reading(&r, "LOG ");
  }
  if (lost_full) {
    Serial.printf("LOG backlog full, %lu oldest readings dropped\n", (unsigned long)lost_full);
    lost_full = 0;
  }
  service_backlog();
  if ((int32_t)(millis() - next_hello_ms) >= 0) send_hello();
  delay(2);
}
