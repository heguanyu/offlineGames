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

// Self-drawing a 混儿 to win is itself a 单吊 → at least 混吊. 123m 456m 123p 456p +
// a {混,混} 将 closed by drawing the 2nd 混儿: 1 STANDING 混儿 in the 将 → 混吊 (×2).
const drewWildPair = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(4), P(5), P(6), 27, 28];
r = analyzeWin(drewWildPair, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.hunDiao && !r.meta.shuangHun, '混吊 when a drawn 混儿 closes the 将 (1 standing 混儿)');
eq(r.score, 2, '混吊 = 2');

// A drawn 混儿 that just parks in an otherwise-natural meld is still a 单吊 → 混吊.
// 123m 456m 123p 99p + {7s,8s,混}: drew the 混儿 to fill the 9s of a 7-8-9s run.
const drewParks = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(9), P(9), S(7), S(8), 27];
r = analyzeWin(drewParks, [], { wilds: [27, 28], winningKind: 27 });
ok(r && r.meta.hunDiao, '混吊 when the drawn 混儿 completes the win (even parking in a run)');
eq(r.score, 2, '混吊 = 2');

// 双混 IS credited when a NATURAL tile closes a wait two standing 混儿 held open.
// 123m 456m 123p 99p + {27,28,9s}: the two hand-row wilds stand as 999s and the
// drawn natural 9s closes the triplet → 双混(×2), score 2.
const twoWildMeld = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(9), P(9), 27, 28, S(9)];
r = analyzeWin(twoWildMeld, [], { wilds: [27, 28], winningKind: S(9) });
ok(r && r.meta.shuangHun, '双混 credited when two standing 混儿 are closed by a natural tile');
ok(!r.meta.su, '双混 hand is not 素');
eq(r.score, 2, '双混儿 = 2');

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

// 天和 — dealer's立手 (first-draw) win → flat maximum (28), not the pattern score.
r = analyzeWin(plain, [], { wilds: [27, 28], winningKind: S(5), tianOrDi: true, dealerWin: true });
eq(r.score, 28, '天和 = 28 (flat max)');
ok(r.fans.includes('天和'), '天和 labelled');

// 捉五 won on a 混儿 as the 5万, no other 混儿 in the run (4万/6万 natural). The drawn
// 混儿 is the 吊 → 混吊; 0 standing 混儿 so not 双混. 捉五(3) × 混吊(2) = 6.
const zw0 = [M(4), 27, M(6), P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(zw0, [], { wilds: [27, 28], winningKind: 27 });
ok(r && r.meta.zhuoWu && r.meta.hunDiao && !r.meta.shuangHun, '捉五 + 混吊 (won 混儿 as 5万, 0 standing)');
eq(r.score, 6, '捉五(3) × 混吊(2) = 6');

// 捉五 won on a 混儿 as the 5万, with the 4万 also a STANDING 混儿 (run has 2 混儿).
// 1 standing 混儿 → 混吊 (not 双混, since the won 混儿 doesn't count). 捉五×混吊 = 6.
const sszw = [M(6), 27, 28, P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(sszw, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.zhuoWu, '捉五 detected when a drawn 混儿 fills the 5万');
ok(r && r.meta.hunDiao && !r.meta.shuangHun, '捉五 + 混吊 (1 standing 混儿; the won 混儿 is the 吊)');
eq(r.score, 6, '捉五(3) × 混吊(2) = 6');

// 捉五 won on a 混儿 as the 5万 with BOTH 4万 and 6万 standing 混儿 (run = three 混儿).
// 2 STANDING 混儿 → 双混. 捉五(3) × 双混(2) = 6.
const sszw2 = [27, 28, 27, P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(sszw2, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.zhuoWu, '捉五 detected (won 混儿 as 5万, two standing 混儿)');
ok(r && r.meta.shuangHun, '双混 when 2 standing 混儿 are in the 捉五 run');
eq(r.score, 6, '捉五(3) × 双混(2) = 6');

// --- 杠分 (kong points) + 金杠 -------------------------------------------------
console.log('kong points:');
{
  const kg = new Game({ rng: () => 0.5, indicator: 31 }); // wilds = 中,發 (31,32)
  ok(kg.isWild(31) && !kg.isWild(0), 'indicator 31 → 中發 are 混儿');
  kg.melds = [
    [{ type: 'kong', kind: 0, concealed: true }],   // 暗杠 = 2
    [{ type: 'kong', kind: 5, concealed: false }],  // 明杠 = 1
    [{ type: 'kong', kind: 31, concealed: true }],  // 金杠 (中 is a 混儿) = 4
    [],
  ];
  const net = kg._settleKongs([0, 0, 0, 0]);
  // K = [2,1,4,0], total = 7 → net = 4K − total = [1, −3, 9, −7]
  eq(net.join(), '1,-3,9,-7', '杠分 net: 暗2 / 明1 / 金4, paid by the other three');
  eq(net.reduce((a, b) => a + b, 0), 0, '杠分 is zero-sum');
  // 金杠 is offered for four 混儿 in hand (the only way to kong a wild)
  kg.hands[kg.dealer] = [31, 31, 31, 31, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3];
  kg.phase = PHASE.AWAIT_DISCARD; kg.turn = kg.dealer;
  ok(kg.selfKongOptions(kg.dealer).some((o) => o.type === 'gold' && o.kind === 31), '金杠 offered for four 混儿');
}

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
      if (g.selfDrawWin) { g.declareWin(); continue; } // self-draw no longer auto-fires
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
