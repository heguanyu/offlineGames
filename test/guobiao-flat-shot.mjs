// Flat 2D (phone) board + compact result modal for 国标. iPhone-landscape viewport.
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8148;
const dir = path.join(root, 'test');
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/guobiao/?fast=1&flat=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await new Promise((r) => setTimeout(r, 500));

  let midShot = false, resultShot = false;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !resultShot) {
    const phase = await page.evaluate(() => {
      const vis = (id) => !document.getElementById(id).classList.contains('hidden');
      if (vis('result-overlay')) return 'result';
      const b = [...document.querySelectorAll('#action-bar .act-btn')];
      const hu = b.find((x) => x.textContent.startsWith('胡'));
      if (hu) { hu.click(); return 'win'; }
      const pass = b.find((x) => x.textContent.includes('过'));
      if (pass) { pass.click(); return 'pass'; }
      if (window.__gb && window.__gb.humanTurn()) return 'human';
      return 'wait';
    });
    if (phase === 'human') {
      if (!midShot) { await new Promise((r) => setTimeout(r, 200)); await page.screenshot({ path: path.join(dir, 'guobiao-flat.png') }); midShot = true; console.log('saved mid'); }
      await page.evaluate(() => window.__gb.discard());
    } else if (phase === 'result') {
      await new Promise((r) => setTimeout(r, 250));
      await page.screenshot({ path: path.join(dir, 'guobiao-flat-result.png') });
      const scroll = await page.evaluate(() => {
        const p = document.querySelector('#result-overlay .panel');
        return { scrollH: p.scrollHeight, clientH: p.clientHeight, overflowing: p.scrollHeight > p.clientHeight + 1 };
      });
      console.log('saved result; panel', scroll.clientH, 'content', scroll.scrollH, scroll.overflowing ? 'SCROLLS' : 'fits');
      resultShot = true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!resultShot) console.log('no result reached (mid shot only)');
  if (errors.length) console.log('ERRORS:\n  ' + errors.join('\n  '));
  else console.log('no page errors');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
