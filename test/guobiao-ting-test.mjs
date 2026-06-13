// Verifies the 听 (tenpai) declaration flow in 国标（无定番）:
//  1. With a ready hand, selecting a discard that leaves 听 shows both 打出 and a
//     glowing-red 打出并听牌 button.
//  2. Clicking 打出并听牌 locks the seat (听) and starts background music.
//  3. While 听, the seat is on autopilot: no 打出/碰/吃 buttons are offered.
// Usage: node test/guobiao-ting-test.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PORT = 8166;
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
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
function assert(c, m) { if (!c) throw new Error(m); }
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/guobiao-free/?fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__gb && __gb.phase(), { timeout: 8000 });

  // Force a ready hand: 123m 456m 789m 123p + 东, with a freshly drawn 白(33).
  // Discarding 33 leaves a hand waiting on 东(27); discarding 27 waits on 白(33).
  const TENPAI13 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27];
  await page.evaluate((h) => window.__gb.forceTing(h, 33), TENPAI13);

  // (1) select the drawn 白 → both 打出 and 打出并听牌 appear
  await page.evaluate(() => window.__gb.selectKind(33));
  const acts = await page.evaluate(() => window.__gb.actions());
  const plain = acts.find((a) => a.text === '打出');
  const riichi = acts.find((a) => a.text === '打出并听牌');
  assert(plain, '打出 button missing: ' + JSON.stringify(acts));
  assert(riichi, '打出并听牌 button missing: ' + JSON.stringify(acts));
  assert(riichi.cls.includes('riichi'), '打出并听牌 missing .riichi class: ' + riichi.cls);
  const hint = await page.evaluate(() => window.__gb.hint());
  assert(/即听/.test(hint), 'hint should mention 即听, got: ' + hint);
  console.log('OK split: 打出 + 打出并听牌(riichi), hint =', JSON.stringify(hint));

  // (2) declare → locks + music starts
  await page.evaluate(() => window.__gb.clickAction('打出并听牌'));
  const locked = await page.evaluate(() => window.__gb.locked());
  const music = await page.evaluate(() => window.__gb.music());
  assert(locked, 'expected lockedTing after 打出并听牌');
  assert(music, 'expected background music after 听');
  console.log('OK declared: locked =', locked, ', music =', music);

  // (3) while 听 the human is offered nothing (autopilot). Force the human's
  // discard turn again, set 听, and confirm no buttons + 已听 hint.
  await page.evaluate((h) => window.__gb.forceTing(h, 33), TENPAI13);
  await page.evaluate(() => window.__gb.setLocked([27]));
  const lockedActs = await page.evaluate(() => window.__gb.actions());
  const lockedHint = await page.evaluate(() => window.__gb.hint());
  assert(lockedActs.length === 0, 'expected NO action buttons while 听, got: ' + JSON.stringify(lockedActs));
  assert(/已听/.test(lockedHint), 'expected 已听 hint while 听, got: ' + lockedHint);
  console.log('OK locked render: no buttons, hint =', JSON.stringify(lockedHint));

  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log('GUOBIAO-TING TEST PASS');
} catch (e) {
  console.error('GUOBIAO-TING TEST FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
