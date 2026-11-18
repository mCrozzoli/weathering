// node --test tests/js/   (no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, formatPose, readingToCsv, csvToReading, formatReading, CSV_HEADER } from "../../app/static/js/protocol.js";
import { Room } from "../../app/static/js/room.js";
import { runPipeline, hourly, dueRun, nextRun, openness, eigSym, percentile, labelHours, soundContext, ALGORITHM_IDS } from "../../app/static/js/pipeline.js";
import { TRIS, PULLED, solve, ideal } from "../../app/static/js/twin.js";
import { toPulls } from "../../app/static/js/protocol.js";
import { FakeHub } from "../../app/static/js/fakehub.js";

const DAY = 86400;

function simulate(days, { seed = 1, start = 1_790_000_000, interval = 300, missing = [] } = {}) {
  const room = new Room({ seed });
  const out = [];
  for (let u = start; u < start + days * DAY; u += interval) {
    const v = room.read(u);
    const r = { unix: u, seq: out.length, sim: [], old: false, ...v };
    for (const m of missing) r[m] = null;
    out.push(r);
  }
  return out;
}

// ----------------------------------------------------------- protocol
test("reading line round-trips through parse, csv and format", () => {
  const ev = parseLine("R 1790000000 12 co2=812 t=21.40 rh=44.00 lux=410 db=-51 sim=lux,db old");
  assert.equal(ev.type, "reading");
  const r = ev.reading;
  assert.deepEqual([r.unix, r.seq, r.co2, r.t, r.lux, r.db], [1790000000, 12, 812, 21.4, 410, -51]);
  assert.deepEqual(r.sim, ["lux", "db"]);
  assert.equal(r.old, true);
  const back = csvToReading(readingToCsv(r));
  assert.deepEqual(back, r);
  assert.equal(parseLine(formatReading(r)).reading.co2, 812);
  assert.equal(CSV_HEADER.split(",").length, readingToCsv(r).split(",").length);
});

test("missing channels parse as null", () => {
  const r = parseLine("R 100 1 co2=500 t=20").reading;
  assert.equal(r.lux, null);
  assert.equal(r.rh, null);
});

test("other hub lines", () => {
  assert.deepEqual(parseLine("ACK body 7"), { type: "ack", role: "body", seq: 7 });
  assert.equal(parseLine("NODE sensor AA:BB fw 0.1.0 rssi -50").role, "sensor");
  const body = parseLine("BODY 0.1 0.2 0.3 0.4 moving=1 homed=0 found=7");
  assert.deepEqual([body.pose, body.moving, body.homed, body.found], [[0.1, 0.2, 0.3, 0.4], true, false, 7]);
  assert.equal(parseLine("BODY 0.1 0.2 0.3").type, "bad");
  assert.equal(parseLine("FW weathering_body 0.1.0 mac AA:BB group 1").role, "body");
  assert.equal(parseLine("INFO sensor fw 0.1.0 mac AA group 1 interval=300 sensors=co2,t").info.interval, "300");
  assert.equal(parseLine("R garbage").type, "bad");
});

test("pose lines clamp and validate", () => {
  assert.equal(formatPose(3, [0, 0.5, 2, 0.1234], 60), "POSE 3 0.000 0.500 1.000 0.123 60");
  assert.throws(() => formatPose(3, [0, 0, 0, 0, 0, 0], 60));
  // a shape (how far each string is let out) becomes pulls (1 = closed)
  assert.deepEqual(toPulls([0, 0.5, 1, 1], 0), [1, 1, 1, 1]);
  assert.deepEqual(toPulls([0, 0.5, 1, 1], 0.5), [1, 0.75, 0.5, 0.5]);
  assert.throws(() => formatPose(1, [0, 1]));
});

// --------------------------------------------------------------- room
test("the simulated room has a day and a night", () => {
  const rs = simulate(2);
  const { hours, X, channels } = hourly(rs);
  assert.deepEqual(channels, ["co2", "t", "rh", "lux", "db"]);
  const lux = X.map((r) => r[3]);
  assert.ok(Math.max(...lux) > 300 && Math.min(...lux) < 20, "light swings day/night");
  const co2 = X.map((r) => r[0]);
  assert.ok(Math.max(...co2) > 600 && Math.min(...co2) < 480, "visitors raise CO2");
  assert.ok(hours.length === 48 || hours.length === 49, "two days of hours (49 if it starts mid-hour)");
});

test("the room is deterministic per seed", () => {
  assert.deepEqual(simulate(0.2, { seed: 4 }), simulate(0.2, { seed: 4 }));
  assert.notDeepEqual(simulate(0.2, { seed: 4 }).map((r) => r.co2), simulate(0.2, { seed: 5 }).map((r) => r.co2));
});

// ----------------------------------------------------------- pipeline
test("eigSym finds the eigen-decomposition", () => {
  const e = eigSym([[2, 1], [1, 2]]);
  assert.ok(Math.abs(e[0].value - 3) < 1e-9 && Math.abs(e[1].value - 1) < 1e-9);
  assert.equal(percentile([1, 2, 3, 4], 2.5), 0.5);
});

test("too little data keeps the sculpture closed", () => {
  const rs = simulate(0.1);
  const run = runPipeline(rs, rs.at(-1).unix);
  assert.equal(run.openness, 0);
  assert.deepEqual(run.sent, [1, 1, 1, 1]);      // pulls: every string in, closed
});

test("a run gives four values per algorithm (one per string), all in [0,1]", () => {
  const rs = simulate(3);
  const run = runPipeline(rs, rs.at(-1).unix);
  for (const a of ALGORITHM_IDS) {
    assert.equal(run.poses[a].length, 4, a);
    for (const x of run.poses[a]) assert.ok(x >= 0 && x <= 1, `${a} ${x}`);
  }
  assert.equal(run.sent.length, 4);
  assert.deepEqual(run.sent, toPulls(run.poses[run.driving], run.openness));
  assert.ok(run.openness > 0 && run.openness < 1);
  // the shares of the three kinds of hours add up to 1
  const c = run.poses.clusters;
  assert.ok(Math.abs(c[0] + c[1] + c[2] - 1) < 0.01);
  assert.ok(c[3] >= 0 && c[3] <= 1);              // how differently today is mixed
});

test("algorithms disagree: same data, different shapes", () => {
  const rs = simulate(4);
  const run = runPipeline(rs, rs.at(-1).unix);
  const d = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0);
  assert.ok(d(run.poses.pca, run.poses.clusters) > 0.3);
  assert.ok(d(run.poses.pca, run.poses.extremes) > 0.3);
});

test("openness grows as the piece lives", () => {
  const short = runPipeline(simulate(1), 1_790_000_000 + DAY);
  const long = runPipeline(simulate(8), 1_790_000_000 + 8 * DAY);
  assert.ok(long.openness > short.openness + 0.15, `${short.openness} → ${long.openness}`);
  assert.equal(openness(0, 0), 0);
  assert.ok(openness(14 * 24, 1e9) <= 1);
});

test("runs are aligned: kinds of hours keep their identity", () => {
  const rs = simulate(6);
  const t1 = 1_790_000_000 + 5 * DAY, t2 = t1 + DAY / 2;
  const r1 = runPipeline(rs, t1);
  const r2 = runPipeline(rs, t2, r1);
  // each kind's centroid moves little between consecutive runs
  for (let k = 0; k < 3; k++) {
    const a = r1.meta.clusters.centroids[k], b = r2.meta.clusters.centroids[k];
    assert.ok(Math.abs(a[0] - b[0]) < 120, `kind ${k} CO2 centroid jumped ${a[0]} → ${b[0]}`);
  }
  // PCA directions keep their sign
  const dot = r1.meta.pca.loadings[0].reduce((s, x, i) => s + x * r2.meta.pca.loadings[0][i], 0);
  assert.ok(dot > 0.8);
  // hours are labelled by the run's kinds
  const labels = labelHours(rs, r2);
  assert.ok(labels.size > 100);
  assert.equal(new Set(labels.values()).size, 3);
});

test("a missing sensor still runs, with fewer channels", () => {
  const rs = simulate(3, { missing: ["lux", "db"] });
  const run = runPipeline(rs, rs.at(-1).unix);
  assert.deepEqual(run.channels, ["co2", "t", "rh"]);
  const full = runPipeline(simulate(3), rs.at(-1).unix);
  assert.deepEqual(full.channels, ["co2", "t", "rh", "lux", "db"]);   // optional channels join in
  assert.equal(full.poses.extremes.length, 4);
});

test("gaps (computer off) are just fewer hours", () => {
  const rs = simulate(4).filter((r) => r.unix % DAY > DAY / 3);   // a third of every day lost
  const run = runPipeline(rs, rs.at(-1).unix);
  assert.ok(run.n_hours < 96 && run.n_hours > 50);
  assert.ok(run.openness > 0);
});

// ------------------------------------------------------------ schedule
test("due runs at the local run times, catching up once after a gap", () => {
  const tz = 0;   // UTC for the test
  const day0 = 1_790_000_000 - (1_790_000_000 % DAY);
  const six = day0 + 6 * 3600, eighteen = day0 + 18 * 3600;
  assert.equal(dueRun(day0, six - 1, ["06:00", "18:00"], tz), null);
  assert.equal(dueRun(day0, six, ["06:00", "18:00"], tz), six);
  assert.equal(dueRun(six, eighteen + 10, ["06:00", "18:00"], tz), eighteen);
  // three days off: one run, at the latest boundary
  assert.equal(dueRun(six, six + 3 * DAY + 3600, ["06:00", "18:00"], tz), six + 3 * DAY);
  assert.equal(nextRun(six, ["06:00", "18:00"], tz), eighteen);
  assert.equal(nextRun(eighteen, ["06:00", "18:00"], tz), six + DAY);
});

// ---------------------------------------------------------------- twin
test("the twin is Florian's jitterbug: 8 rigid triangles, 4 of them pulled", () => {
  assert.equal(TRIS.length, 8);
  assert.equal(PULLED.filter(Boolean).length, 4);
  assert.equal(new Set(PULLED.flat()).size, 12);                  // the pulled ones share no corner
  const r = (X) => Math.hypot(...X[0]);
  assert.ok(Math.abs(r(ideal(0)) - 2) < 1e-9, "pull 0: cuboctahedron");
  assert.ok(Math.abs(r(ideal(1)) - Math.SQRT2) < 1e-9, "pull 1: octahedron");
  const edgeErr = (X) => Math.max(...TRIS.flatMap((f) => [0, 1, 2].map((e) => {
    const a = X[f[e]], b = X[f[(e + 1) % 3]];
    return Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - 2);
  })));
  assert.ok(edgeErr(solve([0.5, 0.5, 0.5, 0.5])) < 1e-9);
  // uneven pulls bend it off the ideal path, triangles still rigid
  const X = solve([1, 0, 0.3, 0.8]);
  assert.ok(edgeErr(X) < 0.02, `triangles stretched: ${edgeErr(X)}`);
  const centre = (f) => Math.hypot(...[0, 1, 2].map((d) => (X[f[0]][d] + X[f[1]][d] + X[f[2]][d]) / 3));
  assert.ok(centre(PULLED[0]) < centre(PULLED[1]), "the pulled-in string's triangle is closer to the hub");
});

// ------------------------------------------------------------- fake hub
test("the fake hub speaks the protocol and runs fast", async () => {
  const lines = [];
  const hub = new FakeHub({ onLine: (l) => lines.push(l), startUnix: 1_790_000_000, speed: 1 });
  hub.write("PING");
  hub.skip(DAY);
  const readings = lines.map(parseLine).filter((e) => e.type === "reading");
  assert.equal(readings.length, 289);            // every 300 s for a day, both ends
  // the demo sensor box has the sculpture's SCD30 only: CO₂, temperature, humidity
  assert.ok(readings.every((e) => e.reading.sim.join() === "co2,t,rh" && e.reading.lux === null));
  assert.equal(lines[0], "PONG");
  hub.write("POSE 4 0.1 0.2 0.3 0.4 0");
  assert.ok(lines.includes("OK POSE 4"));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(lines.includes("ACK body 4"));
  hub.skip(10);
  const body = lines.map(parseLine).filter((e) => e.type === "body").at(-1);
  assert.deepEqual(body.pose, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(body.homed, true);
  hub.write("CFG sensor interval=600");
  assert.equal(hub.interval, 600);
  assert.ok(lines.at(-1).startsWith("OK CFG"));
  hub.write("NOPE");
  assert.ok(lines.at(-1).startsWith("ERR"));
});

// ---------------------------------------------------------------- sound
test("each run carries a sound context, not sensor values", () => {
  const rs = simulate(4);
  const run = runPipeline(rs, rs.at(-1).unix);
  const ctx = soundContext(run, labelHours(rs, run));
  assert.deepEqual(Object.keys(ctx).sort(), ["between", "busy", "kind", "novelty", "openness", "quiet"]);
  assert.ok([0, 1, 2].includes(ctx.kind));
  assert.ok(Math.abs(ctx.quiet + ctx.between + ctx.busy - 1) < 0.01);
  assert.equal(ctx.openness, run.openness);
  assert.ok(ctx.novelty >= 0 && ctx.novelty <= 1);
  const empty = soundContext(null, null);
  assert.equal(empty.openness, 0);
});

// ------------------------------------------------------- SOM + taught
import { MLP, trainTaught } from "../../app/static/js/mlp.js";
import { dataState, ALGORITHMS } from "../../app/static/js/pipeline.js";

test("the room map (SOM) is the default reading and stays in [0,1]", () => {
  const rs = simulate(3);
  const run = runPipeline(rs, rs.at(-1).unix);
  assert.equal(run.driving, "som");
  assert.equal(Object.keys(ALGORITHMS)[0], "som");
  assert.equal(run.poses.som.length, 4);
  for (const x of run.poses.som) assert.ok(x >= 0 && x <= 1);
  assert.equal(run.meta.som.weights.length, 64);
  assert.deepEqual(runPipeline(rs, rs.at(-1).unix).poses.som, run.poses.som, "deterministic");
});

test("the room map weathers: it grows from the last run's map", () => {
  const rs = simulate(7);
  const t1 = 1_790_000_000 + 6 * DAY, t2 = t1 + 3600;
  const r1 = runPipeline(rs, t1);
  const warm = runPipeline(rs, t2, r1);
  // warm start keeps the map: its prototypes stay close to the last run's
  const shift = warm.meta.som.weights.reduce((s, w, k) => s + Math.abs(w[0] - r1.meta.som.weights[k][0]), 0) / 64;
  assert.ok(shift < 60, `prototypes jumped (mean CO2 shift ${shift.toFixed(1)} ppm)`);
  // an hour later, the room's place on the map has barely moved
  const d = warm.poses.som.slice(0, 2).map((x, i) => Math.abs(x - r1.poses.som[i]));
  assert.ok(Math.max(...d) < 0.35, `today's place on the map jumped: ${d}`);
});

test("a taught mapping reproduces its examples and fills in between", () => {
  const rs = simulate(5);
  let prev = null; const runs = [];
  for (let k = 2; k <= 5; k++) { prev = runPipeline(rs, 1_790_000_000 + k * DAY, prev); runs.push(prev); }
  const shapes = [[0.1, 0.1, 0.1, 0.1], [0.9, 0.8, 0.9, 0.8], [0.2, 0.9, 0.2, 0.9]];
  const examples = shapes.map((output, i) => ({ input: dataState(runs[i]), output }));
  const t = trainTaught(examples);
  assert.ok(t.err < 0.005, `didn't learn its examples: ${t.err}`);
  examples.forEach((e) => {
    const y = t.net.predict(e.input);
    y.forEach((v, k) => assert.ok(Math.abs(v - e.output[k]) < 0.12, `example off by ${Math.abs(v - e.output[k])}`));
  });
  const untaught = t.net.predict(dataState(runs[3]));
  assert.equal(untaught.length, 4);
  assert.equal(dataState(runs[0]).length, 16);
  assert.equal(trainTaught([{ input: new Array(24).fill(0), output: new Array(6).fill(0) }, { input: new Array(24).fill(1), output: new Array(6).fill(1) }]), null, "six-servo shapes are skipped");
  for (const v of untaught) assert.ok(v >= 0 && v <= 1);
  assert.equal(trainTaught([examples[0]]), null, "one example isn't a mapping");
  assert.deepEqual(trainTaught(examples).net.predict(examples[0].input), t.net.predict(examples[0].input), "deterministic");
});

// ------------------------------------------------------ isolation forest
import { isolationScores } from "../../app/static/js/pipeline.js";
test("isolation forest finds the odd combination, not just the extreme value", () => {
  // two sensors that always move together; one hour breaks the pattern while
  // each value alone is ordinary
  const Z = [];
  for (let i = 0; i < 400; i++) { const x = Math.sin(i * 0.37) * 1.5; Z.push([x, x + Math.cos(i * 1.7) * 0.05]); }
  Z.push([1.2, -1.2]);
  const s = isolationScores(Z);
  const odd = s.at(-1);
  assert.ok(odd > 0.6, `odd hour scores high (${odd.toFixed(3)})`);
  assert.ok(s.filter((x) => x >= odd).length <= 3, "and is among the very top");
  assert.deepEqual(isolationScores(Z), s, "deterministic");
  const t0 = Date.now(); isolationScores(Array.from({ length: 24 * 120 }, (_, i) => [Math.sin(i), Math.cos(i * 0.3), i % 7, 0, 1]));
  assert.ok(Date.now() - t0 < 2000, "four months of hours in under 2 s");
});
