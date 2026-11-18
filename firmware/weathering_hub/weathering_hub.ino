// Weathering — hub (the board on USB to the show computer)
//
// Bridges USB serial (the app) and ESP-NOW (the sensor and body boards).
// It keeps no data: readings go straight to USB and are acknowledged to the
// sensor only while the computer is listening, so nothing is acknowledged
// into the void (the sensor keeps it in its backlog instead).
//
// Contract: docs/PROTOCOL.md. USB lines (115200 baud):
//   host -> hub:  TIME <unix>   POSE <seq> <p1..p4> <glide_s>   RELAX   TEST <1..4>
//                 READ   CFG sensor|body <key>=<value> ...   NODES
//                 INFO   SET group=<g>   PING
//   hub -> host:  OK <cmd>  OK POSE <seq>  ACK body <seq>  NAK body <seq>
//                 R <unix> <seq> co2=.. t=.. rh=.. lux=.. db=.. [sim=..] [old]
//                 BODY <p1..p4> moving= homed= found=   NODE <role> <mac> fw <ver> rssi <dBm>
//                 LOST <role>   INFO ...   PONG   ERR <reason>   LOG <text>
//
// The computer is "listening" when it sent TIME since boot and any line in
// the last HOST_SILENT_MS (the app sends TIME every few minutes).

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_idf_version.h>
#include <Preferences.h>
#include "wx.h"

#define MY_ROLE        WX_ROLE_HUB
#define POSE_RETRIES   3          // after the first try
#define POSE_RETRY_MS  300
#define TIME_EVERY_MS  60000      // re-send the clock to the sensor this often
#define HOST_SILENT_MS (30UL * 60 * 1000)

static Preferences prefs;
static uint8_t group = 1;
static WxLine usb = {};

// ---- packets from the Wi-Fi task, handled in loop() -------------------------
typedef struct { uint8_t mac[6]; int8_t rssi; WxPacket p; } RxItem;
#define RX_QUEUE 24
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static RxItem rx_q[RX_QUEUE];
static uint8_t rx_head = 0, rx_n = 0;
static volatile uint32_t rx_dropped = 0;

// RSSI: ESP-IDF 4 (Arduino core 2.x) doesn't pass it to the ESP-NOW
// callback, so a promiscuous callback notes it for the frame that follows.
static uint8_t last_frame_mac[6];
static int8_t  last_frame_rssi = 0;

static void on_packet(const uint8_t *mac, int8_t rssi, const uint8_t *data, int len) {
  const WxPacket *p = wx_accept(data, len, group);
  if (!p || p->role == MY_ROLE) return;
  portENTER_CRITICAL(&g_mux);
  if (rx_n < RX_QUEUE) {
    RxItem *it = &rx_q[(rx_head + rx_n) % RX_QUEUE];
    memcpy(it->mac, mac, 6);
    it->rssi = rssi;
    it->p = *p;
    rx_n++;
  } else {
    rx_dropped++;
  }
  portEXIT_CRITICAL(&g_mux);
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
static void on_data_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  on_packet(info->src_addr, info->rx_ctrl ? info->rx_ctrl->rssi : 0, data, len);
}
#else
static void on_data_recv(const uint8_t *mac, const uint8_t *data, int len) {
  int8_t rssi = memcmp(mac, last_frame_mac, 6) == 0 ? last_frame_rssi : 0;
  on_packet(mac, rssi, data, len);
}
#endif

static void on_promisc(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT) return;
  const wifi_promiscuous_pkt_t *pk = (const wifi_promiscuous_pkt_t *)buf;
  const uint8_t *hdr = pk->payload;
  if (hdr[0] != 0xD0) return;              // action frames carry ESP-NOW
  memcpy(last_frame_mac, hdr + 10, 6);     // addr2 = sender
  last_frame_rssi = pk->rx_ctrl.rssi;
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

// ---- the boards we hear (one per role) --------------------------------------
typedef struct {
  bool     known;      // heard since boot (mac valid)
  bool     alive;      // heard within WX_LOST_MS
  uint8_t  mac[6];
  uint16_t fw;
  int8_t   rssi;
  uint32_t heard_ms;
  uint32_t dup_ms;     // last "two boards" warning
} Node;
static Node nodes[4];   // index = role

static void add_peer(const uint8_t *mac) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t info = {};
  memcpy(info.peer_addr, mac, 6);
  if (esp_now_add_peer(&info) != ESP_OK) Serial.println("LOG add_peer failed");
}

static void send_to(const uint8_t *mac, const WxPacket *p) {
  esp_now_send(mac, (const uint8_t *)p, sizeof(WxPacket));
}

// Unicast to that role's board if we know it, else broadcast (only that role
// acts on these packet types).
static const uint8_t *addr_of(uint8_t role) {
  return nodes[role].known ? nodes[role].mac : WX_BROADCAST;
}

static void print_node(uint8_t role) {
  const Node *n = &nodes[role];
  char mac[18];
  wx_mac_str(n->mac, mac);
  Serial.printf("NODE %s %s fw %u.%u rssi %d\n", wx_role_name(role), mac,
                n->fw >> 8, n->fw & 0xFF, (int)n->rssi);
}

// ---- clock --------------------------------------------------------------------
static uint32_t time_unix = 0;     // the computer's clock at time_ms (0: never told)
static uint32_t time_ms = 0;
static uint32_t host_ms = 0;       // last line from the computer
static uint32_t next_time_ms = 0;  // next clock relay to the sensor

static uint32_t now_unix() {
  return time_unix ? time_unix + (millis() - time_ms) / 1000 : 0;
}

static bool host_listening() {
  return time_unix && millis() - host_ms < HOST_SILENT_MS;
}

static void send_time() {
  if (!time_unix || !nodes[WX_ROLE_SENSOR].known) return;
  WxPacket p;
  wx_init(&p, WX_TIME, group, MY_ROLE);
  p.unix = now_unix();
  send_to(nodes[WX_ROLE_SENSOR].mac, &p);
  next_time_ms = millis() + TIME_EVERY_MS;
}

// ---- HELLO --------------------------------------------------------------------
static uint32_t next_hello_ms = 0;

static void send_hello(const uint8_t *to) {
  WxPacket p;
  wx_init(&p, WX_HELLO, group, MY_ROLE);
  send_to(to, &p);
  if (to == WX_BROADCAST) next_hello_ms = millis() + WX_HELLO_MS + (esp_random() % 500);
}

// ---- pose delivery --------------------------------------------------------------
static WxPacket pose_pkt;
static bool     pose_busy = false;
static uint8_t  pose_tries = 0;
static uint32_t pose_next_ms = 0;

static void pose_send() {
  send_to(addr_of(WX_ROLE_BODY), &pose_pkt);
  pose_tries++;
  pose_next_ms = millis() + POSE_RETRY_MS;
}

static void service_pose() {
  if (!pose_busy || (int32_t)(millis() - pose_next_ms) < 0) return;
  if (pose_tries <= POSE_RETRIES) {
    pose_send();
  } else {
    pose_busy = false;
    Serial.printf("NAK body %u\n", (unsigned)pose_pkt.seq);
  }
}

// ---- radio -> USB ----------------------------------------------------------------
static void print_reading(const WxPacket *p) {
  char line[200];
  wx_format_reading(p, line, sizeof(line));
  Serial.println(line);
}

static void heard(const RxItem *it) {
  uint8_t role = it->p.role;
  if (role != WX_ROLE_SENSOR && role != WX_ROLE_BODY) return;
  Node *n = &nodes[role];
  uint32_t now = millis();
  bool same = n->known && memcmp(n->mac, it->mac, 6) == 0;
  if (!same && n->alive && now - n->heard_ms < 2 * WX_HELLO_MS) {
    // A second board with the same role in this group: keep the first.
    if (!n->dup_ms || now - n->dup_ms > 60000) {
      char mac[18];
      wx_mac_str(it->mac, mac);
      Serial.printf("LOG another %s in group %u: %s (ignored; give it another group)\n",
                    wx_role_name(role), group, mac);
      n->dup_ms = now;
    }
    return;
  }
  bool fresh = !n->alive || !same;
  memcpy(n->mac, it->mac, 6);
  n->known = true;
  n->alive = true;
  n->fw = it->p.fw;
  if (it->rssi) n->rssi = it->rssi;
  n->heard_ms = now;
  if (fresh) {
    add_peer(n->mac);
    print_node(role);
    send_hello(n->mac);                 // answer: "here is the hub"
    if (role == WX_ROLE_SENSOR) send_time();
  }
}

static void handle_radio(const RxItem *it) {
  const WxPacket *p = &it->p;
  if (p->role == WX_ROLE_HUB) return;
  // Packets from a second board of a role are ignored (heard() warns).
  heard(it);
  const Node *n = &nodes[p->role];
  if (!n->known || memcmp(n->mac, it->mac, 6) != 0) return;
  switch (p->type) {
    case WX_READING:
      if (p->role != WX_ROLE_SENSOR || !host_listening()) break;   // no ACK: the sensor keeps it
      print_reading(p);
      {
        WxPacket a;
        wx_init(&a, WX_ACK, group, MY_ROLE);
        a.seq = p->seq;
        send_to(it->mac, &a);
      }
      break;
    case WX_ACK:
      if (p->role == WX_ROLE_BODY && pose_busy && p->seq == pose_pkt.seq) {
        pose_busy = false;
        Serial.printf("ACK body %u\n", (unsigned)p->seq);
      }
      break;
    case WX_BODYSTATE:
      Serial.printf("BODY %.3f %.3f %.3f %.3f moving=%d homed=%d found=%u\n", p->v[0], p->v[1], p->v[2],
                    p->v[3], (p->flags & WX_FLAG_MOVING) ? 1 : 0, (p->flags & WX_FLAG_HOMED) ? 1 : 0,
                    (unsigned)(p->flags >> 4));
      break;
    case WX_CONFIG: {
      // A board's answer to CFG (its "OK SET" / "ERR ...").
      char text[WX_TEXT_LEN + 1];
      memcpy(text, p->text, WX_TEXT_LEN);
      text[WX_TEXT_LEN] = 0;
      Serial.printf("LOG %s %s\n", wx_role_name(p->role), text);
      break;
    }
    default:
      break;
  }
}

static void service_nodes() {
  uint32_t now = millis();
  for (uint8_t r = WX_ROLE_SENSOR; r <= WX_ROLE_BODY; r++) {
    Node *n = &nodes[r];
    if (n->alive && now - n->heard_ms > WX_LOST_MS) {
      n->alive = false;
      Serial.printf("LOST %s\n", wx_role_name(r));
    }
  }
}

// ---- USB commands ------------------------------------------------------------------
static void print_info() {
  Serial.printf("INFO hub fw %s mac %s group %u time=%lu\n", FW_VERSION,
                WiFi.macAddress().c_str(), group, (unsigned long)now_unix());
}

static void cmd_set(char *args) {
  long g = -1;
  for (char *tok = strtok(args, " "); tok; tok = strtok(nullptr, " ")) {
    char *k, *v;
    if (!wx_split_kv(tok, &k, &v)) { Serial.printf("ERR bad pair %s\n", tok); return; }
    if (strcmp(k, "group") == 0) {
      if (!wx_parse_long(v, WX_GROUP_MIN, WX_GROUP_MAX, &g)) { Serial.println("ERR group 1-250"); return; }
    } else {
      Serial.printf("ERR unknown key %s\n", k);
      return;
    }
  }
  if (g < 0) { Serial.println("ERR nothing to set"); return; }
  if (g != group) {
    group = (uint8_t)g;
    prefs.putUChar("group", group);
    for (uint8_t r = WX_ROLE_SENSOR; r <= WX_ROLE_BODY; r++) {
      if (nodes[r].alive) Serial.printf("LOST %s\n", wx_role_name(r));
      nodes[r] = Node{};
    }
    pose_busy = false;
    send_hello(WX_BROADCAST);
  }
  Serial.println("OK SET");
}

static void cmd_pose(char *args) {
  char *tok[7];
  int n = 0;
  for (char *t = strtok(args, " "); t && n < 7; t = strtok(nullptr, " ")) tok[n++] = t;
  long seq, glide;
  float a[4];
  if (n != 6 || !wx_parse_long(tok[0], 0, 65535, &seq) || !wx_parse_long(tok[5], 0, 3600, &glide)) {
    Serial.println("ERR usage POSE <seq> <p1> .. <p4> <glide_s>");
    return;
  }
  for (int i = 0; i < 4; i++) {
    if (!wx_parse_float(tok[1 + i], 0.0f, 1.0f, &a[i])) { Serial.println("ERR pose values 0..1"); return; }
  }
  if (pose_busy) Serial.printf("NAK body %u\n", (unsigned)pose_pkt.seq);   // superseded
  wx_init(&pose_pkt, WX_POSE, group, MY_ROLE);
  pose_pkt.seq = (uint16_t)seq;
  for (int i = 0; i < 4; i++) pose_pkt.v[i] = a[i];
  pose_pkt.glide_s = (uint16_t)glide;
  pose_busy = true;
  pose_tries = 0;
  Serial.printf("OK POSE %u\n", (unsigned)seq);
  if (!nodes[WX_ROLE_BODY].alive) Serial.println("LOG body not heard, sending anyway");
  pose_send();
}

// CFG <role> k=v ...: forwarded as WX_CONFIG, split into as many packets as
// the 40-byte text needs. The board answers with WX_CONFIG -> LOG <role> ...
static void cmd_cfg(char *args) {
  char *who = strtok(args, " ");
  uint8_t role = 0;
  if (who && strcmp(who, "sensor") == 0) role = WX_ROLE_SENSOR;
  else if (who && strcmp(who, "body") == 0) role = WX_ROLE_BODY;
  if (!role) { Serial.println("ERR usage CFG sensor|body <key>=<value> ..."); return; }
  if (!nodes[role].known) { Serial.printf("ERR %s not heard\n", who); return; }
  WxPacket p;
  wx_init(&p, WX_CONFIG, group, MY_ROLE);
  size_t used = 0;
  int sent = 0;
  for (char *tok = strtok(nullptr, " "); tok; tok = strtok(nullptr, " ")) {
    size_t len = strlen(tok);
    if (len >= WX_TEXT_LEN || !strchr(tok, '=')) { Serial.printf("ERR bad pair %s\n", tok); return; }
    if (used && used + 1 + len >= WX_TEXT_LEN) {
      send_to(nodes[role].mac, &p);
      sent++;
      memset(p.text, 0, sizeof(p.text));
      used = 0;
    }
    if (used) p.text[used++] = ' ';
    memcpy(p.text + used, tok, len);
    used += len;
  }
  if (!used && !sent) { Serial.println("ERR nothing to set"); return; }
  if (used) send_to(nodes[role].mac, &p);
  Serial.println("OK CFG");
}

static void handle_command(char *line) {
  host_ms = millis();
  while (*line == ' ') line++;
  char *args = strchr(line, ' ');
  if (args) *args++ = 0;
  else args = line + strlen(line);

  if (strcmp(line, "PING") == 0) {
    Serial.println("PONG");
  } else if (strcmp(line, "INFO") == 0) {
    print_info();
  } else if (strcmp(line, "SET") == 0) {
    cmd_set(args);
  } else if (strcmp(line, "TIME") == 0) {
    long t;
    if (!wx_parse_long(args, 1000000000L, 0x7FFFFFFFL, &t)) { Serial.println("ERR usage TIME <unix_seconds>"); return; }
    time_unix = (uint32_t)t;
    time_ms = millis();
    send_time();
    Serial.println("OK TIME");
  } else if (strcmp(line, "POSE") == 0) {
    cmd_pose(args);
  } else if (strcmp(line, "RELAX") == 0 || strcmp(line, "READ") == 0) {
    bool relax = strcmp(line, "RELAX") == 0;
    uint8_t role = relax ? WX_ROLE_BODY : WX_ROLE_SENSOR;
    WxPacket p;
    wx_init(&p, relax ? WX_RELAX : WX_READ, group, MY_ROLE);
    if (relax) pose_busy = false;
    if (!nodes[role].alive) Serial.printf("LOG %s not heard, sending anyway\n", wx_role_name(role));
    send_to(addr_of(role), &p);
    Serial.printf("OK %s\n", line);
  } else if (strcmp(line, "TEST") == 0) {
    long k;
    if (!wx_parse_long(args, 1, 4, &k)) { Serial.println("ERR usage TEST <1..4>"); return; }
    WxPacket p;
    wx_init(&p, WX_TEST, group, MY_ROLE);
    p.text[0] = (char)('0' + k);
    if (!nodes[WX_ROLE_BODY].alive) Serial.println("LOG body not heard, sending anyway");
    send_to(addr_of(WX_ROLE_BODY), &p);
    Serial.println("OK TEST");
  } else if (strcmp(line, "CFG") == 0) {
    cmd_cfg(args);
  } else if (strcmp(line, "NODES") == 0) {
    for (uint8_t r = WX_ROLE_SENSOR; r <= WX_ROLE_BODY; r++) {
      if (nodes[r].alive) print_node(r);
    }
    Serial.println("OK NODES");
  } else if (*line) {
    Serial.printf("ERR unknown command %s\n", line);
  }
}

// ---- setup / loop ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  prefs.begin("weathering", false);
  group = prefs.getUChar("group", 1);
  if (group < WX_GROUP_MIN || group > WX_GROUP_MAX) group = 1;

  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) {
    Serial.println("ERR esp_now_init");
  }
  esp_now_register_recv_cb(on_data_recv);
  add_peer(WX_BROADCAST);
  esp_wifi_set_promiscuous(true);
  wifi_promiscuous_filter_t filt = {WIFI_PROMIS_FILTER_MASK_MGMT};
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous_rx_cb(on_promisc);

  Serial.printf("FW weathering_hub %s mac %s group %u\n", FW_VERSION, WiFi.macAddress().c_str(), group);
  send_hello(WX_BROADCAST);
}

void loop() {
  if (wx_read_line(Serial, &usb)) handle_command(usb.buf);
  RxItem it;
  while (pop_rx(&it)) handle_radio(&it);
  if (rx_dropped) {
    Serial.printf("LOG radio queue full, %lu packets dropped\n", (unsigned long)rx_dropped);
    rx_dropped = 0;
  }
  service_pose();
  service_nodes();
  if ((int32_t)(millis() - next_hello_ms) >= 0) send_hello(WX_BROADCAST);
  if (nodes[WX_ROLE_SENSOR].alive && (int32_t)(millis() - next_time_ms) >= 0) send_time();
  delay(1);
}
