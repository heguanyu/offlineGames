// E2E: the per-ROM ⋯ menu overlay (GBA + NDS library pages) must be HIDDEN at page load and
// only appear when the ⋯ button is tapped — regression guard for the bug where the id-selector
// `#menu-overlay { display:flex }` overrode the UA `[hidden]{display:none}` rule, leaving the menu
// backdrop covering the ROM list on every load (and making Cancel appear to do nothing, since the
// overlay stayed visible regardless of the hidden attribute).
//
// Usage: node test/emu-menu-test.mjs            (runs gba + nds)
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8131;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (label, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) fails.push(label); };

async function overlayState(page) {
  return page.evaluate(() => {
    const o = document.getElementById('menu-overlay');
    const r = o.getBoundingClientRect();
    return { hidden: o.hasAttribute('hidden'), display: getComputedStyle(o).display, area: Math.round(r.width * r.height) };
  });
}

async function testSystem(browser, system) {
  console.log(`\n[${system}]`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  // Neutralize the service worker for this test: the NDS page registers one (for cross-origin
  // isolation) and both emulator pages now reload on a new SW taking control — either would reload the
  // page mid-test. (Aborting the /sw.js request doesn't help: the SW thread's fetch bypasses page
  // request interception.) Stub register/getRegistration so no SW ever controls the page here.
  await page.evaluateOnNewDocument(() => {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.reject(new Error('test-blocked'));
        navigator.serviceWorker.getRegistration = () => Promise.resolve(undefined);
      }
    } catch {}
  });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  await page.goto(`http://localhost:${PORT}/games/${system}/`, { waitUntil: 'load' });
  await page.waitForFunction('typeof openDB === "function" && typeof refreshList === "function"', { timeout: 10000 });

  // 1) At page load (with a ROM present so the ⋯ button exists) the overlay must be hidden.
  await page.evaluate(async () => {
    const db = await openDB();
    await tx(db, 'readwrite', (s) => s.put({ name: 'TEST.gba', data: new Blob([new Uint8Array(1024)]) }));
    await refreshList();
  });
  await sleep(200);
  const atLoad = await overlayState(page);
  check('overlay hidden at page load (display:none)', atLoad.display === 'none' && atLoad.area === 0);

  // 2) Tapping ⋯ opens it. (Dispatch via the real element's click handler — robust against
  //     puppeteer's hit-testing, while still exercising the actual onclick → openRomMenu path.)
  await page.evaluate(() => document.querySelector('.rom .menu').click());
  await sleep(150);
  const opened = await overlayState(page);
  check('⋯ opens the menu (display:flex, hidden attr removed)', opened.display === 'flex' && !opened.hidden);

  // 3) Cancel closes it.
  await page.evaluate(() => document.querySelector('#menu-panel button[data-act="cancel"]').click());
  await sleep(150);
  const afterCancel = await overlayState(page);
  check('Cancel closes the menu (display:none)', afterCancel.display === 'none' && afterCancel.area === 0);

  // 4) Re-open, then tapping the backdrop (the overlay itself, not the panel) closes it.
  await page.evaluate(() => document.querySelector('.rom .menu').click());
  await sleep(150);
  await page.mouse.click(20, 20); // backdrop corner, away from the panel
  await sleep(150);
  const afterBackdrop = await overlayState(page);
  check('backdrop tap closes the menu (display:none)', afterBackdrop.display === 'none' && afterBackdrop.area === 0);

  await page.close();
}

const server = await startServer(PORT);
const browser = await launchBrowser();
try {
  await testSystem(browser, 'gba');
  await testSystem(browser, 'nds');
} finally {
  await browser.close();
  server.close();
}

if (fails.length) { console.log(`\nFAILED (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
console.log('\nemu-menu E2E PASS');
