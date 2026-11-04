// Vercel Edge Function: live sync between a "station" (the PC that listens and transcribes)
// and "viewers" (phones). Storage is a free Upstash Redis database connected to the project
// (Vercel → Storage → Upstash Redis), reached over its REST API, so there are no npm packages.
//
// Every request carries the passphrase in the X-Sync-Key header. The first station write
// claims the passphrase (its SHA-256 is stored); after that only the same passphrase works.
//
//   GET  /api/sync?since=<ms>   latest snapshot, or 204 if nothing newer than <ms>
//   POST /api/sync              station uploads a snapshot {updated, incs, tx}
//   POST /api/sync?clip=<id>    station uploads one audio clip (base64 WAV text body), kept 24 h
//   GET  /api/sync?clip=<id>    viewer downloads that clip as audio/wav
export const config = { runtime: "edge" };

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const MAX_BODY = 900_000;
const CLIP = /^[\w-]{1,48}$/;
const J = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: J });

async function redis(...cmd) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("database: " + (j.error || r.status));
  return j.result;
}
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("scanlog:" + s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export default async function handler(req) {
  if (!URL_ || !TOKEN) return json({ error: "no-db", message: "No database connected. In Vercel: project → Storage → Create Database → Upstash Redis (free) → Connect, then redeploy." }, 503);
  const key = req.headers.get("x-sync-key") || "";
  if (key.length < 6) return json({ error: "bad-key", message: "Sync passphrase must be at least 6 characters." }, 401);
  const params = new URL(req.url).searchParams;
  const clip = params.get("clip");
  if (clip !== null && !CLIP.test(clip)) return json({ error: "bad-clip" }, 400);
  const hash = await sha256(key);

  try {
    if (req.method === "POST") {
      const body = await req.text();
      if (body.length > MAX_BODY) return json({ error: "too-big" }, 413);
      // claim the passphrase on first use (SET NX), then require it
      const stored = await redis("GET", "sync:keyhash");
      if (!stored) await redis("SET", "sync:keyhash", hash, "NX");
      else if (stored !== hash) return json({ error: "wrong-key", message: "Wrong sync passphrase." }, 403);
      if (clip !== null) { await redis("SET", "clip:" + clip, body, "EX", 86400); return json({ ok: true }); }
      let snap;
      try { snap = JSON.parse(body); } catch { return json({ error: "bad-json" }, 400); }
      const updated = Number(snap.updated) || Date.now();
      await redis("MSET", "sync:snap", body, "sync:updated", String(updated));
      return json({ ok: true, updated });
    }
    if (req.method === "GET") {
      if (clip !== null) {
        const [kh, b64] = await redis("MGET", "sync:keyhash", "clip:" + clip);
        if (kh !== hash) return json({ error: kh ? "wrong-key" : "no-station" }, kh ? 403 : 404);
        if (!b64) return json({ error: "expired" }, 404);
        const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        return new Response(bin, { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=86400" } });
      }
      const since = Number(params.get("since")) || 0;
      const [kh, updated] = await redis("MGET", "sync:keyhash", "sync:updated");
      if (!kh) return json({ error: "no-station", message: "No PC has synced yet." }, 404);
      if (kh !== hash) return json({ error: "wrong-key", message: "Wrong sync passphrase." }, 403);
      if (since && Number(updated) <= since) return new Response(null, { status: 204, headers: J });
      const snap = await redis("GET", "sync:snap");
      return new Response(snap || "{}", { headers: J });
    }
    return json({ error: "method" }, 405);
  } catch (e) {
    return json({ error: "db-error", message: e.message }, 502);
  }
}
