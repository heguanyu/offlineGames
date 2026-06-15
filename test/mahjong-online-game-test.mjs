// Headless test for the server-authoritative online game loop (server/table.js + index.js).
// Spins up the server and drives a raw WebSocket client (1 human + 3 bots): sit → bots →
// ready → the server runs the hand, the human acts on each pushed view, and partway through
// the human DROPS and RECONNECTS with the same uid — the server must hold the seat, resync,
// and the hand must keep progressing. No browser; this validates the protocol + ground truth.
// Usage: node test/mahjong-online-game-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8191;
const UID = 'test-uid-1';
// a fresh per-run score file so the leaderboard assertion is deterministic (pots === 1)
const SCORES_FILE = path.join(os.tmpdir(), `mj-online-test-scores-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20', SCORES_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let ws = null, setup = false, didReconnect = false, playedAfterReconnect = false, potDone = false;
let overSeen = 0, awaitCount = 0;
const events = [];
const deadline = Date.now() + 90000; // a full 锅 (4 圈) over a reconnect

function done(code, msg) { console.log(msg); try { ws && ws.terminate(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {} srv.kill(); process.exit(code); }
const fail = (m) => done(1, 'ONLINE GAME TEST FAIL: ' + m + (srvErr ? '\n  server stderr: ' + srvErr : ''));

const send = (m) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const act = (a) => send({ type: 'action', ...a });
const firstDiscardable = (view) => view.hands[0].find((t) => t >= 0 && !(view.wilds || []).includes(t));

// React to a state where it might be our turn (used for both 'await' frames and post-reconnect 'sync').
function actOnTurn(view) {
  if (view.phase === 'await-claim' && view.claim && view.claim.player === 0) { act({ do: 'pass' }); return; }
  if (view.phase === 'await-discard' && view.turn === 0) {
    if (view.canWin) { act({ do: 'win' }); return; }
    act({ do: 'discard', tile: firstDiscardable(view) });
  }
}

function reconnect() {
  console.log('  [reconnect] dropping the socket, reconnecting with the same uid…');
  try { ws.close(); } catch {}
  setTimeout(openClient, 300);
}

function onMsg(msg) {
  if (msg.type === 'lobby') {
    if (potDone) { // the 锅 just finished → the server must have recorded it to the leaderboard
      if (!didReconnect || !playedAfterReconnect) return fail('reconnect drill did not resume play before the 锅 finished');
      const me = (msg.leaderboard || []).find((r) => r.mine);
      if (!me) return fail('leaderboard is missing the player after the 锅 finished');
      if (me.pots !== 1) return fail(`expected 1 finished 锅 on the leaderboard, got ${me.pots}`);
      return done(0, `full 锅 over a reconnect; leaderboard recorded (me: ${me.total >= 0 ? '+' : ''}${me.total} / ${me.pots}锅)\nMAHJONG ONLINE GAME TEST PASS`);
    }
    if (!setup && msg.you && !msg.you.seat) { // first lobby → sit, fill with bots, ready
      send({ type: 'sit', table: 0, seat: 0 });
      for (const s of [1, 2, 3]) send({ type: 'addBot', table: 0, seat: s });
      send({ type: 'ready', ready: true });
      setup = true;
    }
    return;
  }
  if (msg.type !== 'game') return;
  const { ev, view } = msg;
  events.push(ev.t);

  // Play the WHOLE 锅: each hand ends with 'over' (result) then 'handEnd' (→ 下一局); the 锅
  // ends with 'potOver'. Partway through we DROP and reconnect (same uid) and must resume.
  if (ev.t === 'deal') { act({ do: 'dealDone' }); return; }  // a real client acks when its deal animation ends → server drives the bots
  if (ev.t === 'potOver') { potDone = true; return; } // wait for the lobby frame that records the score
  if (ev.t === 'over') { overSeen++; return; }         // result pushed; the server follows with handEnd
  if (ev.t === 'handEnd') { act({ do: 'next' }); return; }
  if (ev.t === 'lazhuang') { act({ do: 'lazhuang', yes: false }); return; }
  if (ev.t === 'sync') { if (didReconnect) playedAfterReconnect = true; actOnTurn(view); return; }
  if (ev.t === 'await' && ev.seat === 0) {
    awaitCount++;
    if (!didReconnect && awaitCount === 3) { didReconnect = true; return reconnect(); } // drop mid-turn
    if (didReconnect) playedAfterReconnect = true; // the resync re-issued our turn → we act on it (not via timeout)
    actOnTurn(view);
  }
}

function openClient() {
  ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name: '阿测', uid: UID })));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } onMsg(m); });
  ws.on('error', () => {});
}

openClient();
const watchdog = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(watchdog); fail(`timed out — events seen: ${[...new Set(events)].join(',')} | reconnect=${didReconnect} resumed=${playedAfterReconnect} over=${overSeen} potDone=${potDone}`); }
}, 1000);
