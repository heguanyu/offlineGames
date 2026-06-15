// End-to-end online PLAY test: a browser goes through the lobby (sit + bots + ready), the
// lobby hands off to the game page (?online=1), and the game — driven by the server via the
// RemoteBackend — renders and plays a hand to a result. Validates the main.js online wiring.
// Usage: node test/mahjong-online-play-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8193, SITE = 8148;
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await page.evaluateOnNewDocument(() => { localStorage.setItem('mahjong-online-name', '阿玩'); localStorage.setItem('mahjong-online-uid', 'play-e2e-uid'); });

  // --- lobby: sit at seat 0 (dealer → no 拉庄), fill with bots, ready ---
  await page.goto(`http://localhost:${SITE}/games/mahjong-tianjin-online/?server=ws://localhost:${PORT}&fast=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('conn')?.className.includes('on'), { timeout: 6000 });
  await page.waitForSelector('.chair[data-table="0"][data-seat="0"]');
  await page.click('.chair[data-table="0"][data-seat="0"]');
  await clickMenu(page, '坐这里');
  await page.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  for (const s of [1, 2, 3]) { await page.click(`.chair[data-table="0"][data-seat="${s}"]`); await clickMenu(page, '加机器人'); await new Promise((r) => setTimeout(r, 120)); }
  await page.evaluate(() => [...document.querySelectorAll('.btn.ready')].find((b) => b.textContent.includes('准备')).click());
  console.log('lobby: seated + 3 bots + ready');

  // --- hand-off: the lobby navigates to the game page ---
  await page.waitForFunction(() => location.pathname.includes('/mahjong-tianjin/'), { timeout: 8000 });
  console.log('navigated to the online game page');
  await page.waitForFunction(() => (window.__mj && window.__mj.humanTurn && window.__mj.humanTurn()) ||
    document.querySelector('#action-bar .act-btn') || document.querySelector('#ting-center .act-btn'), { timeout: 12000 });
  const info = await page.$eval('#round-info', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  if (!info.includes('联机')) throw new Error(`online round-info should say 联机, got: ${info}`);
  console.log('online game live —', info);

  // --- drive the server-run hand to a result (server is authoritative) ---
  const deadline = Date.now() + 40000; let resolved = 0;
  while (Date.now() < deadline && resolved < 1) {
    const st = await page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return e && !e.classList.contains('hidden'); };
      if (vis('result-overlay')) return 'result';
      const hu = [...document.querySelectorAll('#ting-center .act-btn')].find((b) => b.textContent.includes('胡')); if (hu) { hu.click(); return 'win'; }
      const pass = [...document.querySelectorAll('#action-bar .act-btn')].find((b) => b.textContent.includes('过')); if (pass) { pass.click(); return 'pass'; }
      if (window.__mj && window.__mj.humanTurn && window.__mj.humanTurn()) { window.__mj.discard(); return 'discard'; }
      return 'wait';
    });
    if (st === 'result') {
      resolved++;
      const title = await page.$eval('#result-title', (e) => e.textContent);
      console.log('online hand resolved:', title);
      await page.screenshot({ path: path.join(root, 'test', 'online-game.png') });
      await page.click('#next-hand-btn');
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!resolved) throw new Error('no online hand resolved within the timeout');
  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log('MAHJONG ONLINE PLAY E2E PASS');
} catch (e) {
  console.error('MAHJONG ONLINE PLAY E2E FAIL:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  if (srvErr) console.error('server:', srvErr);
  process.exitCode = 1;
} finally {
  await browser.close(); site.close(); srv.kill();
}
