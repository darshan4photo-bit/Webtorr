// Smoke test for the on-the-fly conversion pipeline (run: node tests/convert.test.mjs)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { probeCodecs, buildConvertArgs } from '../server.js';

const ff = (await import('ffmpeg-static')).default;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamtor-test-'));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};

const gen = (out, args) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: dir });

// real test inputs
gen('native.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'native.mp4']);
gen('hevc.mkv', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-shortest', 'hevc.mkv']);
gen('divx.avi', ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1', '-c:v', 'mpeg4', '-vtag', 'xvid', '-qscale:v', '5', '-an', 'divx.avi']);
gen('flac.mkv', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'testsrc=size=200x200:duration=1', '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic', 'flac.mkv']);

// probeCodecs
const pNative = await probeCodecs(path.join(dir, 'native.mp4'));
check('probe: h264+aac detected', pNative?.vcodec === 'h264' && pNative?.acodec === 'aac', JSON.stringify(pNative));

const pHevc = await probeCodecs(path.join(dir, 'hevc.mkv'));
check('probe: hevc+ac3 detected', pHevc?.vcodec === 'hevc' && pHevc?.acodec === 'ac3', JSON.stringify(pHevc));

const pDivx = await probeCodecs(path.join(dir, 'divx.avi'));
check('probe: mpeg4 detected', pDivx?.vcodec === 'mpeg4', JSON.stringify(pDivx));

const pFlac = await probeCodecs(path.join(dir, 'flac.mkv'));
check('probe: cover art ignored, audio codec found', pFlac?.vcodec === null && !!pFlac?.acodec, JSON.stringify(pFlac));

// buildConvertArgs decisions
const aNative = buildConvertArgs(pNative, 1080);
check('args: h264 is stream-copied', aNative.includes('-c:v') && aNative[aNative.indexOf('-c:v') + 1] === 'copy', aNative.join(' '));
const aHevc = buildConvertArgs(pHevc, 1080);
check('args: hevc → libx264', aHevc.includes('libx264'), aHevc.join(' '));
const aAudio = buildConvertArgs(pFlac, 1080);
check('args: audio-only maps no video stream', !aAudio.some((v, i) => v === '-map' && String(aAudio[i + 1]).startsWith('0:v')), aAudio.join(' '));
check('args: audio always → aac', aAudio.includes('aac'), aAudio.join(' '));
const tall = buildConvertArgs({ vcodec: 'hevc', vIndex: 0, vHeight: 2160, acodec: 'ac3' }, 1080);
check('args: oversized video scaled to even height ≤ cap', tall.some((v, i) => v === '-vf' && /scale=-2:10[0-9]{2}$/.test(tall[i + 1])), tall.join(' '));

// end-to-end: run the exact pipeline and confirm playable fMP4 comes out
const run = (args, out) => new Promise((resolve) => {
  const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', ...args], { cwd: dir, stdio: ['ignore', fs.openSync(path.join(dir, out), 'w'), 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, err, out }));
});
for (const [name, probe, src] of [['out-native.mp4', pNative, 'native.mp4'], ['out-hevc.mp4', pHevc, 'hevc.mkv'], ['out-divx.mp4', pDivx, 'divx.avi'], ['out-audio.mp4', pFlac, 'flac.mkv']]) {
  const args = ['-i', src, ...buildConvertArgs(probe, 1080)];
  const r = await run(args, name);
  const size = fs.existsSync(path.join(dir, r.out)) ? fs.statSync(path.join(dir, r.out)).size : 0;
  const head = size > 16 ? fs.readFileSync(path.join(dir, r.out)).subarray(4, 8).toString() : '';
  check(`convert: ${name} produced fragmented MP4`, r.code === 0 && size > 1000 && head === 'ftyp', `exit=${r.code} size=${size} ${r.err.slice(0, 200)}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll conversion checks passed');
process.exit(failures ? 1 : 0);
