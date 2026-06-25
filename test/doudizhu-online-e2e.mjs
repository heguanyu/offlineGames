// Full-stack browser e2e for ONLINE 斗地主: spins up the real server (which also serves the static
// site), opens the lobby in a headless browser, sits + adds two bots + readies, follows the
// auto-navigation into the game page (?online=1), and drives the human (bid 3 → landlord, then play
// the smallest legal combo each turn) until the result modal appears. Asserts NO page/runtime errors
// along the way — this is what exercises the online main.js paths (startOnline, the online onEvent
// branches, the turn ring, the result toggle) in a real browser.
// Usage: node test/doudizhu-online-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ROOT as root, launchBrowser } from './harness.mjs';

const PORT = 8195;
const SCORES_FILE = path.join(os.tmpdir(), `dou-e2e-scores-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), TABLE_GAMES: 'doudizhu', BOT_THINK_MS: '20', DOU_MATCH_TARGET: '1', READY_MS: '120000', SCORES_FILE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let browser;
const errs = [];
function done(code, msg) {
  console.log(msg);
  try { browser && browser.close(); } catch {}
  try { fs.unlinkSync(SCORES_FILE); } catch {}
  srv.kill();
  process.exit(code);
}
const fail = (m) => done(1, 'DOU ONLINE E2E FAIL: ' + m + (errs.length ? '\n  page errors: ' + errs.join(' | ') : '') + (srvErr ? '\n  server stderr: ' + srvErr : ''));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  // a stable uid + name so sitting never opens the name dialog, and muted audio
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('mahjong-online-uid', 'dou-e2e-uid'); localStorage.setItem('mahjong-online-name', '阿斗'); localStorage.setItem('doudizhu-mute', '1'); localStorage.setItem('mahjong-muted', '1'); } catch {}
  });
  page.on('pageerror', (e) => errs.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  const base = `http://localhost:${PORT}`;
  const srvParam = `server=ws://localhost:${PORT}`;
  await page.goto(`${base}/games/mahjong-common-online/?game=doudizhu&fast=1&${srvParam}`, { waitUntil: 'domcontentloaded' });

  // ---- lobby: sit seat 0, add bots to 1 & 2, ready ----
  await page.waitForSelector('.chair[data-seat="0"]', { timeout: 8000 });
  await page.waitForFunction(() => !!document.querySelector('.chair[data-seat="0"].empty'), { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.chair[data-seat="0"].empty').click());
  await page.waitForFunction(() => !!document.querySelector('.chair[data-seat="0"].me'), { timeout: 8000 });
  for (const s of [1, 2]) {
    await page.waitForFunction((seat) => !!document.querySelector(`.chair[data-seat="${seat}"] .seat-bot`), { timeout: 8000 }, s);
    await page.evaluate((seat) => document.querySelector(`.chair[data-seat="${seat}"] .seat-bot`).click(), s);
    await page.waitForFunction((seat) => !!document.querySelector(`.chair[data-seat="${seat}"].bot`), { timeout: 8000 }, s);
  }
  // bot seats must use the 斗地主 NPC names (阿牛/阿强/阿美), not the mahjong chair names
  const botNames = await page.evaluate(() => [1, 2].map((s) => (document.querySelector(`.chair[data-seat="${s}"]`) || {}).textContent || ''));
  const DOU = ['阿牛', '阿强', '阿美'];
  if (!botNames.every((txt) => DOU.some((n) => txt.includes(n)))) fail('lobby bot seats not named 阿牛/阿强/阿美: ' + JSON.stringify(botNames));
  console.log('  bot seats named:', botNames.map((t) => DOU.find((n) => t.includes(n))).join(', '));

  await page.waitForSelector('.table-ready', { timeout: 8000 });
  await page.evaluate(() => document.querySelector('.table-ready').click());

  // ---- the lobby navigates into the game page (?online=1) ----
  await page.waitForFunction(() => /\/games\/doudizhu\//.test(location.pathname), { timeout: 12000 });
  await page.waitForFunction(() => !!window.__dou, { timeout: 12000 });
  // the difficulty start screen must NEVER show in online mode (it's gated off before first paint)
  const diffShown = await page.evaluate(() => { const e = document.getElementById('start-overlay'); return !!e && getComputedStyle(e).display !== 'none'; });
  if (diffShown) fail('difficulty start overlay is visible in online mode');
  console.log('  entered the online 斗地主 game page (no difficulty popup)');

  // ---- drive the human until the hand resolves ----
  const deadline = Date.now() + 45000;
  let resolved = false;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      if (window.__dou.resultShown && window.__dou.resultShown()) return 'result';
      const a = window.__dou.awaiting && window.__dou.awaiting();
      if (a === 'bid') {
        // bid 3 to reliably become the landlord so the hand plays out (avoids endless redeals)
        const btns = [...document.querySelectorAll('.bid-btn')];
        if (btns[3] && !btns[3].disabled) { btns[3].click(); return 'bid3'; }
        window.__dou.step(); return 'bid';
      }
      if (a === 'play') { window.__dou.step(); return 'play'; }
      return 'wait';
    });
    if (st === 'result') { resolved = true; break; }
    await wait(200);
  }
  if (errs.length) { fail('runtime errors during online play'); }
  else if (!resolved) { fail('the online hand never reached a result'); }
  else done(0, 'online 斗地主: lobby → seated → played a full hand → result, no runtime errors\nDOU ONLINE E2E PASS');
} catch (e) {
  fail('exception: ' + (e && e.stack || e));
}
