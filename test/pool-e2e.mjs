// Browser smoke test for 台球 (黑八 + 斯诺克): boots each game in 3D (iPad-class viewport)
// and flat 2D (?flat), places the cue ball, fires a shot, and screenshots — failing on any
// page error. Usage: node test/pool-e2e.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8137;
const server = await startServer(PORT);
const browser = await launchBrowser();

let failed = 0;
const CASES = [
  { name: 'pool8-3d', url: `/games/pool8/?d3`, vp: { width: 1180, height: 820 } },
  { name: 'pool8-flat', url: `/games/pool8/?flat`, vp: { width: 844, height: 390 } },
  { name: 'snooker-3d', url: `/games/snooker/?d3`, vp: { width: 1180, height: 820 } },
  { name: 'snooker-flat', url: `/games/snooker/?flat`, vp: { width: 390, height: 844 } }, // portrait phone → rotated table
];

for (const c of CASES) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('pool-mute', '1'); } catch {} });
  await page.setViewport(c.vp);
  await page.goto(`http://localhost:${PORT}${c.url}`, { waitUntil: 'networkidle0' });

  try {
    await page.waitForSelector('#start-btn', { visible: true, timeout: 10000 });
    await page.click('#start-btn');
    // both games begin with cue-ball placement (kitchen / D)
    await page.waitForSelector('#place-done', { visible: true, timeout: 10000 });
    await page.click('#place-done');
    await page.waitForSelector('#controls', { visible: true, timeout: 10000 });
    await page.evaluate(() => { const p = document.getElementById('power'); p.value = 85; p.dispatchEvent(new Event('input')); });
    await new Promise((r) => setTimeout(r, 600));       // let the aim line render
    await page.screenshot({ path: `test/${c.name}-aim.png` });
    await page.click('#shoot-btn');
    await new Promise((r) => setTimeout(r, 5000));      // break rolls out (incl. AI reply starting)
    await page.screenshot({ path: `test/${c.name}-after.png` });

    // sanity: the canvas actually drew something non-background. 2D-canvas only —
    // a WebGL canvas reads back blank without preserveDrawingBuffer (the 3D cases
    // are covered by their screenshots instead).
    const painted = c.url.includes('flat') ? await page.evaluate(() => {
      const cv = document.getElementById('scene');
      const test = document.createElement('canvas');
      test.width = 64; test.height = 64;
      const x = test.getContext('2d');
      x.drawImage(cv, 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data;
      const first = [d[0], d[1], d[2]];
      for (let i = 4; i < d.length; i += 4) {
        if (Math.abs(d[i] - first[0]) + Math.abs(d[i + 1] - first[1]) + Math.abs(d[i + 2] - first[2]) > 24) return true;
      }
      return false;
    }) : true;
    if (!painted) { errors.push('canvas appears blank'); }
  } catch (e) {
    errors.push(String(e));
  }

  if (errors.length) {
    failed++;
    console.error(`✗ ${c.name}:`);
    for (const e of errors) console.error('   ', e);
  } else {
    console.log(`✓ ${c.name}`);
  }
  await page.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} case(s) FAILED` : '\nall pool e2e cases passed');
process.exit(failed ? 1 : 0);
