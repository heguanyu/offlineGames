// 方舟资讯 — read-only NGA reader for the two 明日方舟 boards. All data comes from our own
// same-origin relay (server/nga.js), which proxies NGA's guest app API + images. This file is pure
// view: fetch → render. Two in-page views (thread list ⇄ thread reader) toggled by show/hide — NEVER
// a history push (app-nav.js + the repo's edge-swipe rule), so nav is state, not the back stack.

import { EMOTES } from './emotes.js';

const BOARDS = [
  { fid: '-34587507', label: '明日方舟' },
  { fid: '846', label: '终末地' },
];
const LAST_BOARD_KEY = 'nga.lastFid';

const $ = (id) => document.getElementById(id);
const els = {
  listView: $('list-view'), threadView: $('thread-view'),
  boards: $('boards'), threads: $('threads'),
  filterBtn: $('btn-filter'), filterPanel: $('filter-panel'),
  listPager: $('list-pager'), lpPrev: $('lp-prev'), lpNext: $('lp-next'), lpInfo: $('lp-info'),
  refresh: $('btn-refresh'), threadRefresh: $('btn-thread-refresh'),
  toList: $('btn-to-list'), threadTitle: $('thread-title'), posts: $('posts'),
  threadPager: $('thread-pager'), tpPrev: $('tp-prev'), tpNext: $('tp-next'), tpInfo: $('tp-info'),
  lightbox: $('lightbox'), lbImg: $('lb-img'), lbScroll: $('lb-scroll'), lbClose: $('lb-close'),
  toast: $('toast'),
};

// Where we are. `list` remembers the board + page so returning from a thread lands exactly back.
// subForums/threads + `hidden` (a Set of hidden group ids) drive the sub-forum filter.
const state = {
  view: 'list',
  list: { fid: BOARDS[0].fid, page: 1, threads: null, subForums: [], label: '', hidden: new Set() },
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
  let s = String(raw);
  // 1) extract NGA inline videos BEFORE escaping — `<span class="video"><video src poster …></video></span>`
  //    (short .gif.mp4 clips on img.nga.178.com). Stash a safe, proxied <video> behind a control-char
  //    placeholder that survives escaping, restored at the very end.
  const videos = [];
  s = s.replace(/(?:<span class="video">)?<video\b[^>]*>(?:\s*<\/video>)?(?:<\/span>)?/gi, (tag) => {
    const src = (tag.match(/\bsrc="([^"]+)"/i) || [])[1];
    if (!src || !/^https?:\/\//i.test(src)) return '';
    const poster = (tag.match(/\bposter="([^"]+)"/i) || [])[1];
    const posterAttr = poster && /^https?:\/\//i.test(poster) ? ` poster="${escapeHtml(proxyImg(poster))}"` : '';
    videos.push(`<video class="nga-video" controls preload="none" playsinline${posterAttr}><source src="${escapeHtml(proxyImg(src))}" type="video/mp4"></video>`);
    return '\x01' + (videos.length - 1) + '\x01';
  });
  // 2) fold NGA's literal <br> variants to newlines BEFORE escaping
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // 3) escape — from here on the string has no live HTML, only text + [bbcode] brackets + placeholders
  s = escapeHtml(s);

  // 4) images: [img]src[/img]  (src may be absolute or attachPrefix-relative)
  s = s.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_, src) => {
    const abs = resolveSrc(src.replace(/&amp;/g, '&'), prefix);
    if (!/^https?:\/\//i.test(abs)) return '';
    return `<img class="nga-img" loading="lazy" src="${escapeHtml(proxyImg(abs))}" alt="图片">`;
  });

  // 5) links: [url=href]text[/url]  and  [url]href[/url]
  const safeHref = (h) => { h = h.replace(/&amp;/g, '&').trim(); return /^https?:\/\//i.test(h) ? h : null; };
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, href, text) => {
    const h = safeHref(href); if (!h) return text;
    return `<a href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_, href) => {
    const h = safeHref(href); if (!h) return escapeHtml(href);
    return `<a href="${escapeHtml(h)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h)}</a>`;
  });

  // 6) collapse / spoiler → <details>
  s = s.replace(/\[collapse(?:=([^\]]*))?\]([\s\S]*?)\[\/collapse\]/gi, (_, title, body) =>
    `<details class="nga-collapse"><summary>${(title || '').trim() || '展开'}</summary>${body}</details>`);

  // 7) quotes — innermost-first so nesting resolves; cap the passes so a malformed [quote] can't spin
  for (let i = 0; i < 8 && /\[quote\]/i.test(s); i++) {
    const before = s;
    s = s.replace(/\[quote\]((?:(?!\[quote\]|\[\/quote\])[\s\S])*?)\[\/quote\]/gi,
      (_, inner) => `<blockquote class="nga-quote">${inner}</blockquote>`);
    if (s === before) break;
  }
  s = s.replace(/\[\/?quote\]/gi, ''); // drop any leftover unmatched quote tags

  // 8) simple inline styling
  s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<b>$1</b>')
       .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<i>$1</i>')
       .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>')
       .replace(/\[del\]([\s\S]*?)\[\/del\]/gi, '<del>$1</del>');

  // 9) emotes [s:cat:name] → the real NGA smiley image (proxied) when known, else a text badge
  s = s.replace(/\[s:([^:\]]+):([^\]]+)\]/gi, (_, cat, name) => {
    const url = EMOTES[cat + ':' + name];
    if (url) return `<img class="nga-emote-img" src="${escapeHtml(proxyImg(url))}" alt="${escapeHtml(name)}" loading="lazy">`;
    return `<span class="nga-emote">${escapeHtml(name)}</span>`;
  });

  // 10) strip any remaining known-but-unhandled tags, keep their text
  s = s.replace(/\[\/?(?:color|size|align|font|list|table|tr|td|h|randomblock|pid|uid|tid|flash|media|dice)(?:=[^\]]*)?\]/gi, '');

  // 11) newlines → <br>, then restore the stashed <video> elements
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\x01(\d+)\x01/g, (_, i) => videos[+i] || '');
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
    state.list.subForums = data.subForums || [];
    state.list.label = data.label || (BOARDS.find((b) => b.fid === fid) || {}).label || '';
    state.list.hidden = loadHidden(fid);
    els.filterPanel.hidden = true; // collapse on each fresh load
    buildFilterPanel();
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
  const shown = (threads || []).filter((t) => !state.list.hidden.has(groupOf(t)));
  if (!threads || !threads.length) {
    els.threads.innerHTML = '<div class="state">这一页没有主题</div>';
  } else if (!shown.length) {
    els.threads.innerHTML = '<div class="state">当前筛选下没有主题<br>点右上角「版块」调整</div>';
  } else {
    const frag = document.createDocumentFragment();
    for (const t of shown) frag.appendChild(makeThreadRow(t));
    els.threads.appendChild(frag);
  }
  els.lpInfo.textContent = `第 ${state.list.page} 页`;
  els.lpPrev.disabled = state.list.page <= 1;
  els.lpNext.disabled = !threads || threads.length === 0;
  els.listPager.hidden = false;
  els.threads.scrollTop = 0;
}

// ---------- sub-forum filter (uncheck to hide, like the native app) ---------
const hiddenKey = (fid) => 'nga.hidden.' + fid;
function loadHidden(fid) {
  try { const a = JSON.parse(localStorage.getItem(hiddenKey(fid)) || '[]'); return new Set(Array.isArray(a) ? a.map(String) : []); }
  catch { return new Set(); }
}
function saveHidden(fid, set) { try { localStorage.setItem(hiddenKey(fid), JSON.stringify([...set])); } catch {} }

// The toggleable groups for the current board: the board's own forum first, then each linked
// sub-forum. Threads whose fid isn't one of those collapse into a synthetic "其他" group.
function filterGroups() {
  const groups = [{ id: state.list.fid, name: state.list.label || '本版' }];
  for (const sf of state.list.subForums || []) if (sf.id !== state.list.fid) groups.push({ id: sf.id, name: sf.name });
  return groups;
}
function groupOf(t) {
  const ids = new Set(filterGroups().map((g) => g.id));
  return ids.has(t.fid) ? t.fid : '__other__';
}
function updateFilterBtn() {
  const n = state.list.hidden.size;
  els.filterBtn.classList.toggle('on', n > 0);
  els.filterBtn.textContent = n > 0 ? `版块·隐藏${n} ▾` : '版块 ▾';
}
function buildFilterPanel() {
  const groups = filterGroups().slice();
  const counts = {};
  for (const t of state.list.threads || []) counts[groupOf(t)] = (counts[groupOf(t)] || 0) + 1;
  if (counts.__other__) groups.push({ id: '__other__', name: '其他' });
  // Nothing to filter (e.g. 终末地 has no linked sub-forums) → hide the whole control.
  if (groups.length <= 1) { els.filterBtn.hidden = true; els.filterPanel.hidden = true; return; }
  els.filterBtn.hidden = false;
  const hidden = state.list.hidden;
  const chips = groups.map((g) =>
    `<button class="fchip${hidden.has(g.id) ? ' off' : ''}" type="button" data-gid="${escapeHtml(g.id)}">` +
    `${escapeHtml(g.name)}<span class="fc-n">${counts[g.id] || 0}</span></button>`).join('');
  els.filterPanel.innerHTML =
    `<div class="fp-head">显示的版块（取消勾选可隐藏）<span class="fp-actions">` +
    `<button class="fp-act" type="button" data-act="all">全选</button>` +
    `<button class="fp-act" type="button" data-act="none">全不选</button></span></div>` +
    `<div class="fp-chips">${chips}</div>`;
  els.filterPanel.querySelectorAll('.fchip').forEach((btn) => btn.addEventListener('click', () => {
    const gid = btn.getAttribute('data-gid');
    if (hidden.has(gid)) hidden.delete(gid); else hidden.add(gid);
    btn.classList.toggle('off');
    saveHidden(state.list.fid, hidden);
    updateFilterBtn();
    renderThreadList(state.list.threads);
  }));
  els.filterPanel.querySelectorAll('.fp-act').forEach((btn) => btn.addEventListener('click', () => {
    hidden.clear();
    if (btn.getAttribute('data-act') === 'none') for (const g of groups) hidden.add(g.id);
    saveHidden(state.list.fid, hidden);
    buildFilterPanel();
    renderThreadList(state.list.threads);
  }));
  updateFilterBtn();
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
    // likes (赞 / 踩) — show a count only when non-zero
    const good = p.good | 0, bad = p.bad | 0;
    if (good || bad) {
      const foot = document.createElement('div');
      foot.className = 'p-foot';
      foot.innerHTML =
        (good ? `<span class="p-vote good">👍 ${good}</span>` : '') +
        (bad ? `<span class="p-vote bad">👎 ${bad}</span>` : '');
      el.appendChild(foot);
    }
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
els.filterBtn.addEventListener('click', () => { els.filterPanel.hidden = !els.filterPanel.hidden; });

// image lightbox — tap a post image to view it full-screen; tap it to toggle fit ⇄ actual size
// (pan by scrolling when zoomed), tap the backdrop or ✕ to close.
function openLightbox(src) { els.lbImg.src = src; els.lbScroll.classList.remove('zoom'); els.lightbox.hidden = false; }
function closeLightbox() { els.lightbox.hidden = true; els.lbImg.removeAttribute('src'); }
els.posts.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('img.nga-img');
  if (img && img.getAttribute('src')) { e.preventDefault(); openLightbox(img.getAttribute('src')); }
});
els.lbImg.addEventListener('click', (e) => { e.stopPropagation(); els.lbScroll.classList.toggle('zoom'); });
els.lbScroll.addEventListener('click', closeLightbox);
els.lbClose.addEventListener('click', closeLightbox);

// restore last-read board
try { const last = localStorage.getItem(LAST_BOARD_KEY); if (last && BOARDS.some((b) => b.fid === last)) state.list.fid = last; } catch {}

buildTabs();
loadBoard();

// e2e hook
window.__nga = { state, renderContent, makeThreadRow, groupOf, filterGroups, buildFilterPanel, renderThreadList };
