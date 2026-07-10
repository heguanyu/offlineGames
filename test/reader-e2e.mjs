// 电子书阅读 (reader/) — end-to-end: import an EPUB from "disk", open it, flip pages
// (tap zones), cross a chapter boundary, jump via the TOC, then reload the page and
// assert the last-read spot is restored from IndexedDB. Finally delete the book.
// Usage: node test/reader-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchBrowser, ROOT } from './harness.mjs';
import { makeEpub } from './reader-fixture.mjs';

const PORT = 8181;
const URL0 = `http://localhost:${PORT}/reader/`;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'reader-sample.epub');

let failed = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`); if (!cond) failed++; };
const pos = (page) => page.evaluate(() => window.__reader.pos);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
fs.writeFileSync(FIXTURE, makeEpub());

const server = await startServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 768 });
  page.on('dialog', (d) => d.accept());
  await page.goto(URL0, { waitUntil: 'networkidle0' });

  // ---- empty shelf, then import ----
  ok(await page.$eval('#empty', (el) => !el.hidden), 'empty-shelf notice shows before import');
  const input = await page.$('#file-input');
  await input.uploadFile(FIXTURE);
  await page.waitForSelector('.book', { timeout: 10000 });
  const card = await page.$eval('.book', (el) => ({
    title: el.querySelector('.btitle').textContent,
    meta: el.querySelector('.bmeta').textContent,
    hasCover: !!el.querySelector('.cover img'),
  }));
  ok(card.title === '测试之书', `book title from OPF (got "${card.title}")`);
  ok(card.meta.includes('测试作者'), 'author shown on the card');
  ok(card.meta.includes('未读'), 'fresh book is 未读');
  ok(card.hasCover, 'cover image extracted');

  // ---- open: chapter 1 paginates into multiple pages ----
  await page.click('.book');
  await page.waitForFunction(() => window.__reader.pos && window.__reader.pos.pageCount > 1);
  let p = await pos(page);
  ok(p.chapter === 0 && p.page === 0, `opens at chapter 0 page 0 (got ${p.chapter}/${p.page})`);
  ok(p.pageCount > 3, `long chapter spans pages (pageCount=${p.pageCount})`);

  // ---- tap zones: right = forward, left = back ----
  await page.mouse.click(950, 400);
  await sleep(400);
  p = await pos(page);
  ok(p.page === 1, `right tap flips forward (page=${p.page})`);
  await page.mouse.click(60, 400);
  await sleep(400);
  p = await pos(page);
  ok(p.page === 0, `left tap flips back (page=${p.page})`);

  // ---- swipe (drag) flips forward like iOS Books ----
  await page.mouse.move(800, 400);
  await page.mouse.down();
  for (let x = 800; x >= 500; x -= 60) { await page.mouse.move(x, 400); await sleep(16); }
  await page.mouse.up();
  await sleep(400);
  p = await pos(page);
  ok(p.page === 1, `swipe left flips forward (page=${p.page})`);

  // ---- keep tapping forward: crossing the chapter edge loads chapter 1 ----
  for (let i = 0; i < 40; i++) {
    p = await pos(page);
    if (p.chapter === 1) break;
    await page.mouse.click(950, 400);
    await sleep(350);
  }
  p = await pos(page);
  ok(p.chapter === 1 && p.page === 0, `flipping past the last page enters chapter 1 (got ${p.chapter}/${p.page})`);
  // flipping BACK across the edge lands on the previous chapter's LAST page
  await page.mouse.click(60, 400);
  await sleep(450);
  p = await pos(page);
  ok(p.chapter === 0 && p.page === p.pageCount - 1, `back across the edge lands on last page (got ${p.chapter}/${p.page + 1}/${p.pageCount})`);

  // ---- the in-chapter image resolved to a blob: URL ----
  await page.mouse.click(950, 400);
  await sleep(450);
  const imgSrc = await page.$eval('#flow img', (im) => im.src).catch(() => '');
  ok(imgSrc.startsWith('blob:'), `chapter image is a blob URL (got "${imgSrc.slice(0, 24)}…")`);

  // ---- HUD + TOC: jump to chapter 3 ----
  await page.mouse.click(512, 400); // center tap opens the HUD
  ok(await page.$eval('#reader', (el) => el.classList.contains('hud-open')), 'center tap opens the HUD');
  await sleep(350); // let the HUD bars finish sliding in before clicking them
  await page.click('#btn-toc');
  await page.waitForSelector('.toc-item');
  const tocLabels = await page.$$eval('.toc-item', (els) => els.map((e) => e.textContent));
  ok(tocLabels.length === 3 && tocLabels[2].includes('第三章'), `NCX TOC parsed (${tocLabels.join(' | ')})`);
  await (await page.$$('.toc-item'))[2].click();
  await sleep(400);
  p = await pos(page);
  ok(p.chapter === 2, `TOC jump reaches chapter 2 (got ${p.chapter})`);

  // ---- reload: the last-read spot is restored from IndexedDB ----
  await sleep(500); // let the debounced progress write land
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.book');
  const pct = await page.$eval('.book .bpct', (el) => el.textContent);
  ok(/已读 \d+%/.test(pct), `shelf shows progress (${pct})`);
  await page.click('.book');
  await page.waitForFunction(() => window.__reader.pos);
  p = await pos(page);
  ok(p.chapter === 2, `reopening restores the last-read chapter (got ${p.chapter})`);

  // ---- font size buttons re-paginate but keep the spot sane ----
  await page.mouse.click(512, 400);
  await sleep(350);
  await page.click('#btn-font-inc');
  await sleep(200);
  const font = await page.evaluate(() => getComputedStyle(document.getElementById('flow')).fontSize);
  ok(parseInt(font, 10) === 21, `A＋ bumps the reading font (got ${font})`);

  // ---- delete from the shelf ----
  await page.click('#btn-shelf');
  await page.waitForSelector('.book .del');
  await sleep(400); // closeBook re-renders the shelf — let the fresh cards land
  await page.click('.book .del'); // confirm() auto-accepted by the dialog handler
  await page.waitForFunction(() => document.getElementById('empty').hidden === false);
  ok(true, 'delete empties the shelf');

  // book really gone from IndexedDB (not just the DOM)
  const count = await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.open('epub-reader');
    req.onsuccess = () => {
      const t = req.result.transaction('books').objectStore('books').count();
      t.onsuccess = () => res(t.result);
    };
  }));
  ok(count === 0, `books store empty after delete (count=${count})`);
} finally {
  await browser.close();
  server.close();
  fs.rmSync(FIXTURE, { force: true });
}
console.log(failed ? `reader-e2e: ${failed} FAILURE(S)` : 'reader-e2e: all ok');
process.exit(failed ? 1 : 0);
