// Tests for the /api/subtitles pipeline (run: node tests/subtitles.test.mjs)
// No real network: OpenSubtitles is stubbed through the injectable fetch, and the endpoint
// tests spawn server.js on ephemeral ports without ever reaching the OpenSubtitles API
// (400/401/404/501 answers all resolve before any lookup would run).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { computeMoviehash, subToVtt, getSubtitleVtt, CFG } from '../server.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

const CHUNK = 65536;
const MASK = 0xFFFFFFFFFFFFFFFFn;
const fakeFile = (buf, name = 'Movie.2020.1080p.mkv') => ({
  length: buf.length,
  name,
  // WebTorrent's createReadStream takes an INCLUSIVE `end`.
  createReadStream: ({ start, end }) => Readable.from([buf.subarray(start, Math.min(end + 1, buf.length))])
});
const pattern = (len) => {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + (i >> 8) * 17) & 0xff;
  return b;
};

/* ---------------- moviehash correctness ---------------- */
// Independent reference of the official opensubtitlescli algorithm: seed with the file size,
// sum every little-endian uint64 word of the first and last 64 KiB, mod 2^64, 16 hex chars.
// Computed straight from the bytes — no streams, so it cross-checks the ranged reads too.
const refMoviehash = (buf) => {
  let sum = BigInt(buf.length);
  for (const slice of [buf.subarray(0, CHUNK), buf.subarray(buf.length - CHUNK)]) {
    for (let i = 0; i + 8 <= slice.length; i += 8) sum += slice.readBigUInt64LE(i);
  }
  return (sum & MASK).toString(16).padStart(16, '0');
};

// Hand-verifiable: all-zero file → every word is 0 → sum = size = 131072 = 0x20000 → padded.
const zeroMh = await computeMoviehash(fakeFile(Buffer.alloc(131072)));
check('moviehash: all-zero 128 KiB file equals known value (size seeded, zero padded)', zeroMh === '0000000000020000', String(zeroMh));

// Closed form for an all-0x01 128 KiB file: 8192 words of 0x0101010101010101 per 64 KiB
// chunk (65536/8), two chunks, plus the size seed.
const onesMh = await computeMoviehash(fakeFile(Buffer.alloc(131072, 0x01)));
const onesExpected = ((131072n + 16384n * 0x0101010101010101n) & MASK).toString(16).padStart(16, '0');
check('moviehash: all-0x01 128 KiB file matches closed-form sum', onesMh === onesExpected, `${onesMh} != ${onesExpected}`);

const pat = pattern(200 * 1024);
const patMh = await computeMoviehash(fakeFile(pat));
check('moviehash: 200 KiB patterned file matches reference (head + tail ranges)', patMh === refMoviehash(pat), `${patMh} != ${refMoviehash(pat)}`);
check('moviehash: output is 16 lowercase hex chars', /^[0-9a-f]{16}$/.test(String(patMh)), String(patMh));

// Wrap-around: 16384 words of 0xFF…FF massively exceed 2^64 — the mod must be applied.
const ffBuf = Buffer.alloc(256 * 1024, 0xff);
let raw = BigInt(ffBuf.length);
for (const slice of [ffBuf.subarray(0, CHUNK), ffBuf.subarray(ffBuf.length - CHUNK)]) {
  for (let i = 0; i + 8 <= slice.length; i += 8) raw += slice.readBigUInt64LE(i);
}
check('moviehash: overflow fixture actually exceeds 2^64 (wraparound exercised)', raw > MASK, String(raw));
const ffMh = await computeMoviehash(fakeFile(ffBuf));
check('moviehash: sum wraps mod 2^64', ffMh === (raw & MASK).toString(16).padStart(16, '0'), `${ffMh} != ${raw & MASK}`);

const tiny = await computeMoviehash(fakeFile(Buffer.alloc(1000)));
check('moviehash: files below 128 KiB return null (falls back to filename search)', tiny === null, String(tiny));

/* ---------------- conversion: SRT / gzip / VTT / ASS → VTT ---------------- */
const SRT = '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there\r\n\r\n2\r\n00:00:04,100 --> 00:00:06,000\r\nSecond line\r\n';

const vSrt = await subToVtt(Buffer.from(SRT), 'movie.en.srt');
check('srt→vtt: WEBVTT header + dot timestamps', !!vSrt && vSrt.startsWith('WEBVTT') && vSrt.includes('00:00:01.000 --> 00:00:03.500') && !/,\d{3}\s*-->/.test(vSrt), String(vSrt).slice(0, 120));

const vGz = await subToVtt(zlib.gzipSync(Buffer.from(SRT)), 'movie.en.srt');
check('gzip-compressed srt is unpacked and converted', !!vGz && vGz.startsWith('WEBVTT') && vGz.includes('Hello there'), String(vGz).slice(0, 120));

const vPas = await subToVtt(Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\r\n'), 'movie.en.vtt');
check('existing VTT passes through with a single header', !!vPas && vPas.startsWith('WEBVTT') && !vPas.slice(4).includes('WEBVTT') && !vPas.includes('\r'), String(vPas).slice(0, 80));

check('empty input → null', (await subToVtt(Buffer.alloc(0), 'x.srt')) === null);

const ASS = [
  '[Script Info]', 'Title: Test', 'ScriptType: v4.00+', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1', '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello from ASS', ''
].join('\n');
const vAss = await subToVtt(Buffer.from(ASS), 'movie.eng.ass');
check('ass→vtt via ffmpeg', !!vAss && vAss.includes('WEBVTT') && vAss.includes('Hello from ASS'), String(vAss).slice(0, 160));

/* ---------------- lookup flow: search → download → convert → cache ---------------- */
CFG.osKey = 'unit-test-key'; // env has no key; the route/flow reads CFG at call time
const content = pattern(256 * 1024);
const file = fakeFile(content);
const expectedMh = refMoviehash(content); // independent of computeMoviehash

const mkFetch = ({ calls, mode = 'hit', payload = Buffer.from(SRT) }) => async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers });
  if (u.includes('/api/v1/subtitles')) {
    const byMh = u.includes('moviehash=');
    if (mode === 'miss' || (mode === 'mh-miss' && byMh)) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: true, json: async () => ({ data: [{ attributes: { files: [{ file_id: 4242, file_name: 'Movie.en.srt' }] } }] }) };
  }
  if (u.includes('/api/v1/download')) return { ok: true, json: async () => ({ link: 'https://dl.test/sub.bin' }) };
  if (u.includes('dl.test')) return { ok: true, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) };
  throw new Error('unexpected fetch: ' + u);
};

const t1 = { infoHash: 'a'.repeat(40) };
const c1 = [];
const f1 = mkFetch({ calls: c1 });
const out1 = await getSubtitleVtt(t1, file, 0, 'en', { fetchImpl: f1 });
check('lookup: returns VTT text', !!out1 && out1.startsWith('WEBVTT') && out1.includes('Hello there'), String(out1).slice(0, 120));
check('lookup: primary search uses the moviehash', c1[0]?.url.includes('/api/v1/subtitles') && c1[0].url.includes(`moviehash=${expectedMh}`), c1[0]?.url);
check('lookup: Api-Key header sent to OpenSubtitles', c1[0]?.headers?.['Api-Key'] === 'unit-test-key', JSON.stringify(c1[0]?.headers));
check('lookup: file downloaded via POST /download', c1.some((c) => c.url.includes('/api/v1/download') && c.method === 'POST'));

const n1 = c1.length;
const out2 = await getSubtitleVtt(t1, file, 0, 'en', { fetchImpl: f1 });
check('cache: repeat request served from memory (zero network calls)', out2 === out1 && c1.length === n1, `calls ${n1} → ${c1.length}`);

const n2 = c1.length;
const outFr = await getSubtitleVtt(t1, file, 0, 'fr', { fetchImpl: f1 });
check('cache: different language performs a fresh lookup', !!outFr && c1.length > n2, `calls ${n2} → ${c1.length}`);

// Misses must NOT be cached: the subtitle DB grows, so a retry later can succeed.
const t2 = { infoHash: 'b'.repeat(40) };
const c2 = [];
const missFetch = mkFetch({ calls: c2, mode: 'miss' });
const m1 = await getSubtitleVtt(t2, file, 3, 'en', { fetchImpl: missFetch });
const afterMiss = c2.length;
const m2 = await getSubtitleVtt(t2, file, 3, 'en', { fetchImpl: missFetch });
check('miss: returns null and is not cached', m1 === null && m2 === null && c2.length > afterMiss, `calls ${afterMiss} → ${c2.length}`);
const c2b = [];
const m3 = await getSubtitleVtt(t2, file, 3, 'en', { fetchImpl: mkFetch({ calls: c2b }) });
check('miss: a later hit for the same key still works', !!m3 && m3.startsWith('WEBVTT'), String(m3).slice(0, 80));

// Filename fallback when the moviehash finds nothing.
const t3 = { infoHash: 'c'.repeat(40) };
const c3 = [];
const fb = await getSubtitleVtt(t3, file, 7, 'en', { fetchImpl: mkFetch({ calls: c3, mode: 'mh-miss' }) });
const searches = c3.filter((c) => c.url.includes('/api/v1/subtitles'));
check('fallback: moviehash miss → filename query search', !!fb && searches.length >= 2 && searches[0].url.includes('moviehash=') && searches[1].url.includes('query=Movie.2020.1080p'), searches.map((s) => s.url).join(' | ').slice(0, 200));

// Gzipped download payload still converts.
const t4 = { infoHash: 'd'.repeat(40) };
const c4 = [];
const gz = await getSubtitleVtt(t4, file, 9, 'en', { fetchImpl: mkFetch({ calls: c4, payload: zlib.gzipSync(Buffer.from(SRT)) }) });
check('lookup: gzipped download converted to VTT', !!gz && gz.startsWith('WEBVTT') && gz.includes('Hello there'), String(gz).slice(0, 80));

// Without a key the flow bails out before touching the network.
CFG.osKey = '';
const t5 = { infoHash: 'e'.repeat(40) };
const c5 = [];
const noKey = await getSubtitleVtt(t5, file, 0, 'en', { fetchImpl: mkFetch({ calls: c5 }) });
check('no API key → null with zero network calls', noKey === null && c5.length === 0, `calls=${c5.length}`);
CFG.osKey = 'unit-test-key';

/* ---------------- endpoint behavior (spawned server) ---------------- */
const here = path.dirname(fileURLToPath(import.meta.url));
const children = new Set();
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } });
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const startServer = async (extra = {}) => {
  const env = { ...process.env };
  // hermetic: no inherited auth/subscription settings
  delete env.ACCESS_CODE; delete env.OPENSUBTITLES_API_KEY; delete env.SESSION_SECRET;
  Object.assign(env, { ENABLE_ENGINE: 'true' }, extra);
  const port = await freePort();
  env.PORT = String(port);
  const child = spawn(process.execPath, [path.join(here, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    if (child.exitCode !== null) throw new Error('server exited early:\n' + log);
    try { up = (await fetch(base + '/api/health')).ok; } catch { /* not listening yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error('server did not become ready:\n' + log);
  return { base, child };
};

const HASH = 'a'.repeat(40);
const A = await startServer({ ACCESS_CODE: 'sekrit', OPENSUBTITLES_API_KEY: 'test-key' });
try {
  const r401 = await fetch(`${A.base}/api/subtitles?hash=${HASH}&idx=0`);
  check('endpoint: unauthenticated request → 401 when ACCESS_CODE is set', r401.status === 401, String(r401.status));

  const cookie = `st_auth=${crypto.createHmac('sha256', 'sekrit').update('streamtor-auth').digest('hex')}`;
  const get = (q) => fetch(`${A.base}/api/subtitles?${q}`, { headers: { cookie } });
  check('endpoint: missing hash → 400', (await get('idx=0')).status === 400);
  check('endpoint: non-hex hash → 400', (await get(`hash=${'z'.repeat(40)}&idx=0`)).status === 400);
  check('endpoint: non-numeric idx → 400', (await get(`hash=${HASH}&idx=abc`)).status === 400);
  check('endpoint: malformed lang → 400', (await get(`hash=${HASH}&idx=0&lang=e`)).status === 400);
  const r404 = await get(`hash=${HASH}&idx=0&lang=en`);
  const j404 = await r404.json().catch(() => ({}));
  check('endpoint: unknown torrent → 404 JSON (no network lookup needed)', r404.status === 404 && /not found/i.test(j404.error || ''), `${r404.status} ${JSON.stringify(j404)}`);
} finally {
  A.child.kill('SIGKILL'); children.delete(A.child);
}

const B = await startServer({});
try {
  const r501 = await fetch(`${B.base}/api/subtitles?hash=${HASH}&idx=0&lang=en`);
  const j501 = await r501.json().catch(() => ({}));
  check('endpoint: 501 without OPENSUBTITLES_API_KEY', r501.status === 501 && /OPENSUBTITLES_API_KEY/.test(j501.error || ''), `${r501.status} ${JSON.stringify(j501)}`);
  const health = await (await fetch(`${B.base}/api/health`)).json();
  check('health: public route reports raised 250 GB size limit', health?.limits?.maxSizeGB === 250, JSON.stringify(health?.limits));
} finally {
  B.child.kill('SIGKILL'); children.delete(B.child);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll subtitle checks passed');
process.exit(failures ? 1 : 0);
