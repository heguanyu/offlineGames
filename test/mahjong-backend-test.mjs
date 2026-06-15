// Unit test for the game Backend boundary (backend.js) — the seam the UI is decoupled
// across. Covers the factory, the LocalBackend event flow + action handling (the in-process
// "server"), and that the RemoteBackend has the same shape with stubs awaiting server calls.
// Usage: node test/mahjong-backend-test.mjs
import { createBackend, LocalBackend, RemoteBackend, HUMAN } from '../games/mahjong-tianjin/backend.js';
import { PHASE } from '../games/mahjong-tianjin/engine.js';

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('  FAIL:', m); } }
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

// --- factory ---------------------------------------------------------------
console.log('factory:');
ok(createBackend({ mode: 'local' }) instanceof LocalBackend, 'local → LocalBackend');
ok(createBackend({ mode: 'remote' }) instanceof RemoteBackend, 'remote → RemoteBackend');
ok(createBackend() instanceof LocalBackend, 'default → LocalBackend');
let badMode = false; try { createBackend({ mode: 'nope' }); } catch { badMode = true; }
ok(badMode, 'unknown mode throws');

async function run() {
  // --- LocalBackend: deal, drive to the human, then play the hand out ---------
  console.log('LocalBackend flow:');
  const events = [];
  const b = createBackend({ mode: 'local', thinkDelay: 0, rng: rng(7) });
  b.onEvent(async (ev) => { events.push(ev.type); if (ev.type === 'lazhuang') b.decideLaZhuang(false); });

  // human is the 庄 → no 拉庄 prompt; startHand resolves once the human must act.
  await b.startHand({ dealer: HUMAN, prevailingWind: 0, scores: [0, 0, 0, 0], seatBase: 0, level: 2 });
  ok(events[0] === 'deal', "first event is 'deal'");
  ok(events[events.length - 1] === 'await', "pauses on an 'await' for the human");
  const v = b.getState();
  ok(v && v.hands[HUMAN].length === 14, 'GameView: the 庄 (human) holds 14 tiles after the deal');
  ok(v.phase === PHASE.AWAIT_DISCARD && v.turn === HUMAN, 'paused at the human discard');
  ok(typeof v.isWild === 'function' && typeof v.seatWind === 'function', 'GameView carries the helper methods the UI reads');

  // Drive the human (discard / pass / take a win); the backend keeps advancing the bots.
  let guard = 0;
  while (b.getState().phase !== PHASE.OVER && guard++ < 80) {
    const g = b.getState();
    if (g.phase === PHASE.AWAIT_CLAIM && g.claim.player === HUMAN) { await b.pass(); continue; }
    if (g.phase === PHASE.AWAIT_DISCARD && g.turn === HUMAN) {
      if (g.selfDrawWin) { await b.declareWin(); continue; }
      await b.discard(g.hands[HUMAN].find((t) => !g.isWild(t)));
      continue;
    }
    break; // the backend should only ever pause at a human decision point
  }
  ok(b.getState().phase === PHASE.OVER, 'hand reaches OVER by driving the human + bots');
  ok(events.includes('discard'), "'discard' events fired (human + bots)");
  ok(events.includes('over'), "an 'over' event fired");

  // a stale action after the hand ended is a safe no-op (validated against the live game)
  const before = b.getState().result;
  await b.discard(0);
  ok(b.getState().result === before, 'an action after OVER is ignored');

  // --- non-庄 hand: deal first (table refreshes), THEN ask 'lazhuang' (still blind — the UI hides
  // the hand). The prompt carries `need` so the cross-panel knows who must choose. ----
  console.log('LocalBackend 拉庄:');
  const ev2 = [];
  const b2 = createBackend({ mode: 'local', thinkDelay: 0, rng: rng(3) });
  let asked = false, lzNeed = null;
  b2.onEvent(async (ev) => { ev2.push(ev.type); if (ev.type === 'lazhuang') { asked = true; lzNeed = ev.need; b2.decideLaZhuang(true); } });
  await b2.startHand({ dealer: 1, prevailingWind: 0, scores: [0, 0, 0, 0], seatBase: 0, level: 2 });
  ok(asked && ev2[0] === 'deal', "a non-庄 hand deals first, then asks 'lazhuang'");
  ok(ev2.indexOf('deal') < ev2.indexOf('lazhuang'), '拉庄 is asked AFTER the deal (blind, hand kept face-down)');
  ok(Array.isArray(lzNeed) && lzNeed.includes(HUMAN), "the 'lazhuang' event names the human as a pending challenger");
  ok(b2.getState().isLaZhuang(HUMAN), 'a yes answer puts the human in the 拉庄 set');

  // a new hand bumps the generation, so a stale opponent loop cannot touch the new game
  console.log('LocalBackend generation guard:');
  const b3 = new LocalBackend({ thinkDelay: 5, rng: rng(9) });
  b3.onEvent(async (ev) => { if (ev.type === 'lazhuang') b3.decideLaZhuang(false); });
  const first = b3.startHand({ dealer: 1, prevailingWind: 0, scores: [0, 0, 0, 0], seatBase: 0, level: 2 });
  const second = b3.startHand({ dealer: 0, prevailingWind: 0, scores: [0, 0, 0, 0], seatBase: 0, level: 2 });
  await Promise.all([first, second]);
  ok(b3.getState().dealer === 0, 'the latest startHand wins; the abandoned one does not clobber it');

  // --- RemoteBackend: same contract, stubs not implemented --------------------
  // RemoteBackend now implemented (online play); the full drive is in mahjong-online-client-test.
  console.log('RemoteBackend shape:');
  const r = createBackend({ mode: 'remote', url: 'ws://localhost:1', uid: 'x' });
  for (const m of ['onEvent', 'getState', 'connect', 'dispose', 'discard', 'claim', 'pass', 'selfKong', 'declareWin', 'decideLaZhuang', 'next', 'unready', 'dealDone'])
    ok(typeof r[m] === 'function', `RemoteBackend implements ${m}()`);
  ok(r.getState() === null, 'RemoteBackend.getState() is null before any frame');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run();
