// demo-scenarios.mjs — one entry per recordable demo.
//
// Each scenario is { title, seconds, setup(page, port), play(page, keepGoing) }.
//   setup      navigate and get to the first filmable frame; recording starts after it returns
//   play       drive the game until keepGoing() goes false; every repaint is a frame
//
// Driving is deliberately done through the pages' own test hooks (window.__mj and
// friends) and real clicks, not by faking state — the recording should show the
// actual game, and if a hook disappears the demo fails loudly rather than filming
// a broken table.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click the first action button whose label starts with one of `labels`. */
async function clickAction(page, labels) {
  return page.evaluate((wanted) => {
    const btns = [...document.querySelectorAll('#action-bar .act-btn')];
    for (const w of wanted) {
      const b = btns.find((x) => x.textContent.trim().startsWith(w));
      if (b) { b.click(); return w; }
    }
    return null;
  }, labels);
}

export const SCENARIOS = {
  // ------------------------------------------------------------- mahjong --
  // NOTE: the games have no i18n — every page is lang="zh" with hardcoded Chinese
  // UI, so there is no English build to record. Titles here are English for the
  // operator's benefit; the footage itself is necessarily Chinese.
  mahjong: {
    title: 'Tianjin Mahjong — 3D table, three AI bots',
    seconds: 26,
    async setup(page, port) {
      // ?fast=1 is REQUIRED, not just convenient: window.__mj — the hook this
      // scenario drives the human seat with — is only defined under that flag
      // (games/mahjong-tianjin/main.js). Without it the bots play, the human
      // never discards, the table goes still, and the screencast records a
      // frozen scene. The shorter AI delay it also brings is a bonus here:
      // more happens per second of video.
      await page.goto(`http://localhost:${port}/games/mahjong-tianjin/?fast=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#start-btn');
      await page.click('#start-btn');
      await sleep(1200);                       // deal animation settles into a table
    },
    async play(page, keepGoing) {
      while (keepGoing()) {
        const state = await page.evaluate(() => {
          const hidden = (id) => document.getElementById(id)?.classList.contains('hidden') ?? true;
          if (!hidden('result-overlay')) return 'result';
          return window.__mj && window.__mj.humanTurn() ? 'human' : 'wait';
        });

        if (state === 'result') {
          await sleep(2500);                   // hold on the win modal — it is worth seeing
          await page.evaluate(() => document.getElementById('next-hand-btn')?.click());
          await sleep(900);
          continue;
        }
        // Claiming makes a meld appear flat on the table, which reads well on video.
        if (await clickAction(page, ['碰', '杠'])) { await sleep(700); continue; }
        if (state === 'human') {
          // Move the cursor before discarding so the lift + glow is visible.
          for (let i = 0; i < 3 && keepGoing(); i++) { await page.keyboard.press('ArrowRight'); await sleep(220); }
          await sleep(350);
          await page.evaluate(() => window.__mj.discard());
          await sleep(500);
          continue;
        }
        await clickAction(page, ['过']);
        await sleep(220);
      }
    },
  },

  // ------------------------------------------------------------ doudizhu --
  doudizhu: {
    title: 'Dou Dizhu — bidding and play vs bots',
    seconds: 22,
    async setup(page, port) {
      // ?fast=1 again: window.__dou (awaiting / step / resultShown) only exists
      // under it, and it is the only way to advance the human seat.
      await page.goto(`http://localhost:${port}/games/doudizhu/?fast=1`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#start-btn');
      await page.click('#start-btn');
      await page.waitForFunction(
        () => window.__dou && (window.__dou.awaiting() || window.__dou.resultShown()),
        { timeout: 15000 },
      );
      await sleep(600);
    },
    async play(page, keepGoing) {
      while (keepGoing()) {
        const phase = await page.evaluate(() => {
          if (!window.__dou) return 'gone';
          if (window.__dou.resultShown()) return 'result';
          return window.__dou.step();
        });
        if (phase === 'gone') return;
        if (phase === 'result') {
          await sleep(2200);                   // let the result card be readable
          await page.evaluate(() => document.getElementById('next-btn')?.click());
          await sleep(900);
          continue;
        }
        await sleep(320);                      // slower than the test: this is for watching
      }
    },
  },

  // --------------------------------------------------------------- pool8 --
  pool8: {
    title: 'Eight-ball — cue physics',
    seconds: 22,
    async setup(page, port) {
      await page.goto(`http://localhost:${port}/games/pool8/`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#start-btn', { visible: true, timeout: 15000 });
      await page.click('#start-btn');
      // Both billiards games open with cue-ball placement in the kitchen.
      await page.waitForSelector('#place-done', { visible: true, timeout: 15000 });
      await page.click('#place-done');
      await page.waitForSelector('#controls', { visible: true, timeout: 15000 });
      await sleep(500);
    },
    async play(page, keepGoing) {
      // Slingshot: press on the cue ball, pull back in steps so the aim line and
      // power draw are on camera, then release and let the table settle.
      while (keepGoing()) {
        const from = [640, 470];
        const to = [700 + Math.round(Math.random() * 90), 560 + Math.round(Math.random() * 40)];
        await page.mouse.move(from[0], from[1]);
        await page.mouse.down();
        for (let i = 1; i <= 8 && keepGoing(); i++) {
          await page.mouse.move(from[0] + (to[0] - from[0]) * i / 8, from[1] + (to[1] - from[1]) * i / 8);
          await sleep(60);
        }
        await sleep(500);                      // hold at full draw
        await page.mouse.up();
        await sleep(5200);                     // break rolls out, then the AI replies
      }
    },
  },
};
