// Tests fast-forward through the real KEYBOARD binding (Space) on a heavy
// game, vs calling the core function directly — to tell a keybinding bug
// from a perf limit. Headed (real GPU) by default.
// Usage: node test/ff-keyboard.mjs "<rom-name>"
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROM = process.argv[2] || '精灵宝可梦 白2.nds';
const PORT = 8131;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.data': 'application/octet-stream', '.nds': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EDGE, headless: false, args: ['--mute-audio'] });

async function fps(page, seconds) {
  const f0 = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
  await sleep(seconds * 1000);
  const f1 = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
  return +((f1 - f0) / seconds).toFixed(1);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.goto(`http://localhost:${PORT}/games/nds/`, { waitUntil: 'load' });
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { if (await page.evaluate(() => window.crossOriginIsolated === true)) break; } catch (e) {}
    await sleep(300);
  }
  await page.waitForFunction('typeof play === "function"', { timeout: 10000 }).catch(() => {});

  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + encodeURIComponent(rom))).arrayBuffer();
    play({ name: rom, data });
  }, ROM);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true', { timeout: 180000, polling: 500 });
  console.log('threaded:', await page.evaluate(() => window.EJS_threads === true));
  await sleep(6000); // load + intro

  const normal = await fps(page, 4);

  // Keyboard path: focus the emulator and hold Space (our FF binding).
  await page.click('#game canvas').catch(() => {});
  await page.keyboard.down('Space');
  await sleep(1000);
  const kbFF = await fps(page, 4);
  await page.keyboard.up('Space');
  await sleep(1000);

  // Direct core call, for comparison.
  await page.evaluate(() => { window.EJS_emulator.gameManager.setFastForwardRatio(0); window.EJS_emulator.gameManager.toggleFastForward(1); });
  await sleep(1000);
  const directFF = await fps(page, 4);
  await page.evaluate(() => window.EJS_emulator.gameManager.toggleFastForward(0));

  console.log(`FPS — normal: ${normal} | Space-held: ${kbFF} (${(kbFF / normal).toFixed(2)}x) | direct: ${directFF} (${(directFF / normal).toFixed(2)}x)`);
  if (kbFF / normal < 1.3 && directFF / normal >= 1.5) {
    console.log('=> KEYBOARD binding is broken (direct works, Space does not).');
  } else if (directFF / normal < 1.3) {
    console.log('=> PERF-BOUND: even direct FF barely speeds up (normal fps:', normal, ').');
  } else {
    console.log('=> Keyboard FF works.');
  }
} finally {
  await browser.close();
  server.close();
}
