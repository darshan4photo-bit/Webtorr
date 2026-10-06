import WebTorrent from './webtorrent.min.js';

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'];
const tr = TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('');
const SAMPLES = {
  sintel: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel' + tr,
  tos: 'magnet:?xt=urn:btih:209c8226b299b308beaf2b9cd3fb49212dbd13ec&dn=Tears+of+Steel' + tr,
  cosmos: 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056&dn=Cosmos+Laundromat' + tr
};
const EXT = {
  video: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'avi', 'ts', 'wmv', 'flv'],
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp'],
  sub: ['srt', 'vtt']
};
const NATIVE_VIDEO = ['mp4', 'm4v', 'webm', 'ogv'];
const NATIVE_AUDIO = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav'];
const ext = (n) => (n.split('.').pop() || '').toLowerCase();
const kindOf = (n) => Object.keys(EXT).find((k) => EXT[k].includes(ext(n))) || 'other';
const ICON = { video: '🎬', audio: '🎵', image: '🖼️', sub: '💬', other: '📄' };
const bytes = (n) => { if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4); return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i]; };
const notice = (m) => { const n = $('notice'); if (n) { n.textContent = m; n.hidden = !m; } };
const showError = (m) => { const e = $('error'); e.textContent = m; e.hidden = !m; };

/* ---------- backend detection ---------- */
let backend = null;        // {server, auth, authed, ffmpeg, limits} or null (static hosting)
let mode = 'browser';      // 'server' | 'browser'
async function detectBackend() {
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw 0;
    const j = await r.json();
    if (!j.server) throw 0;
    backend = j; mode = 'server';
    $('engineBox').hidden = false;
    $('loginForm').hidden = !(j.auth && !j.authed);
    $('addForm').hidden = j.auth && !j.authed;
  } catch { backend = null; mode = 'browser'; }
}
const ready = detectBackend();

document.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.engine;
  document.querySelectorAll('[data-engine]').forEach((x) => x.classList.toggle('on', x === b));
}));
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); showError('');
  const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('codeInput').value }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return showError(j.error || 'Login failed');
  backend.authed = true; $('loginForm').hidden = true; $('addForm').hidden = false;
});

/* ---------- browser engine (WebTorrent + service worker) ---------- */
let client = null, serverReady = null, useSW = false;
function getClient() {
  if (client) return client;
  client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }] } } });
  client.on('error', (e) => showError('Client error: ' + (e.message || e)));
  return client;
}
function initSW() {
  if (serverReady) return serverReady;
  serverReady = (async () => {
    getClient();
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      notice('⚠️ This page isn’t on HTTPS, so live streaming is unavailable. Files will play only after they finish downloading. Enable HTTPS on your host for instant streaming.');
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.register('./sw.min.js', { scope: './' });
      await navigator.serviceWorker.ready;
      client.createServer({ controller: reg });
      useSW = true; return true;
    } catch (e) {
      notice('⚠️ Streaming service worker failed (' + (e.message || e) + '). Make sure sw.min.js is next to index.html. Falling back to play-after-download.');
      return false;
    }
  })();
  return serverReady;
}

/* ---------- state ---------- */
let cur = null;   // {kind:'browser'|'server', hash, t?, files[]}
let ticker = null, activeFile = null, objectUrls = [], remuxActive = false;

const fileUrl = (f, q = '') => cur.kind === 'server' ? `stream/${cur.hash}/${f.index}${q}` : f.streamURL;
const selectFile = (f) => cur.kind === 'browser' && f.select();
async function readText(f) {
  if (cur.kind === 'server') return (await fetch(fileUrl(f))).text();
  f.select(); return (await f.blob()).text();
}

/* ---------- add torrent ---------- */
async function start(source, label) {
  await ready;
  showError(''); notice('');
  let s = typeof source === 'string' ? source.trim() : source;
  if (!s) return;
  if (typeof s === 'string') {
    if (/^[a-f0-9]{40}$/i.test(s)) s = 'magnet:?xt=urn:btih:' + s;
    else if (!/^(magnet:|https?:\/\/)/i.test(s)) return showError('That doesn’t look like a magnet link, info-hash or .torrent URL.');
  }
  await resetView();
  $('hero').hidden = true; $('view').hidden = false;
  $('tName').textContent = label || 'Fetching metadata…';
  $('files').innerHTML = ''; window.scrollTo({ top: 0 });
  $('peerPill').textContent = '● live'; $('peerPill').classList.add('live');
  if (mode === 'server' && backend) return startServer(s);
  return startBrowser(s);
}

function backHome(msg) {
  resetView(); $('view').hidden = true; $('hero').hidden = false;
  if (msg) showError(msg);
  history.replaceState(null, '', location.pathname);
}

async function startServer(s) {
  $('sStatus').textContent = 'Finding peers on server…';
  const t0 = Date.now();
  const wait = setInterval(() => { $('sStatus').textContent = `Finding peers on server… ${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
  let info;
  try {
    const isFile = typeof s !== 'string';
    const r = await fetch('api/add', isFile
      ? { method: 'POST', headers: { 'Content-Type': 'application/x-bittorrent' }, body: await s.arrayBuffer() }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: s }) });
    info = await r.json().catch(() => ({}));
    if (r.status === 401) { backend.authed = false; $('loginForm').hidden = false; $('addForm').hidden = true; clearInterval(wait); return backHome('Access code required.'); }
    if (!r.ok) { clearInterval(wait); return backHome(info.error || 'Server error'); }
  } catch (e) { clearInterval(wait); return backHome('Could not reach the server: ' + e.message); }
  clearInterval(wait);
  cur = { kind: 'server', hash: info.infoHash, files: info.files };
  history.replaceState(null, '', '#' + info.infoHash);
  renderFiles(info);
  ticker = setInterval(pollServer, 1000);
}
async function pollServer() {
  if (!cur || cur.kind !== 'server') return;
  try {
    const r = await fetch('api/torrent/' + cur.hash, { cache: 'no-store' });
    if (r.status === 404) { clearInterval(ticker); $('sStatus').textContent = 'Expired'; return notice('This torrent expired on the server (idle timeout). Add it again to continue.'); }
    const j = await r.json();
    j.files.forEach((f, i) => { cur.files[i].progress = f.progress; });
    paintStats({ progress: j.progress, down: j.downloadSpeed, up: j.uploadSpeed, peers: j.numPeers, meta: true });
  } catch { /* transient */ }
}

async function startBrowser(s) {
  await initSW();
  let t;
  try { t = getClient().add(s, { deselect: true }); } catch (e) { return backHome(e.message); }
  cur = { kind: 'browser', t, hash: null, files: [] };
  $('sStatus').textContent = 'Finding peers…';
  t.on('infoHash', () => { cur && (cur.hash = t.infoHash); history.replaceState(null, '', '#' + t.infoHash); });
  t.on('error', (e) => {
    const m = e.message || String(e);
    showError(/quota/i.test(m) ? 'Your browser ran out of temporary storage (common in private/incognito windows or when the disk is nearly full). Try a normal window or a smaller torrent.' : m);
    clearInterval(ticker); $('sStatus').textContent = 'Error';
  });
  t.on('ready', () => {
    cur.files = t.files;
    renderFiles({ name: t.name, length: t.length, files: t.files });
  });
  ticker = setInterval(() => { paintStats({ progress: t.progress, down: t.downloadSpeed, up: t.uploadSpeed, peers: t.numPeers, meta: !!t.metadata }); }, 500);
  setTimeout(() => {
    if (cur && cur.t === t && !t.numPeers && t.progress === 0) {
      notice('No browser-compatible (WebRTC) peers found. This torrent may only be seeded by regular BitTorrent clients, which a web page cannot reach.' + (backend ? ' Switch Engine to “Server” to try it.' : ''));
    }
  }, 30000);
}

function renderFiles(info) {
  $('tName').textContent = info.name;
  $('sSize').textContent = bytes(info.length);
  $('fCount').textContent = `(${info.files.length})`;
  const list = $('files'); list.innerHTML = '';
  const files = cur.files;
  const subs = files.filter((f) => kindOf(f.name) === 'sub');
  const rank = (k) => ({ video: 0, audio: 1, image: 2 }[k] ?? 3);
  const order = files.map((f) => ({ f, k: kindOf(f.name) })).sort((a, b) => rank(a.k) - rank(b.k) || b.f.length - a.f.length);
  for (const { f, k } of order) {
    const li = document.createElement('li');
    li.className = 'file' + (k === 'other' || k === 'sub' ? ' na' : '');
    li.innerHTML = `<div class="ft">${ICON[k]}</div><div class="fi"><div class="fn"></div><div class="fm"><span>${bytes(f.length)}</span><span class="pc">0%</span></div><div class="fp"><i></i></div></div>`;
    li.querySelector('.fn').textContent = f.path.split(/[/\\]/).slice(1).join('/') || f.name;
    li.title = f.name;
    li.onclick = () => play(f, li, subs);
    f._li = li; list.appendChild(li);
  }
  // "More in this torrent" poster rail
  const media = order.filter((o) => o.k === 'video' || o.k === 'audio');
  const rail = $('posters');
  rail.innerHTML = '';
  for (const { f, k } of media) {
    const card = document.createElement('div');
    card.className = 'poster' + (k === 'audio' ? ' s2' : '');
    card.innerHTML = `<div class="thumb">${ICON[k]}<span class="play">▶</span><div class="fprog"><i></i></div></div>
      <div class="ptitle"></div><div class="pmeta"><span>${bytes(f.length)}</span><span class="pc">0%</span></div>`;
    card.querySelector('.ptitle').textContent = f.path.split(/[/\\]/).pop() || f.name;
    card.title = f.name;
    card.onclick = () => play(f, f._li, subs);
    f._card = card; rail.appendChild(card);
  }
  $('posterRow').hidden = media.length < 2;
  const playable = order.filter((o) => o.k === 'video' || o.k === 'audio');
  if (playable.length) {
    const first = playable[0].k;
    const best = playable.filter((o) => o.k === first).sort((a, b) => b.f.length - a.f.length)[0];
    play(best.f, best.f._li, subs);
  }
}

/* ---------- playback ---------- */
const srt2vtt = (s) => 'WEBVTT\n\n' + s.replace(/\r+/g, '').replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2');

async function play(file, li, subs, forceConvert = false) {
  const kind = kindOf(file.name);
  document.querySelectorAll('.file.active').forEach((x) => x.classList.remove('active'));
  li.classList.add('active');
  activeFile = file;
  const host = $('mediaHost'); host.innerHTML = '';
  objectUrls.forEach(URL.revokeObjectURL); objectUrls = [];
  $('placeholder').hidden = true; $('nowPlaying').hidden = false; $('nowName').textContent = file.name;
  $('dlNow').onclick = (e) => { e.preventDefault(); download(file); };
  const isMedia = kind === 'video' || kind === 'audio';
  const convertable = isMedia && cur.kind === 'server' && backend?.ffmpeg;
  const compat = $('compatBtn');
  compat.hidden = !convertable;
  compat.onclick = () => play(file, li, subs, !remuxActive);

  if (kind === 'other' || kind === 'sub') {
    $('placeholder').hidden = false;
    $('placeholder').querySelector('p').textContent = 'No in-browser preview for this file type — use Download.';
    return;
  }
  selectFile(file);
  const loading = document.createElement('div');
  loading.className = 'loading'; loading.textContent = 'Buffering…';
  const el = document.createElement(kind === 'image' ? 'img' : kind);
  if (kind !== 'image') { el.controls = true; el.autoplay = true; el.preload = 'auto'; el.playsInline = true; }
  host.append(el, loading);
  const clear = () => loading.remove();
  ['playing', 'load', 'canplay'].forEach((ev) => el.addEventListener(ev, clear));

  const native = kind === 'video' ? NATIVE_VIDEO.includes(ext(file.name)) : NATIVE_AUDIO.includes(ext(file.name));
  document.querySelectorAll('.poster.active').forEach((x) => x.classList.remove('active'));
  if (file._card) file._card.classList.add('active');
  let useRemux = convertable && (forceConvert || !native);
  remuxActive = useRemux;
  compat.textContent = useRemux ? '🛠 Compatibility mode: ON' : '🛠 Compatibility mode';
  if (useRemux) loading.textContent = 'Starting the stream on the server — a large file’s first seconds can take a moment…';

  let retried = false;
  el.addEventListener('error', () => {
    if (convertable && !remuxActive) { return play(file, li, subs, true); }
    // One automatic retry with a fresh ffmpeg process (e.g. if the server-side stream died).
    if (cur?.kind === 'server' && !retried) {
      retried = true;
      loading.textContent = 'Reconnecting to the server…';
      if (!loading.isConnected) host.append(loading);
      el.src = fileUrl(file, (useRemux ? '?convert=1&' : '?') + 'r=' + Date.now());
      return;
    }
    loading.textContent = 'Your browser can’t play this format (' + ext(file.name).toUpperCase() + ')' + (cur?.kind === 'server' ? '' : '. Use the Server engine or Download and open in VLC.') + '.';
    loading.style.pointerEvents = 'auto';
    if (!loading.isConnected) host.append(loading);
  });

  if (cur.kind === 'server') el.src = fileUrl(file, useRemux ? '?convert=1' : '');
  else if (useSW) el.src = file.streamURL;
  else {
    const tick = setInterval(() => { loading.textContent = `Downloading ${(file.progress * 100).toFixed(0)}% — will play when complete…`; }, 500);
    file.blob().then((b) => { clearInterval(tick); if (activeFile !== file) return; const u = URL.createObjectURL(b); objectUrls.push(u); el.src = u; })
      .catch((err) => { clearInterval(tick); loading.textContent = 'Error: ' + err.message; });
  }

  if (kind === 'video' && subs.length) {
    subs.forEach(async (sf, i) => {
      try {
        const text = await readText(sf);
        if (activeFile !== file) return;
        const vtt = ext(sf.name) === 'srt' ? srt2vtt(text) : text;
        const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })); objectUrls.push(url);
        const tk = document.createElement('track');
        tk.kind = 'subtitles'; tk.label = sf.name.replace(/\.[^.]+$/, ''); tk.src = url; if (i === 0) tk.default = true;
        el.appendChild(tk);
      } catch (e) { console.warn('subtitle failed', e); }
    });
  }
}

function download(file) {
  if (cur.kind === 'server') { const a = document.createElement('a'); a.href = fileUrl(file, '?download=1'); a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); return; }
  if (useSW) { const a = document.createElement('a'); a.href = file.streamURL; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); return; }
  file.select();
  file.blob().then((b) => { const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); });
}

/* ---------- stats ---------- */
function paintStats({ progress, down, up, peers, meta }) {
  const p = progress || 0;
  $('sProg').textContent = (p * 100).toFixed(1) + '%';
  $('bar').style.width = p * 100 + '%';
  $('sDown').textContent = bytes(down) + '/s';
  $('sUp').textContent = bytes(up) + '/s';
  $('sPeers').textContent = peers;
  $('sStatus').textContent = !meta ? (peers ? 'Fetching metadata…' : 'Finding peers…') : p >= 1 ? 'Complete ✓' : peers ? 'Streaming' : 'Waiting for peers…';
  for (const f of cur?.files || []) {
    if (!f._li) continue;
    const pr = f.progress || 0;
    f._li.querySelector('.fp i').style.width = pr * 100 + '%';
    f._li.querySelector('.pc').textContent = (pr * 100).toFixed(0) + '%';
    if (f._card) {
      f._card.querySelector('.fprog i').style.width = pr * 100 + '%';
      f._card.querySelector('.pmeta .pc').textContent = (pr * 100).toFixed(0) + '%';
    }
  }
}

async function resetView() {
  clearInterval(ticker);
  const old = cur; cur = null; activeFile = null;
  if (old?.kind === 'browser') { try { old.t.destroy(); } catch {} }
  if (old?.kind === 'server') fetch('api/torrent/' + old.hash, { method: 'DELETE' }).catch(() => {});
  objectUrls.forEach(URL.revokeObjectURL); objectUrls = [];
  $('mediaHost').innerHTML = ''; $('nowPlaying').hidden = true; $('placeholder').hidden = false;
  $('posters').innerHTML = ''; $('posterRow').hidden = true;
  $('placeholder').querySelector('p').textContent = 'Select a file from the list to start streaming';
  ['sProg', 'sDown', 'sUp', 'sPeers', 'sSize'].forEach((i) => ($(i).textContent = i === 'sSize' ? '—' : i === 'sProg' ? '0%' : i === 'sPeers' ? '0' : '0 B/s'));
  $('bar').style.width = '0';
  $('peerPill').textContent = '● idle'; $('peerPill').classList.remove('live');
}

/* ---------- UI wiring ---------- */
$('addForm').addEventListener('submit', (e) => { e.preventDefault(); start($('magnetInput').value); });
const SAMPLE_META = {
  sintel: { title: 'Sintel', sub: 'Open Movie · 2010', cls: '' },
  tos: { title: 'Tears of Steel', sub: 'Open Movie · 2012', cls: 's2' },
  cosmos: { title: 'Cosmos Laundromat', sub: 'Open Movie · 2015', cls: 's3' }
};
$('samples').innerHTML = Object.entries(SAMPLE_META).map(([k, m]) =>
  `<div class="poster ${m.cls}" data-sample="${k}" role="button" tabindex="0" title="${m.title}">
     <div class="thumb">🎬<span class="play">▶</span></div>
     <div class="ptitle">${m.title}</div>
     <div class="pmeta">${m.sub}</div>
   </div>`).join('');
document.querySelectorAll('[data-sample]').forEach((card) => {
  const go = () => { const k = card.dataset.sample; $('magnetInput').value = SAMPLES[k]; start(SAMPLES[k], SAMPLE_META[k].title); };
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
});
$('navSearch').addEventListener('click', () => {
  if (!$('view').hidden) backHome();
  $('hero').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('magnetInput').focus();
});
const drop = $('drop');
drop.addEventListener('click', () => $('fileInput').click());
drop.addEventListener('keydown', (e) => e.key === 'Enter' && $('fileInput').click());
$('fileInput').addEventListener('change', (e) => e.target.files[0] && start(e.target.files[0], e.target.files[0].name));
['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
window.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.name.endsWith('.torrent'));
  if (f) start(f, f.name); else { const t = e.dataTransfer?.getData('text'); if (t) start(t); }
});
window.addEventListener('paste', (e) => {
  if (!$('view').hidden || document.activeElement === $('magnetInput') || document.activeElement === $('codeInput')) return;
  const t = e.clipboardData?.getData('text'); if (t && t.startsWith('magnet:')) start(t);
});
$('stopBtn').addEventListener('click', () => backHome());
$('copyLink').addEventListener('click', async (e) => {
  if (!cur?.hash) return;
  const url = location.href.split('#')[0] + '#' + cur.hash;
  try { await navigator.clipboard.writeText(url); e.target.textContent = '✓ Copied!'; } catch { prompt('Copy link:', url); }
  setTimeout(() => (e.target.textContent = '🔗 Copy share link'), 1500);
});
const hash = decodeURIComponent(location.hash.slice(1));
if (hash) { $('magnetInput').value = hash; ready.then(() => { if (!backend?.auth || backend.authed) start(hash); }); }
