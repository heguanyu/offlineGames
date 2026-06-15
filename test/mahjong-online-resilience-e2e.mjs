// Resilience e2e: start a game, KILL the server, and confirm the game page shows the reconnect
// banner then returns to the lobby; the lobby shows the "维护中" status; and once the server is
// restarted (same state file) the lobby reconnects with the seat RESTORED — ready to resume the 锅.
// Usage: node test/mahjong-online-resilience-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8199, SITE = 8153;
const SCORES_FILE = path.join(os.tmpdir(), `mj-resilience-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const spawnServer = () => spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '300', SCORES_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
const waitListen = (s) => new Promise((res) => { s.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let srv = spawnServer(); await waitListen(srv);
const site = await startServer(SITE);
const browser = await launchBrowser();
const clickMenu = (p, label) => p.evaluate((l) => { const b = [...document.querySelectorAll('#seat-menu button')].find((x) => x.textContent.includes(l)); if (b) b.click(); }, label);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 720 });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('mahjong-online-name', '阿弹'); localStorage.setItem('mahjong-online-uid', 'resil-uid'); });
  await page.goto(`http://localhost:${SITE}/games/mahjong-tianjin-online/?server=ws://localhost:${PORT}&fast=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('conn')?.className.includes('on'), { timeout: 6000 });
  await page.waitForSelector('.chair[data-table="0"][data-seat="0"]');
  await page.click('.chair[data-table="0"][data-seat="0"]'); await clickMenu(page, '坐这里');
  await page.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  for (const s of [1, 2, 3]) { await page.click(`.chair[data-table="0"][data-seat="${s}"]`); await clickMenu(page, '加机器人'); await new Promise((r) => setTimeout(r, 120)); }
  await page.evaluate(() => [...document.querySelectorAll('.btn.ready')].find((b) => b.textContent.includes('准备')).click());
  await page.waitForFunction(() => location.pathname.includes('/mahjong-tianjin/'), { timeout: 8000 });
  await page.waitForFunction(() => window.__mj && window.__mj.game && window.__mj.game(), { timeout: 12000 });
  console.log('game live');

  // --- KILL the server mid-game ---
  srv.kill('SIGTERM');
  await new Promise((r) => srv.on('exit', r));
  console.log('server killed');

  // the game page shows the reconnect banner, then returns to the lobby (the 8s fallback)
  await page.waitForFunction(() => !document.getElementById('reconnect-overlay').classList.contains('hidden'), { timeout: 5000 });
  console.log('reconnect banner shown on the game page');
  await page.waitForFunction(() => location.pathname.includes('/mahjong-tianjin-online/'), { timeout: 12000 });
  console.log('bounced back to the lobby');

  // the lobby shows the maintenance status while the server is down
  await page.waitForFunction(() => { const e = document.getElementById('maint-overlay'); return e && !e.classList.contains('hidden'); }, { timeout: 6000 });
  const maintText = await page.$eval('#maint-overlay', (e) => e.textContent);
  if (!maintText.includes('维护')) throw new Error('maintenance overlay missing the 维护 message');
  console.log('lobby shows 服务器维护中');

  // --- restart the server (same state file) ---
  srv = spawnServer(); await waitListen(srv);
  console.log('server restarted');

  // the lobby reconnects → maintenance hides AND the seat is restored (chair[seat 0] is "me")
  await page.waitForFunction(() => document.getElementById('maint-overlay').classList.contains('hidden'), { timeout: 8000 });
  await page.waitForFunction(() => { const c = document.querySelector('.chair[data-table="0"][data-seat="0"]'); return c && c.classList.contains('me'); }, { timeout: 6000 });
  console.log('lobby reconnected; seat restored — ready to resume the 锅');
  console.log('MAHJONG ONLINE RESILIENCE E2E PASS');
} catch (e) {
  console.error('MAHJONG ONLINE RESILIENCE E2E FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close(); site.close(); try { srv.kill(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {}
}
