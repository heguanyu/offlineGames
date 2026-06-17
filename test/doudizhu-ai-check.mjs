// 斗地主 AI checks: legality (the AI never returns an illegal move), termination, and a
// strength sanity check (a smarter tier beats a dumber one as landlord, well above chance).
// Usage: node test/doudizhu-ai-check.mjs
import { Game, PHASE, legalMoves, classify, beats, ROLE } from '../games/doudizhu/engine.js';
import { chooseBid, chooseMove } from '../games/doudizhu/ai.js';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } }

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Play one full hand. `levels[seat]` is the AI tier for that seat. `forceLandlord`, if set,
// makes that seat win the bidding (so we can hold roles fixed for the strength test).
// Returns the engine result, or null if the deal was a redeal (everyone passed).
function playHand(levels, rng, forceLandlord = -1, validate = false) {
  const g = new Game({ rng });
  // bidding
  let guard = 0;
  while (g.phase === PHASE.BID && guard++ < 10) {
    const seat = g.bidTurn;
    let call = chooseBid(g, seat, levels[seat], rng);
    if (forceLandlord >= 0) call = seat === forceLandlord ? 3 : 0;
    g.placeBid(seat, call);
  }
  if (g.phase === PHASE.OVER) return null; // redeal
  if (forceLandlord >= 0 && g.landlord !== forceLandlord) return null;
  // play
  guard = 0;
  while (g.phase === PHASE.PLAY && guard++ < 1000) {
    const seat = g.turn;
    const mv = chooseMove(g, seat, levels[seat], rng);
    if (validate) {
      if (mv.pass) {
        ok(seat !== g.leadSeat, 'never passes on its own lead');
      } else {
        const d = g.validatePlay(seat, mv.cardIds);
        ok(!!d, `move is legal (seat ${seat})`);
      }
    }
    const okMove = g.play(seat, mv.pass ? [] : mv.cardIds);
    ok(okMove, `engine accepts the AI move (seat ${seat})`);
    if (!okMove) break;
  }
  ok(g.phase === PHASE.OVER, 'hand terminates');
  return g.result;
}

// --- legality + termination across tiers ---
console.log('legality + termination:');
{
  const rng = mulberry32(42);
  let played = 0;
  for (let i = 0; i < 30 && played < 20; i++) {
    const r = playHand([1, 1, 1], rng, -1, true);
    if (r) played++;
  }
  ok(played >= 10, `enough non-redeal hands played (${played})`);
}
// level 2 (Monte-Carlo) smoke: legal + terminates
console.log('level 2 (Monte-Carlo) smoke:');
{
  const rng = mulberry32(7);
  let played = 0;
  for (let i = 0; i < 12 && played < 6; i++) {
    const r = playHand([2, 2, 2], rng, -1, true);
    if (r) played++;
  }
  ok(played >= 3, `level-2 hands completed (${played})`);
}

// --- strength: heuristic (1) vs greedy/erratic (0), roles held fixed ---
// The seat under test is always the landlord; the two peasants are the baseline tier. A stronger
// landlord should win materially more of its hands than a weaker landlord over the same deals.
console.log('strength (landlord winrate, smart vs dumb):');
function landlordWinrate(landlordLevel, peasantLevel, games, seed) {
  const rng = mulberry32(seed);
  let wins = 0, n = 0;
  for (let i = 0; i < games * 4 && n < games; i++) {
    const levels = [peasantLevel, peasantLevel, peasantLevel];
    levels[0] = landlordLevel;
    const r = playHand(levels, rng, 0, false);
    if (!r) continue;
    n++;
    if (r.landlordWon) wins++;
  }
  return { rate: wins / n, n };
}
const smart = landlordWinrate(1, 0, 120, 1001);
const dumb = landlordWinrate(0, 0, 120, 1001);
console.log(`  heuristic landlord winrate: ${(smart.rate * 100).toFixed(1)}% over ${smart.n}`);
console.log(`  greedy   landlord winrate: ${(dumb.rate * 100).toFixed(1)}% over ${dumb.n}`);
ok(smart.rate > dumb.rate + 0.07, `heuristic landlord clearly stronger than greedy (${(smart.rate * 100).toFixed(1)}% vs ${(dumb.rate * 100).toFixed(1)}%)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
