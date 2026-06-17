// Smart card selection for 斗地主 — a DEDICATED, swappable module. Tapping BUILDS the smallest legal
// PATTERN from the selected cards: any valid combo on a free lead, a BEATING combo when following
// (using the supplied legalMoves). So the selection is always something that can actually be played.
//   • tap a card → smallest legal combo containing (current selection + that card); if they don't
//     combine, switch to the smallest legal combo of the tapped card; a card that can't form any
//     playable combo right now is ignored.
//   • tap a selected card → remove just it.
//   • swipe → paint cards on/off directly.
// 串 (straight) tie-break: among same-size straights, prefer the one starting at the lowest selected
// card (so it "starts with" the selected card; otherwise the selected card sits as early as possible).
import { COMBO } from './engine.js';

const partCache = new Map();

// Sort legal moves by preference: smallest first; tie-break by lowest rank, EXCEPT straights, where a
// HIGHER start wins (so the straight begins at/near the selected card → its position stays small).
function costCmp(a, b) {
  return a.size - b.size || (a.type === COMBO.STRAIGHT && b.type === COMBO.STRAIGHT ? b.rank - a.rank : a.rank - b.rank);
}

function countsOf(ranks) { const c = new Array(18).fill(0); for (const r of ranks) c[r]++; return c; }

// Optimal partition of a count-vector into the fewest structural groups. Returns an array of
// groups, each an array of ranks. Memoized on the count-vector (subproblems recur constantly).
function bestPartition(counts) {
  let i = 3; while (i <= 17 && !counts[i]) i++;
  if (i > 17) return [];
  const key = counts.slice(3).join(',');
  const hit = partCache.get(key); if (hit) return hit.map((g) => g.slice());
  if (partCache.size > 200000) partCache.clear();
  let best = null;
  const c = counts.slice();
  const consider = (grp, rest) => { const sub = bestPartition(rest); const cand = [grp, ...sub]; if (!best || cand.length < best.length) best = cand; };
  if (counts[16] && counts[17]) { c[16]--; c[17]--; consider([16, 17], c); c[16]++; c[17]++; }
  const k = counts[i];
  c[i]--; consider([i], c); c[i]++;                                          // single
  if (k >= 2 && i < 16) { c[i] -= 2; consider([i, i], c); c[i] += 2; }       // pair
  if (k >= 3 && i < 16) { c[i] -= 3; consider([i, i, i], c); c[i] += 3; }    // trio
  if (k >= 4 && i < 16) { c[i] -= 4; consider([i, i, i, i], c); c[i] += 4; } // bomb
  if (i <= 14) { let L = 0; for (let r = i; r <= 14 && counts[r] >= 1; r++) { L++; if (L >= 5) { const g = []; for (let x = i; x < i + L; x++) { c[x]--; g.push(x); } consider(g, c); for (let x = i; x < i + L; x++) c[x]++; } } }
  if (i <= 14) { let L = 0; for (let r = i; r <= 14 && counts[r] >= 2; r++) { L++; if (L >= 3) { const g = []; for (let x = i; x < i + L; x++) { c[x] -= 2; g.push(x, x); } consider(g, c); for (let x = i; x < i + L; x++) c[x] += 2; } } }
  if (i <= 14) { let L = 0; for (let r = i; r <= 14 && counts[r] >= 3; r++) { L++; if (L >= 2) { const g = []; for (let x = i; x < i + L; x++) { c[x] -= 3; g.push(x, x, x); } consider(g, c); for (let x = i; x < i + L; x++) c[x] += 3; } } }
  partCache.set(key, best);
  return best.map((g) => g.slice());
}

// Map a move's ranks to concrete card ids from the hand, preferring the `prefer` ids for their rank
// (so already-selected / just-tapped cards stay in the selection).
function pickIds(hand, ranks, prefer = []) {
  const pool = hand.slice(); const ids = [];
  const pset = prefer instanceof Set ? prefer : new Set(prefer);
  for (const r of ranks) {
    let i = pool.findIndex((c) => pset.has(c.id) && c.rank === r);
    if (i < 0) i = pool.findIndex((c) => c.rank === r);
    if (i >= 0) { ids.push(pool[i].id); pool.splice(i, 1); }
  }
  return ids;
}
// Multiset superset: does `sup` contain every rank in `sub` with at least its multiplicity?
function supersetOf(sup, sub) {
  const need = new Map();
  for (const r of sub) need.set(r, (need.get(r) || 0) + 1);
  const have = new Map();
  for (const r of sup) have.set(r, (have.get(r) || 0) + 1);
  for (const [r, n] of need) if ((have.get(r) || 0) < n) return false;
  return true;
}

// Decompose a concrete hand into groups of card ids + a card→group lookup.
export function decompose(hand) {
  const groups = bestPartition(countsOf(hand.map((c) => c.rank)));
  const pool = hand.slice();
  const out = [], cardGroup = new Map();
  groups.forEach((grp, gi) => {
    const ids = [];
    for (const r of grp) { const idx = pool.findIndex((c) => c.rank === r); if (idx >= 0) { ids.push(pool[idx].id); pool.splice(idx, 1); } }
    out.push({ ids, ranks: grp }); ids.forEach((id) => cardGroup.set(id, gi));
  });
  return { groups: out, cardGroup };
}

export class SmartSelection {
  constructor() { this.selected = new Set(); this.hand = []; this.legalMoves = []; }
  setHand(hand) { this.hand = hand; }
  // `legalMoves` are the patterns a tap may build toward: all valid combos on a free lead, only the
  // BEATING combos when following (main.js computes legalMoves(hand, against) accordingly).
  setContext({ legalMoves } = {}) { this.legalMoves = legalMoves || []; }
  clear() { this.selected.clear(); }
  has(id) { return this.selected.has(id); }
  get ids() { return [...this.selected]; }
  set(ids) { this.selected = new Set(ids); }
  // paint a single card on/off — the granular op the swipe gesture drives.
  paint(id, on) { if (on) this.selected.add(id); else this.selected.delete(id); }

  // tap BUILDS the smallest legal pattern from the selection. Tapping a selected card removes it.
  tap(id) {
    if (this.selected.has(id)) { this.selected.delete(id); return; }
    const rankOf = (cid) => this.hand.find((c) => c.id === cid).rank;
    // smallest legal combo containing all `anchorIds`, preferring those exact cards; null if none.
    const combo = (anchorIds) => {
      const ranks = anchorIds.map(rankOf);
      const fits = this.legalMoves.filter((m) => supersetOf(m.ranks, ranks)).sort(costCmp);
      return fits.length ? pickIds(this.hand, fits[0].ranks, anchorIds) : null;
    };
    // build on the existing selection (selected + new); else switch to the new card's own combo;
    // if the card can't form any playable combo, ignore the tap (selection stays valid).
    const next = (this.selected.size && combo([...this.selected, id])) || combo([id]);
    if (next) this.selected = new Set(next);
  }
}
