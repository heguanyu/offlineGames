// Browser smoke test for the mahjong game: loads the page, starts a hand, and
// auto-plays the human seat (always pass claims, always discard) until a hand
// resolves — asserting no console/page errors along the way. Catches runtime
// breakage in main.js that the Node engine test cannot see.
// Usage: node test/mahjong-e2e.mjs
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8137;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/mahjong-tianjin/?fast=1`, { waitUntil: 'networkidle0' });

  // Start a hand on Normal difficulty; the 3D table + action bar should appear.
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => (window.__mj && window.__mj.humanTurn()) ||
    document.querySelector('#action-bar .act-btn') ||
    !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
  console.log('hand started, 3D scene + action bar live');

  // the online turn timer must never appear offline — check COMPUTED display, not just the class
  // (a stale #turn-timer{display:flex} once beat .hidden). Both the 2D ring and the 3D mesh stay off.
  const timerVis = await page.evaluate(() => {
    const el = document.getElementById('turn-timer');
    const sc = window.__mj && window.__mj.scene && window.__mj.scene();
    return { dom: el ? getComputedStyle(el).display !== 'none' : false, mesh: !!(sc && sc.timerMesh && sc.timerMesh.visible) };
  });
  if (timerVis.dom || timerVis.mesh) throw new Error(`offline turn timer is showing (dom=${timerVis.dom}, mesh=${timerVis.mesh})`);
  console.log('offline turn timer correctly hidden');

  // round-info reads 圈 · 庄 · 难度 (座风 fixed for the 锅; no more 第N局).
  const roundInfo = await page.$eval('#round-info', (e) => e.textContent);
  if (!roundInfo.includes('圈') || !roundInfo.includes('庄') || roundInfo.includes('局'))
    throw new Error(`round-info should be 圈·庄·难度, got: ${roundInfo}`);
  console.log('round-info:', roundInfo.replace(/\s+/g, ' ').trim());

  // Auto-play: pass every claim, discard on every turn, until a result shows.
  const deadline = Date.now() + 60000;
  let handsResolved = 0;
  while (Date.now() < deadline && handsResolved < 2) {
    const state = await page.evaluate(() => {
      const vis = (id) => !document.getElementById(id).classList.contains('hidden');
      const btn = (txt) => [...document.querySelectorAll('#action-bar .act-btn')]
        .find((b) => b.textContent.includes(txt));
      if (vis('result-overlay')) return { phase: 'result' };
      const hu = btn('胡');
      if (hu) { hu.click(); return { phase: 'win' }; }   // take a self-draw win
      const pass = btn('过');
      if (pass) { pass.click(); return { phase: 'claim' }; }
      if (window.__mj && window.__mj.humanTurn()) { window.__mj.discard(); return { phase: 'discard' }; }
      return { phase: 'wait' };
    });
    if (state.phase === 'result') {
      handsResolved++;
      const title = await page.$eval('#result-title', (e) => e.textContent);
      console.log('hand resolved:', title);
      if (handsResolved === 1) await page.screenshot({ path: path.join(root, 'test', 'mahjong-shot.png') });
      await page.click('#next-hand-btn'); // closes the result overlay (and starts the next hand)
      if (handsResolved < 2) {
        await page.waitForFunction(() => (window.__mj && window.__mj.humanTurn()) || document.querySelector('#action-bar .act-btn') ||
          !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
      }
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  if (handsResolved === 0) throw new Error('no hand resolved within timeout');

  // 每圈成绩: the button under the scoreboard opens a table of the current 锅's 圈s.
  await page.click('#rounds-btn');
  await page.waitForFunction(() => !document.getElementById('rounds-overlay').classList.contains('hidden'), { timeout: 4000 });
  const hasTable = await page.$eval('#rounds-body', (e) => !!e.querySelector('table.rounds-table'));
  if (!hasTable) throw new Error('每圈成绩 modal has no table');
  await page.click('#rounds-close');
  await page.waitForFunction(() => document.getElementById('rounds-overlay').classList.contains('hidden'));
  console.log('每圈成绩 modal opens with a table');

  // After scores have accrued, the menu's 重开 must reset them to zero.
  const before = await page.$$eval('#scores .sb-pt', (els) => els.map((e) => e.textContent.trim()));
  if (!before.some((s) => s !== '0')) throw new Error('expected non-zero scores before restart');
  await page.click('#menu-btn');
  await page.waitForFunction(() => !document.getElementById('menu-overlay').classList.contains('hidden'));
  await page.click('#newgame-btn');
  await page.waitForFunction(() => (window.__mj && window.__mj.humanTurn()) || document.querySelector('#action-bar .act-btn'), { timeout: 8000 });
  const after = await page.$$eval('#scores .sb-pt', (els) => els.map((e) => e.textContent.trim()));
  if (!after.every((s) => s === '0')) throw new Error(`重开 did not reset scores: ${after.join(', ')}`);
  console.log('restart reset scores:', before.join(','), '→', after.join(','));

  // 一锅最终成绩: fill four 圈 (debug hook) and verify the final board + 再来一锅 reset.
  await page.evaluate(() => window.__mj.debugFinal());
  await page.waitForFunction(() => !document.getElementById('final-overlay').classList.contains('hidden'), { timeout: 4000 });
  const final = await page.evaluate(() => ({
    rows: document.querySelectorAll('#final-standings .standing').length,
    gold: document.querySelector('#final-standings').textContent.includes('🥇'),
    congrats: document.getElementById('final-congrats').textContent.trim(),
    rounds: !!document.querySelector('#final-rounds table.rounds-table'),
  }));
  if (final.rows !== 4) throw new Error(`final board: expected 4 standings, got ${final.rows}`);
  if (!final.gold) throw new Error('final board: no 🥇 medal');
  if (!final.congrats) throw new Error('final board: empty 恭喜 line');
  if (!final.rounds) throw new Error('final board: missing 每圈成绩 table');
  await page.click('#final-reset-btn');
  await page.waitForFunction(() => document.getElementById('final-overlay').classList.contains('hidden') &&
    ((window.__mj && window.__mj.humanTurn()) || document.querySelector('#action-bar .act-btn')), { timeout: 8000 });
  const reset = await page.$$eval('#scores .sb-pt', (els) => els.map((e) => e.textContent.trim()));
  if (!reset.every((s) => s === '0')) throw new Error(`再来一锅 did not reset scores: ${reset.join(', ')}`);
  console.log('final board (human 🥇) + 再来一锅 reset OK:', final.congrats);

  // 历史战绩: a finished 锅 is recorded persistently and shown via the menu's history modal.
  await page.evaluate(() => {
    localStorage.removeItem('mahjong-history');
    window.__mj.game().scores = [7, -3, -2, -2];
    window.__mj.recordPot();
  });
  if (await page.evaluate(() => JSON.parse(localStorage.getItem('mahjong-history')).length) !== 1)
    throw new Error('历史战绩 did not record the finished 锅');
  await page.click('#menu-btn');
  await page.waitForFunction(() => !document.getElementById('menu-overlay').classList.contains('hidden'));
  await page.click('#menu-history-btn');
  await page.waitForFunction(() => !document.getElementById('history-overlay').classList.contains('hidden'), { timeout: 4000 });
  const histRows = await page.$$eval('#history-body .rounds-table tbody tr', (els) => els.length);
  if (histRows !== 1) throw new Error(`历史战绩 modal should show 1 锅 row, got ${histRows}`);
  await page.click('#history-close');
  await page.waitForFunction(() => document.getElementById('history-overlay').classList.contains('hidden'));
  console.log('历史战绩: record + menu modal OK');

  // 拉庄: the table-shaped cross panel (seats around + arrow → 庄), the ⚔️ badge, and the doubled 庄 row.
  await page.evaluate(() => window.__mj.debugLzPanel()); // dealer = 下家 (display seat 1)
  await page.waitForFunction(() => !document.getElementById('lazhuang-overlay').classList.contains('hidden'), { timeout: 4000 });
  const lzText = await page.$eval('#lazhuang-text', (e) => e.textContent);
  if (!lzText.includes('坐庄') || !lzText.includes('拉庄')) throw new Error(`拉庄 panel text wrong: ${lzText}`);
  const lzCross = await page.evaluate(() => ({
    dealerChip: document.getElementById('lz-seat-1').textContent.includes('庄家'),
    arrow: document.getElementById('lz-arrow').className.includes('lz-arrow-1'),
    seats: [0, 1, 2, 3].every((p) => document.getElementById('lz-seat-' + p).textContent.length > 0),
  }));
  if (!lzCross.dealerChip || !lzCross.arrow || !lzCross.seats) throw new Error(`拉庄 cross layout wrong: ${JSON.stringify(lzCross)}`);
  await page.click('#lazhuang-yes');
  // new flow: the panel switches to a 'waiting' state (buttons hidden, choice captured), not hidden
  await page.waitForFunction(() => document.getElementById('lz-btns').style.display === 'none');
  if (await page.evaluate(() => window.__lz) !== true) throw new Error('拉庄 panel did not capture the 拉庄 choice');
  await page.evaluate(() => document.getElementById('lazhuang-overlay').classList.add('hidden')); // dismiss the standalone debug panel

  // a real 拉庄 hand (human challenges 庄 = 下家): the engine marks it and the badge shows.
  await page.evaluate(() => window.__mj.dealLz());
  await page.waitForFunction(() => document.querySelector('#plate-0 .lazhuang') &&
    document.getElementById('scores').textContent.includes('⚔️'), { timeout: 8000 });
  const lzSet = await page.evaluate(() => window.__mj.game().laZhuang.join(','));
  if (lzSet !== '0') throw new Error(`拉庄 set should be [0], got [${lzSet}]`);

  // the win breakdown marks both 庄x2 and 拉庄x2 on the 庄 row.
  await page.evaluate(() => window.__mj.debugLzWin());
  await page.waitForFunction(() => !document.getElementById('result-overlay').classList.contains('hidden'));
  const pay = await page.$eval('#result-payments', (e) => e.textContent);
  if (!pay.includes('庄x2') || !pay.includes('拉庄x2')) throw new Error(`breakdown missing 庄x2/拉庄x2 tags: ${pay}`);
  console.log('拉庄: panel + ⚔️ badge + 庄x2·拉庄x2 breakdown OK');

  // 杠分 split: when my 杠 and the opponent's 杠 cancel in the net, the breakdown must still
  // show BOTH the gain (金杠 +16) and the loss (下家金杠 −16) as separate signed lines.
  await page.evaluate(() => window.__mj.debugKongSplit());
  await page.waitForFunction(() => !document.getElementById('result-overlay').classList.contains('hidden'));
  const split = await page.$eval('#result-payments', (e) => e.textContent);
  if (!split.includes('金杠') || !split.includes('+16') || !split.includes('下家金杠') || !split.includes('-16'))
    throw new Error(`杠分 split missing gain/loss lines (+16 金杠 / −16 下家金杠): ${split}`);
  console.log('杠分 split: gain (+) and opponent-杠 loss (−) shown separately OK');

  // 混吊: the highlighted winning tile must be the 混 inside the 将 (pair), not a 混 in a meld.
  await page.evaluate(() => window.__mj.debugHunDiao());
  await page.waitForFunction(() => !document.getElementById('result-overlay').classList.contains('hidden'));
  const hd = await page.evaluate(() => {
    const win = document.querySelector('#result-hand .win-tile');
    if (!win) return { ok: false, why: 'no .win-tile' };
    const grp = win.closest('.meld-group');
    return { ok: !!(grp && grp.classList.contains('pair')), isWild: win.classList.contains('wild'), inPair: !!(grp && grp.classList.contains('pair')) };
  });
  if (!hd.ok || !hd.isWild) throw new Error(`混吊 highlight wrong: ${JSON.stringify(hd)} (want a wild tile inside the .pair group)`);
  console.log('混吊: winning 混 highlighted inside the 将/pair OK');

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
