// Weathering — body board (inside the sculpture, NPTX)
//
// Four Dynamixel XL430-W250 on the faces of the central tetrahedron, each
// winding a string that pulls one triangle of the jitterbug. A pull is 0
// with the string slack (structure open, cuboctahedron) and 1 with it wound
// to its calibrated closed point (octahedron). Strings only pull: the
// structure opens by itself when they let out.
//
// Wiring (proven on Florian's TTGO): ESP32 TX GPIO32 --[1k]-- Dynamixel DATA,
// RX GPIO33 straight on DATA. Half duplex on one wire: every byte sent comes
// back as echo, so replies are found by looking for the status packet
// (instruction 0x55) rather than by counting bytes. 57600 baud, Protocol
// 2.0, extended position mode. Motors on their own 12 V, grounds joined.
// The packet code (CRC, ping, read, write, sync write) is Florian's
// hand-written code from his test sketch, extended.
//
// Calibration is all SET keys (docs/PROTOCOL.md): jog=<k>,<ticks>,
// slack=all, closed=<k>, ids=, setid=<old>,<new>, speed=, group=.
//
// Safety: never trusts "where I am at power-up" as slack. Zero, travel and
// the last settled pull live in flash; at boot the present positions must
// match them (or match them by whole turns, if the motors lost power),
// otherwise the body is not homed: torque off, poses ignored, until
// slack=all is set again with the structure open. Goals are clamped to the
// calibrated travel whatever arrives.
//
// Radio (from the hub): WX_POSE (answered with WX_ACK seq), WX_TEST,
// WX_RELAX, WX_CONFIG. WX_BODYSTATE every 2 s while moving and on change
// (also printed on USB as a BODY line).
//
// USB (115200): INFO, SET <key>=<value> ..., PING, SCAN,
//   POSE <p1> .. <p4> <glide_s>, TEST <k>, RELAX.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_idf_version.h>
#include <Preferences.h>
#include "wx.h"

#define MY_ROLE        WX_ROLE_BODY
#define N_MOTORS       4
#define DXL_RX         33
#define DXL_TX         32
#define DXL_BAUD       57600
#define DRIVE_MS       33          // goal positions out, ~30 Hz
#define READ_MS        250         // present positions in
#define PING_MS        3000        // look again for missing motors
#define SAVE_MS        10000       // store the settled pulls at most this often
#define STATE_EVERY_MS 2000        // BODYSTATE while moving
#define HUB_ALIVE_MS   10000
#define TEST_MS        2400
#define TICKS_TURN     4096
#define HOME_TOL       256         // 1/16 turn
#define MIN_TRAVEL     (TICKS_TURN / 4)
#define MAX_TRAVEL     (TICKS_TURN * 8)
#define MAX_JOG        (TICKS_TURN / 4)
#define PULL_LO        -0.02f
#define PULL_HI        1.02f

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
typedef struct {
  uint8_t ids[N_MOTORS];
  int32_t zero[N_MOTORS];      // ticks at pull 0 (as counted when slack was set)
  int32_t travel[N_MOTORS];    // ticks from slack to closed; sign = direction; 0 = not calibrated
  uint8_t zeroed;              // 1 once slack=all was set
  uint8_t speed;               // % of 60 rpm
} MotorCfg;

static Preferences prefs;
static uint8_t  group = 1;
static MotorCfg mc;
static float    saved_pull[N_MOTORS];   // last settled pulls, in flash
static WxLine   usb = {};

// ---- state --------------------------------------------------------------------
static int32_t  offset[N_MOTORS];       // whole turns lost when a motor's power went off
static bool     homed[N_MOTORS];
static bool     torque[N_MOTORS];
static int32_t  present[N_MOTORS];
static bool     have_present[N_MOTORS];
static uint8_t  found = 0;              // bit k = motor k answers
static float    cur[N_MOTORS];          // commanded pull now
static float    from[N_MOTORS], target[N_MOTORS];
static uint32_t glide_ms = 0, glide_start = 0;
static bool     moving = false;
static bool     relaxed = false;
static uint16_t last_pose_seq = 0;
static bool     have_pose_seq = false;
static int      test_k = -1;            // motor being tested (0..3)
static uint32_t test_start = 0;
static int32_t  test_base = 0;
static uint32_t next_drive_ms = 0, next_read_ms = 0, next_ping_ms = 0, next_save_ms = 0, next_state_ms = 0;
static bool     state_dirty = true;

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

// ================= Dynamixel, Protocol 2.0 (after Florian's TTGO sketch) =================
static const uint16_t ADDR_ID = 7, ADDR_OPMODE = 11, ADDR_TORQUE = 64, ADDR_PROF_ACC = 108,
                      ADDR_PROF_VEL = 112, ADDR_GOAL = 116, ADDR_PRESENT = 132;
static const uint8_t  OPMODE_EXTENDED = 4;
static HardwareSerial DXL(2);

static uint16_t crc16(const uint8_t *d, size_t n) {
  uint16_t crc = 0;
  for (size_t i = 0; i < n; i++) {
    crc ^= (uint16_t)d[i] << 8;
    for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (crc << 1) ^ 0x8005 : (crc << 1);
  }
  return crc;
}

// p needs room for n + 2 bytes (CRC appended). No byte stuffing: FF FF FD
// cannot occur in our parameters (IDs < 253, positions within ±8 turns).
static void dxl_send(uint8_t *p, int n) {
  uint16_t c = crc16(p, n);
  p[n] = c & 0xFF; p[n + 1] = c >> 8;
  while (DXL.available()) DXL.read();      // old echo / leftovers
  DXL.write(p, n + 2);
  DXL.flush();
}

static int dxl_read(uint8_t *buf, int want, uint32_t tmo) {
  int got = 0; uint32_t t0 = millis();
  while (got < want && millis() - t0 < tmo) {
    if (DXL.available()) buf[got++] = DXL.read();
  }
  return got;
}

// The status packet of `id` (FF FF FD 00 id len_l len_h 55) in buf, checked by CRC.
static int dxl_find_status(const uint8_t *buf, int len, uint8_t id, int status_len) {
  for (int i = 0; i + status_len <= len; i++) {
    if (buf[i] == 0xFF && buf[i + 1] == 0xFF && buf[i + 2] == 0xFD && buf[i + 3] == 0x00 &&
        buf[i + 4] == id && buf[i + 7] == 0x55) {
      uint16_t c = crc16(buf + i, status_len - 2);
      if ((c & 0xFF) == buf[i + status_len - 2] && (c >> 8) == buf[i + status_len - 1]) return i;
    }
  }
  return -1;
}

// Sends n bytes (+CRC), waits for echo + status; returns the status's error byte or -1.
static int dxl_transact(uint8_t *p, int n, uint8_t id, uint8_t *out, int status_len, uint32_t tmo = 15) {
  dxl_send(p, n);
  uint8_t buf[96];
  int got = dxl_read(buf, n + 2 + status_len, tmo);
  int off = dxl_find_status(buf, got, id, status_len);
  if (off < 0) return -1;
  memcpy(out, buf + off, status_len);
  return out[8];
}

static bool dxl_ping(uint8_t id, uint16_t *model = nullptr, uint32_t tmo = 15) {
  uint8_t p[16] = {0xFF, 0xFF, 0xFD, 0x00, id, 0x03, 0x00, 0x01};
  uint8_t st[14];
  if (dxl_transact(p, 8, id, st, 14, tmo) != 0) return false;
  if (model) *model = st[9] | (st[10] << 8);
  return true;
}

static bool dxl_write(uint8_t id, uint16_t addr, uint32_t value, uint8_t bytes) {
  uint8_t p[24] = {0xFF, 0xFF, 0xFD, 0x00, id, 0, 0, 0x03, (uint8_t)(addr & 0xFF), (uint8_t)(addr >> 8)};
  uint16_t len = 3 + bytes + 2;
  p[5] = len & 0xFF; p[6] = len >> 8;
  for (uint8_t k = 0; k < bytes; k++) p[10 + k] = (value >> (8 * k)) & 0xFF;
  uint8_t st[11];
  return dxl_transact(p, 10 + bytes, id, st, 11) == 0;
}

static bool dxl_read_reg(uint8_t id, uint16_t addr, uint8_t bytes, uint32_t *value) {
  uint8_t p[20] = {0xFF, 0xFF, 0xFD, 0x00, id, 0x07, 0x00, 0x02,
                   (uint8_t)(addr & 0xFF), (uint8_t)(addr >> 8), bytes, 0};
  uint8_t st[16];
  int len = 11 + bytes;
  if (dxl_transact(p, 12, id, st, len) != 0) return false;
  uint32_t v = 0;
  for (int k = 0; k < bytes; k++) v |= (uint32_t)st[9 + k] << (8 * k);
  *value = v;
  return true;
}

// One Sync Write of the goal position to the motors in `mask` (no replies).
static void dxl_sync_goal(const int32_t *goal, uint8_t mask) {
  uint8_t p[64];
  int n = 0, count = 0;
  for (int k = 0; k < N_MOTORS; k++) if (mask & (1 << k)) count++;
  if (!count) return;
  p[n++] = 0xFF; p[n++] = 0xFF; p[n++] = 0xFD; p[n++] = 0x00; p[n++] = 0xFE;
  uint16_t len = 1 + 4 + count * 5 + 2;
  p[n++] = len & 0xFF; p[n++] = len >> 8;
  p[n++] = 0x83;
  p[n++] = ADDR_GOAL & 0xFF; p[n++] = ADDR_GOAL >> 8;
  p[n++] = 4; p[n++] = 0;
  for (int k = 0; k < N_MOTORS; k++) {
    if (!(mask & (1 << k))) continue;
    p[n++] = mc.ids[k];
    for (int b = 0; b < 4; b++) p[n++] = ((uint32_t)goal[k] >> (8 * b)) & 0xFF;
  }
  dxl_send(p, n);
}

// ================= motors =================
static bool calibrated(int k) { return mc.zeroed && mc.travel[k] != 0; }
static bool drivable(int k) { return (found & (1 << k)) && homed[k] && calibrated(k) && !relaxed; }

static float pull_of(int k, int32_t ticks) {
  return (float)(ticks - mc.zero[k] - offset[k]) / (float)mc.travel[k];
}
static int32_t ticks_of(int k, float pull) {
  pull = constrain(pull, PULL_LO, PULL_HI);
  return mc.zero[k] + offset[k] + (int32_t)lroundf(pull * mc.travel[k]);
}

static bool read_present(int k) {
  uint32_t v;
  if (dxl_read_reg(mc.ids[k], ADDR_PRESENT, 4, &v)) {
    present[k] = (int32_t)v;
    have_present[k] = true;
    if (!(found & (1 << k))) state_dirty = true;
    found |= (1 << k);
    return true;
  }
  if (found & (1 << k)) state_dirty = true;
  found &= ~(1 << k);
  torque[k] = false;                     // it will be set up again when it answers
  return false;
}

static void set_profile(int k) {
  uint32_t vel = (uint32_t)(262UL * mc.speed / 100);   // 0.229 rpm units: 262 = 60 rpm
  dxl_write(mc.ids[k], ADDR_PROF_VEL, vel < 1 ? 1 : vel, 4);
  dxl_write(mc.ids[k], ADDR_PROF_ACC, 20, 4);
}

// Extended position mode, without touching a motor that is already in it
// (a mode write would drop its torque and could reset its turn count).
static void setup_motor(int k) {
  uint32_t mode = 0;
  if (dxl_read_reg(mc.ids[k], ADDR_OPMODE, 1, &mode) && mode != OPMODE_EXTENDED) {
    dxl_write(mc.ids[k], ADDR_TORQUE, 0, 1);
    dxl_write(mc.ids[k], ADDR_OPMODE, OPMODE_EXTENDED, 1);
  }
  uint32_t t = 0;
  if (dxl_read_reg(mc.ids[k], ADDR_TORQUE, 1, &t)) torque[k] = t == 1;
  set_profile(k);
}

// Torque on without a jump: goal = present first.
static bool torque_on(int k) {
  if (torque[k]) return true;
  if (!read_present(k)) return false;
  dxl_write(mc.ids[k], ADDR_GOAL, (uint32_t)present[k], 4);
  torque[k] = dxl_write(mc.ids[k], ADDR_TORQUE, 1, 1);
  return torque[k];
}

static void torque_off(int k) {
  if (found & (1 << k)) dxl_write(mc.ids[k], ADDR_TORQUE, 0, 1);
  torque[k] = false;
}

// Is motor k where flash says it should be? Sets homed[k] and offset[k].
static void check_home(int k) {
  homed[k] = false;
  offset[k] = 0;
  if (!mc.zeroed || !have_present[k]) return;
  int32_t expect = mc.zero[k] + (calibrated(k) ? (int32_t)lroundf(saved_pull[k] * mc.travel[k]) : 0);
  int32_t d = present[k] - expect;
  if (abs(d) <= HOME_TOL) { homed[k] = true; return; }
  // the motor's 12 V went off: its count restarted within one turn
  int32_t turns = (int32_t)lroundf((float)(expect - present[k]) / TICKS_TURN);
  int32_t cand = present[k] + turns * TICKS_TURN;
  if (abs(cand - expect) <= HOME_TOL) {
    offset[k] = -turns * TICKS_TURN;
    homed[k] = true;
    Serial.printf("LOG motor %d found %ld turn(s) off, corrected\n", k + 1, (long)turns);
    return;
  }
  Serial.printf("LOG motor %d is not where it was left (%ld ticks off): not homed, set slack again\n",
                k + 1, (long)d);
}

static bool all_homed() {
  for (int k = 0; k < N_MOTORS; k++) if (!homed[k]) return false;
  return true;
}

// A motor has (re)appeared: set it up and decide whether it can be driven.
static void motor_appeared(int k) {
  setup_motor(k);
  read_present(k);
  check_home(k);
  if (homed[k] && calibrated(k)) {
    cur[k] = from[k] = target[k] = constrain(pull_of(k, present[k]), 0.0f, 1.0f);
    if (!relaxed) torque_on(k);
  } else if (torque[k] && !homed[k]) {
    torque_off(k);                       // never hold a position we can't vouch for
  }
  state_dirty = true;
}

static void save_cfg() { prefs.putBytes("motors", &mc, sizeof(mc)); }
static void save_pulls() { prefs.putBytes("pulls", saved_pull, sizeof(saved_pull)); }

// ---- hub ----------------------------------------------------------------------------
static uint8_t  hub_mac[6];
static bool     hub_known = false;
static uint32_t hub_ms = 0;

static bool hub_alive() { return hub_known && millis() - hub_ms < HUB_ALIVE_MS; }

static void send_state() {
  WxPacket p;
  wx_init(&p, WX_BODYSTATE, group, MY_ROLE);
  for (int k = 0; k < N_MOTORS; k++) p.v[k] = cur[k];
  p.flags = (moving ? WX_FLAG_MOVING : 0) | (all_homed() ? WX_FLAG_HOMED : 0) | (uint8_t)(found << 4);
  if (hub_alive()) esp_now_send(hub_mac, (const uint8_t *)&p, sizeof(p));
  Serial.printf("BODY %.3f %.3f %.3f %.3f moving=%d homed=%d found=%u\n",
                cur[0], cur[1], cur[2], cur[3], moving ? 1 : 0, all_homed() ? 1 : 0, found);
  next_state_ms = millis() + STATE_EVERY_MS;
  state_dirty = false;
}

// ---- poses --------------------------------------------------------------------------
static bool start_pose(const float *pulls, uint16_t glide_s) {
  if (!all_homed()) {
    Serial.println("LOG pose ignored: not homed (set slack with the structure open)");
    state_dirty = true;
    return false;
  }
  if (relaxed) {
    relaxed = false;
    for (int k = 0; k < N_MOTORS; k++) {
      if (have_present[k] && calibrated(k)) cur[k] = constrain(pull_of(k, present[k]), 0.0f, 1.0f);
      if (drivable(k)) torque_on(k);
    }
  }
  test_k = -1;
  for (int k = 0; k < N_MOTORS; k++) {
    from[k] = cur[k];
    target[k] = constrain(pulls[k], 0.0f, 1.0f);
  }
  glide_ms = glide_s * 1000UL;
  glide_start = millis();
  moving = true;
  state_dirty = true;
  Serial.printf("LOG pose %.3f %.3f %.3f %.3f over %u s\n", target[0], target[1], target[2], target[3], glide_s);
  return true;
}

static void drive() {
  int32_t goal[N_MOTORS];
  uint8_t mask = 0;
  for (int k = 0; k < N_MOTORS; k++) {
    if (k == test_k || !drivable(k) || !torque[k]) continue;
    goal[k] = ticks_of(k, cur[k]);
    mask |= 1 << k;
  }
  dxl_sync_goal(goal, mask);
}

static void service_motion() {
  uint32_t now = millis();
  if ((int32_t)(now - next_drive_ms) < 0) return;
  next_drive_ms = now + DRIVE_MS;
  if (moving) {
    uint32_t t = now - glide_start;
    float f = glide_ms ? (float)t / glide_ms : 1.0f;
    if (f >= 1.0f) {
      for (int k = 0; k < N_MOTORS; k++) cur[k] = target[k];
      moving = false;
      state_dirty = true;
      next_save_ms = 0;                  // settled: store it soon
    } else {
      for (int k = 0; k < N_MOTORS; k++) cur[k] = from[k] + (target[k] - from[k]) * f;
    }
  }
  if (test_k >= 0) {
    uint32_t t = now - test_start;
    int k = test_k;
    if (t >= TEST_MS) {
      dxl_write(mc.ids[k], ADDR_GOAL, (uint32_t)test_base, 4);
      test_k = -1;
    } else {
      // in by 5 % of the travel (1/8 turn before calibration) and back
      int32_t span = calibrated(k) ? mc.travel[k] / 20 : TICKS_TURN / 8;
      if (calibrated(k) && cur[k] > 0.9f) span = -span;     // near closed: test towards open
      float w = 0.5f - 0.5f * cosf(2 * (float)M_PI * t / TEST_MS);
      dxl_write(mc.ids[k], ADDR_GOAL, (uint32_t)(test_base + (int32_t)lroundf(span * w)), 4);
    }
  }
  if (!relaxed) drive();
}

static void start_test(int k) {
  if (!(found & (1 << k))) { Serial.printf("LOG motor %d does not answer\n", k + 1); return; }
  if (test_k >= 0 && test_k != k) dxl_write(mc.ids[test_k], ADDR_GOAL, (uint32_t)test_base, 4);
  if (!torque_on(k)) return;
  read_present(k);
  test_base = present[k];
  test_k = k;
  test_start = millis();
}

static void relax() {
  test_k = -1;
  if (moving) {
    for (int k = 0; k < N_MOTORS; k++) target[k] = cur[k];
    moving = false;
  }
  for (int k = 0; k < N_MOTORS; k++) torque_off(k);
  relaxed = true;
  state_dirty = true;
}

// Every READ_MS: where the motors are; store settled pulls now and then.
static void service_read() {
  uint32_t now = millis();
  if ((int32_t)(now - next_read_ms) >= 0) {
    next_read_ms = now + READ_MS;
    for (int k = 0; k < N_MOTORS; k++) {
      if (found & (1 << k)) read_present(k);
    }
  }
  if ((int32_t)(now - next_ping_ms) >= 0) {
    next_ping_ms = now + PING_MS;
    for (int k = 0; k < N_MOTORS; k++) {
      if (found & (1 << k)) continue;
      if (dxl_ping(mc.ids[k])) {
        Serial.printf("LOG motor %d (id %u) answers\n", k + 1, mc.ids[k]);
        found |= 1 << k;
        motor_appeared(k);
      }
    }
  }
  // Store where the strings are, so a reset can check it: the settled
  // target while holding, the measured pull while relaxed (it drifts open).
  if (!moving && test_k < 0 && (int32_t)(now - next_save_ms) >= 0) {
    next_save_ms = now + SAVE_MS;
    bool changed = false;
    for (int k = 0; k < N_MOTORS; k++) {
      if (!homed[k] || !calibrated(k) || !have_present[k]) continue;
      float p = relaxed ? pull_of(k, present[k]) : cur[k];
      if (fabsf(p - saved_pull[k]) > 0.005f) { saved_pull[k] = p; changed = true; }
    }
    if (changed) save_pulls();
  }
}

// ---- SET (over USB, or CFG from the hub) ----------------------------------------------
static int split_csv(char *v, char **f, int max) {
  int n = 0;
  for (char *q = v; n < max; ) {
    f[n++] = q;
    q = strchr(q, ',');
    if (!q) break;
    *q++ = 0;
  }
  return n;
}

// Applies "key=value ..."; writes "OK SET" or "ERR ..." to out. Actions
// (jog, slack, closed, setid) happen at once, in order.
static void apply_set(char *args, char *out, size_t size) {
  bool any = false;
  for (char *tok = strtok(args, " "); tok; tok = strtok(nullptr, " ")) {
    char *k, *v, *f[4];
    any = true;
    if (!wx_split_kv(tok, &k, &v)) { snprintf(out, size, "ERR bad pair %s", tok); return; }
    if (strcmp(k, "group") == 0) {
      long g;
      if (!wx_parse_long(v, WX_GROUP_MIN, WX_GROUP_MAX, &g)) { snprintf(out, size, "ERR group 1-250"); return; }
      if (g != group) {
        group = (uint8_t)g;
        prefs.putUChar("group", group);
        hub_known = false;
      }
    } else if (strcmp(k, "speed") == 0) {
      long sp;
      if (!wx_parse_long(v, 1, 100, &sp)) { snprintf(out, size, "ERR speed 1-100"); return; }
      mc.speed = (uint8_t)sp;
      save_cfg();
      for (int m = 0; m < N_MOTORS; m++) if (found & (1 << m)) set_profile(m);
    } else if (strcmp(k, "ids") == 0) {
      long id[N_MOTORS];
      if (split_csv(v, f, 4) != 4) { snprintf(out, size, "ERR ids=<i1>,<i2>,<i3>,<i4>"); return; }
      for (int m = 0; m < N_MOTORS; m++)
        if (!wx_parse_long(f[m], 0, 252, &id[m])) { snprintf(out, size, "ERR ids 0-252"); return; }
      for (int a = 0; a < N_MOTORS; a++)
        for (int b = a + 1; b < N_MOTORS; b++)
          if (id[a] == id[b]) { snprintf(out, size, "ERR two motors with id %ld", id[a]); return; }
      bool same = true;
      for (int m = 0; m < N_MOTORS; m++) same = same && mc.ids[m] == id[m];
      if (!same) {                       // only a real change lets go of the motors
        for (int m = 0; m < N_MOTORS; m++) { torque_off(m); mc.ids[m] = (uint8_t)id[m]; }
        found = 0;
        next_ping_ms = 0;
        save_cfg();
      }
    } else if (strcmp(k, "setid") == 0) {
      long a, b;
      if (split_csv(v, f, 2) != 2 || !wx_parse_long(f[0], 0, 252, &a) || !wx_parse_long(f[1], 0, 252, &b)) {
        snprintf(out, size, "ERR setid=<old>,<new>"); return;
      }
      dxl_write((uint8_t)a, ADDR_TORQUE, 0, 1);
      if (!dxl_write((uint8_t)a, ADDR_ID, (uint32_t)b, 1) || !dxl_ping((uint8_t)b)) {
        snprintf(out, size, "ERR no motor %ld answered (alone on the line?)", a); return;
      }
      found = 0;
      next_ping_ms = 0;
    } else if (strcmp(k, "jog") == 0) {
      long m, t;
      if (split_csv(v, f, 2) != 2 || !wx_parse_long(f[0], 1, N_MOTORS, &m) ||
          !wx_parse_long(f[1], -MAX_JOG, MAX_JOG, &t)) {
        snprintf(out, size, "ERR jog=<1-4>,<ticks, at most %d>", MAX_JOG); return;
      }
      int i = (int)m - 1;
      moving = false;
      test_k = -1;
      if (!(found & (1 << i)) || !torque_on(i) || !read_present(i)) {
        snprintf(out, size, "ERR motor %ld does not answer", m); return;
      }
      dxl_write(mc.ids[i], ADDR_GOAL, (uint32_t)(present[i] + t), 4);
      if (homed[i] && calibrated(i)) cur[i] = target[i] = pull_of(i, present[i] + t);
    } else if (strcmp(k, "slack") == 0) {
      if (strcmp(v, "all") != 0) { snprintf(out, size, "ERR slack=all"); return; }
      for (int m = 0; m < N_MOTORS; m++) {
        if (!(found & (1 << m)) || !read_present(m)) {
          snprintf(out, size, "ERR motor %d does not answer: all four are needed", m + 1); return;
        }
      }
      moving = false;
      test_k = -1;
      for (int m = 0; m < N_MOTORS; m++) {
        mc.zero[m] = present[m];
        offset[m] = 0;
        homed[m] = true;
        saved_pull[m] = 0;
        cur[m] = from[m] = target[m] = 0;
      }
      mc.zeroed = 1;
      save_cfg();
      save_pulls();
      state_dirty = true;
    } else if (strcmp(k, "closed") == 0) {
      long m;
      if (!wx_parse_long(v, 1, N_MOTORS, &m)) { snprintf(out, size, "ERR closed=<1-4>"); return; }
      int i = (int)m - 1;
      if (!mc.zeroed || !homed[i]) { snprintf(out, size, "ERR set slack=all first"); return; }
      if (!read_present(i)) { snprintf(out, size, "ERR motor %ld does not answer", m); return; }
      int32_t tr = present[i] - mc.zero[i] - offset[i];
      if (abs(tr) < MIN_TRAVEL || abs(tr) > MAX_TRAVEL) {
        snprintf(out, size, "ERR travel %ld ticks: wind it 1/4 to 8 turns from slack", (long)tr); return;
      }
      mc.travel[i] = tr;
      save_cfg();
      cur[i] = from[i] = target[i] = 1.0f;
      saved_pull[i] = 1.0f;
      save_pulls();
      state_dirty = true;
    } else {
      snprintf(out, size, "ERR unknown key %s", k);
      return;
    }
  }
  if (!any) { snprintf(out, size, "ERR nothing to set"); return; }
  snprintf(out, size, "OK SET");
}

// ---- USB ------------------------------------------------------------------------------
static void print_info() {
  Serial.printf("INFO body fw %s mac %s group %u pose=%.3f,%.3f,%.3f,%.3f",
                FW_VERSION, WiFi.macAddress().c_str(), group, target[0], target[1], target[2], target[3]);
  for (int k = 0; k < N_MOTORS; k++) Serial.printf(" m%d=%u,%ld", k + 1, mc.ids[k], (long)mc.travel[k]);
  Serial.printf(" speed=%u homed=%d found=%u moving=%d relaxed=%d hub=%d\n", mc.speed, all_homed() ? 1 : 0,
                found, moving ? 1 : 0, relaxed ? 1 : 0, hub_alive() ? 1 : 0);
}

static void scan() {
  static const uint32_t BAUDS[2] = {57600, 1000000};
  int n = 0;
  for (int b = 0; b < 2; b++) {
    DXL.updateBaudRate(BAUDS[b]);
    delay(5);
    for (int id = 0; id <= 252; id++) {
      uint16_t model;
      if (dxl_ping((uint8_t)id, &model, 8)) {
        Serial.printf("LOG motor id %d baud %lu model %u\n", id, (unsigned long)BAUDS[b], model);
        n++;
      }
    }
  }
  DXL.updateBaudRate(DXL_BAUD);
  Serial.printf("LOG scan done: %d answer(s)%s\n", n, n ? "" : " (power? wiring TX32-1k-DATA, RX33-DATA? common GND?)");
  found = 0;
  next_ping_ms = 0;
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
    char out[80];
    apply_set(args, out, sizeof(out));
    Serial.println(out);
  } else if (strcmp(line, "SCAN") == 0) {
    Serial.println("OK SCAN");
    scan();
  } else if (strcmp(line, "POSE") == 0) {
    char *tok[6];
    int n = 0;
    for (char *t = strtok(args, " "); t && n < 6; t = strtok(nullptr, " ")) tok[n++] = t;
    float a[N_MOTORS];
    long glide;
    bool ok = n == 5 && wx_parse_long(tok[4], 0, 3600, &glide);
    for (int k = 0; ok && k < N_MOTORS; k++) ok = wx_parse_float(tok[k], 0.0f, 1.0f, &a[k]);
    if (!ok) { Serial.println("ERR usage POSE <p1> .. <p4> <glide_s> (p in 0..1, glide 0..3600)"); return; }
    if (start_pose(a, (uint16_t)glide)) Serial.println("OK POSE");
    else Serial.println("ERR not homed");
  } else if (strcmp(line, "TEST") == 0) {
    long k;
    if (!wx_parse_long(args, 1, N_MOTORS, &k)) { Serial.println("ERR usage TEST <1..4>"); return; }
    start_test((int)k - 1);
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
    state_dirty = true;
  }
  hub_ms = millis();
  switch (p->type) {
    case WX_POSE: {
      bool same = have_pose_seq && p->seq == last_pose_seq;
      for (int k = 0; same && k < N_MOTORS; k++) same = fabsf(p->v[k] - target[k]) < 0.0005f;
      if (!same) {
        last_pose_seq = p->seq;
        have_pose_seq = true;
        float a[N_MOTORS];
        for (int k = 0; k < N_MOTORS; k++) a[k] = p->v[k];
        start_pose(a, p->glide_s > 3600 ? 3600 : p->glide_s);
      }
      WxPacket a;
      wx_init(&a, WX_ACK, group, MY_ROLE);
      a.seq = p->seq;
      esp_now_send(it->mac, (const uint8_t *)&a, sizeof(a));
      break;
    }
    case WX_TEST: {
      int k = p->text[0] - '1';
      if (k >= 0 && k < N_MOTORS) start_test(k);
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
      wx_init(&a, WX_CONFIG, group, MY_ROLE);
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

  memset(&mc, 0, sizeof(mc));
  for (int k = 0; k < N_MOTORS; k++) mc.ids[k] = k + 1;
  mc.speed = 30;
  if (prefs.getBytesLength("motors") == sizeof(mc)) {
    MotorCfg c;
    prefs.getBytes("motors", &c, sizeof(c));
    bool ok = c.speed >= 1 && c.speed <= 100 && c.zeroed <= 1;
    for (int k = 0; ok && k < N_MOTORS; k++) ok = c.ids[k] <= 252 && abs(c.travel[k]) <= MAX_TRAVEL;
    if (ok) mc = c;
  }
  for (int k = 0; k < N_MOTORS; k++) saved_pull[k] = 0;
  if (prefs.getBytesLength("pulls") == sizeof(saved_pull)) {
    prefs.getBytes("pulls", saved_pull, sizeof(saved_pull));
    for (int k = 0; k < N_MOTORS; k++) if (!(saved_pull[k] >= PULL_LO && saved_pull[k] <= PULL_HI)) saved_pull[k] = 0;
  }

  DXL.begin(DXL_BAUD, SERIAL_8N1, DXL_RX, DXL_TX);

  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) Serial.println("ERR esp_now_init");
  esp_now_register_recv_cb(on_data_recv);
  add_peer(WX_BROADCAST);

  Serial.printf("FW weathering_body %s mac %s group %u\n", FW_VERSION, WiFi.macAddress().c_str(), group);
  for (int k = 0; k < N_MOTORS; k++) {
    cur[k] = from[k] = target[k] = saved_pull[k];
    if (dxl_ping(mc.ids[k])) {
      found |= 1 << k;
      motor_appeared(k);
      Serial.printf("LOG motor %d (id %u): %s\n", k + 1, mc.ids[k],
                    homed[k] ? (calibrated(k) ? "ready" : "slack set, closed not set") : "not homed");
    } else {
      Serial.printf("LOG motor %d (id %u) does not answer\n", k + 1, mc.ids[k]);
    }
  }
  next_ping_ms = millis() + PING_MS;
  send_hello();
}

void loop() {
  if (wx_read_line(Serial, &usb)) handle_command(usb.buf);
  RxItem it;
  while (pop_rx(&it)) handle_radio(&it);
  bool was = moving;
  service_motion();
  service_read();
  if (was != moving) state_dirty = true;
  uint32_t now = millis();
  if (state_dirty || (moving && (int32_t)(now - next_state_ms) >= 0)) send_state();
  if ((int32_t)(now - next_hello_ms) >= 0) send_hello();
  delay(1);
}
