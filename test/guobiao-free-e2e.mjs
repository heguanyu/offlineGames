// Smoke test for 国标（无定番）: loads the page (which reuses ../guobiao/main.js
// with minFan: 0), auto-plays the human seat, and fails on any console error.
// With no fan minimum, hands resolve quickly. Usage: node test/guobiao-free-e2e.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8163;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/guobiao-free/?fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  // the header should show 无定番 (config applied through the shared module)
  await page.click('#start-btn');
  await page.waitForFunction(() => (window.__gb && window.__gb.humanTurn()) ||
    document.querySelector('#action-bar .act-btn') ||
    !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
  const round = await page.$eval('#round-info', (e) => e.textContent);
  if (!round.includes('无定番')) throw new Error('round info missing 无定番: ' + round);

  const deadline = Date.now() + 60000;
  let handsResolved = 0;
  while (Date.now() < deadline && handsResolved < 2) {
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
      console.log('hand resolved:', await page.$eval('#result-title', (e) => e.textContent));
      await page.click('#next-hand-btn');
      if (handsResolved < 2) {
        await page.waitForFunction(() => (window.__gb && window.__gb.humanTurn()) || document.querySelector('#action-bar .act-btn') ||
          !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (handsResolved === 0) throw new Error('no hand resolved within timeout');
  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log(`resolved ${handsResolved} hand(s), 无定番 shown, no runtime errors`);
  console.log('GUOBIAO-FREE E2E PASS');
} catch (e) {
  console.error('GUOBIAO-FREE E2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
