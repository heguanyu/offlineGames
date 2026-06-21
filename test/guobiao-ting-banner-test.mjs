// Regression: in 国标麻将 the floating 听牌 disclaimer (#ting-banner, "已听 · 自动出牌…")
// must be cleared the moment a new hand starts dealing — not left lingering over the
// deal animation until the post-deal render(). Runs WITHOUT ?fast so the real deal
// animation (and its 发牌中… window) plays. Usage: node test/guobiao-ting-banner-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8186;
const server = await startServer(PORT);
const browser = await launchBrowser();
function assert(c, m) { if (!c) throw new Error(m); }

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 720 });
  await page.goto(`http://localhost:${PORT}/games/guobiao/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  // first deal: 发牌中… appears, then clears once the hand is in play
  await page.waitForFunction(() => /发牌/.test(document.getElementById('hand-hint').textContent), { timeout: 8000 });
  await page.waitForFunction(() => !/发牌/.test(document.getElementById('hand-hint').textContent), { timeout: 8000 });

  // Simulate a 听 disclaimer left showing from the hand just played.
  await page.evaluate(() => { const b = document.getElementById('ting-banner'); b.textContent = '已听 · 自动出牌（等 东）'; b.classList.add('show'); });

  // Start a fresh hand from the menu (重开) — this deals again.
  await page.click('#menu-btn');
  await page.waitForFunction(() => !document.getElementById('menu-overlay').classList.contains('hidden'), { timeout: 4000 });
  await page.click('#newgame-btn');

  // While the new hand is DEALING (发牌中…), the stale 听 banner must already be gone.
  await page.waitForFunction(() => /发牌/.test(document.getElementById('hand-hint').textContent), { timeout: 8000 });
  const banner = await page.evaluate(() => {
    const b = document.getElementById('ting-banner');
    return { shown: b.classList.contains('show'), text: b.textContent };
  });
  assert(!banner.shown && !banner.text, `听 banner still showing during deal: shown=${banner.shown}, text="${banner.text}"`);
  console.log('OK: 听 banner cleared at deal start (not lingering over 发牌中…)');

  console.log('GUOBIAO TING-BANNER TEST PASS');
  await page.close();
} catch (e) {
  console.error('GUOBIAO TING-BANNER TEST FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
