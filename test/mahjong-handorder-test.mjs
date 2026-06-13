// Unit tests for the hand display order: 混儿 grouped on the left, the rest
// sorted with the freshly drawn tile on the right.
// Usage: node test/mahjong-handorder-test.mjs
import { buildOrder } from '../games/mahjong/handorder.js';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Wilds are the pair {3, 4} for these tests.
const isWild = (id) => id === 3 || id === 4;

eq(buildOrder([7, 1, 4, 9, 3, 2], isWild, 9), [3, 4, 1, 2, 7, 9], '混儿 left; non-wilds sorted; drawn 9 last');
eq(buildOrder([5, 0, 8], isWild, null), [0, 5, 8], 'no wilds → plain sort');
eq(buildOrder([7, 4, 1], isWild, 4), [4, 1, 7], 'a drawn 混儿 still groups on the left');
eq(buildOrder([8, 4, 3, 1], isWild, 1), [3, 4, 8, 1], 'two 混儿 sorted on the left, drawn 1 on the right');
eq(buildOrder([], () => false, null), [], 'empty hand');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
