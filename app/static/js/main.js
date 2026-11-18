// Weathering — the page. Ties the hub (via a backend), the show's memory,
// the 12-hour runs and the drawing together.

import { parseLine, formatPose, CHANNELS, CORE_CHANNELS, CHANNEL_INFO, MOTORS, toPulls, CLOSED } from "./protocol.js";
import { runPipeline, labelHours, dueRun, nextRun, soundContext, dataState, ALGORITHMS, ALGORITHM_IDS } from "./pipeline.js";
import { trainTaught, MIN_EXAMPLES } from "./mlp.js";
import { drawTwin } from "./twin.js";
import { LocalBackend, SerialBackend, DemoBackend } from "./backends.js";
import { exportFiles } from "./store.js";
import * as boards from "./boards.js";

const $ = (id) => document.getElementById(id);
const KIND_RGB = [[77, 147, 166], [191, 170, 110], [176, 74, 104]];
const NEUTRAL = [120, 134, 146];
const NODE_STALE_S = 30;
// the cards: the four readings, then the taught mapping
const CARDS = { ...ALGORITHMS, taught: { label: "MLP", about: "Your own mapping, learned from shapes you teach on the twin (Teach…)." } };
const CARD_IDS = Object.keys(CARDS);

const S = {
  backend: null, local: false,
  meta: {}, readings: [], seen: new Set(), runs: [],
  body: null, sentPose: null, seq: 1, connected: false,
  nodes: {},                    // role → {seen (ms), fw}
  labels: new Map(), labelsRun: -1,
  view: null,                   // history: index into runs, or null = now
  running: false,
  taught: null,                 // {net, err} trained on meta.examples, or null
  teaching: false, teachPose: new Array(MOTORS).fill(0.5), tried: false,
  bodyHomed: true, bodyFound: 15,
  lastLive: 0,                  // when the last live pose was sent (real ms)
};
window.weathering = S;          // for debugging in the console

// ================================================================ start
async function boot() {
  wireUi();
  if (await LocalBackend.available()) {
    S.local = true;
    $("quitBtn").hidden = false;
    await use(new LocalBackend());
  } else {
    await use(new DemoBackend(Number($("speed").value)));
  }
  requestAnimationFrame(frame);
  setInterval(() => { maybeRun(); renderStatus(); renderOverlay(); }, 5000);
}

async function use(backend) {
  if (S.backend) { try { await S.backend.stop(); } catch (_) {} }
  S.backend = backend;
  const show = await backend.loadShow();
  S.meta = show.meta;
  S.readings = show.readings;
  S.seen = new Set(show.readings.map(key));
  // runs from the six-servo version (before the NPTX sculpture) don't fit
  S.runs = show.runs.filter((r) => Array.isArray(r.sent) && r.sent.length === MOTORS);
  if (S.runs.length < show.runs.length) setTimeout(() => toast("Runs from the six-servo version are left out"), 800);
  S.labelsRun = -1;
  S.view = null;
  S.nodes = {};
  S.body = null;
  S.sentPose = S.runs.at(-1)?.sent || null;
  recomputeTaught();
  closeTeach(false);
  S.seq = (S.runs.length + 1) * 10;
  for (const line of show.recent || []) handleLine(line, true);
  $("demoBanner").hidden = backend.kind !== "demo";
  $("demoCtl").hidden = backend.kind !== "demo";
  await backend.start(onEvent);
  renderAll();
  maybeRun();
}

const key = (r) => `${r.unix}:${r.seq}`;

// ================================================================ events
function onEvent(ev) {
  if (ev.type === "status") {
    const was = S.connected;
    S.connected = !!ev.connected;
    if (ev.lost) toast("The hub was unplugged");
    // (re)connected: make sure the sculpture holds the current shape
    if (S.connected && !was && S.sentPose) setTimeout(() => sendPose(S.sentPose), 1200);
    renderStatus();
  } else if (ev.type === "line") handleLine(ev.line);
  else if (ev.type === "show") use(new LocalBackend());
}

function handleLine(line, replay = false) {
  const ev = parseLine(line);
  if (!ev) return;
  switch (ev.type) {
    case "reading": if (!replay) addReading(ev.reading); break;
    case "body": S.body = ev.pose; S.bodyHomed = ev.homed; S.bodyFound = ev.found; renderBody(ev.moving); renderStatus(); break;
    case "node": S.nodes[ev.role] = { seen: Date.now(), fw: ev.fw }; renderStatus(); break;
    case "lost": if (S.nodes[ev.role]) S.nodes[ev.role].seen = 0; renderStatus(); break;
    case "boot": S.nodes.hub = { seen: Date.now(), fw: ev.fw }; renderStatus(); break;
    case "log": if (ev.text.startsWith("(sound) ")) { S.sound = ev.text.slice(8).trim(); renderStatus(); } break;
    // a newer pose NAKs the one still in flight: only the current one matters
    case "nak": if (!replay && ev.seq === S.seq) toast("The sculpture didn't answer (power? range?)"); break;
    case "err": if (!replay) console.warn("hub:", ev.reason); break;
    default: break;
  }
}

function addReading(r) {
  const k = key(r);
  if (S.seen.has(k)) return;
  S.seen.add(k);
  if (S.readings.length && r.unix < S.readings.at(-1).unix) {
    S.readings.push(r);
    S.readings.sort((a, b) => a.unix - b.unix);      // a backlog reading arriving late
  } else S.readings.push(r);
  S.nodes.sensor = { ...(S.nodes.sensor || {}), seen: Date.now() };
  S.backend.addReading(r).catch(() => toast("Couldn't save a reading"));
  renderRoom();
  renderOverlay();
  maybeRun();
  maybeLive();
}

// ================================================================ runs
function now() {
  if (S.backend?.kind === "demo") return S.backend.now;
  return Math.max(Date.now() / 1000, S.readings.at(-1)?.unix || 0);
}

function maybeRun() {
  if (S.running || !S.readings.length) return;
  const last = S.runs.at(-1)?.unix ?? S.readings[0].unix;
  const due = dueRun(last, now(), S.meta.run_times);
  if (due !== null) doRun(due, false);
}

async function doRun(at, manual) {
  S.running = true;
  try {
    const prev = S.runs.at(-1) || null;
    const run = runPipeline(S.readings, at, prev, { showDays: S.meta.show_days, driving: S.meta.driving });
    run.run = (prev?.run || 0) + 1;
    if (manual) run.manual = true;
    if (S.taught) {
      run.poses.taught = S.taught.net.predict(dataState(run)).map((x) => +x.toFixed(3));
      if (S.meta.driving === "taught") {
        run.driving = "taught";
        run.sent = toPulls(run.poses.taught, run.openness);
      }
    }
    run.context = soundContext(run, labelHours(S.readings, run));
    S.runs.push(run);
    await S.backend.addRun(run);
    sendPose(run.sent);
    if (S.view === null) renderAll();
    else renderHistory();
  } finally {
    S.running = false;
  }
}

// Live (optional): between runs the sculpture also follows each new reading,
// read with everything so far, gliding quickly. Not stored as runs.
const LIVE_EVERY_MS = 20000, LIVE_GLIDE_S = 20;
function maybeLive() {
  if (S.meta.moves !== "live" || S.running || S.view !== null || S.teaching) return;
  if (Date.now() - S.lastLive < LIVE_EVERY_MS) return;
  const prev = S.runs.at(-1);
  if (!prev) return;
  S.lastLive = Date.now();
  const run = runPipeline(S.readings, now(), prev, { showDays: S.meta.show_days, driving: S.meta.driving });
  let pulls = run.sent;
  if (S.meta.driving === "taught" && S.taught) pulls = toPulls(S.taught.net.predict(dataState(run)), run.openness);
  sendPose(pulls, LIVE_GLIDE_S);
}

// pulls: 4 values, 1 = closed
function sendPose(pulls, glideS = S.meta.glide_s ?? 60) {
  S.sentPose = pulls.slice();
  S.seq += 1;
  S.backend.send(formatPose(S.seq, pulls, glideS));
  renderBody();
}

// ============================================================== drawing
const stage = $("stage");
const ctx = stage.getContext("2d");
let ringCache = null, ringKey = "";
const shown = CLOSED();                    // the main twin's pulls, eased
let spin = 0, lastT = 0;

function frame(t) {
  requestAnimationFrame(frame);            // first, so one bad frame can't stop the loop
  const dt = lastT ? Math.min(100, t - lastT) : 16;
  lastT = t;
  spin += dt * 0.00012;
  const W = stage.clientWidth, H = stage.clientHeight, dpr = devicePixelRatio || 1;
  if (!W || !H) return;                    // hidden view or not laid out yet
  if (stage.width !== W * dpr || stage.height !== H * dpr) {
    stage.width = W * dpr; stage.height = H * dpr; ringKey = "";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawRings(W, H);
  const target = mainPose();
  const k = 1 - Math.pow(0.94, dt / 16.7);
  for (let i = 0; i < MOTORS; i++) shown[i] += (target[i] - shown[i]) * k;
  const C = Math.min(W, H) / 2;
  drawTwin(ctx, W / 2, H / 2, C * 0.3, shown, { color: currentColor(), spin, tilt: 0.44 + Math.sin(t * 0.00006) * 0.08 });
}

// the pulls the main twin shows
function mainPose() {
  if (S.teaching) return toPulls(S.teachPose, 1);
  if (S.view !== null) return S.runs[S.view]?.sent || CLOSED();
  return S.body || S.sentPose || CLOSED();
}

function currentColor() {
  const run = S.view !== null ? S.runs[S.view] : S.runs.at(-1);
  const at = S.view !== null ? run?.unix : S.readings.at(-1)?.unix;
  if (!run || !at) return NEUTRAL;
  const labels = labelsFor(run);
  const h = Math.floor(at / 3600) * 3600;
  for (let back = 0; back < 6; back++) {
    const kind = labels.get(h - back * 3600);
    if (kind !== undefined) return KIND_RGB[kind];
  }
  return NEUTRAL;
}

function labelsFor(run) {
  if (S.labelsRun !== run.run) {
    S.labels = labelHours(S.readings, run);
    S.labelsRun = run.run;
  }
  return S.labels;
}

// One ring per day, one arc per hour; colour = the kind of hour, as the
// latest run reads it (so each run re-colours the whole past). Hours after
// the latest run are grey until the next run reads them.
function drawRings(W, H) {
  const run = S.view !== null ? S.runs[S.view] : S.runs.at(-1);
  const keyNow = `${W}x${H}:${S.readings.length}:${run?.run ?? 0}:${S.view}`;
  if (keyNow !== ringKey) {
    ringKey = keyNow;
    ringCache = ringCache || document.createElement("canvas");
    const dpr = devicePixelRatio || 1;
    ringCache.width = W * dpr; ringCache.height = H * dpr;
    const g = ringCache.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintRings(g, W, H, run);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(ringCache, 0, 0);
  ctx.restore();
}

function paintRings(g, W, H, run) {
  if (!S.readings.length) return;
  const cx = W / 2, cy = H / 2, C = Math.min(W, H) / 2;
  const r0 = C * 0.58, rMax = C * 0.97;
  const tz = -new Date().getTimezoneOffset() * 60;
  const dayOf = (u) => Math.floor((u + tz) / 86400);
  const first = dayOf(S.readings[0].unix);
  const days = dayOf(S.readings.at(-1).unix) - first + 1;
  const rw = Math.max(1.5, Math.min(10, (rMax - r0) / Math.max(7, days)));
  const labels = run ? labelsFor(run) : new Map();
  const upTo = run?.unix ?? -Infinity;
  const hours = new Set(S.readings.map((r) => Math.floor(r.unix / 3600) * 3600));
  g.lineCap = "butt";
  for (const h of hours) {
    const day = dayOf(h) - first;
    const hourOfDay = Math.floor(((h + tz) % 86400) / 3600);
    const a0 = (hourOfDay / 24) * 2 * Math.PI - Math.PI / 2;
    const r = r0 + day * rw;
    const kind = h <= upTo ? labels.get(h) : undefined;
    const col = kind === undefined ? [70, 80, 90] : KIND_RGB[kind];
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + (2 * Math.PI / 24) * 0.9);
    g.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${kind === undefined ? 0.35 : 0.7})`;
    g.lineWidth = rw * 0.72;
    g.stroke();
  }
  // where now is
  const last = S.readings.at(-1).unix;
  const day = dayOf(last) - first;
  const a = ((((last + tz) % 86400) / 86400) * 2 * Math.PI) - Math.PI / 2;
  g.beginPath();
  g.arc(cx + Math.cos(a) * (r0 + day * rw), cy + Math.sin(a) * (r0 + day * rw), 3, 0, 2 * Math.PI);
  g.fillStyle = "#e8eef2";
  g.fill();
}

// ============================================================ rendering
function renderAll() {
  renderStatus(); renderOverlay(); renderRoom(); renderAlgos(); renderHistory(); renderBody();
}

function renderStatus() {
  const b = S.backend;
  let text, cls;
  if (!b) { text = "Not connected"; cls = ""; }
  else if (b.kind === "demo") { text = `Demo ×${b.speed}`; cls = "ok"; }
  else if (S.connected) { text = b.kind === "local" ? "Hub connected" : "Hub connected (USB)"; cls = "ok"; }
  else { text = b.kind === "local" ? "Hub not connected" : "Not connected"; cls = "warn"; }
  $("statusText").innerHTML = `<span class="dot ${cls}"></span>${text}`;
  const fresh = (role) => S.nodes[role] && (Date.now() - S.nodes[role].seen) / 1000 < (role === "sensor" ? Math.max(NODE_STALE_S, 2.5 * 300) : NODE_STALE_S * 4);
  $("nodes").innerHTML = ["sensor", "body"].map((role) => {
    const ok = b?.kind === "demo" || (S.connected && fresh(role));
    const lame = role === "body" && ok && (!S.bodyHomed || S.bodyFound !== 15);
    const why = !S.bodyHomed ? "the sculpture needs Set slack (Boards)" : `motors answering: ${[0, 1, 2, 3].filter((k) => S.bodyFound & (1 << k)).map((k) => k + 1).join(", ") || "none"}`;
    return `<span title="${role === "sensor" ? "sensor box" : lame ? why : "sculpture"}"><span class="dot ${lame ? "warn" : ok ? "ok" : ""}"></span>${role === "sensor" ? "sensor" : "sculpture"}</span>`;
  }).join(" ");
  $("connectBtn").textContent = S.connected && b?.kind !== "demo" ? "Connected" : "Connect";
  if (b?.kind === "local" && S.sound) $("soundState").textContent = { ready: "sound on", starting: "sound starting…", missing: "no SuperCollider: silent", off: "sound off", stopped: "sound stopped" }[S.sound] || "";
}

const fmtDate = (u) => new Date(u * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtShort = (u) => new Date(u * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function renderOverlay() {
  const run = S.view !== null ? S.runs[S.view] : S.runs.at(-1);
  const t = S.view !== null ? run?.unix : (S.readings.length ? now() : null);
  $("clock").textContent = t ? fmtDate(t) : "—";
  if (S.readings.length) {
    const days = Math.floor((now() - S.readings[0].unix) / 86400) + 1;
    const n = S.runs.length;
    $("lived").textContent = `day ${days} · ${S.readings.length.toLocaleString()} readings · ${n} run${n === 1 ? "" : "s"}`;
  } else $("lived").textContent = "waiting for the first reading";
  const open = run?.openness ?? 0;
  $("openVal").textContent = open.toFixed(2);
  $("openBar").style.width = `${(open * 100).toFixed(1)}%`;
  if (S.readings.length && S.view === null) {
    const next = nextRun(now(), S.meta.run_times);
    const hrs = (next - now()) / 3600;
    $("nextRun").textContent = `next run ${new Date(next * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · in ${hrs >= 1 ? hrs.toFixed(1) + " h" : Math.max(0, Math.round(hrs * 60)) + " min"}`;
  } else $("nextRun").textContent = run?.note || "";
}

function renderRoom() {
  const last = S.readings.at(-1);
  const since = (last?.unix || 0) - 86400;
  const day = S.readings.filter((r) => r.unix >= since);
  // the show's channels: the SCD30's three, plus any that boards send
  const chans = CHANNELS.filter((c) => CORE_CHANNELS.includes(c) || day.some((r) => r[c] !== null && r[c] !== undefined));
  $("room").innerHTML = chans.map((c) => {
    const info = CHANNEL_INFO[c];
    const v = last?.[c];
    const val = v === null || v === undefined ? `<span class="dim">no sensor</span>` : `${Number(v).toFixed(info.digits)} <span class="dim">${info.unit}</span>`;
    const sim = last?.sim?.includes(c) ? `<span class="sim" title="simulated: no sensor on the board">sim</span>` : "";
    return `<div class="room-row"><span>${info.label}${sim}</span><canvas data-c="${c}"></canvas><span class="val">${val}</span></div>`;
  }).join("");
  for (const cv of $("room").querySelectorAll("canvas")) spark(cv, day.map((r) => r[cv.dataset.c]));
}

function spark(cv, vals) {
  const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  const v = vals.filter((x) => x !== null && x !== undefined);
  if (v.length < 2) return;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  g.beginPath();
  vals.forEach((x, i) => {
    if (x === null || x === undefined) return;
    const px = (i / (vals.length - 1)) * w, py = h - 2 - ((x - lo) / span) * (h - 4);
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  });
  g.strokeStyle = "#5d6a74"; g.lineWidth = 1; g.stroke();
}

function renderAlgos() {
  const run = S.view !== null ? S.runs[S.view] : S.runs.at(-1);
  const box = $("algos");
  if (!box.children.length) {
    box.innerHTML = CARD_IDS.map((id) => `<button class="algo" data-id="${id}" title="${CARDS[id].about}"><canvas></canvas><span>${CARDS[id].label}</span></button>`).join("");
    for (const el of box.children) el.onclick = () => setDriving(el.dataset.id);
  }
  for (const el of box.children) {
    const id = el.dataset.id;
    el.classList.toggle("on", id === (run?.driving || S.meta.driving));
    el.classList.toggle("off", id === "taught" && !S.taught);
    const cv = el.querySelector("canvas");
    const w = cv.clientWidth, dpr = devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = w * dpr;
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);
    const shape = run?.poses?.[id];
    drawTwin(g, w / 2, w / 2, w * 0.32, shape ? toPulls(shape, 1) : CLOSED(), { color: [150, 175, 190], glow: false, faint: !run, strings: false });
  }
}

async function setDriving(id) {
  if (S.view !== null) return toast("Back to now first");
  if (id === "taught" && !S.taught) { openTeach(); return toast(`Teach at least ${MIN_EXAMPLES} shapes first`); }
  S.meta.driving = id;
  await S.backend.saveSettings({ driving: id });
  const run = S.runs.at(-1);
  if (run) {
    run.driving = id;
    if (run.poses[id]) { run.sent = toPulls(run.poses[id], run.openness); sendPose(run.sent); }
  }
  renderAlgos();
  toast(`${CARDS[id].label} moves the sculpture now`);
}

function renderHistory() {
  const n = S.runs.length;
  const hist = $("hist");
  hist.max = String(n);
  hist.value = String(S.view === null ? n : S.view);
  hist.disabled = n === 0;
  if (S.view === null) {
    $("histLabel").textContent = n ? `now · ${n} run${n === 1 ? "" : "s"}` : "now · no runs yet";
  } else {
    const r = S.runs[S.view];
    $("histLabel").textContent = `run ${r.run} · ${fmtShort(r.unix)} · open ${r.openness.toFixed(2)}`;
  }
  $("histToBody").hidden = S.view === null;
  $("histNow").hidden = S.view === null;
  renderOverlay();
  renderAlgos();
  ringKey = "";
}

function renderBody(moving) {
  const p = S.body || S.sentPose;
  $("touchBtn").hidden = S.backend?.kind !== "local";
  $("bodyState").textContent = !S.bodyHomed
    ? "needs calibrating: Boards → Sculpture → Set slack"
    : p ? `pulls ${moving ? "→ " : ""}${p.map((a) => a.toFixed(2)).join(" · ")}` : "closed";
}

// ================================================================== ui
function wireUi() {
  for (const b of document.querySelectorAll("nav button")) b.onclick = () => showView(b.dataset.view);
  $("connectBtn").onclick = openConnect;
  $("connectClose").onclick = () => $("connectDlg").close();
  $("settingsBtn").onclick = openSettings;
  $("settingsClose").onclick = () => $("settingsDlg").close();
  $("saveSettings").onclick = saveSettings;
  $("exportBtn").onclick = () => exportFiles(S.meta.name || S.backend.kind, S.readings, S.runs);
  $("resetDemo").onclick = async () => { await S.backend.reset(); $("settingsDlg").close(); await use(new DemoBackend(Number($("speed").value))); toast("Demo restarted: the sculpture is closed again"); };
  $("quitBtn").onclick = async () => { await S.backend.quit(); document.body.innerHTML = '<p style="padding:40px">Weathering stopped. You can close this tab.</p>'; };
  $("speed").onchange = () => { S.backend.setSpeed?.(Number($("speed").value)); renderStatus(); };
  $("skipDay").onclick = () => S.backend.skip?.(86400);
  $("touchBtn").onclick = async () => {
    const r = await S.backend.touch?.();
    toast(r?.ok ? "Knock" : "No sound engine running");
  };
  $("runNow").onclick = () => { if (!S.readings.length) return toast("No readings yet"); if (S.view !== null) return toast("Back to now first"); doRun(now(), true); };
  $("hist").oninput = () => {
    const v = Number($("hist").value);
    S.view = v >= S.runs.length ? null : v;
    renderHistory();
    if (S.teaching) renderTeach();
  };
  $("histNow").onclick = () => {
    S.view = null;
    const run = S.runs.at(-1);
    if (run) sendPose(run.sent);
    renderHistory();
  };
  $("histToBody").onclick = () => { const r = S.runs[S.view]; if (r) { sendPose(r.sent); toast(`The sculpture takes run ${r.run}'s shape`); } };
  $("algoHelp").onclick = () => {
    $("helpBody").innerHTML = ALGORITHM_IDS.map((id) => `<p><b>${ALGORITHMS[id].label}</b>${id === "som" ? " <span class=\"dim\">(default)</span>" : ""}<br><span class="dim">${ALGORITHMS[id].about}</span></p>`).join("");
    $("helpDlg").showModal();
  };
  $("helpClose").onclick = () => $("helpDlg").close();
  $("teachBtn").onclick = () => (S.teaching ? closeTeach(true) : openTeach());
  $("teachDone").onclick = () => closeTeach(true);
  $("teachAdd").onclick = teachMoment;
  $("teachTry").onclick = () => { S.tried = true; sendPose(toPulls(S.teachPose, 1), 10); toast("The sculpture takes this shape"); };
  addEventListener("resize", () => { renderRoom(); renderAlgos(); });
  wireBoards();
}

function showView(v) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.view === v);
  for (const id of ["live", "setup", "boards"]) $(`view-${id}`).hidden = id !== v;
  if (v === "live") { ringKey = ""; renderRoom(); renderAlgos(); }
  if (v === "boards") renderBoardsIntro();
}

function choice(title, small, fn) {
  const b = document.createElement("button");
  b.innerHTML = `${title}<small>${small}</small>`;
  b.onclick = async () => { $("connectDlg").close(); try { await fn(); } catch (e) { toast(e.message || String(e)); } };
  return b;
}

async function openConnect() {
  const box = $("connectChoices");
  box.innerHTML = "";
  if (S.local) {
    const st = await new LocalBackend().state();
    if (S.backend.kind !== "local") box.append(choice("Back to the installation", "the hub and the show on this computer", () => use(new LocalBackend())));
    for (const p of st.ports) {
      const on = st.link.connected && st.link.port === p.device;
      box.append(choice(`${on ? "✓ " : ""}${p.esp ? "ESP32 · " : ""}${p.device}`, on ? "the hub is here" : p.label, async () => {
        if (S.backend.kind !== "local") await use(new LocalBackend());
        await S.backend.connect(p.device);
      }));
    }
    if (!st.ports.length) box.append(Object.assign(document.createElement("p"), { className: "dim", textContent: "No USB ports found: plug the hub in and open this again." }));
    if (st.link.port) box.append(choice("Disconnect the hub", "frees its USB port (to set it up in Boards)", () => S.backend.disconnect()));
  } else if (SerialBackend.supported()) {
    box.append(choice("Hub on USB", "pick the ESP32 in Chrome's list", async () => {
      const port = await navigator.serial.requestPort();
      await use(new SerialBackend(port));
    }));
  } else {
    box.append(Object.assign(document.createElement("p"), { className: "dim", textContent: "Connecting a hub needs Chrome or Edge on a computer." }));
  }
  box.append(choice("Demo", "a pretend room and sculpture, fast — nothing is sent to hardware", () => use(new DemoBackend(Number($("speed").value)))));
  $("connectDlg").showModal();
}

function openSettings() {
  $("showName").textContent = `${S.meta.name || S.backend.kind}${S.backend.kind === "local" ? "" : " (in this browser)"}`;
  $("runTimes").value = (S.meta.run_times || []).join(", ");
  $("showDays").value = S.meta.show_days ?? 14;
  $("glide").value = S.meta.glide_s ?? 60;
  $("moves").value = S.meta.moves === "live" ? "live" : "runs";
  $("resetDemo").hidden = S.backend.kind !== "demo";
  $("settingsDlg").showModal();
}

async function saveSettings() {
  const times = $("runTimes").value.split(/[,\s]+/).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  if (!times.length) return toast("Run times look like 06:00, 18:00");
  const m = { run_times: times, show_days: Math.max(1, Number($("showDays").value) || 14), glide_s: Math.max(0, Number($("glide").value) || 0),
              moves: $("moves").value === "live" ? "live" : "runs" };
  Object.assign(S.meta, m);
  await S.backend.saveSettings(m);
  $("settingsDlg").close();
  renderOverlay();
  toast("Saved");
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
}

// ================================================================ teach
// The twin is the teaching surface: pick a moment (the history slider),
// shape the sculpture with four sliders (one per string), teach. The taught mapping (mlp.js)
// learns from those pairs and gives a shape for every moment.
function recomputeTaught() {
  S.taught = trainTaught(S.meta.examples || []);
  for (const r of S.runs) {
    if (S.taught) r.poses.taught = S.taught.net.predict(dataState(r)).map((x) => +x.toFixed(3));
    else delete r.poses.taught;
  }
}

function teachRun() { return S.view !== null ? S.runs[S.view] : S.runs.at(-1); }

function openTeach() {
  const r = teachRun();
  if (!r) return toast("Teaching needs a first run");
  const shape = r.poses.taught || r.poses[r.driving] || r.poses.som || new Array(MOTORS).fill(0.5);
  S.teachPose = shape.map((x) => +x);
  S.teaching = true;
  $("teach").hidden = false;
  $("teachBtn").textContent = "Teaching…";
  renderTeach();
}

function closeTeach(restore) {
  if (restore && S.tried) { const r = S.runs.at(-1); if (r) sendPose(r.sent); }
  S.teaching = false; S.tried = false;
  $("teach").hidden = true;
  $("teachBtn").textContent = "Teach…";
}

function renderTeach() {
  const r = teachRun();
  $("teachWhen").textContent = r ? `For run ${r.run} · ${fmtShort(r.unix)}${S.view === null ? " (now)" : ""}. Each slider lets a string out (left: pulled in). Shape it, then teach.` : "";
  const box = $("teachSliders");
  if (!box.children.length) {
    box.innerHTML = Array.from({ length: MOTORS }, (_, k) =>
      `<label><span>string ${k + 1}</span><input type="range" min="0" max="1" step="0.01" data-k="${k}"><span class="dim" data-v="${k}"></span></label>`).join("");
    for (const inp of box.querySelectorAll("input")) {
      inp.oninput = () => { S.teachPose[+inp.dataset.k] = +inp.value; box.querySelector(`[data-v="${inp.dataset.k}"]`).textContent = (+inp.value).toFixed(2); };
    }
  }
  for (const inp of box.querySelectorAll("input")) {
    inp.value = S.teachPose[+inp.dataset.k];
    box.querySelector(`[data-v="${inp.dataset.k}"]`).textContent = (+inp.value).toFixed(2);
  }
  renderTeachList();
}

function renderTeachList() {
  const ex = S.meta.examples || [];
  const box = $("teachList");
  box.innerHTML = ex.length
    ? `<p>${ex.length} taught${S.taught ? ` · learned, off by ${Math.max(0.1, Math.sqrt(S.taught.err) * 100).toFixed(1)}%` : ` · teach ${MIN_EXAMPLES - ex.length} more`}</p>`
      + ex.map((e, i) => `<div class="ex"><span>run ${e.run} · ${fmtShort(e.unix)}</span><button class="quiet" data-i="${i}" title="Forget this one">×</button></div>`).join("")
    : "<p>Nothing taught yet.</p>";
  for (const b of box.querySelectorAll("button[data-i]")) {
    b.onclick = async () => {
      S.meta.examples = ex.filter((_, i) => i !== +b.dataset.i);
      await saveExamples();
    };
  }
}

async function teachMoment() {
  const r = teachRun();
  if (!r) return;
  const ex = (S.meta.examples || []).filter((e) => e.run !== r.run);   // one shape per moment
  ex.push({ run: r.run, unix: r.unix, input: dataState(r), output: S.teachPose.map((x) => +x.toFixed(3)) });
  S.meta.examples = ex;
  await saveExamples();
  toast(S.taught ? `MLP: ${ex.length} shapes, the mapping is updated` : `Taught ${ex.length}: one more to make a mapping`);
}

async function saveExamples() {
  await S.backend.saveSettings({ examples: S.meta.examples });
  recomputeTaught();
  if (S.meta.driving === "taught" && !S.taught) { S.meta.driving = "som"; await S.backend.saveSettings({ driving: "som" }); }
  renderTeachList();
  renderAlgos();
}

// =============================================================== boards
const B = { port: null, board: null };
window.weatheringBoards = { B, renderBoard: () => renderBoard() };   // debugging / tests

function renderBoardsIntro() {
  const ok = "serial" in navigator;
  $("noSerial").hidden = ok;
  $("boardConnect").disabled = !ok;
  $("hubBusy").hidden = !(S.backend?.kind === "local" && S.connected);
}

function blog(text) {
  const el = $("boardLog");
  el.textContent = (el.textContent + text + "\n").slice(-6000);
  el.scrollTop = el.scrollHeight;
}

function wireBoards() {
  $("boardConnect").onclick = async () => {
    try {
      B.port = await navigator.serial.requestPort();
    } catch (_) { return; }
    await inspectBoard();
  };
  $("readNow").onclick = async () => {
    try {
      const { reply } = await boards.readNow(B.port);
      const r = parseLine(reply).reading;
      $("sensorNow").textContent = CHANNELS.filter((c) => r[c] !== null).map((c) => `${CHANNEL_INFO[c].label} ${r[c] ?? "—"}${r.sim.includes(c) ? " (sim)" : ""}`).join(" · ");
    } catch (e) { blog(`! ${e.message}`); }
  };
  $("saveBoard").onclick = saveBoard;
  wireMotorButtons();
}

async function inspectBoard() {
  $("boardCard").hidden = false;
  $("boardWhat").textContent = "asking the board…";
  $("boardLog").textContent = "";
  try {
    const b = await boards.inspect(B.port);
    B.board = b;
    b.lines.forEach(blog);
    renderBoard();
  } catch (e) {
    $("boardWhat").textContent = "";
    blog(`! ${e.message}`);
  }
}

async function renderBoard() {
  const b = B.board;
  const known = b.role && boards.ROLE_INFO[b.role];
  $("boardWhat").textContent = "";
  $("boardInfo").innerHTML = known
    ? `<b>${boards.ROLE_INFO[b.role].label}</b> <span class="dim">· firmware ${b.fw} · ${b.mac}${b.group ? ` · group ${b.group}` : ""}</span>`
      + (b.role === "sensor" ? `<br><span class="dim">sensors found: ${b.settings.sensors || "?"} · simulated: ${b.settings.sim || "?"}</span>` : "")
    : `<b>No Weathering firmware on this board yet.</b> <span class="dim">Install one part below.</span>`;
  const roles = $("roles");
  roles.innerHTML = "";
  for (const [role, info] of Object.entries(boards.ROLE_INFO)) {
    const latest = await boards.latestVersion(role);
    const current = b.role === role;
    const btn = document.createElement("button");
    btn.className = current ? "current" : "";
    btn.innerHTML = `${current ? "Update " : "Install "}${info.label}<small>${info.does}${latest ? ` · v${latest}` : " · not built yet"}</small>`;
    btn.disabled = !latest;
    btn.onclick = () => installRole(role);
    roles.append(btn);
  }
  $("sensorCfg").hidden = b.role !== "sensor";
  $("bodyCfg").hidden = b.role !== "body";
  $("groupRow").hidden = !known;
  $("saveBoard").hidden = !known;
  $("group").value = b.group || 1;
  if (b.role === "sensor") $("interval").value = String(b.settings.interval || 300);
  if (b.role === "sensor") {
    const chans = String(b.settings.channels || "co2,t,rh").split(",");
    for (const cb of $("channelBoxes").querySelectorAll("input")) cb.checked = chans.includes(cb.dataset.ch);
  }
  if (b.role === "body") renderMotors(b.settings);
}

// The sculpture: four Dynamixel motors, calibrated here (docs/PROTOCOL.md, Body board).
function renderMotors(settings) {
  const homed = settings.homed === "1", found = Number(settings.found ?? 0);
  const motors = [1, 2, 3, 4].map((k) => boards.parseMotor(settings[`m${k}`]));
  const answering = [0, 1, 2, 3].filter((k) => found & (1 << k)).map((k) => k + 1);
  $("motorState").innerHTML = `motors answering: <b>${answering.join(", ") || "none"}</b> of 4 · `
    + (homed ? "slack set" : "<b>slack not set</b> (step 2)")
    + ` · closed set for ${motors.filter((m) => m.travel).length} of 4`;
  $("motorSpeed").value = ["10", "30", "60"].includes(String(settings.speed)) ? String(settings.speed) : "30";
  const tb = $("motorRows");
  tb.innerHTML = "";
  motors.forEach((m, i) => {
    const k = i + 1, ok = found & (1 << i);
    const tr = document.createElement("tr");
    tr.dataset.k = k;
    tr.innerHTML = `<td>${k}${ok ? "" : ' <span class="dim">(silent)</span>'}</td>
      <td><input type="number" data-f="id" min="0" max="252" value="${m.id}"></td>
      <td class="jog"><button data-jog="-512" title="1/8 turn">◂◂</button><button data-jog="-64">◂</button><button data-jog="64">▸</button><button data-jog="512" title="1/8 turn">▸▸</button></td>
      <td>${m.travel ? `${(Math.abs(m.travel) / boards.TICKS_PER_TURN).toFixed(2)} turns` : '<span class="dim">not set</span>'}</td>
      <td><button data-closed="${k}">Set closed</button> <button data-test="${k}">Test</button></td>`;
    tb.append(tr);
  });
  for (const b of tb.querySelectorAll("button[data-jog]")) {
    b.onclick = () => bodyAction({ jog: `${b.closest("tr").dataset.k},${b.dataset.jog}` }, null);
  }
  for (const b of tb.querySelectorAll("button[data-closed]")) {
    b.onclick = () => bodyAction({ closed: b.dataset.closed }, `motor ${b.dataset.closed}: closed point set`);
  }
  for (const b of tb.querySelectorAll("button[data-test]")) {
    b.onclick = async () => { try { await boards.testMotor(B.port, Number(b.dataset.test)); blog(`motor ${b.dataset.test}: in a little and back`); } catch (e) { blog(`! ${e.message}`); } };
  }
}

// One calibration step on the board, then show what it says now.
async function bodyAction(settings, done) {
  try {
    await boards.saveSettings(B.port, settings);
    if (done) { blog(done); toast(done); }
    const b = await boards.info(B.port);
    B.board.settings = b.settings;
    renderMotors(b.settings);
  } catch (e) { blog(`! ${e.message}`); toast(e.message); }
}

function wireMotorButtons() {
  $("scanMotors").onclick = async () => {
    blog("looking for motors (≈ 6 s)…");
    try { (await boards.scan(B.port)).forEach(blog); } catch (e) { blog(`! ${e.message}`); }
    await bodyAction({ speed: $("motorSpeed").value }, null);
  };
  $("setId").onclick = () => bodyAction({ setid: `${Number($("oldId").value) | 0},${Number($("newId").value) | 0}` }, "id changed");
  $("setSlack").onclick = () => {
    if (!confirm("Is the structure fully open, with every string just slack?")) return;
    bodyAction({ slack: "all" }, "slack set: this is pull 0 for every motor");
  };
  $("motorSpeed").onchange = () => bodyAction({ speed: $("motorSpeed").value }, null);
}

async function installRole(role) {
  const bar = $("flashBar");
  bar.hidden = false;
  bar.firstElementChild.style.width = "0%";
  blog(`installing ${boards.ROLE_INFO[role].label}…`);
  try {
    const v = await boards.install(B.port, role, {
      onProgress: (f) => { bar.firstElementChild.style.width = `${(f * 100).toFixed(0)}%`; },
      onLog: (t) => blog(t),
    });
    blog(`installed ${role} v${v}`);
    toast(`${boards.ROLE_INFO[role].label} installed`);
    await new Promise((r) => setTimeout(r, 1500));
    await inspectBoard();
  } catch (e) {
    blog(`! ${e.message}`);
    toast(e.message);
  } finally {
    setTimeout(() => { bar.hidden = true; }, 1500);
  }
}

async function saveBoard() {
  const b = B.board;
  const settings = { group: Math.max(1, Math.min(250, Number($("group").value) || 1)) };
  if (b.role === "sensor") {
    settings.interval = Number($("interval").value);
    settings.channels = [...$("channelBoxes").querySelectorAll("input")].filter((cb) => cb.checked).map((cb) => cb.dataset.ch).join(",");
  }
  if (b.role === "body") {
    settings.ids = [...$("motorRows").children].map((tr) => Number(tr.querySelector('[data-f="id"]').value) | 0).join(",");
    settings.speed = $("motorSpeed").value;
  }
  try {
    await boards.saveSettings(B.port, settings);
    $("saveMsg").textContent = "saved on the board";
    setTimeout(() => { $("saveMsg").textContent = ""; }, 2500);
  } catch (e) { blog(`! ${e.message}`); }
}

boot();
