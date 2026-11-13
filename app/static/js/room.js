// A simulated room for testing without sensors: the white box the
// sculpture stands in. Plausible indoor values with a day/night cycle and
// visitors during opening hours. Deterministic for a given seed, so tests
// and demos repeat. Python twin: sim/room.py (same model, same numbers).
//
//   lux  windows follow the sun (clouds drift); gallery lights 10–18 h
//   t    20 °C ± a daily swing, warmed a little by visitors
//   rh   falls as the room warms
//   co2  420 ppm outdoors; each visitor adds, ventilation pulls back (τ 40 min)
//   db   quiet room ≈ −62 dBFS, louder with visitors

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth noise in time (value noise with cosine interpolation), 0..1.
function smooth(seed, unix, periodS) {
  const k = Math.floor(unix / periodS);
  const f = unix / periodS - k;
  const r = (i) => mulberry32((seed * 7919 + i * 104729) >>> 0)();
  const w = (1 - Math.cos(Math.PI * f)) / 2;
  return r(k) * (1 - w) + r(k + 1) * w;
}

export class Room {
  constructor({ seed = 1, tzOffsetH = -new Date().getTimezoneOffset() / 60, open = [10, 18] } = {}) {
    this.seed = seed;
    this.tz = tzOffsetH;          // local time = UTC + tz (Athens/Vienna-ish)
    this.open = open;
    this.co2 = 430;
    this.visitors = 0;
    this.last = null;
    this.rand = mulberry32(seed);
  }

  hourOfDay(unix) {
    const h = ((unix / 3600 + this.tz) % 24 + 24) % 24;
    return h;
  }

  // Advance the room to `unix` and read it.
  read(unix) {
    const h = this.hourOfDay(unix);
    const dt = this.last === null ? 300 : Math.max(0, Math.min(3600, unix - this.last));
    this.last = unix;
    const isOpen = h >= this.open[0] && h < this.open[1];

    // visitors: a slow random crowd during opening hours, none at night
    const crowd = isOpen ? 1 + 9 * smooth(this.seed + 11, unix, 2400) ** 2 : 0;
    this.visitors += (crowd - this.visitors) * Math.min(1, dt / 900);
    const v = Math.max(0, this.visitors + (isOpen ? (this.rand() - 0.5) * 1.5 : 0));

    // light
    const sun = Math.max(0, Math.sin(((h - 6.5) / 13) * Math.PI));     // ~06:30–19:30
    const cloud = 0.35 + 0.65 * smooth(this.seed + 3, unix, 5400);
    const lamps = isOpen ? 380 : 0;
    const lux = 2 + 260 * sun * cloud + lamps + (this.rand() - 0.5) * 6;

    // temperature and humidity
    const drift = (smooth(this.seed + 5, unix, 86400 * 3) - 0.5) * 2.0;
    const t = 20 + 1.4 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + 0.12 * v + drift
              + (this.rand() - 0.5) * 0.1;
    const rh = 46 - (t - 20) * 2.2 + (smooth(this.seed + 7, unix, 86400) - 0.5) * 8
               + (this.rand() - 0.5) * 0.6;

    // CO2: first-order towards 420 + 45 ppm per visitor
    const target = 420 + 45 * v;
    this.co2 += (target - this.co2) * (1 - Math.exp(-dt / 2400));
    const co2 = this.co2 + (this.rand() - 0.5) * 6;

    // sound level (dBFS, 0 = loudest)
    const db = -62 + 9 * Math.log10(1 + 3 * v) + (this.rand() - 0.5) * 2;

    return {
      co2: Math.round(co2), t: +t.toFixed(2), rh: +Math.max(15, Math.min(85, rh)).toFixed(1),
      lux: Math.round(Math.max(0, lux)), db: Math.round(db),
    };
  }
}
