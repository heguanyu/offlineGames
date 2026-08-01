// Targeted strategy regressions for the production Guandan AI.
// Run: node test/guandan-ai-test.mjs
import { chooseMove, minSplit } from '../games/guandan/ai.js';
import { classify, COMBO, JOKER_S, JOKER_B } from '../games/guandan/engine.js';

let passed = 0, failed = 0, nextId = 10000;
const ok = (condition, message) => {
  if (condition) passed++;
  else { failed++; console.error(`  ✗ ${message}`); }
};
const C = (rank, suit = 0) => ({ id: nextId++, rank, suit });
const four = (rank) => [C(rank, 0), C(rank, 1), C(rank, 2), C(rank, 3)];
const pair = (rank) => [C(rank, 0), C(rank, 2)];
const mixedStraight = (lo) => [C(lo, 0), C(lo + 1, 1), C(lo + 2, 2), C(lo + 3, 3), C(lo + 4, 0)];
const vector = (entries) => {
  const counts = new Array(18).fill(0);
  for (const [rank, count] of entries) counts[rank] = count;
  return counts;
};

function table(hand, { leadCards = null, leadSeat = 0, counts = [hand.length, 12, 12, 12], finished = [] } = {}) {
  return {
    level: 2,
    hands: [hand, [], [], []],
    handCounts: counts,
    finished,
    leadSeat,
    lead: leadCards ? classify(leadCards, 2) : null,
  };
}

function decision(round, policy = 2) {
  const result = chooseMove(round, 0, policy, () => 0.5);
  const cards = result.cardIds.map((id) => round.hands[0].find((card) => card.id === id));
  return { ...result, cards, combo: result.pass ? null : classify(cards, round.level) };
}

// The hand evaluator must understand every one-play structure the rules engine understands.
ok(minSplit(vector([[7, 3], [9, 2]])) === 1, '三带二 is valued as one play');
ok(minSplit(vector([[14, 1], [2, 1], [3, 1], [4, 1], [5, 1]])) === 1, 'A2345 is valued as one play');
ok(minSplit(vector([[JOKER_S, 2], [JOKER_B, 2]])) === 1, '天王炸 is valued as one play');

// A bomb that leaves one clean exit should be used instead of being carried pointlessly to the end.
{
  const hand = [...four(3), ...pair(7)];
  const round = table(hand, { leadCards: pair(14), leadSeat: 1, counts: [6, 10, 8, 10] });
  const expert = decision(round, 2), baseline = decision(round, 1);
  ok(expert.combo?.type === COMBO.BOMB, 'expert bombs to create a one-hand finish');
  ok(baseline.pass, 'baseline demonstrates the former bomb-hoarding behavior');
}

// With layered firepower, spend the smallest bomb early and keep the larger one for control.
{
  const hand = [...four(3), ...four(4), ...mixedStraight(7)];
  const round = table(hand, { leadCards: pair(14), leadSeat: 1, counts: [13, 18, 15, 18] });
  const expert = decision(round, 2), baseline = decision(round, 1);
  ok(expert.combo?.type === COMBO.BOMB, 'expert uses redundant firepower to take 牌权');
  ok(expert.cards.every((card) => card.rank === 3), 'expert spends the smallest sufficient bomb first');
  ok(baseline.pass, 'baseline would conservatively pass with two bombs');
}

// But a lone early bomb with no short continuation remains valuable and should not be wasted.
{
  const hand = [...four(3), ...mixedStraight(4), ...pair(9), ...pair(10)];
  const round = table(hand, { leadCards: pair(14), leadSeat: 1, counts: [13, 18, 15, 18] });
  ok(decision(round, 2).pass, 'expert preserves a lone bomb when it has no tactical purpose');
}

// Countering an opponent bomb is a purposeful way to regain the table, even before the endgame.
{
  const hand = [...four(4), C(6), C(8), C(10), C(12)];
  const round = table(hand, { leadCards: four(3), leadSeat: 1, counts: [8, 12, 9, 12] });
  const expert = decision(round, 2), baseline = decision(round, 1);
  ok(expert.combo?.type === COMBO.BOMB, 'expert counter-bombs to regain 牌权');
  ok(baseline.pass, 'baseline would pass and hoard the counter-bomb');
}

// Free-lead denial: do not hand an opponent exactly the shape needed to go out.
{
  const hand = [...pair(3), C(4)];
  const round = table(hand, { counts: [3, 2, 10, 10] });
  const expert = decision(round, 2), baseline = decision(round, 1);
  ok(expert.combo?.type === COMBO.SINGLE, 'expert avoids leading a pair to an opponent with two cards');
  ok(baseline.combo?.type === COMBO.PAIR, 'baseline exposes the former exact-size lead');
}
{
  const hand = [C(3), ...pair(4)];
  const round = table(hand, { counts: [3, 1, 10, 10] });
  ok(decision(round, 2).combo?.type === COMBO.PAIR, 'expert avoids leading a single to an opponent with one card');
}

// Team play: feed a safe low single to a reporting partner, and never overtake their live lead.
{
  const hand = [C(3), ...pair(4)];
  const round = table(hand, { counts: [3, 10, 1, 10] });
  const expert = decision(round, 2), baseline = decision(round, 1);
  ok(expert.combo?.type === COMBO.SINGLE && expert.cards[0].rank === 3, 'expert feeds a cheap single to a one-card partner');
  ok(baseline.combo?.type === COMBO.PAIR, 'baseline did not recognize the feed opportunity');
}
{
  const hand = [...pair(6), C(8)];
  const round = table(hand, { leadCards: pair(5), leadSeat: 2, counts: [3, 10, 4, 10] });
  ok(decision(round, 2).pass, 'expert leaves 牌权 with a partner who is already winning');
}

console.log(`\n${passed} AI strategy assertions passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
