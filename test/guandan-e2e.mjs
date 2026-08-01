// Browser smoke test for 掼蛋: loads the page, starts a match, auto-plays the human seat until a
// round resolves — asserting no console/page errors. Catches runtime breakage in scene.js/main.js
// that the Node engine/ai/backend tests cannot see.
// Usage: node test/guandan-e2e.mjs
import path from 'node:path';
import { startServer, launchBrowser, ROOT as root } from './harness.mjs';

const PORT = 8147;
const server = await startServer(PORT);
const browser = await launchBrowser();
const errors = [];
let shot = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('guandan-mute', '1'); } catch {} });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/games/guandan/?fast=1&d3=1`, { waitUntil: 'networkidle0' });

  await page.waitForSelector('#start-btn');
  await page.click('#start-btn');
  await page.waitForFunction(() => window.__gd && (window.__gd.awaiting() || window.__gd.resultShown()), { timeout: 10000 });
  console.log('match started, scene live');

  // Selecting a card must pulse its gold border smoothly without making the turn ring blink too.
  if (await page.evaluate(() => window.__gd.awaiting())) {
    const point = await page.evaluate(() => {
      const scene = window.__gd.scene();
      const card = [...scene.cards.values()].find((entry) => entry.pick);
      return scene.worldToScreen(card.mesh.position.clone());
    });
    await page.mouse.click(point.x, point.y);
    const samples = await page.evaluate(async () => {
      const scene = window.__gd.scene(); const turn = [], border = [];
      for (let i = 0; i < 7; i++) {
        turn.push(scene.turnRing.material.opacity);
        const selected = [...scene.cards.values()].find((entry) => entry.mesh.userData.selectionBorder?.visible);
        border.push(selected?.mesh.userData.selectionBorder.material.opacity ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 70));
      }
      return { turn, border };
    });
    const spread = (values) => Math.max(...values) - Math.min(...values);
    if (spread(samples.turn) > 0.001) throw new Error('turn indicator blinked with selected card');
    if (spread(samples.border) < 0.08) throw new Error('selected-card border did not animate smoothly');

    // An unbeatable lead should explain the forced pass and visually recommend 不要.
    const forcedPass = await page.evaluate(() => {
      const round = window.__gd.state().round;
      const saved = { lead: round.lead, leadSeat: round.leadSeat };
      round.lead = { type: 'jokerbomb', n: 4, bomb: true, bombScore: 9999, key: 9999 };
      round.leadSeat = 1;
      window.__gd.render();
      const result = {
        recommended: document.querySelector('#pass-btn').classList.contains('recommended'),
        note: document.querySelector('#action-hint').textContent,
        hintDisabled: document.querySelector('#hint-btn').disabled,
      };
      round.lead = saved.lead; round.leadSeat = saved.leadSeat; window.__gd.render();
      return result;
    });
    if (!forcedPass.recommended || forcedPass.note !== '无牌可压，只能不要' || !forcedPass.hintDisabled) {
      throw new Error('forced-pass recommendation missing: ' + JSON.stringify(forcedPass));
    }
  }

  const deadline = Date.now() + 90000;
  let resolved = 0;
  while (Date.now() < deadline && resolved < 2) {
    const phase = await page.evaluate(() => {
      if (window.__gd.resultShown()) return 'result';
      return window.__gd.step();
    });
    if (phase === 'result') {
      resolved++;
      const title = await page.$eval('#result-title', (e) => e.textContent);
      console.log('round resolved:', title);
      if (!shot) { await page.screenshot({ path: path.join(root, 'test', 'guandan-shot.png') }); shot = true; }
      await page.click('#next-btn');
      if (resolved < 2) await page.waitForFunction(() => window.__gd && (window.__gd.awaiting() || window.__gd.resultShown()), { timeout: 10000 });
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (resolved === 0) throw new Error('no round resolved within the deadline');
  console.log(`resolved ${resolved} round(s)`);
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('\nguandan e2e PASS');
