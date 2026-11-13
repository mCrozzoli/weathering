// A pretend hub, with a pretend sensor box and sculpture behind it, for
// trying everything without hardware. It speaks the same USB lines as the
// hub firmware (docs/PROTOCOL.md), but its clock can run fast: at ×720 a
// day of readings arrives in two minutes. Python twin: sim/fake_hub.py.

import { Room } from "./room.js";
import { CHANNELS, SERVOS, formatReading, parseLine } from "./protocol.js";

const FW = "0.1.0-demo";

export class FakeHub {
  // onLine(text): the hub "prints" a line.
  constructor({ onLine, speed = 720, startUnix = null, interval = 300, seed = 1,
                missing = [] } = {}) {
    this.onLine = onLine || (() => {});
    this.speed = speed;
    this.interval = interval;
    this.missing = new Set(missing);         // channels with no sensor at all
    this.room = new Room({ seed });
    this.clock = startUnix ?? Math.floor(Date.now() / 1000);
    this.nextReading = this.clock;
    this.seq = 0;
    this.pose = new Array(SERVOS).fill(0);   // where the body is
    this.from = this.pose.slice();
    this.target = this.pose.slice();
    this.glide = { start: 0, dur: 0 };
    this.timer = null;
    this.lastReal = null;
    this.lastBodyReport = 0;
  }

  get now() { return this.clock; }

  start() {
    if (this.timer) return;
    this.say("FW weathering_hub " + FW + " mac DE:MO:00:00:00:02 group 1");
    this._nodes();
    this.lastReal = performanceNow();
    this.timer = setInterval(() => this._tick(), 100);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  setSpeed(s) { this.speed = Math.max(1, s); }

  // Jump the clock forward, producing every reading on the way (no waiting).
  skip(seconds) {
    const end = this.clock + seconds;
    while (this.nextReading <= end) {
      this.clock = this.nextReading;
      this._reading();
    }
    this.clock = end;
    this._moveBody(true);
  }

  say(line) { this.onLine(line); }

  // The computer writes a line to the hub.
  write(raw) {
    const line = String(raw).trim();
    const p = line.split(/\s+/);
    switch (p[0]) {
      case "PING": return this.say("PONG");
      case "INFO": return this.say(`INFO hub fw ${FW} mac DE:MO:00:00:00:02 group 1`);
      case "NODES": return this._nodes();
      case "TIME": return this.say("OK TIME");      // the demo keeps its own fast clock
      case "READ": this._reading(true); return;
      case "POSE": {
        const seq = Number(p[1]);
        const vals = p.slice(2, 8).map(Number);
        const glide = Number(p[8] ?? 60);
        if (vals.length !== SERVOS || vals.some((x) => !Number.isFinite(x))) return this.say("ERR bad pose");
        this.say(`OK POSE ${seq}`);
        this.from = this.pose.slice();
        this.target = vals.map((x) => Math.min(1, Math.max(0, x)));
        this.glide = { start: this.clock, dur: Math.max(0, glide) };
        setTimeout(() => this.say(`ACK body ${seq}`), 120);
        return;
      }
      case "TEST": return this.say(`OK TEST ${p[1] ?? 0}`);
      case "RELAX": return this.say("OK RELAX");
      case "CFG": {
        if (p[1] === "sensor") {
          const iv = line.match(/interval=(\d+)/);
          if (iv) this.interval = Math.max(10, Number(iv[1]));
        }
        return this.say(`OK CFG ${p[1] ?? ""}`.trim());
      }
      default:
        return this.say(`ERR unknown ${p[0] || ""}`.trim());
    }
  }

  _nodes() {
    this.say(`NODE sensor DE:MO:00:00:00:01 fw ${FW} rssi -48`);
    this.say(`NODE body DE:MO:00:00:00:03 fw ${FW} rssi -55`);
  }

  _tick() {
    const real = performanceNow();
    const dReal = (real - this.lastReal) / 1000;
    this.lastReal = real;
    const end = this.clock + dReal * this.speed;
    while (this.nextReading <= end) {
      this.clock = this.nextReading;
      this._reading();
    }
    this.clock = end;
    this._moveBody(false);
  }

  _reading(now = false) {
    const unix = now ? Math.floor(this.clock) : this.nextReading;
    const values = this.room.read(unix);
    const r = { unix, seq: this.seq++, sim: CHANNELS.filter((c) => !this.missing.has(c)), old: false };
    for (const c of CHANNELS) r[c] = this.missing.has(c) ? null : values[c];
    // every value is simulated in the demo: say so, like the real sensor board does
    this.say(formatReading(r));
    if (!now) this.nextReading += this.interval;
  }

  _moveBody(force) {
    const { start, dur } = this.glide;
    const k = dur <= 0 ? 1 : Math.min(1, (this.clock - start) / dur);
    const moving = k < 1;
    const next = this.from.map((a, i) => a + (this.target[i] - a) * k);
    const changed = next.some((a, i) => Math.abs(a - this.pose[i]) > 1e-4);
    this.pose = next;
    const real = performanceNow();
    if ((changed && real - this.lastBodyReport > 250) || force || (!moving && changed)) {
      this.lastBodyReport = real;
      this.say(`BODY ${this.pose.map((a) => a.toFixed(3)).join(" ")} moving=${moving ? 1 : 0}`);
    }
  }
}

function performanceNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export { parseLine };
