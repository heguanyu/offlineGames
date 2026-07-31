// record-demo.mjs — drive a game in headless Edge and record it to video.
//
//   node tools/record-demo.mjs mahjong
//   node tools/record-demo.mjs mahjong --out D:\demos --seconds 25
//   node tools/record-demo.mjs --list
//
// Produces two files per run:
//   <name>.master.mp4   near-lossless, kept LOCALLY (large; never deployed)
//   <name>.web.mp4      720p, ~1 Mbit/s, faststart — the one that gets hosted
//   <name>.jpg          poster frame for the <video> element
//
// How the capture works: Chrome DevTools Protocol Page.startScreencast pushes a
// JPEG every time the page repaints, with a wall-clock timestamp. Headless has no
// display, so there is nothing for an OS screen recorder to grab — the frames ARE
// the recording. Because they arrive only on repaint, timing is uneven, so the
// frames are muxed through ffmpeg's concat demuxer with a real per-frame duration
// rather than assumed to be a constant frame rate. Assuming 30fps here is what
// makes hand-rolled screencast recordings look subtly sped-up or stuttery.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, ROOT } from '../test/harness.mjs';
import { SCENARIOS } from './demo-scenarios.mjs';

const PORT = 8177;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
if (argv.includes('--list') || argv.length === 0) {
  console.log('scenarios:');
  for (const [k, s] of Object.entries(SCENARIOS)) console.log(`  ${k.padEnd(12)} ${s.title}`);
  process.exit(0);
}
const name = argv[0];
const scenario = SCENARIOS[name];
if (!scenario) { console.error(`unknown scenario "${name}" — try --list`); process.exit(1); }

const flag = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };
const outDir = path.resolve(flag('--out', path.join(ROOT, '_demos')));
const maxSeconds = Number(flag('--seconds', scenario.seconds ?? 20));

// ------------------------------------------------------------- helpers ----
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-1800)}`))));
  });
}
const pad = (n) => String(n).padStart(6, '0');

// ------------------------------------------------------------ recording ---
async function record(page, frameDir) {
  const client = await page.createCDPSession();
  const frames = [];
  let i = 0;
  let stopped = false;

  client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    // Ack FIRST, always: an un-acked frame stops the stream dead, and a write error
    // would otherwise silently truncate the recording at that point.
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* session gone */ }
    if (stopped) return;
    const file = path.join(frameDir, `f${pad(i++)}.jpg`);
    await fsp.writeFile(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
  });
  return {
    async stop() {
      stopped = true;
      try { await client.send('Page.stopScreencast'); } catch {}
      await new Promise((r) => setTimeout(r, 250));   // let in-flight writes land
      return frames;
    },
  };
}

/** ffmpeg concat list with real per-frame durations, so playback matches reality. */
async function writeConcat(frames, listPath) {
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    // Last frame has no successor to measure against; give it a sensible tail.
    const dur = i < frames.length - 1
      ? Math.max(0.016, Math.min(1.5, frames[i + 1].t - frames[i].t))
      : 0.4;
    lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`, `duration ${dur.toFixed(4)}`);
  }
  // The concat demuxer ignores the final duration unless the file is repeated.
  if (frames.length) lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
  await fsp.writeFile(listPath, lines.join('\n'), 'utf8');
}

// ----------------------------------------------------------------- main ---
await fsp.mkdir(outDir, { recursive: true });
const frameDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogdemo-'));
const server = await startServer(PORT);
const browser = await launchBrowser(['--enable-accelerated-2d-canvas', '--hide-scrollbars']);
const errors = [];
let frames = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log(`> ${name}: ${scenario.title}`);
  await scenario.setup(page, PORT);            // navigate + get to a filmable state

  const rec = await record(page, frameDir);
  const deadline = Date.now() + maxSeconds * 1000;
  await scenario.play(page, () => Date.now() < deadline);
  frames = await rec.stop();

  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '));
} finally {
  await browser.close();
  server.close();
}

if (frames.length < 10) {
  console.error(`only ${frames.length} frames captured — the page probably never repainted`);
  process.exit(1);
}

const span = frames[frames.length - 1].t - frames[0].t;
console.log(`captured ${frames.length} frames over ${span.toFixed(1)}s (${(frames.length / span).toFixed(1)} fps)`);

const listPath = path.join(frameDir, 'frames.txt');
await writeConcat(frames, listPath);

const master = path.join(outDir, `${name}.master.mp4`);
const web = path.join(outDir, `${name}.web.mp4`);
const poster = path.join(outDir, `${name}.jpg`);

// Master: visually lossless archive. Stays on this machine.
console.log('> encoding master…');
await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
  '-vsync', 'vfr', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', master]);

// Web: 720p capped bitrate. -an because there is no audio and an empty track
// costs bytes; +faststart puts the moov atom first so it plays while downloading.
console.log('> encoding web…');
await run('ffmpeg', ['-y', '-i', master,
  '-vf', 'scale=1280:-2:flags=lanczos,fps=30',
  '-c:v', 'libx264', '-crf', '30', '-preset', 'slow',
  '-maxrate', '1200k', '-bufsize', '2400k', '-profile:v', 'main', '-level', '4.0',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', web]);

// Poster: a frame from a little way in, so it is not the empty opening table.
console.log('> poster…');
await run('ffmpeg', ['-y', '-i', master, '-ss', String(Math.min(3, span / 3)),
  '-frames:v', '1', '-q:v', '4', poster]);

await fsp.rm(frameDir, { recursive: true, force: true });

const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0) + ' KB';
console.log(`\nmaster  ${master}  ${kb(master)}`);
console.log(`web     ${web}  ${kb(web)}`);
console.log(`poster  ${poster}  ${kb(poster)}`);
