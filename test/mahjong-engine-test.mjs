// Unit tests for the Tianjin mahjong rules engine. Pure logic, no browser.
// Usage: node test/mahjong-engine-test.mjs
import {
  wildKindsFromIndicator, nextInCycle, tileName, isWinningHand, analyzeWin,
  Game, PHASE, freshTiles,
} from '../games/mahjong/engine.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  FAIL:', msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${a}, want ${b})`); }

// Tile ids (number suits): m1=0..m9=8, p1=9..p9=17, s1=18..s9=26,
// winds 东=27 南=28 西=29 北=30, dragons 中=31 發=32 白=33.
const M = (r) => r - 1, P = (r) => 8 + r, S = (r) => 17 + r;

// --- wild wrap-around ---------------------------------------------------------
console.log('wild determination:');
ok(wildKindsFromIndicator(M(3)).join() === [M(3), M(4)].join(), '3万 → 3万,4万');
ok(wildKindsFromIndicator(M(9)).join() === [M(9), M(1)].join(), '9万 wraps → 9万,1万');
ok(wildKindsFromIndicator(S(9)).join() === [S(9), S(1)].join(), '9条 wraps → 9条,1条');
eq(nextInCycle(30), 27, '北 wraps to 东');
eq(nextInCycle(33), 31, '白 wraps to 中');
eq(nextInCycle(29), 30, '西 → 北');

// --- win detection ------------------------------------------------------------
console.log('win detection:');
// 123m 456m 789p 123s 55s — four melds + pair, no wilds.
const plain = [M(1), M(2), M(3), M(4), M(5), M(6), P(7), P(8), P(9), S(1), S(2), S(3), S(5), S(5)];
ok(isWinningHand(plain, 0, 4), 'plain 4-melds+pair wins');
// Remove one tile → 13 tiles, cannot be 4 melds + pair.
ok(!isWinningHand(plain.slice(0, 13), 0, 4), '13 tiles do not win');
// Broken hand of 14 that cannot decompose.
const broken = [M(1), M(1), M(4), M(7), P(2), P(5), P(8), S(1), S(4), S(7), 27, 28, 29, 30];
ok(!isWinningHand(broken, 0, 4), 'scattered hand does not win');
// One wild completes a pair: 123m 456m 123p 456p + (9s, wild).
const wildWin = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(4), P(5), P(6), S(9)];
ok(isWinningHand(wildWin, 1, 4), 'one joker completes the pair');

// --- scoring ------------------------------------------------------------------
console.log('scoring:');
// 素 baseline (no wild): plain hand above, winning on s5. 提溜 × 素 = 2.
let r = analyzeWin(plain, [], { wilds: [S(5), S(6)], winningKind: S(5) });
// Note: S(5) is the wild here only nominally — plain has no wild tile of that id?
// plain DOES contain S(5). Use a wild set disjoint from the hand to test 素.
r = analyzeWin(plain, [], { wilds: [27, 28], winningKind: S(5) });
ok(r && r.meta.su, '素 detected when no wild tile held');
eq(r.score, 2, '没混儿(素) = 2');

// 龙 + 素: 123m456m789m (full 1-9 m) + 123p + 99p. winning on 9m.
const longHand = [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), P(1), P(2), P(3), P(9), P(9)];
r = analyzeWin(longHand, [], { wilds: [27, 28], winningKind: M(9) });
ok(r && r.meta.long, '龙 detected (full 1-9)');
eq(r.score, 8, '龙(4) × 素(2) = 8');

// 捉五: win 5万 into 4-5-6万. 123m 456m 123p 123s 中中, winning tile = 5万.
const catch5 = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), S(1), S(2), S(3), 31, 31];
r = analyzeWin(catch5, [], { wilds: [27, 28], winningKind: M(5) });
ok(r && r.meta.zhuoWu, '捉五 detected');
eq(r.score, 6, '捉五(3) × 素(2) = 6');

// 混吊: 123m 456m 123p 456p + (9s natural + wild) pair, drew the 9s to pair the
// standing wild. wilds are s-suit so no 本混龙 interaction. winningKind = 9s.
const hunDiao = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(4), P(5), P(6), S(9), S(5)];
// S(5) stands in as the wild tile (wilds = [S(5), S(6)]).
r = analyzeWin(hunDiao, [], { wilds: [S(5), S(6)], winningKind: S(9) });
ok(r && r.meta.hunDiao, '混吊 detected');
ok(!r.meta.su, '混吊 hand is not 素');
eq(r.score, 2, '混吊(2) = 2');

// Two wilds available for the 将: 123m 456m 123p 456p (four natural melds) + a
// pair drawing on two wilds. Both 混吊 and 双混吊 are 2番 per the wiki, so this
// scores 2 — never the old 4. (The solver may label it 混吊, since a 2-joker pair
// can always be re-read as a 1-joker pair + a joker in a meld; both are 2番.)
const twoWild = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(4), P(5), P(6), 27, 28];
r = analyzeWin(twoWild, [], { wilds: [27, 28], winningKind: 28 });
ok(r && (r.meta.shuangHun || r.meta.hunDiao), '将含混儿 (混吊/双混吊) detected');
eq(r.score, 2, '将含混儿 = 2番（双混吊不再是 4）');

// 本混龙: full 1-9万 with two m-suit wilds (8万/9万) filling 8,9; pair 99p. The
// wild suit equals 龙's suit, so 本混 doubles 龙 → 8 (the combination-table value;
// the old engine wrongly added it as a flat +8).
const benHun = [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(8), P(1), P(2), P(3), P(9), P(9)];
r = analyzeWin(benHun, [], { wilds: [M(8), M(9)], winningKind: P(9) });
ok(r && r.meta.benHunLong, '本混龙 detected');
eq(r.score, 8, '本混龙 = 龙(4) × 本混(2) = 8');

// 杠开 multiplier on the 素 baseline → 素(2)×杠开(2) = 4.
r = analyzeWin(plain, [], { wilds: [27, 28], winningKind: S(5), afterKong: true });
eq(r.score, 4, '素×杠开 = 4');

// 起和 2番: a fan-less win (a wild buried in a pung, natural pair, no 捉五/龙/杠开)
// scores only 1 — a 小和, which is NOT a legal win.
const xiaohe = [27, S(9), S(9), M(1), M(2), M(3), P(4), P(5), P(6), P(7), P(8), P(9), 31, 31];
r = analyzeWin(xiaohe, [], { wilds: [27, 28], winningKind: 31 });
ok(r === null, '小和 (score 1) is rejected by 起和 2番');

// --- full game state machine: random self-play terminates, scores zero-sum ----
console.log('state machine:');
function autoplay(seed) {
  let s = seed;
  const rng = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const g = new Game({ rng });
  let guard = 0;
  while (g.phase !== PHASE.OVER && guard++ < 5000) {
    if (g.phase === PHASE.AWAIT_CLAIM) { g.passClaim(); continue; }
    if (g.phase === PHASE.AWAIT_DISCARD) {
      const hand = g.hands[g.turn];
      const tile = hand.find((t) => !g.isWild(t));
      ok(tile !== undefined, 'always a non-wild tile to discard');
      g.discard(g.turn, tile);
    }
  }
  return g;
}
let wins = 0, draws = 0;
for (let seed = 1; seed <= 200; seed++) {
  const g = autoplay(seed);
  ok(g.phase === PHASE.OVER, `game ${seed} terminates`);
  const sum = g.scores.reduce((a, b) => a + b, 0);
  eq(sum, 0, `game ${seed} scores are zero-sum`);
  if (g.result.type === 'win') wins++; else draws++;
}
console.log(`  (${wins} self-draw wins, ${draws} draws over 200 random games)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
