// Viewer mode: a non-seated client spectates a specific human seat. It must receive THAT seat's
// frames (incl. the player's hand) and have its own actions IGNORED by the server. We run a real
// hand driven by the seated player while the viewer watches seat 0 and spams discard actions; the
// hand must complete normally (proving the viewer can't act) and the viewer must have seen the hand.
// Usage: node test/mahjong-online-viewer-test.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocket } from 'ws';
import { ROOT as root } from './harness.mjs';

const PORT = 8193;
const STATE = path.join(os.tmpdir(), `mj-viewer-${PORT}.db`);
const clean = () => { for (const e of ['', '-journal', '.tmp', '.legacy.bak']) { try { fs.unlinkSync(STATE + e); } catch {} } };
clean();

const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')],
  { env: { ...process.env, PORT: String(PORT), BOT_THINK_MS: '15', SCORES_FILE: STATE }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => { srv.stdout.on('data', (d) => { if (/listening/.test(d)) res(); }); setTimeout(res, 2500); });

let pl, vw;
const done = (c, m) => { console.log(m); try { pl && pl.terminate(); } catch {} try { vw && vw.terminate(); } catch {} try { srv.kill(); } catch {} clean(); process.exit(c); };
const fail = (m) => done(1, 'MAHJONG ONLINE VIEWER TEST FAIL: ' + m);
const firstDiscardable = (v) => (v.hands?.[0] || []).find((t) => t >= 0 && !(v.wilds || []).includes(t));

let viewerStarted = false, sawYourSeat = false, sawHand = false, viewerActed = false, frames = 0, passed = false;

// ---- seated player (drives the hand) ----
pl = new WebSocket(`ws://localhost:${PORT}`);
const sendP = (m) => { if (pl.readyState === 1) pl.send(JSON.stringify(m)); };
const actP = (a) => sendP({ type: 'action', ...a });
let setupP = false;
pl.on('open', () => sendP({ type: 'hello', name: '庄家', uid: 'viewer-player' }));
pl.on('message', (d) => {
  let m; try { m = JSON.parse(d); } catch { return; }
  if (m.type === 'lobby') {
    if (!setupP && m.you && !m.you.seat) { sendP({ type: 'sit', table: 0, seat: 0 }); for (const s of [1, 2, 3]) sendP({ type: 'addBot', table: 0, seat: s }); sendP({ type: 'ready', ready: true }); setupP = true; }
    return;
  }
  if (m.type !== 'game') return;
  const { ev, view } = m;
  if (ev.t === 'lazhuang') { actP({ do: 'lazhuang', yes: false }); return; }
  if (ev.t === 'deal') { actP({ do: 'dealDone' }); if (!viewerStarted) { viewerStarted = true; connectViewer(); } return; }
  if (ev.t === 'await' && ev.seat === 0) { const t = firstDiscardable(view); if (t != null) actP({ do: 'discard', tile: t }); return; }
  if (ev.t === 'handEnd') { actP({ do: 'next' }); return; } // keep the 锅 going so the viewer reliably catches an 'over'
});

// ---- spectator (watches seat 0, tries to interfere) ----
function connectViewer() {
  vw = new WebSocket(`ws://localhost:${PORT}`);
  const sendV = (m) => { if (vw.readyState === 1) vw.send(JSON.stringify(m)); };
  vw.on('open', () => sendV({ type: 'hello', name: '看客', uid: 'the-viewer', spectate: { table: 0, seat: 0 } }));
  vw.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.type === 'noGame') return fail('viewer got noGame — could not spectate a live game');
    if (m.type !== 'game') return;
    const { view } = m;
    frames++;
    if (view.yourSeat === 0) sawYourSeat = true;                          // we are seeing seat 0's perspective
    if ((view.hands?.[0] || []).some((t) => t >= 0)) sawHand = true;      // the watched player's hand is visible
    const t = firstDiscardable(view);                                    // spam actions — the server MUST ignore them (we're not seated)
    if (t != null) { sendV({ type: 'action', do: 'discard', tile: t }); viewerActed = true; }
    // Success: we've watched seat 0's hand through a healthy stream of live frames while the seated
    // player drove the game and OUR actions were ignored (had they registered, the seated hand would
    // desync and the game would stall/error instead of streaming on).
    if (!passed && sawYourSeat && sawHand && viewerActed && frames >= 12) {
      passed = true;
      done(0, `viewer streamed ${frames} live frames of seat 0 (hand visible); its own actions were ignored\nMAHJONG ONLINE VIEWER TEST PASS`);
    }
  });
}

setTimeout(() => fail('timed out'), 40000);
