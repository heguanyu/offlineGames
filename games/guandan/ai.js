// 掼蛋 AI. Pure, no DOM, Node-testable. Built on engine.js's legalMoves()/classify().
//
// Difficulty tiers:
//   level 0 (新手)  — the heuristic with heavy noise; erratic, over-eager.
//   level 1 (普通)  — the full heuristic: a WILD-AWARE fewest-plays hand value, a steep card-cost
//                     curve (cheap to spend 2..J, dear to spend the trump/jokers/bombs), an
//                     initiative (tempo) term so it actively contests opponents' leads, and 队友
//                     cooperation (let a winning partner keep the lead; race to go out after 接风).
//   level 2 (高手)  — same model, a touch sharper (fights harder for the lead, conserves control
//                     a hair more). No Monte-Carlo (27-card 4-hand rollouts are too costly offline).
//
// Design note: an earlier version passed ~60% of the time even when it held a non-bomb beat — it
// gave taking a trick no value and over-charged every card. This version prices cards by a steep
// curve so LOW cards are nearly free to spend (you must shed them anyway) while the trump / jokers /
// bombs stay precious, and adds a tempo term — so the bot grabs cheap leads but still hoards control.
import { legalMoves, classify, COMBO, isBombType, isWild, teamOf, partnerOf, strengthOf, JOKER_S, JOKER_B } from './engine.js';

// ---- fewest-plays hand value (the decomposition engine) --------------------
// "How few separate plays can empty this hand?" — the dominant strength signal. minSplit() counts
// the structural Guandan groups (single/pair/trip/bomb/顺子/木板/钢板) over a count-vector of
// NATURAL cards. handPlays() wraps it to be WILD-AWARE: each ♥-level wildcard is assigned to the
// rank that minimises the play count (逢人配 — it fills the cheapest gap), instead of being frozen
// at the level rank. This is what lets the bot value "what a play leaves behind" correctly.
const splitCache = new Map();
function minSplit(counts) {
  let i = 2; while (i <= 17 && !counts[i]) i++;
  if (i > 17) return 0;
  const key = counts.join(',');
  const hit = splitCache.get(key); if (hit !== undefined) return hit;
  if (splitCache.size > 300000) splitCache.clear();
  let best = Infinity;
  const c = counts.slice();
  const k = counts[i];
  c[i]--; best = Math.min(best, 1 + minSplit(c)); c[i]++;                          // single
  if (k >= 2) { c[i] -= 2; best = Math.min(best, 1 + minSplit(c)); c[i] += 2; }    // pair
  if (k >= 3 && i < 16) { c[i] -= 3; best = Math.min(best, 1 + minSplit(c)); c[i] += 3; } // trip
  for (let s = 4; s <= 8 && k >= s && i < 16; s++) { c[i] -= s; best = Math.min(best, 1 + minSplit(c)); c[i] += s; } // bomb
  if (i <= 10) {                                                                    // 顺子 (5 consecutive)
    let ok = true; for (let r = i; r < i + 5; r++) if (!counts[r]) { ok = false; break; }
    if (ok) { for (let r = i; r < i + 5; r++) c[r]--; best = Math.min(best, 1 + minSplit(c)); for (let r = i; r < i + 5; r++) c[r]++; }
  }
  if (i <= 12) {                                                                    // 木板 (3 consecutive pairs)
    let ok = true; for (let r = i; r < i + 3; r++) if (counts[r] < 2) { ok = false; break; }
    if (ok) { for (let r = i; r < i + 3; r++) c[r] -= 2; best = Math.min(best, 1 + minSplit(c)); for (let r = i; r < i + 3; r++) c[r] += 2; }
  }
  if (i <= 13) {                                                                    // 钢板 (2 consecutive trips)
    let ok = true; for (let r = i; r < i + 2; r++) if (counts[r] < 3) { ok = false; break; }
    if (ok) { for (let r = i; r < i + 2; r++) c[r] -= 3; best = Math.min(best, 1 + minSplit(c)); for (let r = i; r < i + 2; r++) c[r] += 3; }
  }
  splitCache.set(key, best);
  return best;
}
// Wild-aware: assign each wildcard to the rank that minimises the play count, then decompose.
const playsCache = new Map();
function handPlays(counts, wild) {
  if (wild <= 0) return minSplit(counts);
  const key = counts.join(',') + '|' + wild;
  const hit = playsCache.get(key); if (hit !== undefined) return hit;
  if (playsCache.size > 200000) playsCache.clear();
  let best = Infinity;
  for (let r = 2; r <= 14; r++) { counts[r]++; best = Math.min(best, handPlays(counts, wild - 1)); counts[r]--; }
  playsCache.set(key, best);
  return best;
}
// Split a card list into a NATURAL count-vector + a wildcard count.
function decompose(cards, level) {
  const c = new Array(18).fill(0); let w = 0;
  for (const x of cards) { if (isWild(x, level)) w++; else c[x.rank]++; }
  return { counts: c, wild: w };
}
function countsOf(cards) { const c = new Array(18).fill(0); for (const x of cards) c[x.rank]++; return c; }
function removeCounts(counts, cardIds, hand) {
  const c = counts.slice();
  for (const id of cardIds) { const card = hand.find((h) => h.id === id); if (card) c[card.rank]--; }
  return c;
}

// ---- decision view ---------------------------------------------------------
function buildView(round, seat) {
  const hand = round.hands[seat];
  return {
    seat, hand, level: round.level,
    against: seat === round.leadSeat ? null : round.lead,
    leadSeat: round.leadSeat, lead: round.lead,
    team: teamOf(seat), partner: partnerOf(seat),
    handCounts: round.handCounts.slice(), finished: round.finished.slice(),
  };
}

// ---- card / bomb pricing ---------------------------------------------------
// A STEEP curve: 2..J are nearly free to spend (you must shed them anyway), Q/K/A cost a little,
// and the trump rank / jokers are dear (true control — hoard them). This is the lever that makes the
// bot contest cheap leads while still refusing to burn its big cards on nothing.
// The curve is steep AND control-protecting: 2..J are nearly free, Q/K/A cost a little, but the
// trump rank / jokers / wildcards are priced ABOVE the tempo bonus so the bot won't dump them on a
// trivial lead — only the closing/threat bonuses (endgame, or stopping an opponent) push it to spend
// them. So it's aggressive with cheap cards yet conserves true control, which reads as smart play.
function cardPrice(card, level) {
  if (isWild(card, level)) return 42;
  if (card.rank === JOKER_B) return 54;
  if (card.rank === JOKER_S) return 44;
  if (card.rank === level) return 42;           // the trump rank
  if (card.rank === 14) return 6;               // A
  if (card.rank === 13) return 3;               // K
  if (card.rank === 12) return 1.4;             // Q
  return 0.25;                                   // 2..J — basically free
}
function handPrice(view, move) {
  let p = 0;
  for (const id of move.cardIds) { const c = view.hand.find((h) => h.id === id); if (c) p += cardPrice(c, view.level); }
  return p;
}
function bombCost(move) {
  if (move.type === COMBO.JOKER_BOMB) return 64;
  if (move.type === COMBO.STRAIGHT_FLUSH) return 24;
  return 16 + (move.n - 4) * 5;                  // bigger bombs are dearer still
}
// Does the move break up a would-be 炸弹 (use part of a rank held ≥4 times, while not being a bomb)?
function splitsBomb(view, move) {
  const c = countsOf(view.hand);
  const use = {};
  for (const id of move.cardIds) { const card = view.hand.find((h) => h.id === id); if (card) use[card.rank] = (use[card.rank] || 0) + 1; }
  if (isBombType(move.type)) return false;
  for (const r in use) if (c[r] >= 4 && use[r] < c[r] && use[r] < 4) return true;
  return false;
}

// ---- move scoring ----------------------------------------------------------
// score(playing this move) vs the pass baseline (0 when following an opponent; −∞ when leading, so
// the leader must act). Higher = better.
// Value of seizing the lead from an opponent. At 40 ≈ 80% of leads get contested (lively play), yet
// it sits BELOW the trump/joker prices (42+) so the bot still won't dump true control on a big hand —
// only the closing / stop-a-threat bonuses push it to spend those. Aggressive AND control-aware.
const TEMPO = 40;
function scoreMove(view, move, baseCounts, baseWild, basePlays, level, rng, tempo) {
  const n = move.cardIds.length;
  if (n === view.hand.length) return 1e6;                    // empties the hand → win
  // plays left AFTER this move (wild-aware): the structural cost.
  const ac = baseCounts.slice(); let aw = baseWild;
  for (const id of move.cardIds) { const c = view.hand.find((h) => h.id === id); if (isWild(c, view.level)) aw--; else ac[c.rank]--; }
  const after = handPlays(ac, aw);
  const frag = (after + 1) - basePlays;                      // 0 = clean group, >0 = broke a sequence/structure
  let s = -frag * 26 + n * 1.5;                              // reward clean groups + shedding cards
  s -= move.bomb ? bombCost(move) : handPrice(view, move);   // spend cheap cards freely, hoard control/bombs
  s += strategicAdj(view, move, n, tempo);
  if (level === 0) s += (rng() - 0.5) * 120;
  return s;
}
function strategicAdj(view, move, n, tempo) {
  const following = view.against != null;
  let adj = 0;
  if (following) {
    if (view.leadSeat === view.partner) return -300;          // never trump a partner who's winning (cooperation handled earlier)
    const oppLeft = view.handCounts[view.leadSeat];
    const myLeft = view.hand.length;
    if (!move.bomb) {
      adj += tempo;                                           // TEMPO: seizing the lead lets us start dumping
      if (myLeft <= 12) adj += (13 - myLeft) * 1.5;           // closing in → the lead is worth more; spend more freely
    }
    if (oppLeft <= 6) adj += (7 - oppLeft) * 9;               // stop/punish a closing opponent (incl. with a bomb)
    if (move.bomb && oppLeft > 7 && myLeft > 12) adj -= 50;   // but don't burn a bomb early on a non-threat
  } else {                                                     // free lead
    if (view.finished.includes(view.partner)) adj += n * 2;   // partner is out (接风) → unload fast
    if (move.bomb) adj -= 60;                                 // don't open with a bomb
  }
  return adj;
}

// ---- the policy ------------------------------------------------------------
export function chooseMove(round, seat, level = 1, rng = Math.random, opts = {}) {
  const tempo = opts.tempo ?? TEMPO;                          // exposed so self-play can A/B the aggression
  const view = buildView(round, seat);
  const following = view.against != null;
  const all = legalMoves(view.hand, view.against, view.level);
  if (all.length === 0) return { pass: true, cardIds: [] };

  // Always take a hand-emptying play (go out) if available.
  const out = all.find((m) => m.cardIds.length === view.hand.length);
  if (out) return { pass: false, cardIds: out.cardIds };

  // Prefer not to fracture a 炸弹 when a cleaner option exists.
  let moves = all.filter((m) => !splitsBomb(view, m));
  if (!moves.length) moves = all;

  // Cooperation: if the partner currently holds the lead, pass (we already took any go-out above).
  if (following && view.leadSeat === view.partner && level >= 1) return { pass: true, cardIds: [] };

  const { counts, wild } = decompose(view.hand, view.level);
  const basePlays = handPlays(counts, wild);
  let best = null, bestS = following ? 0 : -Infinity;        // opponent-lead pass baseline = 0; a leader must act
  for (const m of moves) { const s = scoreMove(view, m, counts, wild, basePlays, level, rng, tempo); if (s > bestS) { bestS = s; best = m; } }
  if (!best) return { pass: true, cardIds: [] };
  return { pass: false, cardIds: best.cardIds };
}

// Order all legal plays for the human's 提示 button. Structurally CLEAN plays come first (it never
// suggests breaking a 顺子/木板/钢板 or splitting a 炸弹 ahead of a clean alternative), whole bombs
// last. Uses the same wild-aware fragmentation signal the bots score on.
export function orderedHints(hand, against, level) {
  const moves = legalMoves(hand, against, level);
  const { counts, wild } = decompose(hand, level);
  const before = handPlays(counts, wild);
  const view = { hand, level };
  for (const m of moves) {
    const ac = counts.slice(); let aw = wild;
    for (const id of m.cardIds) { const c = hand.find((h) => h.id === id); if (isWild(c, level)) aw--; else ac[c.rank]--; }
    m._frag = (handPlays(ac, aw) + 1) - before;
    m._rank = (m.bomb ? 2 : 0) + (splitsBomb(view, m) ? 1 : 0);
  }
  return moves.sort((a, b) => a._rank - b._rank || a._frag - b._frag || a.n - b.n || (a.key || 0) - (b.key || 0));
}

// ---- "cleanest beat" for the human's auto-selection ------------------------
// minSplit/handPlays count GROUPS, so carving a single out of a trip (999→9) or a card out of a
// 顺子 is "free" (group count is unchanged) — which is why the auto-pick would split JJJ999 into
// JJJ99. To fix the human's default suggestion we instead decompose the hand into its best groups
// and prefer the beat that BREAKS the least structure (bigger groups weighted more). This does NOT
// touch the win-rate-tuned bot policy — only what we pre-select for the human.
const partCache = new Map();
function partitionCounts(counts) {
  let i = 2; while (i <= 17 && !counts[i]) i++;
  if (i > 17) return [];
  const key = counts.join(',');
  const hit = partCache.get(key); if (hit) return hit.map((g) => g.slice());
  if (partCache.size > 120000) partCache.clear();
  let best = null;
  const c = counts.slice();
  const consider = (grp) => { const sub = partitionCounts(c); const cand = [grp, ...sub]; if (!best || cand.length < best.length) best = cand; };
  // Try the most structural groups first so ties keep big shapes whole (min-count already favors them).
  for (let s = Math.min(8, counts[i]); s >= 4 && i < 16; s--) { for (let x = 0; x < s; x++) c[i]--; consider(Array(s).fill(i)); for (let x = 0; x < s; x++) c[i]++; }
  if (i <= 10) { let ok = true; for (let r = i; r < i + 5; r++) if (!counts[r]) { ok = false; break; } if (ok) { const g = []; for (let r = i; r < i + 5; r++) { c[r]--; g.push(r); } consider(g); for (let r = i; r < i + 5; r++) c[r]++; } } // 顺子
  if (i <= 13) { let ok = true; for (let r = i; r < i + 2; r++) if (counts[r] < 3) { ok = false; break; } if (ok) { const g = []; for (let r = i; r < i + 2; r++) { c[r] -= 3; g.push(r, r, r); } consider(g); for (let r = i; r < i + 2; r++) c[r] += 3; } } // 钢板
  if (i <= 12) { let ok = true; for (let r = i; r < i + 3; r++) if (counts[r] < 2) { ok = false; break; } if (ok) { const g = []; for (let r = i; r < i + 3; r++) { c[r] -= 2; g.push(r, r); } consider(g); for (let r = i; r < i + 3; r++) c[r] += 2; } } // 木板
  if (counts[i] >= 3 && i < 16) { c[i] -= 3; consider([i, i, i]); c[i] += 3; }
  if (counts[i] >= 2 && i < 16) { c[i] -= 2; consider([i, i]); c[i] += 2; }
  c[i]--; consider([i]); c[i]++;
  partCache.set(key, best);
  return best.map((g) => g.slice());
}
// Best partition of a hand into groups of CARD IDS (naturals only; wildcards are spare, never "split").
function bestPartition(cards, level) {
  const nat = cards.filter((c) => !isWild(c, level));
  const counts = new Array(18).fill(0); for (const c of nat) counts[c.rank]++;
  const pool = nat.slice(); const out = [];
  for (const grp of partitionCounts(counts)) {
    const ids = [];
    for (const r of grp) { const i = pool.findIndex((c) => c.rank === r); if (i >= 0) { ids.push(pool[i].id); pool.splice(i, 1); } }
    out.push(ids);
  }
  return out;
}
// How much a move breaks the hand's structure: for each group it uses SOME-BUT-NOT-ALL of, add the
// group's size (so splitting a 5-card 顺子 hurts more than a 3-card trip, which hurts more than a pair).
function splitCost(cardIds, groups) {
  const used = new Set(cardIds);
  let cost = 0;
  for (const g of groups) { let u = 0; for (const id of g) if (used.has(id)) u++; if (u > 0 && u < g.length) cost += g.length; }
  return cost;
}
// The cleanest legal beat of the given type/size (the bot's chosen shape): least structure broken,
// then fewest cards, then non-bomb, then lowest card. Returns cardIds, or null if there are no beats.
export function cleanestBeat(hand, against, level, type = null, size = null) {
  const all = legalMoves(hand, against, level);
  if (!all.length) return null;
  let moves = type ? all.filter((m) => m.type === type && (size == null || m.n === size)) : all;
  if (!moves.length) moves = all;
  const groups = bestPartition(hand, level);
  moves.sort((a, b) => splitCost(a.cardIds, groups) - splitCost(b.cardIds, groups) || a.n - b.n || (a.bomb ? 1 : 0) - (b.bomb ? 1 : 0) || (a.key || 0) - (b.key || 0));
  return moves[0].cardIds;
}

// Tribute return — give back the lowest card (rank ≤ 10 by the rules; else the lowest held).
export function chooseTributeReturn(hand, level) {
  const eligible = hand.filter((c) => c.rank <= 10);
  const pool = eligible.length ? eligible : hand;
  return pool.slice().sort((a, b) => strengthOf(a.rank, level) - strengthOf(b.rank, level))[0].id;
}

export { minSplit, handPlays };
