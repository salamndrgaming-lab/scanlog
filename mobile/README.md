# ScanLog Mobile

A version of ScanLog that runs entirely on your phone (iPhone or Android), in the browser
or installed to the home screen. No computer and no server are involved: listening,
transcription, incident grouping, the map and storage all happen on the phone.

## Put it online (one time, ~3 minutes)

It's a static site (just these files), so any HTTPS host works. Phones only allow the
microphone and app install over HTTPS.

**Cloudflare Pages:** dash.cloudflare.com → Workers & Pages → Create → Pages →
*Upload assets* → drag this `mobile` folder in → Deploy. You get `https://<name>.pages.dev`.

Other options: Netlify Drop (app.netlify.com/drop, drag the folder), GitHub Pages, or
`vercel deploy` from this folder.

Then on your phone, open the URL and add it to the home screen (iPhone: Share → *Add to
Home Screen*; Android: menu → *Install app*).

## PC listens, phone watches (free, live)

Broadcastify's free listening only works in its own web player, so let a computer do the listening:

1. **One time:** Vercel → this project → Storage → Create Database → **Upstash Redis** (free plan) → Connect to this project → redeploy.
2. **PC (Chrome or Edge):** open the feed in Broadcastify's player in one tab. Open ScanLog in another tab → Setup → This device: **Listen & log**, pick a **Sync passphrase**, Audio source: **Browser tab**. Live → **Start listening** → choose the Broadcastify tab, keep “Share tab audio” on. Keep both tabs open.
3. **Phone:** open ScanLog → Setup → This device: **View PC's log**, same passphrase. Incidents, map, transcripts and audio clips update about every 20–30 seconds.

The first PC to sync claims the passphrase; only that passphrase can read or change the log. Audio clips are kept 24 hours.

## Using it

1. **Setup → Audio source**
   - **Online feed:** enter a Broadcastify feed ID (Tennessee → Shelby County →
     "Memphis Police and Shelby County Sheriff" or "Memphis Fire Department"; the
     number at the end of the feed page address).
   - **Microphone:** set the phone next to a scanner radio, or next to another device
     playing a feed. Works with any audio, no setup.
2. **Setup → Transcription**
   - **On this phone:** free and private. Downloads Whisper (Tiny ~40 MB or Base
     ~80 MB) once; tap *Download model now* on Wi-Fi. Uses the GPU (WebGPU) when the
     phone supports it.
   - **Cloud API:** paste a Groq or OpenAI key. More accurate and lighter on the
     battery. The key is stored only on the phone.
3. **Live → Start listening.** Incidents appear under *Incidents* and on the *Map*.
   Tap one to see every transmission and replay the audio.
4. **Export:** Setup → CSV / GeoJSON / Log, which opens the share sheet.

You can also feed it a recording: Setup → *Process a recording…*

## Phone limitations

- **Keep the app open with the screen on, and plugged in.** ScanLog asks the screen to
  stay awake while listening, but iOS and Android pause web apps in the background or
  when the screen locks. For true 24/7 logging, run the Python version on a computer or
  Raspberry Pi and open its dashboard from your phone (`server.host: 0.0.0.0`).
- **Feeds that block browsers:** some stream servers don't allow web pages to read
  their audio (CORS). If ScanLog says it can't open a feed that plays fine elsewhere,
  on Vercel the app retries automatically through its built-in `/api/relay`. On other hosts,
  deploy `relay-worker.js` as a free Cloudflare Worker (instructions at the top of the
  file) and paste its URL into Setup → Relay. Microphone mode always works.
- On-device transcription keeps up with one channel on recent phones. If clips pile up,
  switch to the Tiny model or the cloud engine.
- Map tiles and address lookups (OpenStreetMap) need a connection.

## Files

| File | What it is |
|---|---|
| `index.html` | layout and styles |
| `app.js` | audio capture, transcription queue, screens |
| `core.js` | voice segmenter, IndexedDB storage, geocoding, incident grouping, exports |
| `extract.js` | call-type / address / unit / status rules (same rules as the Python `extract.py`; `tests/` checks they agree) |
| `whisper-worker.js` | on-device Whisper (transformers.js) |
| `sw.js`, `manifest.webmanifest`, `icon*` | home-screen app and offline shell |
| `sync.js`, `api/sync.js` | live PC → phone sync (Upstash Redis via Vercel Storage) |
| `relay-worker.js` | optional Cloudflare Worker stream relay |
| `api/relay.js` | built-in stream relay (Vercel Edge Function); the app retries through it automatically when a feed won't open |
| `vercel.json` | Vercel config: no build step, service-worker / manifest / permissions headers |
