// Drives the 斗地主 LocalBackend through a full hand, treating the "human" (seat 0) as just
// another AI so the await/resume machinery (askBid + await-play) is exercised end to end.
// Usage: node test/doudizhu-backend-test.mjs
import { createBackend, HUMAN } from '../games/doudizhu/backend.js';
import { chooseBid, chooseMove } from '../games/doudizhu/ai.js';
import { PHASE } from '../games/doudizhu/engine.js';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } }
function mb(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function runHand(seed) {
  const rng = mb(seed);
  const be = createBackend({ mode: 'local', rng, level: 1, thinkDelay: 0 });
  const events = [];
  let result = null;
  // The "human" auto-plays via the AI when asked, so we test the awaited human path.
  be.onEvent(async (ev) => {
    events.push(ev.type);
    const g = be.getState();
    if (ev.type === 'askBid') {
      be.decideBid(chooseBid(g, HUMAN, 1, rng));
    } else if (ev.type === 'await') {
      const mv = chooseMove(g, HUMAN, 1, rng);
      if (mv.pass) await be.pass(); else await be.play(mv.cardIds);
    } else if (ev.type === 'over') {
      result = ev.result;
    } else if (ev.type === 'play') {
      ok(Array.isArray(ev.cardIds) && ev.cardIds.length > 0, 'play event carries cards');
      ok(ev.move && ev.move.type, 'play event carries a combo descriptor');
    }
  });
  await be.startHand();
  return { events, result, be };
}

console.log('backend full hand:');
const seeds = [3, 11, 29, 57, 88];
let completed = 0;
for (const s of seeds) {
  const { events, result, be } = await runHand(s);
  ok(events[0] === 'deal', 'first event is deal');
  ok(events.includes('bidEnd') || events.includes('redeal'), 'bidding resolves');
  if (result) {
    completed++;
    ok(result.winner >= 0, 'a winner');
    ok(result.delta.reduce((a, b) => a + b, 0) === 0, 'zero-sum settlement');
    ok(be.getState().phase === PHASE.OVER, 'game ends in OVER');
  }
}
ok(completed >= 3, `at least a few hands completed to a result (${completed}/${seeds.length})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
