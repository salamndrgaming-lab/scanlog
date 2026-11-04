// App-shell cache so ScanLog opens instantly and works offline (except live audio,
// transcription APIs and map tiles, which always go to the network).
const CACHE = "scanlog-v3";
const SHELL = ["./", "index.html", "app.js", "core.js", "extract.js", "sync.js", "whisper-worker.js", "manifest.webmanifest",
  "icon.svg", "icon-192.png", "icon-512.png", "icon-180.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  const shell = (u.origin === location.origin) || u.href.startsWith("https://unpkg.com/leaflet@1.9.4/");
  // never intercept the stream relay (endless audio body; must not be cached)
  if (e.request.method !== "GET" || !shell || (u.origin === location.origin && u.pathname.startsWith("/api/"))) return;
  // stale-while-revalidate
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
