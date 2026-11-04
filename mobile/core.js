// Segmenter, storage, geocoding and incident grouping for the phone app.
// Mirrors scanlog/segmenter.py, db.py, geocode.py and incidents.py.
import { extract, normalizeAddress, STATUS_ORDER } from "./extract.js";

export const SR = 16000;

/* ------------------------------------------------------------ segmenter */
export class Segmenter {
  constructor(o = {}) {
    this.frame = Math.round(SR * 0.02);
    this.threshold = o.threshold_db ?? 9;
    this.minLevel = o.min_level_dbfs ?? -50;
    this.hang = Math.round((o.hangover_s ?? 1.0) / 0.02);
    this.minFrames = Math.round((o.min_segment_s ?? 0.8) / 0.02);
    this.maxFrames = Math.round((o.max_segment_s ?? 45) / 0.02);
    this.preFrames = Math.round(0.25 / 0.02);
    this.hist = []; this.pre = []; this.buf = new Float32Array(0);
    this.active = null; this.voiced = 0; this.silent = 0; this.clock = null; this.level = -90;
  }
  floor() {
    if (this.hist.length < 25) return -70;
    const s = [...this.hist].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.15)];
  }
  /** samples: Float32Array @16 kHz. Returns finished segments [{samples, start}] */
  feed(samples, now) {
    if (this.clock === null) this.clock = now ?? Date.now() / 1000;
    const b = new Float32Array(this.buf.length + samples.length);
    b.set(this.buf); b.set(samples, this.buf.length);
    const out = []; let i = 0;
    for (; i + this.frame <= b.length; i += this.frame) {
      const f = b.subarray(i, i + this.frame);
      const ts = this.clock; this.clock += 0.02;
      const seg = this._frame(f.slice(), ts);
      if (seg) out.push(seg);
    }
    this.buf = b.slice(i);
    return out;
  }
  _frame(f, ts) {
    let s = 0; for (let k = 0; k < f.length; k++) s += f[k] * f[k];
    const lvl = 20 * Math.log10(Math.sqrt(s / f.length) + 1e-9);
    this.level = lvl;
    const floor = this.floor();
    const voiced = lvl > this.minLevel && lvl > floor + this.threshold;
    if (!this.active) { this.hist.push(lvl); if (this.hist.length > 1000) this.hist.shift(); }
    if (this.active) {
      this.active.push(f);
      if (voiced) { this.voiced++; this.silent = 0; } else this.silent++;
      if (this.silent >= this.hang || this.active.length >= this.maxFrames) return this._close();
    } else if (voiced) {
      this.active = [...this.pre, f]; this.start = ts - this.pre.length * 0.02;
      this.voiced = 1; this.silent = 0; this.pre = [];
    } else { this.pre.push(f); if (this.pre.length > this.preFrames) this.pre.shift(); }
    return null;
  }
  _close() {
    let frames = this.active; const voiced = this.voiced;
    const keep = Math.min(this.silent, 15);
    if (this.silent > keep) frames = frames.slice(0, frames.length - (this.silent - keep));
    this.active = null; this.voiced = 0; this.silent = 0;
    if (voiced < this.minFrames) return null;
    const out = new Float32Array(frames.length * this.frame);
    frames.forEach((f, j) => out.set(f, j * this.frame));
    return { samples: out, start: this.start };
  }
  flush() { return this.active ? [this._close()].filter(Boolean) : []; }
}

export function resampleTo16k(input, fromRate) {
  if (fromRate === SR) return input;
  const ratio = fromRate / SR, n = Math.floor(input.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {   // box filter + linear pick: adequate for narrowband radio audio
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let s = 0; for (let k = a; k < b; k++) s += input[k];
    out[i] = b > a ? s / (b - a) : input[a] || 0;
  }
  return out;
}

export function wavBlob(samples, rate = SR) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([buf], { type: "audio/wav" });
}

/* ------------------------------------------------------------ storage (IndexedDB) */
export class Store {
  async open() {
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open("scanlog", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        const tx = d.createObjectStore("tx", { keyPath: "id", autoIncrement: true });
        tx.createIndex("ts", "ts"); tx.createIndex("incident_id", "incident_id");
        d.createObjectStore("inc", { keyPath: "id", autoIncrement: true }).createIndex("updated", "updated");
        d.createObjectStore("audio");
        d.createObjectStore("geo");
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this;
  }
  _req(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), r = fn(t.objectStore(store));
      t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error);
    });
  }
  put(store, val, key) { return this._req(store, "readwrite", s => s.put(val, key)); }
  get(store, key) { return this._req(store, "readonly", s => s.get(key)); }
  del(store, key) { return this._req(store, "readwrite", s => s.delete(key)); }
  all(store) { return this._req(store, "readonly", s => s.getAll()); }
  byIndex(store, index, range) { return this._req(store, "readonly", s => s.index(index).getAll(range)); }
  async recentIncidents(sinceTs) { return (await this.byIndex("inc", "updated", IDBKeyRange.lowerBound(sinceTs))).sort((a, b) => b.updated - a.updated); }
  async recentTx(sinceTs) { return (await this.byIndex("tx", "ts", IDBKeyRange.lowerBound(sinceTs))).sort((a, b) => b.ts - a.ts); }
  txFor(iid) { return this.byIndex("tx", "incident_id", IDBKeyRange.only(iid)); }
  async clear() { for (const s of ["tx", "inc", "audio"]) await this._req(s, "readwrite", st => st.clear()); }
  async prune(days) {
    const cut = Date.now() / 1000 - days * 86400;
    const old = await this.byIndex("tx", "ts", IDBKeyRange.upperBound(cut));
    for (const t of old) await this.del("audio", t.id);
  }
}

/* ------------------------------------------------------------ geocoding (OSM Nominatim, CORS-friendly) */
const BBOX = { s: 34.99, w: -90.32, n: 35.43, e: -89.63 };
const inside = (lat, lon) => lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;
let lastNom = 0, nomChain = Promise.resolve();

async function nom(q, extra = {}) {
  // Nominatim policy: max 1 request/second
  const run = async () => {
    const wait = 1100 - (Date.now() - lastNom); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNom = Date.now();
    const p = new URLSearchParams({ q, format: "jsonv2", countrycodes: "us", viewbox: `${BBOX.w},${BBOX.n},${BBOX.e},${BBOX.s}`, bounded: 1, ...extra });
    const r = await fetch("https://nominatim.openstreetmap.org/search?" + p);
    if (!r.ok) throw new Error("geocode " + r.status);
    return (await r.json()).filter(m => inside(+m.lat, +m.lon));
  };
  const p = nomChain.then(run, run); nomChain = p.catch(() => {}); return p;
}

async function streetPoints(street) {
  const pts = [];
  for (const m of await nom(`${street}, Shelby County, TN`, { limit: 15, polygon_geojson: 1 })) {
    const g = m.geojson || {};
    if (g.type === "LineString") pts.push(...g.coordinates);
    if (g.type === "MultiLineString") g.coordinates.forEach(l => pts.push(...l));
  }
  return pts;
}

export async function geocode(store, address, kind) {
  if (!address) return null;
  const key = address.toLowerCase();
  const cached = await store.get("geo", key);
  if (cached !== undefined) return cached;
  let res = null;
  try {
    if (address.includes(" & ")) {          // intersection: nearest vertices of the two streets
      const [a, b] = address.split("&").map(s => s.trim());
      const [pa, pb] = [await streetPoints(a), await streetPoints(b)];
      let best = null;
      for (const [x1, y1] of pa) for (const [x2, y2] of pb) {
        const d = (x1 - x2) ** 2 + ((y1 - y2) * 1.22) ** 2;
        if (!best || d < best[0]) best = [d, (y1 + y2) / 2, (x1 + x2) / 2];
      }
      if (best && Math.sqrt(best[0]) * 91000 < 120) res = { lat: best[1], lon: best[2], matched: `${a} & ${b}` };
    }
    if (!res) {
      const q = address.replace(/ block /, " ").replace(" & ", " and ").replace(/ on /, ", ");
      const m = (await nom(`${q}, Memphis, TN`, { limit: 3 }))[0];
      if (m) res = { lat: +m.lat, lon: +m.lon, matched: m.display_name.slice(0, 120) };
    }
  } catch (e) { console.warn(e); return null; }   // network error: don't cache
  await store.put("geo", res, key);
  return res;
}

/* ------------------------------------------------------------ incident grouping */
const rank = s => (s === "open" ? -1 : STATUS_ORDER.indexOf(s));
function haversine(a, b) {
  const R = Math.PI / 180, h = Math.sin((b[0] - a[0]) * R / 2) ** 2 + Math.cos(a[0] * R) * Math.cos(b[0] * R) * Math.sin((b[1] - a[1]) * R / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

export class Tracker {
  constructor(store, opts = {}) {
    this.store = store;
    this.o = { address_window_min: 45, unit_window_min: 20, channel_window_s: 90, close_after_min: 90, merge_distance_m: 200, ...opts };
    this.lastOnChannel = {};
    this.geocoder = opts.geocoder || ((addr, kind) => geocode(store, addr, kind));
  }

  /** Store one transcribed transmission and attach it to an incident. Returns {tx, incident}. */
  async ingest({ ts, text, channel, source, duration, confidence, audio }) {
    const ex = extract(text);
    const tx = { ts, text, channel, source, duration, confidence, category: ex.category, type: ex.incident_type,
      address: ex.address, units: ex.units, codes: ex.codes, status: ex.status, incident_id: null, has_audio: !!audio };
    tx.id = await this.store.put("tx", tx);
    if (audio) await this.store.put("audio", audio, tx.id);
    const inc = text ? await this.assign(tx, ex) : null;
    if (inc) { tx.incident_id = inc.id; await this.store.put("tx", tx); }
    return { tx, incident: inc, ex };
  }

  async assign(tx, ex) {
    const o = this.o, ts = tx.ts, norm = normalizeAddress(ex.address);
    const recent = (await this.store.recentIncidents(ts - o.address_window_min * 60)).filter(i => i.status !== "closed");
    let inc = null;
    const loc = ex.address ? await this.geocoder(ex.address, ex.address_kind) : null;
    if (norm) {
      inc = recent.find(i => i.norm_address === norm) || null;
      if (!inc && loc) inc = recent.find(i => i.lat != null && haversine([i.lat, i.lon], [loc.lat, loc.lon]) < o.merge_distance_m &&
        (!ex.category || !i.category || i.category === ex.category)) || null;
    }
    if (!inc && !norm && ex.units.length) {
      const win = ts - o.unit_window_min * 60;
      inc = recent.find(i => i.updated >= win && i.units.some(u => ex.units.includes(u))) || null;
    }
    if (!inc && !norm && this.lastOnChannel[tx.channel]) {
      const [t0, iid] = this.lastOnChannel[tx.channel];
      if (ts - t0 <= o.channel_window_s && (ex.incident_type || ex.status || ex.units.length)) {
        const c = await this.store.get("inc", iid);
        if (c && c.status !== "closed") inc = c;
      }
    }
    if (!inc) {
      if (!ex.incident_type && !norm) return null;
      inc = { created: ts, updated: ts, category: ex.category, type: ex.incident_type, priority: ex.priority,
        address: ex.address, norm_address: norm, address_kind: ex.address_kind, lat: loc?.lat ?? null, lon: loc?.lon ?? null,
        geo_matched: loc?.matched ?? null, units: ex.units, status: "open", last_status: ex.status || "dispatched",
        summary: `${ex.incident_type || "Call"}${ex.address ? " at " + ex.address : ""}`, channels: [tx.channel], tx_count: 1 };
      inc.id = await this.store.put("inc", inc);
    } else {
      inc.updated = Math.max(ts, inc.updated); inc.tx_count++;
      if (ex.incident_type && (!inc.type || ex.priority < inc.priority)) Object.assign(inc, { type: ex.incident_type, category: ex.category, priority: ex.priority });
      if (ex.address && !inc.address) Object.assign(inc, { address: ex.address, norm_address: norm, address_kind: ex.address_kind });
      else if (ex.address_kind === "address" && ["intersection", "landmark", "block"].includes(inc.address_kind)) Object.assign(inc, { address: ex.address, address_kind: "address" });
      if (loc && (inc.lat == null || ex.address_kind === "address")) Object.assign(inc, { lat: loc.lat, lon: loc.lon, geo_matched: loc.matched });
      inc.units = [...new Set([...inc.units, ...ex.units])];
      if (ex.status && rank(ex.status) >= rank(inc.last_status || "open")) inc.last_status = ex.status;
      if (tx.channel && !inc.channels.includes(tx.channel)) inc.channels.push(tx.channel);
      await this.store.put("inc", inc);
    }
    this.lastOnChannel[tx.channel] = [ts, inc.id];
    return inc;
  }

  async housekeeping(now = Date.now() / 1000) {
    const cut = now - this.o.close_after_min * 60;
    for (const i of await this.store.recentIncidents(now - 7 * 86400))
      if (i.status !== "closed" && i.updated < cut) { i.status = "closed"; await this.store.put("inc", i); }
  }
}

/* ------------------------------------------------------------ exports */
const fmt = ts => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);
export function toCSV(incs) {
  const cols = ["id", "created", "updated", "category", "type", "priority", "address", "lat", "lon", "units", "last_status", "status", "tx_count"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...incs.map(i => cols.map(c => q(c === "created" || c === "updated" ? fmt(i[c]) : c === "units" ? i.units.join("; ") : i[c])).join(","))].join("\n");
}
export function toGeoJSON(incs) {
  return JSON.stringify({ type: "FeatureCollection", features: incs.filter(i => i.lat != null).map(i => ({
    type: "Feature", geometry: { type: "Point", coordinates: [i.lon, i.lat] },
    properties: { id: i.id, type: i.type, category: i.category, address: i.address, units: i.units.join("; "),
      created: fmt(i.created), status: i.last_status } })) }, null, 1);
}
