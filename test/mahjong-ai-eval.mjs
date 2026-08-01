// Deterministic paired self-play: production HARD vs the former NORMAL policy. Every wall is
// replayed with the policies swapped between seats, reducing dealer/hand luck.
// Override MJ_EVAL_DEALS for a longer tuning run.
import { Game, PHASE } from '../games/mahjong-tianjin/engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS } from '../games/mahjong-tianjin/ai.js';

const deals = +(process.env.MJ_EVAL_DEALS || 20);
const seeded = (s0) => {
  let s = s0 >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};

function play(seed, hardSeats) {
  const rng = seeded(seed);
  const levels = [0, 1, 2, 3].map((p) => hardSeats.has(p) ? LEVELS.HARD : LEVELS.NORMAL);
  const game = new Game({ rng, dealer: seed % 4 });
  let turns = 0;
  while (game.phase !== PHASE.OVER && turns++ < 6000) {
    if (game.phase === PHASE.AWAIT_CLAIM) {
      const p = game.claim.player;
      const action = chooseClaim(game, p, game.claim, levels[p], rng);
      if (action && game.claim.options.includes(action)) game.claimDiscard(action); else game.passClaim();
      continue;
    }
    const p = game.turn;
    if (game.selfDrawWin) { game.declareWin(); continue; }
    const kong = chooseSelfKong(game, p, levels[p], rng);
    if (kong !== null) { game.selfKong(p, kong); continue; }
    const tile = chooseDiscard(game, p, levels[p], rng);
    if (tile == null) throw new Error('AI returned no discard without a win');
    game.discard(p, tile);
  }
  if (game.phase !== PHASE.OVER) throw new Error('self-play hand exceeded turn guard');
  const hardScore = [...hardSeats].reduce((sum, p) => sum + game.scores[p], 0);
  const hardWin = game.result.type === 'win' && hardSeats.has(game.result.winner);
  const normalWin = game.result.type === 'win' && !hardSeats.has(game.result.winner);
  return { hardScore, hardWin, normalWin, turns };
}

let score = 0, hardWins = 0, normalWins = 0, draws = 0, turns = 0;
for (let i = 1; i <= deals; i++) {
  for (const hardSeats of [new Set([0, 2]), new Set([1, 3])]) {
    const result = play(i, hardSeats);
    score += result.hardScore; turns += result.turns;
    if (result.hardWin) hardWins++;
    else if (result.normalWin) normalWins++;
    else draws++;
  }
}

console.log(`${deals * 2} paired hands: HARD score ${score >= 0 ? '+' : ''}${score}, wins ${hardWins}-${normalWins}, ${draws} draws, ${turns} turns`);
if (score <= 0 || hardWins < normalWins) {
  console.error('production Tianjin policy did not beat the former baseline');
  process.exit(1);
}
