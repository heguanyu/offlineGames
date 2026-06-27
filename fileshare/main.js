// 文件共享助手 — orchestrator. Pairs two devices (QR scan OR 9-char code), opens a WebRTC link, and
// moves files peer-to-peer. The signaling server only brokers the handshake (see signaling.js); files
// travel device-to-device, encrypted (rtc.js). Received files are offered as a browser download so on
// iOS they land in Files → Downloads.
import { Signaling } from './signaling.js';
import { PeerLink } from './rtc.js';
import { drawQR } from './qr.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['offline', 'landing', 'host', 'code', 'scan', 'transfer'];
function showView(name) { for (const v of VIEWS) $('view-' + v).hidden = v !== name; }

// Don't let app-nav.js's background SW-update reload the page while a share session is live — that
// would drop the pairing / interrupt a transfer (this page has none of the generic "busy" markers).
window.appBusy = () => !!link;

const sig = new Signaling();
let link = null;          // PeerLink once paired
let joining = false;      // a join is in flight (blocks duplicate submits until peer/error)
let myRoom = null;        // code we're hosting
let pendingJoin = null;   // code to auto-join once the socket opens

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

// ---- connection status ----------------------------------------------------
function setConn(s) { const el = $('conn'); el.className = 'conn ' + s; el.title = { on: '已连接', off: '未连接', connecting: '连接中…' }[s]; }
sig.addEventListener('open', () => { setConn('on'); if (pendingJoin) { sig.join(pendingJoin); pendingJoin = null; } });
sig.addEventListener('close', () => setConn('off'));

// ---- pairing: signaling events -------------------------------------------
sig.addEventListener('fs-created', (e) => { myRoom = e.detail.room; showHost(myRoom); });
sig.addEventListener('fs-peer', (e) => startLink(e.detail.polite));
sig.addEventListener('fs-error', (e) => onPairError(e.detail.code));
sig.addEventListener('fs-peer-gone', () => onPeerGone());

function showHost(code) {
  drawQR($('qr'), location.origin + location.pathname + '#r=' + code, { scale: 6, dark: '#0e1630', light: '#ffffff' });
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

function onPeerGone() {
  if (link) { link.close(); link = null; }
  showView('landing');
}

// ---- the WebRTC link + transfer UI ---------------------------------------
function startLink(polite) {
  if (link) return; // ignore a duplicate fs-peer (already linked)
  joining = false;
  link = new PeerLink(sig, { polite });
  resetLists();
  $('link-status').textContent = '正在建立直连…';
  setPickersEnabled(false);
  showView('transfer');

  link.addEventListener('open', () => { $('link-status').textContent = '已连接，可互传文件'; setPickersEnabled(true); });
  link.addEventListener('peerstate', (e) => { if (e.detail === 'failed') $('link-status').textContent = '直连失败（网络受限）'; });
  link.addEventListener('channelclose', () => onPeerGone());

  // outgoing
  link.addEventListener('queued', (e) => addItem('out', e.detail.id, e.detail.name, e.detail.size));
  link.addEventListener('sent', (e) => completeItem('out', e.detail.id));
  link.addEventListener('sendfail', (e) => failItem('out', e.detail.id));
  // incoming
  link.addEventListener('incoming', (e) => addItem('in', e.detail.id, e.detail.name, e.detail.size));
  link.addEventListener('received', (e) => receiveItem(e.detail));
  // both directions report progress
  link.addEventListener('progress', (e) => updateProgress(e.detail.dir, e.detail.id, e.detail.done, e.detail.total));
}

function setPickersEnabled(on) { for (const id of ['pick-files', 'pick-media']) $(id).disabled = !on; $('dropzone').classList.toggle('disabled', !on); }

// ---- transfer list rendering ---------------------------------------------
const itemEls = { out: new Map(), in: new Map() };
function resetLists() { for (const dir of ['out', 'in']) { itemEls[dir].clear(); $(dir + '-list').innerHTML = '<li class="empty muted">暂无</li>'; } }
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.className = 'dl'; a.href = url; a.download = name; a.textContent = '保存到文件';
  li.appendChild(a);
}

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

$('disconnect').addEventListener('click', () => { sig.leave(); if (link) { link.close(); link = null; } showView('landing'); });

// ---- landing buttons ------------------------------------------------------
$('btn-host').addEventListener('click', () => { if (sig.ws && sig.ws.readyState === WebSocket.OPEN) sig.create(); });
$('btn-code').addEventListener('click', () => { $('code-error').hidden = true; clearCode(); showView('code'); setTimeout(() => boxes[0] && boxes[0].focus(), 50); });
$('host-cancel').addEventListener('click', () => { sig.leave(); myRoom = null; showView('landing'); });
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

// ---- in-app QR scan (only where BarcodeDetector exists; iOS uses native camera) ----
let scanStream = null, scanTimer = null;
const canScan = 'BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
if (canScan) {
  $('btn-scan').hidden = false;
  $('btn-scan').addEventListener('click', startScan);
  $('scan-cancel').addEventListener('click', stopScan);
}
async function startScan() {
  showView('scan'); $('scan-status').textContent = '正在打开摄像头…';
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('scan-video'); v.srcObject = scanStream; await v.play();
    $('scan-status').textContent = '对准二维码…';
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    scanTimer = setInterval(async () => {
      try { const codes = await det.detect(v); if (codes.length) { const code = extractCode(codes[0].rawValue); if (code) { stopScan(); doJoin(code); } } } catch {}
    }, 300);
  } catch { $('scan-status').textContent = '无法打开摄像头，请改用配对码'; }
}
function stopScan() {
  clearInterval(scanTimer); scanTimer = null;
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
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
