// Headless test for FORFEIT when another human remains: 2 humans (seats 0,1) + 2 bots. Player A
// (seat 0) forfeits mid-game. The server must replace A with a bot and KEEP PLAYING for player B —
// B keeps receiving frames, and in B's rotated view A's seat is now a bot. A is bounced to the lobby.
// Usage: node test/mahjong-online-forfeit-continue-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8203;
const SCORES_FILE = path.join(os.tmpdir(), `mj-forfeit-cont-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20', SCORES_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

const deadline = Date.now() + 45000;
let aForfeited = false, bFramesAfter = 0, bSawBotAtA = false, aGotLobbyAfter = false;
function done(code, msg) { console.log(msg); try { A.ws.terminate(); B.ws.terminate(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {} srv.kill(); process.exit(code); }
const fail = (m) => done(1, 'FORFEIT-CONTINUE TEST FAIL: ' + m + (srvErr ? '\n  server stderr: ' + srvErr : ''));

function client(uid, name, seat) {
  const c = { uid, name, seat, ws: null, ready: false };
  const send = (m) => { if (c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m)); };
  c.act = (a) => send({ type: 'action', ...a });
  c.open = () => {
    c.ws = new WebSocket(`ws://localhost:${PORT}`);
    c.ws.on('open', () => send({ type: 'hello', name, uid }));
    c.ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } c.onMsg(m); });
    c.ws.on('error', () => {});
  };
  c.send = send;
  return c;
}

const A = client('forfeit-A', '甲', 0);
const B = client('forfeit-B', '乙', 1);

// shared per-game play: dealDone, answer 拉庄 no, discard on our turn / pass claims
function autoPlay(c, ev, view) {
  if (ev.t === 'deal') { c.act({ do: 'dealDone' }); return; }
  if (ev.t === 'lazhuang') { c.act({ do: 'lazhuang', yes: false }); return; }
  if (ev.t === 'await' && ev.seat === c.seat) {
    if (view.phase === 'await-claim') { c.act({ do: 'pass' }); return; }
    if (view.phase === 'await-discard') {
      if (view.canWin) { c.act({ do: 'win' }); return; }
      const t = view.hands[0].find((x) => x >= 0 && !(view.wilds || []).includes(x));
      c.act({ do: 'discard', tile: t });
    }
  }
}

A.onMsg = (m) => {
  if (m.type === 'lobby') {
    if (!A.ready && m.you && !m.you.seat) { A.send({ type: 'sit', table: 0, seat: 0 }); A.send({ type: 'addBot', table: 0, seat: 2 }); A.send({ type: 'addBot', table: 0, seat: 3 }); }
    else if (aForfeited && (!m.you || !m.you.seat)) aGotLobbyAfter = true; // A bounced back to the lobby, unseated
    return;
  }
  if (m.type !== 'game') return;
  if (aForfeited) return fail('A must stop receiving game frames after forfeiting');
  // forfeit on A's first turn-to-act
  if (m.ev.t === 'await' && m.ev.seat === 0) { aForfeited = true; A.act({ do: 'forfeit' }); return; }
  autoPlay(A, m.ev, m.view);
};

B.onMsg = (m) => {
  if (m.type === 'lobby') {
    if (!B.ready && m.you && !m.you.seat) { B.send({ type: 'sit', table: 0, seat: 1 }); }
    return;
  }
  if (m.type !== 'game') return;
  if (aForfeited) {
    bFramesAfter++;
    // A is absolute seat 0 → B's display index (0 - 1 + 4) % 4 = 3. The namecard must read 机器人
    // (not A's old name) AND the seat kind must be bot — the forfeit→bot rename, everywhere.
    if (m.view.seatKinds && m.view.seatKinds[3] === 'bot' && m.view.seatNames && m.view.seatNames[3] === '机器人') bSawBotAtA = true;
    if (bFramesAfter >= 4 && bSawBotAtA && aGotLobbyAfter) {
      return done(0, `A forfeited → replaced by a bot; B kept playing (${bFramesAfter} frames), A's seat shows 机器人, A returned to lobby\nMAHJONG ONLINE FORFEIT-CONTINUE TEST PASS`);
    }
  }
  autoPlay(B, m.ev, m.view);
};

// ready both up once seated (poll briefly), then play
A.open();
setTimeout(() => B.open(), 400);
const readyTimer = setInterval(() => {
  // ready each once seated; the game starts when both ready + 2 bots
  if (!A.ready) { A.send({ type: 'ready', ready: true }); A.ready = true; }
  if (!B.ready) { B.send({ type: 'ready', ready: true }); B.ready = true; }
}, 600);
setTimeout(() => clearInterval(readyTimer), 4000);

const watchdog = setInterval(() => {
  if (Date.now() > deadline) { clearInterval(watchdog); fail(`timed out — aForfeited=${aForfeited} bFramesAfter=${bFramesAfter} bSawBotAtA=${bSawBotAtA} aGotLobby=${aGotLobbyAfter}`); }
}, 1000);
