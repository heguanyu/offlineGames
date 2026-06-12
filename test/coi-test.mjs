// Verifies cross-origin isolation (SharedArrayBuffer) is achieved via the
// service worker, and that the NDS page loads the THREADED melonDS core.
// Usage: node test/coi-test.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROM = 'GodMode9i.nds';
const PORT = 8129;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.data': 'application/octet-stream', '.nds': 'application/octet-stream', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
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
  const coreRequests = [];
  page.on('request', (r) => { if (r.url().includes('/cores/melonds')) coreRequests.push(r.url().split('/').pop()); });

  await page.goto(`http://localhost:${PORT}/games/nds/`, { waitUntil: 'load' });
  // The page registers the SW and reloads itself once to gain isolation.
  await page.waitForFunction('window.crossOriginIsolated === true', { timeout: 25000, polling: 300 }).catch(() => {});

  const iso = await page.evaluate(() => ({
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    ejsThreads: window.EJS_threads,
  }));
  console.log('isolation:', JSON.stringify(iso));
  if (!iso.crossOriginIsolated || !iso.sharedArrayBuffer) {
    throw new Error('cross-origin isolation NOT achieved — threaded core unavailable');
  }

  await page.evaluate(async (rom) => {
    const data = await (await fetch('/roms/' + rom)).arrayBuffer();
    play({ name: rom, data });
  }, ROM);
  await page.waitForFunction('window.EJS_emulator && window.EJS_emulator.started === true', { timeout: 120000, polling: 500 });
  await sleep(2000);

  console.log('melonDS core file requested:', coreRequests.join(', ') || '(none seen)');
  const usedThreaded = coreRequests.some((f) => f.includes('thread'));
  if (usedThreaded) {
    console.log('COI TEST PASS — threaded melonDS core loaded');
  } else {
    throw new Error('threaded core was NOT loaded (got: ' + coreRequests.join(', ') + ')');
  }
} finally {
  await browser.close();
  server.close();
}
