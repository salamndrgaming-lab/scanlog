// Vercel Edge Function: search the public Radio Browser directory (radio-browser.info)
// for scanner / public-safety audio streams. Read-only; returns a short JSON list.
export const config = { runtime: "edge" };

const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };

export default async function handler(req) {
  const q = (new URL(req.url).searchParams.get("q") || "memphis").slice(0, 60);
  const searches = [
    `name=${encodeURIComponent(q)}`,
    `tag=scanner&state=Tennessee`,
    `tag=police&state=Tennessee`,
    `tag=scanner&name=${encodeURIComponent(q)}`,
  ];
  const seen = new Map();
  for (const s of searches) {
    try {
      const r = await fetch(`https://all.api.radio-browser.info/json/stations/search?${s}&limit=200&hidebroken=false`, { headers: { "User-Agent": "ScanLog-mobile/1.0" } });
      if (!r.ok) continue;
      for (const st of await r.json()) seen.set(st.stationuuid, st);
    } catch {}
  }
  const rows = [...seen.values()]
    .filter(st => /scanner|police|fire|sheriff|ems|dispatch|public safety|emergency/i.test(st.name + " " + st.tags))
    .map(st => ({ name: st.name, url: st.url_resolved || st.url, tags: st.tags, state: st.state, codec: st.codec, ok: st.lastcheckok === 1 }));
  return new Response(JSON.stringify({ query: q, total: seen.size, matches: rows }), { headers: CORS });
}
