// Headless test for FORFEIT (server side): a lone human (+3 bots) starts a hand, then forfeits.
// The server must conclude the 锅 immediately (no humans left), return the table to 'waiting', and
// record NO lifetime score for the forfeiter (they never finish a 锅). Validates the seat→bot
// takeover + conclude-if-last-human + score-exclusion path.
// Usage: node test/mahjong-online-forfeit-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8201;
const UID = 'forfeit-uid-1';
const SCORES_FILE = path.join(os.tmpdir(), `mj-forfeit-test-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20', SCORES_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let ws = null, setup = false, forfeited = false;
const events = new Set();
const deadline = Date.now() + 40000;
function done(code, msg) { console.log(msg); try { ws && ws.terminate(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {} srv.kill(); process.exit(code); }
const fail = (m) => done(1, 'FORFEIT TEST FAIL: ' + m + (srvErr ? '\n  server stderr: ' + srvErr : ''));
const send = (m) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const act = (a) => send({ type: 'action', ...a });

function onMsg(msg) {
  if (msg.type === 'lobby') {
    if (forfeited) { // after forfeiting, the conclude should have bounced us back to a waiting lobby
      const t = msg.tables[0];
      if (t.status !== 'waiting') return; // wait for the table to settle back to waiting
      if (msg.you && msg.you.seat) return fail('forfeiter should no longer hold a seat');
      if ((msg.leaderboard || []).some((r) => r.mine)) return fail('forfeiter must NOT be recorded on the leaderboard');
      if (t.seats.some((s) => s)) return fail('the table should reset to EMPTY when the last human forfeits (no phantom all-bot table), got: ' + JSON.stringify(t.seats));
      return done(0, `forfeit concluded the 锅, table reset to waiting + empty, no score recorded\nMAHJONG ONLINE FORFEIT TEST PASS`);
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
  const { ev } = msg;
  events.add(ev.t);
  if (ev.t === 'deal') { act({ do: 'dealDone' }); return; }
  if (ev.t === 'lazhuang') { act({ do: 'lazhuang', yes: false }); return; }
  // Once we're actually in play and it's our turn, forfeit.
  if (ev.t === 'await' && ev.seat === 0 && !forfeited) {
    forfeited = true;
    act({ do: 'forfeit' });
  }
}

function open() {
  ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name: '弃局者', uid: UID })));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } onMsg(m); });
  ws.on('error', () => {});
}
open();
const watchdog = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(watchdog); fail(`timed out — events: ${[...events].join(',')} forfeited=${forfeited}`); }
}, 1000);
