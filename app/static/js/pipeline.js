// The 12-hour run: everything the sensors gathered so far → one 6D pose per
// algorithm, and the openness that lets the sculpture unfold as it lives.
// Pure functions, no DOM: tested in tests/js/pipeline.test.mjs.
//
// Same data, four readings of it (the multiplicity Miguel and Florian
// asked for — each algorithm makes its own shape):
//   som       where today lives on a self-organising map of the room's states
//   pca       the room's main directions: where today sits along the first
//             three, and how much today moves
//   clusters  kinds of hours (k-means, 3): today's share of each kind, and
//             how differently today is mixed from all time
//   extremes  how high today is for CO₂, temperature, humidity (percentile
//             in their own history), plus novelty (isolation forest)
// A pose (a shape) is 4 values in [0,1], one per string: how far string k is
// let out (0 = closed). The body gets pulls = 1 − openness × shape, so the
// sculpture starts closed and opens as data accumulates.

import { CHANNELS, CORE_CHANNELS, MOTORS, toPulls } from "./protocol.js";

export const ALGORITHMS = {
  som:      { label: "SOM", about: "A self-organising map lays every hour since the opening out on a map of the room's states, learning by itself with no examples. Where today lives on that map, how widely it wanders, how familiar or new it is. The map grows from the last run's, so it weathers slowly instead of starting over." },
  pca:      { label: "PCA", about: "Principal components: where today sits along the room's three main directions of change (strings 1–3), and how much it moves (string 4)." },
  clusters: { label: "k-means", about: "The room's hours fall into three kinds (quiet · in between · busy). How much of today is each kind (strings 1–3), and how differently today is mixed from all time (string 4)." },
  extremes: { label: "IForest", about: "How high today is for CO₂, temperature and humidity in their own history (strings 1–3), and how easily an isolation forest sets today's hours apart from all the others, sensors together (string 4)." },
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
  const moves = [];
  for (let k = 0; k < 3; k++) {
    const all = Z.map((r) => proj(r, comps[k]));
    const overall = std(all) || 1;
    const today = recent.map((i) => all[i]);
    moves.push(std(today) / overall);
  }
  pose.push(clamp01(mean(moves) / 1.5));
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
  if (Z.length < k) return { pose: new Array(MOTORS).fill(0), meta: null };
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
    pose: (() => {
      const today = share(recent), ever = share(all);
      return [...today, today.reduce((s, x, i) => s + Math.abs(x - ever[i]), 0) / 2];
    })(),
    meta: { centroids: order.map((ci) => centsUnits[ci].map((x) => +x.toFixed(3))) },
    labels,
  };
}

// ---------------------------------------------------------- extremes
function extremesPose(Z, X, channels, recent) {
  const pose = [];
  for (const c of CORE_CHANNELS) {
    const j = channels.indexOf(c);
    if (j < 0) { pose.push(0.5); continue; }
    const col = X.map((r) => r[j]);
    pose.push(percentile(col, mean(recent.map((i) => col[i]))));
  }
  // novelty: isolation forest over every hour, sensors together. Today's
  // hours' scores as percentiles among all hours: an ordinary day ≈ 0.5 →
  // 0, a day whose hours are the easiest to set apart → 1.
  if (Z.length - recent.length < 3) pose.push(0);
  else {
    const scores = isolationScores(Z);
    const p = mean(recent.map((i) => percentile(scores, scores[i])));
    pose.push(clamp01((p - 0.5) * 2));
  }
  return { pose, meta: null };
}

// Isolation forest (Liu, Ting & Zhou, ICDM 2008): random trees split the
// hours at random until each is alone; unusual hours are alone sooner.
// Returns each row's anomaly score s = 2^(−E[path length] / c(ψ)) (≈0.5
// ordinary, → 1 unusual). Seeded, so the same data gives the same scores.
const IF_TREES = 100, IF_SAMPLE = 256;
const cPath = (n) => (n <= 1 ? 0 : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n);
export function isolationScores(Z, { trees = IF_TREES, sample = IF_SAMPLE, seed = 13 } = {}) {
  const n = Z.length, d = Z[0]?.length || 0;
  if (n < 2 || !d) return Z.map(() => 0.5);
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const psi = Math.min(sample, n), limit = Math.ceil(Math.log2(psi));
  const grow = (idx, depth) => {
    if (depth >= limit || idx.length <= 1) return { size: idx.length };
    const j = Math.floor(rand() * d);
    let lo = Infinity, hi = -Infinity;
    for (const i of idx) { lo = Math.min(lo, Z[i][j]); hi = Math.max(hi, Z[i][j]); }
    if (hi - lo < 1e-12) return { size: idx.length };
    const split = lo + rand() * (hi - lo);
    return { j, split, left: grow(idx.filter((i) => Z[i][j] < split), depth + 1),
             right: grow(idx.filter((i) => Z[i][j] >= split), depth + 1) };
  };
  const path = (node, x, depth) => (node.size !== undefined
    ? depth + cPath(node.size)
    : path(x[node.j] < node.split ? node.left : node.right, x, depth + 1));
  const forest = [];
  for (let t = 0; t < trees; t++) {
    const all = Array.from({ length: n }, (_, i) => i);
    for (let i = 0; i < psi; i++) {                     // sample without replacement
      const k = i + Math.floor(rand() * (n - i));
      [all[i], all[k]] = [all[k], all[i]];
    }
    forest.push(grow(all.slice(0, psi), 0));
  }
  const c = cPath(psi) || 1;
  return Z.map((x) => 2 ** (-mean(forest.map((tree) => path(tree, x, 0))) / c));
}

// --------------------------------------------------------------- SOM
// A self-organising map (Kohonen): an 8×8 grid of prototype room-states,
// trained on every hour so far. Unsupervised: no examples, the map
// arranges itself so neighbouring cells hold similar hours. It starts from
// the previous run's map (in sensor units, re-standardised), so it reshapes
// slowly; the very first map is laid along the two main directions (PCA),
// so it is deterministic. Pose:
//   s1, s2  where today lives on the map (mean cell, column and row)
//   s3      how widely today wanders across the map
//   s4      how unfamiliar today is (fit error, against all hours)
export const SOM_SIZE = 8;

function somTrain(Z, init, { epochs, radius0, rate0 }) {
  const n = SOM_SIZE, W = init.map((w) => w.slice());
  const pos = W.map((_, k) => [k % n, Math.floor(k / n)]);
  const total = epochs * Z.length;
  let step = 0;
  for (let e = 0; e < epochs; e++) {
    for (let i = 0; i < Z.length; i++, step++) {
      const x = Z[(i * 7919 + e * 104729) % Z.length];   // a fixed, spread-out order
      const f = step / total;
      const radius = Math.max(0.6, radius0 * (1 - f));
      const rate = rate0 * (1 - f) + 0.01;
      let b = 0, bd = Infinity;
      for (let k = 0; k < W.length; k++) { const d = dist2(x, W[k]); if (d < bd) { bd = d; b = k; } }
      for (let k = 0; k < W.length; k++) {
        const g2 = (pos[k][0] - pos[b][0]) ** 2 + (pos[k][1] - pos[b][1]) ** 2;
        const h = Math.exp(-g2 / (2 * radius * radius));
        if (h < 0.01) continue;
        for (let j = 0; j < x.length; j++) W[k][j] += rate * h * (x[j] - W[k][j]);
      }
    }
  }
  return W;
}

function somInitPca(Z) {
  const d = Z[0].length;
  const C = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) / Z.length));
  const e = eigSym(C);
  const v1 = e[0].vector, v2 = (e[1] || e[0]).vector;
  const s1 = Math.sqrt(Math.max(1e-6, e[0].value)), s2 = Math.sqrt(Math.max(1e-6, (e[1] || e[0]).value));
  const n = SOM_SIZE, W = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const a = ((c / (n - 1)) * 2 - 1) * 2 * s1, b = ((r / (n - 1)) * 2 - 1) * 2 * s2;
    W.push(v1.map((x, j) => a * x + b * v2[j]));
  }
  return W;
}

function somPose(Z, recent, std0, prev) {
  const n = SOM_SIZE, d = Z[0].length;
  const prevW = prev?.weights;
  let W;
  if (prevW && prevW.length === n * n && prevW[0].length === d) {
    // last run's map, in today's standardisation: a gentle fine-tune
    const init = prevW.map((w) => w.map((x, j) => (x - std0.mu[j]) / std0.sd[j]));
    W = somTrain(Z, init, { epochs: 3, radius0: 1.5, rate0: 0.08 });
  } else {
    W = somTrain(Z, somInitPca(Z), { epochs: 8, radius0: n / 2, rate0: 0.4 });
  }
  const bmu = (x) => { let b = 0, bd = Infinity; for (let k = 0; k < W.length; k++) { const dd = dist2(x, W[k]); if (dd < bd) { bd = dd; b = k; } } return [b, Math.sqrt(bd)]; };
  const all = Z.map(bmu);
  const today = recent.map((i) => all[i]);
  const cols = today.map(([b]) => b % n), rows = today.map(([b]) => Math.floor(b / n));
  const spread = Math.sqrt(std(cols) ** 2 + std(rows) ** 2) / (n / 2);
  const errs = all.map(([, e]) => e);
  const pose = [
    mean(cols) / (n - 1),
    mean(rows) / (n - 1),
    clamp01(spread * 1.5),
    percentile(errs, mean(today.map(([, e]) => e))),
  ];
  return {
    pose,
    meta: { weights: W.map((w) => w.map((x, j) => +(x * std0.sd[j] + std0.mu[j]).toFixed(3))) },
  };
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
export function runPipeline(readings, nowUnix, prev = null, { showDays = 14, driving = "som" } = {}) {
  const usable = readings.filter((r) => r.unix <= nowUnix);
  const { hours, channels, X } = hourly(usable);
  const closed = new Array(MOTORS).fill(0);         // shape 0: every string in
  const base = { unix: nowUnix, n_readings: usable.length, n_hours: hours.length, channels, driving };
  if (hours.length < MIN_HOURS || channels.length < 2) {
    const poses = Object.fromEntries(ALGORITHM_IDS.map((a) => [a, closed.slice()]));
    return { ...base, openness: 0, poses, sent: toPulls(closed, 0), meta: {}, note: "not enough data yet" };
  }
  const { Z, mu, sd } = standardize(X);
  const cut = nowUnix - WINDOW_H * 3600;
  let recent = hours.map((h, i) => (h >= cut ? i : -1)).filter((i) => i >= 0);
  if (!recent.length) recent = [hours.length - 1];

  const pca = pcaPose(Z, recent, prev?.meta?.pca);
  const cl = clustersPose(Z, X, recent, prev?.meta?.clusters, { mu, sd });
  const ex = extremesPose(Z, X, channels, recent);
  const so = somPose(Z, recent, { mu, sd }, prev?.meta?.som);

  let motion = 0;
  for (let i = 1; i < Z.length; i++) motion += Math.sqrt(dist2(Z[i], Z[i - 1]) / Z[i].length);
  const open = openness(hours.length, motion, showDays);
  const poses = {
    pca: pca.pose.map((x) => +clamp01(x).toFixed(3)),
    clusters: cl.pose.map((x) => +clamp01(x).toFixed(3)),
    extremes: ex.pose.map((x) => +clamp01(x).toFixed(3)),
    som: so.pose.map((x) => +clamp01(x).toFixed(3)),
  };
  const drive = poses[driving] ? driving : "som";
  return {
    ...base,
    driving: drive,
    openness: +open.toFixed(3),
    poses,
    sent: toPulls(poses[drive], open),
    meta: { pca: pca.meta, clusters: cl.meta, som: so.meta, z: { mu: mu.map((x) => +x.toFixed(4)), sd: sd.map((x) => +x.toFixed(4)) } },
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

// ------------------------------------------------------------ sound
// What a run tells the sound engine (sc/weathering_sound.scd). Not the
// sensor values: the context — how open the show is, which kind of hour it
// is now, how today divides into the three kinds, how new today is.
// labels: Map hourUnix → kind, from labelHours(readings, run).
export function soundContext(run, labels) {
  const c = run?.poses?.clusters || [];
  let kind = 1;
  if (labels && run) {
    const h = Math.floor(run.unix / 3600) * 3600;
    for (let back = 0; back < 12; back++) {
      const k = labels.get(h - back * 3600);
      if (k !== undefined) { kind = k; break; }
    }
  }
  return {
    openness: run?.openness ?? 0,
    kind,
    quiet: c[0] ?? 0.33, between: c[1] ?? 0.34, busy: c[2] ?? 0.33,
    novelty: run?.poses?.extremes?.[3] ?? 0,
  };
}

// ------------------------------------------------------------ taught
// The data state a taught mapping learns from: the four readings of a run
// (16 numbers). Examples pair it with a shape shaped on the twin.
export const TAUGHT_INPUTS = ["som", "pca", "clusters", "extremes"];
export function dataState(run) {
  return TAUGHT_INPUTS.flatMap((id) => {
    const p = run?.poses?.[id] || [];
    return Array.from({ length: MOTORS }, (_, k) => (Number.isFinite(p[k]) ? p[k] : 0));
  });
}
