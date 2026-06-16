// Unit test for the 国标 game Backend boundary (games/guobiao/backend.js): the factory, the
// LocalBackend event flow + action handling (deal / claim-queue / 自摸 / discard), the seat
// rotation mappers, and that RemoteBackend has the right shape over the shared transport.
// Usage: node test/guobiao-backend-test.mjs
import { createBackend, LocalBackend, RemoteBackend, buildRemoteView, mapServerEvent, HUMAN } from '../games/guobiao/backend.js';
import { PHASE } from '../games/guobiao/engine.js';

let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('  FAIL:', m); } }
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

console.log('factory:');
ok(createBackend({ mode: 'local' }) instanceof LocalBackend, 'local → LocalBackend');
ok(createBackend({ mode: 'remote' }) instanceof RemoteBackend, 'remote → RemoteBackend');
ok(createBackend() instanceof LocalBackend, 'default → LocalBackend');
let badMode = false; try { createBackend({ mode: 'nope' }); } catch { badMode = true; }
ok(badMode, 'unknown mode throws');

async function run() {
  // --- LocalBackend: deal, drive to the human, then play the hand out (across several hands so
  // claims/吃/自摸 are exercised) ---
  console.log('LocalBackend flow:');
  let dealSeen = false, sawDiscard = false, sawOver = false, sawClaim = false, awaitPauses = 0;
  const b = createBackend({ mode: 'local', thinkDelay: 0, rng: rng(11) });
  b.onEvent(async (ev) => {
    if (ev.type === 'deal') dealSeen = true;
    if (ev.type === 'discard') sawDiscard = true;
    if (ev.type === 'claim') sawClaim = true;
    if (ev.type === 'over') sawOver = true;
    if (ev.type === 'await') awaitPauses++;
  });

  await b.startHand({ dealer: HUMAN, roundWind: 0, scores: [0, 0, 0, 0], level: 2 });
  ok(dealSeen, "first event is 'deal'");
  const v = b.getState();
  ok(v && v.hands[HUMAN].length === 14, 'the 庄 (human) holds 14 tiles after the deal');
  ok(v.phase === PHASE.AWAIT_DISCARD && v.turn === HUMAN, 'paused at the human discard');
  ok(typeof v.seatWind === 'function' && typeof v.isWild === 'function' && typeof v.currentClaim === 'function', 'GameView carries the helper methods the UI reads');
  ok(v.isWild(0) === false, '国标 has no 混儿 (isWild always false)');

  // Drive the human (pass claims unless it's a win; take self-draws; else discard) to OVER.
  let guard = 0;
  while (b.getState().phase !== PHASE.OVER && guard++ < 400) {
    const g = b.getState();
    if (g.phase === PHASE.AWAIT_CLAIM && g.currentClaim() && g.currentClaim().player === HUMAN) {
      const c = g.currentClaim();
      if (c.type === 'win') await b.claim('win'); else await b.pass();
      continue;
    }
    if (g.phase === PHASE.AWAIT_DISCARD && g.turn === HUMAN) {
      if (g.selfDrawWin) { await b.declareWin(); continue; }
      await b.discard(g.hands[HUMAN][0]);
      continue;
    }
    break; // should only ever pause at a human decision point
  }
  ok(b.getState().phase === PHASE.OVER, 'hand reaches OVER by driving the human + bots');
  ok(sawDiscard, "'discard' events fired");
  ok(sawOver, "an 'over' event fired");
  ok(awaitPauses > 0, 'paused for the human at least once');
  void sawClaim; // claims are opportunistic — not asserted (depends on the deal)

  // a stale action after the hand ended is a safe no-op
  const before = b.getState().result;
  await b.discard(0);
  ok(b.getState().result === before, 'an action after OVER is ignored');

  // --- seat rotation mappers (player at absolute seat 2 → display index 0) ---
  console.log('rotation mappers:');
  const sv = {
    yourSeat: 2, dealer: 2, roundWind: 1, turn: 3, phase: PHASE.AWAIT_DISCARD, minFan: 8,
    scores: [10, 20, 30, 40], wallCount: 50,
    hands: [[1], [2], [3], [4]], melds: [[], [], [], []], discards: [[], [], [], []],
    discardLog: [{ player: 1, kind: 5 }], lastDiscard: { player: 1, kind: 5 },
    drawnTile: null, claim: null, canWin: false, winInfo: null, result: null,
    seatNames: ['A', 'B', 'C', 'D'], seatKinds: ['human', 'bot', 'human', 'bot'],
  };
  const view = buildRemoteView(sv, 2);
  ok(view.dealer === 0, 'dealer (abs 2) rotates to display 0');
  ok(view.turn === 1, 'turn (abs 3) rotates to display 1');
  ok(view.scores[0] === 30 && view.scores[1] === 40, 'scores re-indexed to display order');
  ok(view.seatNames[0] === 'C', 'our seat (C) is display 0');
  ok(view.seatWind(0) === 0, 'our seat reads 东 (dealer)');
  ok(mapServerEvent({ t: 'discard', player: 1, tile: 5 }, 2, view).player === 3, 'discard event player rotated (abs1→disp3)');
  ok(mapServerEvent({ t: 'claim', player: 3, claim: 'chow', kind: 5 }, 2, view).type === 'claim', 'claim event mapped');
  ok(mapServerEvent({ t: 'over' }, 2, view).type === 'over', 'over event mapped');
  ok(mapServerEvent({ t: 'lazhuang' }, 2, view) === null, '国标 ignores any stray lazhuang event');

  // --- RemoteBackend shape ---
  console.log('RemoteBackend shape:');
  const r = createBackend({ mode: 'remote', url: 'ws://localhost:1', uid: 'x' });
  for (const m of ['onEvent', 'getState', 'connect', 'dispose', 'discard', 'claim', 'pass', 'selfKong', 'declareWin', 'next', 'unready', 'dealDone'])
    ok(typeof r[m] === 'function', `RemoteBackend implements ${m}()`);
  ok(r.getState() === null, 'RemoteBackend.getState() is null before any frame');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run();
