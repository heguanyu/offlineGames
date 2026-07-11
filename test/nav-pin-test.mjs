// app-nav.js history PIN — the installed-PWA edge-swipe guard. Verifies both halves:
//   1) In a standalone PWA (emulated via navigator.standalone), a back-swipe (history.back) is
//      trapped — the popstate handler re-pushes, so you never leave the current page.
//   2) In a normal browser tab (not standalone), the pin is NOT installed, so Back still works.
// The gesture itself can't be scripted, but it's just a history traversal, so history.back() exercises
// the exact code path the swipe triggers.
// Usage: node test/nav-pin-test.mjs
import { startServer, launchBrowser } from './harness.mjs';

const PORT = 8189;
const server = await startServer(PORT);
const browser = await launchBrowser();
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok' : 'FAIL'}: ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a 2-page history (hub → reader) then attempt a back navigation; return where we ended up.
// Uses the reader as the destination — a generic page that relies on app-nav's blanket pin (the NGA
// reader is NOT used here: it owns its history via window.__ownsHistory, covered by nga-test).
async function backFrom(page) {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.goto(`http://localhost:${PORT}/reader/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('library'), { timeout: 10000 });
  await page.evaluate(() => history.back());
  await sleep(600);
  return { url: page.url(), onReader: (await page.$('#library')) != null };
}

try {
  // 1) standalone PWA → trapped
  const pwa = await browser.newPage();
  await pwa.evaluateOnNewDocument(() => {
    try { Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true }); } catch (e) {}
  });
  const r1 = await backFrom(pwa);
  ok(r1.url.endsWith('/reader/') && r1.onReader, `standalone PWA: edge-swipe back is trapped (stayed at ${r1.url})`);

  // 2) normal browser tab → Back still navigates
  const tab = await browser.newPage();
  const r2 = await backFrom(tab);
  ok(!r2.onReader, `normal browser tab: Back still works (left the reader → ${r2.url})`);
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\nnav-pin-test FAILED (${failed})` : '\nnav-pin-test: all passed');
process.exit(failed ? 1 : 0);
