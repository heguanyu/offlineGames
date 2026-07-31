// record-demo.mjs — drive the games in headless Edge and record them to video.
//
//   node tools/record-demo.mjs mahjong
//   node tools/record-demo.mjs all --out D:\demos
//   node tools/record-demo.mjs online --seconds 40
//   node tools/record-demo.mjs --list
//
// Two files per run, plus a poster:
//   <name>.master.mp4   near-lossless, kept LOCALLY (large; gitignored, never deployed)
//   <name>.web.mp4      720p, ~1 Mbit/s, faststart — the one that gets hosted
//   <name>.jpg          poster frame for the <video> element
//
// Capture: Chrome DevTools Protocol Page.startScreencast pushes a JPEG on every
// repaint, with a wall-clock timestamp. Headless has no display, so there is
// nothing for an OS screen recorder to grab — the frames ARE the recording.
// Because they arrive on repaint rather than on a clock, frames are muxed through
// ffmpeg's concat demuxer with a REAL per-frame duration. Assuming a constant
// 30fps is what makes hand-rolled screencast captures look sped-up and stuttery.
//
// A scenario may ask for several clients (`clients: 4`) and for the multiplayer
// backend (`backend: true`). Multi-client runs record every client and tile them
// into one grid with ffmpeg's xstack, which is the whole point of the online
// demo: four independent browsers, one shared table.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { startServer, launchBrowser, ROOT } from '../test/harness.mjs';
import { SCENARIOS } from './demo-scenarios.mjs';

const SITE_PORT = 8177;
const BACKEND_PORT = 8178;

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
if (argv.includes('--list') || argv.length === 0) {
  console.log('scenarios:');
  for (const [k, s] of Object.entries(SCENARIOS)) {
    console.log(`  ${k.padEnd(10)} ${s.clients > 1 ? `${s.clients}x ` : '   '}${s.title}`);
  }
  console.log('\n  all        record every scenario in order');
  process.exit(0);
}
const flag = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };
const outDir = path.resolve(flag('--out', path.join(ROOT, '_demos')));
const secondsOverride = argv.includes('--seconds') ? Number(flag('--seconds')) : null;

const names = argv[0] === 'all' ? Object.keys(SCENARIOS) : [argv[0]];
for (const n of names) {
  if (!SCENARIOS[n]) { console.error(`unknown scenario "${n}" — try --list`); process.exit(1); }
}

// ------------------------------------------------------------- helpers ----
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`))));
  });
}
const pad = (n) => String(n).padStart(6, '0');
const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;

/** Attach a screencast to one page; returns { stop() → frames }. */
async function recordPage(page, frameDir, maxW, maxH) {
  const client = await page.createCDPSession();
  const frames = [];
  let i = 0;
  let stopped = false;
  client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    // Ack FIRST, always: an un-acked frame stops the stream dead, and a failed
    // write would otherwise silently truncate the recording at that point.
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch { /* session gone */ }
    if (stopped) return;
    const file = path.join(frameDir, `f${pad(i++)}.jpg`);
    await fsp.writeFile(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: maxW, maxHeight: maxH, everyNthFrame: 1 });
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
    const dur = i < frames.length - 1
      ? Math.max(0.016, Math.min(1.5, frames[i + 1].t - frames[i].t))   // cap also trims dead air
      : 0.4;
    lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`, `duration ${dur.toFixed(4)}`);
  }
  if (frames.length) lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
  await fsp.writeFile(listPath, lines.join('\n'), 'utf8');
}

/** Spawn the multiplayer backend (server/index.js) and wait for it to listen. */
async function startBackend() {
  const scores = path.join(os.tmpdir(), `og-demo-scores-${BACKEND_PORT}.json`);
  try { fs.unlinkSync(scores); } catch {}          // isolate: no restored table state
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(BACKEND_PORT), BOT_THINK_MS: '260', SCORES_FILE: scores },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  await new Promise((res) => {
    proc.stdout.on('data', (d) => { if (/listening/.test(String(d))) res(); });
    setTimeout(res, 3000);
  });
  return { proc, err: () => err };
}

// ---------------------------------------------------------------- record --
async function recordScenario(name) {
  const scenario = SCENARIOS[name];
  const clients = scenario.clients ?? 1;
  const seconds = secondsOverride ?? scenario.seconds ?? 20;
  // Grid panes are 640x360 so a 2x2 tiles to exactly 1280x720 — the web output size,
  // so panes are never resampled. It is also 4x less pixel work per client than a
  // 960x540 pane, which matters a lot when four WebGL scenes share one SwiftShader CPU.
  const [vw, vh] = clients > 1 ? [640, 360] : [1280, 720];

  console.log(`\n=== ${name} — ${scenario.title}${clients > 1 ? ` (${clients} clients)` : ''}`);

  const frameDirs = [];
  for (let i = 0; i < clients; i++) frameDirs.push(await fsp.mkdtemp(path.join(os.tmpdir(), `ogdemo-${i}-`)));

  const site = await startServer(SITE_PORT);
  const backend = scenario.backend ? await startBackend() : null;
  // ONE BROWSER PER CLIENT. Page.startScreencast only delivers frames for a VISIBLE
  // target, and a headless browser has exactly one foreground tab — with four pages in
  // a single browser, three of them record nothing at all (measured: 0/0/0/3634 frames).
  // Separate browsers give every client its own foreground. The throttling flags matter
  // for the same reason: a backgrounded renderer stops painting and stalls CDP calls.
  const LAUNCH_ARGS = ['--enable-accelerated-2d-canvas', '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'];
  const browsers = [];
  for (let i = 0; i < clients; i++) {
    browsers.push(await launchBrowser(LAUNCH_ARGS, { protocolTimeout: 240000 }));
  }
  const errors = [];
  let sets = [];

  try {
    const pages = [];
    for (let i = 0; i < clients; i++) {
      const page = await browsers[i].newPage();
      await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => errors.push(`[${i}] pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${i}] console: ${m.text()}`); });
      pages.push(page);
    }

    const ctx = { pages, page: pages[0], sitePort: SITE_PORT, backendPort: BACKEND_PORT };
    await scenario.setup(ctx);

    const recs = [];
    for (let i = 0; i < clients; i++) recs.push(await recordPage(pages[i], frameDirs[i], vw, vh));

    const deadline = Date.now() + seconds * 1000;
    await scenario.play(ctx, () => Date.now() < deadline);

    for (const r of recs) sets.push(await r.stop());
    if (errors.length) console.log('page errors:\n  ' + errors.slice(0, 8).join('\n  '));
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    site.close();
    if (backend) backend.proc.kill();
  }

  if (sets.some((f) => f.length < 10)) {
    throw new Error(`too few frames (${sets.map((s) => s.length).join('/')}) — a page probably never repainted`);
  }
  const span = sets[0][sets[0].length - 1].t - sets[0][0].t;
  console.log(`captured ${sets.map((s) => s.length).join(' + ')} frames over ${span.toFixed(1)}s`);

  await fsp.mkdir(outDir, { recursive: true });
  const master = path.join(outDir, `${name}.master.mp4`);
  const web = path.join(outDir, `${name}.web.mp4`);
  const poster = path.join(outDir, `${name}.jpg`);

  console.log('> encoding master…');
  if (clients === 1) {
    const list = path.join(frameDirs[0], 'frames.txt');
    await writeConcat(sets[0], list);
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vsync', 'vfr',
      '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', master]);
  } else {
    // Per-client intermediates first, then tile. xstack needs equal-sized inputs
    // and identical frame rates, so each pass is normalised to 30fps here.
    const parts = [];
    for (let i = 0; i < clients; i++) {
      const list = path.join(frameDirs[i], 'frames.txt');
      await writeConcat(sets[i], list);
      const part = path.join(frameDirs[i], 'part.mp4');
      await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vsync', 'vfr',
        '-vf', `scale=${vw}:${vh},fps=30`, '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', part]);
      parts.push(part);
    }
    const layout = clients === 2 ? '0_0|w0_0' : '0_0|w0_0|0_h0|w0_h0';
    const inputs = parts.flatMap((p) => ['-i', p]);
    const refs = parts.map((_, i) => `[${i}:v]`).join('');
    await run('ffmpeg', ['-y', ...inputs, '-filter_complex',
      `${refs}xstack=inputs=${parts.length}:layout=${layout}:fill=black[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-crf', '14', '-preset', 'slow',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', master]);
  }

  console.log('> encoding web…');
  await run('ffmpeg', ['-y', '-i', master,
    '-vf', 'scale=1280:-2:flags=lanczos,fps=30',
    '-c:v', 'libx264', '-crf', '30', '-preset', 'slow',
    '-maxrate', '1200k', '-bufsize', '2400k', '-profile:v', 'main', '-level', '4.0',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', web]);

  console.log('> poster…');
  await run('ffmpeg', ['-y', '-i', master, '-ss', String(Math.min(4, span / 3)),
    '-frames:v', '1', '-q:v', '4', poster]);

  for (const d of frameDirs) await fsp.rm(d, { recursive: true, force: true });
  console.log(`master ${kb(master)}   web ${kb(web)}   poster ${kb(poster)}`);
}

for (const n of names) await recordScenario(n);
console.log(`\ndone → ${outDir}`);
