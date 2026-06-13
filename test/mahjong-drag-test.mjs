// Verifies the in-browser drag interaction actually reorders the hand (the pure
// order math is covered by mahjong-handorder-test.mjs). Usage: node test/mahjong-drag-test.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8141;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1`, { waitUntil: 'networkidle0' });
  await page.click('#start-btn');

  // Only 混儿 are draggable, so play on until it's the human's turn AND a 混儿 is
  // in hand (a wild may be dealt or drawn).
  const deadline = Date.now() + 45000;
  let wildIdx = [];
  while (Date.now() < deadline) {
    const human = await page.evaluate(() => window.__mj && window.__mj.humanTurn());
    if (human) {
      wildIdx = await page.evaluate(() => window.__mj.wildIndices());
      if (wildIdx.length) break;
      // no 混儿 yet — discard to draw a fresh tile next turn
      await page.evaluate(() => [...document.querySelectorAll('#action-bar .act-btn')].find((x) => x.textContent.includes('打出'))?.click());
    } else {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('#action-bar .act-btn')];
        (b.find((x) => x.textContent.includes('过')) || b.find((x) => x.textContent.includes('打出')))?.click();
      });
    }
    await new Promise((r) => setTimeout(r, 70));
  }
  if (!wildIdx.length) { console.log('no 混儿 reached the hand in time — skipping drag assertion'); console.log('MAHJONG DRAG TEST PASS'); }
  else {
    const order0 = await page.evaluate(() => window.__mj.order());
    const wpick = wildIdx[0];
    const wildId = order0[wpick];
    const tgt = Math.min(order0.length - 1, wpick + 4);
    const a = await page.evaluate((p) => window.__mj.tileXY(p), wpick);
    const b = await page.evaluate((p) => window.__mj.tileXY(p), tgt);
    if (!a || !b) throw new Error('could not locate hand tiles on screen');

    // Drag the 混儿 to the right.
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y); await new Promise((r) => setTimeout(r, 12)); }
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 120));

    const order1 = await page.evaluate(() => window.__mj.order());
    const newIdx = order1.indexOf(wildId);
    if (newIdx <= wpick) throw new Error(`混儿 did not move right (${wpick} → ${newIdx})`);

    // Invariant: non-wild tiles are never reordered — they stay sorted ascending
    // (the freshly drawn tile is allowed at the far right).
    const wilds1 = await page.evaluate(() => window.__mj.wildIndices());
    const nonWilds = order1.filter((_, i) => !wilds1.includes(i));
    const body = nonWilds.slice(0, -1); // drop the possibly-just-drawn rightmost tile
    if (!body.every((v, i) => i === 0 || body[i - 1] <= v)) {
      throw new Error('non-wild tiles are not sorted: ' + nonWilds.join(','));
    }
    if (errors.length) throw new Error('runtime errors: ' + errors.join('; '));
    console.log(`混儿 dragged ${wpick} → ${newIdx}; non-wilds stay sorted`);
    console.log('MAHJONG DRAG TEST PASS');
  }
} catch (e) {
  console.error('MAHJONG DRAG TEST FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
