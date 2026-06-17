// Verify the hub's update progress bar is HIDDEN unless an update the user
// started is in flight. Reproduces the "bar permanently visible at 0%" bug.
// Usage: node test/update-bar-test.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8141;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--mute-audio'] });
let failed = false;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed = true; };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
  // let the SW register + (first) install run; its progress broadcasts would, if ungated,
  // reveal the bar.
  await sleep(3500);

  const snap = () => page.evaluate(() => {
    const el = document.getElementById('update-progress');
    const cs = getComputedStyle(el);
    return { exists: !!el, hiddenAttr: el.hasAttribute('hidden'), display: cs.display, visible: cs.display !== 'none' };
  });

  const s1 = await snap();
  console.log('on fresh load:', JSON.stringify(s1));
  check('bar exists', s1.exists);
  check('bar hidden on fresh load (nothing the user is updating)', !s1.visible);

  // Click "check for updates" — sw.js is byte-identical, so there is nothing to update;
  // the bar must stay hidden through and after the check.
  await page.evaluate(() => document.getElementById('update-btn')?.click());
  await sleep(2500);
  const s2 = await snap();
  console.log('after check (nothing to update):', JSON.stringify(s2));
  check('bar still hidden after a no-op update check', !s2.visible);

  await page.screenshot({ path: path.join(here, 'update-bar.png') });
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
