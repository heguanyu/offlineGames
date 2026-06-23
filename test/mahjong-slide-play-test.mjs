// Verifies the "slide up to play" gesture: dragging a hand tile up ~2x its height
// discards it directly (no tap-to-select first); a shorter slide just selects. Covers
// the 3D table (scene.js) and flat 2D board (scene2d.js), landscape + force-rotated
// portrait (rotation flips the on-screen "up" axis), for both 国标 and 天津.
// Usage: node test/mahjong-slide-play-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8179;
const server = await startServer(PORT);
const browser = await launchBrowser();
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Locate a target hand tile and compute the slide endpoint for a given multiple of
// the tile height. `which`: 'any' | 'notSelected' | 'nonWild'. Returns client px.
async function planSlide(page, dbgName, which, mult) {
  return page.evaluate((dbgName, which, mult) => {
    const dbg = window[dbgName];
    const game = dbg.game();
    const sc = dbg.scene();
    const rotated = window.innerHeight > window.innerWidth;
    const th = sc.handTilePixelHeight();
    const flat = document.body.classList.contains('flat');
    const beforeLen = game.discardLog.length;
    const selIndex = dbg.selInfo ? dbg.selInfo().selIndex : -1;

    // rendered order for 天津 (wilds first) to find a non-wild index
    let wildCount = 0;
    if (game.isWild) wildCount = game.hands[0].filter((id) => game.isWild(id)).length;

    let cx, cy, pickIdx;
    if (flat) {
      const tiles = [...document.querySelector('.b2-hand').children];
      let i = 0;
      if (which === 'notSelected') i = tiles.findIndex((t) => +t.dataset.pick !== selIndex);
      else if (which === 'nonWild') i = tiles.findIndex((t) => +t.dataset.pick >= wildCount);
      if (i < 0) i = 0;
      const r = tiles[i].getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2; pickIdx = +tiles[i].dataset.pick;
    } else {
      // 3D: pick a settled hand mesh, project to its on-screen pixel (mirrors orient test)
      let rec = null;
      for (const [k, r] of sc.tiles) {
        if (!k.startsWith('h') || r.mesh.userData.pick == null) continue;
        const pk = r.mesh.userData.pick;
        if (which === 'notSelected' && pk === selIndex) continue;
        if (which === 'nonWild' && pk < wildCount) continue;
        rec = r; break;
      }
      if (!rec) return { error: 'no eligible hand tile' };
      pickIdx = rec.mesh.userData.pick;
      const p = rec.mesh.position.clone().project(sc.camera);
      const cv = sc.canvas;
      const clx = (p.x * 0.5 + 0.5) * cv.clientWidth;
      const cly = (-p.y * 0.5 + 0.5) * cv.clientHeight;
      const headerH = document.querySelector('header').offsetHeight;
      if (rotated) { cx = window.innerWidth - (headerH + cly); cy = clx; }
      else { cx = clx; cy = headerH + cly; }
    }
    // slide "up" (toward the table centre): -Δy normally, +Δx when force-rotated 90°.
    const dist = mult * th;
    const ex = rotated ? cx + dist : cx;
    const ey = rotated ? cy : cy - dist;
    return { cx, cy, ex, ey, th, beforeLen, pickIdx, rotated, flat };
  }, dbgName, which, mult);
}

// Dispatch a touch-pointer slide (pointerType 'touch' so the mouse-only hover
// handler ignores it — matching a real finger drag, the feature's actual target).
async function doSlide(page, plan) {
  await page.evaluate((p) => {
    const sc = document.getElementById('scene');
    const mk = (type, x, y, target) => target.dispatchEvent(new PointerEvent(type,
      { pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true, pointerId: 1 }));
    mk('pointerdown', p.cx, p.cy, sc);
    mk('pointermove', (p.cx + p.ex) / 2, (p.cy + p.ey) / 2, window);
    mk('pointermove', p.ex, p.ey, window);
    mk('pointerup', p.ex, p.ey, window);
  }, plan);
}

async function reachHumanTurn(page, url, dbgName, vp) {
  await page.setViewport(vp);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction((n) => window[n] && window[n].humanTurn && window[n].scene(), { timeout: 8000 }, dbgName);
  // wait for the human's turn AND the drawn-tile reveal to settle (discard — tap or
  // slide — is intentionally blocked while the tile is still flying in).
  await page.waitForFunction((n) => window[n].humanTurn() && !window[n].scene().handDrawRevealing, { timeout: 15000 }, dbgName);
  await sleep(150);
}

// A positive case: slide up ~2.5 tiles must DISCARD the tile (discardLog grows).
async function expectPlay(label, url, dbgName, which, vp) {
  const page = await browser.newPage();
  try {
    await reachHumanTurn(page, url, dbgName, vp);
    const plan = await planSlide(page, dbgName, which, 2.5);
    assert(!plan.error, `${label}: ${plan.error}`);
    await doSlide(page, plan);
    await page.waitForFunction((n, b) => window[n].game().discardLog.length > b, { timeout: 4000 }, dbgName, plan.beforeLen);
    console.log(`OK ${label} (rotated=${plan.rotated}, flat=${plan.flat}, th≈${Math.round(plan.th)}px): slide up played tile #${plan.pickIdx}`);
  } finally { await page.close(); }
}

async function ptr(page, type, x, y, onWindow) {
  await page.evaluate((type, x, y, onWindow) => {
    const t = onWindow ? window : document.getElementById('scene');
    t.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: true, pointerId: 1 }));
  }, type, x, y, onWindow);
}

// How far the dragged tile is currently lifted from its resting slot: world-Y units in
// 3D, screen px (from the inline translateY) in flat 2D. ~0 means at rest.
async function liftOf(page, dbgName, pickIdx) {
  return page.evaluate((dbgName, pickIdx) => {
    if (document.body.classList.contains('flat')) {
      const el = [...document.querySelector('.b2-hand').children].find((t) => +t.dataset.pick === pickIdx);
      const m = el && /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(el.style.transform || '');
      return m ? -parseFloat(m[1]) : 0;
    }
    const sc = window[dbgName].scene();
    for (const [k, r] of sc.tiles) if (k[0] === 'h' && r.mesh.userData.pick === pickIdx) return r.mesh.position.y - r.tp.y;
    return 0;
  }, dbgName, pickIdx);
}

// Negative + animation case: dragging partway up (~1.2 tiles) must LIFT the tile to track
// the finger; releasing below the 2-tile threshold must snap it back and NOT discard.
async function expectLiftAndSnap(label, url, dbgName, vp) {
  const page = await browser.newPage();
  try {
    await reachHumanTurn(page, url, dbgName, vp);
    const plan = await planSlide(page, dbgName, 'notSelected', 1.2);
    assert(!plan.error, `${label}: ${plan.error}`);
    await ptr(page, 'pointerdown', plan.cx, plan.cy, false);
    await ptr(page, 'pointermove', plan.ex, plan.ey, true);
    await sleep(60); // let a render frame apply the lift (3D)
    const lift = await liftOf(page, dbgName, plan.pickIdx);
    assert(lift > (plan.flat ? 8 : 0.08), `${label}: tile did not lift to follow the finger (lift=${lift})`);
    await ptr(page, 'pointerup', plan.ex, plan.ey, true);
    await sleep(400); // snap-back (CSS ease / lerp)
    const back = await liftOf(page, dbgName, plan.pickIdx);
    const after = await page.evaluate((n) => ({ len: window[n].game().discardLog.length, human: window[n].humanTurn() }), dbgName);
    assert(after.len === plan.beforeLen, `${label}: short slide discarded (${plan.beforeLen}→${after.len})`);
    assert(after.human, `${label}: short slide ended the human's turn`);
    assert(back < (plan.flat ? 4 : 0.05), `${label}: tile did not snap back after release (lift=${back})`);
    console.log(`OK ${label}: drag lifts tile (${plan.flat ? Math.round(lift) + 'px' : lift.toFixed(2) + 'u'}), short release snaps back, no discard`);
  } finally { await page.close(); }
}

try {
  const GB = `http://localhost:${PORT}/games/guobiao/?fast=1`;
  const TJ = `http://localhost:${PORT}/games/mahjong-tianjin/?fast=1`;
  const LAND = { width: 1024, height: 720 }, PORT_VP = { width: 560, height: 960 };

  // 国标 3D landscape — positive + lift/snap-back negative
  await expectPlay('国标 3D landscape', GB, '__gb', 'any', LAND);
  await expectLiftAndSnap('国标 3D landscape', GB, '__gb', LAND);

  // 国标 3D portrait (force-rotated 90°) — "up" becomes +clientX
  await expectPlay('国标 3D portrait(rotated)', GB, '__gb', 'any', PORT_VP);

  // 国标 flat 2D (scene2d.js) landscape — positive + lift/snap-back
  await expectPlay('国标 flat 2D', GB + '&flat=1', '__gb', 'any', LAND);
  await expectLiftAndSnap('国标 flat 2D', GB + '&flat=1', '__gb', LAND);

  // 天津 3D — slide a NON-混儿 tile (混儿 can't be discarded)
  await expectPlay('天津 3D landscape', TJ, '__mj', 'nonWild', LAND);

  console.log('MAHJONG SLIDE-PLAY TEST PASS');
} catch (e) {
  console.error('MAHJONG SLIDE-PLAY TEST FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
