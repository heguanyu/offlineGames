// Browser smoke test for 国标麻将: loads the page (reusing the mahjong 3D layer),
// auto-plays the human seat through several hands (taking 胡 when offered, else
// passing claims), and fails on any console/page error.
// Usage: node test/guobiao-e2e.mjs
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8143;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/guobiao/?fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => (window.__gb && window.__gb.humanTurn()) ||
    document.querySelector('#action-bar .act-btn') ||
    !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
  console.log('hand started, 3D scene + action bar live');

  const deadline = Date.now() + 90000;
  let handsResolved = 0;
  while (Date.now() < deadline && handsResolved < 3) {
    const phase = await page.evaluate(() => {
      const vis = (id) => !document.getElementById(id).classList.contains('hidden');
      if (vis('result-overlay')) return 'result';
      const b = [...document.querySelectorAll('#action-bar .act-btn')];
      const hu = b.find((x) => x.textContent.startsWith('胡'));
      if (hu) { hu.click(); return 'win'; }
      const pass = b.find((x) => x.textContent.includes('过'));
      if (pass) { pass.click(); return 'pass'; }
      if (window.__gb && window.__gb.humanTurn()) { window.__gb.discard(); return 'discard'; }
      return 'wait';
    });
    if (phase === 'result') {
      handsResolved++;
      const title = await page.$eval('#result-title', (e) => e.textContent);
      console.log('hand resolved:', title);
      if (handsResolved === 1) await page.screenshot({ path: path.join(root, 'test', 'guobiao-shot.png') });
      await page.click('#next-hand-btn');
      if (handsResolved < 3) {
        await page.waitForFunction(() => (window.__gb && window.__gb.humanTurn()) || document.querySelector('#action-bar .act-btn') ||
          !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (handsResolved === 0) throw new Error('no hand resolved within timeout');
  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log(`resolved ${handsResolved} hand(s), no runtime errors`);
  console.log('GUOBIAO E2E PASS');
} catch (e) {
  console.error('GUOBIAO E2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
