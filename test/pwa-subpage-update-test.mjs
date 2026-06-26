// E2E: does the PWA service worker correctly update SUB-PAGES (not just the hub) after a new
// version is deployed? Reproduces the real update cycle against the REAL sw.js:
//   1. Serve "v1": register the SW, let it precache the hub + GBA sub-page.
//   2. Navigate to the GBA sub-page → it is served (from cache) as v1.
//   3. Flip the server to "v2" (the GBA page's content changes AND sw.js's CACHE version bumps) —
//      i.e. a new deploy.
//   4. Drive the hub's update path (reg.update() → the new SW skipWaiting()s, activates, claims).
//   5. Navigate to the GBA sub-page again → it MUST now serve v2, not the stale v1 cache.
//
// The server serves the real repo files, but rewrites sw.js's CACHE constant to a version we control
// and trims its ASSETS to a small set (hub + gba page + deps) so the cycle is fast — the real
// install/activate/cache-first FETCH logic under test is untouched. The gba page gets a `window.__BUILD`
// marker so the test can read which version actually reached the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8133;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let VER = 1; // server-side "deployed version"; bump to simulate a new deploy

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png',
  '.json': 'application/json', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.data': 'application/octet-stream' };
const TRIMMED_ASSETS = "['./','./index.html','./sw.js','./app-nav.js','./games/gba/','./games/gba/index.html']";

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (p === '/sw.js') {
    let s = body.toString('utf8');
    s = s.replace(/const CACHE = '[^']*';/, `const CACHE = 'offline-games-test-v${VER}';`);
    s = s.replace(/const ASSETS = \[[\s\S]*?\];/, `const ASSETS = ${TRIMMED_ASSETS};`);
    body = Buffer.from(s);
  } else if (p === '/games/gba/index.html') {
    body = Buffer.from(body.toString('utf8') + `\n<script>window.__BUILD=${VER};</script>`);
  }
  // no-store so the browser HTTP cache never shadows what the SW re-fetches on update
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});

const fails = [];
const check = (label, cond, extra = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) fails.push(label); };

// Ask the controlling SW for its CACHE name (the hub uses this same 'version' message). Tolerant of
// the execution context being destroyed mid-poll — the hub auto-reloads when a new SW takes over.
const swVersion = (page) => page.evaluate(() => new Promise((resolve) => {
  const sw = navigator.serviceWorker.controller;
  if (!sw) return resolve(null);
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => resolve(e.data);
  sw.postMessage('version', [ch.port2]);
})).catch(() => null);
async function waitFor(fn, ms = 15000, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }

await new Promise((r) => server.listen(PORT, r));
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem('coiReload', '1'); } catch {} });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  // 1) v1: load hub, register the SW, wait until it controls the page.
  console.log('[v1] register SW on hub');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((r) => r.update?.()));
  const controlled = await waitFor(async () => (await swVersion(page)) === 'offline-games-test-v1');
  check('SW v1 installed + controlling', controlled, await swVersion(page));

  // 2) sub-page serves v1.
  await page.goto(`http://localhost:${PORT}/games/gba/`, { waitUntil: 'load' });
  const b1 = await page.evaluate(() => window.__BUILD);
  check('GBA sub-page serves v1', b1 === 1, 'build=' + b1);

  // 3) deploy v2 (sub-page content changes + sw.js CACHE bumps).
  VER = 2;
  console.log('[v2] deployed — driving update from the hub');

  // 4) drive the hub update path: reg.update() finds the new SW; sw.js skipWaiting()s + claims.
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    const w = reg.installing || reg.waiting;
    if (w && w.state === 'installed') w.postMessage('skipWaiting'); // nudge in case it lingers
  });
  const updated = await waitFor(async () => (await swVersion(page)) === 'offline-games-test-v2');
  check('SW updated to v2 (new worker controls)', updated, await swVersion(page));

  // verify the old cache was cleared on activate.
  const caches = await page.evaluate(() => self.caches ? caches.keys() : []);
  check('old cache (v1) deleted on activate', !caches.includes('offline-games-test-v1') && caches.includes('offline-games-test-v2'), caches.join(','));

  // 5) THE point: navigating to the sub-page now serves v2, not the stale v1 cache.
  await page.goto(`http://localhost:${PORT}/games/gba/`, { waitUntil: 'load' });
  const b2 = await page.evaluate(() => window.__BUILD);
  check('GBA sub-page updates to v2 after SW update', b2 === 2, 'build=' + b2);

  // 6) Auto-reload: while SITTING ON the sub-page (ROM library, not mid-game), a freshly-deployed
  //    version should reload the page on its own (the fix for an already-open iPad PWA page going
  //    stale after the hub updated). We're on the gba library page now (game-wrap hidden).
  VER = 3;
  console.log('[v3] deployed — sub-page should self-reload while on the library');
  await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    await r.update();
    const w = r.installing || r.waiting;
    if (w && w.state === 'installed') w.postMessage('skipWaiting');
  });
  const selfReloaded = await waitFor(async () => (await page.evaluate(() => window.__BUILD).catch(() => null)) === 3, 20000);
  check('open sub-page auto-reloads to v3 on update (library view)', selfReloaded);

  // 7) Mid-game guard: with a game showing (#game-wrap visible), a new deploy must NOT reload — that
  //    would interrupt play. Simulate being in a game, deploy v4, and confirm the page stays on v3.
  await page.evaluate(() => { document.getElementById('game-wrap').hidden = false; });
  VER = 4;
  console.log('[v4] deployed — must NOT reload while a game is showing');
  await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    await r.update();
    const w = r.installing || r.waiting;
    if (w && w.state === 'installed') w.postMessage('skipWaiting');
  });
  await waitFor(async () => (await swVersion(page)) === 'offline-games-test-v4', 15000); // new SW takes control
  await sleep(800); // give any (incorrect) reload a chance to happen
  const stillV3 = await page.evaluate(() => window.__BUILD).catch(() => null);
  check('mid-game: NO auto-reload while #game-wrap visible (stays v3)', stillV3 === 3, 'build=' + stillV3);
} finally {
  await browser.close();
  server.close();
}

if (fails.length) { console.log(`\nFAILED (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
console.log('\npwa-subpage-update E2E PASS');
