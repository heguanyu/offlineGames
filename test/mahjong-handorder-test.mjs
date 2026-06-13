// Unit tests for the hand display order: non-混 always sorted (drawn on the
// right) and not draggable; 混儿 default left, draggable, and a dragged 混儿 keeps
// its spot across draws/discards. Usage: node test/mahjong-handorder-test.mjs
import { buildOrder, moveWild } from '../games/mahjong/handorder.js';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Wilds are the pair {3, 4} for these tests.
const isWild = (id) => id === 3 || id === 4;

console.log('default order — 混儿 left, the rest sorted, drawn on the right:');
eq(buildOrder(null, [7, 1, 4, 9, 3, 2], isWild, 9), [3, 4, 1, 2, 7, 9], 'wilds left; non-wilds sorted; drawn 9 last');
eq(buildOrder(null, [5, 0, 8], isWild, null), [0, 5, 8], 'no wilds → plain sort');
eq(buildOrder(null, [7, 4, 1], isWild, 4), [4, 1, 7], 'drawn wild stays left');

console.log('non-混 always re-sorts (never carries a custom position):');
// Even if a prior order had non-wilds out of order, buildOrder re-sorts them.
eq(buildOrder([7, 1, 2], [7, 1, 2], isWild, null), [1, 2, 7], 'non-wilds always sorted');

console.log('dragged 混儿 keeps its spot across draws/discards:');
let order = buildOrder(null, [1, 2, 3, 7], isWild, null); // [3,1,2,7]
order = moveWild(order, 3, 2, isWild);                     // drag wild 3 to index 2
eq(order, [1, 2, 3, 7], 'wild 3 dragged between 2 and 7');
order = buildOrder(order, [1, 2, 3, 5, 7], isWild, 5);     // draw a 5
eq(order, [1, 2, 3, 7, 5], 'drawn 5 on the right; wild 3 keeps its slot after 2');
order = buildOrder(order, [2, 3, 5, 7], isWild);           // discard the 1 (no fresh draw)
eq(order, [2, 3, 5, 7], 'discarded tile gone; non-wilds re-sort; wild 3 still after 2');

console.log('moveWild only moves 混儿:');
eq(moveWild([3, 1, 2, 7], 7, 0, isWild), [3, 1, 2, 7], 'non-wild drag is a no-op');
eq(moveWild([3, 1, 2, 7], 3, 3, isWild), [1, 2, 7, 3], 'wild 3 moved to the end');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
