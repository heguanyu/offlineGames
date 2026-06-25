// 天津麻将联机版 — lobby + table server.
//
// Plain `ws` on the HTTP server Azure App Service hands us (listen on process.env.PORT,
// TLS terminated by the platform → clients connect over wss://). Holds the AUTHORITATIVE
// lobby state — 4 tables × 4 seats (东南西北) — and, once a table fills with ready humans /
// bots, an authoritative Table game (server/table.js). The server PUSHES every change; the
// client never polls. Players are identified by a persistent `uid` (their localStorage id),
// so a dropped connection can reconnect to its seat and resync the game in progress.
//
// This same process ALSO serves the static PWA site (the whole repo, staged alongside) for
// every non-WebSocket request, with native COOP/COEP/CORP headers so the threaded emulator
// cores get crossOriginIsolated (SharedArrayBuffer) without the sw.js header hack that GitHub
// Pages forced. GitHub Pages remains a fully working mirror; the client (lobby.js) connects to
// whichever origin served it, so both hosts work.
//
// Run locally:  PORT=8090 node index.js   (serves the site at http://localhost:8090/)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Table } from './table.js';
import { PokerTable } from './poker-table.js';
import { ruleset as tianjin } from './rulesets/tianjin.js';
import { ruleset as guobiao, freeRuleset as guobiaoFree } from './rulesets/guobiao.js';
import { BOT_NAMES } from '../games/mahjong-common/bot-names.js';
import db from './db.js';
import { startWeather, getWeatherJson } from './weather.js';

// The games the lobby can host. Each table hosts ONE game; the lobby is split per game (the hub's
// online cards deep-link a game). Every game shares the same lobby + reconnect + { type:'game' }
// protocol — what differs is the seat count, the table driver, and (for mahjong) the ruleset:
//   kind 'mahjong' → 4 seats, server/table.js + a ruleset (server/rulesets/*.js)
//   kind 'poker'   → 3 seats, server/poker-table.js (runs games/doudizhu's engine + AI directly)
// TABLE_GAMES overrides the lineup; GAME_TYPE keeps the legacy single-type form (used by tests).
// `bots` names a game's NPC seats (by seat index). Mahjong uses the 东南西北 chair names; 斗地主 has
// its own trio (阿牛 / 阿强 / 阿美).
const DOU_BOT_NAMES = ['阿牛', '阿强', '阿美'];
const GAMES = {
  tianjin: { kind: 'mahjong', seats: 4, ruleset: tianjin, label: '天津麻将', page: 'mahjong-tianjin', bots: BOT_NAMES },
  guobiao: { kind: 'mahjong', seats: 4, ruleset: guobiao, label: '国标麻将', page: 'guobiao', bots: BOT_NAMES },
  'guobiao-free': { kind: 'mahjong', seats: 4, ruleset: guobiaoFree, label: '国标无定番', page: 'guobiao-free', bots: BOT_NAMES },
  doudizhu: { kind: 'poker', seats: 3, label: '斗地主', page: 'doudizhu', bots: DOU_BOT_NAMES },
};
const botNamesFor = (gameType) => (GAMES[gameType] || GAMES.tianjin).bots;
const TABLE_GAMES = (process.env.TABLE_GAMES ? process.env.TABLE_GAMES.split(',')
  : process.env.GAME_TYPE ? [process.env.GAME_TYPE]
  : ['tianjin', 'guobiao', 'guobiao-free', 'doudizhu']).map((g) => g.trim()).filter((g) => GAMES[g]);
if (!TABLE_GAMES.length) TABLE_GAMES.push('tianjin');
const seatsOf = (gameType) => (GAMES[gameType] || GAMES.tianjin).seats;

const PORT = process.env.PORT || 8090;
const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  'https://heguanyu.github.io,https://offlinegames.azurewebsites.net,http://localhost:8090,http://127.0.0.1:8090,http://localhost:8137')
  .split(',').map((s) => s.trim());

// The static site root. The server lives at <root>/server/index.js, so the publishable site
// (index.html, games/, emulatorjs/, icons/, shared/, sw.js …) sits one level up — true both for
// a local checkout and for the staged Azure package. Override with STATIC_ROOT if needed.
const STATIC_ROOT = process.env.STATIC_ROOT || fileURLToPath(new URL('..', import.meta.url));

const TABLES = TABLE_GAMES.length;
const WIND = ['东', '南', '西', '北']; // mahjong seat → 风; poker games carry no wind (the client ignores it)
const READY_MS = +process.env.READY_MS || 60_000; // a seated human must ready within this window or the server frees their seat (tests set it low)
const GAME_LABEL = Object.fromEntries(Object.entries(GAMES).map(([g, c]) => [g, c.label]));
const GAME_PAGE = Object.fromEntries(Object.entries(GAMES).map(([g, c]) => [g, c.page])); // lobby navigates here

// ---- persistence (lifetime scores + the live 锅 state) ---------------------
// All durable state lives in the SQLite database (server/db.js): the lifetime leaderboard
// (scoreBook: uid → {name,total,matches}) and a per-table snapshot — its seats + the current 锅's
// standings (scores / 圈 / 庄 / 每圈成绩). The scoreBook is loaded into memory once for fast
// leaderboard reads and written through on every change; the table snapshot is written after each
// hand. A restart RESTORES the seats + 锅 standings (the in-progress hand is dropped); the 锅 then
// auto-resumes from the same round — it never resets to round 1.
// Per-game leaderboards: scoreBook[gameType] → { uid: {name,total,matches} }. Each game has its own
// lifetime board (the lobby is split per game), so a 天津 锅 never mixes into the 国标 standings.
const scoreBook = db.loadScoreBook();
for (const g of TABLE_GAMES) if (!scoreBook[g]) scoreBook[g] = {};
const savedTables = db.loadTables();

// ---- authoritative state --------------------------------------------------
// seat: null | { kind:'human', uid, name, ready } | { kind:'bot' }
// table: { id, status:'waiting'|'playing', seats:[4], game: Table|null, resume: 锅-snapshot|null }
const tables = Array.from({ length: TABLES }, (_, id) => {
  const sv = savedTables[id];
  const nseats = seatsOf(TABLE_GAMES[id]);
  const seats = (sv && Array.isArray(sv.seats) ? sv.seats : []).slice(0, nseats).map((s) => !s ? null
    : s.kind === 'bot' ? { kind: 'bot' }
    : (s.kind === 'human' && s.uid) ? { kind: 'human', uid: s.uid, name: s.name || '', ready: false } : null);
  while (seats.length < nseats) seats.push(null);
  return { id, status: 'waiting', seats, game: null, resume: (sv && sv.match) || null, gameType: TABLE_GAMES[id] };
});

// Backfill on restart: a human seat restored from the DB carries no readyBy (it's not persisted, and
// may predate the ready timer entirely), so the sweep would never free it — leaving a player parked
// idle forever. Give EVERY restored human seat a fresh 1-minute window. This includes a 锅 awaiting
// resume: if an occupant reconnects in time, resumeTable flips the table to 'playing' (and the sweep
// then ignores it) well before the window elapses; if NOBODY returns, the sweep abandons the dead 锅.
for (const t of tables) {
  for (const seat of t.seats) if (seat && seat.kind === 'human' && !seat.ready && !seat.readyBy) seat.readyBy = Date.now() + READY_MS;
}

// Write each table's current snapshot (seats + 锅 standings) to the DB. Cheap + synchronous, so it's
// called directly on every change (seat edits, after each hand); a graceful shutdown adds a final flush.
function persist() { for (const t of tables) db.saveTable(t.id, t.seats, t.game ? t.game.snapshot() : (t.resume || null)); }
const flushState = persist;
// Record one finished 锅 onto THAT game's board: each human seat's final score is added to their
// lifetime total for `game` (forfeiters are bots by now, so they're skipped → no score for them).
function recordMatch(game, seats, finalScores) {
  const book = scoreBook[game] || (scoreBook[game] = {});
  for (let s = 0; s < seats.length; s++) {
    const seat = seats[s];
    if (seat && seat.kind === 'human' && seat.uid) {
      const rec = book[seat.uid] || (book[seat.uid] = { name: seat.name, total: 0, matches: 0 });
      rec.name = seat.name || rec.name; rec.total += finalScores[s] | 0; rec.matches += 1;
      db.savePlayer(game, seat.uid, rec);
    }
  }
}
const leaderboard = (game, uid) => Object.entries(scoreBook[game] || {})
  .sort((a, b) => b[1].total - a[1].total).slice(0, 50)
  .map(([k, r]) => ({ name: r.name, total: r.total, matches: r.matches, mine: k === uid }));
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
  for (const t of tables) for (let s = 0; s < t.seats.length; s++) {
    const seat = t.seats[s];
    if (seat && seat.kind === 'human' && seat.uid === uid) return { table: t.id, seat: s };
  }
  return null;
}

// The lobby view for one player. Only their own seat coordinates are exposed; other seats
// show kind/name/ready only (no uids leak).
function lobbyFor(uid, game) {
  game = scoreBook[game] ? game : TABLE_GAMES[0]; // which game's board this client is viewing
  const mine = seatOf(uid);
  return {
    type: 'lobby',
    game, // the lobby is split per game; the client renders only its game's table + this board
    you: { name: (uid && [...clients.values()].find((c) => c.uid === uid)?.name) || '', seat: mine,
      ready: mine ? !!tables[mine.table].seats[mine.seat].ready : false,
      // ms left on the ready countdown (null once ready / not seated) — the client ticks it down and
      // draws a depleting ring against the full window (readyTotal).
      readyIn: (mine && !tables[mine.table].seats[mine.seat].ready && tables[mine.table].seats[mine.seat].readyBy)
        ? Math.max(0, tables[mine.table].seats[mine.seat].readyBy - Date.now()) : null,
      readyTotal: READY_MS },
    tables: tables.map((t) => ({
      id: t.id, status: t.status, game: t.gameType, gameLabel: GAME_LABEL[t.gameType] || t.gameType,
      seats: t.seats.map((seat, i) => !seat ? null
        : seat.kind === 'bot' ? { kind: 'bot', name: botNamesFor(t.gameType)[i] } // bots are named by seat (麻将 东方雨… / 斗地主 阿牛…)
        // readyIn lets every client show a not-ready player's own countdown (未准备(mm:ss)) — no uid leaks
        : { kind: 'human', name: seat.name, ready: !!seat.ready,
            readyIn: (!seat.ready && seat.readyBy) ? Math.max(0, seat.readyBy - Date.now()) : null }),
    })),
    leaderboard: leaderboard(game, uid),
  };
}
const broadcastLobby = () => { for (const c of clients.values()) send(c.ws, lobbyFor(c.uid, c.game)); };

// Stand up the authoritative game for a full table (every seat occupied). Tells each human to
// open the game page, then routes that seat's frames to the player's current socket.
function startGame(t) {
  t.status = 'playing';
  const gameSeats = t.seats.map((s, i) => s.kind === 'bot' ? { kind: 'bot', name: botNamesFor(t.gameType)[i] } : { kind: 'human', uid: s.uid, name: s.name });
  for (let s = 0; s < gameSeats.length; s++) if (gameSeats[s].kind === 'human') send(uidWs.get(gameSeats[s].uid), { type: 'gameStart', table: t.id, seat: s, wind: WIND[s], game: t.gameType, page: GAME_PAGE[t.gameType] });
  broadcastLobby();
  // route each seat's frames to that player's current socket (reconnection-safe), AND fan them out
  // to any spectators watching that seat (viewer mode — they see exactly what the player sees).
  const emit = (seatIdx, msg) => {
    const gs = gameSeats[seatIdx];
    if (gs.kind === 'human') send(uidWs.get(gs.uid), msg);
    for (const c of clients.values()) if (c.spectate && c.spectate.table === t.id && c.spectate.seat === seatIdx) send(c.ws, msg);
  };
  // online bots play at the hardest level; t.resume carries the 锅 standings across a restart;
  // persist after every hand so a crash resumes from the latest round. The game kind picks the driver:
  // mahjong → Table (+ ruleset); poker (斗地主) → PokerTable (engine + AI imported directly).
  const onMatch = (finalScores) => onMatchOver(t, gameSeats, finalScores);
  if ((GAMES[t.gameType] || {}).kind === 'poker') {
    t.game = new PokerTable(t.id, gameSeats, emit, onMatch, 2, t.resume, persist);
  } else {
    const ruleset = (GAMES[t.gameType] || {}).ruleset || tianjin;
    t.game = new Table(t.id, gameSeats, emit, onMatch, 3, t.resume, persist, ruleset);
  }
  persist();
}

// All four seats filled and every human ready → start the table's authoritative game.
function maybeStart(t) {
  if (t.status !== 'waiting') return;
  if (!t.seats.some((s) => s && s.kind === 'human')) return; // never auto-start an all-bot table (e.g. left behind after a forfeit)
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
function onMatchOver(t, gameSeats, finalScores) {
  if (gameSeats && finalScores) recordMatch(t.gameType, gameSeats, finalScores); // onto this table's game board
  if (t.game) t.game.dispose();
  t.game = null; t.resume = null;
  t.status = 'waiting';
  for (const seat of t.seats) if (seat && seat.kind === 'human') seat.ready = false;
  broadcastLobby();
  persist();
}

// A seated human FORFEITS the live game: their seat becomes a bot in place — it plays on for any
// remaining humans, but recordMatch (keyed on seat.kind === 'human') never records a lifetime score for
// it. If they were the last human, the 锅 is concluded immediately (nobody left to play for). The
// forfeiter's client returns to the lobby on its own; their seat no longer carries their uid, so they
// land back in the lobby unseated.
function forfeitSeat(t, seat) {
  if (!t.game || !t.game.isHuman(seat)) return;
  t.game.forfeit(seat);            // game: seat → bot + release any pending request so the bot takes over
  t.seats[seat] = { kind: 'bot' };  // lobby: drop the human; a bot holds the seat for the rest of the 锅
  if (t.game.humans().length === 0) {
    // no humans left → conclude the 锅 NOW and reset the table to empty (clear the orphaned bots, so it
    // doesn't linger as a phantom all-bot table — which maybeStart would otherwise have auto-started).
    t.seats = t.seats.map(() => null);
    onMatchOver(t, t.game.seats, t.game.scores.slice()); // records nothing (all bots); disposes + back to waiting
  } else {
    t.game.pushEvent({ t: 'sync' }); // remaining players re-render with the bot takeover (nameplate → 机器人)
    broadcastLobby();
    persist();
  }
}

// ---- per-connection messages ----------------------------------------------
const inRange = (ti, si) => ti >= 0 && ti < TABLES && si >= 0 && si < tables[ti].seats.length;

function handle(client, msg) {
  // in-game moves route straight to the authoritative table (no lobby broadcast)
  if (msg.type === 'action') {
    const at = seatOf(client.uid);
    if (at && tables[at.table].game) {
      if (msg.do === 'forfeit') forfeitSeat(tables[at.table], at.seat); // changes seat composition → lobby's job
      else tables[at.table].game.onAction(at.seat, msg);
    }
    return;
  }

  switch (msg.type) {
    case 'hello': {
      client.uid = String(msg.uid || '').slice(0, 64) || ('anon-' + client.id);
      client.name = sanitizeName(msg.name) || `玩家${client.id}`;
      if (GAMES[msg.game] && TABLE_GAMES.includes(msg.game)) client.game = msg.game; // which game's split lobby this client is viewing
      uidWs.set(client.uid, client.ws);
      // Spectator: a NON-seated client asked to watch a specific human seat of a live table. Register
      // it (the seat's frames fan out to it via emit) and seed it with the current catch-up frame.
      // Falls through to a normal hello (→ noGame) if the game's gone or the seat isn't a live human.
      const sp = msg.spectate;
      if (sp && !seatOf(client.uid)) {
        const ti = sp.table | 0, si = sp.seat | 0;
        const st = inRange(ti, si) ? tables[ti] : null;
        if (st && st.status === 'playing' && st.game && st.seats[si] && st.seats[si].kind === 'human') {
          client.spectate = { table: ti, seat: si };
          const frame = st.game.spectateFrame(si);
          if (frame) send(client.ws, frame);
        } else send(client.ws, { type: 'noGame' });
        break;
      }
      client.spectate = null;
      const at = seatOf(client.uid); // reconnection: reclaim a seat held while we were away
      const t = at ? tables[at.table] : null;
      if (t) { const seat = t.seats[at.seat]; seat.name = client.name;
        // reclaiming a waiting seat (e.g. restored after a restart) → a FRESH ready window: you're back,
        // ready up within a minute or the sweep frees the seat.
        if (t.status === 'waiting' && !seat.ready) seat.readyBy = Date.now() + READY_MS; }
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
      tables[ti].seats[si] = { kind: 'human', uid: client.uid, name: client.name, ready: false, readyBy: Date.now() + READY_MS };
      break;
    }
    case 'leave': { const at = seatOf(client.uid); if (at && tables[at.table].status === 'waiting') tables[at.table].seats[at.seat] = null; break; }
    case 'ready': { const at = seatOf(client.uid); if (!at) return; const seat = tables[at.table].seats[at.seat];
      seat.ready = !!msg.ready; seat.readyBy = seat.ready ? null : Date.now() + READY_MS; break; } // un-ready restarts the window
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

// ---- static site serving --------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
const ROOT = path.resolve(STATIC_ROOT);

// Map a request URL to a file inside ROOT (no path traversal). A trailing '/' → that dir's
// index.html. Returns null if the path escapes ROOT.
function resolveStatic(reqUrl) {
  let p;
  try { p = decodeURIComponent(reqUrl.split('?')[0]); } catch { return null; }
  if (p.endsWith('/')) p += 'index.html';
  const full = path.resolve(ROOT, '.' + p);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

// COOP/COEP/CORP enable cross-origin isolation (crossOriginIsolated === true → SharedArrayBuffer →
// threaded emulator cores). Served natively here so a fresh load is isolated immediately, before the
// service worker (which sets the same headers for the GitHub Pages mirror) is even installed.
function isolate(headers) {
  headers['Cross-Origin-Opener-Policy'] = 'same-origin';
  headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  headers['Cross-Origin-Resource-Policy'] = 'same-origin';
  return headers;
}

async function serveStatic(req, res) {
  const file = resolveStatic(req.url);
  if (!file) { res.writeHead(403); res.end(); return; }
  try {
    let target = file;
    let st = await stat(target).catch(() => null);
    if (st && st.isDirectory()) { target = path.join(target, 'index.html'); st = await stat(target).catch(() => null); }
    if (!st || !st.isFile()) { res.writeHead(404, isolate({ 'content-type': 'text/plain; charset=utf-8' })); res.end('not found'); return; }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    const body = req.method === 'HEAD' ? null : await readFile(target);
    res.writeHead(200, isolate({ 'content-type': type, 'content-length': body ? body.length : st.size }));
    res.end(body || undefined);
  } catch { res.writeHead(500); res.end(); }
}

// ---- HTTP + WebSocket -----------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('mahjong-online ok'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  // Server-polled weather for the tourguide dial. CORS-enabled (no isolate()) so the GitHub Pages
  // mirror can read it cross-origin; never cached (dynamic). 503 until the first poll lands.
  if (req.url.split('?')[0] === '/api/weather') {
    const origin = req.headers.origin;
    const cors = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
    if (origin && (ALLOWED.includes(origin) || localhostOrigin(origin))) { cors['Access-Control-Allow-Origin'] = origin; cors['Vary'] = 'Origin'; }
    const body = getWeatherJson();
    res.writeHead(body ? 200 : 503, cors);
    res.end(req.method === 'HEAD' ? undefined : (body || '{"error":"warming up"}'));
    return;
  }
  serveStatic(req, res);
});

const localhostOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }, cb) => cb(!origin || ALLOWED.includes(origin) || localhostOrigin(origin), 403, 'origin not allowed'),
});

wss.on('connection', (ws) => {
  const id = nextId++;
  const client = { ws, id, uid: null, name: '', spectate: null, game: TABLE_GAMES[0] };
  clients.set(id, client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, lobbyFor(null, client.game)); // initial snapshot; the client follows with 'hello' (uid + saved name + game)
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

// Ready sweep: a seated human who hasn't readied within READY_MS is removed from the table, so an idle
// player never blocks a seat indefinitely. While any seat is still counting down we re-push the lobby
// every tick, so the countdown shown by every client (self + others) is server-synced, not a local
// guess. Only waiting tables; bots and ready players are untouched.
const readySweep = setInterval(() => {
  const now = Date.now(); let changed = false, counting = false;
  for (const t of tables) {
    if (t.status !== 'waiting') continue;
    let abandon = false;
    for (let s = 0; s < t.seats.length; s++) {
      const seat = t.seats[s];
      if (!seat || seat.kind !== 'human' || seat.ready || !seat.readyBy) continue;
      if (now > seat.readyBy) {
        if (t.resume) { abandon = true; break; } // a 锅 nobody came back to → drop the whole stale table
        t.seats[s] = null; changed = true;
      } else counting = true;
    }
    if (abandon) { t.seats = t.seats.map(() => null); t.resume = null; changed = true; }
  }
  if (changed) persist();
  if (changed || counting) broadcastLobby();
}, 1000);
wss.on('close', () => clearInterval(readySweep));

// Flush the latest 锅 standings synchronously on a graceful shutdown (Azure sends SIGTERM on a
// restart/redeploy) so the resumed game starts from the most recent round.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushState(); process.exit(0); });

server.listen(PORT, () => console.log(`mahjong-online lobby + site listening on :${PORT} (static root ${ROOT})`));

// Background: refresh the tourguide weather forecast now + hourly (served at /api/weather).
startWeather();
