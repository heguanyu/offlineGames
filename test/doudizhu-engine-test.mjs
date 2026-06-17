// Unit tests for the 斗地主 rules engine. Pure logic, no browser.
// Usage: node test/doudizhu-engine-test.mjs
import { classify, beats, legalMoves, COMBO, Game, PHASE, makeDeck } from '../games/doudizhu/engine.js';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
const ty = (ranks) => { const d = classify(ranks); return d ? d.type : null; };

// --- deck ---
console.log('deck:');
eq(makeDeck().length, 54, '54 cards');

// --- classification ---
console.log('classify:');
eq(ty([5]), COMBO.SINGLE, 'single');
eq(ty([5, 5]), COMBO.PAIR, 'pair');
eq(ty([5, 6]), null, 'two different ranks ≠ combo');
eq(ty([7, 7, 7]), COMBO.TRIO, 'trio');
eq(ty([7, 7, 7, 3]), COMBO.TRIO_SINGLE, 'trio+single');
eq(ty([7, 7, 7, 3, 3]), COMBO.TRIO_PAIR, 'trio+pair');
eq(ty([3, 4, 5, 6, 7]), COMBO.STRAIGHT, '5-straight 3-7');
eq(ty([3, 4, 5, 6]), null, '4-straight too short');
eq(ty([11, 12, 13, 14, 15]), null, 'straight cannot include 2');
eq(ty([10, 11, 12, 13, 14]), COMBO.STRAIGHT, '10-J-Q-K-A straight');
eq(ty([3, 3, 4, 4, 5, 5]), COMBO.DOUBLE_STRAIGHT, '连对 ×3');
eq(ty([3, 3, 4, 4]), null, '连对 needs ≥3 pairs');
eq(ty([3, 3, 3, 4, 4, 4]), COMBO.PLANE, '飞机 pure (2 trios)');
eq(ty([3, 3, 3, 4, 4, 4, 5, 6]), COMBO.PLANE_SINGLE, '飞机带两单');
eq(ty([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]), COMBO.PLANE_PAIR, '飞机带两对');
eq(ty([8, 8, 8, 8]), COMBO.BOMB, 'bomb');
eq(ty([8, 8, 8, 8, 3, 4]), COMBO.FOUR_SINGLE, '四带二单');
eq(ty([8, 8, 8, 8, 3, 3, 4, 4]), COMBO.FOUR_PAIR, '四带两对');
eq(ty([16, 17]), COMBO.ROCKET, 'rocket 双王');
eq(ty([16, 16]), null, 'two same jokers impossible but not a pair-combo of 16');

// --- comparison (beats) ---
console.log('beats:');
const C = (ranks) => classify(ranks);
ok(beats(C([6]), C([5])), '6 > 5 single');
ok(!beats(C([5]), C([6])), '5 ≯ 6');
ok(!beats(C([6, 6]), C([5])), 'pair cannot beat single (type mismatch)');
ok(beats(C([8, 8, 8, 8]), C([5])), 'bomb beats single');
ok(beats(C([9, 9, 9, 9]), C([8, 8, 8, 8])), 'bigger bomb beats bomb');
ok(!beats(C([8, 8, 8, 8]), C([9, 9, 9, 9])), 'smaller bomb loses');
ok(beats(C([16, 17]), C([9, 9, 9, 9])), 'rocket beats bomb');
ok(!beats(C([9, 9, 9, 9]), C([16, 17])), 'nothing beats rocket');
ok(beats(C([4, 5, 6, 7, 8]), C([3, 4, 5, 6, 7])), 'higher straight, same length');
ok(!beats(C([3, 4, 5, 6, 7, 8]), C([3, 4, 5, 6, 7])), 'straights of different length do not compare');
ok(beats(C([5]), null), 'free lead: any combo beats null');

// --- legal moves ---
console.log('legalMoves:');
// Hand 3,3,3,4,5,6,7 → should include the trio, the straight 3-7, singles, pairs, etc.
const hr = [3, 3, 3, 4, 5, 6, 7];
const lead = legalMoves(hr, null);
ok(lead.some((m) => m.type === COMBO.TRIO && m.rank === 3), 'lead has trio 3');
ok(lead.some((m) => m.type === COMBO.STRAIGHT && m.rank === 3 && m.len === 5), 'lead has straight 3-7');
// Following a single 5: only singles > 5 (and bombs/rockets) are legal.
const follow = legalMoves(hr, classify([5]));
ok(follow.every((m) => (m.type === COMBO.SINGLE && m.rank > 5) || m.type === COMBO.BOMB || m.type === COMBO.ROCKET), 'follow-single only higher singles or bombs');
ok(follow.some((m) => m.type === COMBO.SINGLE && m.rank === 6), 'can follow 5 with 6');
ok(!follow.some((m) => m.type === COMBO.SINGLE && m.rank === 4), 'cannot follow 5 with 4');
// Against a bomb, only bigger bombs / rocket.
const vsBomb = legalMoves([9, 9, 9, 9, 16, 17, 3], classify([8, 8, 8, 8]));
ok(vsBomb.some((m) => m.type === COMBO.BOMB && m.rank === 9), 'bigger bomb available vs bomb');
ok(vsBomb.some((m) => m.type === COMBO.ROCKET), 'rocket available vs bomb');
ok(vsBomb.every((m) => m.type === COMBO.BOMB || m.type === COMBO.ROCKET), 'only bombs/rocket vs bomb');

// every legal move must actually beat the target and be re-classifiable
ok(lead.every((m) => classify(m.ranks)), 'all lead moves re-classify');
ok(follow.every((m) => beats(classify(m.ranks), classify([5]))), 'all follow moves truly beat 5');

// --- bidding + a scripted full hand → settlement ---
console.log('game flow:');
let seed = 12345;
const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const g = new Game({ rng, firstBidder: 0 });
eq(g.phase, PHASE.BID, 'starts in bidding');
ok([0, 1, 2].includes(g.bidTurn), 'a seat to bid');
// drive bidding: seat calls 3 → immediate landlord
g.placeBid(g.bidTurn, 3);
eq(g.phase, PHASE.PLAY, 'call of 3 → straight to play');
eq(g.bid, 3, 'base score = 3');
ok(g.landlord >= 0, 'landlord chosen');
eq(g.hands[g.landlord].length, 20, 'landlord holds 20 cards');
eq(g.turn, g.landlord, 'landlord leads');

// the leader may not pass
ok(!g.play(g.turn, []), 'leader cannot pass');

// play out greedily-legal moves until someone wins; assert it terminates and settles
let guard = 0;
while (g.phase === PHASE.PLAY && guard++ < 500) {
  const seat = g.turn;
  const against = seat === g.leadSeat ? null : g.lead;
  const moves = legalMoves(g.hands[seat].map((c) => c.rank), against);
  if (moves.length === 0) { ok(g.play(seat, []), 'forced pass legal'); continue; }
  // pick the move using the fewest cards (a dumb but valid policy)
  moves.sort((a, b) => a.size - b.size || a.rank - b.rank);
  const want = moves[0];
  // map ranks → concrete card ids from the hand
  const ids = []; const pool = g.hands[seat].slice();
  for (const r of want.ranks) { const i = pool.findIndex((c) => c.rank === r); ids.push(pool[i].id); pool.splice(i, 1); }
  ok(g.play(seat, ids), 'scripted legal play accepted');
}
eq(g.phase, PHASE.OVER, 'hand reaches OVER');
ok(g.result && g.result.winner >= 0, 'a winner');
const sum = g.result.delta.reduce((a, b) => a + b, 0);
eq(sum, 0, 'settlement is zero-sum');
ok(g.result.total > 0, 'positive stake');
// landlord delta magnitude = 2× a peasant's
const ld = Math.abs(g.result.delta[g.result.landlord]);
const pe = Math.abs(g.result.delta[(g.result.landlord + 1) % 3]);
eq(ld, 2 * pe, 'landlord settles 2× a peasant');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
