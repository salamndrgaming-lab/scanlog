// Optional Cloudflare Worker: lets the phone app read a stream whose server doesn't
// send CORS headers. Deploy free: dash.cloudflare.com -> Workers -> Create -> paste ->
// Deploy, then put the worker URL in ScanLog Setup -> Relay.
// Only relays audio-stream hosts listed below (so it can't be used as an open proxy).
const ALLOWED = [/(^|\.)broadcastify\.com$/, /(^|\.)cdnstream1\.com$/, /(^|\.)radioreference\.com$/];

export default {
  async fetch(req) {
    const target = new URL(req.url).searchParams.get("url");
    if (!target) return new Response("usage: ?url=<stream>", { status: 400 });
    let u;
    try { u = new URL(target); } catch { return new Response("bad url", { status: 400 }); }
    if (!ALLOWED.some(r => r.test(u.hostname))) return new Response("host not allowed", { status: 403 });
    const upstream = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 ScanLog-relay" }, redirect: "follow" });
    const h = new Headers(upstream.headers);
    h.set("Access-Control-Allow-Origin", "*");
    h.delete("content-security-policy");
    return new Response(upstream.body, { status: upstream.status, headers: h });
  },
};
