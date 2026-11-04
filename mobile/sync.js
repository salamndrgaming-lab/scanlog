// Live sync between the PC "station" and phone "viewers" via /api/sync (api/sync.js).
// RemoteStore has the same read methods app.js uses on the local IndexedDB Store, so the
// Incidents list, Map, detail sheet and exports work unchanged on a viewer.
import { wavBlob } from "./core.js";

const API = "/api/sync";
export const clipId = tx => `${Math.round(tx.ts * 1000)}_${tx.id}`;

async function call(key, { method = "GET", query = "", body } = {}) {
  const r = await fetch(API + query, { method, headers: { "X-Sync-Key": key, ...(body ? { "Content-Type": "text/plain" } : {}) }, body, cache: "no-store" });
  if (r.status === 204) return { status: 204 };
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) return { status: r.status, blob: r.ok ? await r.blob() : null };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || j.error || `sync ${r.status}`); e.code = j.error; e.status = r.status; throw e; }
  return { status: r.status, json: j };
}

/* ------------------------------------------------------------ viewer */
export class RemoteStore {
  constructor(key) { this.key = key; this.snap = { updated: 0, incs: [], tx: [] }; this.error = null; this.lastPoll = 0; }
  async open() { await this.poll().catch(() => {}); return this; }
  /** Fetch a newer snapshot if there is one. Returns true when data changed. */
  async poll() {
    this.lastPoll = Date.now();
    try {
      const r = await call(this.key, { query: this.snap.updated ? `?since=${this.snap.updated}` : "" });
      this.error = null;
      if (r.status === 204 || !r.json) return false;
      this.snap = { updated: r.json.updated || 0, incs: r.json.incs || [], tx: r.json.tx || [] };
      return true;
    } catch (e) { this.error = e; throw e; }
  }
  async recentIncidents(since) { return this.snap.incs.filter(i => i.updated >= since).sort((a, b) => b.updated - a.updated); }
  async recentTx(since) { return this.snap.tx.filter(t => t.ts >= since).sort((a, b) => b.ts - a.ts); }
  async txFor(iid) { return this.snap.tx.filter(t => t.incident_id === iid); }
  async get(store, key) {
    if (store === "inc") return this.snap.incs.find(i => i.id === key);
    if (store === "audio") {
      const tx = this.snap.tx.find(t => t.id === key);
      if (!tx) return undefined;
      try { return (await call(this.key, { query: `?clip=${clipId(tx)}` })).blob || undefined; } catch { return undefined; }
    }
  }
  async clear() { throw new Error("This phone is a viewer: delete data on the PC."); }
  async prune() {}
}

/* ------------------------------------------------------------ station */
const MIN_PUSH_MS = 20000;   // keeps the free database well under its monthly command allowance

export class Pusher {
  constructor(store, getKey, onStatus) { this.store = store; this.getKey = getKey; this.onStatus = onStatus; this.timer = null; this.last = 0; this.clips = []; this.sending = false; }
  enabled() { return (this.getKey() || "").length >= 6; }
  /** Ask for a snapshot upload soon (rate-limited). */
  schedule() {
    if (!this.enabled() || this.timer) return;
    const wait = Math.max(1500, MIN_PUSH_MS - (Date.now() - this.last));
    this.timer = setTimeout(() => { this.timer = null; this.pushSnapshot(); }, wait);
  }
  async pushSnapshot() {
    if (!this.enabled()) return;
    this.last = Date.now();
    try {
      const now = Date.now() / 1000;
      const incs = await this.store.recentIncidents(now - 24 * 3600);
      const ids = new Set(incs.map(i => i.id));
      const tx = (await this.store.recentTx(now - 24 * 3600)).filter(t => t.ts >= now - 6 * 3600 || ids.has(t.incident_id)).slice(0, 2500);
      await call(this.getKey(), { method: "POST", body: JSON.stringify({ updated: Date.now(), incs, tx }) });
      this.onStatus?.(null, Date.now());
    } catch (e) { this.onStatus?.(e); }
  }
  /** Queue one transmission's audio (16 kHz Float32) for upload at 8 kHz to keep clips small. */
  clip(tx, samples16k) {
    if (!this.enabled() || !tx.has_audio) return;
    const n = samples16k.length >> 1, s8 = new Float32Array(n);
    for (let i = 0; i < n; i++) s8[i] = (samples16k[2 * i] + samples16k[2 * i + 1]) / 2;
    this.clips.push([clipId(tx), wavBlob(s8, 8000)]);
    if (this.clips.length > 30) this.clips.shift();
    this.drain();
  }
  async drain() {
    if (this.sending) return;
    this.sending = true;
    while (this.clips.length) {
      const [id, blob] = this.clips.shift();
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await call(this.getKey(), { method: "POST", query: `?clip=${id}`, body: btoa(bin) });
      } catch (e) { this.onStatus?.(e); }
    }
    this.sending = false;
  }
}
