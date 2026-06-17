// Browser smoke test for 斗地主: loads the page, starts a hand, auto-bids + auto-plays the human
// seat until a hand resolves — asserting no console/page errors. Catches runtime breakage in
// scene.js/main.js that the Node engine/ai/backend tests cannot see.
// Usage: node test/doudizhu-e2e.mjs
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8141;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
let shot = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('doudizhu-mute', '1'); } catch {} });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/doudizhu/?fast=1`, { waitUntil: 'networkidle0' });

  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  // bidding or the table should come alive
  await page.waitForFunction(() => window.__dou && (window.__dou.awaiting() || window.__dou.resultShown()), { timeout: 8000 });
  console.log('hand started, scene + bidding live');

  const deadline = Date.now() + 60000;
  let resolved = 0;
  while (Date.now() < deadline && resolved < 2) {
    const phase = await page.evaluate(() => {
      if (window.__dou.resultShown()) return 'result';
      return window.__dou.step();
    });
    if (phase === 'result') {
      resolved++;
      const title = await page.$eval('#result-title', (e) => e.textContent);
      console.log('hand resolved:', title);
      if (!shot) { await page.screenshot({ path: path.join(root, 'test', 'doudizhu-shot.png') }); shot = true; }
      await page.click('#next-btn');
      if (resolved < 2) await page.waitForFunction(() => window.__dou && (window.__dou.awaiting() || window.__dou.resultShown()), { timeout: 8000 });
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (resolved === 0) throw new Error('no hand resolved within the deadline');
  console.log(`resolved ${resolved} hand(s)`);
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('\ndoudizhu e2e PASS');
