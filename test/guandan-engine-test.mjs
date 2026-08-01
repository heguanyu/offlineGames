// Headless sanity test for the 掼蛋 engine. Run: node games/guandan/engine.test.mjs
import { classify, beats, legalMoves, makeDeck, Round, Match, COMBO, isWild, strengthOf, sortHand } from '../games/guandan/engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

// tiny card factory — ids unique per test card
let _id = 0;
const C = (rank, suit = 0) => ({ id: _id++, rank, suit });
const H = (rank) => C(rank, 1); // heart

// ---- classify: first-category combos --------------------------------------
const L = 2; // level = 2 for these (so ♥2 is the wildcard, 2 is the trump rank)
ok(classify([C(5)], L).type === COMBO.SINGLE, 'single');
ok(classify([C(5), C(5, 1)], L).type === COMBO.PAIR, 'pair (mixed suit)');
ok(classify([C(7), C(7, 2), C(7, 3)], L).type === COMBO.TRIO, 'trio');
ok(classify([C(7), C(7, 2), C(7, 3), C(9), C(9, 2)], L).type === COMBO.TRIO_PAIR, '三带二');
ok(classify([C(3), C(4, 1), C(5), C(6), C(7)], L).type === COMBO.STRAIGHT, 'straight 34567 (mixed suit)');
ok(classify([C(14), C(2, 2), C(3), C(4), C(5)], L).type === COMBO.STRAIGHT, 'A-low straight A2345');
ok(classify([C(10), C(11, 1), C(12), C(13), C(14)], L).type === COMBO.STRAIGHT, 'A-high straight 10JQKA (mixed suit)');
ok(classify([C(3), C(3, 1), C(4), C(4, 1), C(5), C(5, 1)], L).type === COMBO.PLATE, '木板 223344→334455 shape');
ok(classify([C(7), C(7, 1), C(7, 2), C(8), C(8, 1), C(8, 2)], L).type === COMBO.TUBE, '钢板 777888');
ok(classify([C(3), C(3, 1), C(3, 2), C(3, 3)], L).bomb && classify([C(3), C(3, 1), C(3, 2), C(3, 3)], L).type === COMBO.BOMB, '4-bomb');
ok(classify([C(6), C(6, 1), C(6, 2), C(6, 3), C(6)], L).type === COMBO.BOMB, '5-bomb');
ok(classify([C(3), C(4), C(5), C(6), C(7)].map((c) => ({ ...c, suit: 2 })), L).type === COMBO.STRAIGHT_FLUSH, '同花顺');
ok(classify([C(16, -1), C(16, -1), C(17, -1), C(17, -1)], L).type === COMBO.JOKER_BOMB, '天王炸');
ok(classify([C(3), C(4), C(6), C(7)], L) === null, 'broken straight → null');
ok(classify([C(3), C(3), C(3), C(4), C(5)], L) === null, '33345 → null');

// ---- wildcards (♥2 when level=2) ------------------------------------------
ok(isWild(H(2), 2) && !isWild(H(2), 3), 'isWild only at the level rank');
ok(classify([C(9), H(2)], 2).type === COMBO.PAIR && classify([C(9), H(2)], 2).key === strengthOf(9, 2), 'wild completes a pair of 9');
ok(classify([C(9), C(9, 2), H(2)], 2).type === COMBO.TRIO, 'wild completes a trip');
ok(classify([C(3), C(4, 2), H(2), C(6), C(7, 3)], 2).type === COMBO.STRAIGHT, 'wild fills a straight gap (3 4 _ 6 7, mixed suit)');
ok(classify([H(2), H(2)], 2).type === COMBO.PAIR && classify([H(2), H(2)], 2).key === 15, 'two wildcards = pair of the level rank (strength 15)');
ok(classify([C(9), C(9, 1), C(9, 2), H(2)], 2).type === COMBO.BOMB, 'three 9s + wild = 4-bomb');

// ---- beats -----------------------------------------------------------------
const d = (cards, lv = 2) => classify(cards, lv);
ok(beats(d([C(9), C(9, 1)]), d([C(8), C(8, 1)])), 'pair 9 beats pair 8');
ok(!beats(d([C(8), C(8, 1)]), d([C(9), C(9, 1)])), 'pair 8 does not beat pair 9');
ok(beats(d([C(2), C(2, 2)]), d([C(14), C(14, 2)])), 'pair of level (2) beats pair of A');
ok(beats(d([C(3), C(3, 1), C(3, 2), C(3, 3)]), d([C(9), C(9, 1)])), 'any bomb beats a pair');
ok(beats(d([C(5), C(5, 1), C(5, 2), C(5, 3), C(5)]), d([C(14), C(14, 1), C(14, 2), C(14, 3)])), '5-bomb beats 4-bomb');
const flush = d([C(3, 2), C(4, 2), C(5, 2), C(6, 2), C(7, 2)]);
ok(beats(flush, d([C(14), C(14, 1), C(14, 2), C(14, 3)])), '同花顺 beats a 4-bomb');
ok(!beats(flush, d([C(5), C(5, 1), C(5, 2), C(5, 3), C(5, 0), C(5, 1)])), '同花顺 does NOT beat a 6-bomb');
ok(beats(d([C(16, -1), C(16, -1), C(17, -1), C(17, -1)]), flush), '天王炸 beats 同花顺');

// ---- legalMoves ------------------------------------------------------------
{
  const hand = [C(5), C(5, 1), C(6, 1), C(7, 2), C(8, 3), C(9), H(2)];
  const moves = legalMoves(hand, null, 2);
  ok(moves.length > 0, 'legalMoves returns plays on a free lead');
  ok(moves.some((m) => m.type === COMBO.STRAIGHT), 'finds a straight among legal moves');
  ok(moves.some((m) => m.type === COMBO.PAIR), 'finds a pair among legal moves');
  // following a pair of 5 → must produce only higher pairs / bombs
  const against = classify([C(5), C(5, 2)], 2);
  const follow = legalMoves(hand, against, 2);
  ok(follow.every((m) => m.bomb || (m.type === COMBO.PAIR && m.key > against.key)), 'following a pair yields only higher pairs or bombs');
}
{
  // A duplicate rank elsewhere in the hand must not suppress a perfectly legal straight.
  const hand = [C(3), C(3, 1), C(4, 1), C(5, 2), C(6, 3), C(7)];
  ok(legalMoves(hand, null, 2).some((m) => m.type === COMBO.STRAIGHT), 'straight generation tolerates duplicate ranks in hand');
}
{
  // following a bomb → only bombs/flushes
  const hand = [C(9), C(9, 1), C(9, 2), C(9, 3), C(4), C(4, 1)];
  const against = classify([C(3), C(3, 1), C(3, 2), C(3, 3)], 2);
  const follow = legalMoves(hand, against, 2);
  ok(follow.length >= 1 && follow.every((m) => m.bomb), 'against a bomb, only bombs are legal');
}

// ---- full self-play round (random legal moves) ----------------------------
function randInt(n) { return Math.floor(Math.random() * n); }
function playRandomRound() {
  const deck = makeDeck();
  for (let i = deck.length - 1; i > 0; i--) { const j = randInt(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const hands = [0, 1, 2, 3].map((i) => deck.slice(i * 27, i * 27 + 27));
  const r = new Round({ hands, level: 2, firstLeader: 0 });
  let guard = 0;
  while (r.phase !== 'over' && guard++ < 5000) {
    const seat = r.turn;
    const against = seat === r.leadSeat ? null : r.lead;
    const moves = legalMoves(r.hands[seat], against, r.level);
    if (moves.length === 0) { ok(r.play(seat, []), 'forced pass succeeds'); continue; }
    if (seat !== r.leadSeat && Math.random() < 0.3) { r.play(seat, []); continue; } // sometimes pass
    const mv = moves[randInt(moves.length)];
    ok(r.play(seat, mv.cardIds), 'random legal move applies');
  }
  return r;
}
{
  const r = playRandomRound();
  ok(r.phase === 'over', 'round terminates');
  ok(r.result && r.result.order.length === 4, 'finish order has all 4 seats');
  ok([1, 2, 3].includes(r.result.advance), 'advance is 1/2/3');
}

// ---- Match: levels, host, tribute ----------------------------------------
{
  const m = new Match({ rng: Math.random });
  ok(m.level() === 2, 'match starts at level 2');
  const dealt = m.deal();
  ok(dealt.tribute === null, 'round 1 has no tribute');
  const round = m.beginRound();
  ok(round.hands.every((h) => h.length === 27), 'each seat holds 27 after round-1 deal');
  // force a finishing order and settle
  round.result = { order: [0, 2, 1, 3], winTeam: 0, advance: 3, partnerPos: 1, bombs: 0 };
  round.phase = 'over';
  const s = m.settleRound();
  ok(s.teamLevel[0] === 5 && s.winTeam === 0, 'double-down advances +3 (2→5)');
  ok(m.hostTeam === 0, 'winner becomes host');
  const dealt2 = m.deal();
  ok(dealt2.tribute !== null, 'round 2 has a tribute plan');
  ok(dealt2.level === 5, 'round 2 is played at the winners’ level (5)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
