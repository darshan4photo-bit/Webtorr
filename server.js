// Streamtor server — static site + optional server-side torrent engine (for Render/VPS).
// Requires Node >= 22.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';

let ffmpegPath = null;
try { ffmpegPath = (await import('ffmpeg-static')).default; } catch { /* optional */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const env = process.env;
const CFG = {
  port: Number(env.PORT) || 3000,
  engine: env.ENABLE_ENGINE !== 'false',                 // set ENABLE_ENGINE=false for static-only
  accessCode: env.ACCESS_CODE || '',                     // strongly recommended on a public host
  secret: env.SESSION_SECRET || env.ACCESS_CODE || crypto.randomBytes(16).toString('hex'),
  dir: env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'streamtor'),
  maxTorrents: Number(env.MAX_TORRENTS) || 2,
  maxSize: (Number(env.MAX_SIZE_GB) || 15) * 1024 ** 3,
  idleMs: (Number(env.IDLE_MINUTES) || 20) * 60_000,
  metaTimeout: (Number(env.METADATA_TIMEOUT_SEC) || 75) * 1000,
  uploadLimit: (Number(env.UPLOAD_LIMIT_KBPS) || 100) * 1024
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

/* ---------------- streaming ---------------- */
function streamFile(req, res, file, url, hash, idx) {
  const ext = path.extname(file.name).toLowerCase();
  const remux = url.searchParams.get('remux') === '1';
  const download = url.searchParams.get('download') === '1';
  const base = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };

  if (download) base['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;

  if (remux && !download) {
    if (!ffmpegPath) return json(res, 501, { error: 'ffmpeg is not available on this server.' });
    // ffmpeg reads the file through our own range endpoint (so it can seek, e.g. MP4 with moov at the end),
    // copies the video, converts audio to AAC stereo, and emits fragmented MP4 that browsers play progressively.
    const input = `http://127.0.0.1:${CFG.port}/stream/${hash}/${idx}?ik=${INTERNAL_KEY}`;
    const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-readrate', '3', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    res.writeHead(200, { ...base, 'Content-Type': 'video/mp4' });
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

async function handleStream(req, res, url) {
  if (!CFG.engine) return json(res, 404, { error: 'Server engine disabled' });
  if (!authed(req) && url.searchParams.get('ik') !== INTERNAL_KEY) return json(res, 401, { error: 'Access code required.' });
  const m = /^\/stream\/([a-f0-9]{40})\/(\d+)$/i.exec(url.pathname);
  if (!m) return json(res, 404, { error: 'Not found' });
  const t = await find(m[1].toLowerCase());
  const file = t?.files?.[Number(m[2])];
  if (!file) return json(res, 404, { error: 'Torrent or file not found (it may have expired).' });
  touch(t); file.select();
  streamFile(req, res, file, url, t.infoHash, Number(m[2]));
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/stream/')) return await handleStream(req, res, url);
    serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || 'Server error' });
    else res.end();
  }
}).listen(CFG.port, '0.0.0.0', () => console.log(`Streamtor on :${CFG.port} | engine=${CFG.engine} | ffmpeg=${!!ffmpegPath} | access code ${CFG.accessCode ? 'ON' : 'OFF'}`));

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));
