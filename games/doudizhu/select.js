// Smart card selection for 斗地主 — a DEDICATED, swappable module so the selection UX can be
// upgraded independently of the renderer/controller. The strategy here:
//
//   • tap an unselected card → select the whole NATURAL GROUP it belongs to, where "natural" is
//     the card's role in the hand's fewest-hands decomposition (tap a card in a pair → the pair;
//     in a trio → the trio; in a straight → the straight; a lone card → just it).
//   • tap a selected card → remove just that one card (refine the group down).
//   • swipe across cards → range-select exactly the swept cards (great for straights / custom combos).
//
// The decomposition is the optimal partition (same shape as ai.js's minSplit, but returning the
// actual groups), so "tap = the combo this card is part of" matches how a human reads their hand.
// Future upgrades (e.g. context-aware grouping vs the current lead, multi-tap cycling) live here.

const partCache = new Map();

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
  constructor() { this.selected = new Set(); this.hand = []; this._dec = { groups: [], cardGroup: new Map() }; this.following = false; this.legalMoves = []; }
  setHand(hand) { this.hand = hand; this._dec = decompose(hand); }
  // Context for context-aware taps: when `following` a lead, a tap selects a PLAYABLE combo
  // (one of `legalMoves`) rather than the raw decomposition group.
  setContext({ following, legalMoves } = {}) { this.following = !!following; this.legalMoves = legalMoves || []; }
  clear() { this.selected.clear(); }
  has(id) { return this.selected.has(id); }
  get ids() { return [...this.selected]; }
  set(ids) { this.selected = new Set(ids); }
  // paint a single card on/off — the granular op the swipe gesture drives.
  paint(id, on) { if (on) this.selected.add(id); else this.selected.delete(id); }

  tap(id) { if (this.following) this._tapPlayable(id); else this._groupToggle(id); }

  // leading: tap toggles the card's natural decomposition group; tapping a selected card refines it down.
  _groupToggle(id) {
    if (this.selected.has(id)) { this.selected.delete(id); return; }
    const grp = this._dec.groups[this._dec.cardGroup.get(id)];
    if (grp) grp.ids.forEach((x) => this.selected.add(x)); else this.selected.add(id);
  }
  // following: tapping a card BUILDS on the current selection.
  //  • tap a selected card → remove just it (refine down)
  //  • first card (empty selection) → auto-complete to the smallest legal combo using it
  //  • cards already selected → the smallest legal combo containing ALL selected cards + the new one
  //    (the selection isn't thrown away); if none fits, the new card is just added so the player can
  //    keep building, and 出牌 validates the result.
  _tapPlayable(id) {
    if (this.selected.has(id)) { this.selected.delete(id); return; }
    const rankOf = (cid) => this.hand.find((c) => c.id === cid).rank;
    const byCost = (a, b) => a.size - b.size || a.rank - b.rank;
    if (this.selected.size === 0) {
      const cands = this.legalMoves.filter((m) => m.ranks.includes(rankOf(id))).sort(byCost);
      this.selected = new Set(cands.length ? pickIds(this.hand, cands[0].ranks, [id]) : [id]);
      return;
    }
    const anchors = [...this.selected, id];
    const anchorRanks = anchors.map(rankOf);
    const build = this.legalMoves.filter((m) => supersetOf(m.ranks, anchorRanks)).sort(byCost);
    this.selected = build.length ? new Set(pickIds(this.hand, build[0].ranks, anchors)) : new Set(anchors);
  }
}
