// End-to-end online PLAY test for 国标: a browser goes through the lobby, switches to the 国标 tab
// (table 1 in the default lineup), sits + adds bots + readies; the lobby hands off to the 国标 game
// page (?online=1), which — driven by the server via the 国标 RemoteBackend — renders and plays a
// hand to a result. Validates the lobby game tabs + the guobiao online wiring end-to-end.
// Usage: node test/guobiao-online-play-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8195, SITE = 8149;
const SCORES_FILE = path.join(os.tmpdir(), `gb-play-e2e-${PORT}.json`); try { fs.unlinkSync(SCORES_FILE); } catch {}
// default lineup (天津, 国标) — the 国标 table is index 1
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
  await page.evaluateOnNewDocument(() => { localStorage.setItem('mahjong-online-name', '国标客'); localStorage.setItem('mahjong-online-uid', 'gb-play-e2e-uid'); });

  // the 国标 split lobby (?game=guobiao) shows only the 国标 table (index 1 in the default lineup)
  await page.goto(`http://localhost:${SITE}/games/mahjong-tianjin-online/?server=ws://localhost:${PORT}&fast=1&game=guobiao`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('conn')?.className.includes('on'), { timeout: 6000 });
  await page.waitForSelector('.chair[data-table="1"][data-seat="0"]');
  await page.click('.chair[data-table="1"][data-seat="0"]');
  await clickMenu(page, '坐这里');
  await page.waitForFunction(() => document.querySelector('.chair[data-table="1"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  for (const s of [1, 2, 3]) { await page.click(`.chair[data-table="1"][data-seat="${s}"]`); await clickMenu(page, '加机器人'); await new Promise((r) => setTimeout(r, 120)); }
  await page.evaluate(() => [...document.querySelectorAll('.btn.ready')].find((b) => b.textContent.includes('准备')).click());
  console.log('lobby: 国标 tab, seated + 3 bots + ready');

  await page.waitForFunction(() => location.pathname.includes('/guobiao/'), { timeout: 8000 });
  console.log('navigated to the 国标 online game page');
  await page.waitForFunction(() => (window.__gb && window.__gb.humanTurn && window.__gb.humanTurn()) ||
    document.querySelector('#action-bar .act-btn') || document.querySelector('#ting-center .act-btn') ||
    !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 12000 });
  const info = await page.$eval('#round-info', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  if (!info.includes('联机')) throw new Error(`online round-info should say 联机, got: ${info}`);
  console.log('国标 online game live —', info);

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
    if (st === 'result') { resolved++; const title = await page.$eval('#result-title', (e) => e.textContent); console.log('国标 online hand resolved:', title); }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!resolved) throw new Error('no 国标 online hand resolved within the timeout');
  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log('GUOBIAO ONLINE PLAY E2E PASS');
} catch (e) {
  console.error('GUOBIAO ONLINE PLAY E2E FAIL:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  if (srvErr) console.error('server:', srvErr);
  process.exitCode = 1;
} finally {
  await browser.close(); site.close(); srv.kill();
}
