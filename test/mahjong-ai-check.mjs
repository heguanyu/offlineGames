// Quick AI sanity check: drive complete games with the bots and confirm they
// reach wins far more often than random discarding (17.5% baseline), terminate,
// and stay zero-sum. Usage: node test/mahjong-ai-check.mjs
import { Game, PHASE } from '../games/mahjong/engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS } from '../games/mahjong/ai.js';

function play(level, seed) {
  let s = seed >>> 0;
  const rng = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const g = new Game({ rng });
  let guard = 0;
  while (g.phase !== PHASE.OVER && guard++ < 6000) {
    if (g.phase === PHASE.AWAIT_CLAIM) {
      const dec = chooseClaim(g, g.claim.player, g.claim, level, rng);
      if (dec) g.claimDiscard(dec); else g.passClaim();
      continue;
    }
    if (g.phase === PHASE.AWAIT_DISCARD) {
      const p = g.turn;
      if (g.selfDrawWin) { g.declareWin(); continue; } // self-draw no longer auto-fires
      const kong = chooseSelfKong(g, p, level, rng);
      if (kong !== null) { g.selfKong(p, kong); continue; }
      g.discard(p, chooseDiscard(g, p, level, rng));
    }
  }
  return g;
}

for (const [name, level] of [['EASY', LEVELS.EASY], ['NORMAL', LEVELS.NORMAL], ['HARD', LEVELS.HARD]]) {
  let wins = 0, turnsTotal = 0, bad = 0, t0 = Date.now();
  const N = 300;
  for (let seed = 1; seed <= N; seed++) {
    const g = play(level, seed);
    if (g.phase !== PHASE.OVER) bad++;
    if (g.scores.reduce((a, b) => a + b, 0) !== 0) bad++;
    if (g.result.type === 'win') { wins++; turnsTotal += g.log.length; }
  }
  const ms = Date.now() - t0;
  console.log(`${name}: ${(100 * wins / N).toFixed(0)}% games won by self-draw, ` +
    `${bad} anomalies, ${(ms / N).toFixed(1)} ms/game`);
}
