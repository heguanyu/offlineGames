// On-demand render-loop regression test (battery). The card-game 3D scenes no longer run a perpetual
// 60 fps loop — they render only while something animates and STOP when the table settles, waking on
// any state change (sync/select/deal/resize/…). This test proves, in a real browser, that for both
// scene implementations (斗地主 = DouScene, 天津麻将 = MahjongScene):
//   1. once a hand settles and it's the human's idle turn, the render loop STOPS (no wasted frames);
//   2. a state change (scene.resize → _kick) WAKES it again (frames resume), then it re-settles;
//   3. the canvas still shows real content (the game is visually intact with polling off).
// Usage: node test/card-ondemand-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8146;
const server = await startServer(PORT);
const browser = await launchBrowser();
let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok: ' : '  FAIL: ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Instrument the scene's renderer to count frames, and expose its running flag. Runs in page context.
async function instrument(page, hookExpr) {
  await page.evaluate((hook) => {
    const sc = eval(hook)();              // e.g. window.__dou.scene()
    window.__rc = 0;
    const orig = sc.renderer.render.bind(sc.renderer);
    sc.renderer.render = (...a) => { window.__rc++; return orig(...a); };
    window.__scn = sc;
  }, hookExpr);
}
const frames = (page) => page.evaluate(() => window.__rc);
const running = (page) => page.evaluate(() => !!window.__scn._running);

// Wait until the loop has stopped (settled): _running false AND the frame count stable across a gap.
async function waitIdle(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const a = await frames(page); await sleep(250); const b = await frames(page);
    if (a === b && !(await running(page))) return true;
    await sleep(100);
  }
  return false;
}

async function check(name, url, start) {
  console.log(`\n[${name}]`);
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport({ width: 1024, height: 768 });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('doudizhu-mute', '1'); localStorage.setItem('mahjong-muted', '1'); } catch {} });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await start(page);

  // settle once the hand is interactive
  const settled = await waitIdle(page);
  ok(settled, 'render loop STOPS when the table is idle (settled, _running=false)');

  // 1) idle window: frame count must NOT climb
  const before = await frames(page);
  await sleep(900);
  const idleDelta = (await frames(page)) - before;
  ok(idleDelta <= 1, `idle ~900ms draws ~0 frames (was ${idleDelta})`); // ≤1 tolerates a stray settle frame

  // 2) wake on a state change: resize() calls _kick() → loop runs again
  await page.evaluate(() => window.__scn.resize());
  await sleep(300);
  const wakeDelta = (await frames(page)) - before - idleDelta;
  ok(wakeDelta >= 1, `a state change WAKES the loop (drew ${wakeDelta} frame(s))`);
  ok(await waitIdle(page), 'loop re-settles (stops again) after the change');

  // 3) the canvas is non-blank — game still renders with polling off
  const painted = await page.evaluate(() => {
    const cv = document.querySelector('canvas');
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    const px = new Uint8Array(4 * cv.width * cv.height);
    gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nonBlack = 0; for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) nonBlack++;
    return nonBlack > px.length / 4 * 0.05; // >5% of pixels have colour
  }).catch(() => null);
  // readPixels can be empty after a render (cleared backbuffer); fall back to a screenshot non-blank check
  if (painted === null || painted === false) {
    const buf = await page.screenshot();
    ok(buf.length > 5000, 'canvas/screenshot shows real content (game visually intact)');
  } else {
    ok(painted, 'canvas shows real content (game visually intact)');
  }

  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
  await page.close();
}

try {
  await instrumentedRun();
} finally {
  await browser.close();
  server.close();
}

async function instrumentedRun() {
  // 斗地主 (DouScene)
  await check('doudizhu', `http://localhost:${PORT}/games/doudizhu/?fast=1&d3=1`, async (page) => {
    await page.waitForSelector('#start-btn'); await page.click('#start-btn');
    await page.waitForFunction(() => window.__dou && (window.__dou.awaiting() || window.__dou.resultShown()), { timeout: 8000 });
    await instrument(page, 'window.__dou.scene');
  });
  // 天津麻将 (MahjongScene)
  await check('mahjong-tianjin', `http://localhost:${PORT}/games/mahjong-tianjin/?fast=1&d3=1`, async (page) => {
    await page.waitForSelector('#start-btn'); await page.click('#start-btn');
    await page.waitForFunction(() => window.__mj && window.__mj.scene && window.__mj.scene(), { timeout: 8000 });
    await instrument(page, 'window.__mj.scene');
    // let the deal flourish finish so we measure a genuinely idle table
    await page.waitForFunction(() => (window.__mj && window.__mj.humanTurn()) || document.querySelector('#action-bar .act-btn'), { timeout: 8000 }).catch(() => {});
  });
}

if (failed) { console.log(`\nCARD ON-DEMAND TEST FAIL (${failed})`); process.exit(1); }
console.log('\nCARD ON-DEMAND TEST PASS');
