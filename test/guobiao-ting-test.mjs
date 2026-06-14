// Verifies the 听 (tenpai) declaration flow in 国标（无定番）:
//  1. With a ready hand, selecting a discard that leaves 听 shows both 打出 and a
//     glowing-red 打出并听牌 button.
//  2. Clicking 打出并听牌 locks the seat (听) and starts background music.
//  3. While 听, the seat is on autopilot: no 打出/碰/吃 buttons are offered.
// Usage: node test/guobiao-ting-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8166;
const server = await startServer(PORT);
const browser = await launchBrowser(['--autoplay-policy=no-user-gesture-required']);
function assert(c, m) { if (!c) throw new Error(m); }
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/guobiao-free/?fast=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__gb && __gb.phase(), { timeout: 8000 });

  // Force a ready hand: 123m 456m 789m 123p + 东, with a freshly drawn 白(33).
  // Discarding 33 leaves a hand waiting on 东(27); discarding 27 waits on 白(33).
  const TENPAI13 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 27];
  await page.evaluate((h) => window.__gb.forceTing(h, 33), TENPAI13);

  // (1) select the drawn 白 → the red 打出并听牌 appears; plain discard has no button (tap)
  await page.evaluate(() => window.__gb.selectKind(33));
  const acts = await page.evaluate(() => window.__gb.actions());
  const plain = acts.find((a) => a.text === '打出');
  const riichi = acts.find((a) => a.text === '打出并听牌');
  assert(!plain, 'plain 打出 button should be gone (tap to discard): ' + JSON.stringify(acts));
  assert(riichi, '打出并听牌 button missing: ' + JSON.stringify(acts));
  assert(riichi.cls.includes('riichi'), '打出并听牌 missing .riichi class: ' + riichi.cls);
  // No text disclaimer anymore — the red 打出并听牌 button itself is the 听 signal.
  const hint = await page.evaluate(() => window.__gb.hint());
  assert(hint === '', 'discard turn should have no disclaimer text, got: ' + JSON.stringify(hint));
  console.log('OK 打出并听牌(riichi) only, no plain 打出, no disclaimer');

  // (2) declare → locks + music starts
  await page.evaluate(() => window.__gb.clickAction('打出并听牌'));
  const locked = await page.evaluate(() => window.__gb.locked());
  const music = await page.evaluate(() => window.__gb.music());
  assert(locked, 'expected lockedTing after 打出并听牌');
  assert(music, 'expected background music after 听');
  console.log('OK declared: locked =', locked, ', music =', music);

  // (3) while 听 the human is offered nothing (autopilot). Force the human's
  // discard turn again, set 听, and confirm no buttons + the 已听 banner (which
  // now floats big above the hand, not as the bottom hint).
  await page.evaluate((h) => window.__gb.forceTing(h, 33), TENPAI13);
  await page.evaluate(() => window.__gb.setLocked([27]));
  const lockedActs = await page.evaluate(() => window.__gb.actions());
  const lockedBanner = await page.evaluate(() => document.getElementById('ting-banner').textContent);
  assert(lockedActs.length === 0, 'expected NO action buttons while 听, got: ' + JSON.stringify(lockedActs));
  assert(/已听/.test(lockedBanner), 'expected 已听 banner while 听, got: ' + lockedBanner);
  console.log('OK locked render: no buttons, banner =', JSON.stringify(lockedBanner));

  // Let the tension loop run a few bars so its Web Audio scheduling (heartbeat,
  // drone, tritone swell, 4-bar riser reset) is exercised for runtime errors.
  await page.evaluate(() => window.__gb.setLocked([27])); // ensure music still wanted
  await new Promise((r) => setTimeout(r, 6000));
  console.log('OK music loop ran ~6s without error');

  if (errors.length) throw new Error('runtime errors:\n  ' + errors.join('\n  '));
  console.log('GUOBIAO-TING TEST PASS');
} catch (e) {
  console.error('GUOBIAO-TING TEST FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
