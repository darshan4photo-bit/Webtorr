# Streamtor — torrent streaming website + Stremio addon

Stream a magnet link in the browser, and install the **built-in Stremio addon** so the same server appears as a catalog inside Stremio.

## The site

Two engines in one site:

| Engine | Where it runs | Works with |
|---|---|---|
| **Server** | Node backend (Render/VPS) downloads the torrent and streams it to the browser over HTTP (range requests, ffmpeg conversion: remux for MKV, transcode HEVC/DivX/WMV to H.264, audio→AAC) | Regular torrents (UDP/TCP peers) |
| **Browser P2P** | WebTorrent in the tab over WebRTC | Only torrents with WebRTC peers. Works on static hosts (InfinityFree, Netlify…) |

If the page is served by `server.js`, both engines appear (Server is the default). On a static host only Browser P2P is available.

## Stremio addon (built in)

Streamtor doubles as a **self-hosted Stremio addon** — no extra install, no package:

| Route | Purpose |
|---|---|
| `GET /stremio/<code>/manifest.json` | Addon manifest (`catalog`, `meta`, `stream` resources) |
| `GET /stremio/<code>/catalog/{movie\|series}/{id}.json` (+ optional `/search=…`) | Live catalog of the torrents on the server |
| `GET /stremio/<code>/meta/{movie\|series}/{id}.json` | Item detail; episode packs list every video file as an episode |
| `GET /stremio/<code>/stream/{movie\|series}/{id}.json` | Playable streams (URLs under `.../dl/<hash>/<fileIndex>`) |
| `GET /stremio/<code>/poster/<hash>.svg` | Generated poster art |
| `GET /stremio/<code>/dl/<hash>/<fileIndex>` | Range-capable stream endpoint Stremio plays from |

- IDs are `streamtor:<infoHash>` (movies) and `streamtor:<infoHash>:f<fileIndex>` (single episodes).
- A torrent counts as a **series** when most of its video files carry `SxxEyy`/`1x01` episode tags; files without tags get sequential episode numbers.
- All routes send permissive CORS headers, as the Stremio protocol requires.
- `<code>` is your `ACCESS_CODE` on protected servers (so only people who know it can install the addon); on open servers any label such as `public` works.
- Install: on the site, open **Stremio Addon** in the sidebar, copy the manifest URL (or press **Install in Stremio**) and add it via **Stremio → Addons → Community Addons**. Streams then play straight from your server, including the ffmpeg-based conversion.
- The website mirrors the same catalog: the home page shows a **Your library** row backed by `GET /api/library` (cookie-gated, same shape as the addon catalog) and `GET /api/poster/<hash>.svg` for artwork. Click a card to stream it here, or use the 🧩 badge for a `stremio:///detail/…` deep link that opens it inside Stremio.

## Run locally (Node 22+)
    npm install
    ACCESS_CODE=mysecret node server.js     # http://localhost:3000

## Deploy to Render (free plan works)
1. Push this folder to a GitHub repo (`node_modules` is git-ignored).
2. Render → **New → Blueprint** → select the repo. `render.yaml` sets everything up.
3. When prompted, set **ACCESS_CODE** (your private password). Deploy.
4. Open the `https://<name>.onrender.com` URL, enter the access code, paste a magnet link.

Manual alternative: New → Web Service → Build `npm install` → Start `node server.js` → add env `NODE_VERSION=22` and `ACCESS_CODE`.

## Environment variables
| Var | Default | Meaning |
|---|---|---|
| `ACCESS_CODE` | *(none)* | Password required for the server engine. **Set it** on any public host. |
| `MAX_TORRENTS` | 2 | Concurrent torrents (least-recently-used is evicted) |
| `MAX_SIZE_GB` | 250 | Reject torrents bigger than this (raised for large 4K remuxes) |
| `IDLE_MINUTES` | 20 | Delete a torrent + its data after this long without the page polling it |
| `METADATA_TIMEOUT_SEC` | 75 | Give up if no peers provide metadata |
| `UPLOAD_LIMIT_KBPS` | 100 | Cap seeding bandwidth (keeps your Render egress low) |
| `TRANSCODE_MAX_HEIGHT` | 2160 | Cap converted-video resolution (4K sources stay 4K; lower = less CPU on the fly) |
| `OPENSUBTITLES_API_KEY` | *(none)* | Enables `GET /api/subtitles` — moviehash/filename lookup on OpenSubtitles, converted to WebVTT |
| `ENABLE_ENGINE` | true | `false` = static-only (no torrent engine) |

## Render free plan notes
- 512 MB RAM, sleeps after 15 min idle (first request takes ~30–60 s to wake), ephemeral disk (data is deleted on restart/idle — that's fine for streaming), ~100 GB/month bandwidth.
- Cannot accept incoming peer connections; it only connects out, so speeds depend on available seeders.
- Compatibility mode now actually converts: browsers-native codecs (H.264/VP9/AV1) are stream-copied (tiny CPU), while HEVC/H.265, MPEG-4/DivX, WMV, FLV etc. are transcoded to H.264 — playable on the free tier for 1080p-ish content; lower `TRANSCODE_MAX_HEIGHT` (e.g. 720) if the CPU can't keep up.

## Responsible use
Only stream content you have the right to access (your own files, public domain, Creative Commons, Linux ISOs…). You are responsible for what you run on your server — keep it private with `ACCESS_CODE`.
