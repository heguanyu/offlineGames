// Client-side online test: the seat ROTATION helpers (pure) + the RemoteBackend driving a
// real hand against the server with the player at SEAT 2 (so rotation is actually exercised:
// the server's absolute seats must become display index 0 = the player, winds preserved).
// Uses Node's global WebSocket. Usage: node test/mahjong-online-client-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';
import { buildRemoteView, mapServerEvent, createBackend } from '../games/mahjong-tianjin/backend.js';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error('  FAIL:', m); } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --- unit: rotation to the player's perspective (player at absolute seat 2) ----------------
console.log('rotation:');
{
  const sv = {
    yourSeat: 2, phase: 'await-discard', turn: 2, dealer: 1, seatBase: 0, prevailingWind: 0,
    wilds: [5, 6], indicator: 5, wallCount: 40, dealerDouble: true, laZhuang: [1],
    scores: [10, -2, -3, -5], hands: [[0, 0], [-1, -1], [7, 8, 9], [-1]],
    melds: [[], [], [], []], discards: [[], [], [], []], discardLog: [{ player: 1, kind: 3 }],
    drawnTile: 9, claim: null, canWin: false, seatNames: ['A', 'B', 'C', 'D'], seatKinds: ['bot', 'bot', 'human', 'bot'],
  };
  const v = buildRemoteView(sv, 2);
  ok(v.hands[0].join() === '7,8,9', "player's own hand sits at display 0");
  ok(v.hands[1].join() === '-1' && v.hands[3].join() === '-1,-1', 'opponents hidden, re-indexed');
  ok(v.turn === 0, 'turn rotated to the player (0)');
  ok(v.dealer === 3, 'dealer 1 → display 3');
  ok(v.seatWind(0) === 2, 'player keeps their wind (seat 2, seatBase 0 → 西=2)');
  ok(v.seatWind(2) === 0, 'the 东 seat is now display 2');
  ok(v.isWild(5) && !v.isWild(0), 'isWild works from the wild set');
  ok(v.scores.join() === '-3,-5,10,-2', 'scores re-indexed to display order');
  ok(v.laZhuang.join() === '3', 'laZhuang seat 1 → display 3');
  ok(v.discardLog[0].player === 3, 'discardLog player rotated');
  ok(v.wall.length === 40, 'wall count exposed as wall.length');
  ok(mapServerEvent({ t: 'discard', player: 1, tile: 3 }, 2, v).player === 3, 'discard event player rotated');
  ok(mapServerEvent({ t: 'over', player: 0 }, 2, v).type === 'over', 'over event mapped');
}

// --- integration: RemoteBackend plays a hand vs the server, player at seat 2 ----------------
console.log('RemoteBackend integration:');
const PORT = 8192, UID = 'client-test-uid';
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

function finish(code, msg) {
  console.log(msg);
  console.log(`\n${passed} passed, ${failed} failed`);
  try { lobby.close(); backend.dispose(); } catch {}
  srv.kill();
  process.exit(code || (failed ? 1 : 0));
}

// raw lobby client: sit the player at seat 2, fill the rest with bots, ready → game starts
const lobby = new WebSocket(`ws://localhost:${PORT}`);
await new Promise((r) => lobby.on('open', r));
lobby.send(JSON.stringify({ type: 'hello', name: '阿测', uid: UID }));
await delay(150);
lobby.send(JSON.stringify({ type: 'sit', table: 0, seat: 2 }));
for (const s of [0, 1, 3]) lobby.send(JSON.stringify({ type: 'addBot', table: 0, seat: s }));
lobby.send(JSON.stringify({ type: 'ready', ready: true }));
await delay(300); // game started; the player's 拉庄 prompt is pending

// RemoteBackend takes over (same uid): hello → server resyncs and re-emits the pending 拉庄.
let awaited = false, overSeen = 0, sawDeal = false;
const backend = createBackend({ mode: 'remote', url: `ws://localhost:${PORT}`, uid: UID, name: '阿测' });
backend.onEvent(async (ev) => {
  const g = backend.getState();
  if (ev.type === 'lazhuang') { backend.decideLaZhuang(false); return; }
  if (ev.type === 'deal' || ev.type === 'sync') { sawDeal = sawDeal || ev.type === 'deal'; if (g && g.phase) actIfMyTurn(g); return; }
  if (ev.type === 'over') {
    overSeen++;
    ok(backend.yourSeat === 2, 'RemoteBackend knows it is absolute seat 2');
    ok(g && g.result && g.result.winner != null, 'result has a winner (rotated)');
    return finish(0, `hand resolved via RemoteBackend (player seat 2, rotated): awaited=${awaited}\nMAHJONG ONLINE CLIENT TEST PASS`);
  }
  if (ev.type === 'await') { awaited = true; actIfMyTurn(g); }
});
function actIfMyTurn(g) {
  if (g.phase === 'await-claim' && g.claim && g.claim.player === 0) { backend.pass(); return; }
  if (g.phase === 'await-discard' && g.turn === 0) {
    if (g.selfDrawWin) { backend.declareWin(); return; }
    const tile = g.hands[0].find((t) => t >= 0 && !g.isWild(t));
    if (tile != null) backend.discard(tile);
  }
}
backend.connect();

setTimeout(() => finish(1, `timed out (awaited=${awaited} over=${overSeen})` + (srvErr ? '\n server: ' + srvErr : '')), 40000);
