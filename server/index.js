// 天津麻将联机版 — lobby + table server.
//
// Plain `ws` on the HTTP server Azure App Service hands us (listen on process.env.PORT,
// TLS terminated by the platform → clients connect over wss://). Holds the AUTHORITATIVE
// lobby state — 4 tables × 4 seats (东南西北) — and, once a table fills with ready humans /
// bots, an authoritative Table game (server/table.js). The server PUSHES every change; the
// client never polls. Players are identified by a persistent `uid` (their localStorage id),
// so a dropped connection can reconnect to its seat and resync the game in progress.
//
// Run locally:  PORT=8090 node index.js
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Table } from './table.js';

const PORT = process.env.PORT || 8090;
const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  'https://heguanyu.github.io,http://localhost:8090,http://127.0.0.1:8090,http://localhost:8137')
  .split(',').map((s) => s.trim());

const TABLES = 1, SEATS = 4;
const WIND = ['东', '南', '西', '北'];

// ---- persistence (lifetime scores + the live 锅 state) ---------------------
// One JSON file holds the lifetime leaderboard (scoreBook: uid → {name,total,pots}) AND a snapshot
// of each table — its seats + the current 锅's standings (scores / 圈 / 庄 / 每圈成绩). On Azure set
// SCORES_FILE to a path under /home so it survives restarts & redeploys. A restart RESTORES the
// seats + 锅 standings (the in-progress hand is dropped); players re-ready and the 锅 resumes from
// the same round — it never resets to round 1.
const STATE_FILE = process.env.SCORES_FILE || fileURLToPath(new URL('./scores.json', import.meta.url));
let scoreBook = {}, savedTables = [];
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (raw && typeof raw === 'object') {
    if (raw.scoreBook || raw.tables) { scoreBook = raw.scoreBook || {}; savedTables = raw.tables || []; }
    else scoreBook = raw; // legacy file: the bare scoreBook
  }
} catch {}

// ---- authoritative state --------------------------------------------------
// seat: null | { kind:'human', uid, name, ready } | { kind:'bot' }
// table: { id, status:'waiting'|'playing', seats:[4], game: Table|null, resume: 锅-snapshot|null }
const tables = Array.from({ length: TABLES }, (_, id) => {
  const sv = savedTables[id];
  const seats = (sv && Array.isArray(sv.seats) ? sv.seats : []).map((s) => !s ? null
    : s.kind === 'bot' ? { kind: 'bot' }
    : (s.kind === 'human' && s.uid) ? { kind: 'human', uid: s.uid, name: s.name || '', ready: false } : null);
  while (seats.length < SEATS) seats.push(null);
  return { id, status: 'waiting', seats, game: null, resume: (sv && sv.pot) || null };
});

const dumpState = () => JSON.stringify({
  scoreBook,
  tables: tables.map((t) => ({ seats: t.seats, pot: t.game ? t.game.snapshot() : (t.resume || null) })),
});
let saveTimer = null;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(STATE_FILE, dumpState()); } catch {} }, 200); }
function flushState() { clearTimeout(saveTimer); try { fs.writeFileSync(STATE_FILE, dumpState()); } catch {} } // sync, for shutdown
// Record one finished 锅: each human seat's final score is added to their lifetime total.
function recordPot(seats, finalScores) {
  for (let s = 0; s < SEATS; s++) {
    const seat = seats[s];
    if (seat && seat.kind === 'human' && seat.uid) {
      const rec = scoreBook[seat.uid] || (scoreBook[seat.uid] = { name: seat.name, total: 0, pots: 0 });
      rec.name = seat.name || rec.name; rec.total += finalScores[s] | 0; rec.pots += 1;
    }
  }
}
const leaderboard = (uid) => Object.entries(scoreBook)
  .sort((a, b) => b[1].total - a[1].total).slice(0, 50)
  .map(([k, r]) => ({ name: r.name, total: r.total, pots: r.pots, mine: k === uid }));
const clients = new Map(); // clientId → { ws, id, uid, name }
const uidWs = new Map();    // uid → the live socket for that player (for routing game frames)
let nextId = 1;

// Names: only Chinese characters or English letters, capped at 6 中文 / 12 英文 (中文 = 2 width
// units, 英文 = 1, max 12). Mirrors the lobby's cleanName so a hand-crafted client can't bypass it.
const sanitizeName = (n) => {
  let out = '', w = 0;
  for (const ch of String(n || '')) {
    const cjk = /[㐀-䶿一-鿿]/.test(ch);
    if (!cjk && !/[a-zA-Z]/.test(ch)) continue;
    const cw = cjk ? 2 : 1;
    if (w + cw > 12) break;
    w += cw; out += ch;
  }
  return out;
};
const send = (ws, msg) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

function seatOf(uid) {
  if (!uid) return null;
  for (const t of tables) for (let s = 0; s < SEATS; s++) {
    const seat = t.seats[s];
    if (seat && seat.kind === 'human' && seat.uid === uid) return { table: t.id, seat: s };
  }
  return null;
}

// The lobby view for one player. Only their own seat coordinates are exposed; other seats
// show kind/name/ready only (no uids leak).
function lobbyFor(uid) {
  const mine = seatOf(uid);
  return {
    type: 'lobby',
    you: { name: (uid && [...clients.values()].find((c) => c.uid === uid)?.name) || '', seat: mine,
      ready: mine ? !!tables[mine.table].seats[mine.seat].ready : false },
    tables: tables.map((t) => ({
      id: t.id, status: t.status,
      seats: t.seats.map((seat) => !seat ? null
        : seat.kind === 'bot' ? { kind: 'bot' }
        : { kind: 'human', name: seat.name, ready: !!seat.ready }),
    })),
    leaderboard: leaderboard(uid),
  };
}
const broadcastLobby = () => { for (const c of clients.values()) send(c.ws, lobbyFor(c.uid)); };

// Stand up the authoritative game for a full table (every seat occupied). Tells each human to
// open the game page, then routes that seat's frames to the player's current socket.
function startGame(t) {
  t.status = 'playing';
  const gameSeats = t.seats.map((s) => s.kind === 'bot' ? { kind: 'bot' } : { kind: 'human', uid: s.uid, name: s.name });
  for (let s = 0; s < SEATS; s++) if (gameSeats[s].kind === 'human') send(uidWs.get(gameSeats[s].uid), { type: 'gameStart', table: t.id, seat: s, wind: WIND[s] });
  broadcastLobby();
  // route each seat's frames to that player's current socket (reconnection-safe)
  const emit = (seatIdx, msg) => { const gs = gameSeats[seatIdx]; if (gs.kind === 'human') send(uidWs.get(gs.uid), msg); };
  // online bots play at the hardest level; t.resume carries the 锅 standings across a restart;
  // persist after every hand so a crash resumes from the latest round.
  t.game = new Table(t.id, gameSeats, emit, (finalScores) => onPotOver(t, gameSeats, finalScores), 3, t.resume, persist);
  persist();
}

// All four seats filled and every human ready → start the table's authoritative game.
function maybeStart(t) {
  if (t.status !== 'waiting') return;
  if (!t.seats.every((s) => s && (s.kind === 'bot' || s.ready))) return;
  startGame(t);
}

// A 锅 interrupted by a server restart resumes the moment one of its occupants returns — the
// seats were restored from the snapshot, so there's nothing to re-ready. Returns true if it
// (re)started the game. The disconnected seats are held and auto-act until those players are back,
// exactly like a mid-game drop.
function resumeTable(t) {
  if (t.status !== 'waiting' || t.game || !t.resume) return false;
  if (!t.seats.every((s) => s)) return false; // a 锅 always has four occupied seats
  startGame(t);
  return true;
}

// 锅 finished → persist each player's lifetime score, then back to the lobby (same occupants,
// humans un-readied for a rematch). The 锅 is done, so its resume snapshot is cleared.
function onPotOver(t, gameSeats, finalScores) {
  if (gameSeats && finalScores) recordPot(gameSeats, finalScores);
  if (t.game) t.game.dispose();
  t.game = null; t.resume = null;
  t.status = 'waiting';
  for (const seat of t.seats) if (seat && seat.kind === 'human') seat.ready = false;
  broadcastLobby();
  persist();
}

// ---- per-connection messages ----------------------------------------------
const inRange = (ti, si) => ti >= 0 && ti < TABLES && si >= 0 && si < SEATS;

function handle(client, msg) {
  // in-game moves route straight to the authoritative table (no lobby broadcast)
  if (msg.type === 'action') {
    const at = seatOf(client.uid);
    if (at && tables[at.table].game) tables[at.table].game.onAction(at.seat, msg);
    return;
  }

  switch (msg.type) {
    case 'hello': {
      client.uid = String(msg.uid || '').slice(0, 64) || ('anon-' + client.id);
      client.name = sanitizeName(msg.name) || `玩家${client.id}`;
      uidWs.set(client.uid, client.ws);
      const at = seatOf(client.uid); // reconnection: reclaim a seat held while we were away
      const t = at ? tables[at.table] : null;
      if (t) t.seats[at.seat].name = client.name;
      // Live game → resync onto the table. A 锅 interrupted by a server restart (seat restored,
      // standings saved, but no game object) → resume it now so a refresh lands back on the table
      // instead of bouncing to the lobby. Otherwise → no live game, the game page returns to the lobby.
      if (t && t.status === 'playing' && t.game) t.game.resync(at.seat);
      else if (t && resumeTable(t)) t.game.resync(at.seat);
      else send(client.ws, { type: 'noGame' });
      break;
    }
    case 'setName': {
      client.name = sanitizeName(msg.name) || client.name || `玩家${client.id}`;
      const at = seatOf(client.uid);
      if (at) tables[at.table].seats[at.seat].name = client.name;
      break;
    }
    case 'sit': {
      const ti = msg.table | 0, si = msg.seat | 0;
      if (!client.uid || !inRange(ti, si) || tables[ti].status !== 'waiting' || tables[ti].seats[si]) return;
      const cur = seatOf(client.uid); if (cur) tables[cur.table].seats[cur.seat] = null; // one seat per player
      tables[ti].seats[si] = { kind: 'human', uid: client.uid, name: client.name, ready: false };
      break;
    }
    case 'leave': { const at = seatOf(client.uid); if (at && tables[at.table].status === 'waiting') tables[at.table].seats[at.seat] = null; break; }
    case 'ready': { const at = seatOf(client.uid); if (!at) return; tables[at.table].seats[at.seat].ready = !!msg.ready; break; }
    case 'addBot': {
      const ti = msg.table | 0, si = msg.seat | 0;
      if (!inRange(ti, si) || tables[ti].status !== 'waiting' || tables[ti].seats[si]) return;
      tables[ti].seats[si] = { kind: 'bot' };
      break;
    }
    case 'removeBot': {
      const ti = msg.table | 0, si = msg.seat | 0;
      if (!inRange(ti, si) || tables[ti].status !== 'waiting') return;
      if (tables[ti].seats[si]?.kind === 'bot') tables[ti].seats[si] = null;
      break;
    }
    default: return;
  }
  broadcastLobby();
  for (const t of tables) maybeStart(t); // any change (ready OR adding the last bot) can complete a table
  persist(); // seat/ready/bot changes are part of the restored state
}

// ---- HTTP + WebSocket -----------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('mahjong-online ok'); return; }
  res.writeHead(404); res.end();
});

const localhostOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, cb) => cb(!origin || ALLOWED.includes(origin) || localhostOrigin(origin), 403, 'origin not allowed'),
});

wss.on('connection', (ws) => {
  const id = nextId++;
  const client = { ws, id, uid: null, name: '' };
  clients.set(id, client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, lobbyFor(null)); // initial snapshot; the client follows with 'hello' (uid + saved name)
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    try { handle(client, msg); } catch { /* ignore malformed input */ }
  });
  ws.on('close', () => {
    clients.delete(id);
    if (client.uid && uidWs.get(client.uid) === ws) uidWs.delete(client.uid);
    const at = seatOf(client.uid);
    // free the seat only at a waiting table; a seat in a live game is HELD for reconnection
    // (the table auto-acts on that seat's turn until the player returns).
    if (at && tables[at.table].status === 'waiting') tables[at.table].seats[at.seat] = null;
    broadcastLobby();
    persist();
  });
  ws.on('error', () => {});
});

// Heartbeat: cull dead sockets (mobile drops, Azure idle culling).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// Flush the latest 锅 standings synchronously on a graceful shutdown (Azure sends SIGTERM on a
// restart/redeploy) so the resumed game starts from the most recent round.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushState(); process.exit(0); });

server.listen(PORT, () => console.log(`mahjong-online lobby listening on :${PORT}`));
