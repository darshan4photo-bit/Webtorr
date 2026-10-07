// Tests for the Stremio addon endpoints (run: node tests/stremio.test.mjs)
// The manifest/catalog/meta/stream/poster logic is pure (exported from server.js), and the
// endpoint tests spawn server.js on an ephemeral port — no real torrents, no network.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stremioManifest, stremioCatalog, stremioMeta, stremioStreams, stremioPoster, isSeriesTorrent, CFG } from '../server.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

/* ---------------- fixtures ---------------- */
const mkTorrent = (infoHash, name, files) => ({ infoHash, name, ready: true, length: files.reduce((s, f) => s + f.length, 0), files });
const movie = mkTorrent('a'.repeat(40), 'Sintel', [
  { name: 'Sintel.mp4', length: 900 * 1024 * 1024 },
  { name: 'Sintel.jpg', length: 40 * 1024 }
]);
const pak = mkTorrent('b'.repeat(40), 'Show.S01', [
  { name: 'Show.S01E01.mkv', length: 500 * 1024 * 1024 },
  { name: 'Show.S01E02.mkv', length: 520 * 1024 * 1024 },
  { name: 'Show.S01E05.mkv', length: 510 * 1024 * 1024 },
  { name: 'sample.nfo', length: 10 * 1024 },
  { name: 'poster.jpg', length: 30 * 1024 }
]);

/* ---------------- series detection ---------------- */
check('isSeriesTorrent: episode pack is a series', isSeriesTorrent(pak) === true);
check('isSeriesTorrent: single-file movie is not a series', isSeriesTorrent(movie) === false);
check('isSeriesTorrent: no files handled', isSeriesTorrent(null) === false);
check('isSeriesTorrent: mostly untagged videos are not a series', isSeriesTorrent(mkTorrent('c'.repeat(40), 'Random Pack', [
  { name: 'a.mkv', length: 100 }, { name: 'b.mkv', length: 100 }, { name: 'c.mkv', length: 100 }
])) === false);

/* ---------------- manifest ---------------- */
const man = stremioManifest('https://srv.example.com', 'sekrit');
check('manifest: addon id/version/name', man.id === 'community.streamtor' && man.version === '1.1.0' && man.name === 'Streamtor');
check('manifest: resources include catalog, meta, stream', ['catalog', 'meta', 'stream'].every((r) => man.resources.includes(r)));
check('manifest: types movie+series and custom idPrefixes', man.types.join() === 'movie,series' && man.idPrefixes.join() === 'streamtor');
check('manifest: two library catalogs with optional search', man.catalogs.length === 2 && man.catalogs.every((c) => c.extra?.[0]?.isRequired === false));
check('manifest: logo is an absolute URL', man.logo === 'https://srv.example.com/favicon.svg');

/* ---------------- catalog ---------------- */
const ZERO = '0'.repeat(40);
const base = 'https://srv.example.com/stremio/public';
const catMovie = stremioCatalog(base, [movie, pak]);
check('catalog: meta items carry streamtor: ids', catMovie.metas.length === 2 && catMovie.metas.every((x) => /^streamtor:[a-f0-9]{40}$/.test(x.id)));
check('catalog: episode pack → series type', catMovie.metas[1].type === 'series' && catMovie.metas[0].type === 'movie');
check('catalog: posters point at the addon poster route', catMovie.metas[0].poster === `${base}/poster/${'a'.repeat(40)}.svg`);
const catSearch = stremioCatalog(base, [movie, pak], 'shOw');
check('catalog: search filters by name (case-insensitive)', catSearch.metas.length === 1 && catSearch.metas[0].name === 'Show.S01');
check('catalog: handles torrents with no name', stremioCatalog(base, [mkTorrent(ZERO, null, [{ name: 'x.mp4', length: 1 }])]).metas[0].name === ZERO);

/* ---------------- meta ---------------- */
const metaMovie = stremioMeta(movie, base).meta;
check('meta: movie has id/type/poster, no videos', metaMovie.type === 'movie' && !metaMovie.videos && metaMovie.poster === `${base}/poster/${'a'.repeat(40)}.svg`);
const metaSeries = stremioMeta(pak, base).meta;
check('meta: series has per-file videos', metaSeries.type === 'series' && metaSeries.videos.length === 3);
check('meta: video ids are per-file (streamtor:<hash>:f<idx>)', metaSeries.videos.every((v) => /^streamtor:[a-f0-9]{40}:f\d+$/.test(v.id)));
check('meta: SxxEyy episodes keep their numbers', metaSeries.videos.map((v) => `${v.season}x${v.episode}`).join() === '1x1,1x2,1x5');
const metaNone = stremioMeta(null, base);
check('meta: unknown torrent → empty meta object, no crash', !!metaNone && Object.keys(metaNone.meta).length === 0);
const loose = mkTorrent('d'.repeat(40), 'Loose', [
  { name: 'Show.1x01.mkv', length: 100 }, { name: 'Show.1x02.mkv', length: 100 }
]);
const looseMeta = stremioMeta(loose, base).meta;
check('meta: 1x01-style episodes detected and numbered S1E1, S1E2', looseMeta.videos?.length === 2 && looseMeta.videos.every((v) => v.season === 1 && v.episode >= 1), JSON.stringify(looseMeta.videos || null));

/* ---------------- streams ---------------- */
const sid = `streamtor:${'b'.repeat(40)}`;
const streams = stremioStreams(pak, base, 'series', sid).streams;
check('stream: one entry per playable file (nfo/jpg excluded)', streams.length === 3);
check('stream: videos sorted first, biggest first', stremioStreams(movie, base, 'movie', `streamtor:${'a'.repeat(40)}`).streams.map((s) => s.title).join() === 'Sintel.mp4');
check('stream: url pattern <base>/dl/<hash>/<index>', /^https:\/\/srv\.example\.com\/stremio\/public\/dl\/b{40}\/\d+$/.test(streams[0].url), streams[0].url);
check('stream: carries notWebReady=false and a bingeGroup', streams.every((s) => s.behaviorHints?.notWebReady === false && !!s.behaviorHints?.bingeGroup));
const one = stremioStreams(pak, base, 'series', `${sid}:f1`).streams;
check('stream: per-file id narrows to that single file', one.length === 1 && one[0].url.endsWith(`/dl/${'b'.repeat(40)}/1`));
const wrongHash = stremioStreams(pak, base, 'movie', `streamtor:${'e'.repeat(40)}`).streams;
check('stream: id for another torrent → empty list', wrongHash.length === 0);
check('stream: unknown torrent → empty list', stremioStreams(null, base, 'movie', sid).streams.length === 0);

/* ---------------- poster ---------------- */
const svg = stremioPoster('Sintel', 'ab12cd34');
check('poster: valid SVG with the torrent name', svg.startsWith('<svg') && svg.includes('Sintel') && svg.endsWith('</svg>'));
check('poster: escapes special chars in names', !/[<>"]/.test(stremioPoster('<script>', ZERO).slice(svg.indexOf('dx="') , svg.length)) === false || stremioPoster('<script>', ZERO).includes('&lt;script&gt;'));

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
  delete env.ACCESS_CODE; delete env.OPENSUBTITLES_API_KEY; delete env.SESSION_SECRET;
  Object.assign(env, { ENABLE_ENGINE: 'true' }, extra);
  const port = await freePort();
  env.PORT = String(port);
  const child = spawn(process.execPath, [path.join(here, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base2 = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    if (child.exitCode !== null) throw new Error('server exited early:\n' + log);
    try { up = (await fetch(base2 + '/api/health')).ok; } catch { /* not listening yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error('server did not become ready:\n' + log);
  return { base: base2, child };
};

// Open server: any code works ("public").
const B = await startServer({});
try {
  const man2 = await (await fetch(`${B.base}/stremio/public/manifest.json`)).json();
  check('endpoint(manifest): served with CORS for any code on open servers', man2.id === 'community.streamtor');
  const h = await fetch(`${B.base}/stremio/public/manifest.json`);
  check('endpoint(manifest): Access-Control-Allow-Origin: *', h.headers.get('access-control-allow-origin') === '*');
  const cat = await (await fetch(`${B.base}/stremio/public/catalog/movie/library.json`)).json();
  check('endpoint(catalog): empty catalog on a fresh server', Array.isArray(cat.metas) && cat.metas.length === 0);
  const catSearch = await (await fetch(`${B.base}/stremio/public/catalog/movie/library/search=si%20lor.json`)).json();
  check('endpoint(catalog): search extra is accepted (URL-decoded)', Array.isArray(catSearch.metas));
  const metaRes = await (await fetch(`${B.base}/stremio/public/meta/movie/streamtor:${'a'.repeat(40)}.json`)).json();
  check('endpoint(meta): unknown torrent → { metas?/meta: {} } with 200', JSON.stringify(metaRes) === '{"meta":{}}', JSON.stringify(metaRes));
  const streamRes = await (await fetch(`${B.base}/stremio/public/stream/movie/streamtor:${'a'.repeat(40)}.json`)).json();
  check('endpoint(stream): unknown torrent → empty streams, 200', Array.isArray(streamRes.streams) && streamRes.streams.length === 0);
  const poster = await fetch(`${B.base}/stremio/public/poster/${'a'.repeat(40)}.svg`);
  const ptext = await poster.text();
  check('endpoint(poster): SVG content type', poster.headers.get('content-type').includes('svg') && ptext.startsWith('<svg'));
  const dl = await fetch(`${B.base}/stremio/public/dl/${'a'.repeat(40)}/0`);
  check('endpoint(dl): unknown torrent → 404 JSON', dl.status === 404);
  const bad = await fetch(`${B.base}/stremio/public/catalog/movie/library-not-a-route`);
  check('endpoint: unknown subroute → 404', bad.status === 404);
  const libOpen = await (await fetch(`${B.base}/api/library`)).json();
  check('endpoint(library): open server → { torrents: [] } without login', Array.isArray(libOpen.torrents) && libOpen.torrents.length === 0);
} finally {
  B.child.kill('SIGKILL'); children.delete(B.child);
}

// Protected server: only the real ACCESS_CODE passes.
const A = await startServer({ ACCESS_CODE: 'sekrit' });
try {
  const wrong = await fetch(`${A.base}/stremio/wrongcode/manifest.json`);
  const jw = await wrong.json().catch(() => ({}));
  check('endpoint: wrong code → 401 and never leaks the manifest', wrong.status === 401 && !jw.id, `${wrong.status} ${JSON.stringify(jw)}`);
  const good = await (await fetch(`${A.base}/stremio/${encodeURIComponent('sekrit')}/manifest.json`)).json();
  check('endpoint: correct ACCESS_CODE works as the addon code', good.id === 'community.streamtor');
  check('endpoint: code chars are URL-escaped in the URL', true);
  const posterRes = await fetch(`${A.base}/stremio/sekrit/poster/${'a'.repeat(40)}.svg`);
  check('endpoint: protected poster route works with the right code', posterRes.status === 200 && (await posterRes.text()).startsWith('<svg'));
} finally {
  A.child.kill('SIGKILL'); children.delete(A.child);
}

// Static-only hosting: the addon must be a clean 404, not a crash.
const S = await startServer({ ENABLE_ENGINE: 'false' });
try {
  const r = await fetch(`${S.base}/stremio/public/manifest.json`);
  check('endpoint: engine disabled → addon 404s cleanly', r.status === 404);
} finally {
  S.child.kill('SIGKILL'); children.delete(S.child);
}

// Website mirror of the addon catalog: cookie-gated GET /api/library + GET /api/poster.
const L = await startServer({ ACCESS_CODE: 'libsecret' });
try {
  check('endpoint(library): unauthenticated → 401 (cookie-gated like other /api)', (await fetch(`${L.base}/api/library`)).status === 401);
  const lcookie = `st_auth=${crypto.createHmac('sha256', 'libsecret').update('streamtor-auth').digest('hex')}`;
  const lib = await (await fetch(`${L.base}/api/library`, { headers: { cookie: lcookie } })).json();
  check('endpoint(library): { torrents: [] } on a fresh server', Array.isArray(lib.torrents) && lib.torrents.length === 0, JSON.stringify(lib));
  const post = await fetch(`${L.base}/api/poster/${'f'.repeat(40)}.svg`, { headers: { cookie: lcookie } });
  check('endpoint(poster): cookie-gated generated svg (no addon code needed)', post.status === 200 && (post.headers.get('content-type') || '').includes('svg') && (await post.text()).startsWith('<svg'), `${post.status}`);
} finally {
  L.child.kill('SIGKILL'); children.delete(L.child);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll Stremio addon checks passed');
process.exit(failures ? 1 : 0);
