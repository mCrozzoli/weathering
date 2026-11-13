// The digital twin: Jessen's orthogonal icosahedron, with the jitterbug
// kinematics of Florian's own twin (12 vertices = cyclic permutations of
// (±(1−t), 0, ±(1+t)) on the unit sphere, 20 fixed faces, non-convex).
// As t → 1 the 12 vertices merge in 6 pairs into an octahedron (closed); at
// t = 1/3 it is Jessen's icosahedron (open). Here each pair has its own t,
// driven by its own servo: servo k opens pair k.

export const T_JESSEN = 1 / 3;
export const T_CLOSED = 0.97;

// vertex i -> [sign pattern of (b, a) placement]; b = 1−t, a = 1+t
const VERTS = [
  [ "b", 0, "a"], [ "a", "b", 0], [0, "a", "b"], ["-b", 0, "a"], ["-a", "b", 0], [ "a", "-b", 0],
  [0, "-a", "b"], ["-a", "-b", 0], [ "b", 0, "-a"], [0, "a", "-b"], ["-b", 0, "-a"], [0, "-a", "-b"],
];
// the 6 pairs that merge when the body closes (they differ only in the sign of b)
export const PAIRS = [[0, 3], [1, 5], [2, 9], [4, 7], [6, 11], [8, 10]];
const PAIR_OF = new Array(12);
PAIRS.forEach(([i, j], k) => { PAIR_OF[i] = k; PAIR_OF[j] = k; });

export const FACES = [[0,1,2],[3,4,2],[0,5,6],[3,7,6],[8,1,9],[10,4,9],[8,5,11],
  [10,7,11],[4,1,2],[4,1,9],[3,10,4],[3,10,7],[6,2,0],[6,2,3],
  [5,7,11],[5,7,6],[8,0,5],[8,0,1],[9,11,10],[9,11,8]];
export const SOUNDING = new Set([0, 1, 2, 3, 4, 5, 6, 7]);   // the 8 equilateral faces

const tOf = (a) => T_CLOSED + (T_JESSEN - T_CLOSED) * Math.min(1, Math.max(0, a));

// pose: 6 values in [0,1] (0 = closed). Returns 12 unit vectors.
export function vertices(pose) {
  return VERTS.map((spec, i) => {
    const t = tOf(pose[PAIR_OF[i]] ?? 0);
    const val = { a: 1 + t, "-a": -(1 + t), b: 1 - t, "-b": -(1 - t) };
    const p = spec.map((s) => (s === 0 ? 0 : val[s]));
    const n = Math.hypot(p[0], p[1], p[2]) || 1;
    return [p[0] / n, p[1] / n, p[2] / n];
  });
}

function rot([x, y, z], ay, ax) {
  const x1 = x * Math.cos(ay) + z * Math.sin(ay), z1 = -x * Math.sin(ay) + z * Math.cos(ay);
  const y1 = y * Math.cos(ax) - z1 * Math.sin(ax), z2 = y * Math.sin(ax) + z1 * Math.cos(ax);
  return [x1, y1, z2];
}
const LIGHT = (() => { const l = [0.42, 0.72, 0.55]; const n = Math.hypot(...l); return l.map((x) => x / n); })();
const mix = (a, b, k) => a.map((x, i) => x + (b[i] - x) * k);
const rgba = (c, al = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;

// Draw one twin. color: [r,g,b]; spin: radians; size: radius in px.
export function drawTwin(ctx, cx, cy, size, pose, { color = [150, 190, 210], spin = 0, tilt = 0.44, glow = true, faint = false } = {}) {
  const V = vertices(pose).map((p) => rot(p, spin, tilt));
  const open = pose.reduce((s, a) => s + a, 0) / pose.length;
  const S = size * (0.86 + 0.3 * open);
  if (glow) {
    const g = ctx.createRadialGradient(cx, cy, size * 0.1, cx, cy, size * (0.9 + open * 0.9));
    g.addColorStop(0, rgba(color, faint ? 0.05 : 0.14));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, size * (0.9 + open * 0.9), 0, 2 * Math.PI); ctx.fill();
  }
  const faces = FACES.map((f, i) => {
    const pts = f.map((k) => V[k]);
    const e1 = pts[1].map((x, j) => x - pts[0][j]);
    const e2 = pts[2].map((x, j) => x - pts[0][j]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(...n) || 1e-8;
    // two-sided: the concave faces keep their inward normals by design
    const lam = 0.5 + 0.65 * Math.abs((n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / nl);
    return { pts, lam, depth: (pts[0][2] + pts[1][2] + pts[2][2]) / 3, sounding: SOUNDING.has(i) };
  }).sort((a, b) => a.depth - b.depth);
  const neutral = [93, 106, 116];
  for (const f of faces) {
    const col = f.sounding ? color : mix(color, neutral, 0.28);
    ctx.beginPath();
    ctx.moveTo(cx + f.pts[0][0] * S, cy - f.pts[0][1] * S);
    ctx.lineTo(cx + f.pts[1][0] * S, cy - f.pts[1][1] * S);
    ctx.lineTo(cx + f.pts[2][0] * S, cy - f.pts[2][1] * S);
    ctx.closePath();
    ctx.fillStyle = rgba(col.map((x) => Math.min(255, x * f.lam)), faint ? 0.5 : f.sounding ? 0.94 : 0.86);
    ctx.strokeStyle = rgba(mix(col, [240, 246, 250], 0.14), faint ? 0.5 : 0.9);
    ctx.lineWidth = Math.max(0.6, size / 160);
    ctx.fill(); ctx.stroke();
  }
}
