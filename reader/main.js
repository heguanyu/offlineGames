// reader/main.js — 电子书阅读: bookshelf (books stored in the tool's own IndexedDB)
// + paginated reader with iOS-Books-style slide flips and a persisted last-read spot.
import { openEpub } from './epub.js';

// ---- IndexedDB (this tool's own data: 'books' = the EPUB blobs, 'progress' = last-read) ----
let dbp;
function getDb() {
  return (dbp ||= new Promise((res, rej) => {
    const req = indexedDB.open('epub-reader', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('books', { keyPath: 'id' });
      req.result.createObjectStore('progress', { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}
async function idb(store, mode, fn) {
  const db = await getDb();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result);
    t.onerror = () => rej(t.error);
  });
}
const idbPut = (s, v) => idb(s, 'readwrite', (o) => o.put(v));
const idbGet = (s, k) => idb(s, 'readonly', (o) => o.get(k));
const idbAll = (s) => idb(s, 'readonly', (o) => o.getAll());
const idbDel = (s, k) => idb(s, 'readwrite', (o) => o.delete(k));

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const shelfEl = $('shelf'), emptyEl = $('empty'), busyEl = $('busy');
const readerEl = $('reader'), viewport = $('viewport'), flow = $('flow');
const gesture = $('gesture'), pagenoEl = $('pageno');
const hudTitle = $('hud-title'), hudInfo = $('hud-info');
const tocEl = $('toc'), tocList = $('toc-list'), tocScrim = $('toc-scrim');

const GAP = 56;              // px between columns = twice the visual page margin
const FONT_MIN = 15, FONT_MAX = 27;
let fontSize = parseInt(localStorage.getItem('reader-font'), 10) || 19;

// ---- library (书架) ----
let coverUrls = [];
async function renderLibrary() {
  const [books, progs] = await Promise.all([idbAll('books'), idbAll('progress')]);
  const pct = new Map(progs.map((p) => [p.id, p.pct]));
  coverUrls.forEach((u) => URL.revokeObjectURL(u));
  coverUrls = [];
  shelfEl.textContent = '';
  emptyEl.hidden = books.length > 0;
  for (const b of books.sort((x, y) => (y.openedAt || y.addedAt) - (x.openedAt || x.addedAt))) {
    const card = document.createElement('div');
    card.className = 'book';
    const cover = document.createElement('div');
    cover.className = 'cover';
    if (b.cover) {
      const url = URL.createObjectURL(b.cover);
      coverUrls.push(url);
      const img = document.createElement('img');
      img.src = url;
      cover.appendChild(img);
    } else cover.textContent = '📖';
    const title = document.createElement('div');
    title.className = 'btitle';
    title.textContent = b.title;
    const meta = document.createElement('div');
    meta.className = 'bmeta';
    const p = pct.get(b.id);
    meta.textContent = b.author ? b.author + ' · ' : '';
    const span = document.createElement('span');
    span.className = 'bpct';
    span.textContent = p != null ? `已读 ${p}%` : '未读';
    meta.appendChild(span);
    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '✕';
    del.setAttribute('aria-label', '删除');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除《${b.title}》？`)) return;
      await idbDel('books', b.id);
      await idbDel('progress', b.id);
      renderLibrary();
    });
    card.append(cover, title, meta, del);
    card.addEventListener('click', () => openBook(b));
    shelfEl.appendChild(card);
  }
}

// ---- import ----
async function fileId(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d).slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function addFiles(files) {
  busyEl.hidden = false;
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      const id = await fileId(buf);
      const epub = await openEpub(buf);
      const cover = await epub.cover();
      epub.destroy();
      await idbPut('books', {
        id,
        title: epub.title || f.name.replace(/\.epub$/i, ''),
        author: epub.author || '',
        size: buf.byteLength,
        addedAt: Date.now(),
        data: new Blob([buf], { type: 'application/epub+zip' }),
        cover,
      });
    } catch (err) {
      alert(`无法导入「${f.name}」：${err.message || err}`);
    }
  }
  busyEl.hidden = true;
  renderLibrary();
}
$('btn-add').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  if (e.target.files.length) addFiles([...e.target.files]);
  e.target.value = '';
});

// ---- reader ----
let cur = null;       // { book, epub, chapter, page, pageCount, step, toc }
let turning = false;  // an async chapter swap is in flight

async function openBook(book) {
  try {
    const epub = await openEpub(await book.data.arrayBuffer());
    cur = { book, epub, chapter: 0, page: 0, pageCount: 1, step: 1, toc: null };
    hudTitle.textContent = epub.title || book.title;
    applyFont();
    readerEl.hidden = false;
    readerEl.classList.remove('hud-open');
    const prog = await idbGet('progress', book.id);
    await showChapter(prog ? prog.spine : 0, { frac: prog ? prog.frac : 0 });
    idbPut('books', { ...book, openedAt: Date.now() });
  } catch (err) {
    alert(`无法打开本书：${err.message || err}`);
    closeBook();
  }
}

function closeBook() {
  if (cur) cur.epub.destroy();
  cur = null;
  readerEl.hidden = true;
  tocEl.hidden = tocScrim.hidden = true;
  flow.textContent = '';
  renderLibrary();
}
$('btn-shelf').addEventListener('click', closeBook);

// Render spine chapter i; land on `page` (Infinity = last), or at `frac` of the
// chapter. `anim` = ±1 slides the fresh chapter in from that direction.
async function showChapter(i, { page = 0, frac = null, anim = 0 } = {}) {
  const html = await cur.epub.loadChapter(i);
  cur.chapter = i;
  flow.style.transition = 'none';
  flow.innerHTML = html;
  // wait for images (blob: URLs, so quick) — they change the column count
  await Promise.all([...flow.querySelectorAll('img')].map((im) => im.decode ? im.decode().catch(() => {}) : 0));
  layout();
  let p = frac != null ? Math.round(frac * cur.pageCount) : page;
  p = Math.max(0, Math.min(cur.pageCount - 1, p));
  if (anim) {
    flow.style.transform = `translateX(${-p * cur.step + anim * cur.step}px)`;
    flow.getBoundingClientRect(); // flush so the transition below animates
    setPage(p);
  } else {
    setPage(p, { instant: true });
  }
}

// measure the column strip → page step + count
function layout() {
  const w = viewport.clientWidth;
  flow.style.columnWidth = w + 'px';
  flow.style.columnGap = GAP + 'px';
  cur.step = w + GAP;
  cur.pageCount = Math.max(1, Math.round((flow.scrollWidth + GAP) / cur.step));
}

function setPage(p, { instant = false } = {}) {
  cur.page = Math.max(0, Math.min(cur.pageCount - 1, p));
  flow.style.transition = instant ? 'none' : 'transform 0.28s ease-out';
  flow.style.transform = `translateX(${-cur.page * cur.step}px)`;
  pagenoEl.textContent = `${cur.page + 1} / ${cur.pageCount}`;
  hudInfo.textContent = `第 ${cur.chapter + 1}/${cur.epub.spine.length} 章 · 本页 ${cur.page + 1}/${cur.pageCount}`;
  saveProgress();
}

// flip by one page; crossing a chapter edge loads the neighbour chapter
async function turn(dir) {
  if (turning) return;
  const t = cur.page + dir;
  if (t >= 0 && t < cur.pageCount) { setPage(t); return; }
  const s = cur.chapter + dir;
  if (s < 0 || s >= cur.epub.spine.length) { setPage(cur.page); return; } // book edge
  turning = true;
  try { await showChapter(s, { page: dir > 0 ? 0 : Infinity, anim: dir }); }
  finally { turning = false; }
}

// ---- last-read spot: {spine, frac within chapter} + overall % for the shelf ----
let saveTimer;
function saveProgress() {
  if (!cur) return;
  const { book, chapter, page, pageCount, epub } = cur;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbPut('progress', {
      id: book.id,
      spine: chapter,
      frac: pageCount > 1 ? page / pageCount : 0,
      pct: Math.min(100, Math.round(((chapter + (page + 1) / pageCount) / epub.spine.length) * 100)),
      updatedAt: Date.now(),
    });
  }, 250);
}

// ---- gestures: swipe-follow flip (iOS Books style) + tap zones ----
let drag = null;
gesture.addEventListener('pointerdown', (e) => {
  if (!cur || turning) return;
  drag = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false };
  gesture.setPointerCapture(e.pointerId);
});
gesture.addEventListener('pointermove', (e) => {
  if (!cur || !drag) return;
  let dx = e.clientX - drag.x0;
  if (!drag.moved && Math.abs(dx) < 8) return;
  drag.moved = true;
  // rubber-band at the very start/end of the book
  const atStart = cur.chapter === 0 && cur.page === 0;
  const atEnd = cur.chapter === cur.epub.spine.length - 1 && cur.page === cur.pageCount - 1;
  if ((atStart && dx > 0) || (atEnd && dx < 0)) dx /= 3;
  flow.style.transition = 'none';
  flow.style.transform = `translateX(${-cur.page * cur.step + dx}px)`;
});
gesture.addEventListener('pointerup', (e) => {
  if (!cur || !drag) return;
  const dx = e.clientX - drag.x0;
  const dt = performance.now() - drag.t0;
  const wasDrag = drag.moved;
  drag = null;
  if (!wasDrag) { tapAt(e.clientX, e.clientY); return; }
  const flick = Math.abs(dx) > 60 || (Math.abs(dx) > 24 && dt < 260);
  if (!flick) { setPage(cur.page); return; }
  readerEl.classList.remove('hud-open');
  turn(dx < 0 ? 1 : -1);
});
gesture.addEventListener('pointercancel', () => {
  if (cur && drag && drag.moved) setPage(cur.page);
  drag = null;
});

function tapAt(x, y) {
  // a tap on an in-book link (footnote / TOC page) jumps to its chapter
  const link = document.elementsFromPoint(x, y).find((el) => el.dataset && el.dataset.epubPath);
  if (link) {
    const s = cur.epub.pathToSpine(link.dataset.epubPath);
    if (s >= 0) { showChapter(s); return; }
  }
  const w = gesture.clientWidth;
  if (x < w * 0.3) { readerEl.classList.remove('hud-open'); turn(-1); }
  else if (x > w * 0.7) { readerEl.classList.remove('hud-open'); turn(1); }
  else readerEl.classList.toggle('hud-open');
}

// ---- HUD: chapters, TOC, font size ----
$('btn-prev-ch').addEventListener('click', () => cur.chapter > 0 && showChapter(cur.chapter - 1));
$('btn-next-ch').addEventListener('click', () => cur.chapter < cur.epub.spine.length - 1 && showChapter(cur.chapter + 1));

$('btn-toc').addEventListener('click', async () => {
  if (!cur.toc) cur.toc = await cur.epub.toc();
  tocList.textContent = '';
  if (!cur.toc.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '本书没有目录';
    tocList.appendChild(p);
  }
  // highlight the entry we're inside: the last one at or before the current chapter
  let curIdx = -1;
  cur.toc.forEach((t, i) => { if (t.spine <= cur.chapter) curIdx = i; });
  cur.toc.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'toc-item' + (i === curIdx ? ' current' : '');
    b.type = 'button';
    b.textContent = t.label;
    b.addEventListener('click', () => {
      tocEl.hidden = tocScrim.hidden = true;
      readerEl.classList.remove('hud-open');
      showChapter(t.spine);
    });
    tocList.appendChild(b);
  });
  tocEl.hidden = tocScrim.hidden = false;
});
tocScrim.addEventListener('click', () => { tocEl.hidden = tocScrim.hidden = true; });

function applyFont() {
  document.documentElement.style.setProperty('--reader-font', fontSize + 'px');
}
function bumpFont(d) {
  fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, fontSize + d));
  localStorage.setItem('reader-font', fontSize);
  applyFont();
  if (cur) relayoutKeepingSpot();
}
$('btn-font-dec').addEventListener('click', () => bumpFont(-2));
$('btn-font-inc').addEventListener('click', () => bumpFont(2));

// ---- theme picker (shared/theme.js) ----
const settingsPop = $('settings-pop'), btnTheme = $('btn-theme');
$('theme-mount').appendChild(window.Theme.buildPicker());
function closeSettings() { settingsPop.hidden = true; btnTheme.classList.remove('on'); }
btnTheme.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPop.hidden = !settingsPop.hidden;
  btnTheme.classList.toggle('on', !settingsPop.hidden);
});
// tap anywhere outside the popover (or on a swatch) dismisses it
settingsPop.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!settingsPop.hidden) closeSettings(); });
window.Theme.onChange(closeSettings);

// font-size / viewport changes reflow the columns — keep the reading spot by fraction
function relayoutKeepingSpot() {
  const frac = cur.pageCount > 1 ? cur.page / cur.pageCount : 0;
  layout();
  setPage(Math.round(frac * cur.pageCount), { instant: true });
}
addEventListener('resize', () => { if (cur && !readerEl.hidden) relayoutKeepingSpot(); });

// test hook: current reading position (no behaviour attached)
Object.defineProperty(window, '__reader', {
  value: { get pos() { return cur && { chapter: cur.chapter, page: cur.page, pageCount: cur.pageCount }; } },
});

applyFont();
renderLibrary();
