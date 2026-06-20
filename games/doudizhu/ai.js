// 斗地主 AI. Pure, no DOM, Node-testable. Built on engine.js's legalMoves()/classify().
//
// Difficulty tiers (per the design):
//   level 0 (新手)  — erratic/greedy: heuristic with heavy noise, ignores hoarding.
//   level 1 (普通)  — the full heuristic: fewest-hands hand value, control/fragmentation
//                     awareness, card memory, and peasant cooperation.
//   level 2 (高手)  — the heuristic PLUS determinized Monte-Carlo rollouts in the back half
//                     of the hand, where reading the remaining cards decides games.
//   (online, future) — a neural policy (DouZero-style) would replace pickMoveRanks behind the
//                     SAME chooseMove() call; nothing else changes.
//
// The whole AI runs off a per-seat "view" (handRanks / against / roles / handCounts / outstanding),
// so the exact same policy drives the real bots AND the players inside a Monte-Carlo rollout.
import { legalMoves, classify, beats, COMBO } from './engine.js';

// ---- minimum-hands hand value ---------------------------------------------
// The dominant strength signal in 斗地主 is "how few separate plays can I empty my hand in".
// minSplit() returns that count over the structural combo types (no kickers — kept relative,
// which is all the heuristic needs). Memoized on the count-vector since rollouts re-evaluate
// the same shapes constantly.
const splitCache = new Map();
function minSplit(counts) {
  let i = 3; while (i <= 17 && !counts[i]) i++;
  if (i > 17) return 0;
  const key = counts.slice(3).join(',');
  const cached = splitCache.get(key);
  if (cached !== undefined) return cached;
  if (splitCache.size > 300000) splitCache.clear();
  let best = Infinity;
  const c = counts.slice();
  // rocket is independent of the lowest rank
  if (counts[16] && counts[17]) { c[16]--; c[17]--; best = Math.min(best, 1 + minSplit(c)); c[16]++; c[17]++; }
  const k = counts[i];
  c[i]--; best = Math.min(best, 1 + minSplit(c)); c[i]++;                                  // single
  if (k >= 2 && i < 16) { c[i] -= 2; best = Math.min(best, 1 + minSplit(c)); c[i] += 2; }  // pair
  if (k >= 3 && i < 16) { c[i] -= 3; best = Math.min(best, 1 + minSplit(c)); c[i] += 3; }  // trio
  if (k >= 4 && i < 16) { c[i] -= 4; best = Math.min(best, 1 + minSplit(c)); c[i] += 4; }  // bomb
  if (i <= 14) {                                                                            // straight ≥5
    let L = 0;
    for (let r = i; r <= 14 && counts[r] >= 1; r++) { L++; if (L >= 5) { for (let x = i; x < i + L; x++) c[x]--; best = Math.min(best, 1 + minSplit(c)); for (let x = i; x < i + L; x++) c[x]++; } }
  }
  if (i <= 14) {                                                                            // 连对 ≥3 pairs
    let L = 0;
    for (let r = i; r <= 14 && counts[r] >= 2; r++) { L++; if (L >= 3) { for (let x = i; x < i + L; x++) c[x] -= 2; best = Math.min(best, 1 + minSplit(c)); for (let x = i; x < i + L; x++) c[x] += 2; } }
  }
  if (i <= 14) {                                                                            // 飞机 ≥2 trios
    let L = 0;
    for (let r = i; r <= 14 && counts[r] >= 3; r++) { L++; if (L >= 2) { for (let x = i; x < i + L; x++) c[x] -= 3; best = Math.min(best, 1 + minSplit(c)); for (let x = i; x < i + L; x++) c[x] += 3; } }
  }
  splitCache.set(key, best);
  return best;
}

function countsArr(ranks) {
  const c = new Array(18).fill(0);
  for (const r of ranks) c[r]++;
  return c;
}
function removeRanks(counts, ranks) {
  const c = counts.slice();
  for (const r of ranks) c[r]--;
  return c;
}
function playFromArr(arr, ranks) {
  const out = arr.slice();
  for (const r of ranks) out.splice(out.indexOf(r), 1);
  return out;
}

// ---- views -----------------------------------------------------------------
// A seat's decision view. buildView() derives it from a real Game; makeSimView() from a
// Monte-Carlo rollout's full-info hands. pickMoveRanks() reads only these fields.
export function buildView(game, seat) {
  const handRanks = game.hands[seat].map((c) => c.rank);
  const counts = countsArr(handRanks);
  const role = seat === game.landlord ? 1 : 0;
  const partner = role === 0 ? [0, 1, 2].find((s) => s !== seat && s !== game.landlord) : -1;
  const played = new Array(18).fill(0);
  for (const e of game.playLog) if (e.move) for (const r of e.ranks) played[r]++;
  const out = new Array(18).fill(0);
  for (let r = 3; r <= 17; r++) { const total = r >= 16 ? 1 : 4; out[r] = total - counts[r] - played[r]; }
  return {
    handRanks, counts,
    against: seat === game.leadSeat ? null : game.lead,
    leadSeat: game.leadSeat, leadDesc: game.lead, seat, landlord: game.landlord, role, partner,
    handCounts: game.handCounts.slice(), outstanding: out,
    bombs: game.bombs, landlordPlays: game.landlordPlays, peasantPlayed: game.peasantPlayed,
  };
}
function makeSimView(H, seat, against, leadSeat, landlord) {
  const handRanks = H[seat];
  const role = seat === landlord ? 1 : 0;
  const partner = role === 0 ? [0, 1, 2].find((s) => s !== seat && s !== landlord) : -1;
  const out = new Array(18).fill(0);
  for (const s of [0, 1, 2]) if (s !== seat) for (const r of H[s]) out[r]++;
  return { handRanks, counts: countsArr(handRanks), against, leadSeat, seat, landlord, role, partner,
    handCounts: [H[0].length, H[1].length, H[2].length], outstanding: out };
}

// ---- candidate scoring -----------------------------------------------------
// What a move "costs" in control: spending 2s/jokers/bombs/rockets is precious and should be
// hoarded until they buy something (taking a needed lead, or stopping an opponent's win).
function controlCost(move) {
  let c = 0;
  if (move.type === COMBO.ROCKET) return 9;
  if (move.type === COMBO.BOMB) return 7;
  for (const r of move.ranks) { if (r === 17) c += 4; else if (r === 16) c += 3; else if (r === 15) c += 1.5; }
  return c;
}

// Score one legal move from `view`. Higher = better. The structural core: prefer "clean" groups
// (don't fragment a straight to play a pair), shed more cards, save high/control cards. On top of
// that, strategicAdj() layers role/cooperation logic.
function scoreMove(view, move, level, rng, tempo = 0) {
  if (move.ranks.length === view.handRanks.length) return 1e6 - move.rank; // empties the hand → win
  const groupsBefore = minSplit(view.counts);
  const groupsAfter = minSplit(removeRanks(view.counts, move.ranks));
  const frag = (groupsAfter + 1) - groupsBefore;          // 0 = clean group, >0 = broke structure
  let s = 0;
  s -= frag * 26;
  s += move.ranks.length * 2;                              // efficiency: shed more per play
  s -= controlCost(move) * 5;
  s -= move.rank * 0.5;                                    // all else equal, save higher cards
  s += strategicAdj(view, move, tempo);
  if (level === 0) s += (rng() - 0.5) * 160;              // 新手 plays erratically
  return s;
}
// `tempo` (heuristic levels only) is the value of SEIZING the lead from an opponent — it lets you
// start dumping. 0 = the original conservative behavior (used inside Monte-Carlo rollouts so level-2
// is unchanged); the live level-0/1 default is set below.
function strategicAdj(view, move, tempo = 0) {
  let adj = 0;
  const following = view.against != null;
  if (following) {
    const lsRole = view.leadSeat === view.landlord ? 1 : 0;
    if (view.role === 0 && lsRole === 0 && view.leadSeat !== view.seat) {
      adj -= 120;                                          // partner (a peasant) is winning the trick — don't trump them
    } else {
      const threat = view.handCounts[view.leadSeat];       // an opponent leads; punish them if they're closing out
      if (threat <= 5) adj += (6 - threat) * 18;
      if (tempo && move.type !== COMBO.BOMB && move.type !== COMBO.ROCKET) {
        adj += tempo;                                      // contest the lead with non-bomb plays (bombs stay hoarded)
        if (view.handRanks.length <= 8) adj += (9 - view.handRanks.length) * 1.2; // closing in → the lead is worth more
      }
    }
  } else {
    if (view.handRanks.length > 8) adj -= controlCost(move); // early game: hoard control even harder
    if (view.role === 0 && view.partner >= 0 && view.handCounts[view.partner] < view.handCounts[view.landlord]
        && move.type === COMBO.SINGLE && move.rank < 15) adj += 6; // feed a partner who's ahead with low singles
  }
  return adj;
}
function passScore(view) {
  let s = 0;
  const lsRole = view.leadSeat === view.landlord ? 1 : 0;
  if (view.role === 0 && lsRole === 0 && view.leadSeat !== view.seat) s += 80; // let partner keep the lead
  return s;
}

// ---- the policy ------------------------------------------------------------
// Pick a move (array of ranks) or null (pass) for `view`. The single decision function used by
// both the live bots and the rollouts.
export function pickMoveRanks(view, level, rng, tempo = 0) {
  const following = view.against != null;
  const all = legalMoves(view.handRanks, view.against);
  // Never break up a 炸弹: drop moves that use only part of a held 4-of-a-kind. The bomb stays whole
  // for its trumping power (a forced lead falls back to the unfiltered set so it's never stuck).
  let moves = all.filter((m) => !splitsBomb(m.ranks, view.counts));
  if (!moves.length && !following) moves = all;
  if (following && moves.length === 0) return null;        // nothing beats the lead → forced pass
  if (level >= 2 && shouldMonteCarlo(view)) {
    try { return monteCarlo(view, moves, following, rng); } catch { /* fall through to heuristic */ }
  }
  let best = null, bestS = following ? passScore(view) : -Infinity;
  for (const m of moves) { const s = scoreMove(view, m, level, rng, tempo); if (s > bestS) { bestS = s; best = m; } }
  return best ? best.ranks : null;
}

// A move "splits" a 炸弹 if it uses 1-3 cards of a rank the hand holds 4 of (a bomb), breaking it up.
function splitsBomb(ranks, counts) {
  const use = {};
  for (const r of ranks) use[r] = (use[r] || 0) + 1;
  for (const r in use) if ((counts[r] || 0) === 4 && use[r] < 4) return true;
  return false;
}

// Run MC only in the back half of the hand (where card-reading decides outcomes and rollouts are
// short/cheap). Early game the heuristic leads are fine and rollouts would be long.
function shouldMonteCarlo(view) {
  const total = view.handCounts.reduce((a, b) => a + b, 0);
  return total <= 17;
}

function monteCarlo(view, moves, following, rng) {
  const ranked = moves.map((m) => ({ m, s: scoreMove(view, m, 1, rng) })).sort((a, b) => b.s - a.s);
  const cands = ranked.slice(0, 4).map((x) => x.m);
  const options = following ? [...cands, null] : cands;
  if (options.length <= 1) return options[0] ? options[0].ranks : null;
  const N = 18;
  let bestOpt = options[0], bestVal = -Infinity;
  for (const opt of options) {
    let sum = 0;
    for (let d = 0; d < N; d++) sum += rolloutAfter(view, determinize(view, rng), opt, rng);
    const avg = sum / N;
    if (avg > bestVal) { bestVal = avg; bestOpt = opt; }
  }
  return bestOpt ? bestOpt.ranks : null;
}

// Deal the outstanding (unseen) cards to the two other seats, sized to their real hand counts.
function determinize(view, rng) {
  const others = [0, 1, 2].filter((s) => s !== view.seat);
  const pool = [];
  for (let r = 3; r <= 17; r++) for (let k = 0; k < view.outstanding[r]; k++) pool.push(r);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const H = []; H[view.seat] = view.handRanks.slice();
  let idx = 0;
  for (const s of others) { const n = view.handCounts[s]; H[s] = pool.slice(idx, idx + n); idx += n; }
  return H;
}

// Apply `opt` as our move from the live lead state, then play the hand out with the level-1
// heuristic for all three seats. Returns +1 if our side wins, −1 otherwise.
function rolloutAfter(view, H, opt, rng) {
  const landlord = view.landlord, mySide = view.role;
  let lead = view.seat === view.leadSeat ? null : view.leadDesc;
  let leadSeat = view.leadSeat, turn = view.seat, passes = 0;
  const sideOf = (seat) => (seat === landlord ? 1 : 0);
  const finish = (winner) => (sideOf(winner) === mySide ? 1 : -1);
  const apply = (seat, ranks) => {
    H[seat] = playFromArr(H[seat], ranks);
    lead = classify(ranks); leadSeat = seat; passes = 0;
  };
  // our chosen option first
  if (opt === null) { passes = 1; turn = (turn + 1) % 3; }
  else { apply(view.seat, opt.ranks); if (H[view.seat].length === 0) return finish(view.seat); turn = (turn + 1) % 3; }
  for (let guard = 0; guard < 400; guard++) {
    const seat = turn;
    const against = seat === leadSeat ? null : lead;
    if (against === null && seat === leadSeat && H[seat].length === 0) return finish(seat);
    const sv = makeSimView(H, seat, against, leadSeat, landlord);
    const ranks = pickMoveRanks(sv, 1, rng);
    if (ranks === null) {
      passes++;
      if (passes >= 2) { lead = null; passes = 0; turn = leadSeat; }
      else turn = (turn + 1) % 3;
      continue;
    }
    apply(seat, ranks);
    if (H[seat].length === 0) return finish(seat);
    turn = (turn + 1) % 3;
  }
  return -1; // shouldn't happen; treat a non-terminating rollout as a loss
}

// ---- public entry points ---------------------------------------------------
// 叫分 (0..3). Strength from control cards + bombs/rocket + how few groups the 17-card hand needs.
export function chooseBid(game, seat, level = 1, rng = Math.random) {
  const ranks = game.hands[seat].map((c) => c.rank);
  const c = countsArr(ranks);
  let s = 0;
  if (c[17]) s += 6;
  if (c[16]) s += 4;
  if (c[16] && c[17]) s += 4;                 // holding the rocket is huge
  s += c[15] * 3;                             // 2s
  for (let r = 3; r <= 15; r++) if (c[r] === 4) s += 8; // bombs
  s += (11 - minSplit(c)) * 2.2;             // fewer groups = stronger
  if (level === 0) s += (rng() - 0.5) * 10;  // 新手 misjudges
  const call = s >= 17 ? 3 : s >= 11 ? 2 : s >= 6 ? 1 : 0;
  return Math.max(0, Math.min(3, call));
}

// Heuristic tempo (levels 0/1): how keenly the bot contests an opponent's lead. 0 was the original
// over-cautious behavior; this value was chosen by paired self-play (see test/doudizhu-ai-check). It
// is NOT used inside the level-2 Monte-Carlo (rollouts pass tempo 0), so 高手 play is unchanged.
const DEFAULT_TEMPO = 10;

// Choose a play for `seat`. Returns { pass, cardIds } — cardIds are concrete ids from the hand.
// `opts.tempo` overrides the heuristic tempo (exposed so paired self-play can A/B the aggression).
export function chooseMove(game, seat, level = 1, rng = Math.random, opts = {}) {
  const view = buildView(game, seat);
  const tempo = opts.tempo ?? DEFAULT_TEMPO;
  const ranks = pickMoveRanks(view, level, rng, tempo);
  if (ranks === null) return { pass: true, cardIds: [] };
  const pool = game.hands[seat].slice();
  const cardIds = [];
  for (const r of ranks) { const i = pool.findIndex((card) => card.rank === r); cardIds.push(pool[i].id); pool.splice(i, 1); }
  return { pass: false, cardIds };
}

// Exposed for tests / tuning.
export { minSplit };
