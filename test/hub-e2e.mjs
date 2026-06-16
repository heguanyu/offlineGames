// Checks the hub page: version is displayed and all game cards are present.
// Usage: node test/hub-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8124;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });
try {
  const page = await browser.newPage();
  // The expected labels below are the English set (Nintendo DS / Controller Test), so pin the hub to
  // English before it boots (the mahjong cards have no en override, so they stay Chinese — as listed).
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('hub-lang', 'en'); } catch {} });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });

  const version = await page.$eval('#app-version', (el) => el.textContent);
  if (!/^v\d+\.\d+\.\d+ · $/.test(version)) throw new Error(`bad version display: "${version}"`);
  console.log('version shown:', version.replace(' · ', ''));

  const cards = await page.$$eval('.card', (els) => els.map((e) => e.textContent.trim()));
  console.log('cards:', cards.join(' | '));
  for (const expected of ['GBA · mGBA', 'GBA · VBA-M', 'Nintendo DS', 'Tianjin Mahjong', 'Guobiao (MCR)', 'Guobiao (no minimum)', 'Controller Test']) {
    if (!cards.some((c) => c.includes(expected))) throw new Error(`missing card: ${expected}`);
  }

  console.log('HUB E2E PASS');
} finally {
  await browser.close();
  server.close();
}
