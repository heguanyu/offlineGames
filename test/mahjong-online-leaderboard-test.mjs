// The reported bug: score history didn't survive a server restart. Play a FULL 锅 so the player's
// lifetime total + 锅 count land on the leaderboard, KILL the server, restart on the same DB file,
// reconnect, and confirm the leaderboard still shows the same total/pots (now backed by SQLite).
// Usage: node test/mahjong-online-leaderboard-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8195, UID = 'lb-uid';
const STATE = path.join(os.tmpdir(), `mj-lb-${PORT}.db`);
const cleanDb = () => { for (const ext of ['', '-journal', '.tmp', '.legacy.bak']) { try { fs.unlinkSync(STATE + ext); } catch {} } };
cleanDb();

function startServer() {
  const s = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '8', SCORES_FILE: STATE }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { s.stdout.on('data', (d) => { if (/listening/.test(d)) res(s); }); setTimeout(() => res(s), 2500); });
}
const firstDiscardable = (v) => v.hands[0].find((t) => t >= 0 && !(v.wilds || []).includes(t));

let srv, ws, setup = false, phase = 1, potDone = false, expected = null;
const done = (c, m) => { console.log(m); try { ws && ws.terminate(); } catch {} try { srv && srv.kill(); } catch {} cleanDb(); process.exit(c); };
const fail = (m) => done(1, 'LEADERBOARD TEST FAIL: ' + m);
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const act = (a) => send({ type: 'action', ...a });

function onMsg(m) {
  if (m.type === 'lobby') {
    if (phase === 1 && !setup && m.you && !m.you.seat) { send({ type: 'sit', table: 0, seat: 0 }); for (const s of [1, 2, 3]) send({ type: 'addBot', table: 0, seat: s }); send({ type: 'ready', ready: true }); setup = true; return; }
    const me = (m.leaderboard || []).find((r) => r.mine);
    if (phase === 1 && potDone) { // 锅 finished → capture the leaderboard, then restart the server
      if (!me || me.pots !== 1) return fail('leaderboard not recorded after the 锅: ' + JSON.stringify(me));
      expected = { total: me.total, pots: me.pots };
      console.log(`  锅 finished; leaderboard = total ${me.total}, pots ${me.pots} — restarting server…`);
      return restart();
    }
    if (phase === 2 && me) { // after restart: the leaderboard must be unchanged (NOT reset)
      if (me.total !== expected.total || me.pots !== expected.pots) return fail(`leaderboard reset! after restart total=${me.total} pots=${me.pots}, expected total=${expected.total} pots=${expected.pots}`);
      return done(0, `score history SURVIVED the restart — total ${me.total}, pots ${me.pots}\nMAHJONG ONLINE LEADERBOARD TEST PASS`);
    }
    return;
  }
  if (m.type !== 'game') return;
  const { ev, view } = m;
  if (ev.t === 'deal') { act({ do: 'dealDone' }); return; }
  if (ev.t === 'lazhuang') { act({ do: 'lazhuang', yes: false }); return; }
  if (ev.t === 'handEnd') { act({ do: 'next' }); return; }
  if (ev.t === 'potOver') { potDone = true; return; } // wait for the lobby frame that records the score
  if (ev.t === 'await' && ev.seat === 0) {
    if (view.canWin) { act({ do: 'win' }); return; }
    if (view.phase === 'await-claim' && view.claim && view.claim.player === 0) { act({ do: 'pass' }); return; }
    act({ do: 'discard', tile: firstDiscardable(view) });
  }
}

async function restart() {
  try { ws.close(); } catch {}
  srv.kill('SIGTERM');
  await new Promise((r) => srv.on('exit', r));
  phase = 2;
  srv = await startServer();
  openClient(); // reconnect → the lobby frame carries the (persisted) leaderboard
}

function openClient() {
  ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => send({ type: 'hello', name: '阿榜', uid: UID }));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } onMsg(m); });
  ws.on('error', () => {});
}

srv = await startServer();
openClient();
setTimeout(() => fail('timed out'), 120000);
