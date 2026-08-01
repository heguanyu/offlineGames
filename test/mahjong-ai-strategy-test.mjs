// Targeted regressions for the production Tianjin Mahjong policy.
// Run: node test/mahjong-ai-strategy-test.mjs
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS } from '../games/mahjong-tianjin/ai.js';
import { suitOf } from '../games/mahjong-tianjin/engine.js';

let passed = 0, failed = 0;
const ok = (condition, message) => {
  if (condition) passed++;
  else { failed++; console.error(`  ✗ ${message}`); }
};

function table({ hand, wilds, indicator = wilds[0], dealer = 0, hands = null, discards = null, melds = null, selfKongs = [] }) {
  return {
    hands: hands || [hand, [], [], []],
    discards: discards || [[], [], [], []],
    melds: melds || [[], [], [], []],
    wilds, wildSet: new Set(wilds), indicator, dealer,
    wildSuit: wilds[0] < 27 ? suitOf(wilds[0]) : null,
    selfKongOptions: () => selfKongs,
  };
}

// Structural tenpai is not enough in Tianjin: a 混儿-assisted 小和 below 2 fan cannot win.
// The former policy chases that false 13-way wait; HARD keeps the legal 捉五/混吊 route instead.
{
  const hand = [2, 2, 5, 6, 10, 11, 16, 17, 19, 20, 27, 27, 27, 27];
  const game = table({ hand, wilds: [30, 27] });
  ok(chooseDiscard(game, 0, LEVELS.NORMAL, () => 0.5) === 5, 'baseline reproduces the score-dead structural wait');
  ok(chooseDiscard(game, 0, LEVELS.HARD, () => 0.5) === 6, 'expert chooses a wait that clears Tianjin 起和');
}

// Three concealed 5万 can either 碰 and retain one useful copy, or 杠 all three. The old code
// simulated both as 碰 and blindly returned 杠; the corrected policy evaluates the actual states.
{
  const hands = [
    [3, 5, 7, 7, 20, 21, 21, 22, 23, 28, 29, 32, 32],
    [3, 3, 9, 11, 14, 15, 17, 19, 20, 30, 31, 31, 31],
    [4, 4, 4, 5, 12, 13, 13, 15, 23, 25, 30, 31, 32],
    [2, 5, 8, 9, 10, 10, 15, 19, 23, 24, 25, 29, 33],
  ];
  const game = table({
    hand: hands[2], hands, wilds: [28, 29], indicator: 28, dealer: 1,
    discards: [[0], [25, 4], [19], [26]], melds: [[], [], [], []],
  });
  const claim = { player: 2, kind: 4, options: ['kong', 'pung'] };
  ok(chooseClaim(game, 2, claim, LEVELS.NORMAL, () => 0.5) === 'kong', 'baseline reproduces the false kong preference');
  ok(chooseClaim(game, 2, claim, LEVELS.HARD, () => 0.5) === 'pung', 'expert prefers the stronger real post-claim hand');
}

// A self-kong is valuable only if turning the four tiles into a meld does not damage the hand more
// than an ordinary discard. Cover both sides so the guard cannot degrade into "never kong".
{
  const hand = [2, 4, 5, 5, 5, 5, 7, 9, 10, 13, 16, 18, 23, 32];
  const game = table({ hand, wilds: [17, 9], indicator: 17, selfKongs: [{ type: 'concealed', kind: 5 }] });
  ok(chooseSelfKong(game, 0, LEVELS.NORMAL, () => 0.5) === 5, 'baseline reproduces unconditional hard-style konging');
  ok(chooseSelfKong(game, 0, LEVELS.HARD, () => 0.5) === null, 'expert declines a self-kong that damages the hand');
}
{
  const hand = [1, 6, 6, 11, 11, 12, 18, 20, 25, 27, 27, 27, 27, 28];
  const game = table({ hand, wilds: [3, 4], indicator: 3, selfKongs: [{ type: 'concealed', kind: 27 }] });
  ok(chooseSelfKong(game, 0, LEVELS.HARD, () => 0.5) === 27, 'expert still takes a sound self-kong and its 杠开 draw');
}

console.log(`\n${passed} Tianjin AI strategy assertions passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
