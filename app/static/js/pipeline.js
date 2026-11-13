// The 12-hour run: everything the sensors gathered so far → one 6D pose per
// algorithm, and the openness that lets the sculpture unfold as it lives.
// Pure functions, no DOM: tested in tests/js/pipeline.test.mjs.
//
// Same data, three readings of it (the multiplicity Miguel and Florian
// asked for — each algorithm makes its own shape):
//   pca       the room's main directions: where today sits along the first
//             three, and how much today moves along them
//   clusters  kinds of hours (k-means, 3): today's share of each kind, and
//             the whole history's share
//   extremes  how unusual today is per channel (percentile in its own
//             history), plus overall novelty
// A pose is 6 values in [0,1]; value k drives servo k. What the body gets is
// pose × openness, so it starts closed and opens as data accumulates.

import { CHANNELS } from "./protocol.js";

export const ALGORITHMS = {
  pca:      { label: "Directions", about: "Where today sits along the room's three main directions of change, and how much it moves along them (PCA)." },
  clusters: { label: "Kinds of hours", about: "The room's hours fall into three kinds (k-means). How much of today, and of all time, is each kind." },
  extremes: { label: "Unusual", about: "How high today is in each sensor's own history, plus how new today is compared to everything before." },
};
export const ALGORITHM_IDS = Object.keys(ALGORITHMS);
export const WINDOW_H = 12;          // "today" = the last 12 hours
export const MIN_HOURS = 6;          // fewer hours than this: stay closed

// ------------------------------------------------------------ small maths
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
function std(a, m = mean(a)) {
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length || 1));
}
const dist2 = (a, b) => a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0);
// fraction of `values` at or below x (empirical CDF), ties counted half
export function percentile(values, x) {
  if (!values.length) return 0.5;
  let below = 0, equal = 0;
  for (const v of values) { if (v < x) below++; else if (v === x) equal++; }
  return (below + equal / 2) / values.length;
}

// Eigen-decomposition of a small symmetric matrix (Jacobi rotations).
export function eigSym(A) {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-14) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const pairs = a.map((row, i) => ({ value: row[i], vector: V.map((r) => r[i]) }));
  pairs.sort((x, y) => y.value - x.value);
  return pairs;
}

// ------------------------------------------------------ readings → hours
// Hourly means, so a dense sensor and a sparse one weigh the same per hour
// and gaps (computer off) just mean fewer hours.
export function hourly(readings) {
  const buckets = new Map();
  for (const r of readings) {
    const h = Math.floor(r.unix / 3600) * 3600;
    let b = buckets.get(h);
    if (!b) buckets.set(h, (b = { sum: {}, n: {} }));
    for (const c of CHANNELS) {
      if (r[c] === null || r[c] === undefined || !Number.isFinite(r[c])) continue;
      b.sum[c] = (b.sum[c] || 0) + r[c];
      b.n[c] = (b.n[c] || 0) + 1;
    }
  }
  const hours = [...buckets.keys()].sort((x, y) => x - y);
  // a channel counts if at least half the hours have it
  const channels = CHANNELS.filter((c) => hours.filter((h) => buckets.get(h).n[c]).length >= hours.length / 2 && hours.length > 0);
  const raw = hours.map((h) => channels.map((c) => {
    const b = buckets.get(h);
    return b.n[c] ? b.sum[c] / b.n[c] : null;
  }));
  // fill a missing hour-channel with that channel's mean
  const means = channels.map((_, j) => mean(raw.map((r) => r[j]).filter((x) => x !== null)));
  const X = raw.map((r) => r.map((x, j) => (x === null ? means[j] : x)));
  return { hours, channels, X };
}

export function standardize(X) {
  const d = X[0]?.length || 0;
  const mu = [], sd = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]);
    mu.push(mean(col));
    const s = std(col, mu[j]);
    sd.push(s > 1e-9 ? s : 1);
  }
  return { Z: X.map((r) => r.map((x, j) => (x - mu[j]) / sd[j])), mu, sd };
}

// --------------------------------------------------------------- PCA
function pcaPose(Z, recent, prev) {
  const n = Z.length, d = Z[0].length;
  const C = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) =>
    Z.reduce((s, r) => s + r[i] * r[j], 0) / n));
  const eig = eigSym(C);
  const total = eig.reduce((s, e) => s + Math.max(0, e.value), 0) || 1;
  const comps = [];
  for (let k = 0; k < 3; k++) {
    let v = eig[k] ? eig[k].vector.slice() : new Array(d).fill(0);
    // a direction has no sign: keep the one closest to the previous run's,
    // else make its largest loading positive, so poses don't flip at random
    const ref = prev?.loadings?.[k];
    if (ref && ref.length === d) {
      if (v.reduce((s, x, i) => s + x * ref[i], 0) < 0) v = v.map((x) => -x);
    } else {
      const big = v.reduce((bi, x, i) => (Math.abs(x) > Math.abs(v[bi]) ? i : bi), 0);
      if (v[big] < 0) v = v.map((x) => -x);
    }
    comps.push(v);
  }
  const proj = (r, v) => r.reduce((s, x, i) => s + x * v[i], 0);
  const pose = [];
  for (let k = 0; k < 3; k++) {
    const all = Z.map((r) => proj(r, comps[k]));
    const today = recent.map((i) => all[i]);
    pose.push(percentile(all, mean(today)));
  }
  for (let k = 0; k < 3; k++) {
    const all = Z.map((r) => proj(r, comps[k]));
    const overall = std(all) || 1;
    const today = recent.map((i) => all[i]);
    pose.push(clamp01(std(today) / overall / 1.5));
  }
  return {
    pose,
    meta: { loadings: comps.map((v) => v.map((x) => +x.toFixed(4))),
            explained: eig.slice(0, 3).map((e) => +(Math.max(0, e.value) / total).toFixed(4)) },
  };
}

// ---------------------------------------------------------- clusters
export function kmeans(Z, k = 3, seed = 7, iters = 30) {
  const n = Z.length;
  let rnd = seed >>> 0;
  const rand = () => ((rnd = (Math.imul(rnd ^ (rnd >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
  let best = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    // k-means++ start
    const cents = [Z[Math.floor(rand() * n)].slice()];
    while (cents.length < k) {
      const d = Z.map((r) => Math.min(...cents.map((c) => dist2(r, c))));
      const sum = d.reduce((s, x) => s + x, 0);
      let pick = rand() * sum, i = 0;
      while (i < n - 1 && (pick -= d[i]) > 0) i++;
      cents.push(Z[i].slice());
    }
    let labels = new Array(n).fill(0);
    for (let it = 0; it < iters; it++) {
      labels = Z.map((r) => cents.reduce((bi, c, ci) => (dist2(r, c) < dist2(r, cents[bi]) ? ci : bi), 0));
      for (let ci = 0; ci < k; ci++) {
        const members = Z.filter((_, i) => labels[i] === ci);
        if (members.length) cents[ci] = members[0].map((_, j) => mean(members.map((m) => m[j])));
      }
    }
    const inertia = Z.reduce((s, r, i) => s + dist2(r, cents[labels[i]]), 0);
    if (!best || inertia < best.inertia) best = { cents: cents.map((c) => c.slice()), labels, inertia };
  }
  return best;
}

const PERMS3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

function clustersPose(Z, X, recent, prev, std0) {
  const k = 3;
  if (Z.length < k) return { pose: new Array(6).fill(0), meta: null };
  const km = kmeans(Z, k);
  // centroids in sensor units, so the next run can recognise them
  const centsUnits = km.cents.map((c) => c.map((z, j) => z * std0.sd[j] + std0.mu[j]));
  let order;
  const ref = prev?.centroids;
  if (ref && ref.length === k && ref[0].length === centsUnits[0].length) {
    // keep each kind's identity: match new centroids to last run's (in today's z-units)
    const zref = ref.map((c) => c.map((x, j) => (x - std0.mu[j]) / std0.sd[j]));
    order = PERMS3.reduce((bp, p) => {
      const cost = p.reduce((s, ci, slot) => s + dist2(km.cents[ci], zref[slot]), 0);
      return !bp || cost < bp.cost ? { p, cost } : bp;
    }, null).p;
  } else {
    // first run: order the kinds by their first channel (e.g. CO₂: quiet → busy)
    order = [0, 1, 2].sort((a, b) => centsUnits[a][0] - centsUnits[b][0]);
  }
  const slotOf = new Array(k);
  order.forEach((ci, slot) => { slotOf[ci] = slot; });
  const labels = km.labels.map((ci) => slotOf[ci]);
  const share = (idx) => [0, 1, 2].map((s) => idx.filter((i) => labels[i] === s).length / (idx.length || 1));
  const all = Z.map((_, i) => i);
  return {
    pose: [...share(recent), ...share(all)],
    meta: { centroids: order.map((ci) => centsUnits[ci].map((x) => +x.toFixed(3))) },
    labels,
  };
}

// ---------------------------------------------------------- extremes
function extremesPose(Z, X, channels, recent) {
  const pose = [];
  for (const c of CHANNELS.slice(0, 5)) {
    const j = channels.indexOf(c);
    if (j < 0) { pose.push(0.5); continue; }
    const col = X.map((r) => r[j]);
    pose.push(percentile(col, mean(recent.map((i) => col[i]))));
  }
  // novelty: how far today's hours are from every earlier hour
  const earlier = Z.map((_, i) => i).filter((i) => !recent.includes(i));
  if (earlier.length < 3) pose.push(0);
  else {
    const nn = (i, pool) => Math.sqrt(Math.min(...pool.filter((p) => p !== i).map((p) => dist2(Z[i], Z[p]))));
    const todayD = mean(recent.map((i) => nn(i, earlier)));
    const sample = earlier.length > 200 ? earlier.filter((_, i) => i % Math.ceil(earlier.length / 200) === 0) : earlier;
    const typical = mean(sample.map((i) => nn(i, earlier))) || 1;
    pose.push(clamp01(1 - Math.exp(-todayD / typical / 2)));
  }
  return { pose, meta: null };
}

// ----------------------------------------------------------- openness
// The sculpture starts closed and opens with lived data: mostly how long it
// has lived (log-scaled against the planned show length), partly how much
// the room has moved.
export function openness(hoursLived, motion, showDays = 14) {
  const experience = Math.log1p(hoursLived) / Math.log1p(showDays * 24);
  const moved = motion / (showDays * 24 * 0.6);
  return clamp01(0.7 * Math.min(1, experience) + 0.3 * Math.min(1, moved));
}

// ------------------------------------------------------------- the run
// readings: [{unix, co2, t, …}] sorted or not; nowUnix: when the run happens;
// prev: the previous run record (for alignment); opts.showDays.
export function runPipeline(readings, nowUnix, prev = null, { showDays = 14, driving = "pca" } = {}) {
  const usable = readings.filter((r) => r.unix <= nowUnix);
  const { hours, channels, X } = hourly(usable);
  const closed = new Array(6).fill(0);
  const base = { unix: nowUnix, n_readings: usable.length, n_hours: hours.length, channels, driving };
  if (hours.length < MIN_HOURS || channels.length < 2) {
    const poses = Object.fromEntries(ALGORITHM_IDS.map((a) => [a, closed.slice()]));
    return { ...base, openness: 0, poses, sent: closed.slice(), meta: {}, note: "not enough data yet" };
  }
  const { Z, mu, sd } = standardize(X);
  const cut = nowUnix - WINDOW_H * 3600;
  let recent = hours.map((h, i) => (h >= cut ? i : -1)).filter((i) => i >= 0);
  if (!recent.length) recent = [hours.length - 1];

  const pca = pcaPose(Z, recent, prev?.meta?.pca);
  const cl = clustersPose(Z, X, recent, prev?.meta?.clusters, { mu, sd });
  const ex = extremesPose(Z, X, channels, recent);

  let motion = 0;
  for (let i = 1; i < Z.length; i++) motion += Math.sqrt(dist2(Z[i], Z[i - 1]) / Z[i].length);
  const open = openness(hours.length, motion, showDays);
  const poses = {
    pca: pca.pose.map((x) => +clamp01(x).toFixed(3)),
    clusters: cl.pose.map((x) => +clamp01(x).toFixed(3)),
    extremes: ex.pose.map((x) => +clamp01(x).toFixed(3)),
  };
  const drive = poses[driving] ? driving : "pca";
  return {
    ...base,
    driving: drive,
    openness: +open.toFixed(3),
    poses,
    sent: poses[drive].map((a) => +(a * open).toFixed(3)),
    meta: { pca: pca.meta, clusters: cl.meta, z: { mu: mu.map((x) => +x.toFixed(4)), sd: sd.map((x) => +x.toFixed(4)) } },
  };
}

// Which kind of hour each hour is, by the run's stored centroids (for the
// rings). Returns a Map hourUnix → 0|1|2.
export function labelHours(readings, run) {
  const out = new Map();
  const cents = run?.meta?.clusters?.centroids;
  const z = run?.meta?.z;
  if (!cents || !z || !run.channels) return out;
  const { hours, channels, X } = hourly(readings);
  if (channels.join() !== run.channels.join()) return out;
  hours.forEach((h, i) => {
    const zr = X[i].map((x, j) => (x - z.mu[j]) / z.sd[j]);
    const zc = cents.map((c) => c.map((x, j) => (x - z.mu[j]) / z.sd[j]));
    out.set(h, zc.reduce((bi, c, ci) => (dist2(zr, c) < dist2(zr, zc[bi]) ? ci : bi), 0));
  });
  return out;
}

// ----------------------------------------------------------- schedule
// Run times are local clock times ("06:00", "18:00"). Given the last run
// and now, the boundary that is due (the latest one passed), or null. A
// machine that was off for days runs once on return, on everything.
export function dueRun(lastRunUnix, nowUnix, runTimes = ["06:00", "18:00"], tzOffsetMin = null) {
  if (lastRunUnix === null || lastRunUnix === undefined) return null;
  const offset = (tzOffsetMin ?? -new Date(nowUnix * 1000).getTimezoneOffset()) * 60;
  const mins = runTimes.map((s) => { const [h, m] = s.split(":").map(Number); return h * 3600 + (m || 0) * 60; });
  let latest = null;
  const dayStart = (u) => Math.floor((u + offset) / 86400) * 86400 - offset;
  for (let d = dayStart(nowUnix); d >= dayStart(lastRunUnix) - 86400; d -= 86400) {
    for (const s of mins) {
      const b = d + s;
      if (b > lastRunUnix && b <= nowUnix && (latest === null || b > latest)) latest = b;
    }
    if (latest !== null) break;
  }
  return latest;
}

export function nextRun(afterUnix, runTimes = ["06:00", "18:00"], tzOffsetMin = null) {
  const offset = (tzOffsetMin ?? -new Date(afterUnix * 1000).getTimezoneOffset()) * 60;
  const mins = runTimes.map((s) => { const [h, m] = s.split(":").map(Number); return h * 3600 + (m || 0) * 60; });
  const day = Math.floor((afterUnix + offset) / 86400) * 86400 - offset;
  const cands = [];
  for (const dd of [0, 86400]) for (const s of mins) cands.push(day + dd + s);
  return cands.filter((b) => b > afterUnix).sort((a, b) => a - b)[0];
}
