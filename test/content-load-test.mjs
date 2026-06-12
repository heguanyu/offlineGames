// Decisive check: does a given core actually LOAD + RUN the ROM on our
// frontend? Measures emulated frame advance (0 = stuck at RetroArch menu /
// content not loaded; >0 = game running). Screenshots for visual confirmation.
// Usage: node test/content-load-test.mjs <core> [rom]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CORE = process.argv[2] || 'mgba';
const ROM = process.argv[3] || 'Emerald386CN.gba';
const PORT = 8132;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cl');
fs.mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.data': 'application/octet-stream', '.gba': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  page.on('console', (m) => console.log(`[c.${m.type()}]`, m.text().slice(0, 280)));
  await page.goto(`http://localhost:${PORT}/games/gba/?core=${CORE}`, { waitUntil: 'load' });
  await page.evaluate(async (rom, core) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM, CORE);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true', { timeout: 120000, polling: 500 });
  if (process.argv.includes('ff')) {
    await sleep(2000);
    await page.evaluate(() => { const gm = window.EJS_emulator.gameManager; gm.setFastForwardRatio(10); gm.toggleFastForward(1); });
    console.log('enabled fast-forward');
  }
  await sleep(6000); // let it settle / boot

  const f0 = await page.evaluate(() => { try { return window.EJS_emulator.gameManager.getFrameNum(); } catch (e) { return -1; } });
  await sleep(3000);
  const f1 = await page.evaluate(() => { try { return window.EJS_emulator.gameManager.getFrameNum(); } catch (e) { return -1; } });
  await page.$('#game canvas').then((c) => c && c.screenshot({ path: path.join(outDir, CORE + '.png') }));

  const delta = f1 - f0;
  console.log(`core=${CORE}  frameNum ${f0} -> ${f1}  (delta ${delta})`);
  console.log(delta > 0
    ? `=> CONTENT RUNNING (${CORE} loads + runs the ROM on our frontend)`
    : `=> NOT RUNNING (${CORE} did not load content — stuck/menu)`);
} finally {
  await browser.close();
  server.close();
}
