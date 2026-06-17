// Browser smoke test for the FLAT 2D board (scene2d.js) on a phone viewport: loads ?flat=1, plays
// a hand to a result, asserts the 2D board renders and there are no console/page errors.
// Usage: node test/doudizhu-flat-e2e.mjs
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8146;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
let shot = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780, isMobile: true, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('doudizhu-mute', '1'); } catch {} });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/doudizhu/?flat=1&fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn'); await page.click('#start-btn');
  // the flat board element must exist
  await page.waitForSelector('#board2d', { timeout: 4000 });
  console.log('flat board live');

  const deadline = Date.now() + 60000;
  let resolved = 0;
  while (Date.now() < deadline && resolved < 1) {
    const phase = await page.evaluate(() => {
      if (window.__dou.resultShown()) return 'result';
      return window.__dou.step();
    });
    if (phase === 'result') {
      resolved++;
      if (!shot) { await page.screenshot({ path: path.join(root, 'test', 'doudizhu-flat.png') }); shot = true; }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (resolved === 0) throw new Error('no hand resolved in flat mode');
  // the hand row rendered card elements
  const handCards = await page.evaluate(() => document.querySelectorAll('#board2d .c2.h').length);
  console.log(`resolved a hand in flat mode; hand rendered ${handCards} card els at result`);
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('\ndoudizhu flat e2e PASS');
