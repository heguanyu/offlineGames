// 方舟资讯 (nga/) — deterministic, offline test. Two parts, NO live NGA dependency:
//   1) server/nga.js pure helpers: the fid whitelist + the list/post row normalizer.
//   2) The client's untrusted-content sanitizer (window.__nga.renderContent), driven in a real
//      browser against a batch of XSS / BBCode fixtures — this is the security-critical path
//      (forum markup → HTML), so it's pinned here.
// The page is served by the harness's plain file server (no /api/nga), so the board load just shows
// an error state; renderContent is still exposed and is what we exercise.
// Usage: node test/nga-test.mjs
import { startServer, launchBrowser } from './harness.mjs';
import { rowsOf, ALLOWED_FIDS, BOARDS } from '../server/nga.js';

let failed = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`); if (!cond) failed++; };

// ---- 1) relay pure helpers ----
console.log('relay helpers:');
ok(ALLOWED_FIDS.has('846') && ALLOWED_FIDS.has('-34587507'), 'both 方舟 boards whitelisted');
ok(!ALLOWED_FIDS.has('7') && !ALLOWED_FIDS.has(''), 'other/empty fids rejected');
ok(BOARDS['846'] === '明日方舟：终末地' && BOARDS['-34587507'] === '明日方舟', 'board labels');
ok(rowsOf([{ tid: 1 }, { tid: 2 }, { x: 3 }], 'tid').length === 2, 'rowsOf array: keeps rows with the key');
ok(rowsOf({ 0: { tid: 1 }, 1: { tid: 2 }, __ROWS: 9, meta: {} }, 'tid').length === 2, 'rowsOf object: numeric keys + key present only');
ok(rowsOf(null, 'tid').length === 0 && rowsOf(undefined, 'lou').length === 0, 'rowsOf nullish → []');
ok(rowsOf([{ lou: 0 }, { lou: 1 }], 'lou').length === 2, 'rowsOf keeps lou:0 (楼主, falsy but present)');

// ---- 2) content sanitizer, in-browser ----
const PORT = 8188;
const server = await startServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/nga/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__nga && typeof window.__nga.renderContent === 'function', { timeout: 10000 });

  const render = (raw, prefix) => page.evaluate((r, p) => window.__nga.renderContent(r, p), raw, prefix);
  const PREFIX = 'https://img.nga.178.com/attachments/';
  console.log('sanitizer:');

  const script = await render('<script>alert(1)</script>hi');
  ok(!/<script/i.test(script) && script.includes('&lt;script&gt;'), 'raw <script> is escaped, not live');

  const rawImg = await render('<img src=x onerror=alert(1)>');
  ok(!/<img[^>]*onerror/i.test(rawImg), 'raw <img onerror> cannot inject a live element');

  // Parse the rendered HTML into a real DOM and report an element's live attributes — the true test
  // for injection (a string that merely appears inside a quoted value is inert).
  const domCheck = (raw, sel) => page.evaluate((r, s) => {
    const d = document.createElement('div'); d.innerHTML = window.__nga.renderContent(r);
    const el = d.querySelector(s);
    return el ? { tag: el.tagName, src: el.getAttribute('src') || '', href: el.getAttribute('href') || '', attrs: [...el.attributes].map((a) => a.name) } : null;
  }, raw, sel);

  const jsImgEl = await domCheck('[img]javascript:alert(1)[/img]', 'img');
  ok(!jsImgEl || jsImgEl.src.startsWith('/api/nga/img?u='), 'non-http [img] src can only ever be the same-origin proxy (never a live javascript: src)');

  const goodImg = await render(`[img]${PREFIX}mon_x/y.jpg[/img]`);
  ok(/<img class="nga-img"[^>]*src="\/api\/nga\/img\?u=/.test(goodImg), 'valid [img] routes through the proxy');

  const relImg = await render('[img]./mon_x/y.jpg[/img]', PREFIX);
  ok(relImg.includes(encodeURIComponent(PREFIX + 'mon_x/y.jpg')), 'relative [img] resolves against attachPrefix');

  const jsUrl = await render('[url=javascript:alert(1)]click[/url]');
  ok(!/href/i.test(jsUrl) && jsUrl.includes('click'), 'javascript: [url] drops the href, keeps text');

  const goodUrl = await render('[url=https://example.com/x]hi[/url]');
  ok(/<a href="https:\/\/example\.com\/x"[^>]*target="_blank"/.test(goodUrl), 'valid [url] → safe anchor');

  const injEl = await domCheck('[url=https://e.com" onmouseover="alert(1)]x[/url]', 'a');
  ok(injEl && !injEl.attrs.includes('onmouseover'), 'quote in [url] href cannot break out into an event-handler attribute');

  const quote = await render('[quote]a[quote]b[/quote]c[/quote]');
  ok((quote.match(/<blockquote/g) || []).length === 2 && !/\[quote\]/i.test(quote), 'nested [quote] → nested blockquotes, no leftover tags');

  const emote = await render('happy[s:ac:哭笑]end');
  ok(/<span class="nga-emote">哭笑<\/span>/.test(emote), '[s:...:name] emote → labelled badge');

  const br = await render('line1<br/>line2<br />line3');
  ok((br.match(/<br>/g) || []).length === 2 && !/<br\s*\/>/.test(br), '<br/> variants folded to <br>');

  const styled = await render('[b]B[/b][del]D[/del]');
  ok(styled.includes('<b>B</b>') && styled.includes('<del>D</del>'), 'inline [b]/[del] styling');

  const unknown = await render('[color=red]text[/color][size=5]big[/size]');
  ok(!/\[color|\[size/i.test(unknown) && unknown.includes('text') && unknown.includes('big'), 'unknown tags stripped, inner text kept');

  const amp = await render('a & b < c > d "q"');
  ok(amp.includes('&amp;') && amp.includes('&lt;') && amp.includes('&gt;') && amp.includes('&quot;'), 'plain metacharacters escaped');
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\nnga-test FAILED (${failed})` : '\nnga-test: all passed');
process.exit(failed ? 1 : 0);
