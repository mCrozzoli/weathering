// A small multilayer perceptron for taught mappings: learning by example,
// as in Rebecca Fiebrink's Wekinator. A few pairs (a run's data state → a
// shape made on the twin) are enough; it then gives a shape for every data
// state, taught or not. Deterministic: same examples, same network.
//
//   inputs (16: the four readings) → 8 tanh units → 4 sigmoid outputs (strings)

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sig = (x) => 1 / (1 + Math.exp(-x));

export class MLP {
  constructor(nIn, nHidden = 8, nOut = 4, seed = 11) {
    const r = rng(seed);
    const init = (fanIn) => () => (r() * 2 - 1) * Math.sqrt(1 / fanIn);
    this.nIn = nIn; this.nH = nHidden; this.nOut = nOut;
    this.W1 = Array.from({ length: nHidden }, () => Array.from({ length: nIn }, init(nIn)));
    this.b1 = new Array(nHidden).fill(0);
    this.W2 = Array.from({ length: nOut }, () => Array.from({ length: nHidden }, init(nHidden)));
    this.b2 = new Array(nOut).fill(0);
  }

  forward(x) {
    const h = this.W1.map((w, i) => Math.tanh(w.reduce((s, wj, j) => s + wj * x[j], this.b1[i])));
    const y = this.W2.map((w, k) => sig(w.reduce((s, wj, j) => s + wj * h[j], this.b2[k])));
    return { h, y };
  }

  predict(x) { return this.forward(x).y; }

  // Full-batch Adam on squared error. Returns the final mean error.
  train(examples, { iterations = 1500, rate = 0.03, l2 = 1e-4 } = {}) {
    const params = [this.W1, [this.b1], this.W2, [this.b2]];
    const m = params.map((p) => p.map((row) => row.map(() => 0)));
    const v = params.map((p) => p.map((row) => row.map(() => 0)));
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    let err = 0;
    for (let it = 1; it <= iterations; it++) {
      const g = params.map((p) => p.map((row) => row.map(() => 0)));
      err = 0;
      for (const { input, output } of examples) {
        const { h, y } = this.forward(input);
        const dy = y.map((yk, k) => (yk - output[k]) * yk * (1 - yk));     // through the sigmoid
        err += y.reduce((s, yk, k) => s + (yk - output[k]) ** 2, 0) / y.length;
        for (let k = 0; k < this.nOut; k++) {
          for (let j = 0; j < this.nH; j++) g[2][k][j] += dy[k] * h[j];
          g[3][0][k] += dy[k];
        }
        for (let j = 0; j < this.nH; j++) {
          let dh = 0;
          for (let k = 0; k < this.nOut; k++) dh += dy[k] * this.W2[k][j];
          dh *= 1 - h[j] * h[j];                                           // through the tanh
          for (let i = 0; i < this.nIn; i++) g[0][j][i] += dh * input[i];
          g[1][0][j] += dh;
        }
      }
      err /= examples.length || 1;
      const n = examples.length || 1;
      params.forEach((p, pi) => p.forEach((row, ri) => row.forEach((w, ci) => {
        const grad = g[pi][ri][ci] / n + (pi % 2 === 0 ? l2 * w : 0);
        m[pi][ri][ci] = b1 * m[pi][ri][ci] + (1 - b1) * grad;
        v[pi][ri][ci] = b2 * v[pi][ri][ci] + (1 - b2) * grad * grad;
        const mh = m[pi][ri][ci] / (1 - b1 ** it), vh = v[pi][ri][ci] / (1 - b2 ** it);
        row[ci] = w - rate * mh / (Math.sqrt(vh) + eps);
      })));
    }
    return err;
  }
}

// Train on a show's examples ({input, output}); null when there are too few.
export const MIN_EXAMPLES = 2;
export function trainTaught(examples) {
  // shapes taught before the four-string sculpture (6 servos) don't fit: skip them
  examples = (examples || []).filter((e) => e?.output?.length === 4 && e?.input?.length === 16);
  if (examples.length < MIN_EXAMPLES) return null;
  const net = new MLP(examples[0].input.length);
  const err = net.train(examples);
  return { net, err };
}
