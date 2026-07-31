// demo-scenarios.mjs — one entry per recordable demo.
//
// A scenario is { title, seconds, clients?, backend?, setup(ctx), play(ctx, keepGoing) }
//   ctx        { pages, page, sitePort, backendPort }  — `page` is pages[0]
//   setup      navigate and reach the first filmable frame; recording starts after it returns
//   play       drive until keepGoing() goes false; every repaint becomes a frame
//   clients    how many independent browser pages to open (default 1). >1 is tiled into a grid.
//   backend    spawn server/index.js for the multiplayer lobby (default false)
//
// Driving goes through the pages' own test hooks (window.__mj / __gb / __dou / __gd)
// and real clicks, never by faking state: the recording should show the actual game,
// and if a hook disappears the run fails loudly instead of filming a broken table.
//
// NOTE: the games have no i18n — every page is lang="zh" with hardcoded Chinese
// strings — so there is no English build to record. Titles here are English for
// the operator; the footage is necessarily Chinese.
//
// ⚠ Every scenario passes ?fast=1. The window.__* hooks only exist under that flag,
// and without them the bots play on while the human seat never acts: the table goes
// still and you record a frozen scene.

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

/**
 * Tile games (Tianjin mahjong, MCR) share a shape: a `humanTurn()/discard()` hook,
 * an #action-bar of claims, and a #result-overlay with #next-hand-btn.
 */
function mahjongLike({ hook, url, claims = ['碰', '杠', '吃'] }) {
  return {
    async setup({ page, sitePort }) {
      await page.goto(`http://localhost:${sitePort}${url}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#start-btn');
      await page.click('#start-btn');
      await sleep(1200);                                  // deal animation settles
    },
    async play({ page }, keepGoing) {
      while (keepGoing()) {
        const state = await page.evaluate((h) => {
          const hidden = (id) => document.getElementById(id)?.classList.contains('hidden') ?? true;
          if (!hidden('result-overlay')) return 'result';
          const hu = [...document.querySelectorAll('#ting-center .act-btn')].find((b) => b.textContent.includes('胡'));
          if (hu) { hu.click(); return 'win'; }
          return window[h] && window[h].humanTurn() ? 'human' : 'wait';
        }, hook);

        if (state === 'result') {
          await sleep(2600);                              // hold on the win modal
          await page.evaluate(() => document.getElementById('next-hand-btn')?.click());
          await sleep(900);
          continue;
        }
        if (state === 'win') { await sleep(600); continue; }
        // Claiming lays a meld flat on the table, which reads well on video.
        if (await clickAction(page, claims)) { await sleep(700); continue; }
        if (state === 'human') {
          for (let i = 0; i < 3 && keepGoing(); i++) { await page.keyboard.press('ArrowRight'); await sleep(220); }
          await sleep(320);
          await page.evaluate((h) => window[h].discard(), hook);
          await sleep(480);
          continue;
        }
        await clickAction(page, ['过']);
        await sleep(200);
      }
    },
  };
}

/** Card games (Dou Dizhu, Guandan) expose awaiting()/step()/resultShown(). */
function cardLike({ hook, url }) {
  return {
    async setup({ page, sitePort }) {
      await page.goto(`http://localhost:${sitePort}${url}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#start-btn');
      await page.click('#start-btn');
      await page.waitForFunction(
        (h) => window[h] && (window[h].awaiting() || window[h].resultShown()),
        { timeout: 20000 }, hook,
      );
      await sleep(600);
    },
    async play({ page }, keepGoing) {
      while (keepGoing()) {
        const phase = await page.evaluate((h) => {
          if (!window[h]) return 'gone';
          if (window[h].resultShown()) return 'result';
          return window[h].step();
        }, hook);
        if (phase === 'gone') return;
        if (phase === 'result') {
          await sleep(2200);
          await page.evaluate(() => document.getElementById('next-btn')?.click());
          await sleep(900);
          continue;
        }
        await sleep(320);                                 // slower than the test: this is for watching
      }
    },
  };
}

/** Billiards: place the cue ball, then slingshot-aim and fire, repeatedly. */
function cueLike({ url }) {
  return {
    async setup({ page, sitePort }) {
      await page.goto(`http://localhost:${sitePort}${url}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#start-btn', { visible: true, timeout: 20000 });
      await page.click('#start-btn');
      await page.waitForSelector('#place-done', { visible: true, timeout: 20000 });
      await page.click('#place-done');
      await page.waitForSelector('#controls', { visible: true, timeout: 20000 });
      await sleep(500);
    },
    async play({ page }, keepGoing) {
      while (keepGoing()) {
        const from = [640, 470];
        const to = [690 + Math.round(Math.random() * 110), 550 + Math.round(Math.random() * 50)];
        await page.mouse.move(from[0], from[1]);
        await page.mouse.down();
        for (let i = 1; i <= 8 && keepGoing(); i++) {
          await page.mouse.move(from[0] + (to[0] - from[0]) * i / 8, from[1] + (to[1] - from[1]) * i / 8);
          await sleep(60);
        }
        await sleep(500);                                 // hold at full draw, cue line showing
        await page.mouse.up();
        await sleep(5200);                                // the break rolls out, then the AI replies
      }
    },
  };
}

// Four seats, four independent browsers. Real display names, because they appear
// on screen in the lobby and on every nameplate at the table — "player1" would
// undercut the whole point of the clip.
// Kept short and Latin: the nameplate truncates at roughly eight characters
// ("关羽 Guanyu" rendered as "关羽Gua…"), and player names are the one piece of
// on-screen text this recording actually controls, so they may as well be legible
// to an English-reading viewer of an otherwise Chinese UI.
const SEATS = [
  { name: 'Guanyu', uid: 'demo-guanyu' },
  { name: 'Lin', uid: 'demo-lin' },
  { name: 'Mei', uid: 'demo-mei' },
  { name: 'Kai', uid: 'demo-kai' },
];

export const SCENARIOS = {
  mahjong: {
    title: 'Tianjin Mahjong — 3D table, three AI bots',
    seconds: 26,
    ...mahjongLike({ hook: '__mj', url: '/games/mahjong-tianjin/?fast=1', claims: ['碰', '杠'] }),
  },
  guobiao: {
    title: 'Chinese Official Mahjong (MCR) — chow, pung, kong, 8-fan minimum',
    seconds: 26,
    ...mahjongLike({ hook: '__gb', url: '/games/guobiao/?fast=1' }),
  },
  doudizhu: {
    title: 'Dou Dizhu — bidding, then play against bots',
    seconds: 22,
    ...cardLike({ hook: '__dou', url: '/games/doudizhu/?fast=1' }),
  },
  guandan: {
    title: 'Guandan — four-player partnership card game',
    seconds: 22,
    ...cardLike({ hook: '__gd', url: '/games/guandan/?fast=1' }),
  },
  pool8: {
    title: 'Eight-ball — cue physics',
    seconds: 22,
    ...cueLike({ url: '/games/pool8/' }),
  },
  snooker: {
    title: 'Snooker — full-size table, same physics engine',
    seconds: 22,
    ...cueLike({ url: '/games/snooker/' }),
  },

  // ------------------------------------------------------------- online ---
  online: {
    title: 'Online lobby — four independent browsers at one table',
    seconds: 38,
    clients: 4,
    backend: true,
    async setup({ pages, sitePort, backendPort }) {
      // Each page gets its own identity BEFORE any script runs, so the lobby
      // shows four distinct named players rather than four copies of one.
      for (let i = 0; i < pages.length; i++) {
        const seat = SEATS[i];
        await pages[i].evaluateOnNewDocument((s) => {
          localStorage.setItem('mahjong-online-name', s.name);
          localStorage.setItem('mahjong-online-uid', s.uid);
        }, seat);
        await pages[i].goto(
          `http://localhost:${sitePort}/games/mahjong-common-online/?server=ws://localhost:${backendPort}&fast=1`,
          { waitUntil: 'domcontentloaded' },
        );
        await pages[i].waitForFunction(() => document.getElementById('conn')?.className.includes('on'), { timeout: 15000 });
        await pages[i].waitForSelector('.chair[data-table="0"][data-seat="0"]', { timeout: 15000 });
      }
      // Seat them one at a time so the lobby visibly fills up on camera.
      // NOTE: a DOM .click() rather than page.click() — puppeteer's version does its own
      // viewport hit-testing, which is unreliable (and can hang) on a page that is not the
      // browser's foreground tab, and here three of the four never are.
      for (let i = 0; i < pages.length; i++) {
        await pages[i].evaluate((s) => document.querySelector(`.chair[data-table="0"][data-seat="${s}"]`)?.click(), i);
        await pages[i].waitForFunction(
          (s) => document.querySelector(`.chair[data-table="0"][data-seat="${s}"]`)?.classList.contains('me'),
          { timeout: 10000 }, i,
        );
        await sleep(500);
      }
      await sleep(1200);                                  // hold on the full lobby
    },
    async play({ pages }, keepGoing) {
      // Everyone readies up; the lobby then hands off to the game page itself.
      for (const p of pages) {
        await p.evaluate(() => {
          const b = [...document.querySelectorAll('.btn.ready')].find((x) => x.textContent.includes('准备'));
          if (b) b.click();
        });
        await sleep(250);
      }
      for (const p of pages) {
        await p.waitForFunction(() => location.pathname.includes('/mahjong-tianjin/'), { timeout: 25000 }).catch(() => {});
      }
      await sleep(1500);

      // The server is authoritative: each client just answers for its own seat.
      while (keepGoing()) {
        await Promise.all(pages.map(async (p) => {
          try {
            await p.evaluate(() => {
              const vis = (id) => { const e = document.getElementById(id); return e && !e.classList.contains('hidden'); };
              if (vis('result-overlay')) { document.getElementById('next-hand-btn')?.click(); return; }
              const hu = [...document.querySelectorAll('#ting-center .act-btn')].find((b) => b.textContent.includes('胡'));
              if (hu) { hu.click(); return; }
              const claim = [...document.querySelectorAll('#action-bar .act-btn')]
                .find((b) => /^(碰|杠)/.test(b.textContent.trim()));
              if (claim) { claim.click(); return; }
              const pass = [...document.querySelectorAll('#action-bar .act-btn')].find((b) => b.textContent.includes('过'));
              if (pass) { pass.click(); return; }
              if (window.__mj && window.__mj.humanTurn && window.__mj.humanTurn()) window.__mj.discard();
            });
          } catch { /* a page mid-navigation — next tick */ }
        }));
        await sleep(420);
      }
    },
  },
};
