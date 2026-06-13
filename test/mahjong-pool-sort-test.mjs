// Verify the discard pool orders each suit type-column by card id.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const PORT = 8174;
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
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn'); await page.click('#start-btn');
  await page.waitForFunction(() => window.__mj, { timeout: 8000 });
  await page.evaluate(() => window.__mj.debugPool());
  await new Promise((r) => setTimeout(r, 300));
  // Read each pool mesh: key 'pool'+i, its kind, and grid cell (from x,z target).
  const cells = await page.evaluate(() => {
    const sc = window.__mj.scene();
    const out = [];
    for (const [k, rec] of sc.tiles) {
      if (!k.startsWith('pool')) continue;
      const kind = parseInt(rec.faceKey, 10); // faceKey is "<kind>" for plain pool tiles
      out.push({ kind, x: rec.tp.x, z: rec.tp.z });
    }
    return out;
  });
  // Group by suit-column via x sign/bands isn't reliable; instead group by kind's suit.
  const suit = (k) => (k < 9 ? 'm' : k < 18 ? 'p' : k < 27 ? 's' : 'z');
  const groups = {};
  for (const c of cells) (groups[suit(c.kind)] ||= []).push(c);
  let failed = 0;
  for (const s of Object.keys(groups)) {
    // fill order is left→right (x asc) then front→back (z desc). Sort by that order.
    const g = groups[s].slice().sort((a, b) => (b.z - a.z) || (a.x - b.x));
    for (let i = 1; i < g.length; i++) {
      if (g[i].kind < g[i - 1].kind) { failed++; console.error(`  ${s}: out of order ${g[i - 1].kind} -> ${g[i].kind}`); }
    }
    console.log(`  ${s}: ${g.map((c) => c.kind).join(',')}`);
  }
  if (failed) throw new Error(`${failed} ordering violations`);
  console.log('POOL SORT OK — every type-column is ordered by card id');
} catch (e) {
  console.error('POOL SORT FAIL:', e.message); process.exitCode = 1;
} finally {
  await browser.close(); server.close();
}
