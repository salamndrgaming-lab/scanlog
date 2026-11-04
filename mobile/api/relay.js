// Vercel Edge Function: same-origin stream relay for feeds whose servers don't send CORS
// headers. Port of relay-worker.js. Only relays the audio-stream hosts below, so it can't
// be used as an open proxy. Edge responses have a duration limit; the app reconnects.
// Add &probe=1 to get a JSON report of what the upstream server answered (for debugging).
export const config = { runtime: "edge" };

const ALLOWED = [/(^|\.)broadcastify\.com$/, /(^|\.)cdnstream1\.com$/, /(^|\.)radioreference\.com$/];
const CORS = { "Access-Control-Allow-Origin": "*" };
const HEADERS_TIMEOUT_MS = 12000;

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" } });
  const params = new URL(req.url).searchParams;
  const target = params.get("url");
  if (!target) return new Response("usage: ?url=<stream>", { status: 400, headers: CORS });
  let u;
  try { u = new URL(target); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
  if (!/^https?:$/.test(u.protocol) || !ALLOWED.some(r => r.test(u.hostname))) return new Response("host not allowed", { status: 403, headers: CORS });

  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEADERS_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 ScanLog-relay", "Accept": "audio/*,*/*" }, redirect: "follow", signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    const msg = ac.signal.aborted ? `upstream did not answer within ${HEADERS_TIMEOUT_MS / 1000}s` : `upstream fetch failed: ${e.message}`;
    console.log(`relay ${u.href} -> ERROR ${msg}`);
    if (params.get("probe")) return Response.json({ target: u.href, error: msg, ms: Date.now() - t0 }, { status: 504, headers: CORS });
    return new Response(msg, { status: 504, headers: CORS });
  }
  clearTimeout(timer);
  console.log(`relay ${u.href} -> ${upstream.status} ${upstream.headers.get("content-type")} final=${upstream.url} ${Date.now() - t0}ms`);

  if (params.get("probe")) {   // read a little of the body, then report
    let bytes = 0, firstBytesMs = null, sample = "";
    const reader = upstream.body?.getReader();
    const stopAt = Date.now() + 8000;
    try {
      while (reader && bytes < 16384 && Date.now() < stopAt) {
        const r = await Promise.race([reader.read(), new Promise(res => setTimeout(() => res({ timeout: true }), Math.max(1, stopAt - Date.now())))]);
        if (r.timeout || r.done) break;
        if (firstBytesMs === null) { firstBytesMs = Date.now() - t0; sample = new TextDecoder("latin1").decode(r.value.slice(0, 200)); }
        bytes += r.value.length;
      }
    } catch (e) { sample += ` [read error: ${e.message}]`; }
    reader?.cancel().catch(() => {});
    return Response.json({ target: u.href, status: upstream.status, finalUrl: upstream.url, redirected: upstream.redirected,
      headers: Object.fromEntries(upstream.headers), headersMs: Date.now() - t0, firstBytesMs, bytesIn8s: bytes,
      sample: sample.replace(/[^\x20-\x7e]/g, ".") }, { headers: CORS });
  }

  const h = new Headers(upstream.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Cache-Control", "no-store");
  for (const k of ["content-security-policy", "content-length", "content-encoding", "transfer-encoding", "connection"]) h.delete(k);
  // Pass the body stream straight through (no buffering).
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
