// Headless test for the server-authoritative online game loop (server/table.js + index.js).
// Spins up the server and drives a raw WebSocket client (1 human + 3 bots): sit → bots →
// ready → the server runs the hand, the human acts on each pushed view, and partway through
// the human DROPS and RECONNECTS with the same uid — the server must hold the seat, resync,
// and the hand must keep progressing. No browser; this validates the protocol + ground truth.
// Usage: node test/mahjong-online-game-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8191;
const UID = 'test-uid-1';
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let ws = null, setup = false, didReconnect = false, syncSeen = false;
let overSeen = 0, awaitCount = 0;
const events = [];
const deadline = Date.now() + 45000;

function done(code, msg) { console.log(msg); try { ws && ws.terminate(); } catch {} srv.kill(); process.exit(code); }
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

  if (ev.t === 'potOver') return done(0, 'pot finished — server ran the whole 锅\nMAHJONG ONLINE GAME TEST PASS');
  if (ev.t === 'over') {
    overSeen++;
    if (didReconnect && syncSeen && overSeen >= 1) return done(0, `hand resolved after reconnect (events: ${[...new Set(events)].join(',')})\nMAHJONG ONLINE GAME TEST PASS`);
  }
  if (ev.t === 'handEnd') { act({ do: 'next' }); return; }
  if (ev.t === 'lazhuang') { act({ do: 'lazhuang', yes: false }); return; }
  if (ev.t === 'sync') { syncSeen = true; actOnTurn(view); return; }
  if (ev.t === 'await' && ev.seat === 0) {
    awaitCount++;
    if (!didReconnect && awaitCount === 3) { didReconnect = true; return reconnect(); } // drop mid-turn
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
  if (Date.now() > deadline) { clearInterval(watchdog); fail(`timed out — events seen: ${[...new Set(events)].join(',')} | reconnect=${didReconnect} sync=${syncSeen} over=${overSeen}`); }
}, 1000);
