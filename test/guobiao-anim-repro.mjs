// Repro for the reported offline 国标 bug: bots get "stuck at thinking" / laggy with animation mess.
// Loads the game with animations ON (no ?fast, fastMode off) and drives the human via keyboard,
// watching the wall count for progress. Fails if play stalls (no progress for STALL_MS) or errors.
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8147;
const STALL_MS = 18000;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  // animations ON: fastMode off (so discard/claim flies play) and NO ?fast (so FAST=false)
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('guobiao-fast', '0'); } catch {} });
  await page.goto(`http://localhost:${PORT}/games/guobiao/?d3=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');

  const wall = async () => page.$eval('#wall-count', (e) => e.textContent).catch(() => '');
  const resultUp = async () => page.evaluate(() => !document.getElementById('result-overlay').classList.contains('hidden'));
  const handsLabel = async () => page.$eval('#round-info', (e) => e.textContent).catch(() => '');

  let last = await wall(), lastChange = Date.now(), hands = 0, deadline = Date.now() + 80000;
  while (Date.now() < deadline && hands < 4) {
    // crude auto-pilot: win if offered, pass claims, discard, advance result — all guarded by onAction
    await page.keyboard.press('KeyH').catch(() => {});      // 'win' (take a 胡 if offered)
    await page.keyboard.press('Backspace').catch(() => {}); // 'pass' a claim
    await page.keyboard.press('Enter').catch(() => {});     // discard selected / 下一局 on the result
    if (await resultUp()) { hands++; await page.keyboard.press('Enter').catch(() => {}); await new Promise((r) => setTimeout(r, 600)); }
    const w = await wall();
    if (w !== last) { last = w; lastChange = Date.now(); }
    else if (Date.now() - lastChange > STALL_MS) {
      const info = await handsLabel();
      throw new Error(`STALLED — no progress for ${STALL_MS}ms. wall="${w}" round="${info}" errors=${JSON.stringify(errors)}`);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log(`progressed (hands seen=${hands}, wall=${last}); no stall, no errors`);
  console.log('GUOBIAO ANIM REPRO: no bug reproduced');
} catch (e) {
  console.error('GUOBIAO ANIM REPRO FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
