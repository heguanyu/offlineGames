// Unit tests for the hand display order: 混儿 grouped on the left, everything
// else sorted ascending. The freshly drawn tile is not pulled out — it sorts
// into place (the renderer flanks it with a margin instead).
// Usage: node test/mahjong-handorder-test.mjs
import { buildOrder } from '../games/mahjong-tianjin/handorder.js';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Wilds are the pair {3, 4} for these tests.
const isWild = (id) => id === 3 || id === 4;

eq(buildOrder([7, 1, 4, 9, 3, 2], isWild), [3, 4, 1, 2, 7, 9], '混儿 left; non-wilds sorted ascending');
eq(buildOrder([5, 0, 8], isWild), [0, 5, 8], 'no wilds → plain sort');
eq(buildOrder([7, 4, 1], isWild), [4, 1, 7], '混儿 groups on the left, rest sorted');
eq(buildOrder([8, 4, 3, 1], isWild), [3, 4, 1, 8], 'two 混儿 on the left, rest sorted (no special drawn slot)');
eq(buildOrder([], () => false), [], 'empty hand');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
