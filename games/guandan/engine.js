// 掼蛋 (Guandan) — pure rules engine. No DOM, fully Node-testable (mirrors the 斗地主 / mahjong
// engines so the rules can be unit-tested headlessly). The UI (main.js) never touches this
// directly; it goes through backend.js. ai.js reuses the combo model + legalMoves() here.
//
// ── Card model ─────────────────────────────────────────────────────────────
// TWO 54-card decks = 108 cards. Each card { id, rank, suit }:
//   rank: 2..14 (2..10, J=11, Q=12, K=13, A=14), plus 小王(small joker)=16, 大王(big joker)=17
//   suit: 0♠ 1♥ 2♣ 3♦  (jokers carry suit -1)
// There are two physical copies of every ranked card and two of each joker, so a rank can appear
// up to 8 times in the deck (and a 4..8 card 炸弹 is possible).
//
// ── The level card (级牌 / 打几) ────────────────────────────────────────────
// Each round is played at a "level" rank (the host team's grade, 2..14). That rank is the trump:
//   • a single/pair/trip/bomb OF the level rank ranks JUST BELOW the jokers (strength 15) — so when
//     the level is 2, a pair of 2s beats a pair of A.
//   • the two ♥-level cards (Heart suit AND the level rank) are WILDCARDS (逢人配 / 红心级牌): each
//     can stand in for any non-joker card when forming pair/trip/三带二/straight/plate/tube/bomb/
//     straight-flush. A wildcard may also just be played as the heart-level card itself.
// In a sequence (straight/plate/tube) every card — including the level rank — uses its NATURAL order;
// the strength-15 elevation only applies to single/pair/trip/三带二/bomb comparisons.

export const SUITS = ['♠', '♥', '♣', '♦'];
export const HEART = 1;
export const JOKER_S = 16, JOKER_B = 17;
export const isJoker = (r) => r >= 16;

export function rankLabel(r) {
  if (r <= 10) return String(r);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 16: '小王', 17: '大王' }[r] || String(r);
}

// A card's comparison strength for single/pair/trip/bomb purposes, given the round's level rank.
// The level rank floats to 15 (just under the jokers); jokers stay 16/17; everything else natural.
export function strengthOf(rank, level) {
  if (rank >= 16) return rank;
  if (rank === level) return 15;
  return rank;
}

// Is this card a wildcard this round? (Heart suit + the level rank.)
export function isWild(card, level) { return card.suit === HEART && card.rank === level && card.rank < 16; }

// ---- deck ------------------------------------------------------------------
export function makeDeck() {
  const cards = [];
  let id = 0;
  for (let d = 0; d < 2; d++) {
    for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) cards.push({ id: id++, rank: r, suit: s });
    cards.push({ id: id++, rank: JOKER_S, suit: -1 });
    cards.push({ id: id++, rank: JOKER_B, suit: -1 });
  }
  return cards;
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Sort a hand for stable display: by level-aware strength, then by raw rank, then suit.
export function sortHand(cards, level = 2) {
  return cards.slice().sort((a, b) => strengthOf(a.rank, level) - strengthOf(b.rank, level) || a.rank - b.rank || a.suit - b.suit);
}

// ---- combination model -----------------------------------------------------
export const COMBO = {
  PASS: 'pass',
  SINGLE: 'single', PAIR: 'pair', TRIO: 'trio', TRIO_PAIR: 'triopair', // 单/对/三/三带二
  STRAIGHT: 'straight', PLATE: 'plate', TUBE: 'tube',                  // 顺子(5) / 木板(三连对) / 钢板(二连三)
  BOMB: 'bomb', STRAIGHT_FLUSH: 'flush', JOKER_BOMB: 'jokerbomb',
};
// Which combo types are "bombs" (second category — beat all first-category plays).
const BOMB_TYPES = new Set([COMBO.BOMB, COMBO.STRAIGHT_FLUSH, COMBO.JOKER_BOMB]);
export const isBombType = (t) => BOMB_TYPES.has(t);

// Bomb strength is a single global score so any two bombs compare directly:
//   4-of-a-kind(100s) < 5-of-a-kind(200s) < 同花顺(300s) < 6-bomb(400s) < 7(500s) < 8(600s) < 天王炸(9999)
function bombBase(n) { return n === 4 ? 100 : n === 5 ? 200 : (n - 2) * 100; } // n>=6 → 400,500,600…

// Split a set of cards into wildcards (count) + naturals (non-wild), keeping suit/rank info.
function partition(cards, level) {
  const wild = []; const nat = [];
  for (const c of cards) (isWild(c, level) ? wild : nat).push(c);
  return { wild, nat, w: wild.length };
}
function rankCounts(nat) { const m = new Map(); for (const c of nat) m.set(c.rank, (m.get(c.rank) || 0) + 1); return m; }

// Can `nat` (all one rank) + `w` wilds form n-of-a-kind? Returns the represented rank, or null.
function asNOfKind(nat, w, n, cnt, level) {
  if (nat.length + w !== n) return null;
  if (cnt.size > 1) return null;                 // more than one natural rank → not n-of-a-kind
  if (cnt.size === 0) return (w === n && n <= 2) ? level : null; // two wildcards = a pair of the level rank
  const [rank] = [...cnt.keys()];
  if (isJoker(rank)) return w === 0 ? rank : null; // jokers never take wilds
  return rank;
}

// Fit naturals (+w wilds) into `length` consecutive ranks, each slot holding `slot` cards.
// Returns the best (highest) comparison key = top rank, or null. A is high (10JQKA, top 14); for
// straights A may also be low (A2345, top 5). Tube/plate are natural-ascending only (A high).
function seqFit(cnt, w, slot, length, allowAceLow) {
  const total = totalNat(cnt);
  let best = null;
  const lo0 = allowAceLow ? 1 : 2;
  for (let lo = lo0; lo + length - 1 <= 14; lo++) {
    const ranks = [];
    for (let i = 0; i < length; i++) { const v = lo + i; ranks.push(v === 1 ? 14 : v); } // 1 → A(low)
    let used = 0, fits = true, natCount = 0;
    for (const r of ranks) { const c = cnt.get(r) || 0; if (c > slot) { fits = false; break; } used += slot - c; natCount += c; }
    if (!fits) continue;
    if (natCount !== total) continue;            // some natural lies OUTSIDE the window → not this shape
    if (used !== w) continue;                     // wild budget must be exactly consumed
    const top = lo + length - 1;                 // 5 for A2345, 14 for A-high
    if (best === null || top > best) best = top;
  }
  return best;
}
// Total naturals (ensures the whole multiset is consumed, no stray cards outside the window).
function totalNat(cnt) { let s = 0; for (const c of cnt.values()) s += c; return s; }

// Classify a set of cards into a combo descriptor, or null if it isn't a legal play.
// Descriptor: { type, n, bomb, key, bombScore, name }.
//   key       = comparison key within the same first-category type (level-aware strength / seq top)
//   bombScore = global bomb strength (only for bombs)
export function classify(cards, level) {
  const n = cards.length;
  if (n === 0) return null;
  const { nat, w } = partition(cards, level);
  const cnt = rankCounts(nat);
  const tot = totalNat(cnt);
  const mk = (type, key, name) => ({ type, n, bomb: false, key, name });
  const bomb = (type, bombScore, name) => ({ type, n, bomb: true, bombScore, name });

  // 天王炸 — all four jokers (two 小王 + two 大王).
  if (n === 4 && w === 0 && (cnt.get(JOKER_S) || 0) === 2 && (cnt.get(JOKER_B) || 0) === 2) return bomb(COMBO.JOKER_BOMB, 9999, '天王炸');

  // n-of-a-kind 炸弹 (4..8). Must be checked before non-bomb shapes of the same count.
  if (n >= 4) {
    const r = asNOfKind(nat, w, n, cnt, level);
    if (r != null) return bomb(COMBO.BOMB, bombBase(n) + strengthOf(r, level), `${n}炸`);
  }

  if (n === 1) {
    const r = nat.length ? nat[0].rank : level;  // a lone wildcard plays as the heart-level card
    return mk(COMBO.SINGLE, strengthOf(r, level), '单张');
  }
  if (n === 2) {
    const r = asNOfKind(nat, w, 2, cnt, level);
    if (r != null) return mk(COMBO.PAIR, strengthOf(r, level), '对子');
    return null;
  }
  if (n === 3) {
    const r = asNOfKind(nat, w, 3, cnt, level);
    if (r != null) return mk(COMBO.TRIO, strengthOf(r, level), '三张');
    return null;
  }
  if (n === 5) {
    // 同花顺 (straight flush) — 5 consecutive cards, one suit (wilds adopt the suit).
    const sf = straightFlushKey(nat, w);
    if (sf != null) return bomb(COMBO.STRAIGHT_FLUSH, 300 + sf, '同花顺');
    // 顺子 — 5 consecutive singles (mixed suit ok). seqFit consumes every natural or returns null.
    const straightTop = seqFit(cnt, w, 1, 5, true);
    if (straightTop != null) return mk(COMBO.STRAIGHT, straightTop, '顺子');
    // 三带二 — trip + pair (different ranks).
    const tp = trioPairKey(cnt, w, level, tot);
    if (tp != null) return mk(COMBO.TRIO_PAIR, tp, '三带二');
    return null;
  }
  if (n === 6) {
    // 钢板 (tube) — two consecutive trips, e.g. 333444.
    const tube = seqFit(cnt, w, 3, 2, false);
    if (tube != null) return mk(COMBO.TUBE, tube, '钢板');
    // 木板 (plate) — three consecutive pairs, e.g. 223344.
    const plate = seqFit(cnt, w, 2, 3, false);
    if (plate != null) return mk(COMBO.PLATE, plate, '木板');
    return null;
  }
  return null;
}
// straight-flush key: 5 consecutive same-suit cards (wilds adopt the suit). Returns top rank or null.
function straightFlushKey(nat, w) {
  const suits = new Set(nat.map((c) => c.suit));
  if (suits.size > 1) return null;               // naturals must share one suit (or be all wild)
  return seqFit(rankCounts(nat), w, 1, 5, true);
}
// 三带二: trip rank a + pair rank b (a≠b), wilds filling, all naturals consumed.
function trioPairKey(cnt, w, level, tot) {
  const cands = new Set([...cnt.keys(), level]); // level allows an all-wild group
  let best = null;
  for (const a of cands) {
    if (isJoker(a)) { /* trips of jokers impossible (≤2 copies + no wild) */ }
    const na = cnt.get(a) || 0; if (na > 3) continue;
    for (const b of cands) {
      if (a === b) continue;
      const nb = cnt.get(b) || 0; if (nb > 2) continue;
      if (isJoker(a) && na < 3) continue;        // can't wild-fill a joker trip
      if (na + nb !== tot) continue;             // every natural must land in the trip or the pair
      const deficit = (3 - na) + (2 - nb);
      if (deficit < 0 || deficit > w) continue;
      const key = strengthOf(a, level);
      if (best === null || key > best) best = key;
    }
  }
  return best;
}

// Does `cur` beat `prev` (descriptors, or prev=null for a free lead)?
export function beats(cur, prev) {
  if (!cur) return false;
  if (!prev) return true;
  if (cur.bomb && prev.bomb) return cur.bombScore > prev.bombScore;
  if (cur.bomb && !prev.bomb) return true;
  if (!cur.bomb && prev.bomb) return false;
  return cur.type === prev.type && cur.n === prev.n && cur.key > prev.key; // same first-category shape, higher key
}

// ---- legal move generation -------------------------------------------------
// All legal plays from `hand` (card objects) that beat `against` (descriptor or null). Returns
// [{ ...descriptor, cardIds }]. Used by ai.js and to validate human plays. Wild-aware.
export function legalMoves(hand, against, level) {
  const out = [];
  const seen = new Set();
  const wilds = hand.filter((c) => isWild(c, level));
  const W = wilds.length;
  const nat = hand.filter((c) => !isWild(c, level));
  // rank -> list of natural card objects of that rank (jokers included as ranks 16/17)
  const byRank = new Map();
  for (const c of nat) { if (!byRank.has(c.rank)) byRank.set(c.rank, []); byRank.get(c.rank).push(c); }
  const ranksAsc = [...byRank.keys()].sort((a, b) => a - b);
  const natRanks = ranksAsc.filter((r) => r < 16);
  const cntOf = (r) => (byRank.get(r) || []).length;

  const add = (cardIds, useWild = 0) => {
    const cards = cardIds.map((id) => hand.find((c) => c.id === id));
    const d = classify(cards, level);
    if (!d || !beats(d, against)) return;
    const key = d.type + ':' + cardIds.slice().sort((a, b) => a - b).join(',');
    if (seen.has(key)) return; seen.add(key);
    out.push({ ...d, cardIds });
  };
  // take k naturals of rank r (ids); returns null if not enough.
  const takeNat = (r, k) => { const a = byRank.get(r) || []; return a.length >= k ? a.slice(0, k).map((c) => c.id) : null; };
  const wildIds = (k) => wilds.slice(0, k).map((c) => c.id);

  // ---- 天王炸 ----
  if (cntOf(JOKER_S) >= 2 && cntOf(JOKER_B) >= 2) add([...takeNat(JOKER_S, 2), ...takeNat(JOKER_B, 2)]);
  // ---- n-of-a-kind 炸弹 (rank 2..A; wilds may extend) ----
  for (const r of natRanks) {
    const have = cntOf(r);
    for (let s = Math.max(4, 4); s <= Math.min(8, have + W); s++) {
      if (have < 1 && s > W) break;
      const useNat = Math.min(have, s);
      const useW = s - useNat;
      if (useW > W) continue;
      const ids = takeNat(r, useNat); if (!ids && useNat > 0) continue;
      add([...(ids || []), ...wildIds(useW)]);
    }
  }
  // If we only need to beat a bomb/rocket, sequence-flush + jokerbomb above are the meaningful
  // options; bombs already generated. Still allow straight-flushes (done below) to top a small bomb.
  // ---- 同花顺 (straight flush) ----
  for (let lo = 1; lo + 4 <= 14; lo++) {
    const ranks = []; for (let i = 0; i < 5; i++) { const v = lo + i; ranks.push(v === 1 ? 14 : v); }
    for (let suit = 0; suit < 4; suit++) {
      const ids = []; let need = 0, ok = true;
      for (const r of ranks) {
        const card = nat.find((c) => c.rank === r && c.suit === suit && !ids.includes(c.id));
        if (card) ids.push(card.id); else need++;
      }
      if (need > W || !ok) continue;
      add([...ids, ...wildIds(need)]);
    }
  }

  if (against && against.bomb) { return out; } // only bombs/flushes/jokerbomb can beat a bomb

  // ---- singles / pairs / trios (+ joker pairs) ----
  for (const r of ranksAsc) {
    const have = cntOf(r);
    if (have >= 1) add(takeNat(r, 1));                              // single
    if (have >= 2) add(takeNat(r, 2));                              // natural pair (incl. joker pair)
    if (r < 16) {
      if (have >= 1 && W >= 1) add([...takeNat(r, 1), ...wildIds(1)]); // pair via wild
      if (have >= 3) add(takeNat(r, 3));                            // natural trip
      if (have >= 2 && W >= 1) add([...takeNat(r, 2), ...wildIds(1)]); // trip via 1 wild
      if (have >= 1 && W >= 2) add([...takeNat(r, 1), ...wildIds(2)]); // trip via 2 wilds
    }
  }
  if (W >= 1) add(wildIds(1)); // a lone wildcard as a single (= the heart-level card)
  if (W >= 2) add(wildIds(2)); // pair of two wildcards (= pair of the level rank)

  // ---- 三带二 (trip a + pair b, a≠b) ----
  const tripRanks = natRanks.filter((r) => cntOf(r) + W >= 3);
  const pairRanks = natRanks.filter((r) => cntOf(r) + W >= 2);
  for (const a of tripRanks) {
    const da = Math.max(0, 3 - cntOf(a));
    const aIds = [...takeNat(a, Math.min(3, cntOf(a))) || [], ...wildIds(da)];
    for (const b of pairRanks) {
      if (b === a) continue;
      const db = Math.max(0, 2 - cntOf(b));
      if (da + db > W) continue;
      const bIds = [...takeNat(b, Math.min(2, cntOf(b))) || [], ...wilds.slice(da, da + db).map((c) => c.id)];
      add([...aIds, ...bIds]);
    }
  }
  // ---- 顺子 (5 consecutive singles, A high or low) ----
  genSequence(1, 5, true, natRanks, cntOf, takeNat, wilds, W, add);
  // ---- 木板 (3 consecutive pairs) ----
  genSequence(2, 3, false, natRanks, cntOf, takeNat, wilds, W, add);
  // ---- 钢板 (2 consecutive trips) ----
  genSequence(3, 2, false, natRanks, cntOf, takeNat, wilds, W, add);

  return out;
}

// Enumerate every consecutive-window sequence move of the given slot/length and emit it.
function genSequence(slot, length, allowAceLow, natRanks, cntOf, takeNat, wilds, W, add) {
  const lo0 = allowAceLow ? 1 : 2;
  for (let lo = lo0; lo + length - 1 <= 14; lo++) {
    const ranks = []; for (let i = 0; i < length; i++) { const v = lo + i; ranks.push(v === 1 ? 14 : v); }
    let need = 0, ok = true; const ids = [];
    for (const r of ranks) {
      const have = Math.min(slot, cntOf(r));
      const got = have > 0 ? takeNat(r, have) : [];
      for (const id of got) ids.push(id);
      need += slot - have;
      if (cntOf(r) > slot && slot === 1) { ok = false; break; } // a straight can't reuse a rank
    }
    if (!ok || need > W) continue;
    // ensure no natural in the hand of these ranks is left unused beyond the slot (handled by Math.min)
    add([...ids, ...wilds.slice(0, need).map((c) => c.id)]);
  }
}

// ---- one round (a single deal → play to completion) ------------------------
export const PHASE = { TRIBUTE: 'tribute', PLAY: 'play', OVER: 'over' };
export const teamOf = (seat) => seat % 2;            // teams: {0,2} vs {1,3}
export const partnerOf = (seat) => (seat + 2) % 4;

export class Round {
  // hands: 4 arrays of card objects (already tribute-resolved). level: trump rank. firstLeader: seat.
  constructor({ hands, level, firstLeader, rng = Math.random }) {
    this.rng = rng;
    this.level = level;
    this.hands = hands.map((h) => sortHand(h, level));
    this.handCounts = this.hands.map((h) => h.length);
    this.phase = PHASE.PLAY;
    this.turn = firstLeader;
    this.lead = null;                 // descriptor to beat (null = free lead)
    this.leadSeat = firstLeader;      // owner of the current lead
    this.lastPlaySeat = firstLeader;  // seat of the most recent actual play
    this.passStreak = 0;
    this.finished = [];               // seats in finishing order (头游 first)
    this.playLog = [];                // { seat, move|null, cardIds }
    this.bombs = 0;
    this.result = null;
  }

  active(seat) { return this.hands[seat].length > 0; }
  _nextActive(seat) { let s = seat; for (let i = 0; i < 4; i++) { s = (s + 1) % 4; if (this.active(s)) return s; } return seat; }

  validate(seat, cardIds) {
    if (this.phase !== PHASE.PLAY || seat !== this.turn) return null;
    const hand = this.hands[seat];
    const chosen = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
    if (chosen.length !== cardIds.length) return null;
    const d = classify(chosen, this.level);
    if (!d) return null;
    const against = seat === this.leadSeat ? null : this.lead;
    if (!beats(d, against)) return null;
    return { ...d, cardIds };
  }

  // Apply a play (cardIds) or a pass (null/empty). Returns true on success.
  play(seat, cardIds) {
    if (this.phase !== PHASE.PLAY || seat !== this.turn) return false;
    const free = seat === this.leadSeat;
    if (!cardIds || cardIds.length === 0) {                 // ---- pass ----
      if (free) return false;                               // the free-leader can't pass
      this.playLog.push({ seat, move: null, cardIds: [] });
      this.passStreak++;
      this._resolveAfterPass();
      return true;
    }
    const d = this.validate(seat, cardIds);                 // ---- play ----
    if (!d) return false;
    const idset = new Set(cardIds);
    this.hands[seat] = this.hands[seat].filter((c) => !idset.has(c.id));
    this.handCounts[seat] = this.hands[seat].length;
    this.playLog.push({ seat, move: d, cardIds });
    if (d.bomb) this.bombs++;
    this.lead = d; this.leadSeat = seat; this.lastPlaySeat = seat; this.passStreak = 0;
    if (this.hands[seat].length === 0) {
      this.finished.push(seat);
      // The round is DECIDED the instant one team has BOTH players out (opponents are 双下, or the
      // 头游's partner has placed, fixing the advancement). End immediately rather than playing on a
      // foregone trick among the two losers.
      if (this.finished.includes(partnerOf(seat))) return this._finish();
    }
    this.turn = this._nextActive(seat);
    return true;
  }

  // After a pass: if every other active player has passed since the last play, the trick is won.
  _resolveAfterPass() {
    const activeCount = [0, 1, 2, 3].filter((s) => this.active(s)).length;
    const leaderActive = this.active(this.lastPlaySeat);
    const need = activeCount - (leaderActive ? 1 : 0);      // how many passes ends the trick
    if (this.passStreak >= need) {
      // trick won by lastPlaySeat. They free-lead; if they've finished, 接风 to their partner.
      let winner = this.lastPlaySeat;
      let leader = winner;
      if (!this.active(winner)) {
        const p = partnerOf(winner);
        leader = this.active(p) ? p : this._nextActive(winner);
      }
      this.lead = null; this.leadSeat = leader; this.lastPlaySeat = leader; this.passStreak = 0; this.turn = leader;
    } else {
      this.turn = this._nextActive(this.turn);
    }
  }

  _finish() {
    // Append everyone still holding cards — fewest first (closest to going out). On an early 双下
    // exit two players remain; their relative order doesn't change the result, only the 三游/末游 tag.
    const rest = [0, 1, 2, 3].filter((s) => !this.finished.includes(s))
      .sort((a, b) => this.hands[a].length - this.hands[b].length);
    for (const s of rest) this.finished.push(s);
    this.phase = PHASE.OVER;
    const order = this.finished.slice();                   // [头游, 二游, 三游, 末游]
    const head = order[0];
    const winTeam = teamOf(head);
    const partnerPos = order.indexOf(partnerOf(head));     // 1,2,3
    const advance = partnerPos === 1 ? 3 : partnerPos === 2 ? 2 : 1;
    this.result = { order, winTeam, advance, partnerPos, bombs: this.bombs };
    return true;
  }
}

// ---- the match (multi-round level ladder + tribute) ------------------------
export class Match {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    const s = opts.state || null;       // resume a saved ladder (between-rounds state)
    this.teamLevel = s ? s.teamLevel.slice() : [2, 2]; // grade per team ({0,2}=team0, {1,3}=team1)
    this.hostTeam = s ? s.hostTeam : (opts.hostTeam ?? 0); // whose grade is the trump this round
    this.lastOrder = s && s.lastOrder ? s.lastOrder.slice() : null; // finishing order of the previous round
    this.round = null;
    this.roundIndex = s ? (s.roundIndex || 0) : 0;
    this.champion = -1;                // winning team once someone clears A
    this.startLevels = null;
  }

  level() { return this.teamLevel[this.hostTeam]; }

  // Serialisable ladder state for save/resume (between-rounds only — NOT mid-round play state).
  toState() { return { teamLevel: this.teamLevel.slice(), hostTeam: this.hostTeam, lastOrder: this.lastOrder ? this.lastOrder.slice() : null, roundIndex: this.roundIndex }; }

  // Deal a fresh round and compute its tribute plan. Returns
  //   { hands, level, tribute:{ pays:[{from,to,card}], antiTribute, doubleDown } | null }
  // The caller resolves tribute (which cards move + the return cards) then calls beginRound().
  deal() {
    this.roundIndex++;
    const level = this.level();
    const deck = shuffle(makeDeck(), this.rng);
    const hands = [0, 1, 2, 3].map((i) => sortHand(deck.slice(i * 27, i * 27 + 27), level));
    const tribute = this._tributePlan(hands, level);
    this._pending = { hands, level, tribute };
    return this._pending;
  }

  // Compute who pays tribute to whom, based on the previous finishing order.
  _tributePlan(hands, level) {
    if (!this.lastOrder) return null;              // round 1 → no tribute
    const order = this.lastOrder;
    const head = order[0], second = order[1], third = order[2], last = order[3];
    const winTeam = teamOf(head);
    const doubleDown = teamOf(second) === winTeam; // winners took 1st & 2nd → losers 双下
    const big = (seat) => hands[seat].filter((c) => c.rank === JOKER_B).length;
    // tribute the biggest card, but the 红心级牌 (wildcard) is exempt by rule — never tributed.
    const topCard = (seat) => {
      const pool = hands[seat].filter((c) => !isWild(c, level));
      return (pool.length ? pool : hands[seat]).slice().sort((a, b) => strengthOf(b.rank, level) - strengthOf(a.rank, level))[0];
    };

    if (doubleDown) {
      // both losers (3rd, 4th) pay; 抗贡 if together they hold both 大王.
      const losers = [third, last];
      if (big(third) + big(last) >= 2) return { antiTribute: true, doubleDown, pays: [] };
      const cards = losers.map((s) => ({ from: s, card: topCard(s) }));
      // larger tribute goes to 头游, the other to 二游
      cards.sort((a, b) => strengthOf(b.card.rank, level) - strengthOf(a.card.rank, level));
      return { doubleDown, antiTribute: false, pays: [
        { from: cards[0].from, to: head, card: cards[0].card },
        { from: cards[1].from, to: second, card: cards[1].card },
      ] };
    }
    // single down — only 末游 pays 头游; 抗贡 if 末游 holds both 大王.
    if (big(last) >= 2) return { antiTribute: true, doubleDown, pays: [] };
    return { doubleDown, antiTribute: false, pays: [{ from: last, to: head, card: topCard(last) }] };
  }

  // Apply resolved tribute. `returns` maps a payer seat -> the card id the receiver gives back.
  // Mutates the dealt hands, then builds the Round with the right opening leader.
  beginRound(returns = {}) {
    const { hands, level, tribute } = this._pending;
    let firstLeader;
    if (!tribute || tribute.antiTribute || tribute.pays.length === 0) {
      firstLeader = this.lastOrder ? this.lastOrder[0] : Math.floor(this.rng() * 4); // 头游 leads (round1 random)
    } else {
      for (const pay of tribute.pays) {
        moveCard(hands, pay.from, pay.to, pay.card.id);
        const back = returns[pay.from];
        if (back != null) moveCard(hands, pay.to, pay.from, back);
      }
      // the payer of the biggest tribute leads
      const lead = tribute.pays.slice().sort((a, b) => strengthOf(b.card.rank, level) - strengthOf(a.card.rank, level))[0];
      firstLeader = lead.from;
    }
    this.round = new Round({ hands, level, firstLeader, rng: this.rng });
    this.startLevels = this.teamLevel.slice();
    return this.round;
  }

  // Settle a finished round: advance the winning team's grade, set the next host, detect a champion.
  settleRound() {
    const r = this.round; if (!r || !r.result) return null;
    const { order, winTeam, advance } = r.result;
    const before = this.teamLevel[winTeam];
    let champion = -1, stayedAtA = false;
    if (before === 14) {
      // To WIN the match FROM A you must get 双上游 (头游+二游); 头游+三游 (advance 2) also counts.
      // Just 头游 with the partner last (advance 1) is NOT enough — the team stays at A and tries again.
      if (advance >= 2) champion = winTeam; else stayedAtA = true;
    } else {
      this.teamLevel[winTeam] = Math.min(14, before + advance);
    }
    this.hostTeam = winTeam;
    this.lastOrder = order.slice();
    this.champion = champion;
    return {
      order, winTeam, advance, champion, stayedAtA,
      teamLevel: this.teamLevel.slice(),
      levelBefore: before, levelAfter: this.teamLevel[winTeam],
    };
  }
}

function moveCard(hands, from, to, id) {
  const i = hands[from].findIndex((c) => c.id === id);
  if (i < 0) return;
  const [card] = hands[from].splice(i, 1);
  hands[to].push(card);
}
