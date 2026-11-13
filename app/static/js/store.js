// Where a show lives when the page runs without the local app (online on
// GitHub Pages, or the demo): this browser's IndexedDB. The local app keeps
// the same things as files on disk instead (app/store.py).
//
// Browser storage can be cleared by the browser: for a real installation,
// run the local app (Weathering.command). Export keeps a copy either way.

import { CSV_HEADER, readingToCsv, csvToReading } from "./protocol.js";

const DB = "weathering";
const VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("readings", { keyPath: ["show", "unix", "seq"] });
      db.createObjectStore("runs", { keyPath: ["show", "run"] });
      db.createObjectStore("meta", { keyPath: "show" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const range = (show) => IDBKeyRange.bound([show], [show, []]);

export class BrowserShow {
  constructor(name) {
    this.name = name;
    this.db = null;
  }

  async init(defaults) {
    this.db = await open();
    const m = await this.meta();
    if (!m) await this.saveMeta({ name: this.name, created: Math.floor(Date.now() / 1000), ...defaults });
    try { await navigator.storage?.persist?.(); } catch (_) { /* best effort */ }
    return this;
  }

  async meta() {
    const tx = this.db.transaction("meta");
    const req = tx.objectStore("meta").get(this.name);
    await done(tx);
    return req.result || null;
  }

  async saveMeta(m) {
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ ...m, show: this.name });
    await done(tx);
  }

  async addReading(r) {
    const tx = this.db.transaction("readings", "readwrite");
    tx.objectStore("readings").put({ show: this.name, ...r });
    await done(tx);
  }

  async readings() {
    const tx = this.db.transaction("readings");
    const req = tx.objectStore("readings").getAll(range(this.name));
    await done(tx);
    return req.result.map(({ show, ...r }) => r).sort((a, b) => a.unix - b.unix);
  }

  async addRun(run) {
    const tx = this.db.transaction("runs", "readwrite");
    tx.objectStore("runs").put({ show: this.name, ...run });
    await done(tx);
  }

  async runs() {
    const tx = this.db.transaction("runs");
    const req = tx.objectStore("runs").getAll(range(this.name));
    await done(tx);
    return req.result.map(({ show, ...r }) => r).sort((a, b) => a.run - b.run);
  }

  async clear() {
    const tx = this.db.transaction(["readings", "runs", "meta"], "readwrite");
    tx.objectStore("readings").delete(range(this.name));
    tx.objectStore("runs").delete(range(this.name));
    tx.objectStore("meta").delete(this.name);
    await done(tx);
  }

  // Bring a show in from exported files (readings CSV + runs JSONL).
  async importFiles(csvText, runsText) {
    const rows = csvText.split(/\r?\n/).map(csvToReading).filter(Boolean);
    const tx = this.db.transaction(["readings", "runs"], "readwrite");
    for (const r of rows) tx.objectStore("readings").put({ show: this.name, ...r });
    for (const line of (runsText || "").split(/\r?\n/)) {
      try { if (line.trim()) tx.objectStore("runs").put({ show: this.name, ...JSON.parse(line) }); } catch (_) {}
    }
    await done(tx);
    return rows.length;
  }
}

// Export: the same two files the local app keeps on disk.
export function exportFiles(name, readings, runs) {
  const csv = [CSV_HEADER, ...readings.map(readingToCsv)].join("\n") + "\n";
  const jsonl = runs.map((r) => JSON.stringify(r)).join("\n") + (runs.length ? "\n" : "");
  download(`${name}-readings.csv`, csv, "text/csv");
  download(`${name}-runs.jsonl`, jsonl, "application/json");
}

function download(filename, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
