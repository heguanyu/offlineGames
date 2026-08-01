import { classify, COMBO } from '../games/guandan/engine.js';
import { bestStacks, groupSelection, normalizeStacks, rankStacks, selectionCombo } from '../games/guandan/arrange.js';

let passed = 0;
const ok = (condition, message) => {
  if (!condition) throw new Error(message);
  passed++;
};
let id = 0;
const C = (rank, suit = 0) => ({ id: id++, rank, suit });

{
  const hand = [C(3), C(3, 1), C(4), C(4, 1), C(4, 2), C(16, -1)];
  const stacks = rankStacks(hand);
  ok(stacks.length === 3, 'default layout creates one stack per rank');
  ok(stacks.map((s) => s.length).join(',') === '2,3,1', 'rank stacks retain every duplicate');
}

{
  const hand = [C(3), C(4, 1), C(5, 2), C(6, 3), C(7), C(9), C(9, 1)];
  const initial = rankStacks(hand);
  const straightIds = hand.slice(0, 5).map((c) => c.id);
  const grouped = groupSelection(hand, initial, straightIds, 2);
  ok(grouped.some((s) => s.length === 5 && s.every((x) => straightIds.includes(x))), 'manual grouping creates one selected stack');
  ok(selectionCombo(hand, straightIds, 2)?.type === COMBO.STRAIGHT, 'valid straight enables grouping');
  const broken = [C(3), C(4, 1), C(5, 2), C(7, 3), C(8)];
  ok(selectionCombo(broken, broken.map((c) => c.id), 2) === null, '34578-style invalid selection is rejected');
  const afterPlay = hand.filter((c) => c.id !== straightIds[2]);
  const normalized = normalizeStacks(afterPlay, grouped, 2);
  ok(normalized.every((s) => s.length === 1 || classify(s.map((x) => afterPlay.find((c) => c.id === x)), 2)), 'broken mixed stack is split after a card leaves');
}

{
  const hand = [C(3), C(3, 1), C(4), C(4, 1), C(5), C(5, 1), C(8), C(8, 1), C(8, 2), C(10), C(10, 1)];
  const stacks = bestStacks(hand, 2);
  ok(stacks.length === 2, 'auto arrange finds the fewest-play partition');
  ok(stacks.every((s) => classify(s.map((x) => hand.find((c) => c.id === x)), 2)), 'every auto-arranged stack is a legal composition');
  ok(new Set(stacks.flat()).size === hand.length, 'auto arrange covers every card exactly once');
}

{
  const wild = C(2, 1);
  const hand = [C(3), C(4, 1), wild, C(6, 2), C(7, 3)];
  const stacks = bestStacks(hand, 2);
  ok(stacks.length === 1 && classify(stacks[0].map((x) => hand.find((c) => c.id === x)), 2)?.type === COMBO.STRAIGHT,
    'auto arrange uses the level-heart wildcard to complete a group');
}

{
  const aceLow = [C(14), C(2, 2), C(3, 1), C(4, 3), C(5)];
  ok(bestStacks(aceLow, 7).length === 1, 'auto arrange recognizes an A2345 straight');
  const jokers = [C(16, -1), C(16, -1), C(17, -1), C(17, -1)];
  ok(bestStacks(jokers, 2).length === 1, 'auto arrange keeps 天王炸 together');
  ok(bestStacks(jokers.slice(0, 2), 2).length === 1, 'auto arrange keeps a joker pair together');
}

{
  const flush = [C(3, 3), C(4, 3), C(5, 3), C(6, 3), C(7, 3), C(3, 0)];
  const stacks = bestStacks(flush, 2);
  ok(stacks.some((s) => classify(s.map((x) => flush.find((c) => c.id === x)), 2)?.type === COMBO.STRAIGHT_FLUSH),
    'auto arrange preserves a same-suit straight when a duplicate rank is present');
}

console.log(`\n${passed} arrangement assertions passed`);
