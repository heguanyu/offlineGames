// Verifies the 天津麻将 winning-modal changes:
//   1. title reads "本局结束，<seat> 获胜！" (not "…自摸！")
//   2. the total winning score (#result-score) is gone
//   3. each fan chip carries its scoring gain (e.g. 混吊·×2, 龙·4分)
//   4. the 玩家明细 title has no trailing total
//   5. the per-opponent total (.bd-net) is gone from the name rows
// Usage: node test/mahjong-win-modal-test.mjs
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8152;
const server = await startServer(PORT);
const browser = await launchBrowser();
let fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++; };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://localhost:${PORT}/games/mahjong-tianjin/?fast=1&flat=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn'); await page.click('#start-btn');
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => window.__mj.debugWin()); // win: winner=玩家(HUMAN), fans=['混吊']
  await new Promise((r) => setTimeout(r, 300));

  const m = await page.evaluate(() => ({
    title: document.getElementById('result-title').textContent,
    score: document.getElementById('result-score').textContent.trim(),
    chips: [...document.querySelectorAll('#result-fans .fan-chip')].map((c) => c.textContent),
    detailTitles: [...document.querySelectorAll('#result-payments .bd-title')].map((t) => t.textContent),
    bdNetCount: document.querySelectorAll('#result-payments .bd-net').length,
    bdSeats: [...document.querySelectorAll('#result-payments .bd-seat')].map((s) => s.textContent.trim()),
    subCount: document.querySelectorAll('#result-payments .bd-sub').length,
  }));
  console.log(JSON.stringify(m, null, 1));

  ok('title is "本局结束，… 获胜！"', /^本局结束，.+ 获胜！$/.test(m.title) && !m.title.includes('自摸'));
  ok('winning total score removed (#result-score empty)', m.score === '');
  ok('multiplier fan shows " xN" (混吊 x2)', m.chips.includes('混吊 x2'));
  ok('no additive fan → 小和·1分 default chip leads', m.chips[0] === '小和·1分');
  ok('玩家明细 title has no trailing total', m.detailTitles.includes('玩家明细') && !m.detailTitles.some((t) => /玩家明细\s*·/.test(t)));
  ok('per-opponent total (.bd-net) removed', m.bdNetCount === 0);
  ok('opponent name rows + reason subitems still present', m.bdSeats.length === 3 && m.subCount > 0);
  ok('no page errors', errs.length === 0);

  await page.screenshot({ path: path.join(root, 'test', 'mahjong-win-modal.png') });
} finally {
  await browser.close(); server.close();
}
console.log(fail ? `\nRESULT: FAIL (${fail})` : '\nRESULT: PASS');
process.exit(fail ? 1 : 0);
