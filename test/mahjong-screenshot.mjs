// Capture a mid-game 3D screenshot for visual iteration on the table look.
// Usage: node test/mahjong-screenshot.mjs [outfile]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8139;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'test', 'mahjong-3d.png');
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
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader',
    '--enable-webgl', '--enable-accelerated-2d-canvas'],
});
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
      if (find('打出')) return 'human';
      return 'wait';
    });
    if (st === 'human') {
      if (i > 9) { atHuman = true; break; }      // enough discards on the table — stop here
      await page.evaluate(() => [...document.querySelectorAll('#action-bar .act-btn')].find((x) => x.textContent.includes('打出'))?.click());
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
