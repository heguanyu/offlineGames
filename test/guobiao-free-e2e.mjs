// Smoke test for 国标（无定番）: loads the page (which reuses ../guobiao/main.js
// with minFan: 0), auto-plays the human seat, and fails on any console error.
// With no fan minimum, hands resolve quickly. Usage: node test/guobiao-free-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8163;
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

  await page.goto(`http://localhost:${PORT}/games/guobiao-free/?fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  // the header should show 无定番 (config applied through the shared module)
  await page.click('#start-btn');
  await page.waitForFunction(() => document.querySelector('#action-bar .act-btn') ||
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
      const disc = b.find((x) => x.textContent.includes('打出'));
      if (disc) { disc.click(); return 'discard'; }
      return 'wait';
    });
    if (phase === 'result') {
      handsResolved++;
      console.log('hand resolved:', await page.$eval('#result-title', (e) => e.textContent));
      await page.click('#next-hand-btn');
      await page.waitForFunction(() => document.querySelector('#action-bar .act-btn'), { timeout: 8000 });
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
