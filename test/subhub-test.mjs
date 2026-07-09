// Sub-hub (/mj/) test: the generated sw-mj.js precaches ONLY the mahjong subset, and the
// scoped-hub navigation loop holds — enter the game from /mj/, leave via 返回主页, land back
// on /mj/ (never the full hub). Usage: node test/subhub-test.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startServer, launchBrowser } from './harness.mjs';

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } };

// ---- generator output ----------------------------------------------------
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'gen-subhub.js')], { stdio: 'inherit' });
const swMj = fs.readFileSync(path.join(ROOT, 'sw-mj.js'), 'utf8');
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'subhubs.json'), 'utf8')).mj;
const mainVer = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/offline-games-([0-9.]+)/)[1];
ok(swMj.includes(`const CACHE = 'mj-hub-${mainVer}';`), 'cache name carries the main sw.js version');
const assets = [...swMj.match(/const ASSETS = \[([\s\S]*?)\n\];/)[1].matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
const allowed = [...profile.prefixes, ...profile.extra];
const strays = assets.filter((a) => !allowed.some((x) => a === x || a.startsWith(x)));
ok(strays.length === 0, `no assets outside the mahjong subset (strays: ${strays.join(', ')})`);
for (const must of ['./games/mahjong-tianjin/main.js', './games/mahjong-common/game-base.js',
  './games/mahjong-common-online/lobby.js', './shared/hub-home.js', './mj/index.html']) {
  ok(assets.includes(must), `precache includes ${must}`);
}
ok(!assets.some((a) => a.includes('doudizhu') || a.includes('emulatorjs') || a.includes('pool')), 'no other games leak in');

// ---- browser flow ----------------------------------------------------------
const PORT = 8209;
const server = await startServer(PORT);
const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (e) => { failed++; console.error('  PAGEERROR:', e.message); });
await page.goto(`http://localhost:${PORT}/mj/`, { waitUntil: 'load' });
ok(await page.evaluate(() => sessionStorage.getItem('hub-home')) === '/mj/', 'hub-home marker planted');
ok((await page.$$('.card')).length === 2, 'two cards (单机 + 联机)');

// 单机 card → the game page loads, and its 返回主页 button returns to /mj/
await page.click('.card');   // first card = offline game
await page.waitForSelector('#start-overlay', { timeout: 20000 });
ok(page.url().includes('/games/mahjong-tianjin/'), 'offline game entered');
// main.js booted = the 省电模式 row is injected (same bindUI block as the hub-link listener)
await page.waitForFunction(() => !!document.querySelector('.power-mode-row'), { timeout: 20000, polling: 300 });
await page.evaluate(() => document.getElementById('start-hub-link').click());
await page.waitForFunction(() => location.pathname === '/mj/', { timeout: 10000, polling: 300 });
ok(true, '返回主页 lands back on /mj/, not the full hub');

// direct entry (no marker) still goes to the full hub
const direct = await browser.newPage();
await direct.goto(`http://localhost:${PORT}/games/mahjong-tianjin/`, { waitUntil: 'load' });
await direct.waitForFunction(() => !!document.querySelector('.power-mode-row'), { timeout: 20000, polling: 300 });
await direct.evaluate(() => document.getElementById('start-hub-link').click());
await direct.waitForFunction(() => location.pathname === '/', { timeout: 10000, polling: 300 });
ok(true, 'direct entry keeps the normal full-hub home');

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
