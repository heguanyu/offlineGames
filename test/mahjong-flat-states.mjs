// Deterministic flat-board states via the ?fast=1 debug hooks (window.__mj).
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8142;
const dir = path.join(root, 'test');
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1&flat=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await new Promise((r) => setTimeout(r, 600));

  // 1) full pool, human's turn
  await page.evaluate(() => window.__mj.debugPool());
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(dir, 'mahjong-flat-pool.png') });
  console.log('saved pool');

  // 2) pending 碰 claim + melds on every seat
  await page.evaluate(() => window.__mj.debugMelds());
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(dir, 'mahjong-flat-claim.png') });
  console.log('saved claim');

  if (errors.length) console.log('ERRORS:\n  ' + errors.join('\n  '));
  else console.log('no page errors');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
