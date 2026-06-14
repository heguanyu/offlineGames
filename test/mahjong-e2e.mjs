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

  await page.goto(`http://localhost:${PORT}/games/mahjong/?fast=1`, { waitUntil: 'networkidle0' });

  // Start a hand on Normal difficulty; the 3D table + action bar should appear.
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => (window.__mj && window.__mj.humanTurn()) ||
    document.querySelector('#action-bar .act-btn') ||
    !document.getElementById('result-overlay').classList.contains('hidden'), { timeout: 8000 });
  console.log('hand started, 3D scene + action bar live');

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
