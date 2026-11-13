// node --test tests/js/   (no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, formatPose, readingToCsv, csvToReading, formatReading, CSV_HEADER } from "../../app/static/js/protocol.js";
import { Room } from "../../app/static/js/room.js";
import { runPipeline, hourly, dueRun, nextRun, openness, eigSym, percentile, labelHours, ALGORITHM_IDS } from "../../app/static/js/pipeline.js";
import { vertices, PAIRS, FACES, T_JESSEN } from "../../app/static/js/twin.js";
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
  assert.equal(parseLine("BODY 0.1 0.2 0.3 0.4 0.5 0.6 moving=1").moving, true);
  assert.equal(parseLine("FW weathering_body 0.1.0 mac AA:BB group 1").role, "body");
  assert.equal(parseLine("INFO sensor fw 0.1.0 mac AA group 1 interval=300 sensors=co2,t").info.interval, "300");
  assert.equal(parseLine("R garbage").type, "bad");
});

test("pose lines clamp and validate", () => {
  assert.equal(formatPose(3, [0, 0.5, 1, 2, -1, 0.1234], 60), "POSE 3 0.000 0.500 1.000 1.000 0.000 0.123 60");
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
  assert.deepEqual(run.sent, [0, 0, 0, 0, 0, 0]);
});

test("a run gives a 6D pose per algorithm, all in [0,1]", () => {
  const rs = simulate(3);
  const run = runPipeline(rs, rs.at(-1).unix);
  for (const a of ALGORITHM_IDS) {
    assert.equal(run.poses[a].length, 6, a);
    for (const x of run.poses[a]) assert.ok(x >= 0 && x <= 1, `${a} ${x}`);
  }
  assert.equal(run.sent.length, 6);
  assert.ok(run.openness > 0 && run.openness < 1);
  // the shares of the three kinds of hours add up to 1
  const c = run.poses.clusters;
  assert.ok(Math.abs(c[0] + c[1] + c[2] - 1) < 0.01);
  assert.ok(Math.abs(c[3] + c[4] + c[5] - 1) < 0.01);
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
  assert.equal(run.poses.extremes[3], 0.5);     // lux: no sensor → middle
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
test("closed merges the six vertex pairs; open is Jessen's icosahedron", () => {
  const closed = vertices([0, 0, 0, 0, 0, 0]);
  for (const [i, j] of PAIRS) {
    const d = Math.hypot(...closed[i].map((x, k) => x - closed[j][k]));
    assert.ok(d < 0.05, `pair ${i},${j} should nearly merge, distance ${d}`);
  }
  const open = vertices([1, 1, 1, 1, 1, 1]);
  const ref = [1 - T_JESSEN, 0, 1 + T_JESSEN];
  const n = Math.hypot(...ref);
  assert.ok(Math.abs(open[0][0] - ref[0] / n) < 1e-9 && Math.abs(open[0][2] - ref[2] / n) < 1e-9);
  // servo 2 moves only pair 2
  const one = vertices([0, 0, 1, 0, 0, 0]);
  for (let v = 0; v < 12; v++) {
    const moved = Math.hypot(...one[v].map((x, k) => x - closed[v][k])) > 1e-9;
    assert.equal(moved, PAIRS[2].includes(v), `vertex ${v}`);
  }
  assert.equal(FACES.length, 20);
  assert.equal(new Set(PAIRS.flat()).size, 12);
});

// ------------------------------------------------------------- fake hub
test("the fake hub speaks the protocol and runs fast", async () => {
  const lines = [];
  const hub = new FakeHub({ onLine: (l) => lines.push(l), startUnix: 1_790_000_000, speed: 1 });
  hub.write("PING");
  hub.skip(DAY);
  const readings = lines.map(parseLine).filter((e) => e.type === "reading");
  assert.equal(readings.length, 289);            // every 300 s for a day, both ends
  assert.ok(readings.every((e) => e.reading.sim.length === 5));
  assert.equal(lines[0], "PONG");
  hub.write("POSE 4 0.1 0.2 0.3 0.4 0.5 0.6 0");
  assert.ok(lines.includes("OK POSE 4"));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(lines.includes("ACK body 4"));
  hub.skip(10);
  const body = lines.map(parseLine).filter((e) => e.type === "body").at(-1);
  assert.deepEqual(body.pose, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  hub.write("CFG sensor interval=600");
  assert.equal(hub.interval, 600);
  assert.ok(lines.at(-1).startsWith("OK CFG"));
  hub.write("NOPE");
  assert.ok(lines.at(-1).startsWith("ERR"));
});
