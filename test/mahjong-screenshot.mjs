// Capture a mid-game 3D screenshot for visual iteration on the table look.
// Usage: node test/mahjong-screenshot.mjs [outfile]
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8139;
const out = process.argv[2] || path.join(root, 'test', 'mahjong-3d.png');
const server = await startServer(PORT);
const browser = await launchBrowser(['--enable-accelerated-2d-canvas']);
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await new Promise((r) => setTimeout(r, 500));

  // Play until it's the human's turn with a populated pool, then stop there.
  let atHuman = false;
  for (let i = 0; i < 80 && !atHuman; i++) {
    const st = await page.evaluate(() => {
      const vis = (id) => !document.getElementById(id).classList.contains('hidden');
      if (vis('result-overlay')) { document.getElementById('next-hand-btn').click(); return 'result'; }
      const b = [...document.querySelectorAll('#action-bar .act-btn')];
      const find = (t) => b.find((x) => x.textContent.trim().startsWith(t));
      // prefer to claim 碰/杠 so a flat meld appears on the table for the screenshot
      if (find('碰')) { find('碰').click(); return 'claim'; }
      if (find('杠')) { find('杠').click(); return 'claim'; }
      if (find('过')) { find('过').click(); return 'pass'; }
      if (window.__mj && window.__mj.humanTurn()) return 'human';
      return 'wait';
    });
    if (st === 'human') {
      if (i > 9) { atHuman = true; break; }      // enough discards on the table — stop here
      await page.evaluate(() => window.__mj.discard());
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  // select a tile (a few cursor moves) to show the lift + highlight halo
  for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await new Promise((r) => setTimeout(r, 80)); }
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: out });
  console.log('saved', out);

  // portrait (vertical iPad) — the table should still fit width, not get cropped
  await page.setViewport({ width: 820, height: 1180, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 600));
  const pout = out.replace(/\.png$/, '-portrait.png');
  await page.screenshot({ path: pout });
  console.log('saved', pout);
  if (errors.length) console.log('ERRORS:\n  ' + errors.join('\n  '));
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
