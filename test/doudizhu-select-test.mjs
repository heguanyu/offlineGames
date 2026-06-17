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

console.log('SmartSelection — leading (group tap / refine):');
{
  const h = hand([3, 3, 5, 6, 7, 8, 9, 13]);
  const s = new SmartSelection(); s.setHand(h); s.setContext({ following: false });
  const a3 = h.find((c) => c.rank === 3).id;
  s.tap(a3);
  ok(s.ids.length === 2, 'tapping a 3 selects the whole pair');
  s.tap(a3);
  ok(s.ids.length === 1 && !s.has(a3), 'tapping the same card again removes just it (refine)');
  s.clear();
  const straightIds = h.filter((c) => c.rank >= 5 && c.rank <= 9).map((c) => c.id);
  s.tap(straightIds[2]);
  ok(s.ids.length === 5, 'tapping a straight card selects the whole straight');
}

console.log('SmartSelection — paint (swipe select + deselect):');
{
  const h = hand([3, 3, 5, 6, 7]);
  const s = new SmartSelection(); s.setHand(h); s.setContext({ following: false });
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
  const s = new SmartSelection(); s.setHand(h); s.setContext({ following: true, legalMoves: lm });
  const an8 = h.find((c) => c.rank === 8).id;
  s.tap(an8);
  ok(s.ids.length === 2 && s.ids.every((id) => h.find((c) => c.id === id).rank === 8), 'following a pair, tapping an 8 selects the pair of 8s');
  // tapping a 4 (cannot form a beating pair) selects just the lone card (illegal, but registers)
  s.clear();
  const a4 = h.find((c) => c.rank === 4).id;
  s.tap(a4);
  ok(s.ids.length === 1 && s.has(a4), 'a card with no playable combo toggles as a lone card');
  // tapping the playable combo again clears it
  s.clear(); s.tap(an8); s.tap(an8);
  ok(s.ids.length === 0, 'tapping the playable combo again clears it');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
