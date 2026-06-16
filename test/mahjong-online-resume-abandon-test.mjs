// A 锅 that survives a restart but NOBODY returns to must not linger forever. After the restart the
// restored seats get a ready window (backfill); if no occupant reconnects to resume the game within it,
// the sweep abandons the dead 锅 and resets the table. (The happy path — a player DOES reconnect and
// the 锅 resumes — is covered by the resilience + persist tests, which reconnect within the window.)
// Usage: node test/mahjong-online-resume-abandon-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8206;
const READY_MS = 1500;
const SCORES_FILE = path.join(os.tmpdir(), `mj-resume-abandon-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '20', SCORES_FILE, READY_MS: String(READY_MS) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(srv); }); setTimeout(() => res(srv), 2500); });
}
function open(uid, name, onMsg) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', uid, name })));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } onMsg(ws, m); });
  ws.on('error', () => {});
  return ws;
}
let srv = null;
function finish(code, msg) { console.log(msg); try { srv && srv.kill(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {} process.exit(code); }

try {
  // --- 1) A sits + 3 bots + ready → a 锅 starts and is persisted ---
  srv = await startServer();
  let started = false, seated = false;
  const A = open('abandon-A', '独行', (ws, m) => {
    if (m.type === 'lobby' && !seated && m.you && !m.you.seat) {
      ws.send(JSON.stringify({ type: 'sit', table: 0, seat: 0 }));
      for (const s of [1, 2, 3]) ws.send(JSON.stringify({ type: 'addBot', table: 0, seat: s }));
    }
    if (m.type === 'lobby' && m.you && m.you.seat) { seated = true; ws.send(JSON.stringify({ type: 'ready', ready: true })); }
    if (m.type === 'gameStart' || m.type === 'game') started = true;
  });
  for (let i = 0; i < 60 && !started; i++) await wait(100);
  if (!started) finish(1, 'RESUME-ABANDON TEST FAIL: the 锅 never started on the first server');
  await wait(300); // let the 锅 snapshot persist
  try { A.terminate(); } catch {}
  srv.kill('SIGTERM'); await wait(600);

  // --- 2) restart; A never reconnects. An observer watches table 0: it starts occupied (the restored
  //         seats) and must be auto-abandoned (all empty) once the backfilled window elapses. ---
  srv = await startServer();
  let occupiedAtBoot = false, abandoned = false;
  open('abandon-observer', '看客', (ws, m) => {
    if (m.type !== 'lobby') return;
    const seats = m.tables && m.tables[0] && m.tables[0].seats;
    if (!seats) return;
    if (seats.some((s) => s)) occupiedAtBoot = true;
    if (occupiedAtBoot && seats.every((s) => !s)) abandoned = true;
  });
  for (let i = 0; i < 80 && !(occupiedAtBoot && abandoned); i++) await wait(100);
  if (!occupiedAtBoot) finish(1, 'RESUME-ABANDON TEST FAIL: restored 锅 table was not present after restart');
  if (!abandoned) finish(1, 'RESUME-ABANDON TEST FAIL: dead 锅 (nobody returned) was NOT abandoned');
  finish(0, 'restored 锅 with no returning player was abandoned + table reset\nMAHJONG ONLINE RESUME-ABANDON TEST PASS');
} catch (e) {
  finish(1, 'RESUME-ABANDON TEST FAIL: ' + e.message);
}
