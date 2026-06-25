// E2E for the seated-but-idle auto-remove: once you sit, you have READY_MS to ready up; if you don't,
// the server frees your seat. Readying within the window keeps the seat. Runs with a short READY_MS.
// Usage: node test/mahjong-online-ready-timeout-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const LOBBY_PORT = 8191, SITE_PORT = 8148;
const READY_MS = 1500; // short window so the test is quick
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SCORES_FILE = path.join(os.tmpdir(), `mj-ready-timeout-${LOBBY_PORT}.json`); try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
  { env: { ...process.env, PORT: String(LOBBY_PORT), SCORES_FILE, READY_MS: String(READY_MS) }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => errors.push('server: ' + d));
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

const site = await startServer(SITE_PORT);
const browser = await launchBrowser();
const url = `http://localhost:${SITE_PORT}/games/mahjong-common-online/?server=ws://localhost:${LOBBY_PORT}`;
const seatCls = (p) => p.$eval('.chair[data-table="0"][data-seat="0"]', (e) => e.className);

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('mahjong-online-name', '拖延'); localStorage.setItem('mahjong-online-uid', 'ready-timeout-uid'); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('conn').className.includes('on'), { timeout: 6000 });
  await page.waitForSelector('.chair[data-table="0"][data-seat="0"]', { timeout: 4000 });

  // --- 1) sit and DON'T ready → the seat must be auto-freed after READY_MS ---
  await page.click('.chair[data-table="0"][data-seat="0"]');
  await page.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  if (!(await page.$('#ready-timer'))) throw new Error('ready countdown not shown after sitting');
  console.log('sat (countdown shown), not readying…');
  await page.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"]').classList.contains('empty'),
    { timeout: READY_MS + 4000, polling: 200 });
  if ((await seatCls(page)).includes('me')) throw new Error('idle seat was NOT freed');
  console.log('idle seat auto-freed after the window ✓');

  // --- 2) sit again, READY within the window → the seat is kept past the window ---
  await page.click('.chair[data-table="0"][data-seat="0"]');
  await page.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  await page.evaluate(() => [...document.querySelectorAll('.btn.ready')].find((b) => b.textContent.includes('准备')).click());
  await page.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"] .ready.yes'), { timeout: 4000 });
  if (await page.$('#ready-timer')) throw new Error('countdown still shown after readying');
  await wait(READY_MS + 800); // outlast the window
  if (!(await seatCls(page)).includes('me')) throw new Error('ready seat was wrongly freed');
  console.log('readied seat survives the window ✓');

  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log('MAHJONG ONLINE READY-TIMEOUT TEST PASS');
} catch (e) {
  console.error('MAHJONG ONLINE READY-TIMEOUT TEST FAIL:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  site.close();
  srv.kill();
}
