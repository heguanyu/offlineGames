// Browser smoke test for 掼蛋: loads the page, starts a match, auto-plays the human seat until a
// round resolves — asserting no console/page errors. Catches runtime breakage in scene.js/main.js
// that the Node engine/ai/backend tests cannot see.
// Usage: node test/guandan-e2e.mjs
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8147;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
let shot = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('guandan-mute', '1'); } catch {} });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/guandan/?fast=1`, { waitUntil: 'networkidle0' });

  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__gd && (window.__gd.awaiting() || window.__gd.resultShown()), { timeout: 10000 });
  console.log('match started, scene live');

  const deadline = Date.now() + 90000;
  let resolved = 0;
  while (Date.now() < deadline && resolved < 2) {
    const phase = await page.evaluate(() => {
      if (window.__gd.resultShown()) return 'result';
      return window.__gd.step();
    });
    if (phase === 'result') {
      resolved++;
      const title = await page.$eval('#result-title', (e) => e.textContent);
      console.log('round resolved:', title);
      if (!shot) { await page.screenshot({ path: path.join(root, 'test', 'guandan-shot.png') }); shot = true; }
      await page.click('#next-btn');
      if (resolved < 2) await page.waitForFunction(() => window.__gd && (window.__gd.awaiting() || window.__gd.resultShown()), { timeout: 10000 });
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (resolved === 0) throw new Error('no round resolved within the deadline');
  console.log(`resolved ${resolved} round(s)`);
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('\nguandan e2e PASS');
