// 天津麻将联机版 — lobby client. Connects to the game server over WebSocket, renders the 4
// tables (东南西北 chairs), and sends the player's moves (set name / sit / leave / ready /
// add+remove bot). The server is authoritative and PUSHES the full lobby on every change —
// the client never polls, it just re-renders each 'lobby' frame. When our table fills with
// ready players/bots the server sends 'gameStart'.
const $ = (id) => document.getElementById(id);

// ?server=wss://… overrides the target (handy for testing a deployed server from a local
// page); otherwise localhost → the dev server, anything else → the Azure Web App.
const SERVER_URL = new URLSearchParams(location.search).get('server')
  || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? `ws://${location.hostname}:8090`
    : 'wss://mahjongonline.azurewebsites.net');

const WINDS = ['东', '南', '西', '北'];          // seat index → wind label
const POS = ['east', 'south', 'west', 'north'];  // seat index → chair CSS position

let ws = null;
let state = { tables: [], you: { name: '', seat: null, ready: false } };
let name = localStorage.getItem('mahjong-online-name') || '';
let pendingSit = null;          // a {table, seat} sit queued until a name is entered
let reconnectTimer = null;

// ---- connection (auto-reconnecting) --------------------------------------
function connect() {
  setConn('connecting');
  ws = new WebSocket(SERVER_URL);
  ws.onopen = () => { setConn('on'); send({ type: 'hello', name }); };
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
}

// ---- name (top-right textbox + first-sit dialog) -------------------------
function setName(n) {
  name = (n || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  localStorage.setItem('mahjong-online-name', name);
  $('name-input').value = name;
  send({ type: 'setName', name });
}
$('name-input').value = name;
$('name-input').addEventListener('change', (e) => setName(e.target.value));

function requireNameThenSit(table, seat) {
  if (name) { send({ type: 'sit', table, seat }); return; }
  pendingSit = { table, seat };
  const inp = $('name-dialog-input'); inp.value = '';
  $('name-overlay').classList.remove('hidden');
  inp.focus();
}
$('name-dialog-ok').addEventListener('click', () => {
  const n = $('name-dialog-input').value.trim();
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
  const mine = state.you.seat;
  state.tables.forEach((t, ti) => {
    const atThisTable = mine && mine.table === ti;
    const card = document.createElement('div');
    card.className = 'table-card' + (t.status === 'playing' ? ' playing' : '') + (atThisTable ? ' mine' : '');

    const title = document.createElement('div');
    title.className = 'table-title';
    title.innerHTML = `<b>第 ${ti + 1} 桌</b>` + (t.status === 'playing' ? ' · 游戏中' : '');
    card.appendChild(title);

    const grid = document.createElement('div'); grid.className = 'table-grid';
    const square = document.createElement('div'); square.className = 'square'; square.textContent = '🀄';
    grid.appendChild(square);

    t.seats.forEach((seat, si) => {
      const isMe = atThisTable && mine.seat === si;
      const chair = document.createElement('div');
      chair.dataset.table = ti; chair.dataset.seat = si;
      chair.className = `chair ${POS[si]}` +
        (!seat ? ' empty' : seat.kind === 'bot' ? ' bot' : '') +
        (isMe ? ' me' : '') + (t.status === 'playing' ? ' playing' : '');
      const who = !seat ? '空位' : seat.kind === 'bot' ? '🤖 机器人' : seat.name;
      chair.innerHTML = `<span class="wind">${WINDS[si]}</span><span class="who">${esc(who)}</span>` +
        (seat && seat.kind === 'human'
          ? `<span class="ready ${seat.ready ? 'yes' : 'no'}">${seat.ready ? '✓ 已准备' : '未准备'}</span>` : '');
      chair.onclick = (ev) => onChairClick(ev, ti, si);
      grid.appendChild(chair);
    });
    card.appendChild(grid);

    if (atThisTable && t.status === 'waiting') {
      const actions = document.createElement('div'); actions.className = 'table-actions';
      const leave = document.createElement('button'); leave.className = 'btn leave'; leave.textContent = '离开桌子';
      leave.onclick = () => send({ type: 'leave' });
      const ready = document.createElement('button');
      ready.className = 'btn ready' + (state.you.ready ? ' on' : '');
      ready.textContent = state.you.ready ? '取消准备' : '我准备好了';
      ready.onclick = () => send({ type: 'ready', ready: !state.you.ready });
      actions.append(leave, ready);
      card.appendChild(actions);
    }
    root.appendChild(card);
  });
}

// ---- game start (placeholder until online play wires to the RemoteBackend) ----
function showStart(m) {
  $('start-text').textContent = `你坐在「${m.wind}」位，第 ${m.table + 1} 桌即将开始新的一锅。`;
  $('start-overlay').classList.remove('hidden');
}
$('start-back').addEventListener('click', () => { $('start-overlay').classList.add('hidden'); send({ type: 'leave' }); });

render();
connect();
