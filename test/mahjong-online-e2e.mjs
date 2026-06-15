// E2E for the 天津麻将联机版 lobby: spins up the lobby server + the static site, drives TWO
// browser clients, and checks the server-authoritative table state syncs over WebSocket
// (no polling): sit (via the name dialog), cross-client visibility, add bots, ready → start.
// Usage: node test/mahjong-online-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOBBY_PORT = 8090, SITE_PORT = 8147;
const errors = [];

// start the lobby server (its own process, like in prod)
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
  { env: { ...process.env, PORT: String(LOBBY_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => errors.push('server: ' + d));
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

const site = await startServer(SITE_PORT);
// two SEPARATE browsers = two independent clients (avoids headless tab-discarding a
// backgrounded page, and mirrors real multi-device play).
const browserA = await launchBrowser();
const browserB = await launchBrowser();
const url = `http://localhost:${SITE_PORT}/games/mahjong-tianjin-online/`;
const vis = (p, id) => p.evaluate((i) => { const e = document.getElementById(i); return e && !e.classList.contains('hidden'); }, id);
const seatText = (p, t, s) => p.$eval(`.chair[data-table="${t}"][data-seat="${s}"] .who`, (e) => e.textContent);
const clickMenu = async (p, label) => p.evaluate((l) => {
  const b = [...document.querySelectorAll('#seat-menu button')].find((x) => x.textContent.includes(l)); if (b) b.click();
}, label);

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
  await A.click('.chair[data-table="0"][data-seat="0"]');
  await clickMenu(A, '坐这里');
  await A.waitForFunction(() => !document.getElementById('name-overlay').classList.contains('hidden'));
  await A.type('#name-dialog-input', '阿强');
  await A.click('#name-dialog-ok');
  await A.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"]').classList.contains('me'), { timeout: 4000 });
  if (await A.evaluate(() => localStorage.getItem('mahjong-online-name')) !== '阿强') throw new Error('name not saved to localStorage');
  console.log('A sat at table0/东 (name dialog → saved)');

  // B sees A's seat (server pushed the update — no poll)
  await B.waitForFunction(() => document.querySelector('.chair[data-table="0"][data-seat="0"] .who').textContent.includes('阿强'), { timeout: 4000 });
  if (!(await seatText(B, 0, 0)).includes('阿强')) throw new Error('cross-client sync failed');
  console.log('B sees A seated (cross-client push)');

  // A fills the other three seats with bots
  for (const s of [1, 2, 3]) { await A.click(`.chair[data-table="0"][data-seat="${s}"]`); await clickMenu(A, '加机器人'); await new Promise((r) => setTimeout(r, 120)); }
  await A.waitForFunction(() => [1, 2, 3].every((s) => document.querySelector(`.chair[data-table="0"][data-seat="${s}"]`).classList.contains('bot')), { timeout: 4000 });
  console.log('A added 3 bots');

  // A readies → all four seats ready/bot → server starts the hand → gameStart banner
  await A.evaluate(() => [...document.querySelectorAll('.btn.ready')].find((b) => b.textContent.includes('准备')).click());
  await A.waitForFunction(() => !document.getElementById('start-overlay').classList.contains('hidden'), { timeout: 4000 });
  if (!(await A.$eval('#start-text', (e) => e.textContent)).includes('东')) throw new Error('gameStart missing the seat wind');
  // B should now see table 0 as 游戏中 (playing)
  await B.waitForFunction(() => document.querySelector('.table-card').classList.contains('playing'), { timeout: 4000 });
  console.log('all ready → gameStart fired; table marked 游戏中');

  // remove-bot path: a fresh table, add then remove a bot
  await B.click('.chair[data-table="1"][data-seat="2"]');
  await clickMenu(B, '加机器人');
  await B.waitForFunction(() => document.querySelector('.chair[data-table="1"][data-seat="2"]').classList.contains('bot'));
  await B.click('.chair[data-table="1"][data-seat="2"]');
  await clickMenu(B, '移除机器人');
  await B.waitForFunction(() => document.querySelector('.chair[data-table="1"][data-seat="2"]').classList.contains('empty'));
  console.log('add/remove bot OK');

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
