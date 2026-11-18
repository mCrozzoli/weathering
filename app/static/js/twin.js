// The digital twin: Florian's NPTX. Buckminster Fuller's jitterbug — eight
// rigid triangles hinged at their corners — with four motors on the faces
// of a small tetrahedron at the centre, each winding a string that pulls one
// triangle in. Pull 0: strings slack, the structure open (cuboctahedron);
// pull 0.5: icosahedron; pull 1: closed (octahedron). Equal pulls follow the
// ideal jitterbug; uneven pulls bend it off that path, which the solver
// finds (rigid triangles, strings that only pull, corners that can't pass
// through each other). Geometry and solver after Florian's "Possibility
// Space" page (index.html of his tetra_sculpture_code), without three.js.

const PHI = (1 + Math.sqrt(5)) / 2;
export const MOTORS = 4;
// motor directions, as in Florian's documentation: M1 red, M2 orange, M3 green, M4 blue
export const DIRS = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((d) => d.map((x) => x / Math.sqrt(3)));
export const MOTOR_COLORS = [[184, 74, 74], [201, 133, 43], [60, 141, 84], [74, 111, 165]];

// ---- small vector maths
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centroid = (P, f) => mul(add(add(P[f[0]], P[f[1]]), P[f[2]]), 1 / 3);

// Jitterbug corners for the ratio r = u/v, triangle edges of length 2.
// index order: yz-plane 0..3, xz-plane 4..7, xy-plane 8..11
function verts(r) {
  const v = 2 / Math.sqrt(2 * r * r + 2 - 2 * r), u = r * v;
  return [[0, u, v], [0, -u, v], [0, -u, -v], [0, u, -v], [v, 0, u], [v, 0, -u], [-v, 0, -u], [-v, 0, u],
          [u, v, 0], [-u, v, 0], [-u, -v, 0], [u, -v, 0]];
}
// pull 0..1 → ratio: 0 cuboctahedron (r = 1), 0.5 icosahedron (1/φ), 1 octahedron (0)
const pullToRatio = (t) => (t <= 0.5 ? 1 + (1 / PHI - 1) * (t / 0.5) : (1 / PHI) * (1 - (t - 0.5) / 0.5));
export const ideal = (t) => verts(pullToRatio(Math.min(1, Math.max(0, t))));

// ---- topology, from the icosahedron state: the 8 triangles touch all three planes
const ICO = ideal(0.5);
const plane = (i) => Math.floor(i / 4);
export const TRIS = [];
for (let a = 0; a < 12; a++) for (let b = a + 1; b < 12; b++) for (let c = b + 1; c < 12; c++) {
  const ok = [[a, b], [b, c], [a, c]].every(([i, j]) => Math.abs(len(sub(ICO[i], ICO[j])) - 2) < 1e-6);
  if (ok && new Set([plane(a), plane(b), plane(c)]).size === 3) TRIS.push([a, b, c]);
}
export const PULLED = DIRS.map((d) => TRIS.find((f) => dot(centroid(ICO, f), d) / len(centroid(ICO, f)) > 0.99));
const EDGES = [];
TRIS.forEach((f) => { for (let e = 0; e < 3; e++) EDGES.push([f[e], f[(e + 1) % 3]]); });
const joined = new Set(EDGES.map(([a, b]) => Math.min(a, b) + "-" + Math.max(a, b)));
const OCTA = ideal(1);
const GAP_PAIRS = [];
for (let a = 0; a < 12; a++) for (let b = a + 1; b < 12; b++) {
  if (!joined.has(a + "-" + b) && len(sub(OCTA[a], OCTA[b])) > 1e-3) GAP_PAIRS.push([a, b]);
}
const GAP = 2, R_MIN = Math.SQRT2, R_MAX = 2;
const triDist = (t) => len(centroid(ideal(t), PULLED[0]));

// The shape for four pulls (1 = closed). Equal pulls: the ideal jitterbug.
// Uneven: relax from the ideal shape at the mean pull until the triangles
// are rigid again and each string is no longer than its pull allows.
const cache = new Map();
export function solve(pulls) {
  const p = [0, 1, 2, 3].map((i) => Math.min(1, Math.max(0, +pulls[i] || 0)));
  const key = p.map((x) => x.toFixed(3)).join(",");
  if (cache.has(key)) return cache.get(key);
  const mean = (p[0] + p[1] + p[2] + p[3]) / 4;
  let X = ideal(mean);
  if (Math.max(...p) - Math.min(...p) > 0.002) {
    X = X.map((v) => v.slice());
    const L = p.map(triDist);
    const edges = () => EDGES.forEach(([a, b]) => {
      const d = sub(X[b], X[a]); const l = len(d) || 1e-6;
      const k = ((l - 2) / l) * 0.5;
      X[a] = add(X[a], mul(d, k)); X[b] = sub(X[b], mul(d, k));
    });
    for (let it = 0; it < 200; it++) {
      X = X.map((v) => mul(v, 1.004));                                   // tendency to open
      PULLED.forEach((f, i) => {                                         // strings: pull only
        const c = centroid(X, f), l = len(c) || 1e-6;
        if (l > L[i]) { const m = mul(c, (L[i] - l) / l); f.forEach((j) => { X[j] = add(X[j], m); }); }
      });
      GAP_PAIRS.forEach(([a, b]) => {                                    // no passing through
        const d = sub(X[b], X[a]); const l = len(d) || 1e-6;
        if (l < GAP) { const k = ((l - GAP) / l) * 0.5; X[a] = add(X[a], mul(d, k)); X[b] = sub(X[b], mul(d, k)); }
      });
      X = X.map((v) => { const r = len(v); return r < R_MIN ? mul(v, R_MIN / r) : r > R_MAX ? mul(v, R_MAX / r) : v; });
      edges(); edges();
    }
    for (let k = 0; k < 16; k++) edges();
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, X);
  return X;
}

// ---- drawing
function rot([x, y, z], ay, ax) {
  const x1 = x * Math.cos(ay) + z * Math.sin(ay), z1 = -x * Math.sin(ay) + z * Math.cos(ay);
  const y1 = y * Math.cos(ax) - z1 * Math.sin(ax), z2 = y * Math.sin(ax) + z1 * Math.cos(ax);
  return [x1, y1, z2];
}
const LIGHT = (() => { const l = [0.42, 0.72, 0.55]; const n = Math.hypot(...l); return l.map((x) => x / n); })();
const mix = (a, b, k) => a.map((x, i) => x + (b[i] - x) * k);
const rgba = (c, al = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;
const HUB_R = 0.42;                                       // the central tetrahedron (schematic size)

// Draw one twin. pulls: 4 values, 1 = closed. color: [r,g,b]; size: radius in px.
export function drawTwin(ctx, cx, cy, size, pulls, { color = [150, 190, 210], spin = 0, tilt = 0.44, glow = true, faint = false, strings = true } = {}) {
  const X = solve(pulls).map((p) => rot(p, spin, tilt));
  const open = 1 - pulls.reduce((s, a) => s + a, 0) / pulls.length;
  const S = size * 0.6;
  const P = (q) => [cx + q[0] * S, cy - q[1] * S];
  if (glow) {
    const g = ctx.createRadialGradient(cx, cy, size * 0.1, cx, cy, size * (0.9 + open * 0.9));
    g.addColorStop(0, rgba(color, faint ? 0.05 : 0.14));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, size * (0.9 + open * 0.9), 0, 2 * Math.PI); ctx.fill();
  }
  const items = [];
  TRIS.forEach((f) => {
    const pts = f.map((k) => X[k]);
    const n = (() => { const e1 = sub(pts[1], pts[0]), e2 = sub(pts[2], pts[0]); return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; })();
    const lam = 0.5 + 0.65 * Math.abs(dot(n, LIGHT) / (len(n) || 1e-8));
    const m = PULLED.indexOf(f);
    items.push({ kind: "tri", pts, lam, m, depth: (pts[0][2] + pts[1][2] + pts[2][2]) / 3 });
  });
  if (strings) {
    const hub = DIRS.map((d) => rot(mul(d, -HUB_R), spin, tilt));          // hub corners
    DIRS.forEach((d, i) => {
      const from = rot(mul(d, HUB_R / 3), spin, tilt);                   // the motor on its face
      const to = centroid(X, PULLED[i]);
      items.push({ kind: "string", from, to, i, w: 0.6 + 1.6 * (pulls[i] || 0), depth: (from[2] + to[2]) / 2 });
    });
    [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]].forEach((f) => {
      items.push({ kind: "hub", pts: f.map((k) => hub[k]), depth: (hub[f[0]][2] + hub[f[1]][2] + hub[f[2]][2]) / 3 });
    });
  }
  items.sort((a, b) => a.depth - b.depth);
  const neutral = [93, 106, 116];
  for (const it of items) {
    if (it.kind === "string") {
      const a = P(it.from), b = P(it.to);
      ctx.strokeStyle = rgba(mix(MOTOR_COLORS[it.i], [235, 240, 244], 0.25), faint ? 0.45 : 0.9);
      ctx.lineWidth = Math.max(0.6, (size / 120) * it.w);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      continue;
    }
    const [a, b, c] = it.pts.map(P);
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.closePath();
    if (it.kind === "hub") {
      ctx.fillStyle = rgba([120, 132, 140], faint ? 0.15 : 0.3);
      ctx.strokeStyle = rgba([200, 210, 216], faint ? 0.3 : 0.6);
      ctx.lineWidth = Math.max(0.5, size / 220);
      ctx.fill(); ctx.stroke();
      continue;
    }
    const base = it.m >= 0 ? mix(color, MOTOR_COLORS[it.m], 0.35) : mix(color, neutral, 0.35);
    ctx.fillStyle = rgba(base.map((x) => Math.min(255, x * it.lam)), faint ? 0.45 : it.m >= 0 ? 0.9 : 0.62);
    ctx.strokeStyle = rgba(mix(base, [240, 246, 250], 0.2), faint ? 0.5 : 0.95);
    ctx.lineWidth = Math.max(0.6, size / 140);
    ctx.fill(); ctx.stroke();
  }
}
