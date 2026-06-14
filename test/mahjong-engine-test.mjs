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

// A freshly-DRAWN 混儿 that can ONLY pair — the hand has no 4-5-6万 (捉五) and no 龙 for it
// to serve — is not 混吊 and not a win: parked in the 将 it is a 小和. (With a 4-5-6万
// present the 混 could instead stand as the 5万 → 捉五; see the 捉五 tests below.)
const drewWildPair = [M(1), M(2), M(3), M(7), M(8), M(9), P(1), P(2), P(3), P(7), P(8), P(9), 27, 28];
ok(analyzeWin(drewWildPair, [], { wilds: [27, 28], winningKind: 28 }) === null,
  'drawn 混儿 that can only pair (no 捉五/龙 available) → 小和');

// A drawn 混儿 parking in a plain run (7-8-9s, not 捉五/龙) is likewise not 混吊 → 小和.
const drewParks = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(9), P(9), S(7), S(8), 27];
ok(analyzeWin(drewParks, [], { wilds: [27, 28], winningKind: 27 }) === null,
  'drawn 混儿 parked in a plain run (not 捉五/龙) is not 混吊 → 小和');

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

// A drawn 混儿 standing as the 5万 (4万/6万 natural) wins as plain 捉五 = 3 — a drawn
// 混儿 is never 混吊.
const zw0 = [M(4), 27, M(6), P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(zw0, [], { wilds: [27, 28], winningKind: 27 });
ok(r && r.meta.zhuoWu && !r.meta.hunDiao && !r.meta.shuangHun, '捉五 only (drawn 混儿 as 5万 is not 混吊)');
eq(r.score, 3, '捉五(3), no 混吊');

// 捉五 won on a drawn 混儿 as the 5万 with the 4万 also a 混儿. Still plain 捉五 = 3: a
// drawn 混儿 never adds 混吊, and the standing 混儿 here is closed by a drawn (not
// natural) tile, so it doesn't count either.
const sszw = [M(6), 27, 28, P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(sszw, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.zhuoWu && !r.meta.hunDiao && !r.meta.shuangHun, '捉五 only (drawn 混儿 5万, standing 混儿 not closed by a natural tile)');
eq(r.score, 3, '捉五(3), no 混吊');

// 捉五 won on a drawn 混儿 as the 5万 in an all-混儿 run (three 混儿 as 4-5-6万). Plain
// 捉五 = 3.
const sszw2 = [27, 28, 27, P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(sszw2, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.zhuoWu && !r.meta.hunDiao, '捉五 only (all-混儿 run, drawn 混儿 as 5万)');
eq(r.score, 3, '捉五(3), no 混吊');

// 捉五 where the winning 混儿 must stand as the 5万 in a 4-5-6万 run while the natural
// 5,6,7万 form a SECOND run: 混,4万,5万,6万,7万,123条,123筒,东东 + drawn 混. The solver
// must read 567万 natural + 4万-[混]-[混] (wilds at 5/6万), not lock 456万 together —
// which would miss 捉五 and leave every reading a 小和.
const zwSplit = [M(4), M(5), M(6), M(7), S(1), S(2), S(3), P(1), P(2), P(3), 27, 27, 31, 31];
r = analyzeWin(zwSplit, [], { wilds: [31, 32], winningKind: 31 });
ok(r && r.meta.zhuoWu, '捉五 via 567万 natural + 4万-混-混 (drawn 混 stands as the 5万)');
eq(r && r.score, 3, '捉五(3): the second man run must not block the 捉五 reading');

// FOUR complete runs + two 混, won by drawing a 混: one 混 stands as the 5万 of the 456万
// and the natural 5万 slides into the 将 — a genuine 捉五 (best reading), the same shape
// as a 4_6万 kanchan and consistent with catching the spot on a natural 5万 (not a 小和).
const zwPair = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(4), P(5), P(6), 31, 31];
r = analyzeWin(zwPair, [], { wilds: [31, 32], winningKind: 31 });
ok(r && r.meta.zhuoWu, '456万 + two 混 (win on 混 as the 5万) is 捉五, not 小和');

// A drawn 混儿 filling a 龙 gap (the 9万 of 1-9万) wins as plain 龙 = 4 — a drawn 混儿
// is never 混吊, so this is 龙, not 混吊龙. (Wilds are winds, off-suit → no 本混.)
const hunLong = [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), 27, P(1), P(2), P(3), P(9), P(9)];
r = analyzeWin(hunLong, [], { wilds: [27, 28], winningKind: 27 });
ok(r && r.meta.long && !r.meta.hunDiao, '龙 only (drawn 混儿 in the 龙 is not 混吊龙)');
eq(r.score, 4, '龙(4), no 混吊');

// A full, all-natural 龙 with the drawn 混儿 parked in the 将 — the 混儿 is NOT in the
// 龙 (no gap to fill), so no 混吊: just 龙(4).
const longPark = [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), P(1), P(2), P(3), P(9), 27];
r = analyzeWin(longPark, [], { wilds: [27, 28], winningKind: 27 });
ok(r && r.meta.long && !r.meta.hunDiao, '龙 with a parked drawn 混儿 is just 龙, not 混吊龙');
eq(r.score, 4, '龙(4), no 混吊');

// --- 杠分 (kong points) + 金杠 -------------------------------------------------
console.log('kong points:');
{
  const kg = new Game({ rng: () => 0.5, indicator: 31 }); // wilds = 中,發 (31,32)
  ok(kg.isWild(31) && !kg.isWild(0), 'indicator 31 → 中發 are 混儿');
  kg.dealer = 0;
  kg.melds = [
    [{ type: 'kong', kind: 0, concealed: true }],   // 暗杠 = 2
    [{ type: 'kong', kind: 5, concealed: false }],  // 明杠 = 1
    [{ type: 'kong', kind: 31, concealed: true }],  // 金杠 (中 is a 混儿) = 4
    [],
  ];
  // K = [2,1,4,0], total = 7. Without 庄家加倍: net = 4K − total.
  kg.dealerDouble = false;
  eq(kg._settleKongs([0, 0, 0, 0]).join(), '1,-3,9,-7', '杠分 base net (no 庄家加倍): 暗2 / 明1 / 金4');
  // With 庄家加倍 (dealer = seat 0): every kong flow to/from the dealer doubles.
  kg.dealerDouble = true;
  const net = kg._settleKongs([0, 0, 0, 0]);
  eq(net.join(), '2,-4,11,-9', '杠分 net with 庄家加倍 (dealer seat 0 flows ×2)');
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
