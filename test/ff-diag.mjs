// Diagnoses fast-forward on this PC: measures emulated FPS (getFrameNum delta
// over wall-clock) with FF off vs on, and reports the WebGL renderer so we can
// tell hardware GPU from software (SwiftShader). Runs headed by default (real
// GPU); pass --headless to compare against software rendering.
// Usage: node test/ff-diag.mjs [system] [rom] [--headless]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HEADLESS = process.argv.includes('--headless');
const SYSTEM = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'nds';
const ROM = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'GodMode9i.nds';
const PORT = 8130;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.data': 'application/octet-stream', '.nds': 'application/octet-stream', '.gba': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = ['--mute-audio'];
if (HEADLESS) args.push('--enable-unsafe-swiftshader'); // force software in headless
const browser = await puppeteer.launch({ executablePath: EDGE, headless: HEADLESS, args });

async function fps(page, seconds) {
  const f0 = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
  await sleep(seconds * 1000);
  const f1 = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
  return +((f1 - f0) / seconds).toFixed(1);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.goto(`http://localhost:${PORT}/games/${SYSTEM}/`, { waitUntil: 'load' });
  if (SYSTEM === 'nds') {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      try { if (await page.evaluate(() => window.crossOriginIsolated === true)) break; } catch (e) {}
      await sleep(300);
    }
    await page.waitForFunction('typeof play === "function"', { timeout: 10000 }).catch(() => {});
  }

  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'renderer hidden';
  });
  console.log(`mode: ${HEADLESS ? 'headless+swiftshader' : 'headed (real GPU)'}`);
  console.log('WebGL renderer:', gpu);
  console.log('crossOriginIsolated:', await page.evaluate(() => window.crossOriginIsolated === true), '| EJS_threads:', await page.evaluate(() => window.EJS_threads));

  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true', { timeout: 120000, polling: 500 });
  await sleep(3000); // let it stabilize

  const normal = await fps(page, 3);
  await page.evaluate(() => { window.EJS_emulator.gameManager.setFastForwardRatio(0); window.EJS_emulator.gameManager.toggleFastForward(1); }); // 0 = unlimited
  await sleep(1000);
  const ff = await fps(page, 3);
  await page.evaluate(() => window.EJS_emulator.gameManager.toggleFastForward(0));

  console.log(`emulated FPS — normal: ${normal}, fast-forward(unlimited): ${ff}, speedup: ${(ff / normal).toFixed(2)}x`);
  console.log(normal < 55 ? 'NOTE: normal speed is below 60fps — the core is not hitting full speed (perf-bound).'
                          : 'normal speed is ~full (60fps).');
} finally {
  await browser.close();
  server.close();
}
