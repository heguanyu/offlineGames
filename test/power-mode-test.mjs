// 省电模式 (power mode) regression test (shared/power-mode.js). Verifies, in a real browser at iPad
// resolution, that the 3-tier setting actually drives the renderer for both a poker game (斗地主) and
// a mahjong game (天津):
//   省电 (eco)      → flat 2D renderer (body.flat) + the #table scale-wrapper is applied (transform);
//   均衡 (balanced) → 3D but lite: pixelRatio 1, shadowMap disabled;
//   流畅 (smooth)   → 3D full: pixelRatio 2 (Retina sim), shadowMap enabled;
//   the 省电模式 picker is present in the in-game menu (3 buttons).
// Usage: node test/power-mode-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8149;
const server = await startServer(PORT);
// Force a Retina-like dpr so the smooth/balanced pixelRatio difference is observable.
const browser = await launchBrowser(['--force-device-scale-factor=2']);
let failed = 0;
const ok = (c, m) => { console.log((c ? '  ok: ' : '  FAIL: ') + m); if (!c) failed++; };

async function load(url, mode) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((m) => { try {
    if (m) localStorage.setItem('power-mode', m); else localStorage.removeItem('power-mode');
    localStorage.setItem('doudizhu-mute', '1'); localStorage.setItem('mahjong-muted', '1');
  } catch {} }, mode);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn', { timeout: 8000 }).catch(() => {});
  await page.click('#start-btn').catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  return { page, errs };
}

// read renderer facts via the exposed scene hook (3D only)
async function rendererInfo(page, hook) {
  return page.evaluate((h) => {
    const sc = (eval(h) && eval(h)()) || null;
    if (!sc || !sc.renderer) return null;
    return { pr: sc.renderer.getPixelRatio(), shadows: !!sc.renderer.shadowMap.enabled };
  }, hook).catch(() => null);
}

async function check(name, base, hook, openMenu) {
  console.log(`\n[${name}]`);
  // eco → flat 2D + scale wrapper
  {
    const { page, errs } = await load(base, 'eco');
    const flat = await page.evaluate(() => document.body.classList.contains('flat'));
    const scaled = await page.evaluate(() => /matrix\(|scale\(/.test(getComputedStyle(document.getElementById('table')).transform));
    ok(flat, 'eco → flat 2D renderer (body.flat)');
    ok(scaled, 'eco → #table scaled to fill the big screen');
    ok(errs.length === 0, 'eco → no page errors' + (errs.length ? ': ' + errs.join(';') : ''));
    await page.close();
  }
  // balanced → 3D lite
  {
    const { page, errs } = await load(base, 'balanced');
    const flat = await page.evaluate(() => document.body.classList.contains('flat'));
    const info = await rendererInfo(page, hook);
    ok(!flat && info, 'balanced → 3D renderer');
    ok(info && info.pr === 1, `balanced → pixelRatio 1 (was ${info && info.pr})`);
    ok(info && info.shadows === false, 'balanced → shadows OFF');
    ok(errs.length === 0, 'balanced → no page errors' + (errs.length ? ': ' + errs.join(';') : ''));
    await page.close();
  }
  // smooth → 3D full
  {
    const { page, errs } = await load(base, 'smooth');
    const info = await rendererInfo(page, hook);
    ok(info && info.pr === 2, `smooth → pixelRatio 2 (was ${info && info.pr})`);
    ok(info && info.shadows === true, 'smooth → shadows ON');
    // the picker is present in the menu (3 buttons)
    const btns = await openMenu(page);
    ok(btns === 3, `省电模式 picker present in the menu (${btns} buttons)`);
    ok(errs.length === 0, 'smooth → no page errors' + (errs.length ? ': ' + errs.join(';') : ''));
    await page.close();
  }
}

try {
  await check('doudizhu', `http://localhost:${PORT}/games/doudizhu/?fast=1`, 'window.__dou.scene', async (page) => {
    await page.click('#menu-btn').catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    return page.evaluate(() => document.querySelectorAll('.power-mode-row button').length);
  });
  await check('mahjong-tianjin', `http://localhost:${PORT}/games/mahjong-tianjin/?fast=1`, 'window.__mj.scene', async (page) => {
    await page.click('#menu-btn').catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    return page.evaluate(() => document.querySelectorAll('.power-mode-row button').length);
  });
} finally {
  await browser.close();
  server.close();
}

if (failed) { console.log(`\nPOWER MODE TEST FAIL (${failed})`); process.exit(1); }
console.log('\nPOWER MODE TEST PASS');
