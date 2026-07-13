// E2E: does the PWA service worker correctly update SUB-PAGES (not just the hub) after a new
// version is deployed? Reproduces the real update cycle against the REAL sw.js, using the 斗地主
// game page as the sub-page under test:
//   1. Serve "v1": register the SW, let it precache the hub + 斗地主 sub-page.
//   2. Navigate to the 斗地主 sub-page → it is served (from cache) as v1.
//   3. Flip the server to "v2" (the page's content changes AND sw.js's CACHE version bumps) — a new
//      deploy — while the page is BUSY (mid-hand: #start-overlay hidden). The new worker takes over
//      but the open page must NOT auto-reload (that would interrupt play).
//   4. A FRESH navigation to the sub-page now serves v2, not the stale v1 cache.
//   5. At the start screen (overlay visible → not busy) a new deploy self-reloads the open page.
//
// The server serves the real repo files, but rewrites sw.js's CACHE constant to a version we control
// and trims its ASSETS to a small set (hub + 斗地主 page + deps) so the cycle is fast — the real
// install/activate/cache-first FETCH logic under test is untouched. The page gets a `window.__BUILD`
// marker so the test can read which version actually reached the browser. The busy/not-busy heuristic
// is app-nav.js's generic #start-overlay check (hidden = a hand in play).
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
const TRIMMED_ASSETS = "['./','./index.html','./sw.js','./app-nav.js','./games/doudizhu/','./games/doudizhu/index.html']";
const isSubPageHtml = (p) => p === '/games/doudizhu/index.html'; // page we tag with a build marker

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
  } else if (isSubPageHtml(p)) {
    body = Buffer.from(body.toString('utf8') + `\n<script>window.__BUILD=${VER};</script>`);
  }
  // no-store so the browser HTTP cache never shadows what the SW re-fetches on update
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});

const fails = [];
const check = (label, cond, extra = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) fails.push(label); };

// Ask the controlling SW for its CACHE name (the hub uses this same 'version' message). Tolerant of
// the execution context being destroyed mid-poll — the page auto-reloads when a new SW takes over.
const swVersion = (page) => page.evaluate(() => new Promise((resolve) => {
  const sw = navigator.serviceWorker.controller;
  if (!sw) return resolve(null);
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => resolve(e.data);
  sw.postMessage('version', [ch.port2]);
})).catch(() => null);
async function waitFor(fn, ms = 15000, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }

// Drive an update: re-check for a new worker and let it take over (skipWaiting).
const driveUpdate = (page) => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  await reg.update();
  const w = reg.installing || reg.waiting;
  if (w && w.state === 'installed') w.postMessage('skipWaiting');
}).catch(() => {});

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
  await page.goto(`http://localhost:${PORT}/games/doudizhu/`, { waitUntil: 'load' });
  const b1 = await page.evaluate(() => window.__BUILD);
  check('斗地主 sub-page serves v1', b1 === 1, 'build=' + b1);

  // 3) deploy v2 while the page is BUSY (mid-hand: #start-overlay hidden). We OBSERVE the SW-version
  //    transition from a busy page, which by design won't auto-reload — so detection is stable and
  //    not racing a reload.
  await page.evaluate(() => document.getElementById('start-overlay').classList.add('hidden')); // mid-hand → busy
  VER = 2;
  console.log('[v2] deployed — new worker should take over, page must NOT reload (mid-hand)');
  await driveUpdate(page);
  const updated = await waitFor(async () => (await swVersion(page)) === 'offline-games-test-v2', 20000);
  check('SW updated to v2 (new worker controls)', updated, await swVersion(page));
  await sleep(800); // give any (incorrect) reload a chance to happen
  const stillV1 = await page.evaluate(() => window.__BUILD).catch(() => null);
  check('mid-hand: NO auto-reload while #start-overlay hidden (stays v1)', stillV1 === 1, 'build=' + stillV1);

  // old cache cleared on activate (poll briefly — claim/controllerchange can fire just before the
  // activate handler's cache-delete fully settles).
  let cacheKeys = [];
  const cacheClean = await waitFor(async () => {
    cacheKeys = await page.evaluate(() => caches.keys()).catch(() => []);
    return !cacheKeys.includes('offline-games-test-v1') && cacheKeys.includes('offline-games-test-v2');
  }, 6000);
  check('old cache (v1) deleted on activate', cacheClean, cacheKeys.join(','));

  // 4) THE point: a FRESH navigation to the sub-page now serves v2, not the stale v1 cache.
  await page.goto(`http://localhost:${PORT}/games/doudizhu/`, { waitUntil: 'load' });
  const b2 = await page.evaluate(() => window.__BUILD);
  check('斗地主 sub-page updates to v2 after SW update', b2 === 2, 'build=' + b2);

  // 5) Auto-reload: at the start screen (#start-overlay visible → not busy) a freshly-deployed version
  //    should reload the OPEN page on its own (the fix for an already-open iPad PWA page going stale
  //    after the hub updated). We're at the start screen now (fresh load, overlay visible).
  const atStart = await page.evaluate(() => { const o = document.getElementById('start-overlay'); return o ? getComputedStyle(o).display !== 'none' : false; });
  check('斗地主 at start screen (overlay visible → not busy)', atStart);
  VER = 3;
  console.log('[v3] deployed — sub-page should self-reload while at the start screen');
  await driveUpdate(page);
  const selfReloaded = await waitFor(async () => (await page.evaluate(() => window.__BUILD).catch(() => null)) === 3, 20000);
  check('open sub-page auto-reloads to v3 on update (start screen)', selfReloaded);
} finally {
  await browser.close();
  server.close();
}

if (fails.length) { console.log(`\nFAILED (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
console.log('\npwa-subpage-update E2E PASS');
