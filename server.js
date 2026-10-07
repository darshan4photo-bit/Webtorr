// Streamtor server — static site + optional server-side torrent engine (for Render/VPS).
// Requires Node >= 22.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import WebTorrent from 'webtorrent';

let ffmpegPath = null;
try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { /* optional */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Serve ./public if it exists, otherwise the site files in the project root (this repo's layout).
const PUBLIC = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const PRIVATE_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'render.yaml', 'readme.md']);
const env = process.env;
const CFG = {
  port: Number(env.PORT) || 3000,
  engine: env.ENABLE_ENGINE !== 'false',                 // set ENABLE_ENGINE=false for static-only
  accessCode: env.ACCESS_CODE || '',                     // strongly recommended on a public host
  osKey: env.OPENSUBTITLES_API_KEY || '',                // enables GET /api/subtitles (OpenSubtitles)
  secret: env.SESSION_SECRET || env.ACCESS_CODE || crypto.randomBytes(16).toString('hex'),
  dir: env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'streamtor'),
  maxTorrents: Number(env.MAX_TORRENTS) || 2,
  maxSize: (Number(env.MAX_SIZE_GB) || 250) * 1024 ** 3, // large 4K torrents (raise via env if your disk allows)
  idleMs: (Number(env.IDLE_MINUTES) || 20) * 60_000,
  metaTimeout: (Number(env.METADATA_TIMEOUT_SEC) || 75) * 1000,
  uploadLimit: (Number(env.UPLOAD_LIMIT_KBPS) || 100) * 1024,
  transcodeHeight: Number(env.TRANSCODE_MAX_HEIGHT) || 2160, // keep 4K sources at 4K (lower if the CPU can't keep up)
  probeMs: Number(env.PROBE_TIMEOUT_MS) || 10_000
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.ico': 'image/x-icon' };
const INTERNAL_KEY = crypto.randomBytes(24).toString('hex'); // lets our own ffmpeg process fetch files
const VIDEO_NATIVE = new Set(['.mp4', '.m4v', '.webm']);

/* ---------------- torrent engine ---------------- */
let client = null;
const touched = new Map(); // infoHash -> last access time
function getClient() {
  if (!client) {
    fs.mkdirSync(CFG.dir, { recursive: true });
    client = new WebTorrent({ uploadLimit: CFG.uploadLimit, maxConns: 60 });
    client.on('error', (e) => console.error('[client]', e.message));
  }
  return client;
}
const touch = (t) => touched.set(t.infoHash, Date.now());
const find = async (hash) => (client ? await client.get(hash) : null);

function removeTorrent(t) {
  touched.delete(t.infoHash);
  for (const k of probed.keys()) if (k.startsWith(t.infoHash)) probed.delete(k);
  for (const k of subCache.keys()) if (k.startsWith(t.infoHash)) subCache.delete(k);
  for (const k of moviehashCache.keys()) if (k.startsWith(t.infoHash)) moviehashCache.delete(k);
  return new Promise((r) => t.destroy({ destroyStore: true }, () => r()));
}
setInterval(() => {
  if (!client) return;
  for (const t of [...client.torrents]) {
    if (Date.now() - (touched.get(t.infoHash) || 0) > CFG.idleMs) {
      console.log('[cleanup] idle torrent removed:', t.name || t.infoHash);
      removeTorrent(t);
    }
  }
}, 30_000).unref();

function state(t) {
  return {
    infoHash: t.infoHash, name: t.name || null, ready: !!t.ready, length: t.length || 0,
    progress: t.progress || 0, downloadSpeed: t.downloadSpeed, uploadSpeed: t.uploadSpeed, numPeers: t.numPeers,
    files: (t.files || []).map((f, index) => ({ index, name: f.name, path: f.path, length: f.length, progress: f.progress }))
  };
}

const DEFAULT_TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.tracker.cl:1337/announce', 'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce', 'udp://opentracker.io:6969/announce', 'wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'];
async function addTorrent(source) {
  const c = getClient();
  if (typeof source === 'string' && source.startsWith('magnet:')) {
    const have = new Set([...source.matchAll(/[?&]tr=([^&]+)/g)].map((m) => decodeURIComponent(m[1])));
    source += DEFAULT_TRACKERS.filter((t) => !have.has(t)).map((t) => '&tr=' + encodeURIComponent(t)).join('');
  }
  // already added? reuse it
  const hm = typeof source === 'string' && /btih:([a-f0-9]{40})/i.exec(source);
  if (hm) { const ex = await c.get(hm[1].toLowerCase()); if (ex && ex.ready) { touch(ex); return ex; } }
  const t0 = Date.now();
  // evict least-recently-used if at capacity
  if (c.torrents.length >= CFG.maxTorrents) {
    const lru = [...c.torrents].sort((a, b) => (touched.get(a.infoHash) || 0) - (touched.get(b.infoHash) || 0))[0];
    if (Date.now() - (touched.get(lru.infoHash) || 0) < 60_000) throw httpErr(429, 'Server is busy streaming other torrents. Try again in a minute.');
    await removeTorrent(lru);
  }
  const t = c.add(source, { path: CFG.dir, deselect: true });
  touch(t);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(httpErr(504, 'Timed out finding peers / metadata for this torrent. It may have no active seeders.')); }, CFG.metaTimeout);
    const onReady = () => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(httpErr(400, e.message)); };
    const cleanup = () => { clearTimeout(timer); t.off('ready', onReady); t.off('error', onErr); };
    if (t.ready) return onReady();
    t.once('ready', onReady); t.once('error', onErr);
  }).catch(async (e) => { await removeTorrent(t).catch(() => {}); throw e; });
  if (t.length > CFG.maxSize) {
    await removeTorrent(t);
    throw httpErr(413, `Torrent is too large for this server (limit ${(CFG.maxSize / 1024 ** 3).toFixed(0)} GB).`);
  }
  touch(t);
  console.log(`[add] ${t.name} (${(t.length / 1048576).toFixed(0)} MB) ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, peers=${t.numPeers}`);
  return t;
}

/* ---------------- http helpers ---------------- */
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const readBody = (req, limit = 6 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > limit) { reject(httpErr(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const token = () => crypto.createHmac('sha256', CFG.secret).update('streamtor-auth').digest('hex');
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
const authed = (req) => !CFG.accessCode || cookies(req).st_auth === token();
const attempts = new Map();

/* ---------------- format conversion ---------------- */
// One probe per file (cached): which codecs/dimensions does it actually contain?
const probed = new Map(); // `${hash}:${idx}` -> {vcodec, vIndex, vHeight, acodec} | null

function probeCodecs(input, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    // Demux-only probe: read the container header and list the streams, without decoding anything.
    const ff = spawn(ffmpegPath, ['-hide_banner', '-i', input, '-t', '0.5',
      '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'copy', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err += d; if (err.length > 200_000) ff.kill('SIGKILL'); });
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} resolve(null); }, timeoutMs);
    ff.on('close', () => {
      clearTimeout(timer);
      // Keep only the input-analysis section (drop the "Stream mapping:" / "Output #0" chatter).
      const cut = err.search(/\nStream mapping:|\nOutput #0:/);
      const head = cut >= 0 ? err.slice(0, cut) : err;
      const lines = head.split('\n').filter((l) => /Stream #\d+:\d+/.test(l));
      const videos = lines.filter((l) => /: Video: /.test(l));
      const audios = lines.filter((l) => /: Audio: /.test(l));
      if (!videos.length && !audios.length) return resolve(null);
      const codecOf = (l) => /: (?:Video|Audio): ([^ ,(),:]+)/.exec(l)?.[1] || null;
      // Still-image streams are cover art, not real video (mp3/flac/m4a/mkv audio files embed them).
      const still = ['png', 'webp', 'bmp', 'gif', 'jpg', 'jpeg', 'mjpeg'];
      const real = videos.filter((l) => !/attached pic/.test(l) && !still.includes(codecOf(l)));
      const main = real[0] || null;
      const dim = main ? /(\d{2,5})x(\d{2,5})/.exec(main) : null;
      resolve({
        vcodec: main ? codecOf(main) : null,
        vIndex: main ? videos.indexOf(main) : 0,
        vHeight: dim ? Number(dim[2]) : 0,
        acodec: audios.length ? codecOf(audios[0]) : null
      });
    });
  });
}

// Build ffmpeg args that turn any input into browser-playable fragmented MP4.
// Video is stream-copied when browsers can decode it (h264/vp8/vp9/av1); otherwise it is
// transcoded to H.264 (capped at maxH pixels tall, even dimensions). Audio always becomes AAC stereo.
function buildConvertArgs(p, maxH) {
  const args = ['-sn'];
  if (p.guess) {
    // The probe didn't get the codecs (slow or unreachable pieces). Never drop the video track —
    // map it optionally (so audio-only files still work) and transcode whatever ffmpeg finds.
    args.push('-map', '0:v:0?', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2');
  } else {
    if (p.vcodec) args.push('-map', p.vIndex > 0 ? `0:v:${p.vIndex}` : '0:v:0');
    args.push('-map', '0:a:0?');
  }
  if (p.vcodec && !p.guess) {
    const copyable = ['h264', 'vp8', 'vp9', 'av1'].includes(p.vcodec);
    const tooTall = p.vHeight > maxH;
    if (copyable && !tooTall) args.push('-c:v', 'copy');
    else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
      const target = Math.min(p.vHeight || maxH, maxH);
      if (tooTall) args.push('-vf', `scale=-2:${target - (target % 2)}`);
      else if (p.vHeight) args.push('-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2');
    }
  }
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

/* ---------------- subtitles (OpenSubtitles) ---------------- */
// Moviehash per the official opensubtitlescli reference: seed with the file size, sum every
// little-endian uint64 word in the first and last 64 KiB (mod 2^64), print as 16 hex chars.
// Files below 128 KiB can't be hashed (the two chunks would overlap), so those fall back to a
// filename search instead.
const MH_CHUNK = 65536;
const MH_MIN_SIZE = MH_CHUNK * 2; // 128 KiB
const MH_TIMEOUT_MS = 15_000;
const subCache = new Map();       // `${infoHash}:${idx}:${lang}` -> VTT text (bounded)
const moviehashCache = new Map(); // `${infoHash}:${idx}` -> hex (successes only — a slow read must not poison retries)

async function computeMoviehash(file, { chunk = MH_CHUNK, timeoutMs = MH_TIMEOUT_MS } = {}) {
  const size = file.length || 0;
  if (size < MH_MIN_SIZE) return null;
  const read = (start, len) => new Promise((resolve) => {
    const chunks = []; let n = 0; let rs;
    const timer = setTimeout(() => { try { rs?.destroy(); } catch {} resolve(null); }, timeoutMs);
    try { rs = file.createReadStream({ start, end: start + len - 1 }); } // end is inclusive (WebTorrent)
    catch { clearTimeout(timer); return resolve(null); }
    rs.on('data', (c) => {
      chunks.push(c); n += c.length;
      if (n >= len) { clearTimeout(timer); try { rs.destroy(); } catch {} resolve(Buffer.concat(chunks).subarray(0, len)); }
    });
    rs.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    rs.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  const [head, tail] = await Promise.all([read(0, chunk), read(size - chunk, chunk)]);
  if (!head || !tail || head.length < chunk || tail.length < chunk) return null;
  let sum = BigInt(size);
  for (const buf of [head, tail]) for (let i = 0; i + 8 <= buf.length; i += 8) sum += buf.readBigUInt64LE(i);
  return (sum & 0xFFFFFFFFFFFFFFFFn).toString(16).padStart(16, '0');
}

const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const osHeaders = (post) => ({
  'Accept': 'application/json',
  'Api-Key': CFG.osKey,
  'X-Api-Key': CFG.osKey,
  'User-Agent': 'Streamtor/1.0',
  ...(post ? { 'Content-Type': 'application/json' } : {})
});

async function osSearch({ moviehash, query, lang, fetchImpl }) {
  const u = new URL(`${OS_BASE}/subtitles`);
  if (moviehash) u.searchParams.set('moviehash', moviehash);
  if (query) u.searchParams.set('query', query);
  u.searchParams.set('languages', lang);
  u.searchParams.set('order_by', 'download_count');
  u.searchParams.set('order_direction', 'desc');
  const r = await fetchImpl(u, { headers: osHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  for (const item of j?.data || []) {
    const f = item?.attributes?.files?.[0];
    if (f?.file_id) return { fileId: f.file_id, name: f.file_name || null };
  }
  return null;
}

async function osDownload(fileId, fetchImpl) {
  const r = await fetchImpl(`${OS_BASE}/download`, {
    method: 'POST', headers: osHeaders(true), body: JSON.stringify({ file_id: fileId }), signal: AbortSignal.timeout(10_000)
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j?.link) return null;
  const f = await fetchImpl(j.link, { signal: AbortSignal.timeout(15_000) });
  if (!f.ok) return null;
  return Buffer.from(await f.arrayBuffer());
}

const srtToVtt = (s) => 'WEBVTT\n\n' + s.replace(/\r+/g, '').replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2');

async function subToVtt(buf, name = '') {
  if (!buf?.length) return null;
  if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch { return null; } }
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (/^\s*WEBVTT/.test(text)) return text.replace(/\r\n?/g, '\n');
  const ext = path.extname(name).toLowerCase();
  const looksSrt = /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text);
  if (ext === '.srt' || looksSrt) return srtToVtt(text);
  if (!ffmpegPath) return null;
  // ASS/SSA/anything else: let ffmpeg convert it to WebVTT.
  const isAss = /^\s*\[Script Info\]/im.test(text) || ext === '.ass' || ext === '.ssa';
  const tmpExt = isAss ? '.ass' : (/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.sub');
  const tmp = path.join(os.tmpdir(), `st-sub-${crypto.randomBytes(6).toString('hex')}${tmpExt}`);
  try { fs.writeFileSync(tmp, buf); } catch { return null; }
  try {
    return await new Promise((resolve) => {
      const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-f', 'webvtt', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = []; let err = '';
      const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} resolve(null); }, 10_000);
      ff.stdout.on('data', (d) => out.push(d));
      ff.stderr.on('data', (d) => { err += d; if (err.length > 50_000) ff.kill('SIGKILL'); });
      ff.on('close', (code) => {
        clearTimeout(timer);
        const v = Buffer.concat(out).toString('utf8');
        resolve(code === 0 && /WEBVTT/.test(v) ? v : null);
      });
      ff.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  } finally { fs.rm(tmp, { force: true }, () => {}); }
}

// Search → download → convert → cache. `t` only provides the infoHash for cache keying; the
// network is injectable so tests can stub OpenSubtitles without touching it.
async function getSubtitleVtt(t, file, idx, lang, { fetchImpl = fetch } = {}) {
  const infoHash = t.infoHash || String(t);
  const key = `${infoHash}:${idx}:${lang}`;
  const cached = subCache.get(key);
  if (cached) return cached;
  if (!CFG.osKey) return null;
  const mhKey = `${infoHash}:${idx}`;
  let mh = moviehashCache.get(mhKey);
  if (!mh) {
    mh = await computeMoviehash(file);
    if (mh) moviehashCache.set(mhKey, mh); // successes only — a slow read must not poison retries
  }
  let hit = mh ? await osSearch({ moviehash: mh, lang, fetchImpl }) : null;
  if (!hit) hit = await osSearch({ query: path.basename(file.name, path.extname(file.name)), lang, fetchImpl });
  if (!hit) return null; // misses are not cached: the subtitle DB grows and searches are cheap
  const raw = await osDownload(hit.fileId, fetchImpl);
  if (!raw) return null;
  const vtt = await subToVtt(raw, hit.name || file.name);
  if (!vtt) return null;
  if (subCache.size >= 200) subCache.delete(subCache.keys().next().value); // bounded, oldest-first
  subCache.set(key, vtt);
  return vtt;
}

/* ---------------- streaming ---------------- */
async function streamFile(req, res, file, url, hash, idx) {
  const ext = path.extname(file.name).toLowerCase();
  const remux = url.searchParams.get('remux') === '1' || url.searchParams.get('convert') === '1';
  const download = url.searchParams.get('download') === '1';
  const base = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };

  if (download) base['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;

  if (remux && !download) {
    if (!ffmpegPath) return json(res, 501, { error: 'ffmpeg is not available on this server.' });
    // ffmpeg reads the file through our own range endpoint (so it can seek, e.g. MP4 with moov at the end)
    // and emits fragmented MP4 that browsers play progressively. Files the browser can't decode natively
    // (HEVC/MKV, MPEG-4/DivX, WMV, FLV, AC3/DTS audio…) are converted on the fly; the rest are stream-copied.
    const key = `${hash}:${idx}`;
    const input = `http://127.0.0.1:${CFG.port}/stream/${hash}/${idx}?ik=${INTERNAL_KEY}`;
    res.writeHead(200, { ...base, 'Content-Type': 'video/mp4' });
    res.flushHeaders(); // flush explicitly: writeHead alone waits for the first write, and the browser
    // should show the player straight away instead of staring at a blank box while we probe.
    let p = probed.get(key);
    if (p === undefined) {
      p = await probeCodecs(input, { timeoutMs: CFG.probeMs });
      // Only cache successful probes: a slow first read must not poison every later retry.
      if (p) probed.set(key, p);
    }
    const guess = !p;
    const transcode = guess || !['h264', 'vp8', 'vp9', 'av1'].includes(p.vcodec);
    console.log(`[convert] ${file.name}: ${guess ? 'probe timed out → safe transcode' : `${p.vcodec || 'no video'}${p.acodec ? '+' + p.acodec : ''}`} → ${transcode ? 'H.264 transcode' : 'stream copy'}`);
    const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-readrate', '3', '-i', input,
      ...buildConvertArgs(p || { vcodec: null, vIndex: 0, vHeight: 0, acodec: null, guess: true }, CFG.transcodeHeight)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim().slice(0, 300)));
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill('SIGKILL'));
    ff.on('close', () => res.end());
    return;
  }

  const total = file.length;
  let start = 0, end = total - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(total - Number(m[2]), 0); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(Number(m[2]), total - 1); }
      if (start > end || start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      status = 206;
    }
  }
  const type = VIDEO_NATIVE.has(ext) || !file.type ? (file.type || 'application/octet-stream') : file.type;
  const headers = { ...base, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const rs = file.createReadStream({ start, end });
  pipeline(rs, res, () => {});
  res.on('close', () => rs.destroy());
}

/* ---------------- routes ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/health') {
    return json(res, 200, { server: CFG.engine, auth: !!CFG.accessCode, authed: authed(req), ffmpeg: !!ffmpegPath,
      limits: { maxTorrents: CFG.maxTorrents, maxSizeGB: CFG.maxSize / 1024 ** 3, idleMinutes: CFG.idleMs / 60000 } });
  }
  if (!CFG.engine) return json(res, 404, { error: 'Server engine disabled' });

  if (p === '/api/login' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 60_000) { a.n = 0; a.t = Date.now(); }
    if (++a.n > 10) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
    attempts.set(ip, a);
    let body = {}; try { body = JSON.parse((await readBody(req, 4096)).toString() || '{}'); } catch {}
    const ok = body.code && crypto.timingSafeEqual(crypto.createHash('sha256').update(String(body.code)).digest(), crypto.createHash('sha256').update(CFG.accessCode).digest());
    if (!ok) return json(res, 401, { error: 'Wrong access code.' });
    return json(res, 200, { ok: true }, { 'Set-Cookie': `st_auth=${token()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` });
  }
  if (!authed(req)) return json(res, 401, { error: 'Access code required.', auth: true });

  if (p === '/api/subtitles' && req.method === 'GET') {
    const hash = String(url.searchParams.get('hash') || '');
    const idx = url.searchParams.get('idx');
    const lang = String(url.searchParams.get('lang') || 'en').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) throw httpErr(400, 'hash must be a 40-char info-hash');
    if (!/^\d+$/.test(String(idx ?? ''))) throw httpErr(400, 'idx must be a file index');
    if (!/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(lang)) throw httpErr(400, 'lang must be a language code like "en" or "pt-br"');
    if (!CFG.osKey) return json(res, 501, { error: 'OpenSubtitles is not configured. Set OPENSUBTITLES_API_KEY.' });
    const t = await find(hash.toLowerCase());
    if (!t) return json(res, 404, { error: 'Torrent not found (it may have expired).' });
    const file = t.files?.[Number(idx)];
    if (!file) return json(res, 404, { error: 'File not found.' });
    touch(t);
    const vtt = await getSubtitleVtt(t, file, Number(idx), lang);
    if (!vtt) return json(res, 404, { error: `No subtitles found for language "${lang}".` });
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(vtt);
  }

  // Library listing for the website: mirrors the Stremio addon catalog (cookie-gated like the rest of /api).
  if (p === '/api/library' && req.method === 'GET') {
    const list = (client?.torrents || []).map((t) => {
      const playable = (t.files || []).filter((f) => STREMIO_VIDEO.has(extOf(f.name)) || STREMIO_AUDIO.has(extOf(f.name))).length;
      const series = isSeriesTorrent(t);
      return {
        infoHash: t.infoHash, name: t.name || t.infoHash, ready: !!t.ready, length: t.length || 0,
        progress: t.progress || 0, files: (t.files || []).length, playable, series,
        type: series ? 'series' : 'movie', metaId: `${STREMIO_PREFIX}:${t.infoHash}`,
        poster: `/api/poster/${t.infoHash}.svg`
      };
    });
    return json(res, 200, { torrents: list });
  }
  let pm;
  if (req.method === 'GET' && (pm = /^\/api\/poster\/([a-f0-9]{40})\.svg$/i.exec(p))) {
    const t = await find(pm[1].toLowerCase());
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(stremioPoster(t?.name, pm[1]));
  }

  if (p === '/api/add' && req.method === 'POST') {
    const ctype = req.headers['content-type'] || '';
    let source;
    if (ctype.includes('application/x-bittorrent')) source = await readBody(req);
    else {
      const body = JSON.parse((await readBody(req, 65536)).toString() || '{}');
      source = String(body.source || '').trim();
      if (/^[a-f0-9]{40}$/i.test(source)) source = 'magnet:?xt=urn:btih:' + source;
      if (!/^(magnet:|https?:\/\/)/i.test(source)) throw httpErr(400, 'Provide a magnet link, info-hash or .torrent URL.');
    }
    const c = getClient();
    const t = await addTorrent(source);
    return json(res, 200, state(t));
  }
  let m = /^\/api\/torrent\/([a-f0-9]{40})$/i.exec(p);
  if (m) {
    const t = await find(m[1].toLowerCase());
    if (!t) return json(res, 404, { error: 'Torrent not found (it may have expired).' });
    if (req.method === 'DELETE') { await removeTorrent(t); return json(res, 200, { ok: true }); }
    touch(t);
    return json(res, 200, state(t));
  }
  return json(res, 404, { error: 'Not found' });
}

async function streamByHashIdx(req, res, url, hash, idx) {
  const t = await find(String(hash).toLowerCase());
  const file = t?.files?.[Number(idx)];
  if (!file) return json(res, 404, { error: 'Torrent or file not found (it may have expired).' });
  touch(t); file.select();
  await streamFile(req, res, file, url, t.infoHash, Number(idx));
}

async function handleStream(req, res, url) {
  if (!CFG.engine) return json(res, 404, { error: 'Server engine disabled' });
  if (!authed(req) && url.searchParams.get('ik') !== INTERNAL_KEY) return json(res, 401, { error: 'Access code required.' });
  const m = /^\/stream\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'Not found' });
  return streamByHashIdx(req, res, url, m[1], m[2]);
}

/* ---------------- Stremio addon ---------------- */
// Streamtor doubles as a self-hosted Stremio addon. Everything under /stremio/<code>/ speaks the
// addon protocol: manifest.json + catalog/meta/stream resources. <code> is the server's
// ACCESS_CODE on protected servers (so only people who know it can install the addon), or an
// arbitrary label like "public" when no access code is configured. The catalog lists the
// torrents currently on the server, so anything added on the website shows up inside Stremio.
const STREMIO_PREFIX = 'streamtor';
const STREMIO_VIDEO = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'ts', 'm2ts', 'wmv', 'flv', 'ogv', 'mpg', 'mpeg', 'm2v', 'divx', '3gp']);
const STREMIO_AUDIO = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'wma']);
const EP_RE = /(?:^|[\s._\-\[])S(\d{1,2})E(\d{1,2})(?:[\s._\-\]]|$)|(?:^|[\s._\-\[])(\d{1,2})x(\d{2})(?:[\s._\-\]]|$)/i;
const extOf = (n) => path.extname(n || '').toLowerCase().slice(1);
const stremioBytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4); return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i]; };

// A torrent counts as a series when most of its video files carry SxxEyy / 1x01 episode tags.
const isSeriesTorrent = (t) => {
  const vids = (t?.files || []).filter((f) => STREMIO_VIDEO.has(extOf(f.name)));
  return vids.length >= 2 && vids.filter((f) => EP_RE.test(f.name)).length >= Math.ceil(vids.length * 0.6);
};
const stremioPlayable = (t) => (t?.files || []).map((f, index) => ({ f, index }))
  .filter(({ f }) => STREMIO_VIDEO.has(extOf(f.name)) || STREMIO_AUDIO.has(extOf(f.name)));
const stremioBase = (origin, code) => `${origin.replace(/\/+$/, '')}/stremio/${encodeURIComponent(code)}`;
const stremioIdHash = (id) => new RegExp(`^${STREMIO_PREFIX}:([a-f0-9]{40})(?::f(\\d+))?$`, 'i').exec(String(id || ''));

function stremioManifest(origin, code) {
  const root = origin.replace(/\/+$/, '');
  return {
    id: 'community.streamtor',
    version: '1.1.0',
    name: 'Streamtor',
    description: 'Your own torrent server inside Stremio. Browse everything added on your Streamtor server and stream it with on-the-fly conversion for MKV, HEVC and friends.',
    logo: `${root}/favicon.svg`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: [STREMIO_PREFIX],
    catalogs: [
      { type: 'movie', id: 'library', name: 'Streamtor Library', extra: [{ name: 'search', isRequired: false }] },
      { type: 'series', id: 'library', name: 'Streamtor Library', extra: [{ name: 'search', isRequired: false }] }
    ],
    behaviorHints: { adult: false, p2p: false, configurable: false }
  };
}

function stremioCatalog(base, list, q = '') {
  const needle = String(q).trim().toLowerCase();
  return {
    metas: list
      .filter((t) => !needle || (t.name || '').toLowerCase().includes(needle))
      .map((t) => {
        const n = (t.files || []).length;
        return {
          id: `${STREMIO_PREFIX}:${t.infoHash}`,
          type: isSeriesTorrent(t) ? 'series' : 'movie',
          name: t.name || t.infoHash,
          poster: `${base}/poster/${t.infoHash}.svg`,
          posterShape: 'regular',
          description: `${n} file${n === 1 ? '' : 's'} · ${stremioBytes(t.length || 0)}${t.ready ? '' : ' · fetching metadata'}`
        };
      })
  };
}

function stremioMeta(t, base) {
  if (!t) return { meta: {} };
  const series = isSeriesTorrent(t);
  const meta = {
    id: `${STREMIO_PREFIX}:${t.infoHash}`,
    type: series ? 'series' : 'movie',
    name: t.name || t.infoHash,
    poster: `${base}/poster/${t.infoHash}.svg`,
    posterShape: 'regular',
    description: `${(t.files || []).length} files · ${stremioBytes(t.length || 0)} · streamed by your Streamtor server`
  };
  if (series) {
    // Episode pack: build one video entry per playable video file. Files with SxxEyy keep their
    // numbers; the rest get sequential fallback numbers so Stremio still lists them as episodes.
    const vids = stremioPlayable(t).filter(({ f }) => STREMIO_VIDEO.has(extOf(f.name)));
    const parsed = vids.map(({ f, index }) => {
      const m = EP_RE.exec(f.name);
      return { f, index, s: m ? Number(m[1] || m[3]) : 1, e: m ? Number(m[2] || m[4]) : 0, named: !!m };
    }).sort((a, b) => a.s - b.s || (a.e || 9e9) - (b.e || 9e9) || a.f.name.localeCompare(b.f.name));
    let seq = 0;
    meta.videos = parsed.map((v) => ({
      id: `${STREMIO_PREFIX}:${t.infoHash}:f${v.index}`,
      season: v.s,
      episode: v.named ? v.e : ++seq,
      name: v.f.name,
      description: stremioBytes(v.f.length || 0)
    }));
  }
  return { meta };
}

function stremioStreams(t, base, type, id) {
  if (!t) return { streams: [] };
  const m = stremioIdHash(id);
  if (!m || m[1].toLowerCase() !== String(t.infoHash).toLowerCase()) return { streams: [] };
  let files = stremioPlayable(t);
  if (m[2] !== undefined) files = files.filter((x) => x.index === Number(m[2]));
  else files.sort((a, b) => (STREMIO_VIDEO.has(extOf(b.f.name)) - STREMIO_VIDEO.has(extOf(a.f.name))) || b.f.length - a.f.length);
  return {
    streams: files.map(({ f, index }) => ({
      name: 'Streamtor',
      title: f.name,
      description: stremioBytes(f.length || 0),
      url: `${base}/dl/${t.infoHash}/${index}`,
      behaviorHints: { notWebReady: false, bingeGroup: `streamtor-${t.infoHash}` }
    }))
  };
}

const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Deterministic gradient poster with the torrent's initials — real artwork is not available.
function stremioPoster(name, hash) {
  const words = String(name || '').replace(/[._]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] || 'S') + (words[1]?.[0] || words[0]?.[1] || 'T')).toUpperCase();
  const h = parseInt(String(hash || '').slice(0, 4), 16) || 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${h % 360} 62% 42%)"/><stop offset="1" stop-color="hsl(${(h + 55) % 360} 68% 28%)"/>`
    + `</linearGradient></defs><rect width="300" height="450" fill="url(#g)"/>`
    + `<text x="150" y="222" font-family="Arial,Helvetica,sans-serif" font-size="104" font-weight="700" fill="rgba(255,255,255,.92)" text-anchor="middle">${xmlEsc(initials)}</text>`
    + `<text x="150" y="268" font-family="Arial,Helvetica,sans-serif" font-size="17" fill="rgba(255,255,255,.78)" text-anchor="middle">${xmlEsc(String(name || 'Streamtor').slice(0, 30))}</text></svg>`;
}

async function handleStremio(req, res, url) {
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (!CFG.engine) return json(res, 404, { error: 'Server engine disabled' }, CORS);
  const m = /^\/stremio\/([^/]+)(\/.*)?$/i.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'Not found' }, CORS);
  let code = m[1];
  try { code = decodeURIComponent(code); } catch { return json(res, 404, { error: 'Bad addon code' }, CORS); }
  if (CFG.accessCode) {
    const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(code).digest(), crypto.createHash('sha256').update(CFG.accessCode).digest());
    if (!ok) return json(res, 401, { error: 'Invalid addon access code. Use your server ACCESS_CODE in the addon URL.' }, CORS);
  }
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] === 'https' ? 'https' : 'http';
  const origin = `${proto}://${req.headers.host || 'localhost'}`;
  const base = stremioBase(origin, code);
  const rest = m[2] || '';
  let mm;
  if (rest === '/manifest.json') return json(res, 200, stremioManifest(origin, code), CORS);
  if ((mm = /^\/catalog\/(movie|series)\/(.+)\.json$/i.exec(rest))) {
    const q = /(?:^|\/|&)search=([^&]*)/.exec(mm[2])?.[1] || '';
    let qs = q; try { qs = decodeURIComponent(q); } catch { /* keep raw */ }
    const wantSeries = mm[1].toLowerCase() === 'series';
    const list = (client?.torrents || []).filter((t) => isSeriesTorrent(t) === wantSeries);
    return json(res, 200, stremioCatalog(base, list, qs), CORS);
  }
  if ((mm = /^\/meta\/(movie|series)\/(.+)\.json$/i.exec(rest))) {
    const h = stremioIdHash(mm[2]);
    const t = h ? await find(h[1].toLowerCase()) : null;
    if (t) touch(t);
    return json(res, 200, stremioMeta(t, base), CORS);
  }
  if ((mm = /^\/stream\/(movie|series)\/(.+)\.json$/i.exec(rest))) {
    const h = stremioIdHash(mm[2]);
    const t = h ? await find(h[1].toLowerCase()) : null;
    if (t) touch(t);
    return json(res, 200, stremioStreams(t, base, mm[1].toLowerCase(), mm[2]), CORS);
  }
  if ((mm = /^\/poster\/([a-f0-9]{40})\.svg$/i.exec(rest))) {
    const t = await find(mm[1].toLowerCase());
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', ...CORS });
    return res.end(stremioPoster(t?.name, mm[1]));
  }
  if ((mm = /^\/dl\/([a-f0-9]{40})\/(\d+)$/i.exec(rest))) return streamByHashIdx(req, res, url, mm[1], mm[2]);
  return json(res, 404, { error: 'Not found' }, CORS);
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  const rel = path.relative(PUBLIC, file);
  const base = path.basename(file).toLowerCase();
  if (rel.startsWith('..') || rel.startsWith('.') || rel.startsWith('node_modules') || PRIVATE_FILES.has(base)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Only bind the HTTP port when run directly (`node server.js`), so tests can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Crash guards only for a real server process — loaded by tests as a library, they would mask failures there.
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
  process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname.startsWith('/stremio/')) return await handleStremio(req, res, url);
      if (url.pathname.startsWith('/stream/')) return await handleStream(req, res, url);
      serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.message || 'Server error' });
      else res.end();
    }
  }).listen(CFG.port, '0.0.0.0', () => console.log(`Streamtor on :${CFG.port} | engine=${CFG.engine} | ffmpeg=${!!ffmpegPath} | access code ${CFG.accessCode ? 'ON' : 'OFF'}`));
}

export { probeCodecs, buildConvertArgs, computeMoviehash, subToVtt, getSubtitleVtt, CFG,
  stremioManifest, stremioCatalog, stremioMeta, stremioStreams, stremioPoster, isSeriesTorrent };
