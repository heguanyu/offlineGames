// 天津麻将联机版 — lobby client. Connects to the game server over WebSocket, renders the 4
// tables (东南西北 chairs), and sends the player's moves (set name / sit / leave / ready /
// add+remove bot). The server is authoritative and PUSHES the full lobby on every change —
// the client never polls, it just re-renders each 'lobby' frame. When our table fills with
// ready players/bots the server sends 'gameStart'.
const $ = (id) => document.getElementById(id);

// Pick the game server. The Azure App Service now serves this very page AND the WebSocket
// backend, so when we're loaded from Azure (or any same-origin host) we just connect back to
// ourselves. The GitHub Pages mirror can't host a WebSocket, so a page served from *.github.io
// reaches across to the Azure backend. ?server=wss://… overrides everything (handy for testing
// a deployed server from a local page).
const AZURE_WS = 'wss://mahjongonline-fhc2e9hcfuafdgh0.canadacentral-01.azurewebsites.net';
function defaultServerUrl() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return `ws://${h}:8090`; // dev server (also serves this page)
  if (h.endsWith('github.io')) return AZURE_WS;                        // Pages mirror → Azure backend
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`; // served from Azure → same origin
}
const SERVER_URL = new URLSearchParams(location.search).get('server') || defaultServerUrl();

const WINDS = ['东', '南', '西', '北'];          // seat index → wind label
const POS = ['east', 'south', 'west', 'north'];  // seat index → chair CSS position

let ws = null;
let state = { tables: [], you: { name: '', seat: null, ready: false } };
let name = localStorage.getItem('mahjong-online-name') || '';
// A persistent per-device id so a dropped connection reclaims its seat on reconnect.
let uid = localStorage.getItem('mahjong-online-uid');
if (!uid) { uid = (crypto.randomUUID ? crypto.randomUUID() : 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem('mahjong-online-uid', uid); }
let pendingSit = null;          // a {table, seat} sit queued until a name is entered
let reconnectTimer = null;

// ---- connection (auto-reconnecting) --------------------------------------
function connect() {
  setConn('connecting');
  ws = new WebSocket(SERVER_URL);
  ws.onopen = () => { setConn('on'); send({ type: 'hello', name, uid }); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'lobby') { state = m; render(); }
    else if (m.type === 'gameStart') showStart(m);
  };
  ws.onclose = () => { setConn('off'); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1500); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
const send = (m) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
function setConn(s) {
  const el = $('conn'); el.className = 'conn ' + s;
  el.title = ({ on: '已连接', off: '未连接 · 重连中…', connecting: '连接中…' })[s];
  // server offline → "维护中" overlay; hide once reconnected (leave it during 'connecting' retries)
  const maint = $('maint-overlay');
  if (maint) { if (s === 'on') maint.classList.add('hidden'); else if (s === 'off') maint.classList.remove('hidden'); }
}

// ---- name (top-right textbox + first-sit dialog) -------------------------
// A name may only contain Chinese characters or English letters, capped at 6 中文 / 12 英文
// (中文 counts as 2 width units, 英文 as 1; max 12). Anything else (digits, spaces, punctuation,
// emoji…) is dropped. Enforced live in the inputs AND again on the server (sanitizeName).
function cleanName(s) {
  let out = '', w = 0;
  for (const ch of String(s || '')) {
    const cjk = /[㐀-䶿一-鿿]/.test(ch);
    if (!cjk && !/[a-zA-Z]/.test(ch)) continue;
    const cw = cjk ? 2 : 1;
    if (w + cw > 12) break;
    w += cw; out += ch;
  }
  return out;
}
// Clean the field's value in place. Bound to 'input' (but SKIPPED while an IME is composing — e.g.
// typing pinyin "xiaoshuai" for 小帅 — because rewriting the value mid-composition commits the raw
// pinyin and cancels the input) and to 'compositionend' (so the limit is applied once the IME finishes).
const clampValue = (el) => { const c = cleanName(el.value); if (c !== el.value) el.value = c; };
const clampInput = (e) => { if (e.isComposing) return; clampValue(e.target); };
const bindNameClamp = (el) => { el.addEventListener('input', clampInput); el.addEventListener('compositionend', () => clampValue(el)); };
function setName(n) {
  name = cleanName(n);
  localStorage.setItem('mahjong-online-name', name);
  $('name-input').value = name;
  send({ type: 'setName', name });
}
name = cleanName(name); localStorage.setItem('mahjong-online-name', name); // clean a name stored before these rules
$('name-input').value = name;
bindNameClamp($('name-input'));
$('name-input').addEventListener('change', (e) => setName(e.target.value));

function requireNameThenSit(table, seat) {
  if (name) { send({ type: 'sit', table, seat }); return; }
  pendingSit = { table, seat };
  const inp = $('name-dialog-input'); inp.value = '';
  $('name-overlay').classList.remove('hidden');
  inp.focus();
}
bindNameClamp($('name-dialog-input'));
$('name-dialog-ok').addEventListener('click', () => {
  const n = cleanName($('name-dialog-input').value);
  if (!n) { $('name-dialog-input').focus(); return; }
  setName(n);
  $('name-overlay').classList.add('hidden');
  if (pendingSit) { send({ type: 'sit', ...pendingSit }); pendingSit = null; }
});
$('name-dialog-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('name-dialog-ok').click(); });

// ---- seat action menu ----------------------------------------------------
function openMenu(x, y, buttons) {
  const menu = $('seat-menu');
  menu.innerHTML = '';
  for (const [label, fn] of buttons) {
    const b = document.createElement('button'); b.textContent = label;
    b.onclick = (ev) => { ev.stopPropagation(); closeMenu(); fn(); };
    menu.appendChild(b);
  }
  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = (y + 6) + 'px';
}
const closeMenu = () => $('seat-menu').classList.add('hidden');
document.addEventListener('click', (e) => { if (!e.target.closest('#seat-menu') && !e.target.closest('.chair')) closeMenu(); });

function onChairClick(ev, ti, si) {
  ev.stopPropagation();
  const t = state.tables[ti];
  if (!t || t.status !== 'waiting') return;
  const seat = t.seats[si];
  const mine = state.you.seat;
  const x = ev.pageX, y = ev.pageY;
  if (!seat) {
    openMenu(x, y, [
      ['坐这里', () => requireNameThenSit(ti, si)],
      ['加机器人', () => send({ type: 'addBot', table: ti, seat: si })],
    ]);
  } else if (seat.kind === 'bot') {
    openMenu(x, y, [['移除机器人', () => send({ type: 'removeBot', table: ti, seat: si })]]);
  } else if (mine && mine.table === ti && mine.seat === si) {
    openMenu(x, y, [['离开座位', () => send({ type: 'leave' })]]);
  }
}

// ---- render --------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render() {
  // keep the name box in sync unless the player is actively editing it
  if (document.activeElement !== $('name-input')) $('name-input').value = state.you.name || name;
  const root = $('lobby');
  root.innerHTML = '';
  const t = state.tables[0];
  if (!t) return;
  const mine = state.you.seat;          // we only ever have one table now
  const atTable = mine && mine.table === 0;

  // ---- the table: a felt surface with four chairs (东南西北) around it ----
  const col = document.createElement('div'); col.className = 'table-col';
  const tbl = document.createElement('div'); tbl.className = 'mj-table' + (t.status === 'playing' ? ' playing' : '') + (atTable ? ' mine' : '');
  const felt = document.createElement('div'); felt.className = 'felt';
  felt.innerHTML = `<span class="felt-mark">🀄</span><span class="felt-status">${t.status === 'playing' ? '游戏中' : '等待开局'}</span>`;
  tbl.appendChild(felt);
  t.seats.forEach((seat, si) => {
    const isMe = atTable && mine.seat === si;
    const chair = document.createElement('div');
    chair.dataset.table = 0; chair.dataset.seat = si;
    chair.className = `chair ${POS[si]}` + (!seat ? ' empty' : seat.kind === 'bot' ? ' bot' : '') + (isMe ? ' me' : '') + (t.status === 'playing' ? ' playing' : '');
    const who = !seat ? '空位' : seat.kind === 'bot' ? '🤖 机器人' : seat.name;
    chair.innerHTML = `<span class="seat-pad"><span class="wind">${WINDS[si]}</span><span class="who">${esc(who)}</span>` +
      (seat && seat.kind === 'human' ? `<span class="ready ${seat.ready ? 'yes' : 'no'}">${seat.ready ? '✓ 已准备' : '未准备'}</span>` : '') + `</span>`;
    chair.onclick = (ev) => onChairClick(ev, 0, si);
    // Spectate: when the table is mid-game and I'm not in it, an eye on each human seat jumps into a
    // read-only view of that player (same UI as them, but no actions).
    if (t.status === 'playing' && !atTable && seat && seat.kind === 'human') {
      const eye = document.createElement('button');
      eye.className = 'watch-eye'; eye.textContent = '👁'; eye.title = `观战 ${seat.name}`;
      eye.onclick = (ev) => { ev.stopPropagation(); watchSeat(si); };
      chair.appendChild(eye);
    }
    tbl.appendChild(chair);
  });
  col.appendChild(tbl);

  if (atTable && t.status === 'playing') {
    // The server holds our seat (by uid) while the table plays — offer to jump back in. This is
    // how you return to a game after wandering off to the lobby or the main hub.
    const actions = document.createElement('div'); actions.className = 'table-actions';
    const back = document.createElement('button'); back.className = 'btn ready on'; back.textContent = '↩ 返回牌桌';
    back.onclick = goToGame;
    actions.appendChild(back);
    col.appendChild(actions);
    const hint = document.createElement('div'); hint.className = 'table-hint';
    hint.textContent = '你正在这局牌中 — 点击返回继续';
    col.appendChild(hint);
  } else if (atTable && t.status === 'waiting') {
    const actions = document.createElement('div'); actions.className = 'table-actions';
    const leave = document.createElement('button'); leave.className = 'btn leave'; leave.textContent = '离开桌子';
    leave.onclick = () => send({ type: 'leave' });
    const ready = document.createElement('button');
    ready.className = 'btn ready' + (state.you.ready ? ' on' : '');
    ready.textContent = state.you.ready ? '取消准备' : '我准备好了';
    ready.onclick = () => send({ type: 'ready', ready: !state.you.ready });
    actions.append(leave, ready);
    col.appendChild(actions);
  } else {
    const hint = document.createElement('div'); hint.className = 'table-hint';
    hint.textContent = t.status === 'playing' ? '本桌正在游戏中…' : '点击空位坐下，或添加机器人';
    col.appendChild(hint);
  }
  root.appendChild(col);

  // ---- lifetime leaderboard (server-kept, keyed by uid) ----
  const lb = document.createElement('aside'); lb.id = 'leaderboard';
  const rows = state.leaderboard || [];
  lb.innerHTML = `<h2>🏆 排行榜</h2>` + (rows.length
    ? `<table class="lb-table"><thead><tr><th>#</th><th>玩家</th><th>总分</th><th>锅</th></tr></thead><tbody>` +
      rows.map((r, i) => `<tr class="${r.mine ? 'me' : ''}"><td class="lb-rank">${i + 1}</td><td class="lb-name">${esc(r.name)}</td>` +
        `<td class="lb-pts ${r.total > 0 ? 'pos' : r.total < 0 ? 'neg' : 'zero'}">${r.total > 0 ? '+' : ''}${r.total}</td><td class="lb-pots">${r.pots}</td></tr>`).join('') +
      `</tbody></table>`
    : `<p class="lb-empty">还没有人打完一锅 — 打完一锅即可上榜！</p>`);
  root.appendChild(lb);
}

// ---- hand off to the game page (it connects with the same uid → the server resyncs the table
// in progress). Carry server/fast/flat/d3 through so the game targets the same server.
function goToGame() {
  const params = new URLSearchParams(location.search);
  params.set('online', '1');
  location.href = '../mahjong-tianjin/?' + params.toString();
}
// Enter read-only viewer mode for a player's seat: hand off to the game page in spectate mode.
function watchSeat(seat) {
  const params = new URLSearchParams(location.search);
  params.set('online', '1'); params.set('viewer', '1'); params.set('vseat', String(seat));
  location.href = '../mahjong-tianjin/?' + params.toString();
}
function showStart(m) {
  $('start-text').textContent = `你坐在「${m.wind}」位，正在进入第 ${m.table + 1} 桌…`;
  $('start-overlay').classList.remove('hidden');
  goToGame();
}
$('start-back').addEventListener('click', () => { $('start-overlay').classList.add('hidden'); send({ type: 'leave' }); });

render();
connect();
