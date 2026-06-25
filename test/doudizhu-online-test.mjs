// Headless test for the server-authoritative ONLINE 斗地主 loop (server/poker-table.js + the
// generalized server/index.js). Spins up the server hosting a doudizhu (3-seat) table and drives a
// raw WebSocket client (1 human + 2 bots): sit → bots → ready → the server runs a full 场, the human
// bids and plays off each pushed redacted view, and partway through it DROPS and RECONNECTS with the
// same uid — the server must hold the seat, resync, and the 场 must keep progressing to a recorded
// leaderboard. No browser; this validates the protocol + ground truth.
// Usage: node test/doudizhu-online-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';
import { legalMoves } from '../games/doudizhu/engine.js';

const PORT = 8194;
const UID = 'dou-test-uid-1';
// A 场 ends when a player reaches DOU_MATCH_TARGET points; '1' means the first completed hand closes it
// (every settlement makes some seat ≥ 1), so the test runs a single hand over a reconnect.
const SCORES_FILE = path.join(os.tmpdir(), `dou-online-test-scores-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), TABLE_GAMES: 'doudizhu', BOT_THINK_MS: '15', DOU_MATCH_TARGET: '1', SCORES_FILE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let ws = null, setup = false, didReconnect = false, playedAfterReconnect = false, matchDone = false;
let bidCount = 0, overSeen = 0, awaitCount = 0;
const events = [];
const overMatchEnds = []; // ev.matchEnd on each 'over' — only the 场's final hand should be true
const deadline = Date.now() + 60000;

function done(code, msg) { console.log(msg); try { ws && ws.terminate(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {} srv.kill(); process.exit(code); }
const fail = (m) => done(1, 'DOU ONLINE TEST FAIL: ' + m + (srvErr ? '\n  server stderr: ' + srvErr : ''));
const send = (m) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const act = (a) => send({ type: 'action', ...a });

// Smallest legal move from a redacted view (my seat is yourSeat). Returns {do} action or pass.
function actOnPlay(view) {
  const me = view.yourSeat;
  const hand = view.hands[me] || [];
  const against = view.leadSeat === me ? null : view.lead;
  const moves = legalMoves(hand.map((c) => c.rank), against).sort((a, b) => a.size - b.size || a.rank - b.rank);
  if (!moves.length) { if (view.leadSeat !== me) act({ do: 'pass' }); return; }
  const mv = moves[0];
  const pool = hand.slice(); const ids = [];
  for (const r of mv.ranks) { const i = pool.findIndex((c) => c.rank === r); ids.push(pool[i].id); pool.splice(i, 1); }
  act({ do: 'play', cardIds: ids });
}

function reconnect() {
  console.log('  [reconnect] dropping the socket, reconnecting with the same uid…');
  try { ws.close(); } catch {}
  setTimeout(openClient, 300);
}

function onMsg(msg) {
  if (msg.type === 'lobby') {
    if (matchDone) {
      if (!didReconnect || !playedAfterReconnect) return fail('reconnect drill did not resume play before the 场 finished');
      const me = (msg.leaderboard || []).find((r) => r.mine);
      if (!me) return fail('leaderboard is missing the player after the 场 finished');
      if (me.matches !== 1) return fail(`expected 1 finished 场 on the leaderboard, got ${me.matches}`);
      return done(0, `full 斗地主 场 (first-to-target) over a reconnect; leaderboard recorded (me: ${me.total >= 0 ? '+' : ''}${me.total} / ${me.matches}场)\nDOU ONLINE TEST PASS`);
    }
    if (!setup && msg.you && !msg.you.seat) {
      send({ type: 'sit', table: 0, seat: 0 });
      for (const s of [1, 2]) send({ type: 'addBot', table: 0, seat: s });
      send({ type: 'ready', ready: true });
      setup = true;
    }
    return;
  }
  if (msg.type !== 'game') return;
  const { ev, view } = msg;
  events.push(ev.t);

  if (ev.t === 'deal') { act({ do: 'dealDone' }); return; }
  if (ev.t === 'matchOver') {
    if (overMatchEnds[overMatchEnds.length - 1] !== true) return fail("the 场's final hand was not flagged matchEnd");
    if (overMatchEnds.slice(0, -1).some((x) => x)) return fail('a non-final hand was wrongly flagged matchEnd');
    matchDone = true; return;
  }
  if (ev.t === 'over') { overSeen++; overMatchEnds.push(!!ev.matchEnd); return; }
  if (ev.t === 'handEnd') { act({ do: 'next' }); return; }
  if (ev.t === 'sync') {
    if (didReconnect) playedAfterReconnect = true;
    if (view.phase === 'play' && view.turn === view.yourSeat) actOnPlay(view);
    return;
  }
  if (ev.t === 'await' && ev.seat === view.yourSeat) {
    if (ev.who === 'bid') {
      bidCount++;
      // Bid 3 the first time so we reliably become the landlord and the hand plays out; otherwise pass.
      act({ do: 'bid', call: view.highBid < 3 && bidCount === 1 ? 3 : 0 });
      return;
    }
    // who === 'play'
    awaitCount++;
    if (!didReconnect && awaitCount === 2) { didReconnect = true; return reconnect(); } // drop mid-hand
    if (didReconnect) playedAfterReconnect = true;
    actOnPlay(view);
  }
}

function openClient() {
  ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name: '阿斗', uid: UID, game: 'doudizhu' })));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } onMsg(m); });
  ws.on('error', () => {});
}

openClient();
const watchdog = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(watchdog); fail(`timed out — events: ${[...new Set(events)].join(',')} | reconnect=${didReconnect} resumed=${playedAfterReconnect} over=${overSeen} matchDone=${matchDone}`); }
}, 1000);
