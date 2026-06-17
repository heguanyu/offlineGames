// Unit test for the smart-selection module: tap selects the natural decomposition group,
// tapping a selected card refines it down, swipe replaces with the swept cards.
// Usage: node test/doudizhu-select-test.mjs
import { decompose, SmartSelection } from '../games/doudizhu/select.js';
import { legalMoves, classify } from '../games/doudizhu/engine.js';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } }
// build a hand of {id,rank,suit} from a list of ranks
const hand = (ranks) => ranks.map((r, i) => ({ id: i, rank: r, suit: i % 4 }));

console.log('decompose:');
{
  // 3,3 (pair) + 5,6,7,8,9 (straight) + K (single)
  const h = hand([3, 3, 5, 6, 7, 8, 9, 13]);
  const { groups, cardGroup } = decompose(h);
  const sizes = groups.map((g) => g.ids.length).sort((a, b) => a - b);
  ok(sizes.join() === [1, 2, 5].join(), `groups are pair+straight+single (got ${sizes.join()})`);
  // the two 3s share a group
  const g3 = h.filter((c) => c.rank === 3).map((c) => cardGroup.get(c.id));
  ok(g3[0] === g3[1], 'both 3s land in the same group');
  // the straight cards share a group
  const gs = h.filter((c) => c.rank >= 5 && c.rank <= 9).map((c) => cardGroup.get(c.id));
  ok(new Set(gs).size === 1, 'the five straight cards share one group');
}

console.log('SmartSelection — leading (build valid patterns):');
{
  const h = hand([3, 3, 5, 6, 7, 8, 9]);
  const lm = legalMoves(h.map((c) => c.rank), null); // free lead → all valid combos
  const s = new SmartSelection(); s.setHand(h); s.setContext({ legalMoves: lm });
  const threes = h.filter((c) => c.rank === 3).map((c) => c.id);
  s.tap(threes[0]);
  ok(s.ids.length === 1, 'first tap selects a single (smallest valid pattern)');
  s.tap(threes[1]);
  ok(s.ids.length === 2 && s.ids.every((id) => h.find((c) => c.id === id).rank === 3), 'tapping the second 3 builds the pair');
  s.tap(threes[1]);
  ok(s.ids.length === 1, 'tapping a selected card removes just it');
}

console.log('SmartSelection — straight tie-break (starts with the selected card):');
{
  const h = hand([5, 6, 7, 8, 9, 10]);
  const lm = legalMoves(h.map((c) => c.rank), null);
  const s = new SmartSelection(); s.setHand(h); s.setContext({ legalMoves: lm });
  // {6} selected, tap 9 → a 5-straight covering 6..9; prefer 6-7-8-9-10 (starts with 6), not 5-6-7-8-9
  s.set([h.find((c) => c.rank === 6).id]);
  s.tap(h.find((c) => c.rank === 9).id);
  const ranks = s.ids.map((id) => h.find((c) => c.id === id).rank).sort((a, b) => a - b);
  ok(ranks.join() === [6, 7, 8, 9, 10].join(), `straight starts at the selected 6 (got ${ranks.join()})`);
}

console.log('SmartSelection — paint (swipe select + deselect):');
{
  const h = hand([3, 3, 5, 6, 7]);
  const s = new SmartSelection(); s.setHand(h); s.setContext({ legalMoves: [] });
  s.paint(h[0].id, true); s.paint(h[2].id, true);
  ok(s.ids.length === 2 && s.has(h[0].id) && s.has(h[2].id), 'paint(true) selects cards');
  s.paint(h[0].id, false);
  ok(s.ids.length === 1 && !s.has(h[0].id), 'paint(false) deselects a card (swipe can deselect)');
}

console.log('SmartSelection — following (tap selects a PLAYABLE combo):');
{
  // hand has a pair of 8s; lead is a pair of 5s → tapping an 8 should select the pair of 8s.
  const h = hand([8, 8, 4, 6, 9, 9, 9]);
  const lead = classify([5, 5]);
  const lm = legalMoves(h.map((c) => c.rank), lead);
  const s = new SmartSelection(); s.setHand(h); s.setContext({ legalMoves: lm });
  const an8 = h.find((c) => c.rank === 8).id;
  s.tap(an8);
  ok(s.ids.length === 2 && s.ids.every((id) => h.find((c) => c.id === id).rank === 8), 'following a pair, tapping an 8 selects the pair of 8s');
  // tapping a 4 (cannot form a beating pair) is ignored — the selection stays valid
  s.clear();
  const a4 = h.find((c) => c.rank === 4).id;
  s.tap(a4);
  ok(s.ids.length === 0, 'a card with no beating combo is ignored');
  // tapping a selected card removes just that card (refine down)
  s.clear(); s.tap(an8);                 // → pair of 8s
  s.tap(an8);
  ok(s.ids.length === 1 && !s.has(an8), 'tapping a selected card removes just it');
}

console.log('SmartSelection — following (build on the existing selection):');
{
  // lead is a 三带二 (trio 5 + pair 3). Hand has trios of 8 AND 9 plus a pair of K.
  const h = hand([8, 8, 8, 9, 9, 9, 13, 13]);
  const lm = legalMoves(h.map((c) => c.rank), classify([5, 5, 5, 3, 3]));
  const s = new SmartSelection(); s.setHand(h); s.setContext({ legalMoves: lm });
  // pre-select the trio of 9s, then tap a K. It must BUILD 9-9-9-K-K (keep the 9s), not switch to the
  // lower 8-8-8-K-K (which the old "best comp of this card" logic would have picked).
  s.set(h.filter((c) => c.rank === 9).map((c) => c.id));
  s.tap(h.find((c) => c.rank === 13).id);
  const ranks = s.ids.map((id) => h.find((c) => c.id === id).rank).sort((a, b) => a - b);
  ok(ranks.join() === [9, 9, 9, 13, 13].join(), `builds 9-9-9-K-K on the selected trio (got ${ranks.join()})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
