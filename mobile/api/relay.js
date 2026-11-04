// Vercel Edge Function: same-origin stream relay for feeds whose servers don't send CORS
// headers. Port of relay-worker.js. Only relays the audio-stream hosts below, so it can't
// be used as an open proxy. Edge responses have a duration limit; the app reconnects.
export const config = { runtime: "edge" };

const ALLOWED = [/(^|\.)broadcastify\.com$/, /(^|\.)cdnstream1\.com$/, /(^|\.)radioreference\.com$/];
const CORS = { "Access-Control-Allow-Origin": "*" };

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "*" } });
  const target = new URL(req.url).searchParams.get("url");
  if (!target) return new Response("usage: ?url=<stream>", { status: 400, headers: CORS });
  let u;
  try { u = new URL(target); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
  if (!/^https?:$/.test(u.protocol) || !ALLOWED.some(r => r.test(u.hostname))) return new Response("host not allowed", { status: 403, headers: CORS });
  let upstream;
  try {
    upstream = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 ScanLog-relay" }, redirect: "follow" });
  } catch (e) {
    return new Response("upstream fetch failed", { status: 502, headers: CORS });
  }
  const h = new Headers(upstream.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Cache-Control", "no-store");
  for (const k of ["content-security-policy", "content-length", "content-encoding", "transfer-encoding", "connection"]) h.delete(k);
  // Pass the body stream straight through (no buffering).
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
