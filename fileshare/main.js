// 文件共享助手 — orchestrator. Pairs two devices (QR scan OR 9-char code), opens a WebRTC link, and
// moves files peer-to-peer. The signaling server only brokers the handshake (see signaling.js); files
// travel device-to-device, encrypted (rtc.js). Received files are offered as a browser download so on
// iOS they land in Files → Downloads.
import { Signaling } from './signaling.js';
import { PeerLink } from './rtc.js';
import { RelayLink } from './relay.js';
import { drawQR } from './qr.js';
import { makeZip } from './zip.js';
import { deleteFile, pruneOld } from './recv-store.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['offline', 'landing', 'host', 'code', 'scan', 'transfer'];
function showView(name) { for (const v of VIEWS) $('view-' + v).hidden = v !== name; }

// Don't let app-nav.js's background SW-update reload the page while a share session is live — that
// would drop the pairing / interrupt a transfer (this page has none of the generic "busy" markers).
window.appBusy = () => !!(link || session);

const sig = new Signaling();
let link = null;          // PeerLink once paired
let joining = false;      // a join is in flight (blocks duplicate submits until peer/error)
let myRoom = null;        // code we're hosting
let pendingJoin = null;   // code to auto-join once the socket opens
let session = null;       // { room, role, token, relay } — the live pairing; survives signaling reconnects
let lastRepair = 0;       // debounce fs-repair so a flapping RTC link can't spam the server
let rtcFails = 0;         // consecutive P2P attempts that never connected (this session)
let lastTrouble = 0;      // debounce rtcTrouble ('failed' + 'channelclose' fire for one death)
let linkWatch = 0;        // watchdog: P2P must open within this timer or it counts as a failure

// ---- helpers --------------------------------------------------------------
const onlyCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9);
const groupCode = (c) => c.replace(/(.{3})(.{3})(.{3})/, '$1-$2-$3');
// Pull a 9-char code out of a scanned URL/text (#r=CODE, ?r=CODE, or a bare code).
// A scanned string that IS a URL is judged ONLY by its r= parameter: stripping the punctuation out of
// "https://example.com/" happens to leave nine characters ("HTTPSEXAM"), and treating that as a pairing
// code would send the user chasing a room that never existed.
function extractCode(text) {
  const raw = String(text || '').trim();
  try {
    const u = new URL(raw);
    const h = onlyCode(new URLSearchParams(u.hash.slice(1)).get('r') || u.searchParams.get('r'));
    return h.length === 9 ? h : '';
  } catch { /* not a URL — fall through to the bare-code reading */ }
  const c = onlyCode(raw);
  return c.length === 9 ? c : '';
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtRate(bps) { return fmtBytes(Math.max(0, bps)) + '/s'; }
function fmtEta(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  if (sec < 60) return '剩余 ' + sec + ' 秒';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return '剩余 ' + m + ' 分 ' + String(s).padStart(2, '0') + ' 秒';
  const h = Math.floor(m / 60);
  return '剩余 ' + h + ' 小时 ' + (m % 60) + ' 分';
}

// ---- keep the screen awake while a share session is live -------------------
// A sleeping device drops the WebSocket AND the DataChannel mid-transfer; the Screen Wake
// Lock API prevents that (Safari 16.4+, Chromium incl. 华为浏览器). Best-effort — devices
// without it just keep their normal sleep timers. iOS can DENY a request (Low Power Mode,
// no user gesture) or RELEASE a held lock at any moment while the page stays visible, so a
// single request isn't enough: re-acquire on release, retry on a slow ticker, and treat any
// tap as a fresh user-gesture chance to acquire.
let wakeLock = null;      // the held sentinel, if any
let wantAwake = false;    // whether a share session wants the screen held on
let wakeAcquiring = false;
let wakeRetry = 0;
async function acquireWake() {
  if (!wantAwake || wakeLock || wakeAcquiring || document.hidden || !('wakeLock' in navigator)) return;
  wakeAcquiring = true;
  try {
    const w = await navigator.wakeLock.request('screen');
    if (!wantAwake) { w.release().catch(() => {}); return; }
    wakeLock = w;
    w.addEventListener('release', () => {
      if (wakeLock === w) wakeLock = null;
      if (wantAwake && !document.hidden) setTimeout(acquireWake, 1000);
    });
  } catch { /* denied — the ticker / next tap retries */ }
  finally { wakeAcquiring = false; }
}
function keepAwake(on) {
  wantAwake = !!on;
  if (on) {
    acquireWake();
    if (!wakeRetry) wakeRetry = setInterval(acquireWake, 20000);
  } else {
    clearInterval(wakeRetry); wakeRetry = 0;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
}
// the OS auto-releases the lock whenever the page hides; re-grab it on return. Taps double
// as user-gesture retries for browsers that reject gesture-less requests.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  acquireWake();
  // only bother checking the link if we were away long enough for iOS to have suspended us
  if (session && Date.now() - hiddenAt > 1500) verifyLive();
});
window.addEventListener('touchend', () => { acquireWake(); }, { passive: true });
window.addEventListener('click', () => { acquireWake(); });

// ---- connection status ----------------------------------------------------
function setConn(s) { const el = $('conn'); el.className = 'conn ' + s; el.title = { on: '已连接', off: '未连接', connecting: '连接中…' }[s]; }
sig.addEventListener('open', () => {
  setConn('on');
  // The socket (re)connected. If we're mid-session, re-attach to our room so a screen-lock /
  // background drop doesn't end the share — the server rebuilds the link if both peers are back.
  if (session) sig.resume(session.room, session.role, session.token);
  else if (pendingJoin) { sig.join(pendingJoin); pendingJoin = null; }
});
sig.addEventListener('close', () => setConn('off'));

// ---- foreground liveness: heal a dropped / half-open socket on return ---------------------------
// iOS suspends a backgrounded PWA and can leave its WebSocket reading OPEN but actually dead (a
// screen-lock, or the save/share sheet covering the app). On return-to-foreground we ping; if no
// fs-pong lands in time we force a fresh socket, whose 'open' triggers sig.resume() to rebuild the
// session (the server holds the room for the grace window). Brief hides are ignored to avoid churn.
let pongTimer = 0;
let hiddenAt = 0;
sig.addEventListener('fs-pong', () => { clearTimeout(pongTimer); pongTimer = 0; });
function verifyLive() {
  if (!session) return;
  if (!(sig.ws && sig.ws.readyState === WebSocket.OPEN)) { sig.reconnect(); return; }
  clearTimeout(pongTimer);
  sig.ping();
  pongTimer = setTimeout(() => { pongTimer = 0; if (session) sig.reconnect(); }, 2500);
}

// ---- pairing: signaling events -------------------------------------------
sig.addEventListener('fs-created', (e) => { myRoom = e.detail.room; showHost(myRoom); });
sig.addEventListener('fs-peer', (e) => establishLink(e.detail));
sig.addEventListener('fs-error', (e) => onPairError(e.detail.code));
sig.addEventListener('fs-peer-gone', () => onPeerGone());
// The peer's socket dropped (lock/background) but the session lives — wait for it to come back.
sig.addEventListener('fs-peer-stale', () => { if (link) { $('link-status').textContent = '对方暂时离开，等待重连…'; setPickersEnabled(false); } });
// The host gave up on P2P (rtcTrouble) and switched to the server relay — follow it.
sig.addEventListener('fs-signal', (e) => { if (e.detail.data && e.detail.data.relayStart && session) switchToRelay(false); });

function showHost(code) {
  // Pure black at high resolution: the canvas is CSS-downscaled to 240px, and a smooth
  // downscale of a hi-res code stays crisply decodable (a pixelated NON-integer downscale
  // distorted module widths — iPhone's detector coped, Huawei's 扫一扫 didn't).
  drawQR($('qr'), location.origin + location.pathname + '#r=' + code, { scale: 12, dark: '#000000', light: '#ffffff' });
  $('code-display').textContent = groupCode(code);
  $('host-status').textContent = '等待对方加入…';
  showView('host');
}

const PAIR_ERR = { gone: '配对码无效或已过期', full: '该共享已被占用', rate: '尝试过于频繁，请稍后再试', expired: '配对码已过期，请重新创建', bad: '配对码格式不正确' };
function onPairError(code) {
  if (link) return; // already paired — ignore a stray/late error (e.g. a duplicate join racing in)
  joining = false;  // let the user retry
  const msg = PAIR_ERR[code] || '配对失败';
  if (!$('view-code').hidden) { const el = $('code-error'); el.textContent = msg; el.hidden = false; }
  else if (!$('view-host').hidden && code === 'expired') { myRoom = null; $('host-status').textContent = msg; }
  else { showView('landing'); }
}

// The session truly ended (explicit leave or the grace window expired). Tear down for real.
function onPeerGone() {
  session = null;
  rtcFails = 0;
  clearTimeout(linkWatch);
  keepAwake(false);
  if (link) { link.close(); link = null; }
  showView('landing');
}

// If our P2P link drops while signaling is still up (NAT rebind, etc.), the host asks the server to
// re-issue the pairing so both sides rebuild. A signaling-socket drop instead recovers via fs-resume
// on reconnect, so we only act while the socket is open. Debounced against a flapping link.
function maybeRecover() {
  if (!session) return;
  if (!(sig.ws && sig.ws.readyState === WebSocket.OPEN)) return; // socket down → fs-resume will rebuild
  if (session.role !== 'host') return; // only the impolite peer re-offers (avoids dueling rebuilds)
  const now = Date.now();
  if (now - lastRepair < 4000) return;
  lastRepair = now;
  sig.repair();
}

// ---- the WebRTC link + transfer UI ---------------------------------------
// Build (or REBUILD) the peer link. Called on the initial pairing and again on every resume/repair —
// the server re-sends fs-peer to mean "establish RTC now", so we always replace any prior transport
// with a fresh RTCPeerConnection. The transfer history is preserved across a rebuild (recovery), and
// only reset when a brand-new session starts.
function establishLink({ polite, room, role, token }) {
  joining = false;
  if (room) {
    const keepRelay = !!(session && session.room === room && session.relay);
    session = { room, role, token, relay: keepRelay };
  }
  // A session already downgraded to the server relay stays there (P2P provably doesn't work
  // on this network) — rebuild the relay transport instead of trying RTC again.
  if (session && session.relay) { switchToRelay(session.role === 'host'); return; }
  keepAwake(true);
  const fresh = !link;
  if (link) { link.close(); link = null; } // drop the dead transport before building the new one
  const l = link = new PeerLink(sig, { polite });
  if (fresh) { resetLists(); rtcFails = 0; }
  $('link-status').textContent = '正在建立直连…';
  setPickersEnabled(false);
  showView('transfer');

  // P2P must reach 'open' within the watchdog window, else it counts as a failed attempt —
  // networks with client isolation never fire 'failed' quickly (ICE just times out slowly).
  clearTimeout(linkWatch);
  linkWatch = setTimeout(() => { if (link === l && !l._openFired) rtcTrouble(); }, 14000);

  // Each handler ignores events from a superseded link (l !== link) so a rebuild's teardown of the old
  // PeerLink can't fire channelclose and bounce us to the landing view.
  l.addEventListener('open', () => {
    if (link !== l) return;
    clearTimeout(linkWatch);
    rtcFails = 0;
    $('link-status').textContent = '已连接，可互传文件（点对点直连）';
    setPickersEnabled(true);
  });
  l.addEventListener('peerstate', (e) => {
    if (link !== l) return;
    if (e.detail === 'disconnected') { $('link-status').textContent = '连接中断，重连中…'; setPickersEnabled(false); } // ICE may self-heal — wait
    else if (e.detail === 'failed') rtcTrouble(); // terminal → rebuild or downgrade
  });
  l.addEventListener('channelclose', () => { if (link === l) rtcTrouble(); });
  wireTransfer(l);
}

// A P2P attempt died (ICE failed / channel closed / never opened). Retry once via a server
// re-pair; if that also can't connect, this network can't do P2P (AP isolation, symmetric NAT
// with no reachable STUN…) — the host downgrades BOTH sides to the server relay.
function rtcTrouble() {
  if (!session || session.relay) return;
  const now = Date.now();
  if (now - lastTrouble < 3000) return;   // 'failed' + 'channelclose' fire for one death
  lastTrouble = now;
  rtcFails++;
  $('link-status').textContent = '连接中断，重连中…';
  setPickersEnabled(false);
  if (rtcFails >= 2) {
    if (session.role === 'host') switchToRelay(true);
    // the guest waits: the host's own trouble path sends relayStart
  } else {
    maybeRecover();
  }
}

// Swap the transport for the server relay (fs-signal carries the bytes; see relay.js).
// `initiate` = we are the host deciding the downgrade → tell the guest to follow.
function switchToRelay(initiate) {
  if (!session) return;
  session.relay = true;
  clearTimeout(linkWatch);
  if (initiate) sig.signal({ relayStart: 1 });
  if (link instanceof RelayLink) return;      // already relaying — keep the live transport
  keepAwake(true);
  if (link) { link.close(); link = null; }
  const l = link = new RelayLink(sig);
  $('link-status').textContent = '直连失败，切换服务器中转…';
  setPickersEnabled(false);
  showView('transfer');
  l.addEventListener('open', () => { if (link === l) { $('link-status').textContent = '已连接 · 服务器中转（速度较慢）'; setPickersEnabled(true); } });
  wireTransfer(l);
}

// Transfer events are identical for both transports.
function wireTransfer(l) {
  // outgoing
  l.addEventListener('queued', (e) => addItem('out', e.detail.id, e.detail.name, e.detail.size));
  l.addEventListener('sent', (e) => completeItem('out', e.detail.id));
  l.addEventListener('sendfail', (e) => failItem('out', e.detail.id));
  // incoming
  l.addEventListener('incoming', (e) => addItem('in', e.detail.id, e.detail.name, e.detail.size));
  l.addEventListener('received', (e) => receiveItem(e.detail));
  // both directions report progress
  l.addEventListener('progress', (e) => updateProgress(e.detail.dir, e.detail.id, e.detail.done, e.detail.total));
}

function setPickersEnabled(on) { $('pick-files').disabled = !on; $('dropzone').classList.toggle('disabled', !on); }

// ---- transfer list rendering ---------------------------------------------
const itemEls = { out: new Map(), in: new Map() };
const received = new Map(); // id → { name, blob } for every SMALL received file (the batch-save pool)
const savedIds = new Set(); // received ids the user has already saved (→ dim the row, uncheck it)
const rateStats = new Map(); // `${dir}:${id}` → { last, lastDone, bps } for live speed/ETA
const idbIds = new Set();    // ids of LARGE received files streamed to IndexedDB (for cleanup)
const clearSentBtn = $('clear-sent');
function resetLists() {
  for (const dir of ['out', 'in']) { itemEls[dir].clear(); $(dir + '-list').innerHTML = '<li class="empty muted">暂无</li>'; }
  received.clear();
  savedIds.clear();
  rateStats.clear();
  // A brand-new pairing clears the receive list, so last session's streamed files can no longer be
  // saved from the UI — drop them from IndexedDB to reclaim space.
  for (const id of idbIds) deleteFile(id).catch(() => {});
  idbIds.clear();
  refreshClearSent();
  refreshInActions();
}
// show the 清除已发送 action once at least one send has finished (completed or failed)
function refreshClearSent() { clearSentBtn.hidden = ![...itemEls.out.values()].some((li) => li.classList.contains('finished')); }
clearSentBtn.addEventListener('click', () => {
  for (const [id, li] of [...itemEls.out]) if (li.classList.contains('finished')) { li.remove(); itemEls.out.delete(id); }
  if (!itemEls.out.size) $('out-list').innerHTML = '<li class="empty muted">暂无</li>';
  refreshClearSent();
});
function addItem(dir, id, name, size) {
  const list = $(dir + '-list');
  const empty = list.querySelector('.empty'); if (empty) empty.remove();
  const li = document.createElement('li'); li.className = 'item';
  li.innerHTML = `<span class="fname"></span><div class="fmeta"><span class="pct">0%</span><span class="rate"></span><span class="size">${fmtBytes(size)}</span></div><div class="bar"><span></span></div>`;
  li.querySelector('.fname').textContent = name;
  list.appendChild(li); itemEls[dir].set(id, li);
}
function updateProgress(dir, id, done, total) {
  const li = itemEls[dir].get(id); if (!li) return;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  li.querySelector('.bar > span').style.width = pct + '%';
  li.querySelector('.pct').textContent = pct + '%';
  // Live transfer speed + ETA, sampled ~4×/s and EMA-smoothed so the number doesn't jitter.
  const key = dir + ':' + id;
  const now = performance.now();
  let st = rateStats.get(key);
  if (!st) { rateStats.set(key, { last: now, lastDone: done, bps: 0 }); return; }
  const dt = now - st.last;
  if (dt < 250) return;
  const inst = (done - st.lastDone) / (dt / 1000);
  st.bps = st.bps ? st.bps * 0.7 + inst * 0.3 : inst;
  st.last = now; st.lastDone = done;
  const rate = li.querySelector('.rate'); if (!rate) return;
  rate.textContent = (done < total && st.bps > 0) ? `${fmtRate(st.bps)} · ${fmtEta((total - done) / st.bps)}` : '';
}
function clearRate(dir, id) { rateStats.delete(dir + ':' + id); const li = itemEls[dir].get(id); const r = li && li.querySelector('.rate'); if (r) r.textContent = ''; }
function completeItem(dir, id) { const li = itemEls[dir].get(id); if (!li) return; clearRate(dir, id); li.querySelector('.bar').classList.add('done'); li.querySelector('.bar > span').style.width = '100%'; li.querySelector('.pct').textContent = '已发送'; if (dir === 'out') { li.classList.add('finished'); refreshClearSent(); } }
function failItem(dir, id) { const li = itemEls[dir].get(id); if (!li) return; clearRate(dir, id); li.querySelector('.pct').textContent = '失败'; if (dir === 'out') { li.classList.add('finished'); refreshClearSent(); } }
// ---- saving a LARGE received file ----------------------------------------------------------------
// A file over INLINE_MAX has no blob: its bytes are in IndexedDB and only the service worker can serve
// them back, at /fileshare/dl/<id>. How the page ASKS for that URL decides whether the worker is
// consulted at all — Chromium issues an <a download> from the browser-process download manager, which
// never consults the service worker, so the request reached the origin server, took its 404, and the
// browser reported "No file" on a transfer that plainly succeeded. WebKit routes the same link through
// the worker, which is why this shipped working on iPad and broken on every desktop Chromium browser.
//
// So where the File System Access API exists — desktop Chromium, exactly where the link is broken — the
// download manager is skipped entirely: ask for a real save location, then stream the worker's response
// body to disk. The bytes never accumulate in memory, nothing is handed to a background download, and
// on a PC it is the plain "save this file" the user wants rather than a share sheet.
const dlUrl = (id) => new URL('dl/' + id, import.meta.url).href;   // resolved against this module, so a
// page reached without its trailing slash can't turn dl/<id> into /dl/<id>, which the route would miss.
const PLAIN_DOWNLOAD_REACHES_SW = /^((?!chrome|chromium|crios|edg|android).)*safari/i.test(navigator.userAgent);

// Resolves true if the file was written, false if the user dismissed the save dialog; throws if the
// worker could not serve the file, so the row can say so instead of silently doing nothing.
async function saveToDisk(picked, id) {
  let handle;
  try { handle = await picked; }
  catch (e) {
    if (e && e.name === 'AbortError') return false;        // dialog dismissed
    throw e;
  }
  const res = await fetch(dlUrl(id));
  if (!res.ok || !res.body) throw new Error('dl ' + res.status);
  await res.body.pipeTo(await handle.createWritable());
  return true;
}

function receiveItem({ id, name, blob, error }) {
  const li = itemEls.in.get(id); if (!li) return;
  clearRate('in', id);
  if (error) { li.querySelector('.pct').textContent = '接收失败'; li.classList.add('recv-fail'); return; }
  li.querySelector('.bar').classList.add('done'); li.querySelector('.bar > span').style.width = '100%'; li.querySelector('.pct').textContent = '已接收';

  // Large files streamed to IndexedDB have no in-memory blob: save them via the service-worker
  // attachment stream (memory-safe, writes straight to disk), and skip the batch checkbox — batching
  // zips/shares in memory, which is exactly what we avoid for big files.
  if (!blob) {
    idbIds.add(id);
    const a = document.createElement('a'); a.className = 'dl'; a.href = dlUrl(id); a.textContent = '保存';
    // Safari's original <a download> path reaches the worker. Elsewhere without a file picker (for
    // example Chromium on Android), leave `download` off: a normal navigation reaches the worker and
    // its Content-Disposition header turns that navigation into a download without leaving the page.
    if (window.showSaveFilePicker || PLAIN_DOWNLOAD_REACHES_SW) a.download = name;
    a.addEventListener('click', (e) => {
      // No picker: allow either Safari's known-good download link or the normal-navigation fallback.
      if (!window.showSaveFilePicker) { markSaved(id); return; }
      e.preventDefault();
      a.classList.remove('save-fail');
      // Called synchronously so it still counts as inside the click gesture.
      let picked;
      try { picked = window.showSaveFilePicker({ suggestedName: name }); }
      catch (err) { picked = Promise.reject(err); }
      a.textContent = '保存中…';
      saveToDisk(picked, id)
        .then((saved) => { a.textContent = '保存'; if (saved) markSaved(id); })
        .catch(() => { a.textContent = '保存失败'; a.classList.add('save-fail'); });
    });
    li.appendChild(a);
    return;
  }

  received.set(id, { name, blob });

  // checkbox + filename in one tappable row → drives the multi-select batch download
  const fname = li.querySelector('.fname');
  const head = document.createElement('label'); head.className = 'recv-head';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'pick'; cb.checked = true;
  cb.addEventListener('change', refreshInActions);
  li.insertBefore(head, fname); head.appendChild(cb); head.appendChild(fname);

  // keep a per-file one-tap save too (single download within the click gesture — iOS-safe)
  const a = document.createElement('a'); a.className = 'dl'; a.href = URL.createObjectURL(blob); a.download = name; a.textContent = '保存';
  a.addEventListener('click', () => markSaved(id)); // the download still proceeds; just flag it saved
  li.appendChild(a);
  refreshInActions();
}

// mark a received file as saved: dim the row, flip its 保存 to a confirmed state, and drop it from
// the batch selection so 全选/打包 default to what you HAVEN'T saved yet.
function markSaved(id) {
  if (savedIds.has(id)) return;
  savedIds.add(id);
  const li = itemEls.in.get(id); if (!li) return;
  li.classList.add('saved');
  const cb = li.querySelector('.pick'); if (cb) cb.checked = false;
  const a = li.querySelector('a.dl'); if (a) { a.classList.add('saved'); a.textContent = '已保存 ✓'; }
  refreshInActions();
}

// ---- received-files panel: select-all → save to Photos/Files (mobile) or .zip (desktop) ----
// iOS can't put a .zip into the Photo Library, but the native share sheet accepts MANY files at once
// and offers "存储 N 张图像" (→ Photos) for images and "存储到文件" for the rest — i.e. the files arrive
// separately, in one tap. So we prefer Web Share where it can share files (mobile), and fall back to a
// single .zip on desktop, where Photos doesn't exist and one download beats N.
// Desktop Chromium also reports canShare({files}) === true — Windows has a share sheet — but on a PC
// "保存到相册 / 分享" is the wrong offer: there is no photo library, and the user wants the file on disk.
// So the share path is limited to touch devices, where it is the ONLY way to reach Photos; a PC gets
// the plain save (each row's 保存, or 打包 .zip for a multi-file selection).
const isHandheld = matchMedia('(pointer: coarse) and (hover: none)').matches;
const canShareFiles = isHandheld && (() => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob([1])], 'p.bin')] })); }
  catch { return false; }
})();
if (canShareFiles) $('share-selected').hidden = false;

function refreshInActions() {
  const actions = $('in-actions');
  // The batch bar earns its place only when it does something a single row's 保存 can't: bundle ≥2
  // files into one .zip (desktop) or reach Photos via the share sheet (mobile). A lone received file
  // on desktop is handled entirely by its own 保存 — so no duplicate 下载 button appears.
  const showBatch = received.size > 0 && (received.size >= 2 || canShareFiles);
  actions.hidden = !showBatch;
  if (!showBatch) return;
  const picks = [...received.keys()].map((id) => itemEls.in.get(id)?.querySelector('.pick')).filter(Boolean);
  const checked = picks.filter((c) => c.checked).length;
  const all = $('sel-all'); all.checked = checked > 0 && checked === picks.length; all.indeterminate = checked > 0 && checked < picks.length;
  const n = checked > 1 ? ` (${checked})` : '';
  const zip = $('save-selected'); zip.disabled = checked < 2; zip.textContent = '打包 .zip' + n; // only bundles ≥2
  const share = $('share-selected'); share.disabled = checked === 0; share.textContent = '保存到相册 / 分享' + n;
}
function selectedIds() {
  const out = [];
  for (const id of received.keys()) { const cb = itemEls.in.get(id)?.querySelector('.pick'); if (cb && cb.checked) out.push(id); }
  return out;
}
function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function zipName() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `文件共享_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.zip`;
}
$('sel-all').addEventListener('change', (e) => {
  for (const id of received.keys()) { const cb = itemEls.in.get(id)?.querySelector('.pick'); if (cb) cb.checked = e.target.checked; }
  refreshInActions();
});
// Mobile: hand the selected files to the OS share sheet — keep them as distinct files (→ Photos/Files).
// Build the File[] synchronously so navigator.share() still runs inside the click gesture.
$('share-selected').addEventListener('click', async () => {
  const ids = selectedIds();
  if (!ids.length) return;
  const picks = ids.map((id) => received.get(id));
  const files = picks.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/octet-stream' }));
  try { await navigator.share({ files }); ids.forEach(markSaved); }
  catch (e) { if (e && e.name !== 'AbortError') { triggerDownload(picks.length === 1 ? picks[0].blob : await makeZip(picks), picks.length === 1 ? picks[0].name : zipName()); ids.forEach(markSaved); } }
});
// Desktop: bundle the selected files into one .zip (single files are saved from their own row).
$('save-selected').addEventListener('click', async () => {
  const ids = selectedIds();
  if (ids.length < 2) return; // a lone file uses its row's 保存 — this button only bundles
  const picks = ids.map((id) => received.get(id));
  const btn = $('save-selected'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = '打包中…';
  try { triggerDownload(await makeZip(picks), zipName()); ids.forEach(markSaved); }
  finally { btn.textContent = label; refreshInActions(); }
});

// ---- file picking / drag-drop --------------------------------------------
function sendFiles(files) { if (!link) return; for (const f of files) link.send(f); }
$('pick-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { sendFiles(e.target.files); e.target.value = ''; });
const dz = $('dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return; dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files); });

$('disconnect').addEventListener('click', () => { sig.leave(); session = null; keepAwake(false); if (link) { link.close(); link = null; } showView('landing'); });

// ---- landing buttons ------------------------------------------------------
$('btn-host').addEventListener('click', () => { if (sig.ws && sig.ws.readyState === WebSocket.OPEN) sig.create(); });
$('btn-code').addEventListener('click', () => { $('code-error').hidden = true; clearCode(); showView('code'); setTimeout(() => boxes[0] && boxes[0].focus(), 50); });
$('host-cancel').addEventListener('click', () => { sig.leave(); myRoom = null; session = null; keepAwake(false); showView('landing'); });
$('code-back').addEventListener('click', () => showView('landing'));
$('code-join').addEventListener('click', submitCode);

function submitCode() {
  if (link || joining) return; // guard against double-submit (auto-fire on last box + the 加入 button)
  const code = boxes.map((b) => b.value).join('');
  if (onlyCode(code).length !== 9) { const el = $('code-error'); el.textContent = '请输入完整的 9 位配对码'; el.hidden = false; return; }
  $('code-error').hidden = true;
  joining = true;
  if (sig.ws && sig.ws.readyState === WebSocket.OPEN) sig.join(code); else pendingJoin = code;
}

// ---- the 9-box (3×3) code input ------------------------------------------
let boxes = [];
function buildCodeInput() {
  const container = $('code-input'); container.innerHTML = ''; boxes = [];
  for (let g = 0; g < 3; g++) {
    const grp = document.createElement('div'); grp.className = 'grp';
    for (let i = 0; i < 3; i++) {
      const inp = document.createElement('input');
      inp.maxLength = 1; inp.autocomplete = 'off'; inp.spellcheck = false;
      inp.setAttribute('autocapitalize', 'characters'); inp.inputMode = 'text';
      grp.appendChild(inp); boxes.push(inp);
    }
    container.appendChild(grp);
    if (g < 2) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '-'; container.appendChild(sep); }
  }
  boxes.forEach((inp, idx) => {
    inp.addEventListener('input', () => {
      const v = onlyCode(inp.value); inp.value = v.slice(-1) || '';
      if (inp.value && idx < 8) boxes[idx + 1].focus();
      if (boxes.every((b) => b.value)) submitCode();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && idx > 0) { boxes[idx - 1].focus(); boxes[idx - 1].value = ''; e.preventDefault(); }
      else if (e.key === 'Enter') submitCode();
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault(); const txt = onlyCode((e.clipboardData || window.clipboardData).getData('text'));
      fillCode(txt); if (txt.length === 9) submitCode(); else if (txt.length) boxes[Math.min(txt.length, 8)].focus();
    });
  });
}
function fillCode(code) { for (let i = 0; i < 9; i++) boxes[i].value = code[i] || ''; }
function clearCode() { fillCode(''); }

// ---- in-app QR scan ----
// Decodes the host's QR straight from the camera so no external scanner is needed. Uses the native
// BarcodeDetector where present (Android/desktop Chrome); falls back to the vendored jsQR decoder
// (jsqr.js → window.jsQR) on browsers without it — notably iOS Safari. Needs HTTPS + a user gesture
// (the button) for camera access; works best opened in a Safari tab rather than a standalone PWA.
let scanStream = null, scanRAF = null, scanCanvas = null;
const canScan = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
  (('BarcodeDetector' in window) || typeof window.jsQR === 'function');
if (canScan) {
  $('btn-scan').hidden = false;
  $('btn-scan').addEventListener('click', startScan);
  $('scan-cancel').addEventListener('click', stopScan);
}
async function startScan() {
  showView('scan'); $('scan-status').textContent = '正在打开摄像头…';
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('scan-video'); v.srcObject = scanStream; v.setAttribute('playsinline', ''); await v.play();
    $('scan-status').textContent = '将二维码对准取景框…';
    const detector = ('BarcodeDetector' in window) ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    if (!detector) scanCanvas = document.createElement('canvas');
    const tick = async () => {
      if (!scanStream) return; // stopped
      let raw = null;
      try {
        if (detector) { const codes = await detector.detect(v); if (codes.length) raw = codes[0].rawValue; }
        else if (v.videoWidth) {
          scanCanvas.width = v.videoWidth; scanCanvas.height = v.videoHeight;
          const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
          const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (res) raw = res.data;
        }
      } catch {}
      if (raw) { const code = extractCode(raw); if (code) { stopScan(); doJoin(code); return; } }
      scanRAF = requestAnimationFrame(tick);
    };
    scanRAF = requestAnimationFrame(tick);
  } catch { $('scan-status').textContent = '无法打开摄像头，请改用配对码'; }
}
function stopScan() {
  if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = null; }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  scanCanvas = null;
  if (!$('view-scan').hidden) showView('landing');
}
function doJoin(code) { if (link || joining) return; joining = true; if (sig.ws && sig.ws.readyState === WebSocket.OPEN) sig.join(code); else pendingJoin = code; }

// ---- boot -----------------------------------------------------------------
function boot() {
  buildCodeInput();
  pruneOld().catch(() => {}); // reclaim IndexedDB space from files a prior session never cleaned up
  if (!navigator.onLine) { showView('offline'); return; }
  sig.connect();
  const hashCode = extractCode(location.hash.slice(1) ? new URLSearchParams(location.hash.slice(1)).get('r') || '' : '');
  if (hashCode) {
    // arrived via a scanned QR → auto-join once the socket is up; show the code filled meanwhile
    fillCode(hashCode); $('code-error').hidden = true; showView('code'); pendingJoin = hashCode;
  } else {
    showView('landing');
  }
}
addEventListener('online', () => { if (!$('view-offline').hidden) { showView('landing'); sig.connect(); } });
addEventListener('offline', () => { if ($('view-landing').hidden === false || $('view-host').hidden === false) showView('offline'); });
boot();

// ---- theme picker (shared/theme.js) ----
const themePop = $('theme-pop'), btnTheme = $('btn-theme');
$('theme-mount').appendChild(window.Theme.buildPicker());
btnTheme.addEventListener('click', (e) => { e.stopPropagation(); themePop.hidden = !themePop.hidden; });
themePop.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!themePop.hidden) themePop.hidden = true; });
window.Theme.onChange(() => { themePop.hidden = true; });
