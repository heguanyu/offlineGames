// Deterministic paired self-play: production expert policy vs the former baseline.
// Each deal is replayed twice with the policies swapped between teams, cancelling most card/seat
// luck. Override GD_EVAL_DEALS for a longer tuning run.
import { chooseMove } from '../games/guandan/ai.js';
import { makeDeck, Round, PHASE, shuffle, teamOf } from '../games/guandan/engine.js';

const deals = +(process.env.GD_EVAL_DEALS || 24);

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function play(hands, level, firstLeader, expertTeam) {
  const round = new Round({ hands: hands.map((hand) => hand.map((card) => ({ ...card }))), level, firstLeader });
  let turns = 0;
  while (round.phase !== PHASE.OVER && turns++ < 1000) {
    const seat = round.turn;
    const policy = teamOf(seat) === expertTeam ? 2 : 1;
    const move = chooseMove(round, seat, policy, () => 0.5);
    const applied = round.play(seat, move.pass ? [] : move.cardIds);
    if (!applied) throw new Error(`invalid AI move on turn ${turns}`);
  }
  if (round.phase !== PHASE.OVER) throw new Error('self-play round exceeded turn guard');
  const won = round.result.winTeam === expertTeam;
  return { won, margin: won ? round.result.advance : -round.result.advance, turns };
}

let wins = 0, losses = 0, margin = 0, turns = 0;
for (let i = 0; i < deals; i++) {
  const deck = shuffle(makeDeck(), seeded(0xC0FFEE + i * 7919));
  const hands = [0, 1, 2, 3].map((seat) => deck.slice(seat * 27, seat * 27 + 27));
  const level = 2 + (i % 13), firstLeader = i % 4;
  for (const expertTeam of [0, 1]) {
    const result = play(hands, level, firstLeader, expertTeam);
    if (result.won) wins++; else losses++;
    margin += result.margin; turns += result.turns;
  }
}

const rate = wins / (wins + losses);
console.log(`${deals * 2} paired rounds: expert ${wins}-${losses} (${(rate * 100).toFixed(1)}%), advancement margin ${margin >= 0 ? '+' : ''}${margin}, ${turns} turns`);
if (wins < losses || margin < 0) {
  console.error('expert policy regressed against the former baseline');
  process.exit(1);
}
