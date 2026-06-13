// Browser smoke test for the mahjong game: loads the page, starts a hand, and
// auto-plays the human seat (always pass claims, always discard) until a hand
// resolves — asserting no console/page errors along the way. Catches runtime
// breakage in main.js that the Node engine test cannot see.
// Usage: node test/mahjong-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8137;
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
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1`, { waitUntil: 'networkidle0' });

  // Start a hand on Normal difficulty; the 3D table + action bar should appear.
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => document.querySelector('#action-bar .act-btn') ||
    !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
  console.log('hand started, 3D scene + action bar live');

  // Auto-play: pass every claim, discard on every turn, until a result shows.
  const deadline = Date.now() + 60000;
  let handsResolved = 0;
  while (Date.now() < deadline && handsResolved < 2) {
    const state = await page.evaluate(() => {
      const vis = (id) => !document.getElementById(id).classList.contains('hidden');
      const btn = (txt) => [...document.querySelectorAll('#action-bar .act-btn')]
        .find((b) => b.textContent.includes(txt));
      if (vis('result-overlay')) return { phase: 'result' };
      const pass = btn('过');
      if (pass) { pass.click(); return { phase: 'claim' }; }
      const discard = [...document.querySelectorAll('#action-bar .act-btn')]
        .find((b) => b.textContent.includes('打出'));
      if (discard) { discard.click(); return { phase: 'discard' }; }
      return { phase: 'wait' };
    });
    if (state.phase === 'result') {
      handsResolved++;
      const title = await page.$eval('#result-title', (e) => e.textContent);
      console.log('hand resolved:', title);
      if (handsResolved === 1) await page.screenshot({ path: path.join(root, 'test', 'mahjong-shot.png') });
      await page.click('#next-hand-btn');
      await page.waitForFunction(() => document.querySelector('#action-bar .act-btn'), { timeout: 8000 });
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  if (handsResolved === 0) throw new Error('no hand resolved within timeout');

  // After scores have accrued, the menu's 重开 must reset them to zero.
  const before = await page.$$eval('#scores .pt', (els) => els.map((e) => e.textContent.trim()));
  if (!before.some((s) => s !== '+0' && s !== '0')) throw new Error('expected non-zero scores before restart');
  await page.click('#menu-btn');
  await page.waitForFunction(() => !document.getElementById('menu-overlay').classList.contains('hidden'));
  await page.click('#newgame-btn');
  await page.waitForFunction(() => document.querySelector('#action-bar .act-btn'), { timeout: 8000 });
  const after = await page.$$eval('#scores .pt', (els) => els.map((e) => e.textContent.trim()));
  if (!after.every((s) => s === '+0')) throw new Error(`重开 did not reset scores: ${after.join(', ')}`);
  console.log('restart reset scores:', before.join(','), '→', after.join(','));

  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));

  console.log(`resolved ${handsResolved} hand(s), no runtime errors`);
  console.log('MAHJONG E2E PASS');
} catch (e) {
  console.error('MAHJONG E2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
