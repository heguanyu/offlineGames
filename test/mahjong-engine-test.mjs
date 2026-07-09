// Unit tests for the Tianjin mahjong rules engine. Pure logic, no browser.
// Usage: node test/mahjong-engine-test.mjs
import {
  wildKindsFromIndicator, nextInCycle, tileName, isWinningHand, analyzeWin,
  Game, PHASE, freshTiles,
} from '../games/mahjong-tianjin/engine.js';

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

// 混吊: four complete melds + a 单吊将 wait held open by ONE standing 混儿, completed by
// drawing a second 混儿 → the 将 is now two 混儿. The standing 混儿 was a genuine 混吊 wait
// (it wins on any tile), so this IS a legal win. 混吊 is the 将 fan (双混吊 is a 2-混儿
// MELD, not this), so even a two-混儿 将 scores as 混吊 (×2) = 2.
const drewWildPair = [M(1), M(2), M(3), M(7), M(8), M(9), P(1), P(2), P(3), P(7), P(8), P(9), 27, 28];
r = analyzeWin(drewWildPair, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.hunDiao && !r.meta.shuangHun, '混吊: 单吊将 wait completed by drawing a 混儿 (将 = two 混儿)');
ok(r && r.fans.includes('混吊'), '混吊 labelled (not 双混吊 — that is for a 2-混儿 meld)');
eq(r && r.score, 2, '混吊(×2) = 2');

// A drawn 混儿 parking in a plain run (7-8-9s, not 捉五/龙) is likewise not 混吊 → 小和.
const drewParks = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(9), P(9), S(7), S(8), 27];
ok(analyzeWin(drewParks, [], { wilds: [27, 28], winningKind: 27 }) === null,
  'drawn 混儿 parked in a plain run (not 捉五/龙) is not 混吊 → 小和');

// 双混吊 IS credited when a NATURAL tile closes a MELD two standing 混儿 held open.
// 123m 456m 123p 99p + {27,28,9s}: the two hand-row wilds stand as 999s and the
// drawn natural 9s closes the triplet → 双混吊(×2), score 2.
const twoWildMeld = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(9), P(9), 27, 28, S(9)];
r = analyzeWin(twoWildMeld, [], { wilds: [27, 28], winningKind: S(9) });
ok(r && r.meta.shuangHun, '双混吊 credited when two standing 混儿 in a meld are closed by a natural tile');
ok(!r.meta.su, '双混吊 hand is not 素');
ok(r.fans.includes('双混吊'), '双混吊 labelled');
eq(r.score, 2, '双混吊 = 2');

// 混吊, NOT 双混: 123m 456m 123p + {P5,P6,P6} + two off-suit wilds, drew P6. The
// drawn 6筒 pairs ONE standing 混儿 (将), the other 混儿 fills a 5-6筒 run → 混吊.
// It must NOT be mis-read as 双混 by parking the winning 6筒 on a JOKER slot inside a
// 4-5-6筒 run (whose real 6 slot is a joker, with the two natural 6筒 left as the 将).
const hunDiaoRun = [M(1), M(2), M(3), M(4), M(5), M(6), P(1), P(2), P(3), P(5), P(6), P(6), 27, 28];
r = analyzeWin(hunDiaoRun, [], { wilds: [27, 28], winningKind: P(6) });
ok(r && r.meta.hunDiao && !r.meta.shuangHun, '混吊 (drawn 6筒 pairs a 混儿; other 混儿 in a 5-6筒 run) — not mis-credited 双混');
eq(r.score, 2, '混吊(2) = 2');

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

// 天和/地和 — "天胡算龙 + 随意摆": an ADDITIVE 4 (like 龙); the hand is arranged in its best
// reading and every other fan stacks normally (zh.wikipedia: 4番; folk rule: 天胡+混吊 = 混吊龙).
r = analyzeWin(plain, [], { wilds: [27, 28], winningKind: S(5), tianOrDi: true, dealerWin: true });
eq(r.score, 8, '天和(4) × 素(2) = 8 — a wild-less 天和 keeps the 素 multiplier');
ok(r.fans.includes('天和') && r.fans.includes('素'), '天和 + 素 labelled');

// 地和 + 混吊 = the folk "混吊龙": 天地和(4) × 混吊(2) = 8.
r = analyzeWin(hunDiaoRun, [], { wilds: [27, 28], winningKind: P(6), tianOrDi: true, dealerWin: false });
eq(r.score, 8, '地和(4) × 混吊(2) = 8 (混吊龙)');
ok(r.fans.includes('地和') && r.fans.includes('混吊'), '地和 + 混吊 labelled');

// 天和 holding a REAL dragon stacks additively, multipliers on top: (天和4 + 龙4) × 本混2 = 16.
r = analyzeWin(benHun, [], { wilds: [M(8), M(9)], winningKind: P(9), tianOrDi: true, dealerWin: true });
eq(r.score, 16, '(天和4 + 本混龙4) × 本混(2) = 16');
ok(r.fans.includes('天和') && r.fans.includes('本混龙'), '天和 + 本混龙 labelled');

// The big one: 天和 + 捉五 + 本混龙 all stack — (天和4 + 捉五3 + 龙4) × 本混2 = 22.
// (A fully NATURAL 本混龙 cannot exist: 本混 means the dragon shares the wild's suit, so the
// dragon's wild-kind tiles are always 混儿 — here the two M8s stand as the 8万/9万.)
const tianMax = [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(8), P(1), P(2), P(3), P(9), P(9)];
r = analyzeWin(tianMax, [], { wilds: [M(8), M(9)], winningKind: M(5), tianOrDi: true, dealerWin: true });
eq(r.score, 22, '(天和4 + 捉五3 + 龙4) × 本混(2) = 22');
ok(r.fans.includes('天和') && r.fans.includes('捉五') && r.fans.includes('本混龙'), '天和 + 捉五 + 本混龙 labelled');

// A drawn 混儿 as the 5万 with 4万/6万 natural — NO standing 混儿 in the run — wins as
// plain 捉五 = 3 (no 混吊 nor 双混吊: the only 混儿 is the drawn winning tile).
const zw0 = [M(4), 27, M(6), P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(zw0, [], { wilds: [27, 28], winningKind: 27 });
ok(r && r.meta.zhuoWu && !r.meta.hunDiao && !r.meta.shuangHun, '捉五 only (drawn 混儿 as 5万, no standing 混儿)');
eq(r.score, 3, '捉五(3), no 双混');

// 捉五 with the 4万 a STANDING 混儿 and the drawn 混儿 as the 5万 (6万 natural): only ONE
// standing 混儿 sits in the run, and 双混吊 needs TWO, so the lone 混儿 earns no wait fan →
// plain 捉五 = 3.
const sszw = [M(6), 27, 28, P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(sszw, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.zhuoWu && !r.meta.hunDiao && !r.meta.shuangHun, '捉五 only (one standing 混儿 in the run is not 双混)');
eq(r.score, 3, '捉五(3), no 双混');

// 双混捉五: a drawn 混儿 as the 5万 closes an all-混儿 4-5-6万 run whose other two 混儿 are
// STANDING — that two-混儿 meld is a genuine 双混吊 wait, completed by the drawn tile exactly
// as a natural tile closing two standing 混儿 (cf. twoWildMeld above). 捉五(3) × 双混吊(2) = 6.
const sszw2 = [27, 28, 27, P(1), P(2), P(3), 31, 31, 31, 32, 32, 32, S(9), S(9)];
r = analyzeWin(sszw2, [], { wilds: [27, 28], winningKind: 28 });
ok(r && r.meta.zhuoWu && r.meta.shuangHun, '双混捉五 (all-混儿 4-5-6万: two standing 混儿 closed by the drawn 混儿 5万)');
eq(r.score, 6, '捉五(3) × 双混吊(2) = 6');

// Reported hand (was mis-scored as plain 捉五 = 3): a 北 kong + 2条 pung + 2万 将, holding
// 5万, 6万 and FOUR 混儿. The best reading splits the man tiles into [混,5万,6万] (混 = 4万)
// plus an all-混儿 4-5-6万 whose two STANDING 混儿 + the drawn 混儿 (the 5万) are the 双混吊
// wait → 双混捉五 = 6, NOT plain 捉五.
const reported = [M(5), M(6), M(2), M(2), S(2), S(2), S(2), P(1), P(1), P(2), P(2)];
const reportedKong = [{ type: 'kong', kind: 30, tiles: [30, 30, 30, 30], concealed: true }];
r = analyzeWin(reported, reportedKong, { wilds: [P(1), P(2)], winningKind: P(1) });
ok(r && r.meta.zhuoWu && r.meta.shuangHun, '双混捉五 across a [混,5万,6万] + all-混儿 4-5-6万 split (reported hand)');
eq(r.score, 6, '捉五(3) × 双混吊(2) = 6 (reported hand)');

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

// 本混龙, NOT 本混龙+双混吊: wilds = 4万/5万 (man suit). Hand 123万 789万 natural + three
// 混儿 (4万,4万,5万) + 22条 33条, drew the 6万. Best reading is 123/456/789万 (the 456 being
// joker·joker·natural 6万) = a full 1-9万 龙 in the wild suit → 本混龙(8). The 456万 run is
// PART of the 龙, so its two standing 混儿 must NOT also be credited as 双混吊 — that 吊 fan
// only applies to a meld OUTSIDE the dragon. (Was mis-scored 本混龙×双混吊 = 16.)
const benHunNoShuang = [M(1), M(2), M(3), M(7), M(8), M(9), M(4), M(4), M(5), S(2), S(2), S(3), S(3)];
r = analyzeWin([...benHunNoShuang, M(6)], [], { wilds: [M(4), M(5)], winningKind: M(6) });
ok(r && r.meta.benHunLong && !r.meta.shuangHun, '本混龙 only — the 混儿 inside the 龙 are not also 双混吊');
ok(r && r.fans.includes('本混龙') && !r.fans.includes('双混吊'), '本混龙 labelled, 双混吊 not');
eq(r && r.score, 8, '本混龙(8), no 双混吊 (the dragon run is not an outside meld)');

// 龙 + 混吊 IS still legal: 混吊 lives on the 将 (pair), which is never part of a 龙 (the
// dragon is three CHOWS). Full 1-9万 + 123筒 + a 单吊将 of [混儿 + winning 9筒]. The standing
// 混儿 in the pair is a genuine 混吊 wait, OUTSIDE the dragon → 龙(4) × 混吊(2) = 8. (Wilds
// are winds, off-suit, so no 本混.) Guards that excluding dragon RUNS did not also kill 混吊.
const longHunDiao = [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), P(1), P(2), P(3), 27];
r = analyzeWin([...longHunDiao, P(9)], [], { wilds: [27, 28], winningKind: P(9) });
ok(r && r.meta.long && r.meta.hunDiao && !r.meta.shuangHun, '龙 + 混吊 — the 将 carries the 混儿 wait (outside the 龙)');
ok(r && r.fans.includes('龙') && r.fans.includes('混吊'), '龙 and 混吊 both labelled');
eq(r && r.score, 8, '龙(4) × 混吊(2) = 8');

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

// --- 拉庄 (blind double-down: a challenger doubles their flow with the 庄) ----------
console.log('拉庄:');
{
  // dealer = seat 1; seat 0 (human) 拉庄. pairMultiplier stacks 庄(2) × 拉庄(2) = 4.
  const g = new Game({ rng: () => 0.5, indicator: 31, dealer: 1, laZhuang: [0] });
  g.scores = [0, 0, 0, 0];
  eq(g.pairMultiplier(0, 1), 4, '拉庄: challenger↔庄 = 庄2 × 拉庄2 = 4');
  eq(g.pairMultiplier(0, 2), 1, '拉庄: challenger↔闲 unaffected = 1');
  eq(g.pairMultiplier(1, 2), 2, '拉庄: 庄↔non-challenger = 庄2 only');
  eq(g.settlementFactors(0, 1).map((x) => x.label).join('+'), '庄+拉庄', '拉庄: factors labelled 庄 + 拉庄');
  // 胡分: challenger self-draws score 3 → 庄 pays 3×4 = 12; the two 闲 pay 3 (×1) each.
  const pay = g._settle(0, 3);
  eq(pay.join(','), '18,-12,-3,-3', '拉庄 胡分: 庄 pays the challenger 4× (12), 闲 pay 1× (3)');
  eq(pay.reduce((a, b) => a + b, 0), 0, '拉庄 胡分 is zero-sum');
  // 杠分: challenger holds an 暗杠 (2) → 庄 pays 2×4 = 8; the two 闲 pay 2 (×1) each.
  const g2 = new Game({ rng: () => 0.5, indicator: 31, dealer: 1, laZhuang: [0] });
  g2.scores = [0, 0, 0, 0];
  g2.melds = [[{ type: 'kong', kind: 0, concealed: true }], [], [], []];
  eq(g2._settleKongs([0, 0, 0, 0]).join(','), '12,-8,-2,-2', '拉庄 杠分: 庄 pays the challenger 暗杠 4× (8), 闲 pay 1× (2)');
  // a third party winning: 拉庄 leaves the 胡分 untouched (challenger & 庄 don't exchange).
  const g3 = new Game({ rng: () => 0.5, indicator: 31, dealer: 1, laZhuang: [0] });
  g3.scores = [0, 0, 0, 0];
  eq(g3._settle(2, 3).join(','), '-3,-6,12,-3', '拉庄: a 闲 win is unaffected (only 庄 pays 庄2)');
  // no 拉庄 → the 庄家加倍 baseline is unchanged.
  const g4 = new Game({ rng: () => 0.5, indicator: 31, dealer: 1 });
  g4.scores = [0, 0, 0, 0];
  eq(g4.pairMultiplier(0, 1), 2, 'no 拉庄: challenger↔庄 = 庄2 only');
  eq(g4._settle(0, 3).join(','), '12,-6,-3,-3', 'no 拉庄: 庄 pays 2× (6) baseline');
}

// --- 座风 fixed per 锅 (only the 庄 moves, the winds don't) ------------------------
console.log('座风:');
{
  // seatBase = 0 → seat 0 is 东 no matter which seat holds the 庄 button.
  const a = new Game({ rng: () => 0.5, indicator: 31, dealer: 0, seatBase: 0 });
  eq(a.seatWind(0), 0, '座风: seat 0 = 东 (东庄 when 庄 = seat 0)');
  eq(a.seatWind(1), 1, '座风: seat 1 = 南');
  const b = new Game({ rng: () => 0.5, indicator: 31, dealer: 2, seatBase: 0 });
  eq(b.seatWind(0), 0, '座风 fixed: seat 0 still 东 when 庄 = seat 2');
  eq(b.seatWind(1), 1, '座风 fixed: seat 1 still 南 regardless of 庄');
  eq(b.seatWind(2), 2, '座风: the 庄 (seat 2) reads 西庄, not 东庄');
  // no seatBase → legacy 庄-relative reading (庄 = 东) keeps standalone Games unchanged.
  const c = new Game({ rng: () => 0.5, indicator: 31, dealer: 2 });
  eq(c.seatWind(2), 0, 'default seatBase = 庄, so the 庄 still reads 东 (legacy)');
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
