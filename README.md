# Streamtor — Webtor-style torrent streaming

Two engines in one site:

| Engine | Where it runs | Works with |
|---|---|---|
| **Server** | Node backend (Render/VPS) downloads the torrent and streams it to the browser over HTTP (range requests, ffmpeg conversion: remux for MKV, transcode HEVC/DivX/WMV to H.264, audio→AAC) | Regular torrents (UDP/TCP peers) |
| **Browser P2P** | WebTorrent in the tab over WebRTC | Only torrents with WebRTC peers. Works on static hosts (InfinityFree, Netlify…) |

If the page is served by `server.js`, both engines appear (Server is the default). On a static host only Browser P2P is available.

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
| `MAX_SIZE_GB` | 15 | Reject torrents bigger than this |
| `IDLE_MINUTES` | 20 | Delete a torrent + its data after this long without the page polling it |
| `METADATA_TIMEOUT_SEC` | 75 | Give up if no peers provide metadata |
| `UPLOAD_LIMIT_KBPS` | 100 | Cap seeding bandwidth (keeps your Render egress low) |
| `TRANSCODE_MAX_HEIGHT` | 1080 | Cap converted-video resolution (lower = less CPU on the fly) |
| `ENABLE_ENGINE` | true | `false` = static-only (no torrent engine) |

## Render free plan notes
- 512 MB RAM, sleeps after 15 min idle (first request takes ~30–60 s to wake), ephemeral disk (data is deleted on restart/idle — that's fine for streaming), ~100 GB/month bandwidth.
- Cannot accept incoming peer connections; it only connects out, so speeds depend on available seeders.
- Compatibility mode now actually converts: browsers-native codecs (H.264/VP9/AV1) are stream-copied (tiny CPU), while HEVC/H.265, MPEG-4/DivX, WMV, FLV etc. are transcoded to H.264 — playable on the free tier for 1080p-ish content; lower `TRANSCODE_MAX_HEIGHT` (e.g. 720) if the CPU can't keep up.

## Responsible use
Only stream content you have the right to access (your own files, public domain, Creative Commons, Linux ISOs…). You are responsible for what you run on your server — keep it private with `ACCESS_CODE`.
