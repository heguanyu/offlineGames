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
const GAME_PAGE = { tianjin: '../mahjong-tianjin/', guobiao: '../guobiao/', 'guobiao-free': '../guobiao-free/' }; // gameType → game page
const GAME_LABEL = { tianjin: '天津麻将', guobiao: '国标麻将', 'guobiao-free': '国标无定番' };
// This lobby is split per game (?game=tianjin|guobiao|guobiao-free, default 天津): one table, no tabs,
// its own leaderboard. The hub's three online cards each deep-link a game.
const GAME = (() => { const g = new URLSearchParams(location.search).get('game'); return GAME_PAGE[g] ? g : 'tianjin'; })();
let activeTable = 0; // index of GAME's table within the lobby frame's tables list

let ws = null;
let state = { tables: [], you: { name: '', seat: null, ready: false } };
let name = localStorage.getItem('mahjong-online-name') || '';
// A persistent per-device id so a dropped connection reclaims its seat on reconnect.
let uid = localStorage.getItem('mahjong-online-uid');
if (!uid) { uid = (crypto.randomUUID ? crypto.randomUUID() : 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2)); localStorage.setItem('mahjong-online-uid', uid); }
let pendingSit = null;          // a {table, seat} sit queued until a name is entered
let reconnectTimer = null;
let readyDeadline = null;       // local timestamp the ready countdown ticks toward (null = no countdown)

// ---- connection (auto-reconnecting) --------------------------------------
function connect() {
  setConn('connecting');
  ws = new WebSocket(SERVER_URL);
  ws.onopen = () => { setConn('on'); send({ type: 'hello', name, uid, game: GAME }); };
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

// ---- render --------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtCountdown = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// Tick the ready countdown between server frames (the lobby only pushes on changes, not every second).
setInterval(() => {
  if (readyDeadline == null) return;
  const num = document.querySelector('#ready-timer .rt-num');
  if (num) num.textContent = fmtCountdown(readyDeadline - Date.now());
}, 500);

function render() {
  // keep the name box in sync unless the player is actively editing it
  if (document.activeElement !== $('name-input')) $('name-input').value = state.you.name || name;
  const root = $('lobby');
  root.innerHTML = '';
  const mine = state.you.seat;
  // This lobby only ever shows GAME's table (no tabs). A seat held at another game's table belongs to
  // that game's lobby, so it never shows here.
  activeTable = state.tables.findIndex((t) => t.game === GAME);
  if (activeTable < 0) activeTable = 0;
  const t = state.tables[activeTable];
  if (!t) return;
  const atTable = mine && mine.table === activeTable;

  // ---- the table: a felt surface with four chairs (东南西北) around it ----
  const col = document.createElement('div'); col.className = 'table-col';
  const tbl = document.createElement('div'); tbl.className = 'mj-table' + (t.status === 'playing' ? ' playing' : '') + (atTable ? ' mine' : '');
  const waiting = t.status === 'waiting';
  const felt = document.createElement('div'); felt.className = 'felt';
  // Keep the felt clean — only surface a status while a hand is in progress (for spectators); the
  // waiting state is conveyed by the seats + the ready button, so no centred "等待开局" clutter.
  if (t.status === 'playing') felt.innerHTML = `<span class="felt-status">游戏中</span>`;
  tbl.appendChild(felt);
  t.seats.forEach((seat, si) => {
    const isMe = atTable && mine.seat === si;
    const chair = document.createElement('div');
    chair.dataset.table = activeTable; chair.dataset.seat = si;
    chair.className = `chair ${POS[si]}` + (!seat ? ' empty' : seat.kind === 'bot' ? ' bot' : '') + (isMe ? ' me' : '') + (t.status === 'playing' ? ' playing' : '');
    const who = !seat ? '空位' : seat.kind === 'bot' ? '🤖 机器人' : seat.name;
    chair.innerHTML = `<span class="seat-pad"><span class="wind">${WINDS[si]}</span><span class="who">${esc(who)}</span>` +
      (seat && seat.kind === 'human' ? `<span class="ready ${seat.ready ? 'yes' : 'no'}">${seat.ready ? '✓ 已准备' : '未准备'}</span>` : '') + `</span>`;
    // Clicking an empty seat sits you there directly (no menu); occupied seats aren't clickable.
    if (waiting && !seat) chair.onclick = (ev) => { ev.stopPropagation(); requireNameThenSit(activeTable, si); };
    // Per-seat bot toggle: a 🤖 button beside an empty seat adds a bot; a 🤖 with a 🚫 over it removes
    // the bot sitting there. Only while the table is still filling up.
    if (waiting && (!seat || seat.kind === 'bot')) {
      const botBtn = document.createElement('button');
      botBtn.className = 'seat-bot' + (seat ? ' remove' : '');
      botBtn.title = seat ? '移除机器人' : '添加机器人';
      botBtn.innerHTML = `<span class="bot-icon">🤖</span>` + (seat ? `<span class="bot-ban">🚫</span>` : '');
      botBtn.onclick = (ev) => { ev.stopPropagation(); send({ type: seat ? 'removeBot' : 'addBot', table: activeTable, seat: si }); };
      chair.appendChild(botBtn);
    }
    // Spectate: when the table is mid-game and I'm not in it, an eye on each human seat jumps into a
    // read-only view of that player (same UI as them, but no actions).
    if (t.status === 'playing' && !atTable && seat && seat.kind === 'human') {
      const eye = document.createElement('button');
      eye.className = 'watch-eye'; eye.textContent = '👁'; eye.title = `观战 ${seat.name}`;
      eye.onclick = (ev) => { ev.stopPropagation(); watchSeat(si); };
      chair.appendChild(eye);
    }
    // My own seat while the table fills: a 离开座位 button pinned to my chair — below it for the side
    // seats (北/南), to its right for the top/bottom seats (西/东). CSS positions it by POS class.
    if (isMe && waiting) {
      const leave = document.createElement('button');
      leave.className = 'seat-leave'; leave.textContent = '离开座位';
      leave.onclick = (ev) => { ev.stopPropagation(); send({ type: 'leave' }); };
      chair.appendChild(leave);
    }
    tbl.appendChild(chair);
  });
  // Readiness check: once you're seated and the table is still filling, a big toggle floats on the
  // felt (centred, 60% down). Above it, a 1-minute countdown — if you don't ready in time the server
  // auto-frees your seat (it sends the remaining ms as you.readyIn; we tick it down locally).
  if (atTable && waiting) {
    if (!state.you.ready && state.you.readyIn != null) {
      readyDeadline = Date.now() + state.you.readyIn;
      const timer = document.createElement('div'); timer.className = 'ready-timer'; timer.id = 'ready-timer';
      timer.innerHTML = `<span class="rt-num">${fmtCountdown(state.you.readyIn)}</span><span class="rt-cap">未准备将自动离座</span>`;
      tbl.appendChild(timer);
    } else { readyDeadline = null; }
    const ready = document.createElement('button');
    ready.className = 'table-ready btn ready' + (state.you.ready ? ' on' : '');
    ready.textContent = state.you.ready ? '✓ 已准备' : '点击准备';
    ready.onclick = (ev) => { ev.stopPropagation(); send({ type: 'ready', ready: !state.you.ready }); };
    tbl.appendChild(ready);
  } else { readyDeadline = null; }
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
  } else if (!atTable) {
    // Leaving (离开座位) now lives on my own chair; while seated + waiting there's nothing to show below.
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
function pageFor(game) { return GAME_PAGE[game] || GAME_PAGE.tianjin; }
function goToGame() {
  const seat = state.you.seat;
  const game = seat ? state.tables[seat.table].game : state.tables[activeTable].game;
  const params = new URLSearchParams(location.search);
  params.set('online', '1');
  location.href = pageFor(game) + '?' + params.toString();
}
// Enter read-only viewer mode for a player's seat: hand off to the active table's game page in
// spectate mode (vtable tells the game which table to watch).
function watchSeat(seat) {
  const params = new URLSearchParams(location.search);
  params.set('online', '1'); params.set('viewer', '1'); params.set('vseat', String(seat)); params.set('vtable', String(activeTable));
  location.href = pageFor(state.tables[activeTable].game) + '?' + params.toString();
}
function showStart(m) {
  $('start-text').textContent = `你坐在「${m.wind}」位，正在进入${GAME_LABEL[m.game] || ''}…`;
  $('start-overlay').classList.remove('hidden');
  goToGame();
}
$('start-back').addEventListener('click', () => { $('start-overlay').classList.add('hidden'); send({ type: 'leave' }); });

// Title this lobby for its game (天津 / 国标 / 国标无定番).
{
  const label = GAME_LABEL[GAME] || '麻将';
  const h1 = document.querySelector('header h1');
  if (h1) h1.innerHTML = `🀄 ${label}联机 <span class="wifi">📶</span>`;
  document.title = `${label}联机版 · 大厅`;
}

render();
connect();
