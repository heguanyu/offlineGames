// AI strength: play many full hands with the engine driven by the bots and confirm the HARD bot
// (availability- + score-aware) clearly outscores EASY and NORMAL. Seats alternate level + the
// dealer rotates, so the 庄 advantage is split evenly and the gap reflects skill, not position.
import { Game, PHASE } from '../games/mahjong-tianjin/engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS } from '../games/mahjong-tianjin/ai.js';

const seeded = (s0) => { let s = s0 >>> 0; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };
const GAMES = +(process.env.MJ_AI_HANDS || 200);

function playHand(seed, levels) {
  const rng = seeded(seed);
  const g = new Game({ rng, dealer: seed % 4 });
  let guard = 0;
  while (g.phase !== PHASE.OVER && guard++ < 6000) {
    if (g.phase === PHASE.AWAIT_CLAIM) {
      const p = g.claim.player;
      const d = chooseClaim(g, p, g.claim, levels[p], rng);
      if (d && g.claim.options.includes(d)) g.claimDiscard(d); else g.passClaim();
      continue;
    }
    if (g.phase === PHASE.AWAIT_DISCARD) {
      const p = g.turn;
      if (g.selfDrawWin) { g.declareWin(); continue; } // self-draw is the only win — always take it
      const k = chooseSelfKong(g, p, levels[p], rng);
      if (k !== null) { g.selfKong(p, k); continue; }
      const t = chooseDiscard(g, p, levels[p], rng);
      if (t == null) { g.declareWin(); if (g.phase !== PHASE.OVER) break; continue; } // all-混儿 edge — bail
      g.discard(p, t);
    }
  }
  return g;
}

function match(label, levels, games = GAMES) {
  let a = 0, b = 0, wins = [0, 0, 0, 0], draws = 0, bad = 0;
  for (let s = 1; s <= games; s++) {
    const g = playHand(s, levels);
    if (g.phase !== PHASE.OVER) { bad++; continue; }
    if (g.scores.reduce((x, y) => x + y, 0) !== 0) bad++;
    for (let p = 0; p < 4; p++) (levels[p] === LEVELS.HARD ? (a += g.scores[p]) : (b += g.scores[p]));
    if (g.result.type === 'win') wins[g.result.winner]++; else draws++;
  }
  console.log(`  ${label}: HARD ${a >= 0 ? '+' : ''}${a} vs other ${b >= 0 ? '+' : ''}${b}  (wins ${wins.join('/')}, ${draws} draws${bad ? `, ${bad} BAD` : ''})`);
  return { a, b, bad };
}

console.log(`AI strength (${GAMES} hands each, dealer rotates):`);
const vsEasy = match('HARD,EASY,HARD,EASY', [LEVELS.HARD, LEVELS.EASY, LEVELS.HARD, LEVELS.EASY]);
const vsNorm = match('HARD,NORMAL,HARD,NORMAL', [LEVELS.HARD, LEVELS.NORMAL, LEVELS.HARD, LEVELS.NORMAL]);

let failed = 0;
const check = (c, m) => { if (!c) { failed++; console.error('  FAIL:', m); } };
check(vsEasy.bad <= 3 && vsNorm.bad <= 3, `nearly all hands terminate cleanly (bad ${vsEasy.bad}/${vsNorm.bad})`);
check(vsEasy.a > vsEasy.b, `HARD outscores EASY (${vsEasy.a} vs ${vsEasy.b})`);
check(vsNorm.a > vsNorm.b, `HARD outscores NORMAL (${vsNorm.a} vs ${vsNorm.b})`);
console.log(failed ? `\nMAHJONG AI TEST FAIL (${failed})` : '\nMAHJONG AI TEST PASS');
process.exit(failed ? 1 : 0);
