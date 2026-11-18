// Boards panel: set up the three ESP32 boards one at a time over USB, in
// the browser (Chrome or Edge). Adapted from calum-organ's Boards panel.
//
//   sensor   reads the room            (firmware/weathering_sensor)
//   hub      stays on USB at the show  (firmware/weathering_hub)
//   body     winds the 4 strings       (firmware/weathering_body)
//
// Plug a board in → identify it (reset + read its boot line + INFO) →
// install firmware (esptool-js, the flasher ESP Web Tools is built on) →
// change its settings (stored on the board) → test it.

import { parseLine, formatSet } from "./protocol.js";

const BAUD = 115200;
const ESPTOOL = "https://unpkg.com/esptool-js@0.5.7/bundle.js";   // loaded only when installing
export const ROLE_INFO = {
  sensor: { label: "Sensor box", does: "reads the room and sends it by radio", path: "firmware/sensor/" },
  hub: { label: "Hub", does: "stays on USB at the computer", path: "firmware/hub/" },
  body: { label: "Sculpture", does: "winds the four strings (Dynamixel motors)", path: "firmware/body/" },
};
const CONNECT_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lines a board said about itself → {role, fw, mac, group, settings}
export function describeBoard(lines) {
  const out = { role: null, fw: null, mac: null, group: null, settings: {} };
  for (const l of lines) {
    const ev = parseLine(l);
    if (!ev) continue;
    if (ev.type === "boot") Object.assign(out, { role: ev.role, fw: ev.fw, mac: ev.mac, group: ev.group ?? out.group });
    if (ev.type === "info") {
      const { role, fw, mac, group, ...rest } = ev.info;
      Object.assign(out, { role, fw, mac, group });
      out.settings = rest;
    }
  }
  return out;
}

// body motor settings from INFO: "m1=<id>,<travel ticks>" → {id, travel}
export function parseMotor(v) {
  const [id, travel] = String(v || "").split(",").map(Number);
  return { id: Number.isFinite(id) ? id : 0, travel: Number.isFinite(travel) ? travel : 0 };
}
export const TICKS_PER_TURN = 4096;

// Open the port, maybe reboot the board, maybe send one line, collect lines.
async function talk(port, { reset = false, send = null, sendAfterMs = 0, done = () => false, timeoutMs = 2500 }) {
  await port.open({ baudRate: BAUD });
  const lines = [];
  const reader = port.readable.getReader();
  const dec = new TextDecoder();
  let buf = "", finished = false;
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          lines.push(buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
        }
        if (done(lines)) { finished = true; break; }
      }
    } catch (_) { /* port closed under us */ }
  })();
  try {
    if (reset) {
      // EN low (RTS) with IO0 high (DTR off): the board restarts and runs
      await port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(120);
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    }
    if (send) {
      await sleep(sendAfterMs);
      const w = port.writable.getWriter();
      await w.write(new TextEncoder().encode(send.trim() + "\n"));
      w.releaseLock();
    }
    const until = Date.now() + timeoutMs;
    while (!finished && Date.now() < until) await sleep(50);
  } finally {
    try { await reader.cancel(); } catch (_) {}
    await reading;
    reader.releaseLock();
    await port.close();
  }
  return lines;
}

export async function inspect(port) {
  const lines = await talk(port, {
    reset: true, send: "INFO", sendAfterMs: 1300, timeoutMs: 3000,
    done: (ls) => ls.some((l) => l.startsWith("INFO ")),
  });
  return { ...describeBoard(lines), lines };
}

export async function command(port, text, expect) {
  for (const wait of [100, 1500]) {       // opening the port can restart some boards
    const lines = await talk(port, {
      send: text, sendAfterMs: wait, timeoutMs: wait + 1500,
      done: (ls) => ls.some((l) => l.startsWith(expect) || l.startsWith("ERR")),
    });
    const reply = lines.find((l) => l.startsWith(expect) || l.startsWith("ERR"));
    if (reply?.startsWith(expect)) return { reply, lines };
    if (reply) throw new Error(reply.replace(/^ERR\s*/, "the board said: "));
  }
  throw new Error("the board didn't answer");
}

export const saveSettings = (port, settings) => command(port, formatSet(settings), "OK SET");
export const testMotor = (port, k) => command(port, `TEST ${k}`, "OK TEST");      // k: 1..4
export async function info(port) {
  const { lines } = await command(port, "INFO", "INFO ");
  return { ...describeBoard(lines), lines };
}
// SCAN: the body pings every Dynamixel id at two speeds (~6 s)
export async function scan(port) {
  const lines = await talk(port, { send: "SCAN", sendAfterMs: 200, timeoutMs: 15000,
    done: (ls) => ls.some((l) => l.startsWith("LOG scan done")) });
  return lines.filter((l) => l.startsWith("LOG motor id") || l.startsWith("LOG scan done")).map((l) => l.slice(4));
}
export const readNow = (port) => command(port, "READ", "R ");

export async function latestVersion(role) {
  try {
    const m = await (await fetch(`${ROLE_INFO[role].path}manifest.json`, { cache: "no-store" })).json();
    return m.version;
  } catch (_) { return null; }
}

// Install a role's firmware. Settings stored on the board are kept.
export async function install(port, role, { onProgress = () => {}, onLog = () => {} } = {}) {
  const base = ROLE_INFO[role].path;
  const manifest = await (await fetch(`${base}manifest.json`, { cache: "no-store" })).json();
  const images = [];
  for (const part of manifest.builds[0].parts) {
    const r = await fetch(base + part.path, { cache: "no-store" });
    if (!r.ok) throw new Error(`couldn't download ${part.path}`);
    images.push({ address: part.offset, bytes: new Uint8Array(await r.arrayBuffer()) });
  }
  let esptool;
  try { esptool = await import(ESPTOOL); }
  catch (_) { throw new Error("couldn't load the installer (is this computer online?)"); }
  const terminal = { clean() {}, writeLine: (t) => onLog(t), write: (t) => onLog(t) };
  const transport = new esptool.Transport(port, false);
  const loader = new esptool.ESPLoader({ transport, baudrate: 460800, romBaudrate: BAUD, terminal });
  try {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no answer from the board: hold its BOOT button and try again")), CONNECT_MS); });
    try { onLog(`chip: ${await Promise.race([loader.main(), timeout])}`); }
    finally { clearTimeout(timer); }
    const family = loader.chip?.CHIP_NAME;
    if (family !== "ESP32") throw new Error(`this is an ${family}: Weathering's firmware is for a plain ESP32`);
    const total = images.reduce((n, im) => n + im.bytes.length, 0);
    const before = images.map((_, i) => images.slice(0, i).reduce((n, im) => n + im.bytes.length, 0));
    await loader.writeFlash({
      fileArray: images.map((im) => ({ address: im.address, data: loader.ui8ToBstr(im.bytes) })),
      flashSize: "keep", flashMode: "keep", flashFreq: "keep", eraseAll: false, compress: true,
      reportProgress: (i, written, size) => onProgress((before[i] + written * (images[i].bytes.length / size)) / total),
    });
    await loader.after("hard_reset");
  } finally {
    await Promise.race([transport.disconnect().catch(() => {}), sleep(3000)]);
    if (port.readable || port.writable) { try { await port.close(); } catch (_) {} }
  }
  return manifest.version;
}
