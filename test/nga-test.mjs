// NGA (nga/) — deterministic, offline test. Two parts, NO live NGA dependency:
//   1) server/nga.js pure helpers: the fid whitelist + the list/post row normalizer.
//   2) The client's untrusted-content sanitizer (window.__nga.renderContent), driven in a real
//      browser against a batch of XSS / BBCode fixtures — this is the security-critical path
//      (forum markup → HTML), so it's pinned here.
// The page is served by the harness's plain file server (no /api/nga), so the board load just shows
// an error state; renderContent is still exposed and is what we exercise.
// Usage: node test/nga-test.mjs
import { startServer, launchBrowser } from './harness.mjs';
import { rowsOf, ALLOWED_FIDS, BOARDS, learnBoardFids, isThreadFidAllowed } from '../server/nga.js';

let failed = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`); if (!cond) failed++; };

// ---- 1) relay pure helpers ----
console.log('relay helpers:');
ok(ALLOWED_FIDS.has('846') && ALLOWED_FIDS.has('-34587507'), 'both 方舟 boards whitelisted');
ok(!ALLOWED_FIDS.has('7') && !ALLOWED_FIDS.has(''), 'other/empty fids rejected');
ok(BOARDS['846'] === '明日方舟：终末地' && BOARDS['-34587507'] === '明日方舟', 'board labels');
ok(ALLOWED_FIDS.has('414') && BOARDS['414'] === '游戏综合讨论', '游戏综合讨论 (414) is whitelisted');
ok(rowsOf([{ tid: 1 }, { tid: 2 }, { x: 3 }], 'tid').length === 2, 'rowsOf array: keeps rows with the key');
ok(rowsOf({ 0: { tid: 1 }, 1: { tid: 2 }, __ROWS: 9, meta: {} }, 'tid').length === 2, 'rowsOf object: numeric keys + key present only');
ok(rowsOf(null, 'tid').length === 0 && rowsOf(undefined, 'lou').length === 0, 'rowsOf nullish → []');
ok(rowsOf([{ lou: 0 }, { lou: 1 }], 'lou').length === 2, 'rowsOf keeps lou:0 (楼主, falsy but present)');

// sub-forum learning: a collection board's threads carry sub-forum fids, which must be readable AFTER
// the board is loaded, but an unrelated board's fid must still be refused.
console.log('sub-forum fid learning:');
ok(isThreadFidAllowed('846') && isThreadFidAllowed('-34587507'), 'the two boards are always readable');
ok(!isThreadFidAllowed('734') && !isThreadFidAllowed('635'), 'sub-forum fids are refused BEFORE their board is loaded');
learnBoardFids('-34587507', { data: [{ tid: 1, fid: 734 }, { tid: 2, fid: '635' }, { tid: 3, fid: '-34587507' }], subForum: [{ id: 805 }, { 0: 806 }] });
ok(isThreadFidAllowed('734') && isThreadFidAllowed('635'), 'sub-forum threads readable AFTER the board is loaded');
ok(isThreadFidAllowed('805') && isThreadFidAllowed('806'), 'declared subForum ids are learned too');
ok(!isThreadFidAllowed('999999'), 'an unrelated board fid is still refused (not an open proxy)');

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

  const br = await render('line1<br/>line2<br />line3');
  ok((br.match(/<br>/g) || []).length === 2 && !/<br\s*\/>/.test(br), '<br/> variants folded to <br>');

  const styled = await render('[b]B[/b][del]D[/del]');
  ok(styled.includes('<b>B</b>') && styled.includes('<del>D</del>'), 'inline [b]/[del] styling');

  const unknown = await render('[color=red]text[/color][size=5]big[/size]');
  ok(!/\[color|\[size/i.test(unknown) && unknown.includes('text') && unknown.includes('big'), 'unknown tags stripped, inner text kept');

  const amp = await render('a & b < c > d "q"');
  ok(amp.includes('&amp;') && amp.includes('&lt;') && amp.includes('&gt;') && amp.includes('&quot;'), 'plain metacharacters escaped');

  console.log('emotes / video:');
  const emoteKnown = await render('哈[s:ac:哭笑]哈');
  ok(/<img class="nga-emote-img"[^>]*src="\/api\/nga\/img\?u=[^"]*mon_201209[^"]*"/.test(emoteKnown), 'known emote [s:ac:哭笑] → proxied smiley image');
  ok(/alt="哭笑"/.test(emoteKnown), 'emote carries its name as alt (fallback text)');
  const emoteUnknown = await render('[s:zz:不存在]');
  ok(/<span class="nga-emote">不存在<\/span>/.test(emoteUnknown) && !/nga-emote-img/.test(emoteUnknown), 'unknown emote → text badge, no broken image');
  const vid = await render('前<span class="video"><video onplay="stopAudio()" src="https://img.nga.178.com/attachments/mon_202607/06/-x-k4.gif.mp4" class="videoSize" poster="https://img.nga.178.com/attachments/mon_202607/06/-x-k4.gif.mp4.thumb.jpg" controls></video></span>后');
  ok(/<video class="nga-video"[^>]*><source src="\/api\/nga\/img\?u=[^"]*gif\.mp4[^"]*" type="video\/mp4">/.test(vid), 'NGA <video> → proxied <video><source> (not escaped text)');
  ok(/poster="\/api\/nga\/img\?u=[^"]*thumb\.jpg[^"]*"/.test(vid) && vid.includes('前') && vid.includes('后'), 'video poster proxied; surrounding text preserved');
  ok(!/&lt;video|onplay|stopAudio/.test(vid), 'raw <video> attributes/handlers do not leak as text or live');

  console.log('raw HTML formatting:');
  const bdel = await render('<b>粗</b>和<del class=\'gray\'>删</del>');
  ok(/<b>粗<\/b>/.test(bdel) && /<del>删<\/del>/.test(bdel), 'NGA <b> / <del class=…> render as real tags (attributes dropped)');
  ok(!/&lt;b&gt;|&lt;del/.test(bdel), 'formatting tags are not left as escaped text');
  const inj = await render('<b onclick="alert(1)">x</b><script>bad()</script>');
  ok(/<b>x<\/b>/.test(inj) && !/onclick/.test(inj), 'attributes are stripped from re-enabled tags (no onclick)');
  ok(!/<script>/.test(inj) && inj.includes('&lt;script&gt;'), 'non-whitelisted tags (script) stay escaped');
  const vote = await render('<form><label for="v1">选项</label><input type="radio"/></form>');
  ok(!/<form|<input|<label/.test(vote) && vote.includes('选项'), 'read-only vote widgets are dropped, label text kept');

  console.log('history-driven back nav:');
  const nav = await page.evaluate(async () => {
    const wait = () => new Promise((r) => setTimeout(r, 60));
    window.__nga.showList();                    // ensure we start on the list
    window.__nga.openThread('123', 'T');        // list → thread (pushes a history entry)
    await wait();
    const afterOpen = window.__nga.state.view;
    history.back(); await wait();                // back-swipe → thread → list
    const afterBack1 = window.__nga.state.view;
    const url1 = location.pathname;
    history.back(); await wait();                // back-swipe from list → trapped (stay on /nga/)
    return { afterOpen, afterBack1, url1, url2: location.pathname };
  });
  ok(nav.afterOpen === 'thread', 'openThread → thread view');
  ok(nav.afterBack1 === 'list', 'back-swipe from a thread returns to the list (not the hub)');
  ok(nav.url1.endsWith('/nga/') && nav.url2.endsWith('/nga/'), 'back-swipe never leaves the reader page');

  // iOS tappability: thread rows MUST be native <button>s — iOS Safari reliably fires a tap on a
  // button but often won't on a plain <div> even with cursor:pointer (a click-driven test can't catch
  // this: desktop Chromium taps divs regardless). Assert the row the code actually builds is a button.
  console.log('iOS tap targets:');
  const row = await page.evaluate(() => {
    const b = window.__nga.makeThreadRow({ tid: 1, subject: 's', author: 'a', replies: 0, lastpost: 0, postdate: 0 });
    document.getElementById('threads').appendChild(b);
    const cs = getComputedStyle(b);
    const r = { tag: b.tagName, cursor: cs.cursor }; b.remove(); return r;
  });
  ok(row.tag === 'BUTTON', `thread rows are native <button> (got <${row.tag.toLowerCase()}>)`);
  ok(row.cursor === 'pointer', `thread rows show cursor:pointer (${row.cursor})`);

  // view switching: the [hidden] attribute MUST actually hide a view. The views set display:flex with
  // an id selector, which silently overrides [hidden] unless a reset forces it — the bug where clicking
  // a thread "did nothing" (list stayed visible). Assert VISIBILITY, not DOM presence.
  console.log('view switching:');
  const vis = await page.evaluate(() => {
    const tv = document.getElementById('thread-view');
    const hiddenDisp = getComputedStyle(tv).display;      // has the hidden attr on load
    tv.hidden = false; const shownDisp = getComputedStyle(tv).display;
    tv.hidden = true; return { hiddenDisp, shownDisp };
  });
  ok(vis.hiddenDisp === 'none', `a [hidden] view is display:none (was "${vis.hiddenDisp}")`);
  ok(vis.shownDisp !== 'none', `a shown view is visible ("${vis.shownDisp}")`);

  // sub-forum filter: hiding a group drops its threads; an unlisted fid falls into "其他".
  console.log('sub-forum filter:');
  const filt = await page.evaluate(() => {
    const N = window.__nga;
    Object.assign(N.state.list, {
      fid: '-34587507', label: '明日方舟',
      subForums: [{ id: '734', name: 'A' }, { id: '805', name: 'B' }],
      threads: [{ tid: 1, fid: '-34587507', subject: 'main', replies: 0 }, { tid: 2, fid: '734', subject: 'a', replies: 0 },
        { tid: 3, fid: '805', subject: 'b', replies: 0 }, { tid: 4, fid: '999', subject: 'other', replies: 0 }],
      hidden: new Set(),
    });
    const count = () => document.querySelectorAll('#threads .thread').length;
    N.renderThreadList(N.state.list.threads); const all = count();
    N.state.list.hidden = new Set(['734']); N.renderThreadList(N.state.list.threads); const hid1 = count();
    return { all, hid1, other: N.groupOf({ fid: '999' }), groups: N.filterGroups().map((g) => g.id) };
  });
  ok(filt.all === 4, `all threads shown with no filter (${filt.all})`);
  ok(filt.hid1 === 3, `hiding a sub-forum drops its threads (${filt.hid1})`);
  ok(filt.other === '__other__', 'a thread from an unlisted fid maps to the 其他 group');
  ok(filt.groups[0] === '-34587507' && filt.groups.includes('734') && filt.groups.includes('805'), 'groups = board itself + linked sub-forums');
} finally {
  await browser.close();
  server.close();
}

console.log(failed ? `\nnga-test FAILED (${failed})` : '\nnga-test: all passed');
process.exit(failed ? 1 : 0);
