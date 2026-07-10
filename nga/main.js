// 方舟资讯 — read-only NGA reader for the two 明日方舟 boards. All data comes from our own
// same-origin relay (server/nga.js), which proxies NGA's guest app API + images. This file is pure
// view: fetch → render. Two in-page views (thread list ⇄ thread reader) toggled by show/hide — NEVER
// a history push (app-nav.js + the repo's edge-swipe rule), so nav is state, not the back stack.

const BOARDS = [
  { fid: '-34587507', label: '明日方舟' },
  { fid: '846', label: '终末地' },
];
const LAST_BOARD_KEY = 'nga.lastFid';

const $ = (id) => document.getElementById(id);
const els = {
  listView: $('list-view'), threadView: $('thread-view'),
  boards: $('boards'), threads: $('threads'),
  listPager: $('list-pager'), lpPrev: $('lp-prev'), lpNext: $('lp-next'), lpInfo: $('lp-info'),
  refresh: $('btn-refresh'), threadRefresh: $('btn-thread-refresh'),
  toList: $('btn-to-list'), threadTitle: $('thread-title'), posts: $('posts'),
  threadPager: $('thread-pager'), tpPrev: $('tp-prev'), tpNext: $('tp-next'), tpInfo: $('tp-info'),
  toast: $('toast'),
};

// Where we are. `list` remembers the board + page so returning from a thread lands exactly back.
const state = {
  view: 'list',
  list: { fid: BOARDS[0].fid, page: 1, threads: null },
  thread: { tid: null, page: 1, subject: '', totalPage: 1 },
};

// ---------- helpers --------------------------------------------------------
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg; els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function relTime(unixSec) {
  if (!unixSec) return '';
  const d = Date.now() / 1000 - unixSec;
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + '分钟前';
  if (d < 86400) return Math.floor(d / 3600) + '小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + '天前';
  const dt = new Date(unixSec * 1000);
  return `${dt.getMonth() + 1}-${String(dt.getDate()).padStart(2, '0')}`;
}

async function api(path) {
  const r = await fetch(path, { headers: { 'Accept': 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

const proxyImg = (u) => '/api/nga/img?u=' + encodeURIComponent(u);
// Resolve an NGA attach src (absolute, or relative to attachPrefix) to an absolute URL.
function resolveSrc(src, prefix) {
  src = String(src).trim();
  if (/^https?:\/\//i.test(src)) return src;
  return (prefix || 'https://img.nga.178.com/attachments/') + src.replace(/^\.?\//, '');
}

// ---------- NGA content → safe HTML ---------------------------------------
// SECURITY: the content is untrusted forum markup (a hybrid of `<br/>` HTML + [bbcode]). We escape
// EVERYTHING first, so the only tags in the output are ones this function emits. URLs are validated
// and attribute-escaped; images are routed through our same-origin proxy (Referer + COEP).
function renderContent(raw, prefix) {
  // 1) fold NGA's literal <br> variants to newlines BEFORE escaping (the only raw HTML it uses)
  let s = String(raw).replace(/<br\s*\/?>/gi, '\n');
  // 2) escape — from here on the string contains no live HTML, only text + [bbcode] brackets
  s = escapeHtml(s);

  // 3) images: [img]src[/img]  (src may be absolute or attachPrefix-relative)
  s = s.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_, src) => {
    const abs = resolveSrc(src.replace(/&amp;/g, '&'), prefix);
    if (!/^https?:\/\//i.test(abs)) return '';
    return `<img class="nga-img" loading="lazy" src="${escapeHtml(proxyImg(abs))}" alt="图片">`;
  });

  // 4) links: [url=href]text[/url]  and  [url]href[/url]
  const safeHref = (h) => { h = h.replace(/&amp;/g, '&').trim(); return /^https?:\/\//i.test(h) ? h : null; };
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, href, text) => {
    const h = safeHref(href); if (!h) return text;
    return `<a href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_, href) => {
    const h = safeHref(href); if (!h) return escapeHtml(href);
    return `<a href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h)}</a>`;
  });

  // 5) collapse / spoiler → <details>
  s = s.replace(/\[collapse(?:=([^\]]*))?\]([\s\S]*?)\[\/collapse\]/gi, (_, title, body) =>
    `<details class="nga-collapse"><summary>${(title || '').trim() || '展开'}</summary>${body}</details>`);

  // 6) quotes — innermost-first so nesting resolves; cap the passes so a malformed [quote] can't spin
  for (let i = 0; i < 8 && /\[quote\]/i.test(s); i++) {
    const before = s;
    s = s.replace(/\[quote\]((?:(?!\[quote\]|\[\/quote\])[\s\S])*?)\[\/quote\]/gi,
      (_, inner) => `<blockquote class="nga-quote">${inner}</blockquote>`);
    if (s === before) break;
  }
  s = s.replace(/\[\/?quote\]/gi, ''); // drop any leftover unmatched quote tags

  // 7) simple inline styling
  s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<b>$1</b>')
       .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<i>$1</i>')
       .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>')
       .replace(/\[del\]([\s\S]*?)\[\/del\]/gi, '<del>$1</del>');

  // 8) emotes [s:xxx:name] → a small badge with the trailing label
  s = s.replace(/\[s:[^:\]]+:([^\]]+)\]/gi, (_, name) => `<span class="nga-emote">${name}</span>`);

  // 9) strip any remaining known-but-unhandled tags, keep their text
  s = s.replace(/\[\/?(?:color|size|align|font|list|table|tr|td|h|quote|randomblock|pid|uid|tid|flash|media|dice)(?:=[^\]]*)?\]/gi, '');

  // 10) newlines → <br>
  return s.replace(/\n/g, '<br>');
}

// ---------- view switching -------------------------------------------------
function showList() {
  state.view = 'list';
  els.threadView.hidden = true; els.listView.hidden = false;
  els.threads.scrollTop = state.list._scroll || 0;
}
function showThread() {
  state.view = 'thread';
  els.listView.hidden = true; els.threadView.hidden = false;
  els.posts.scrollTop = 0;
}

// ---------- board tabs -----------------------------------------------------
function buildTabs() {
  els.boards.innerHTML = '';
  for (const b of BOARDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (b.fid === state.list.fid ? ' active' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', () => {
      if (state.list.fid === b.fid) return;
      state.list.fid = b.fid; state.list.page = 1;
      try { localStorage.setItem(LAST_BOARD_KEY, b.fid); } catch {}
      buildTabs(); loadBoard();
    });
    els.boards.appendChild(btn);
  }
}

// ---------- thread list ----------------------------------------------------
async function loadBoard() {
  const { fid, page } = state.list;
  els.threads.innerHTML = '<div class="state">加载中…</div>';
  els.listPager.hidden = true;
  els.refresh.classList.add('spin');
  try {
    const data = await api(`/api/nga/board?fid=${encodeURIComponent(fid)}&page=${page}`);
    if (state.list.fid !== fid || state.list.page !== page) return; // superseded by a newer tap
    state.list.threads = data.threads;
    renderThreadList(data.threads);
  } catch (e) {
    els.threads.innerHTML = `<div class="state err">加载失败<br>${escapeHtml(e.message)}<br><button type="button" id="retry-list">重试</button></div>`;
    const rb = $('retry-list'); if (rb) rb.addEventListener('click', loadBoard);
  } finally {
    els.refresh.classList.remove('spin');
  }
}

// One thread row. A native <button> (not a styled <div>): iOS Safari reliably fires a tap on a button
// but often WON'T on a plain div, even one with cursor:pointer — which is why the tabs/pager worked but
// the div rows didn't. Same natively-tappable element as the board tabs.
function makeThreadRow(t) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'thread';
  const replies = t.replies | 0;
  row.innerHTML =
    `<div class="t-subject">${escapeHtml(t.subject)}</div>` +
    `<div class="t-meta">` +
      `<span class="t-author">${escapeHtml(t.author || '匿名')}</span>` +
      `<span class="t-time">${relTime(t.lastpost || t.postdate)}</span>` +
      `<span class="t-replies${replies >= 80 ? ' hot' : ''}">${replies}</span>` +
    `</div>`;
  row.addEventListener('click', () => openThread(t.tid, t.subject));
  return row;
}

function renderThreadList(threads) {
  els.threads.innerHTML = '';
  if (!threads || !threads.length) {
    els.threads.innerHTML = '<div class="state">这一页没有主题</div>';
  } else {
    const frag = document.createDocumentFragment();
    for (const t of threads) frag.appendChild(makeThreadRow(t));
    els.threads.appendChild(frag);
  }
  els.lpInfo.textContent = `第 ${state.list.page} 页`;
  els.lpPrev.disabled = state.list.page <= 1;
  els.lpNext.disabled = !threads || threads.length === 0;
  els.listPager.hidden = false;
  els.threads.scrollTop = 0;
}

// ---------- thread reader --------------------------------------------------
function openThread(tid, subject) {
  state.list._scroll = els.threads.scrollTop;
  state.thread = { tid: String(tid), page: 1, subject: subject || '主题', totalPage: 1 };
  els.threadTitle.textContent = state.thread.subject;
  showThread();
  loadThread();
}

async function loadThread() {
  const { tid, page } = state.thread;
  els.posts.innerHTML = '<div class="state">加载中…</div>';
  els.threadPager.hidden = true;
  els.threadRefresh.classList.add('spin');
  try {
    const data = await api(`/api/nga/thread?tid=${encodeURIComponent(tid)}&page=${page}`);
    if (state.thread.tid !== tid || state.thread.page !== page) return;
    state.thread.totalPage = data.totalPage || 1;
    if (data.subject) { state.thread.subject = data.subject; els.threadTitle.textContent = data.subject; }
    renderPosts(data);
  } catch (e) {
    const msg = /forbidden/i.test(e.message) ? '该主题不在方舟版块内' : e.message;
    els.posts.innerHTML = `<div class="state err">加载失败<br>${escapeHtml(msg)}<br><button type="button" id="retry-thread">重试</button></div>`;
    const rb = $('retry-thread'); if (rb) rb.addEventListener('click', loadThread);
  } finally {
    els.threadRefresh.classList.remove('spin');
  }
}

function renderPosts(data) {
  els.posts.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const p of data.posts || []) {
    const el = document.createElement('div');
    el.className = 'post';
    const isUid = /^UID:/.test(p.author);
    const floor = p.lou === 0 ? '楼主' : '#' + p.lou;
    const head = document.createElement('div');
    head.className = 'p-head';
    head.innerHTML =
      `<span class="p-author${isUid ? ' uid' : ''}">${escapeHtml(p.author || '匿名')}</span>` +
      `<span class="p-floor${p.lou === 0 ? ' op' : ''}">${floor}</span>` +
      `<span class="p-date">${escapeHtml(p.date || '')}</span>`;
    const body = document.createElement('div');
    body.className = 'p-body';
    body.innerHTML = renderContent(p.content, data.attachPrefix);
    el.appendChild(head); el.appendChild(body);
    frag.appendChild(el);
  }
  els.posts.appendChild(frag);
  const tp = state.thread.totalPage;
  els.tpInfo.textContent = `第 ${state.thread.page} / ${tp} 页`;
  els.tpPrev.disabled = state.thread.page <= 1;
  els.tpNext.disabled = state.thread.page >= tp;
  els.threadPager.hidden = false;
  els.posts.scrollTop = 0;
}

// ---------- wiring ---------------------------------------------------------
els.refresh.addEventListener('click', loadBoard);
els.threadRefresh.addEventListener('click', loadThread);
els.toList.addEventListener('click', showList);
els.lpPrev.addEventListener('click', () => { if (state.list.page > 1) { state.list.page--; loadBoard(); } });
els.lpNext.addEventListener('click', () => { state.list.page++; loadBoard(); });
els.tpPrev.addEventListener('click', () => { if (state.thread.page > 1) { state.thread.page--; loadThread(); } });
els.tpNext.addEventListener('click', () => { if (state.thread.page < state.thread.totalPage) { state.thread.page++; loadThread(); } });

// restore last-read board
try { const last = localStorage.getItem(LAST_BOARD_KEY); if (last && BOARDS.some((b) => b.fid === last)) state.list.fid = last; } catch {}

buildTabs();
loadBoard();

// e2e hook
window.__nga = { state, renderContent, makeThreadRow };
