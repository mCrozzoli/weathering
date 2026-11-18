// Three ways the page reaches the hub and keeps the show. They all look the
// same to the rest of the page:
//
//   kind          lines from    show kept in
//   "local"       local app     files on disk (~/.weathering) — the installation
//   "serial"      USB hub via   this browser (online, Chrome/Edge)
//                 Web Serial
//   "demo"        a pretend hub this browser ("demo" show), fast clock
//
// Interface: start(onEvent) · send(line) · stop() · loadShow() ·
// addReading(r) · addRun(run) · saveSettings(m) · describe()
// onEvent({type:"line", line} | {type:"status", connected, port})

import { FakeHub } from "./fakehub.js";
import { BrowserShow } from "./store.js";
import { csvToReading, formatTime } from "./protocol.js";

export const DEFAULTS = { run_times: ["06:00", "18:00"], driving: "som", show_days: 14, glide_s: 60, moves: "runs", examples: [] };
const BAUD = 115200;

// --------------------------------------------------------------- local
export class LocalBackend {
  constructor() { this.kind = "local"; this.es = null; }

  static async available() {
    if (location.protocol === "file:") return false;
    try {
      const r = await fetch("api/state", { cache: "no-store" });
      return r.ok && (await r.json()).mode === "local";
    } catch (_) { return false; }
  }

  async state() { return (await fetch("api/state", { cache: "no-store" })).json(); }

  start(onEvent) {
    this.es = new EventSource("events");
    this.es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch (_) {} };
    this.es.onerror = () => onEvent({ type: "status", connected: false, port: null, server: false });
  }

  stop() { this.es?.close(); }

  async send(line) {
    const r = await this._post("api/send", { line });
    return !!r.ok;
  }

  async connect(port) { return this._post("api/connect", { port }); }
  async disconnect() { return this._post("api/disconnect", {}); }
  async quit() { return this._post("api/quit", {}); }
  async touch() { return this._post("api/touch", {}); }

  async loadShow() {
    const s = await (await fetch("api/show", { cache: "no-store" })).json();
    const readings = s.readings.split("\n").map(csvToReading).filter(Boolean).sort((a, b) => a.unix - b.unix);
    return { meta: { ...DEFAULTS, ...s.meta }, readings, runs: s.runs, recent: s.recent || [] };
  }

  async addReading() { /* the local app already wrote it to disk */ }
  async addRun(run) { await this._post("api/run", { run }); }
  async saveSettings(m) { await this._post("api/settings", m); }
  async openShow(name) { return this._post("api/show/open", { name }); }

  async _post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  }
}

// ------------------------------------------------------------- browser
class BrowserBacked {
  constructor(showName) { this.show = new BrowserShow(showName); }
  async loadShow() {
    await this.show.init(DEFAULTS);
    const meta = { ...DEFAULTS, ...(await this.show.meta()) };
    return { meta, readings: await this.show.readings(), runs: await this.show.runs(), recent: [] };
  }
  async addReading(r) { await this.show.addReading(r); }
  async addRun(run) { await this.show.addRun(run); }
  async saveSettings(m) { await this.show.saveMeta({ ...(await this.show.meta()), ...m }); }
}

// ------------------------------------------------- USB hub (Web Serial)
export class SerialBackend extends BrowserBacked {
  constructor(port, showName = "online") {
    super(showName);
    this.kind = "serial";
    this.port = port;
    this.closing = false;
  }

  static supported() { return "serial" in navigator; }

  async start(onEvent) {
    this.onEvent = onEvent;
    // DTR/RTS low: opening the port must not reset the hub into its bootloader
    await this.port.open({ baudRate: BAUD });
    try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (_) {}
    this.writer = this.port.writable.getWriter();
    this.enc = new TextEncoder();
    onEvent({ type: "status", connected: true, port: "USB" });
    this.loop = this._read();
    await this.send(formatTime(Date.now() / 1000));
    await this.send("NODES");
    // the hub forwards readings only while the computer has spoken within 30 min
    this.clock = setInterval(() => this.send(formatTime(Date.now() / 1000)), 5 * 60 * 1000);
  }

  async _read() {
    const dec = new TextDecoder();
    let buf = "";
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "").trim();
            buf = buf.slice(nl + 1);
            if (line) this.onEvent({ type: "line", line });
          }
        }
      } catch (_) { /* framing errors: keep reading; a lost device ends the loop */ }
      finally { this.reader.releaseLock(); }
    }
    if (!this.closing) this.onEvent({ type: "status", connected: false, port: null, lost: true });
  }

  async send(line) {
    try { await this.writer.write(this.enc.encode(line.trim() + "\n")); return true; }
    catch (_) { return false; }
  }

  async stop() {
    this.closing = true;
    clearInterval(this.clock);
    try { await this.reader?.cancel(); } catch (_) {}
    try { await this.loop; } catch (_) {}
    try { this.writer?.releaseLock(); } catch (_) {}
    try { await this.port.close(); } catch (_) {}
  }
}

// ---------------------------------------------------------------- demo
export class DemoBackend extends BrowserBacked {
  constructor(speed = 720) {
    super("demo");
    this.kind = "demo";
    this.speed = speed;
  }

  async loadShow() {
    const s = await super.loadShow();
    // carry on the demo clock from where the stored demo stopped
    this.startUnix = s.readings.length ? s.readings.at(-1).unix + 300 : Math.floor(Date.now() / 1000);
    return s;
  }

  start(onEvent) {
    this.hub = new FakeHub({ onLine: (line) => onEvent({ type: "line", line }), speed: this.speed, startUnix: this.startUnix });
    onEvent({ type: "status", connected: true, port: "demo" });
    this.hub.start();
  }

  setSpeed(s) { this.speed = s; this.hub?.setSpeed(s); }
  skip(seconds) { this.hub?.skip(seconds); }
  get now() { return this.hub ? this.hub.now : Date.now() / 1000; }
  async send(line) { this.hub?.write(line); return true; }
  stop() { this.hub?.stop(); }
  async reset() { this.hub?.stop(); await this.show.init(DEFAULTS); await this.show.clear(); }
}
