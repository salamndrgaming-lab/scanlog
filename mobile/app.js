import { correct, redact } from "./extract.js";
import { SR, Segmenter, resampleTo16k, wavBlob, Store, Tracker, toCSV, toGeoJSON } from "./core.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tfmt = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const tfull = ts => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
const CATS = { violent: "Violent", fire: "Fire", ems: "EMS", traffic: "Traffic", property: "Property", other: "Other" };
const TEST = window.SCANLOG_TEST || null;

const VOCAB = "Memphis Shelby County dispatch radio. Engine, Ladder, Medic, Battalion, Squad, Sheriff, MPD, MFD. 10-4, en route, on scene. Poplar, Lamar, Elvis Presley, Getwell, Winchester, Shelby Drive, Summer, Jackson, Austin Peay, Covington Pike, Germantown Parkway, Kirby, Ridgeway, Mendenhall, Perkins, Highland, Airways, Millbranch, Union, Madison, Walnut Grove, Sam Cooper, Macon, Frayser, Hollywood, Chelsea, Knight Arnold, American Way, Tchulahoma, Hacks Cross, Raleigh LaGrange.";
const HALLUCINATION = /^\W*(thank you( for watching)?|thanks for watching|you|bye|please subscribe|subtitles by.*|\[.*\]|\(.*\)|\.+|music)\W*$/i;

/* ------------------------------------------------------------ settings */
const DEFAULTS = {
  source: "stream", feed: "", relay: "", channel: "Scanner", engine: "device", model: "Xenova/whisper-base.en",
  device: "auto", apiBase: "https://api.groq.com/openai/v1", apiKey: "", apiModel: "whisper-large-v3-turbo",
  threshold: 9, monitor: true, redact: true, keepAudioDays: 7,
};
let cfg = { ...DEFAULTS };
try { Object.assign(cfg, JSON.parse(localStorage.getItem("scanlog.cfg") || "{}")); } catch {}
const saveCfg = () => { try { localStorage.setItem("scanlog.cfg", JSON.stringify(cfg)); } catch {} };

function streamURL() {
  let u = cfg.feed.trim();
  if (/^\d+$/.test(u)) u = `https://broadcastify.cdnstream1.com/${u}`;
  if (cfg.relay.trim()) u = cfg.relay.trim().replace(/\/?$/, "/") + "?url=" + encodeURIComponent(u);
  else if (state.builtinRelay) u = "/api/relay?url=" + encodeURIComponent(u);   // built-in Vercel relay (api/relay.js)
  return u;
}
// The built-in relay only exists on the deployed site, not on a plain local server.
const canAutoRelay = () => !cfg.relay.trim() && !state.builtinRelay && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/* ------------------------------------------------------------ state */
const store = await new Store().open();
const tracker = new Tracker(store, TEST?.geocode ? { geocoder: TEST.geocode } : {});
const state = { running: false, queue: [], busy: false, cat: null, q: "", hours: 24, tab: "live", heard: 0, lastTx: null, modelStatus: "", builtinRelay: false, reconnecting: false };
let ctx, srcNode, capNode, gain, audioEl, micStream, seg, wakeLock, silentSince = null, worker, workerReqs = {}, reqId = 0;
const OPEN_TIMEOUT_MS = 15000;
const SILENT = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA";
let reconnectT = null, backoff = 2000, watchdog = null, lastPos = 0, stuckSince = null;

/* ------------------------------------------------------------ transcription */
function initWorker() {
  if (worker || TEST || cfg.engine !== "device") return;
  worker = new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") setModel(`Downloading model… ${Math.round(data.pct || 0)}%`);
    else if (data.type === "ready") setModel(`Whisper ready (${data.device === "webgpu" ? "GPU" : "CPU"})`);
    else if (data.id in workerReqs) {
      const { res, rej } = workerReqs[data.id]; delete workerReqs[data.id];
      data.type === "result" ? res(data.text) : rej(new Error(data.error));
    } else if (data.type === "error") setModel("Model error: " + data.error, true);
  };
  setModel("Loading model…");
  worker.postMessage({ type: "load", model: cfg.model, device: cfg.device });
}
function setModel(s, bad) { state.modelStatus = s; const el = $("#model"); if (el) { el.textContent = s; el.classList.toggle("bad", !!bad); } }

async function transcribe(samples) {
  if (TEST?.transcribe) return TEST.transcribe(samples);
  if (cfg.engine === "cloud") {
    if (!cfg.apiKey) throw new Error("Add an API key in Setup");
    const fd = new FormData();
    fd.append("file", wavBlob(samples), "clip.wav"); fd.append("model", cfg.apiModel);
    fd.append("language", "en"); fd.append("prompt", VOCAB);
    const r = await fetch(cfg.apiBase.replace(/\/$/, "") + "/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: fd });
    if (!r.ok) throw new Error(`Transcription API ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return ((await r.json()).text || "").trim();
  }
  initWorker();
  const id = ++reqId;
  return new Promise((res, rej) => { workerReqs[id] = { res, rej }; worker.postMessage({ type: "transcribe", id, samples, model: cfg.model, device: cfg.device }, [samples.buffer]); });
}

async function pump() {
  if (state.busy) return;
  state.busy = true;
  while (state.queue.length) {
    const s = state.queue.shift(); renderStatus();
    const audio = wavBlob(s.samples);
    try {
      let text = await transcribe(s.samples.slice());
      if (HALLUCINATION.test(text || ".") || text.length < 2) continue;
      text = correct(text);
      if (cfg.redact) text = redact(text, {});
      const { tx, incident, ex } = await tracker.ingest({ ts: s.start, text, channel: s.channel, source: s.channel, duration: +(s.samples.length / SR).toFixed(1), confidence: null, audio });
      state.lastTx = tx.ts; state.heard++;
      if (incident && ex.priority <= 1 && document.hidden === false && navigator.vibrate) navigator.vibrate(120);
      refresh();
    } catch (e) { toast(e.message); console.error(e); }
  }
  state.busy = false; renderStatus();
}
function enqueue(segs, channel) {
  for (const s of segs) { s.channel = channel; state.queue.push(s); }
  if (state.queue.length > 40) { state.queue.splice(0, state.queue.length - 40); toast("Transcription falling behind: dropped old clips. Try the tiny model or cloud."); }
  pump();
}

/* ------------------------------------------------------------ audio capture */
const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}
process(i){const c=i[0]&&i[0][0];if(c){this.b.push(c.slice());this.n+=c.length;if(this.n>=4096){const o=new Float32Array(this.n);let k=0;for(const x of this.b){o.set(x,k);k+=x.length}this.port.postMessage(o,[o.buffer]);this.b=[];this.n=0}}return true}}
registerProcessor('cap',Cap)`;

async function start() {
  if (state.running) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (cfg.source === "stream" && cfg.feed.trim()) {
    // iOS only lets audio start inside the tap itself. Unlock the element now, synchronously,
    // with a silent clip; later play() calls (relay retry, reconnects) are then allowed.
    audioEl = new Audio(); audioEl.crossOrigin = "anonymous"; audioEl.preload = "none";
    audioEl.src = SILENT; audioEl.play().catch(() => {});
    state.connecting = "connecting…"; renderStatus();
  }
  await ctx.resume();
  seg = new Segmenter({ threshold_db: +cfg.threshold });
  const chan = cfg.source === "mic" ? (cfg.channel || "Mic") : (cfg.channel || "Stream");
  if (cfg.source === "mic") {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    srcNode = ctx.createMediaStreamSource(micStream);
  } else {
    if (!cfg.feed.trim()) { toast("Enter a Broadcastify feed ID or stream URL in Setup"); go("setup"); ctx.close(); return; }
    state.builtinRelay = false; backoff = 2000;
    // Edge relays cut long responses off and feeds drop: while listening, reconnect the same
    // element (same segmenter and queue, so nothing already captured is lost).
    audioEl.onerror = audioEl.onended = () => scheduleReconnect();
    audioEl.onplaying = () => { if (state.reconnecting) { state.reconnecting = false; renderStatus(); } backoff = 2000; };
    srcNode = ctx.createMediaElementSource(audioEl);
    gain = ctx.createGain(); gain.gain.value = cfg.monitor ? 1 : 0;
    srcNode.connect(gain).connect(ctx.destination);
    let why = "";
    const open = async () => {   // never hang: give up after OPEN_TIMEOUT_MS
      if (!audioEl) return false;   // Stop tapped while connecting
      audioEl.src = streamURL();
      let timer;
      try {
        await Promise.race([audioEl.play(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("no answer from the stream")), OPEN_TIMEOUT_MS); })]);
        return true;
      } catch (e) {
        const code = audioEl?.error?.code;
        why = e.name === "NotAllowedError" ? "the browser blocked audio playback" : code ? ["", "aborted", "network error", "can't decode the audio", "stream refused or not found"][code] : e.message;
        audioEl?.pause(); return false;
      } finally { clearTimeout(timer); }
    };
    let ok = await open();
    if (!ok && canAutoRelay()) { state.builtinRelay = true; state.connecting = "connecting via relay…"; renderStatus(); ok = await open(); }   // retry once via /api/relay
    if (!state.connecting) return;   // stopped while connecting
    state.connecting = "";
    if (!ok) {
      state.builtinRelay = false;
      await stop();
      banner(`Couldn't open this stream (${why}). Check the feed ID. If the feed plays in the Broadcastify app, its server is blocking browser access: add a relay in Setup (see README), or switch to Microphone mode.`);
      return;
    }
    lastPos = 0; stuckSince = null;
    watchdog = setInterval(() => {   // a cut-off stream sometimes just stalls without error/ended
      if (!state.running || !audioEl || state.reconnecting || audioEl.paused) return;
      if (audioEl.currentTime !== lastPos) { lastPos = audioEl.currentTime; stuckSince = null; }
      else if ((stuckSince ??= Date.now()) && Date.now() - stuckSince > 20000) { stuckSince = null; scheduleReconnect(); }
    }, 5000);
  }
  const onChunk = buf => {
    const s16 = resampleTo16k(buf, ctx.sampleRate);
    let peak = 0; for (let i = 0; i < s16.length; i += 8) peak = Math.max(peak, Math.abs(s16[i]));
    if (cfg.source === "stream" && audioEl && !audioEl.paused) {   // tainted (CORS) streams deliver pure zeros
      if (peak === 0) { silentSince ??= Date.now(); if (Date.now() - silentSince > 15000) banner("Getting only silence from this stream. If you can hear it but nothing is logged, the server blocks in-browser processing: add a relay in Setup or use Microphone mode."); }
      else { silentSince = null; hideBanner(); }
    }
    enqueue(seg.feed(s16), chan); meter(seg.level);
  };
  if (ctx.audioWorklet) {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    capNode = new AudioWorkletNode(ctx, "cap"); capNode.port.onmessage = e => onChunk(e.data);
    const sink = ctx.createGain(); sink.gain.value = 0;
    srcNode.connect(capNode).connect(sink).connect(ctx.destination);
  } else {
    capNode = ctx.createScriptProcessor(4096, 1, 1); capNode.onaudioprocess = e => onChunk(e.inputBuffer.getChannelData(0).slice());
    const sink = ctx.createGain(); sink.gain.value = 0;
    srcNode.connect(capNode).connect(sink).connect(ctx.destination);
  }
  state.running = true; initWorker(); keepAwake();
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: "ScanLog listening", artist: chan });
  renderStatus();
}

function scheduleReconnect() {
  if (!state.running || cfg.source !== "stream" || !audioEl || reconnectT) return;
  state.reconnecting = true; hideBanner(); renderStatus();
  const delay = backoff; backoff = Math.min(backoff * 2, 30000);   // 2 s, 4, 8, 16, 30, 30…
  reconnectT = setTimeout(async () => {
    reconnectT = null;
    if (!state.running || !audioEl) return;
    audioEl.src = streamURL();
    try { await audioEl.play(); } catch { scheduleReconnect(); }
  }, delay);
}

async function stop() {
  state.running = false; state.connecting = "";
  clearTimeout(reconnectT); reconnectT = null; clearInterval(watchdog); watchdog = null; state.reconnecting = false;
  if (audioEl) audioEl.onerror = audioEl.onended = audioEl.onplaying = null;
  try { enqueue(seg?.flush() || [], cfg.channel); } catch {}
  audioEl?.pause(); if (audioEl) audioEl.src = ""; audioEl = null;
  micStream?.getTracks().forEach(t => t.stop()); micStream = null;
  try { await ctx?.close(); } catch {}
  wakeLock?.release?.(); wakeLock = null; hideBanner(); renderStatus();
}

async function keepAwake() {
  try { if ("wakeLock" in navigator && state.running) wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepAwake(); });

async function importFile(file) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(await file.arrayBuffer()); ac.close();
  const s16 = resampleTo16k(buf.getChannelData(0), buf.sampleRate);
  const sgm = new Segmenter({ threshold_db: +cfg.threshold });
  const start = Date.now() / 1000 - buf.duration;
  const segs = []; let first = true;
  for (let i = 0; i < s16.length; i += SR) { segs.push(...sgm.feed(s16.subarray(i, i + SR), first ? start : undefined)); first = false; }
  segs.push(...sgm.flush());
  toast(`${segs.length} transmissions found in ${file.name}; transcribing…`);
  initWorker(); enqueue(segs, file.name.replace(/\.[^.]+$/, ""));
}

/* ------------------------------------------------------------ UI */
let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 4500); }
function banner(m) { const b = $("#banner"); b.textContent = m; b.hidden = false; }
function hideBanner() { $("#banner").hidden = true; }
function meter(db) { const m = $("#meter i"); if (m) m.style.width = Math.max(0, Math.min(100, (db + 70) * 1.6)) + "%"; }

function renderStatus() {
  $("#go").textContent = state.running || state.connecting ? "Stop listening" : "Start listening";
  $("#go").classList.toggle("on", !!(state.running || state.connecting));
  $("#dot").classList.toggle("on", state.running);
  $("#srcline").textContent = state.connecting ? state.connecting : state.running ? (state.reconnecting ? "reconnecting…" : cfg.source === "mic" ? "Microphone" : (cfg.channel || "Stream")) : "Not listening";
  $("#queue").textContent = state.queue.length || state.busy ? `${state.queue.length + (state.busy ? 1 : 0)} clip(s) transcribing` : "";
}

function go(tab) {
  state.tab = tab;
  document.querySelectorAll("[data-view]").forEach(v => v.hidden = v.dataset.view !== tab);
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === tab));
  if (tab === "map") setTimeout(drawMap, 50);
  refresh();
}

async function refresh() {
  const since = Date.now() / 1000 - state.hours * 3600;
  let incs = await store.recentIncidents(since);
  const txs = await store.recentTx(Date.now() / 1000 - 6 * 3600);
  $("#stat").innerHTML = `<b>${incs.length}</b> incidents · <b>${incs.filter(i => i.status !== "closed").length}</b> active · <b>${txs.length}</b> tx (6h)`;
  if (state.cat) incs = incs.filter(i => i.category === state.cat);
  if (state.q) {
    const q = state.q.toLowerCase();
    const hitIds = new Set(txs.filter(t => (t.text || "").toLowerCase().includes(q)).map(t => t.incident_id));
    incs = incs.filter(i => hitIds.has(i.id) || [i.type, i.address, i.units.join(" ")].join(" ").toLowerCase().includes(q));
  }
  state.incs = incs;
  $("#txfeed").innerHTML = txs.slice(0, 80).map(t => `
    <div class="tx ${t.type ? "hit" : ""}" ${t.incident_id ? `data-inc="${t.incident_id}"` : ""}>
      <div class="m">${tfmt(t.ts)} · ${esc(t.channel)}${t.type ? ` · <span style="color:var(--${t.category})">${esc(t.type)}</span>` : ""}</div>
      <div>${esc(t.text)}</div></div>`).join("") || `<p class="empty">Radio traffic shows up here as it's transcribed.</p>`;
  $("#list").innerHTML = incs.map(i => `
    <div class="inc" data-inc="${i.id}" style="--c:var(--${i.category || "other"})">
      <div class="r"><b>${esc(i.type || "Radio traffic")}</b><span class="m">${tfmt(i.created)}</span></div>
      <div class="addr">${esc(i.address || "Location not stated")}</div>
      <div class="r"><span class="m u">${esc(i.units.slice(0, 5).join(" · "))}</span>
      <span class="badge ${i.status === "closed" ? "closed" : i.last_status}">${i.status === "closed" ? "closed" : esc((i.last_status || "").replace("_", " "))}</span></div>
    </div>`).join("") || `<p class="empty">No incidents in this window yet.</p>`;
  if (state.tab === "map") drawMap();
}

let map, layer;
function drawMap() {
  if (!window.L) { $("#map").innerHTML = `<p class="empty">Map needs a connection.</p>`; return; }
  if (!map) {
    map = L.map("map", { zoomControl: false }).setView([35.12, -89.95], 10);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { attribution: "© OpenStreetMap © CARTO", maxZoom: 19 }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  map.invalidateSize(); layer.clearLayers();
  const css = getComputedStyle(document.documentElement);
  for (const i of state.incs || []) if (i.lat != null) {
    const c = css.getPropertyValue("--" + (i.category || "other")).trim();
    L.circleMarker([i.lat, i.lon], { radius: i.priority <= 1 ? 10 : 7, color: c, fillColor: c, fillOpacity: i.status === "closed" ? .25 : .8, weight: 2 })
      .on("click", () => openInc(i.id)).addTo(layer);
  }
}

async function openInc(id) {
  const i = await store.get("inc", id); if (!i) return;
  const txs = (await store.txFor(id)).sort((a, b) => a.ts - b.ts);
  $("#sheet .hd").innerHTML = `
    <div class="m" style="color:var(--${i.category || "other"})">${esc((CATS[i.category] || "Other").toUpperCase())} · #${i.id}</div>
    <h2>${esc(i.type || "Radio traffic")}</h2>
    <div>${esc(i.address || "Location not stated")}</div>
    ${i.geo_matched ? `<div class="m">↳ ${esc(i.geo_matched)}</div>` : i.address ? `<div class="m">Not mapped</div>` : ""}
    <div class="m">${tfull(i.created)} → ${tfmt(i.updated)} · ${i.tx_count} transmissions</div>
    <div class="m u">${esc(i.units.join(" · "))}</div>`;
  $("#sheet .bd").innerHTML = txs.map(t => `
    <div class="dtx"><div class="m">${tfull(t.ts)} · ${esc(t.channel)} · ${t.duration}s${t.status ? " · " + esc(t.status.replace("_", " ")) : ""}</div>
    <div>${esc(t.text)}</div>${t.has_audio ? `<button class="play" data-tx="${t.id}">▶ Play</button>` : ""}</div>`).join("");
  $("#sheet").classList.add("open"); $("#scrim").hidden = false;
}
function closeSheet() { $("#sheet").classList.remove("open"); $("#scrim").hidden = true; }

async function exportFile(kind) {
  const incs = await store.recentIncidents(Date.now() / 1000 - state.hours * 3600);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  let body, name, type;
  if (kind === "csv") [body, name, type] = [toCSV(incs), `incidents-${stamp}.csv`, "text/csv"];
  else if (kind === "geojson") [body, name, type] = [toGeoJSON(incs), `incidents-${stamp}.geojson`, "application/geo+json"];
  else {
    const lines = [`# Scanner incident log — ${new Date().toLocaleDateString()}`, "", `${incs.length} incidents`, ""];
    for (const i of [...incs].reverse()) {
      lines.push(`## ${tfmt(i.created)} ${i.type || "Call"} — ${i.address || "location unknown"}`, `Units: ${i.units.join(", ") || "—"} · status: ${i.last_status}`);
      for (const t of (await store.txFor(i.id)).sort((a, b) => a.ts - b.ts)) lines.push(`- ${tfmt(t.ts)} ${t.text}`);
      lines.push("");
    }
    lines.push("_Automated transcription of public radio. Unverified._");
    [body, name, type] = [lines.join("\n"), `incident-log-${stamp}.md`, "text/markdown"];
  }
  const file = new File([body], name, { type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; a.click();
}

/* ------------------------------------------------------------ wire up */
function bindSetup() {
  const f = $("#setupForm");
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") el.checked = !!cfg[el.name];
    else if (el.type === "radio") el.checked = cfg[el.name] === el.value;
    else el.value = cfg[el.name] ?? "";
  }
  const vis = () => {
    f.querySelectorAll("[data-when]").forEach(x => { const [k, v] = x.dataset.when.split("="); x.hidden = cfg[k] !== v; });
    $("#thrv").textContent = cfg.threshold;
  };
  f.addEventListener("input", e => {
    const el = e.target; if (!el.name) return;
    cfg[el.name] = el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value;
    saveCfg(); vis();
    if (el.name === "monitor" && gain) gain.gain.value = cfg.monitor ? 1 : 0;
    if (["model", "engine", "device"].includes(el.name)) { worker?.terminate(); worker = null; setModel(""); }
  });
  f.addEventListener("submit", e => e.preventDefault());
  vis();
}

$("#go").onclick = () => (state.running || state.connecting ? stop() : start().catch(async e => { await stop(); banner("Couldn't start listening: " + e.message); }));
document.querySelectorAll("nav button").forEach(b => b.onclick = () => go(b.dataset.tab));
document.body.addEventListener("click", async e => {
  const inc = e.target.closest("[data-inc]"); if (inc) return openInc(+inc.dataset.inc);
  const p = e.target.closest(".play");
  if (p) { const blob = await store.get("audio", +p.dataset.tx); if (blob) { const a = new Audio(URL.createObjectURL(blob)); a.play(); } else toast("Audio expired"); }
  const x = e.target.closest("[data-export]"); if (x) exportFile(x.dataset.export);
});
$("#scrim").onclick = closeSheet; $("#sheet .x").onclick = closeSheet;
$("#chips").innerHTML = `<button data-c="" aria-pressed="true">All</button>` + Object.entries(CATS).map(([k, v]) => `<button data-c="${k}" aria-pressed="false"><i style="background:var(--${k})"></i>${v}</button>`).join("");
$("#chips").onclick = e => { const b = e.target.closest("button"); if (!b) return; state.cat = b.dataset.c || null; $("#chips").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); refresh(); };
$("#hours").onchange = e => { state.hours = +e.target.value; refresh(); };
let qt; $("#q").oninput = e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); refresh(); }, 250); };
$("#file").onchange = e => { const f = e.target.files[0]; if (f) importFile(f).catch(err => toast(err.message)); e.target.value = ""; };
$("#clear").onclick = async () => { if ($("#clear").dataset.armed) { await store.clear(); delete $("#clear").dataset.armed; $("#clear").textContent = "Delete all data"; refresh(); toast("All data deleted"); } else { $("#clear").dataset.armed = 1; $("#clear").textContent = "Tap again to confirm"; } };
$("#preload").onclick = () => { if (cfg.engine !== "device") return toast("On-device engine not selected"); worker?.terminate(); worker = null; initWorker(); };

bindSetup(); renderStatus(); go(cfg.feed || cfg.source === "mic" ? "live" : "setup");
if (!cfg.feed && cfg.source !== "mic") toast("Start by choosing an audio source");
setInterval(() => { tracker.housekeeping(); }, 60000);
store.prune(cfg.keepAudioDays).catch(() => {});
setInterval(refresh, 10000);
if ("serviceWorker" in navigator && !TEST) navigator.serviceWorker.register("./sw.js").catch(() => {});
window.__scanlog = { store, tracker, enqueue, importFile, state };
