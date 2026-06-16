// Backfill on restart: a human who sat (and never readied) is persisted to the DB. After a server
// RESTART the seat is restored without a readyBy (the field isn't persisted / may predate the timer),
// so without a backfill it would sit idle forever. The server must give it a fresh 1-minute window on
// boot, and the sweep then frees it — even though that player never reconnects.
// Usage: node test/mahjong-online-ready-backfill-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8205;
const READY_MS = 1500;
const SCORES_FILE = path.join(os.tmpdir(), `mj-ready-backfill-${PORT}.json`);
try { fs.unlinkSync(SCORES_FILE); } catch {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), SCORES_FILE, READY_MS: String(READY_MS) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(srv); }); setTimeout(() => res(srv), 2500); });
}
// open a ws, send hello, collect the latest lobby frame
function open(uid, name, onLobby) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', uid, name })));
  ws.on('message', (d) => { let m; try { m = JSON.parse(d); } catch { return; } if (m.type === 'lobby' && onLobby) onLobby(m); });
  ws.on('error', () => {});
  return ws;
}

let ok = false, srv = null;
function finish(code, msg) { console.log(msg); try { srv && srv.kill(); } catch {} try { fs.unlinkSync(SCORES_FILE); } catch {} process.exit(code); }

try {
  // --- 1) first server: A sits at table 0 / seat 0 and never readies; persisted to the DB ---
  srv = await startServer();
  let aSeated = false;
  const A = open('backfill-A', '赖着', (m) => { if (m.you && m.you.seat) aSeated = true; else if (!aSeated) A.send(JSON.stringify({ type: 'sit', table: 0, seat: 0 })); });
  for (let i = 0; i < 40 && !aSeated; i++) await wait(100);
  if (!aSeated) finish(1, 'READY-BACKFILL TEST FAIL: A never got seated on the first server');
  await wait(300); // let the seat persist
  try { A.terminate(); } catch {}
  srv.kill('SIGTERM'); await wait(600); // graceful flush + exit

  // --- 2) restart: the seat is restored (no readyBy). A does NOT reconnect. An observer (other uid)
  //         watches and must see the idle seat get auto-freed within the backfilled window. ---
  srv = await startServer();
  let seatedAtBoot = false, freed = false;
  open('backfill-observer', '看客', (m) => {
    const seat = m.tables && m.tables[0] && m.tables[0].seats && m.tables[0].seats[0];
    if (seat && seat.kind === 'human') seatedAtBoot = true;
    if (seatedAtBoot && !seat) freed = true;
  });
  for (let i = 0; i < 60 && !(seatedAtBoot && freed); i++) await wait(100);
  if (!seatedAtBoot) finish(1, 'READY-BACKFILL TEST FAIL: restored idle seat was not present after restart');
  if (!freed) finish(1, `READY-BACKFILL TEST FAIL: restored idle seat was NOT auto-freed (backfill missing)`);
  ok = true;
  finish(0, 'restored idle seat got a fresh window and was auto-freed\nMAHJONG ONLINE READY-BACKFILL TEST PASS');
} catch (e) {
  finish(1, 'READY-BACKFILL TEST FAIL: ' + e.message);
}
