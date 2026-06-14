// Capture the flat 2D (phone) board for visual iteration. iPhone-landscape viewport,
// ?flat=1 forces the DOM renderer. Usage: node test/mahjong-flat-shot.mjs [outfile]
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8141;
const out = process.argv[2] || path.join(root, 'test', 'mahjong-flat.png');
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 }); // iPhone 13 landscape
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1&flat=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await new Promise((r) => setTimeout(r, 500));

  let claimShot = false, atHuman = false;
  for (let i = 0; i < 90 && !atHuman; i++) {
    const st = await page.evaluate(() => {
      const vis = (id) => !document.getElementById(id).classList.contains('hidden');
      if (vis('result-overlay')) { document.getElementById('next-hand-btn').click(); return 'result'; }
      const b = [...document.querySelectorAll('#action-bar .act-btn')];
      const find = (t) => b.find((x) => x.textContent.trim().startsWith(t));
      if (find('碰') || find('杠')) return 'claimable';
      if (find('过')) { find('过').click(); return 'pass'; }
      if (window.__mj && window.__mj.humanTurn()) return 'human';
      return 'wait';
    });
    if (st === 'claimable' && !claimShot) {
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: out.replace(/\.png$/, '-claim.png') });
      console.log('saved claim shot');
      claimShot = true;
      await page.evaluate(() => { const b = [...document.querySelectorAll('#action-bar .act-btn')].find((x) => x.textContent.trim().startsWith('过')); b && b.click(); });
    } else if (st === 'human') {
      if (i > 9) { atHuman = true; break; }
      await page.evaluate(() => window.__mj.discard());
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await new Promise((r) => setTimeout(r, 80)); }
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: out });
  console.log('saved', out);
  if (errors.length) console.log('ERRORS:\n  ' + errors.join('\n  '));
  else console.log('no page errors');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
