// Vercel Edge Function: read-only passthrough to the public OpenMHz API (api.openmhz.com),
// so the phone app can list a system's new calls without CORS problems.
// Only the few read endpoints the app needs are allowed.
export const config = { runtime: "edge" };

const CORS = { "Access-Control-Allow-Origin": "*" };
const PATH = /^\/(systems|[\w-]{1,64}\/(talkgroups|calls\/(newer|older|latest)|calls))$/;
const KEEP = ["time", "filter-type", "filter-code", "filter-starred"];

export default async function handler(req) {
  const params = new URL(req.url).searchParams;
  const path = params.get("path") || "";
  if (!PATH.test(path)) return new Response("path not allowed", { status: 403, headers: CORS });
  const q = new URLSearchParams();
  for (const k of KEEP) if (params.has(k)) q.set(k, params.get(k));
  const target = "https://api.openmhz.com" + path + (q.size ? "?" + q : "");
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(target, { headers: { "Accept": "application/json", "User-Agent": "ScanLog-mobile (personal use)" }, signal: ac.signal });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { ...CORS, "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "no-store" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: ac.signal.aborted ? "OpenMHz did not answer" : String(e.message) }), { status: 504, headers: { ...CORS, "Content-Type": "application/json" } });
  } finally { clearTimeout(timer); }
}
