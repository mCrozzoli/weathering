// The USB line protocol between the computer and the hub (docs/PROTOCOL.md).
// Pure functions: format what we send, parse what the hub says.
// Python twin for the parts the local app needs: app/protocol.py.

export const CHANNELS = ["co2", "t", "rh", "lux", "db"];
export const CHANNEL_INFO = {
  co2: { label: "CO₂", unit: "ppm", digits: 0 },
  t:   { label: "Temperature", unit: "°C", digits: 1 },
  rh:  { label: "Humidity", unit: "%", digits: 0 },
  lux: { label: "Light", unit: "lx", digits: 0 },
  db:  { label: "Sound", unit: "dB", digits: 0 },
};
export const ROLES = ["sensor", "hub", "body"];
export const MOTORS = 4;
// the channels a show starts with (the SCD30); lux and db can be added later
export const CORE_CHANNELS = ["co2", "t", "rh"];

// A shape is how far each string is let out (0 = closed, 1 = fully open);
// the body is sent PULLS (0 = slack/open, 1 = closed). The show opens with
// its openness: pulls = 1 − openness × shape.
export const toPulls = (shape, openness = 1) => shape.map((s) => +(1 - openness * Math.min(1, Math.max(0, s))).toFixed(3));
export const CLOSED = () => new Array(MOTORS).fill(1);

const num = (s) => (s === undefined || s === "" ? null : Number(s));
const fix = (x, d = 3) => Number(x).toFixed(d);

// ------------------------------------------------------------- formatting
// pulls: 4 values, 1 = closed
export function formatPose(seq, pulls, glideS = 60) {
  if (!Array.isArray(pulls) || pulls.length !== MOTORS) throw new Error("a pose has 4 pulls");
  const vals = pulls.map((a) => fix(Math.min(1, Math.max(0, Number(a) || 0))));
  return `POSE ${seq | 0} ${vals.join(" ")} ${Math.max(0, Math.min(3600, Math.round(glideS)))}`;
}
export const formatTime = (unix) => `TIME ${Math.floor(unix)}`;
export const formatTest = (k) => `TEST ${k | 0}`;
export function formatCfg(role, settings) {
  const pairs = Object.entries(settings).map(([k, v]) => `${k}=${v}`);
  return `CFG ${role} ${pairs.join(" ")}`;
}
export function formatSet(settings) {
  return "SET " + Object.entries(settings).map(([k, v]) => `${k}=${v}`).join(" ");
}

// --------------------------------------------------------------- parsing
// key=value pairs after the fixed words
function kv(parts) {
  const out = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
    else out[p] = true;
  }
  return out;
}

// One line from the hub (or any board) -> an event object, or null.
export function parseLine(raw) {
  const line = String(raw).trim();
  if (!line) return null;
  const parts = line.split(/\s+/);
  const head = parts[0];
  let m;
  switch (head) {
    case "R": {
      // R <unix> <seq> co2=… t=… rh=… lux=… db=… [sim=a,b] [old]
      if (parts.length < 3) return { type: "bad", line };
      const f = kv(parts.slice(3));
      const reading = { unix: num(parts[1]), seq: num(parts[2]), old: !!f.old,
        sim: f.sim ? String(f.sim).split(",").filter(Boolean) : [] };
      for (const c of CHANNELS) reading[c] = f[c] === undefined ? null : num(f[c]);
      if (!Number.isFinite(reading.unix)) return { type: "bad", line };
      return { type: "reading", reading };
    }
    case "BODY": {
      // BODY <p1> … <p4> moving=<0|1> homed=<0|1> found=<mask>
      const pose = parts.slice(1, 1 + MOTORS).map(Number);
      const f = kv(parts.slice(1 + MOTORS));
      if (pose.length !== MOTORS || pose.some((x) => !Number.isFinite(x))) return { type: "bad", line };
      return { type: "body", pose, moving: f.moving === "1", homed: f.homed !== "0",
               found: f.found === undefined ? 15 : Number(f.found) };
    }
    case "NODE":
      // NODE <role> <mac> fw <version> rssi <dBm>
      return { type: "node", role: parts[1], mac: parts[2], fw: parts[4] || null,
               rssi: num(parts[6]) };
    case "LOST":
      return { type: "lost", role: parts[1] };
    case "ACK":
    case "NAK":
      return { type: head.toLowerCase(), role: parts[1], seq: num(parts[2]) };
    case "OK":
      return { type: "ok", what: parts.slice(1).join(" "), seq: num(parts[2]) };
    case "ERR":
      return { type: "err", reason: parts.slice(1).join(" ") };
    case "PONG":
      return { type: "pong" };
    case "LOG":
      return { type: "log", text: line.slice(4) };
    case "INFO": {
      // INFO <role> fw <v> mac <mac> group <g> [k=v …]
      const info = { role: parts[1], fw: parts[3], mac: parts[5], group: num(parts[7]) };
      Object.assign(info, kv(parts.slice(8)));
      return { type: "info", info };
    }
    case "FW":
      if ((m = line.match(/^FW weathering_(\w+) (\S+) mac (\S+)(?: group (\d+))?/))) {
        return { type: "boot", role: m[1], fw: m[2], mac: m[3], group: num(m[4]) };
      }
      return { type: "log", text: line };
    default:
      return { type: "log", text: line };
  }
}

// A reading -> the CSV row the show keeps (same columns as app/store.py).
export const CSV_HEADER = "unix,seq,co2,t,rh,lux,db,sim,old";
export function readingToCsv(r) {
  const v = (x) => (x === null || x === undefined || Number.isNaN(x) ? "" : x);
  return [r.unix, v(r.seq), ...CHANNELS.map((c) => v(r[c])), (r.sim || []).join(";"), r.old ? 1 : 0].join(",");
}
export function csvToReading(row) {
  const p = row.split(",");
  if (p.length < 9 || p[0] === "unix") return null;
  const r = { unix: Number(p[0]), seq: num(p[1]), sim: p[7] ? p[7].split(";") : [], old: p[8] === "1" };
  CHANNELS.forEach((c, i) => { r[c] = p[2 + i] === "" ? null : Number(p[2 + i]); });
  return Number.isFinite(r.unix) ? r : null;
}

// The reading line the hub prints (used by the simulators).
export function formatReading(r) {
  const vals = CHANNELS.filter((c) => r[c] !== null && r[c] !== undefined)
    .map((c) => `${c}=${Number(r[c]).toFixed(CHANNEL_INFO[c].digits === 0 ? 0 : 2)}`);
  const sim = r.sim && r.sim.length ? ` sim=${r.sim.join(",")}` : "";
  return `R ${Math.floor(r.unix)} ${r.seq | 0} ${vals.join(" ")}${sim}${r.old ? " old" : ""}`;
}
