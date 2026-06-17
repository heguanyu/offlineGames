// Verifies the predicate behind the doudizhu QoL auto-select-all: when it is the human's turn
// and the ENTIRE remaining hand is a legal play right now, g.validatePlay(seat, allCardIds) is
// truthy (so main.js selects every card for a one-tap win). Checks free-lead + following, and
// the negative cases where the whole hand must NOT auto-select.
import { Game, classify } from '../games/doudizhu/engine.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? pass++ : fail++; };

// Build a hand of card objects (unique ids) from a list of ranks.
let nextId = 0;
const hand = (ranks) => ranks.map((r) => ({ id: nextId++, rank: r, suit: 0 }));
const ids = (cards) => cards.map((c) => c.id);

// Put a fresh Game into mid-PLAY with seat 0 to move and a chosen lead context.
function setup(humanRanks, { against = null } = {}) {
  const g = new Game({ rng: () => 0.5 });
  g.phase = 'play';
  g.turn = 0;
  g.hands[0] = hand(humanRanks);
  g.handCounts[0] = g.hands[0].length;
  if (against) { g.leadSeat = 1; g.lead = against; } else { g.leadSeat = 0; g.lead = null; }
  return g;
}

// ---- free lead (you are leading): any valid full-hand pattern wins ----
{
  const g = setup([3, 4, 5, 6, 7]);               // a straight = the whole hand
  ok('free lead: whole-hand straight auto-selects', !!g.validatePlay(0, ids(g.hands[0])));
}
{
  const g = setup([9, 9]);                          // a pair = the whole hand
  ok('free lead: whole-hand pair auto-selects', !!g.validatePlay(0, ids(g.hands[0])));
}
{
  const g = setup([5, 5, 5, 5]);                    // a bomb = the whole hand
  ok('free lead: whole-hand bomb auto-selects', !!g.validatePlay(0, ids(g.hands[0])));
}
{
  const g = setup([3, 7, 11]);                      // not a single legal pattern
  ok('free lead: non-combo whole hand does NOT auto-select', !g.validatePlay(0, ids(g.hands[0])));
}

// ---- following a lead: only auto-select if the whole hand also BEATS it ----
{
  const g = setup([13, 13], { against: classify([5, 5]) }); // pair KK over pair 55
  ok('follow: whole-hand pair that beats the lead auto-selects', !!g.validatePlay(0, ids(g.hands[0])));
}
{
  const g = setup([3, 3], { against: classify([5, 5]) });   // pair 33 cannot beat pair 55
  ok('follow: whole-hand pair that loses does NOT auto-select', !g.validatePlay(0, ids(g.hands[0])));
}
{
  const g = setup([5, 5, 5, 5], { against: classify([9, 9]) }); // bomb beats any non-bomb
  ok('follow: whole-hand bomb over a pair auto-selects', !!g.validatePlay(0, ids(g.hands[0])));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
