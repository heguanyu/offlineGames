// E2E: boots a real ROM from roms/ in the emulator under headless Edge and
// exercises quick save / quick load.
// Usage: node test/emu-e2e.mjs [system] [rom-name]   (e.g. nds Platinum.nds)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const SYSTEM = process.argv[2] || 'gba';
const ROM = process.argv[3] || 'Emerald386CN.gba';
const PORT = 8123;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.gba': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[${r.status()}]`, r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text());
  });

  await page.goto(`http://localhost:${PORT}/games/${SYSTEM}/`, { waitUntil: 'load' });

  if (SYSTEM === 'nds') {
    // The NDS page registers the SW and reloads once to gain cross-origin
    // isolation (for the threaded core). Wait for that to settle, tolerating
    // the execution-context destruction the reload causes.
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      try { if (await page.evaluate(() => window.crossOriginIsolated === true)) break; } catch (e) {}
      await sleep(300);
    }
    await page.waitForFunction('typeof play === "function"', { timeout: 10000 }).catch(() => {});
  }
  console.log(`page loaded (${SYSTEM}), injecting ROM:`, ROM);

  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM);

  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true',
    { timeout: 120000, polling: 500 });
  console.log('emulator started, letting it run...');
  await sleep(6000);

  const canvas = await page.$('#game canvas');
  if (!canvas) throw new Error('no canvas found');
  await canvas.screenshot({ path: path.join(outDir, 'shot-1-boot.png') });
  console.log('screenshot: shot-1-boot.png');

  const saved = await page.evaluate(() => window.EJS_emulator.gameManager.quickSave(1));
  console.log('quickSave(1) ->', saved);
  if (!saved) throw new Error('quickSave returned falsy');

  await sleep(4000); // let the game advance past the saved frame
  await canvas.screenshot({ path: path.join(outDir, 'shot-2-before-load.png') });
  console.log('screenshot: shot-2-before-load.png');

  await page.evaluate(() => window.EJS_emulator.gameManager.quickLoad(1));
  await sleep(500);
  await canvas.screenshot({ path: path.join(outDir, 'shot-3-after-load.png') });
  console.log('quickLoad(1) done, screenshot: shot-3-after-load.png');

  // Cross-session persistence: the state must survive a full page reload.
  const persisted = await page.evaluate((dbName) => new Promise((res) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('states')) return res('NO states STORE');
      const r = db.transaction('states', 'readonly').objectStore('states').getAll();
      r.onsuccess = () => res(r.result.map((s) => `${s.key} (${s.data.byteLength} bytes)`));
    };
  }), `${SYSTEM}-library`);
  console.log('persisted states in IndexedDB:', persisted);
  if (typeof persisted === 'string' || persisted.length === 0) {
    throw new Error('quick state was not persisted to IndexedDB');
  }

  await page.reload({ waitUntil: 'load' });
  console.log('page reloaded (fresh session), re-launching ROM...');
  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true',
    { timeout: 120000, polling: 500 });
  await sleep(2000); // allow EJS_onGameStart to restore persisted states
  await page.evaluate(() => window.EJS_emulator.gameManager.quickLoad(1));
  await sleep(500);
  const canvas2 = await page.$('#game canvas');
  await canvas2.screenshot({ path: path.join(outDir, 'shot-4-after-reload-load.png') });
  console.log('quickLoad after reload done, screenshot: shot-4-after-reload-load.png');

  console.log('E2E PASS');
} finally {
  await browser.close();
  server.close();
}
