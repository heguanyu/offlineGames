// Headless test for the online game loop running the 国标 ruleset (server/rulesets/guobiao.js)
// through the SAME generic lobby + Table + protocol as 天津. Spawns the server with
// GAME_TYPE=guobiao, drives a raw WebSocket client (1 human + 3 bots): sit → bots → ready →
// the server runs a full 锅 (4 圈). The human auto-passes claims (taking any offered 胡), auto-
// discards, and takes self-draw wins. Validates the 国标 claim QUEUE (吃/点炮), the no-拉庄 flow,
// and that the shared network layer reaches 'potOver' + records the leaderboard for 国标.
// Usage: node test/mahjong-online-guobiao-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8193;
const UID = 'gb-test-uid-1';
const SCORES_FILE = path.join(os.tmpdir(), `mj-gb-online-test-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), GAME_TYPE: 'guobiao', BOT_THINK_MS: '15', SCORES_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let ws = null, setup = false, potDone = false;
let overSeen = 0, claimsSeen = 0;
const events = new Set();
const overPotEnds = [];
const deadline = Date.now() + 120000; // a full 国标 锅 (4 圈)

function done(code, msg) { console.log(msg); try { ws && ws.terminate(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {} srv.kill(); process.exit(code); }
const fail = (m) => done(1, 'GUOBIAO ONLINE TEST FAIL: ' + m + (srvErr ? '\n  server stderr: ' + srvErr : ''));
const send = (m) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const act = (a) => send({ type: 'action', ...a });

// React to any state where it might be our turn (claim window or our discard).
function actOnTurn(view) {
  if (view.phase === 'await-claim' && view.claim && view.claim.player === 0) {
    if (view.claim.type === 'win') { claimsSeen++; act({ do: 'claim' }); } // take the 点炮 win
    else act({ do: 'pass' });                                              // decline 碰/杠/吃
    return;
  }
  if (view.phase === 'await-discard' && view.turn === 0) {
    if (view.canWin) { claimsSeen++; act({ do: 'win' }); return; }         // take the self-draw win
    act({ do: 'discard', tile: view.hands[0].find((t) => t >= 0) });
  }
}

function onMsg(msg) {
  if (msg.type === 'lobby') {
    if (potDone) {
      const me = (msg.leaderboard || []).find((r) => r.mine);
      if (!me) return fail('leaderboard missing the player after the 锅');
      if (me.pots !== 1) return fail(`expected 1 finished 锅, got ${me.pots}`);
      return done(0, `full 国标 锅; leaderboard recorded (me: ${me.total >= 0 ? '+' : ''}${me.total} / ${me.pots}锅; wins taken=${claimsSeen}, overs=${overSeen})\nGUOBIAO ONLINE TEST PASS`);
    }
    if (!setup && msg.you && !msg.you.seat) {
      send({ type: 'sit', table: 0, seat: 0 });
      for (const s of [1, 2, 3]) send({ type: 'addBot', table: 0, seat: s });
      send({ type: 'ready', ready: true });
      setup = true;
    }
    return;
  }
  if (msg.type !== 'game') return;
  const { ev, view } = msg;
  events.add(ev.t);
  if (ev.t === 'lazhuang') return fail('国标 must never emit a 拉庄 event');
  if (ev.t === 'deal') { act({ do: 'dealDone' }); return; }
  if (ev.t === 'claim') { claimsSeen++; return; }
  if (ev.t === 'potOver') {
    if (overPotEnds[overPotEnds.length - 1] !== true) return fail("the 锅's final hand was not flagged potEnd");
    if (overPotEnds.slice(0, -1).some((x) => x)) return fail('a non-final hand was wrongly flagged potEnd');
    potDone = true; return;
  }
  if (ev.t === 'over') { overSeen++; overPotEnds.push(!!ev.potEnd); return; }
  if (ev.t === 'handEnd') { act({ do: 'next' }); return; }
  if (ev.t === 'sync') { actOnTurn(view); return; }
  if (ev.t === 'await' && ev.seat === 0) actOnTurn(view);
}

function openClient() {
  ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name: '国标测', uid: UID })));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } onMsg(m); });
  ws.on('error', () => {});
}
openClient();
const watchdog = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(watchdog); fail(`timed out — events: ${[...events].join(',')} overs=${overSeen} potDone=${potDone}`); }
}, 1000);
