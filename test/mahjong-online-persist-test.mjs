// Server-restart persistence: play a few hands, KILL the server (SIGTERM → it flushes the 锅
// standings), restart it on the same state file, reconnect, re-ready, and confirm the 锅 resumes
// from the saved scores / 圈 / 庄 — NOT a reset to round 1. Also checks the seats were restored.
// Usage: node test/mahjong-online-persist-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8192, UID = 'persist-uid';
const STATE = path.join(os.tmpdir(), `mj-persist-${PORT}.json`);
try { fs.unlinkSync(STATE); } catch {}

function startServer() {
  const s = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '15', SCORES_FILE: STATE }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500); });
}
const firstDiscardable = (v) => v.hands[0].find((t) => t >= 0 && !(v.wilds || []).includes(t));

let srv, ws, phase = 1, setup = false, deals = 0, savedPot = null;
const done = (c, m) => { console.log(m); try { ws && ws.terminate(); } catch {} try { srv && srv.kill(); } catch {} try { fs.unlinkSync(STATE); } catch {} process.exit(c); };
const fail = (m) => done(1, 'PERSIST TEST FAIL: ' + m);
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const act = (a) => send({ type: 'action', ...a });
const onTurn = (v) => { if (v.phase === 'await-discard' && v.turn === 0) act({ do: 'discard', tile: firstDiscardable(v) }); else if (v.phase === 'await-claim' && v.claim && v.claim.player === 0) act({ do: 'pass' }); };

function onMsg(m) {
  if (m.type === 'lobby') {
    if (phase === 1 && !setup && m.you && !m.you.seat) { send({ type: 'sit', table: 0, seat: 0 }); for (const s of [1, 2, 3]) send({ type: 'addBot', table: 0, seat: s }); send({ type: 'ready', ready: true }); setup = true; }
    else if (phase === 2 && m.you && m.you.seat) { if (!setup) { setup = true; send({ type: 'ready', ready: true }); } } // restored seat → re-ready to resume
    return;
  }
  if (m.type !== 'game') return;
  const { ev, view } = m;
  if (ev.t === 'lazhuang') { act({ do: 'lazhuang', yes: false }); return; }
  if (ev.t === 'deal') {
    deals++;
    if (phase === 2) return checkResume(view);
    if (deals >= 4) return restart(); // hands 1-3 are committed by now → kill mid-hand-4
    return;
  }
  if (ev.t === 'await' && ev.seat === 0) return onTurn(view);
  if (ev.t === 'handEnd') { act({ do: 'next' }); return; }
  if (ev.t === 'potOver') { if (phase === 1) fail('锅 finished before the restart (unlucky) — re-run'); return; }
}

async function restart() {
  try { ws.close(); } catch {}
  srv.kill('SIGTERM');                         // graceful → the server flushes the committed snapshot
  await new Promise((r) => srv.on('exit', r));
  let saved; try { saved = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return fail('state file unreadable: ' + e.message); }
  const t0 = saved.tables && saved.tables[0];
  savedPot = t0 && t0.pot;
  if (!savedPot || !Array.isArray(savedPot.scores)) return fail('no 锅 snapshot persisted: ' + JSON.stringify(t0));
  const seats = t0.seats || [];
  if (!(seats[0] && seats[0].kind === 'human' && seats[0].uid === UID)) return fail('human seat not restored: ' + JSON.stringify(seats[0]));
  if (!(seats[1] && seats[1].kind === 'bot' && seats[3] && seats[3].kind === 'bot')) return fail('bot seats not restored');
  console.log(`  killed mid-锅; persisted standings: scores=${JSON.stringify(savedPot.scores)} 圈=${savedPot.prevailingWind} 庄=${savedPot.dealer} 每圈=${savedPot.rounds.length}`);
  phase = 2; setup = false; deals = 0;
  srv = await startServer();
  openClient();
}

function checkResume(v) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(v.scores, savedPot.scores)) return fail(`resumed scores ${JSON.stringify(v.scores)} ≠ saved ${JSON.stringify(savedPot.scores)} (the 锅 reset!)`);
  if (v.prevailingWind !== savedPot.prevailingWind) return fail(`resumed 圈 ${v.prevailingWind} ≠ saved ${savedPot.prevailingWind}`);
  if (v.dealer !== savedPot.dealer) return fail(`resumed 庄 ${v.dealer} ≠ saved ${savedPot.dealer}`);
  done(0, `RESUMED the same 锅 after restart — scores=${JSON.stringify(v.scores)}, 圈=${v.prevailingWind}, 庄=${v.dealer}\nMAHJONG ONLINE PERSIST TEST PASS`);
}

function openClient() {
  ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => send({ type: 'hello', name: '阿持', uid: UID }));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } onMsg(m); });
  ws.on('error', () => {});
}

srv = await startServer();
openClient();
setTimeout(() => fail('timed out'), 45000);
