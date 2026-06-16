// E2E for the 天津麻将联机版 lobby: spins up the lobby server + the static site, drives TWO
// browser clients, and checks the server-authoritative table state syncs over WebSocket
// (no polling): sit (via the name dialog), cross-client visibility, add bots, ready → start.
// Usage: node test/mahjong-online-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOBBY_PORT = 8190, SITE_PORT = 8147; // 8190 (not 8090) so a dev server on 8090 isn't disturbed
const errors = [];

// start the lobby server (its own process, like in prod)
const SCORES_FILE = path.join(os.tmpdir(), `mj-lobby-e2e-${LOBBY_PORT}.json`); try { fs.unlinkSync(SCORES_FILE); } catch {} // isolate: no restored table state
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
  { env: { ...process.env, PORT: String(LOBBY_PORT), SCORES_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => errors.push('server: ' + d));
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

const site = await startServer(SITE_PORT);
// two SEPARATE browsers = two independent clients (avoids headless tab-discarding a
// backgrounded page, and mirrors real multi-device play).
const browserA = await launchBrowser();
const browserB = await launchBrowser();
const url = `http://localhost:${SITE_PORT}/games/mahjong-tianjin-online/?server=ws://localhost:${LOBBY_PORT}`;
const vis = (p, id) => p.evaluate((i) => { const e = document.getElementById(i); return e && !e.classList.contains('hidden'); }, id);
const seatText = (p, t, s) => p.$eval(`.chair[data-table="${t}"][data-seat="${s}"] .who`, (e) => e.textContent);
// Seat interactions: clicking an empty chair sits directly; a 🤖 button on the chair adds a bot,
// and the same button (with a 🚫, .remove) takes it away.
const sit = (p, t, s) => p.click(`.chair[data-table="${t}"][data-seat="${s}"]`);
const addBot = (p, t, s) => p.click(`.chair[data-table="${t}"][data-seat="${s}"] .seat-bot`);
const removeBot = (p, t, s) => p.click(`.chair[data-table="${t}"][data-seat="${s}"] .seat-bot.remove`);

try {
  const A = await browserA.newPage();
  const B = await browserB.newPage();
  for (const [p, n] of [[A, 'A'], [B, 'B']]) {
    p.on('pageerror', (e) => errors.push(`page${n}: ` + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`page${n} console: ` + m.text()); });
    await p.evaluateOnNewDocument(() => localStorage.removeItem('mahjong-online-name'));
    await p.goto(url, { waitUntil: 'domcontentloaded' }); // a persistent WS never lets networkidle0 settle
    await p.waitForFunction(() => document.getElementById('conn').className.includes('on'), { timeout: 6000 });
    await p.waitForSelector('.chair[data-table="0"][data-seat="0"]', { timeout: 4000 }); // lobby frame rendered
  }
  console.log('both clients connected (WebSocket)');

  // A sits at table 0 / 东 via the name dialog (first sit)
  await sit(A, 0, 0);
  await A.waitForFunction(() => !document.getElementById('name-overlay').classList.contains('hidden'));
  // name rules: only 中文/英文, capped at 6 中文 / 12 英文. A too-long, mixed-junk name is cleaned live.
  await A.type('#name-dialog-input', '测试玩家一二三四 abc123!@#'); // 8 中文 + junk
  const cleaned = await A.evaluate(() => document.getElementById('name-dialog-input').value);
  if (cleaned !== '测试玩家一二') throw new Error(`name input not cleaned: got "${cleaned}" (want 测试玩家一二 — 6 中文 cap, junk stripped)`);
  // IME: clamping must NOT fire mid-composition (e.g. typing pinyin for 小帅) — only after compositionend.
  await A.evaluate(() => { const el = document.getElementById('name-dialog-input'); el.value = ''; el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = '小帅同学一二三四五'; // 9 中文, over the limit, but still being composed
    el.dispatchEvent(new InputEvent('input', { isComposing: true, bubbles: true })); });
  const mid = await A.evaluate(() => document.getElementById('name-dialog-input').value);
  if (mid !== '小帅同学一二三四五') throw new Error(`name clamped DURING IME composition: "${mid}" (should be left alone)`);
  await A.evaluate(() => { const el = document.getElementById('name-dialog-input');
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  const after = await A.evaluate(() => document.getElementById('name-dialog-input').value);
  if (after !== '小帅同学一二') throw new Error(`name not clamped after IME ended: "${after}" (want 小帅同学一二)`);
  await A.evaluate(() => { document.getElementById('name-dialog-input').value = ''; });
  await A.type('#name-dialog-input', '阿强');
  await A.click('#name-dialog-ok');
  await A.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  if (await A.evaluate(() => localStorage.getItem('mahjong-online-name')) !== '阿强') throw new Error('name not saved to localStorage');
  console.log('A sat at table0/东 (name dialog → saved)');

  // B sees A's seat (server pushed the update — no poll)
  await B.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"] .who').textContent.includes('阿强'), { timeout: 4000 });
  if (!(await seatText(B, 0, 0)).includes('阿强')) throw new Error('cross-client sync failed');
  // B also sees A's not-ready countdown 未准备(mm:ss) — server-synced, pushed each second
  await B.waitForFunction(() => { const s = document.querySelector('.chair[data-table="0"][data-seat="0"] .ready.no'); return s && /未准备\(\d\d:\d\d\)/.test(s.textContent); }, { timeout: 4000 });
  console.log('B sees A seated + 未准备 countdown (cross-client push)');

  // add/remove bot (the single table, while waiting): B adds a bot to seat 2 then removes it.
  await addBot(B, 0, 2);
  await B.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="2"]').classList.contains('bot'), { timeout: 4000 });
  // bots are named by seat: seat 2 is 西 → 西门风
  if (!(await seatText(B, 0, 2)).includes('西门风')) throw new Error('bot not named by seat (want 西门风 at seat 2)');
  await removeBot(B, 0, 2);
  await B.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="2"]').classList.contains('empty'), { timeout: 4000 });
  console.log('add/remove bot OK');

  // A readies FIRST while seats are still empty — must NOT start (no navigation).
  await A.evaluate(() => [...document.querySelectorAll('.btn.ready')].find((b) => b.textContent.includes('准备')).click());
  await A.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"] .ready.yes'), { timeout: 4000 });
  await new Promise((r) => setTimeout(r, 250));
  if (!(await A.evaluate(() => location.pathname)).includes('mahjong-tianjin-online')) throw new Error('game started before the table was full');
  console.log('A readied (table not full → no start)');

  // Then fill with bots. The table completes on the LAST bot, which must re-trigger the
  // start check (regression: addBot used to skip it). → A is handed off to the game page.
  for (const s of [1, 2, 3]) { await addBot(A, 0, s); await new Promise((r) => setTimeout(r, 150)); }
  await A.waitForFunction(() => location.pathname.includes('/mahjong-tianjin/'), { timeout: 8000 }); // navigated to the game
  await B.waitForFunction(() => document.querySelector('.mj-table.playing'), { timeout: 4000 });
  console.log('all ready → A entered the game; table marked 游戏中');

  // rejoin: A wanders back to the lobby (as you might from the hub). The server still holds A's
  // seat (uid), so the lobby must offer 返回牌桌 and clicking it drops back into the live game.
  await A.goto(url, { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => document.getElementById('conn').className.includes('on'), { timeout: 6000 });
  await A.waitForFunction(() => [...document.querySelectorAll('.btn')].some((b) => b.textContent.includes('返回牌桌')), { timeout: 4000 });
  await A.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('返回牌桌')).click());
  await A.waitForFunction(() => location.pathname.includes('/mahjong-tianjin/'), { timeout: 6000 });
  console.log('A returned to the lobby → 返回牌桌 → back in the live game (rejoin)');

  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log('MAHJONG ONLINE LOBBY E2E PASS');
} catch (e) {
  console.error('MAHJONG ONLINE LOBBY E2E FAIL:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browserA.close();
  await browserB.close();
  site.close();
  srv.kill();
}
