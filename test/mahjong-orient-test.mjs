// Verifies tile-picking is correct in BOTH landscape and force-rotated portrait.
// For a real hand-tile mesh it projects the tile to where it actually appears on
// screen (using the real CSS layout/rotation), calls scene.pick() there, and
// asserts the picked hand index matches. A wrong rotation formula → wrong tile.
// Usage: node test/mahjong-orient-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8176;
const server = await startServer(PORT);
const browser = await launchBrowser();
function assert(c, m) { if (!c) throw new Error(m); }

// Project a settled hand tile to its on-screen pixel via the real layout +
// (optional) 90° body rotation, click there, and return {expected, picked}.
async function roundTrip(page) {
  return page.evaluate(() => {
    const sc = window.__mj.scene();
    let rec = null;
    for (const [k, r] of sc.tiles) if (k.startsWith('h') && r.mesh.userData.pick != null) { rec = r; break; }
    if (!rec) return { error: 'no pickable hand tile' };
    const expected = rec.mesh.userData.pick;
    const p = rec.mesh.position.clone().project(sc.camera);     // world → NDC
    const cv = sc.canvas;
    const clx = (p.x * 0.5 + 0.5) * cv.clientWidth;             // canvas-local px
    const cly = (-p.y * 0.5 + 0.5) * cv.clientHeight;
    const headerH = document.querySelector('header').offsetHeight;
    const rotated = window.innerHeight > window.innerWidth;
    // canvas-local → viewport, mirroring the CSS in ui-util.forceLandscape
    let clientX, clientY;
    if (rotated) { clientX = window.innerWidth - (headerH + cly); clientY = clx; }
    else { clientX = clx; clientY = headerH + cly; }
    return { expected, picked: sc.pick(clientX, clientY), rotated };
  });
}

try {
  for (const [w, h, label] of [[1024, 720, 'landscape'], [560, 960, 'portrait']]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    await page.goto(`http://localhost:${PORT}/games/mahjong-tianjin/?fast=1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#start-btn');
    await page.click('#start-btn');
    await page.waitForFunction(() => window.__mj && window.__mj.humanTurn && window.__mj.scene(), { timeout: 8000 });
    // let a human turn arrive (so the hand is pickable) and tiles settle
    await page.waitForFunction(() => window.__mj.humanTurn(), { timeout: 12000 });
    await new Promise((r) => setTimeout(r, 700));
    const res = await roundTrip(page);
    assert(!res.error, `${label}: ${res.error}`);
    assert(res.rotated === (h > w), `${label}: rotated flag = ${res.rotated}, expected ${h > w}`);
    assert(res.picked === res.expected, `${label}: clicked tile #${res.expected} but pick() returned #${res.picked}`);
    console.log(`OK ${label} (${w}x${h}, rotated=${res.rotated}): clicking tile #${res.expected} picks #${res.picked}`);
    await page.close();
  }
  console.log('MAHJONG ORIENT TEST PASS');
} catch (e) {
  console.error('MAHJONG ORIENT TEST FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
