// 文件共享助手 — orchestrator. Pairs two devices (QR scan OR 9-char code), opens a WebRTC link, and
// moves files peer-to-peer. The signaling server only brokers the handshake (see signaling.js); files
// travel device-to-device, encrypted (rtc.js). Received files are offered as a browser download so on
// iOS they land in Files → Downloads.
import { Signaling } from './signaling.js';
import { PeerLink } from './rtc.js';
import { RelayLink } from './relay.js';
import { drawQR } from './qr.js';
import { makeZip } from './zip.js';

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
// pull a 9-char code out of a scanned URL/text (#r=CODE, ?r=CODE, or a bare code)
function extractCode(text) {
  try { const u = new URL(text); const h = onlyCode(new URLSearchParams(u.hash.slice(1)).get('r') || u.searchParams.get('r')); if (h.length === 9) return h; } catch {}
  const c = onlyCode(text); return c.length === 9 ? c : '';
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

// ---- keep the screen awake while a share session is live -------------------
// A sleeping device drops the WebSocket AND the DataChannel mid-transfer; the Screen Wake
// Lock API prevents that (Safari 16.4+, Chromium incl. 华为浏览器). Best-effort — devices
// without it just keep their normal sleep timers.
let wakeLock = null;
async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const w = wakeLock; wakeLock = null; await w.release();
    }
  } catch { wakeLock = null; }   // denied (low battery etc.) — not fatal
}
// the OS auto-releases the lock whenever the page hides; re-grab it on return
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) keepAwake(true); });

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

function setPickersEnabled(on) { for (const id of ['pick-files', 'pick-media']) $(id).disabled = !on; $('dropzone').classList.toggle('disabled', !on); }

// ---- transfer list rendering ---------------------------------------------
const itemEls = { out: new Map(), in: new Map() };
const received = new Map(); // id → { name, blob } for every fully-received file (the batch-save pool)
function resetLists() {
  for (const dir of ['out', 'in']) { itemEls[dir].clear(); $(dir + '-list').innerHTML = '<li class="empty muted">暂无</li>'; }
  received.clear();
  refreshInActions();
}
function addItem(dir, id, name, size) {
  const list = $(dir + '-list');
  const empty = list.querySelector('.empty'); if (empty) empty.remove();
  const li = document.createElement('li'); li.className = 'item';
  li.innerHTML = `<span class="fname"></span><div class="fmeta"><span class="pct">0%</span><span class="size">${fmtBytes(size)}</span></div><div class="bar"><span></span></div>`;
  li.querySelector('.fname').textContent = name;
  list.appendChild(li); itemEls[dir].set(id, li);
}
function updateProgress(dir, id, done, total) {
  const li = itemEls[dir].get(id); if (!li) return;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  li.querySelector('.bar > span').style.width = pct + '%';
  li.querySelector('.pct').textContent = pct + '%';
}
function completeItem(dir, id) { const li = itemEls[dir].get(id); if (!li) return; li.querySelector('.bar').classList.add('done'); li.querySelector('.bar > span').style.width = '100%'; li.querySelector('.pct').textContent = '已发送'; }
function failItem(dir, id) { const li = itemEls[dir].get(id); if (li) li.querySelector('.pct').textContent = '失败'; }
function receiveItem({ id, name, blob }) {
  const li = itemEls.in.get(id); if (!li) return;
  li.querySelector('.bar').classList.add('done'); li.querySelector('.bar > span').style.width = '100%'; li.querySelector('.pct').textContent = '已接收';
  received.set(id, { name, blob });

  // checkbox + filename in one tappable row → drives the multi-select batch download
  const fname = li.querySelector('.fname');
  const head = document.createElement('label'); head.className = 'recv-head';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'pick'; cb.checked = true;
  cb.addEventListener('change', refreshInActions);
  li.insertBefore(head, fname); head.appendChild(cb); head.appendChild(fname);

  // keep a per-file one-tap save too (single download within the click gesture — iOS-safe)
  const a = document.createElement('a'); a.className = 'dl'; a.href = URL.createObjectURL(blob); a.download = name; a.textContent = '保存';
  li.appendChild(a);
  refreshInActions();
}

// ---- received-files panel: select-all → save to Photos/Files (mobile) or .zip (desktop) ----
// iOS can't put a .zip into the Photo Library, but the native share sheet accepts MANY files at once
// and offers "存储 N 张图像" (→ Photos) for images and "存储到文件" for the rest — i.e. the files arrive
// separately, in one tap. So we prefer Web Share where it can share files (mobile), and fall back to a
// single .zip on desktop, where Photos doesn't exist and one download beats N.
const canShareFiles = (() => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob([1])], 'p.bin')] })); }
  catch { return false; }
})();
if (canShareFiles) $('share-selected').hidden = false;

function refreshInActions() {
  const actions = $('in-actions');
  if (!received.size) { actions.hidden = true; return; }
  actions.hidden = false;
  const picks = [...received.keys()].map((id) => itemEls.in.get(id)?.querySelector('.pick')).filter(Boolean);
  const checked = picks.filter((c) => c.checked).length;
  const all = $('sel-all'); all.checked = checked === picks.length; all.indeterminate = checked > 0 && checked < picks.length;
  const n = checked > 1 ? ` (${checked})` : '';
  const zip = $('save-selected'); zip.disabled = checked === 0; zip.textContent = (checked > 1 ? '打包 .zip' : '下载') + n;
  const share = $('share-selected'); share.disabled = checked === 0; share.textContent = '保存到相册 / 分享' + n;
}
function selectedFiles() {
  const out = [];
  for (const [id, f] of received) { const cb = itemEls.in.get(id)?.querySelector('.pick'); if (cb && cb.checked) out.push(f); }
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
  const picks = selectedFiles();
  if (!picks.length) return;
  const files = picks.map((f) => new File([f.blob], f.name, { type: f.blob.type || 'application/octet-stream' }));
  try { await navigator.share({ files }); }
  catch (e) { if (e && e.name !== 'AbortError') triggerDownload(picks.length === 1 ? picks[0].blob : await makeZip(picks), picks.length === 1 ? picks[0].name : zipName()); }
});
// Desktop: a single file saves as-is; multiple bundle into one .zip.
$('save-selected').addEventListener('click', async () => {
  const picks = selectedFiles();
  if (!picks.length) return;
  if (picks.length === 1) { triggerDownload(picks[0].blob, picks[0].name); return; }
  const btn = $('save-selected'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = '打包中…';
  try { triggerDownload(await makeZip(picks), zipName()); }
  finally { btn.textContent = label; refreshInActions(); }
});

// ---- file picking / drag-drop --------------------------------------------
function sendFiles(files) { if (!link) return; for (const f of files) link.send(f); }
$('pick-files').addEventListener('click', () => $('file-input').click());
$('pick-media').addEventListener('click', () => $('media-input').click());
$('file-input').addEventListener('change', (e) => { sendFiles(e.target.files); e.target.value = ''; });
$('media-input').addEventListener('change', (e) => { sendFiles(e.target.files); e.target.value = ''; });
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
