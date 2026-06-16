// End-to-end online PLAY test for 国标无定番 (no-minimum): the hub deep-links the lobby with
// ?tab=guobiao-free, which preselects that table (index 2 in the default lineup). Sit + bots +
// ready; the lobby hands off to the 无定番 game page (../guobiao-free/?online=1), which connects to
// the minFan-0 server table and plays a hand. Validates the ?tab deep-link, the 3rd table, the
// guobiao-free page's online overlays, and the minFan-0 ruleset path.
// Usage: node test/guobiao-free-online-play-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startServer, launchBrowser } from './harness.mjs';
import { ROOT as root } from './harness.mjs';

const PORT = 8197, SITE = 8150;
const SCORES_FILE = path.join(os.tmpdir(), `gbfree-play-e2e-${PORT}.json`); try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20', SCORES_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });
const site = await startServer(SITE);
const browser = await launchBrowser();
const errors = [];
const clickMenu = (p, label) => p.evaluate((l) => { const b = [...document.querySelectorAll('#seat-menu button')].find((x) => x.textContent.includes(l)); if (b) b.click(); }, label);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('mahjong-online-name', '无定番'); localStorage.setItem('mahjong-online-uid', 'gbfree-play-e2e-uid'); });

  // hub deep-link: ?tab=guobiao-free preselects the 无定番 table
  await page.goto(`http://localhost:${SITE}/games/mahjong-tianjin-online/?server=ws://localhost:${PORT}&fast=1&tab=guobiao-free`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('conn')?.className.includes('on'), { timeout: 6000 });
  await page.waitForFunction(() => document.querySelectorAll('#game-tabs .game-tab').length >= 3, { timeout: 4000 });
  const activeLabel = await page.$eval('#game-tabs .game-tab.active', (e) => e.textContent.trim());
  if (!activeLabel.includes('无定番')) throw new Error(`?tab=guobiao-free should preselect the 无定番 tab, active is: ${activeLabel}`);
  await page.waitForSelector('.chair[data-table="2"][data-seat="0"]');
  await page.click('.chair[data-table="2"][data-seat="0"]');
  await clickMenu(page, '坐这里');
  await page.waitForFunction(() => document.querySelector('.chair[data-table="2"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  for (const s of [1, 2, 3]) { await page.click(`.chair[data-table="2"][data-seat="${s}"]`); await clickMenu(page, '加机器人'); await new Promise((r) => setTimeout(r, 120)); }
  await page.evaluate(() => [...document.querySelectorAll('.btn.ready')].find((b) => b.textContent.includes('准备')).click());
  console.log('lobby: 无定番 tab preselected, seated at table 2 + 3 bots + ready');

  await page.waitForFunction(() => location.pathname.includes('/guobiao-free/'), { timeout: 8000 });
  console.log('navigated to the 无定番 online game page');
  await page.waitForFunction(() => (window.__gb && window.__gb.humanTurn && window.__gb.humanTurn()) ||
    document.querySelector('#action-bar .act-btn') || document.querySelector('#ting-center .act-btn') ||
    !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 12000 });
  const info = await page.$eval('#round-info', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  if (!info.includes('联机')) throw new Error(`online round-info should say 联机, got: ${info}`);
  if (!info.includes('无定番')) throw new Error(`无定番 round-info should say 无定番, got: ${info}`);
  console.log('无定番 online game live —', info);

  const deadline = Date.now() + 50000; let resolved = 0;
  while (Date.now() < deadline && resolved < 1) {
    const st = await page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return e && !e.classList.contains('hidden'); };
      if (vis('result-overlay')) return 'result';
      const hu = [...document.querySelectorAll('#ting-center .act-btn, #action-bar .act-btn')].find((b) => b.textContent.startsWith('胡')); if (hu) { hu.click(); return 'win'; }
      const pass = [...document.querySelectorAll('#action-bar .act-btn')].find((b) => b.textContent.includes('过')); if (pass) { pass.click(); return 'pass'; }
      if (window.__gb && window.__gb.humanTurn && window.__gb.humanTurn()) { window.__gb.discard(); return 'discard'; }
      return 'wait';
    });
    if (st === 'result') { resolved++; console.log('无定番 online hand resolved:', await page.$eval('#result-title', (e) => e.textContent)); }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!resolved) throw new Error('no 无定番 online hand resolved within the timeout');
  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log('GUOBIAO-FREE ONLINE PLAY E2E PASS');
} catch (e) {
  console.error('GUOBIAO-FREE ONLINE PLAY E2E FAIL:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  if (srvErr) console.error('server:', srvErr);
  process.exitCode = 1;
} finally {
  await browser.close(); site.close(); srv.kill();
}
