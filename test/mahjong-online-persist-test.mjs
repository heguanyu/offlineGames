// Server-restart persistence: play a few hands, KILL the server (SIGTERM → it flushes the 锅
// standings to the database), restart it on the same DB file, and just RECONNECT (no re-ready) — the
// 锅 must auto-resume from the saved scores / 圈 / 庄 (NOT a reset to round 1), landing back on the
// table. Standings are captured from the live frames (the DB file is now SQLite, not JSON).
// Usage: node test/mahjong-online-persist-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8192, UID = 'persist-uid';
const STATE = path.join(os.tmpdir(), `mj-persist-${PORT}.db`);
const cleanDb = () => { for (const ext of ['', '-journal', '.tmp', '.legacy.bak']) { try { fs.unlinkSync(STATE + ext); } catch {} } };
cleanDb();

function startServer() {
  const s = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '15', SCORES_FILE: STATE }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500); });
}
const firstDiscardable = (v) => v.hands[0].find((t) => t >= 0 && !(v.wilds || []).includes(t));

let srv, ws, phase = 1, setup = false, deals = 0, savedPot = null;
const done = (c, m) => { console.log(m); try { ws && ws.terminate(); } catch {} try { srv && srv.kill(); } catch {} cleanDb(); process.exit(c); };
const fail = (m) => done(1, 'PERSIST TEST FAIL: ' + m);
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const act = (a) => send({ type: 'action', ...a });
const onTurn = (v) => { if (v.phase === 'await-discard' && v.turn === 0) act({ do: 'discard', tile: firstDiscardable(v) }); else if (v.phase === 'await-claim' && v.claim && v.claim.player === 0) act({ do: 'pass' }); };

function onMsg(m) {
  if (m.type === 'lobby') {
    if (phase === 1 && !setup && m.you && !m.you.seat) { send({ type: 'sit', table: 0, seat: 0 }); for (const s of [1, 2, 3]) send({ type: 'addBot', table: 0, seat: s }); send({ type: 'ready', ready: true }); setup = true; }
    // phase 2: do NOTHING in the lobby — reconnecting (hello) must auto-resume the 锅 on its own.
    return;
  }
  if (m.type !== 'game') return;
  const { ev, view } = m;
  if (ev.t === 'lazhuang') { act({ do: 'lazhuang', yes: false }); return; }
  if (ev.t === 'deal') {
    deals++;
    act({ do: 'dealDone' }); // ack the deal (as a real client does) so the server drives the bots without the 8s fallback
    if (phase === 2) return checkResume(view);
    if (deals >= 4) { // hands 1-3 are committed by now → snapshot the standings, then kill mid-hand-4
      savedPot = { scores: view.scores.slice(), prevailingWind: view.prevailingWind, dealer: view.dealer };
      return restart();
    }
    return;
  }
  if (ev.t === 'await' && ev.seat === 0) return onTurn(view);
  if (ev.t === 'handEnd') { act({ do: 'next' }); return; }
  if (ev.t === 'potOver') { if (phase === 1) fail('锅 finished before the restart (unlucky) — re-run'); return; }
}

async function restart() {
  if (!savedPot || !Array.isArray(savedPot.scores)) return fail('no standings captured before restart');
  try { ws.close(); } catch {}
  srv.kill('SIGTERM');                         // graceful → the server flushes the committed snapshot to the DB
  await new Promise((r) => srv.on('exit', r));
  console.log(`  killed mid-锅; standings before restart: scores=${JSON.stringify(savedPot.scores)} 圈=${savedPot.prevailingWind} 庄=${savedPot.dealer}`);
  phase = 2; setup = false; deals = 0;
  srv = await startServer();
  openClient();
}

function checkResume(v) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(v.scores, savedPot.scores)) return fail(`resumed scores ${JSON.stringify(v.scores)} ≠ saved ${JSON.stringify(savedPot.scores)} (the 锅 reset!)`);
  if (v.prevailingWind !== savedPot.prevailingWind) return fail(`resumed 圈 ${v.prevailingWind} ≠ saved ${savedPot.prevailingWind}`);
  if (v.dealer !== savedPot.dealer) return fail(`resumed 庄 ${v.dealer} ≠ saved ${savedPot.dealer}`);
  const k = v.seatKinds || [];
  if (!(k[0] === 'human' && k[1] === 'bot' && k[3] === 'bot')) return fail('seats not restored: ' + JSON.stringify(k));
  done(0, `RESUMED the same 锅 after restart (from the DB) — scores=${JSON.stringify(v.scores)}, 圈=${v.prevailingWind}, 庄=${v.dealer}, seats restored\nMAHJONG ONLINE PERSIST TEST PASS`);
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
