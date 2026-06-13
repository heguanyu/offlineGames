// Tests for the 国标 (MCR) engine + fan scoring. Usage: node test/guobiao-engine-test.mjs
import { analyzeWin, Game, PHASE, MIN_FAN } from '../games/guobiao/engine.js';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error('  FAIL:', m); } };

const M = (r) => r - 1, P = (r) => 8 + r, S = (r) => 17 + r;
const E = 27, So = 28, W = 29, N = 30, C = 31, F = 32, B = 33;
const ctx = (over = {}) => ({ selfDraw: true, winByDiscard: false, winningTile: null, roundWind: 0, seatWind: 1, lastTile: false, afterKong: false, ...over });
const fanOf = (r) => (r ? r.fan : -1);
const names = (r) => (r ? r.fans.map((f) => f.name) : []);

console.log('special hands:');
// 十三幺
let r = analyzeWin([M(1), M(9), P(1), P(9), S(1), S(9), E, So, W, N, C, C, F, B], [], ctx({ winningTile: C }));
ok(names(r).includes('十三幺') && fanOf(r) >= 88, '十三幺 = 88');
// 七对 (7 distinct pairs, mixed suits)
r = analyzeWin([M(1), M(1), M(3), M(3), M(5), M(5), M(7), M(7), M(9), M(9), P(3), P(3), S(4), S(4)], [], ctx({ winningTile: S(4) }));
ok(names(r).includes('七对') && fanOf(r) >= 24, `七对 ≥ 24 (got ${fanOf(r)})`);

console.log('big hands:');
// 大三元: 中中中 發發發 白白白 + m123 + m9m9
r = analyzeWin([C, C, C, F, F, F, B, B, B, M(1), M(2), M(3), M(9), M(9)], [], ctx({ winningTile: M(3) }));
ok(names(r).includes('大三元') && fanOf(r) >= 88, `大三元 ≥ 88 (got ${fanOf(r)})`);
// 清一色 (all bamboo): 123 456 789 789 + 99 — wait, build 4 melds + pair in one suit
r = analyzeWin([S(1), S(2), S(3), S(4), S(5), S(6), S(7), S(8), S(9), S(2), S(3), S(4), S(5), S(5)], [], ctx({ winningTile: S(5) }));
ok(names(r).includes('清一色') && fanOf(r) >= 24, `清一色 ≥ 24 (got ${fanOf(r)})`);
// 碰碰和 + 混一色: 3 pungs in one suit + an exposed 中 pung + pair (so it's not 四暗刻)
r = analyzeWin([M(2), M(2), M(2), M(5), M(5), M(5), M(8), M(8), M(8), M(1), M(1)],
  [{ type: 'pung', tiles: [C, C, C], concealed: false }], ctx({ winningTile: M(1) }));
ok(names(r).includes('碰碰和') && names(r).includes('混一色'), `碰碰和 + 混一色 (got ${names(r).join(',')})`);

console.log('cheap hand is below the 8-fan minimum:');
// exposed chow + plain chows, simple pair, win on the pair → only small fans
r = analyzeWin([M(2), M(3), M(4), M(5), M(6), M(7), P(2), P(3), P(4), P(5), P(5)],
  [{ type: 'chow', tiles: [S(6), S(7), S(8)], concealed: false }], ctx({ winningTile: P(5), selfDraw: false, winByDiscard: true }));
ok(fanOf(r) < MIN_FAN, `plain hand < 8 fan (got ${fanOf(r)}: ${names(r).join(',')})`);

console.log('a non-winning shape returns null:');
ok(analyzeWin([M(1), M(1), M(4), M(7), P(2), P(5), P(8), S(1), S(4), S(7), E, So, W, N], [], ctx()) === null, 'scattered hand is not a win');

console.log('win on discard vs self-draw (concealment):');
// four concealed pungs by self-draw vs the winning pung coming from a discard
const fourPung = [M(2), M(2), M(2), M(5), M(5), M(5), P(3), P(3), P(3), S(7), S(7), S(7), C, C];
const selfd = analyzeWin(fourPung, [], ctx({ winningTile: S(7), selfDraw: true, winByDiscard: false }));
const disc = analyzeWin(fourPung, [], ctx({ winningTile: S(7), selfDraw: false, winByDiscard: true }));
ok(names(selfd).includes('四暗刻'), `self-draw → 四暗刻 (got ${names(selfd).join(',')})`);
ok(!names(disc).includes('四暗刻'), 'discard completes the pung → not 四暗刻');

console.log('full game: random self-play terminates, zero-sum, wins ≥ 8 fan:');
function play(seed, takeClaims, minFan = 8) {
  let s = seed >>> 0;
  const rng = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const g = new Game({ rng, minFan });
  let guard = 0;
  while (g.phase !== PHASE.OVER && guard++ < 6000) {
    if (g.phase === PHASE.AWAIT_CLAIM) {
      const c = g.currentClaim();
      if (c.type === 'win') g.claimTake();
      else if (takeClaims && rng() < 0.5) g.claimTake(c.options ? c.options[0] : undefined);
      else g.claimPass();
      continue;
    }
    const hand = g.hands[g.turn];
    g.discard(g.turn, hand[Math.floor(rng() * hand.length)]);
  }
  return g;
}
let wins = 0, draws = 0, bad = 0;
for (let seed = 1; seed <= 150; seed++) {
  for (const take of [false, true]) {
    const g = play(seed, take);
    if (g.phase !== PHASE.OVER) bad++;
    if (g.scores.reduce((a, b) => a + b, 0) !== 0) bad++;
    if (g.result.type === 'win') { wins++; if (g.result.fan < MIN_FAN) bad++; } else draws++;
  }
}
ok(bad === 0, `no anomalies (${bad})`);
console.log(`  (${wins} wins, ${draws} draws over 300 games; anomalies ${bad})`);

console.log('无定番 (minFan: 0): more wins, including some below 8 fan:');
let w0 = 0, d0 = 0, bad0 = 0, sub8 = 0;
for (let seed = 1; seed <= 150; seed++) {
  for (const take of [false, true]) {
    const g = play(seed, take, 0);
    if (g.phase !== PHASE.OVER) bad0++;
    if (g.scores.reduce((a, b) => a + b, 0) !== 0) bad0++;
    if (g.result.type === 'win') { w0++; if (g.result.fan < MIN_FAN) sub8++; } else d0++;
  }
}
ok(bad0 === 0, `no anomalies with minFan 0 (${bad0})`);
ok(w0 > wins, `minFan 0 yields more wins than minFan 8 (${w0} vs ${wins})`);
ok(sub8 > 0, `some 无定番 wins are below 8 fan (${sub8})`);
console.log(`  (${w0} wins incl. ${sub8} sub-8-fan, ${d0} draws over 300 games)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
