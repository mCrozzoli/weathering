// Weathering — shared between the three sketches (sensor, hub, body).
//
// Arduino only compiles headers that live inside the sketch folder, so this
// file exists three times: firmware/weathering_{sensor,hub,body}/wx.h.
// Keep them identical (tests/test_firmware.py checks this).
//
// The contract is docs/PROTOCOL.md; this header is its radio part.
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

// Printed at boot and in INFO; must match every manifest.json
// (tests/test_firmware.py). WX_FW_CODE goes in every packet's `fw`.
#define FW_VERSION "0.2.0"
#define WX_FW_CODE 0x0002      // major << 8 | minor

// Bump on any incompatible change to WxPacket: other magics are ignored.
#define WX_MAGIC 0xA8          // 0xA7 was v0.1 (six servos)

enum : uint8_t { WX_ROLE_SENSOR = 1, WX_ROLE_HUB = 2, WX_ROLE_BODY = 3 };

enum : uint8_t {
  WX_HELLO = 1, WX_READING = 2, WX_ACK = 3, WX_TIME = 4, WX_POSE = 5,
  WX_BODYSTATE = 6, WX_CONFIG = 7, WX_TEST = 8, WX_RELAX = 9, WX_READ = 10,
};

// READING channels, in packet order (v[i], present bit i, simulated bit i+1).
enum { WX_CO2 = 0, WX_T = 1, WX_RH = 2, WX_LUX = 3, WX_DB = 4, WX_CHANNELS = 5 };
static const char *const WX_CHANNEL_NAMES[WX_CHANNELS] = {"co2", "t", "rh", "lux", "db"};

#define WX_FLAG_OLD      0x01      // READING: a backlog reading arriving late
#define WX_FLAG_SIM(i)   (0x02 << (i))
#define WX_FLAG_MOVING   0x01      // BODYSTATE (bits 4-7: motors that answer)
#define WX_FLAG_HOMED    0x02      // BODYSTATE

#define WX_TEXT_LEN 40

// Fixed-size, safe-to-memcpy payload. Fields unused by a packet type are 0.
typedef struct __attribute__((packed)) {
  uint8_t  magic;      // WX_MAGIC
  uint8_t  type;       // WX_*
  uint8_t  group;      // installation group; others ignored
  uint8_t  role;       // sender's role: 1 sensor, 2 hub, 3 body
  uint16_t fw;         // WX_FW_CODE
  uint16_t seq;        // READING: reading number; ACK: what is acknowledged; POSE: pose number
  uint32_t unix;       // TIME, READING
  uint8_t  flags;      // READING: bit0 old, bits1..5 simulated mask (co2,t,rh,lux,db); BODYSTATE: bit0 moving, bit1 homed, bits4-7 found
  uint8_t  present;    // READING: bit i = value i present
  float    v[6];       // READING: co2,t,rh,lux,db,(spare); POSE, BODYSTATE: pulls p1..p4 in v[0..3]
  uint16_t glide_s;    // POSE
  char     text[WX_TEXT_LEN];   // CONFIG: "key=value key=value"; TEST: "k" (1-4)
} WxPacket;

static const uint8_t WX_BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

#define WX_HELLO_MS 3000       // every board broadcasts HELLO this often
#define WX_LOST_MS  30000      // a board not heard for this long is lost

#define WX_GROUP_MIN 1
#define WX_GROUP_MAX 250

static inline const char *wx_role_name(uint8_t role) {
  switch (role) {
    case WX_ROLE_SENSOR: return "sensor";
    case WX_ROLE_HUB:    return "hub";
    case WX_ROLE_BODY:   return "body";
    default:             return "?";
  }
}

static inline void wx_mac_str(const uint8_t *m, char *out /* 18 bytes */) {
  snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
}

static inline void wx_init(WxPacket *p, uint8_t type, uint8_t group, uint8_t role) {
  memset(p, 0, sizeof(*p));
  p->magic = WX_MAGIC;
  p->type  = type;
  p->group = group;
  p->role  = role;
  p->fw    = WX_FW_CODE;
}

// A packet for us: right size, right magic, our group.
static inline const WxPacket *wx_accept(const uint8_t *data, int len, uint8_t group) {
  if (len != (int)sizeof(WxPacket)) return nullptr;
  const WxPacket *p = (const WxPacket *)data;
  if (p->magic != WX_MAGIC || p->group != group) return nullptr;
  return p;
}

// The R line (docs/PROTOCOL.md), from a READING packet:
//   R <unix> <seq> co2=<v> t=<v> rh=<v> lux=<v> db=<v> [sim=<list>] [old]
// Channels without a value are left out.
static inline int wx_format_reading(const WxPacket *p, char *line, size_t size) {
  static const char *const FMT[WX_CHANNELS] = {" co2=%.0f", " t=%.2f", " rh=%.1f", " lux=%.1f", " db=%.1f"};
  int n = snprintf(line, size, "R %lu %u", (unsigned long)p->unix, (unsigned)p->seq);
  for (int i = 0; i < WX_CHANNELS && n < (int)size; i++) {
    if (p->present & (1 << i)) n += snprintf(line + n, size - n, FMT[i], p->v[i]);
  }
  bool first = true;
  for (int i = 0; i < WX_CHANNELS && n < (int)size; i++) {
    if ((p->present & (1 << i)) && (p->flags & WX_FLAG_SIM(i))) {
      n += snprintf(line + n, size - n, "%s%s", first ? " sim=" : ",", WX_CHANNEL_NAMES[i]);
      first = false;
    }
  }
  if ((p->flags & WX_FLAG_OLD) && n < (int)size) n += snprintf(line + n, size - n, " old");
  return n;
}

// ---- USB lines -------------------------------------------------------------
// Reads characters into buf; returns true when a whole line is in it
// (CR ignored, overlong lines dropped).
typedef struct { char buf[192]; size_t len; bool overflow; } WxLine;

template <typename S>
static inline bool wx_read_line(S &serial, WxLine *l) {
  while (serial.available()) {
    char c = (char)serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      bool ok = !l->overflow;
      l->buf[l->len] = 0;
      l->len = 0;
      l->overflow = false;
      if (ok) return true;
      continue;
    }
    if (l->len < sizeof(l->buf) - 1) l->buf[l->len++] = c;
    else l->overflow = true;
  }
  return false;
}

// Splits "key=value" in place; returns false if there is no '='.
static inline bool wx_split_kv(char *tok, char **key, char **val) {
  char *eq = strchr(tok, '=');
  if (!eq || eq == tok) return false;
  *eq = 0;
  *key = tok;
  *val = eq + 1;
  return true;
}

// Strict number parsing: the whole token must be the number.
#include <stdlib.h>
static inline bool wx_parse_long(const char *s, long lo, long hi, long *out) {
  if (!s || !*s) return false;
  char *end;
  long v = strtol(s, &end, 10);
  if (*end || v < lo || v > hi) return false;
  *out = v;
  return true;
}
static inline bool wx_parse_float(const char *s, float lo, float hi, float *out) {
  if (!s || !*s) return false;
  char *end;
  float v = strtof(s, &end);
  if (*end || !(v >= lo && v <= hi)) return false;
  *out = v;
  return true;
}
