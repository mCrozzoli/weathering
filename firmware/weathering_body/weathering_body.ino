// Weathering — body board (inside the sculpture)
//
// Drives 6 hobby servos (50 Hz PWM from the LEDC peripheral) to the pose it
// is told, gliding linearly from where it is over glide_s seconds. A pose
// value is 0 at that servo's closed end and 1 at its open end, as
// calibrated here with s<k>=<pin>,<min_us>,<max_us>,<closed>.
//
// The TARGET pose is stored in flash when the body gets there, and at boot
// the servos go straight to the stored pose (all closed the very first
// time), so after a power cut the sculpture stands where it was.
//
// Radio (from the hub): WX_POSE (answered with WX_ACK seq), WX_TEST,
// WX_RELAX, WX_CONFIG. It reports WX_BODYSTATE every 2 s while moving and
// whenever something changes (also echoed on USB as a BODY line).
//
// USB (115200): INFO, SET <key>=<value> ..., PING,
//   POSE <a0> .. <a5> <glide_s>, TEST <k>, RELAX.
// SET keys: group, s<k>=<pin>,<min_us>,<max_us>,<closed 0|1>.
//
// Servos need their own 5-6 V supply with its ground joined to the ESP32's
// (docs/HARDWARE.md); the ESP32 only gives them the signal.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_idf_version.h>
#include <Preferences.h>
#include "wx.h"

#define MY_ROLE        WX_ROLE_BODY
#define N_SERVOS       6
#define SERVO_HZ       50
#define SERVO_BITS     16
#define UPDATE_MS      20          // servo update (one PWM period)
#define STATE_EVERY_MS 2000        // BODYSTATE while moving
#define HUB_ALIVE_MS   10000
#define TEST_MS        1800        // TEST: three small wiggles
#define TEST_SWING     0.12f

typedef struct { uint8_t pin; uint16_t min_us, max_us; uint8_t closed; } ServoCfg;
static const uint8_t DEFAULT_PINS[N_SERVOS] = {13, 12, 14, 27, 26, 25};

// ---- packets from the Wi-Fi task, handled in loop() -------------------------
typedef struct { uint8_t mac[6]; WxPacket p; } RxItem;
#define RX_QUEUE 16
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static RxItem rx_q[RX_QUEUE];
static uint8_t rx_head = 0, rx_n = 0;

static void on_packet(const uint8_t *mac, const uint8_t *data, int len);

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
static void on_data_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  on_packet(info->src_addr, data, len);
}
#else
static void on_data_recv(const uint8_t *mac, const uint8_t *data, int len) {
  on_packet(mac, data, len);
}
#endif

// ---- settings (flash) -------------------------------------------------------
static Preferences prefs;
static uint8_t  group = 1;
static ServoCfg cfg[N_SERVOS];
static WxLine   usb = {};

// ---- motion -------------------------------------------------------------------
static float    cur[N_SERVOS];        // where each servo is now (0 closed .. 1 open)
static float    from[N_SERVOS];       // where the glide started
static float    target[N_SERVOS];
static uint32_t glide_ms = 0, glide_start = 0;
static bool     moving = false;
static bool     relaxed = false;      // PWM off, servos limp
static bool     attached[N_SERVOS];
static uint16_t last_pose_seq = 0;
static bool     have_pose_seq = false;
static int      test_k = -1;          // servo being wiggled
static uint32_t test_start = 0;
static bool     test_relax_after = false;
static uint32_t next_update_ms = 0, next_state_ms = 0;
static bool     state_dirty = true;   // send a BODYSTATE soon

static void on_packet(const uint8_t *mac, const uint8_t *data, int len) {
  const WxPacket *p = wx_accept(data, len, group);
  if (!p || p->role != WX_ROLE_HUB) return;    // the body only listens to the hub
  portENTER_CRITICAL(&g_mux);
  if (rx_n < RX_QUEUE) {
    RxItem *it = &rx_q[(rx_head + rx_n) % RX_QUEUE];
    memcpy(it->mac, mac, 6);
    it->p = *p;
    rx_n++;
  }
  portEXIT_CRITICAL(&g_mux);
}

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

// ---- PWM (the LEDC API changed in Arduino-ESP32 3.x) ------------------------------
static void pwm_attach(int k) {
  if (attached[k]) return;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttachChannel(cfg[k].pin, SERVO_HZ, SERVO_BITS, k);
#else
  ledcSetup(k, SERVO_HZ, SERVO_BITS);
  ledcAttachPin(cfg[k].pin, k);
#endif
  attached[k] = true;
}

static void pwm_detach(int k) {
  if (!attached[k]) return;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcDetach(cfg[k].pin);
#else
  ledcDetachPin(cfg[k].pin);
#endif
  pinMode(cfg[k].pin, OUTPUT);
  digitalWrite(cfg[k].pin, LOW);      // no pulses: the servo stops holding
  attached[k] = false;
}

// Position 0..1 (0 = closed end) -> pulse width -> duty.
static void servo_write(int k, float a) {
  if (!attached[k]) return;
  a = constrain(a, 0.0f, 1.0f);
  const ServoCfg *c = &cfg[k];
  float span = (float)c->max_us - c->min_us;
  float us = c->closed ? c->max_us - a * span : c->min_us + a * span;
  uint32_t duty = (uint32_t)(us * ((1UL << SERVO_BITS) - 1) / (1000000.0f / SERVO_HZ) + 0.5f);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(c->pin, duty);
#else
  ledcWrite(k, duty);
#endif
}

static void attach_all() {
  for (int k = 0; k < N_SERVOS; k++) { pwm_attach(k); servo_write(k, cur[k]); }
  relaxed = false;
}

// ---- hub ----------------------------------------------------------------------------
static uint8_t  hub_mac[6];
static bool     hub_known = false;
static uint32_t hub_ms = 0;

static bool hub_alive() { return hub_known && millis() - hub_ms < HUB_ALIVE_MS; }

static void send_state() {
  WxPacket p;
  wx_init(&p, WX_BODYSTATE, group, MY_ROLE);
  for (int k = 0; k < N_SERVOS; k++) p.v[k] = cur[k];
  p.flags = moving ? WX_FLAG_MOVING : 0;
  if (hub_alive()) esp_now_send(hub_mac, (const uint8_t *)&p, sizeof(p));
  Serial.printf("BODY %.3f %.3f %.3f %.3f %.3f %.3f moving=%d\n",
                cur[0], cur[1], cur[2], cur[3], cur[4], cur[5], moving ? 1 : 0);
  next_state_ms = millis() + STATE_EVERY_MS;
  state_dirty = false;
}

// ---- poses --------------------------------------------------------------------------
static void save_target() {
  prefs.putBytes("pose", target, sizeof(target));
}

static void start_pose(const float *a, uint16_t glide_s) {
  if (relaxed || test_k >= 0) {
    test_k = -1;
    attach_all();
  }
  for (int k = 0; k < N_SERVOS; k++) {
    from[k] = cur[k];
    target[k] = constrain(a[k], 0.0f, 1.0f);
  }
  glide_ms = glide_s * 1000UL;
  glide_start = millis();
  moving = true;
  state_dirty = true;
  Serial.printf("LOG pose %.3f %.3f %.3f %.3f %.3f %.3f over %u s\n",
                target[0], target[1], target[2], target[3], target[4], target[5], glide_s);
}

static void service_motion() {
  uint32_t now = millis();
  if ((int32_t)(now - next_update_ms) < 0) return;
  next_update_ms = now + UPDATE_MS;
  if (moving) {
    uint32_t t = now - glide_start;
    float f = glide_ms ? (float)t / glide_ms : 1.0f;
    if (f >= 1.0f) {
      for (int k = 0; k < N_SERVOS; k++) cur[k] = target[k];
      moving = false;
      save_target();                   // arrived: this is where we stand after a power cut
      state_dirty = true;
    } else {
      for (int k = 0; k < N_SERVOS; k++) cur[k] = from[k] + (target[k] - from[k]) * f;
    }
    for (int k = 0; k < N_SERVOS; k++) if (k != test_k) servo_write(k, cur[k]);
  }
  if (test_k >= 0) {
    uint32_t t = now - test_start;
    if (t >= TEST_MS) {
      servo_write(test_k, cur[test_k]);
      if (test_relax_after) pwm_detach(test_k);
      test_k = -1;
    } else {
      // Swing towards the middle so a servo at an end doesn't push into it.
      float dir = cur[test_k] < 0.5f ? 1.0f : -1.0f;
      float w = 0.5f - 0.5f * cosf(2 * (float)M_PI * t / (TEST_MS / 3.0f));
      servo_write(test_k, cur[test_k] + dir * TEST_SWING * w);
    }
  }
}

static void start_test(int k) {
  test_relax_after = relaxed || !attached[k];
  if (test_k >= 0 && test_k != k) servo_write(test_k, cur[test_k]);
  pwm_attach(k);
  test_k = k;
  test_start = millis();
}

static void relax() {
  test_k = -1;
  if (moving) {                         // stop where we are
    for (int k = 0; k < N_SERVOS; k++) target[k] = cur[k];
    moving = false;
  }
  for (int k = 0; k < N_SERVOS; k++) pwm_detach(k);
  relaxed = true;
  state_dirty = true;
}

// ---- SET (over USB, or CFG from the hub) ----------------------------------------------
static bool out_pin(long p) { return p >= 0 && p <= 33 && !(p >= 6 && p <= 11) && p != 20 && p != 24 && !(p >= 28 && p <= 31); }

static void save_cfg() { prefs.putBytes("servos", cfg, sizeof(cfg)); }

// Applies "key=value ..." (all or nothing); writes "OK SET" or "ERR ..." to out.
static void apply_set(char *args, char *out, size_t size) {
  long g = group;
  ServoCfg c[N_SERVOS];
  memcpy(c, cfg, sizeof(c));
  bool any = false;
  for (char *tok = strtok(args, " "); tok; tok = strtok(nullptr, " ")) {
    char *k, *v;
    any = true;
    if (!wx_split_kv(tok, &k, &v)) { snprintf(out, size, "ERR bad pair %s", tok); return; }
    if (strcmp(k, "group") == 0) {
      if (!wx_parse_long(v, WX_GROUP_MIN, WX_GROUP_MAX, &g)) { snprintf(out, size, "ERR group 1-250"); return; }
    } else if (k[0] == 's' && k[1] >= '0' && k[1] < '0' + N_SERVOS && k[2] == 0) {
      int i = k[1] - '0';
      char *f[4];
      int n = 0;
      for (char *q = v; n < 4; ) {
        f[n++] = q;
        q = strchr(q, ',');
        if (!q) break;
        *q++ = 0;
      }
      long pin, mn, mx, cl;
      if (n != 4 || !wx_parse_long(f[0], 0, 39, &pin) || !wx_parse_long(f[1], 400, 2600, &mn) ||
          !wx_parse_long(f[2], 400, 2600, &mx) || !wx_parse_long(f[3], 0, 1, &cl)) {
        snprintf(out, size, "ERR %s=<pin>,<min_us>,<max_us>,<0|1>", k);
        return;
      }
      if (!out_pin(pin)) { snprintf(out, size, "ERR %s: pin %ld can't drive a servo", k, pin); return; }
      if (mx < mn + 100) { snprintf(out, size, "ERR %s: max_us must be > min_us + 100", k); return; }
      c[i] = ServoCfg{(uint8_t)pin, (uint16_t)mn, (uint16_t)mx, (uint8_t)cl};
    } else {
      snprintf(out, size, "ERR unknown key %s", k);
      return;
    }
  }
  if (!any) { snprintf(out, size, "ERR nothing to set"); return; }
  for (int i = 0; i < N_SERVOS; i++)
    for (int j = i + 1; j < N_SERVOS; j++)
      if (c[i].pin == c[j].pin) { snprintf(out, size, "ERR s%d and s%d on the same pin", i, j); return; }
  // Apply: servos whose pin changed move to their new pin.
  for (int k = 0; k < N_SERVOS; k++) {
    if (c[k].pin != cfg[k].pin && attached[k]) {
      pwm_detach(k);
      cfg[k] = c[k];
      pwm_attach(k);
    } else {
      cfg[k] = c[k];
    }
    servo_write(k, cur[k]);
  }
  save_cfg();
  if (g != group) {
    group = (uint8_t)g;
    prefs.putUChar("group", group);
    hub_known = false;                  // find the hub of the new group
  }
  snprintf(out, size, "OK SET");
}

// ---- USB ------------------------------------------------------------------------------
static void print_info() {
  Serial.printf("INFO body fw %s mac %s group %u pose=%.3f,%.3f,%.3f,%.3f,%.3f,%.3f",
                FW_VERSION, WiFi.macAddress().c_str(), group,
                target[0], target[1], target[2], target[3], target[4], target[5]);
  for (int k = 0; k < N_SERVOS; k++) {
    Serial.printf(" s%d=%u,%u,%u,%u", k, cfg[k].pin, cfg[k].min_us, cfg[k].max_us, cfg[k].closed);
  }
  Serial.printf(" moving=%d relaxed=%d hub=%d\n", moving ? 1 : 0, relaxed ? 1 : 0, hub_alive() ? 1 : 0);
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
  } else if (strcmp(line, "POSE") == 0) {
    char *tok[8];
    int n = 0;
    for (char *t = strtok(args, " "); t && n < 8; t = strtok(nullptr, " ")) tok[n++] = t;
    float a[N_SERVOS];
    long glide;
    bool ok = n == 7 && wx_parse_long(tok[6], 0, 3600, &glide);
    for (int k = 0; ok && k < N_SERVOS; k++) ok = wx_parse_float(tok[k], 0.0f, 1.0f, &a[k]);
    if (!ok) { Serial.println("ERR usage POSE <a0> .. <a5> <glide_s> (a in 0..1, glide 0..3600)"); return; }
    start_pose(a, (uint16_t)glide);
    Serial.println("OK POSE");
  } else if (strcmp(line, "TEST") == 0) {
    long k;
    if (!wx_parse_long(args, 0, N_SERVOS - 1, &k)) { Serial.println("ERR usage TEST <0..5>"); return; }
    start_test((int)k);
    Serial.println("OK TEST");
  } else if (strcmp(line, "RELAX") == 0) {
    relax();
    Serial.println("OK RELAX");
  } else if (*line) {
    Serial.printf("ERR unknown command %s\n", line);
  }
}

// ---- radio ------------------------------------------------------------------------------
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
    state_dirty = true;                 // tell the new hub where we are
  }
  hub_ms = millis();
  switch (p->type) {
    case WX_POSE: {
      // A retry of the pose we already have is only acknowledged again.
      bool same = have_pose_seq && p->seq == last_pose_seq;
      for (int k = 0; same && k < N_SERVOS; k++) same = fabsf(p->v[k] - target[k]) < 0.0005f;
      if (!same) {
        last_pose_seq = p->seq;
        have_pose_seq = true;
        float a[N_SERVOS];
        memcpy(a, p->v, sizeof(a));        // (p->v is a packed member)
        start_pose(a, p->glide_s > 3600 ? 3600 : p->glide_s);
      }
      WxPacket a;
      wx_init(&a, WX_ACK, group, MY_ROLE);
      a.seq = p->seq;
      esp_now_send(it->mac, (const uint8_t *)&a, sizeof(a));
      break;
    }
    case WX_TEST: {
      int k = p->text[0] - '0';
      if (k >= 0 && k < N_SERVOS) start_test(k);
      break;
    }
    case WX_RELAX:
      relax();
      break;
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

// ---- HELLO ------------------------------------------------------------------------------
static uint32_t next_hello_ms = 0;

static void send_hello() {
  WxPacket p;
  wx_init(&p, WX_HELLO, group, MY_ROLE);
  esp_now_send(WX_BROADCAST, (const uint8_t *)&p, sizeof(p));
  next_hello_ms = millis() + WX_HELLO_MS + (esp_random() % 500);
}

// ---- setup / loop -------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  prefs.begin("weathering", false);
  group = prefs.getUChar("group", 1);
  if (group < WX_GROUP_MIN || group > WX_GROUP_MAX) group = 1;

  for (int k = 0; k < N_SERVOS; k++) cfg[k] = ServoCfg{DEFAULT_PINS[k], 1000, 2000, 0};
  if (prefs.getBytesLength("servos") == sizeof(cfg)) {
    ServoCfg c[N_SERVOS];
    prefs.getBytes("servos", c, sizeof(c));
    bool ok = true;
    for (int k = 0; k < N_SERVOS; k++) ok = ok && out_pin(c[k].pin) && c[k].max_us > c[k].min_us && c[k].closed <= 1;
    if (ok) memcpy(cfg, c, sizeof(cfg));
  }
  // Back to the stored pose (all closed the very first time).
  for (int k = 0; k < N_SERVOS; k++) target[k] = 0;
  if (prefs.getBytesLength("pose") == sizeof(target)) {
    prefs.getBytes("pose", target, sizeof(target));
    for (int k = 0; k < N_SERVOS; k++) if (!(target[k] >= 0 && target[k] <= 1)) target[k] = 0;
  }
  for (int k = 0; k < N_SERVOS; k++) cur[k] = from[k] = target[k];
  attach_all();

  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) Serial.println("ERR esp_now_init");
  esp_now_register_recv_cb(on_data_recv);
  add_peer(WX_BROADCAST);

  Serial.printf("FW weathering_body %s mac %s group %u\n", FW_VERSION, WiFi.macAddress().c_str(), group);
  send_hello();
}

void loop() {
  if (wx_read_line(Serial, &usb)) handle_command(usb.buf);
  RxItem it;
  while (pop_rx(&it)) handle_radio(&it);
  bool was = moving;
  service_motion();
  if (was != moving) state_dirty = true;
  uint32_t now = millis();
  if (state_dirty || (moving && (int32_t)(now - next_state_ms) >= 0)) send_state();
  if ((int32_t)(now - next_hello_ms) >= 0) send_hello();
  delay(1);
}
