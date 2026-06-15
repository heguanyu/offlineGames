// 天津麻将联机版 — lobby + table server.
//
// Plain `ws` on the HTTP server Azure App Service hands us (listen on process.env.PORT,
// TLS terminated by the platform → clients connect over wss://). Holds the AUTHORITATIVE
// lobby state — 4 tables × 4 seats (东南西北) — validates each client move, and PUSHES the
// full lobby to everyone on every change. With WebSocket the client never polls: it just
// listens for 'lobby' frames. When a table's four seats are all ready humans / bots, the
// table flips to 'playing' and the seated humans get a 'gameStart' — the per-hand game loop
// (reusing ../games/mahjong-tianjin/engine.js + ai.js behind a RemoteBackend) hooks in there.
//
// Run locally:  PORT=8090 node index.js     (the lobby client falls back to ws://localhost:8090)
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8090;
// Allowed browser origins (a light CSRF guard). Override with ALLOWED_ORIGINS (comma list)
// in Azure App Settings; localhost is kept for local dev.
const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  'https://heguanyu.github.io,http://localhost:8090,http://127.0.0.1:8090,http://localhost:8137')
  .split(',').map((s) => s.trim());

const TABLES = 4, SEATS = 4;
const WIND = ['东', '南', '西', '北'];

// ---- authoritative state --------------------------------------------------
// seat: null | { kind:'human', clientId, name, ready } | { kind:'bot' }
const tables = Array.from({ length: TABLES }, (_, id) => ({ id, status: 'waiting', seats: new Array(SEATS).fill(null) }));
const clients = new Map(); // clientId → { ws, id, name }
let nextId = 1;

function seatOf(clientId) {
  for (const t of tables) for (let s = 0; s < SEATS; s++) {
    const seat = t.seats[s];
    if (seat && seat.kind === 'human' && seat.clientId === clientId) return { table: t.id, seat: s };
  }
  return null;
}
function leaveSeat(clientId) {
  const at = seatOf(clientId);
  if (at) tables[at.table].seats[at.seat] = null;
  return at;
}

// The view a client renders. Only the player's OWN seat coordinates are exposed; other
// seats show just kind/name/ready (no client ids leak).
function lobbyFor(clientId) {
  const mine = seatOf(clientId);
  return {
    type: 'lobby',
    you: {
      name: clients.get(clientId)?.name || '',
      seat: mine,
      ready: mine ? !!tables[mine.table].seats[mine.seat].ready : false,
    },
    tables: tables.map((t) => ({
      id: t.id, status: t.status,
      seats: t.seats.map((seat) => !seat ? null
        : seat.kind === 'bot' ? { kind: 'bot' }
        : { kind: 'human', name: seat.name, ready: !!seat.ready }),
    })),
  };
}

const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const broadcastLobby = () => { for (const c of clients.values()) send(c.ws, lobbyFor(c.id)); };

// All four seats filled and every human ready (bots count as ready) → start the hand.
function maybeStart(t) {
  if (t.status !== 'waiting') return;
  if (!t.seats.every((s) => s && (s.kind === 'bot' || s.ready))) return;
  t.status = 'playing';
  for (let s = 0; s < SEATS; s++) {
    const seat = t.seats[s];
    if (seat && seat.kind === 'human') send(clients.get(seat.clientId)?.ws, { type: 'gameStart', table: t.id, seat: s, wind: WIND[s] });
  }
  broadcastLobby();
  // TODO(online play): instantiate a Game (engine.js), redact per seat, and drive the hand
  // via the same events a RemoteBackend consumes; reset to a fresh 锅 here.
}

// ---- per-client messages --------------------------------------------------
const inRange = (ti, si) => ti >= 0 && ti < TABLES && si >= 0 && si < SEATS;

function handle(client, msg) {
  switch (msg.type) {
    case 'hello':
    case 'setName': {
      client.name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 16) || `玩家${client.id}`;
      const at = seatOf(client.id);
      if (at) tables[at.table].seats[at.seat].name = client.name; // propagate to a seated player
      break;
    }
    case 'sit': {
      const ti = msg.table | 0, si = msg.seat | 0;
      if (!inRange(ti, si) || tables[ti].status !== 'waiting' || tables[ti].seats[si]) return;
      leaveSeat(client.id); // one seat per client — sitting elsewhere moves you (ready resets)
      tables[ti].seats[si] = { kind: 'human', clientId: client.id, name: client.name, ready: false };
      break;
    }
    case 'leave': leaveSeat(client.id); break;
    case 'ready': {
      const at = seatOf(client.id);
      if (!at) return;
      tables[at.table].seats[at.seat].ready = !!msg.ready;
      broadcastLobby();
      maybeStart(tables[at.table]);
      return;
    }
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
}

// ---- HTTP + WebSocket -----------------------------------------------------
const server = http.createServer((req, res) => {
  // health probe + a friendly root (Azure pings these); the app lives over WS.
  if (req.url === '/health' || req.url === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('mahjong-online ok'); return; }
  res.writeHead(404); res.end();
});

const localhostOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const wss = new WebSocketServer({
  server,
  // Non-browser clients send no Origin; browsers must match the allowlist (any localhost in dev).
  verifyClient: ({ origin }, cb) => cb(!origin || ALLOWED.includes(origin) || localhostOrigin(origin), 403, 'origin not allowed'),
});

wss.on('connection', (ws) => {
  const id = nextId++;
  const client = { ws, id, name: '' };
  clients.set(id, client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, lobbyFor(id)); // initial snapshot; the client follows with 'hello' (its saved name)
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    try { handle(client, msg); } catch { /* ignore malformed input */ }
  });
  ws.on('close', () => { leaveSeat(id); clients.delete(id); broadcastLobby(); });
  ws.on('error', () => {});
});

// Heartbeat: cull dead sockets so their seats free up (mobile drops, Azure idle culling).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`mahjong-online lobby listening on :${PORT}`));
