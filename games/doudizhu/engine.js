// 斗地主 (Dou Dizhu) — pure rules engine. No DOM, fully Node-testable (mirrors the
// mahjong engine's split so the rules can be unit-tested headlessly). The UI (main.js)
// never touches this directly; it goes through backend.js. ai.js reuses the combo model
// and legalMoves() here.
//
// Card model: a 54-card deck. Rank is the only thing that matters for combinations;
// suit is carried only so the renderer can draw distinct cards.
//   ranks: 3,4,5,6,7,8,9,10,J,Q,K,A,2 → 3..15, plus 小王(black joker)=16, 大王(red joker)=17
// Order of strength: 3 < 4 < … < A(14) < 2(15) < 小王(16) < 大王(17).

export const RANK = { MIN: 3, J: 11, Q: 12, K: 13, A: 14, TWO: 15, JOKER_S: 16, JOKER_B: 17 };
export const SUITS = ['♠', '♥', '♣', '♦']; // s,h,c,d — irrelevant to play, only for art

// Display label for a rank.
export function rankLabel(r) {
  if (r <= 10) return String(r);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' }[r];
}
export const isJoker = (r) => r >= 16;

// ---- deck -----------------------------------------------------------------
// 52 ranked cards (ranks 3..15 across 4 suits) + 2 jokers. Each card has a stable id
// 0..53 so the renderer can key persistent meshes, like the mahjong tiles.
export function makeDeck() {
  const cards = [];
  let id = 0;
  for (let r = 3; r <= 15; r++) for (let s = 0; s < 4; s++) cards.push({ id: id++, rank: r, suit: s });
  cards.push({ id: id++, rank: 16, suit: -1 }); // 小王
  cards.push({ id: id++, rank: 17, suit: -1 }); // 大王
  return cards;
}

// Fisher–Yates with an injectable rng (so tests/online can be deterministic).
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- combination model ----------------------------------------------------
export const COMBO = {
  PASS: 'pass',
  SINGLE: 'single', PAIR: 'pair', TRIO: 'trio',
  TRIO_SINGLE: 'trio1', TRIO_PAIR: 'trio2',
  STRAIGHT: 'straight', DOUBLE_STRAIGHT: 'straight2', // 顺子 / 连对
  PLANE: 'plane', PLANE_SINGLE: 'plane1', PLANE_PAIR: 'plane2', // 飞机(纯) / 带单 / 带对
  FOUR_SINGLE: 'four1', FOUR_PAIR: 'four2', // 四带二(单) / 四带两对
  BOMB: 'bomb', ROCKET: 'rocket',
};

// rank → count, as a Map, for an array of ranks.
function countRanks(ranks) {
  const m = new Map();
  for (const r of ranks) m.set(r, (m.get(r) || 0) + 1);
  return m;
}

// Are these ranks a run of `len` consecutive values starting at `lo`, all ≤ A (14)?
// 2s and jokers can never appear in any consecutive sequence.
function isConsecutive(sortedUniq, lo, len) {
  if (sortedUniq.length !== len) return false;
  if (lo + len - 1 > RANK.A) return false;
  for (let i = 0; i < len; i++) if (sortedUniq[i] !== lo + i) return false;
  return true;
}

// Classify a set of ranks into a combo descriptor, or return null if it isn't a legal play.
// Descriptor: { type, rank, len, size } where
//   rank = the comparison key (lead rank: the trio/four/run-start rank, or the single/pair rank),
//   len  = number of links (straight length, #pairs, #trios) for sequence types (else 1),
//   size = card count (only used to disambiguate, e.g. four-with-two singles vs pairs).
export function classify(ranks) {
  const n = ranks.length;
  if (n === 0) return null;
  const cnt = countRanks(ranks);
  const groups = [...cnt.entries()];              // [rank, count]
  const uniq = [...cnt.keys()].sort((a, b) => a - b);

  // Rocket: the two jokers.
  if (n === 2 && cnt.get(16) === 1 && cnt.get(17) === 1) return { type: COMBO.ROCKET, rank: 17, len: 1, size: 2 };
  // Bomb: four of a kind.
  if (n === 4 && groups.length === 1 && groups[0][1] === 4) return { type: COMBO.BOMB, rank: groups[0][0], len: 1, size: 4 };

  // A joker can only ever appear as a lone SINGLE or as half the ROCKET (or as a
  // kicker/wing on someone else's trio/four). It can never form a pair/trio/bomb of
  // its own — there's only one of each joker — so guard the core-group cases below.
  if (n === 1) return { type: COMBO.SINGLE, rank: ranks[0], len: 1, size: 1 };
  if (n === 2 && groups.length === 1 && groups[0][1] === 2 && !isJoker(groups[0][0])) return { type: COMBO.PAIR, rank: groups[0][0], len: 1, size: 2 };
  if (n === 3 && groups.length === 1 && groups[0][1] === 3 && !isJoker(groups[0][0])) return { type: COMBO.TRIO, rank: groups[0][0], len: 1, size: 3 };

  // 三带一 (trio + any single) / 三带二 (trio + a pair)
  if (n === 4) {
    const trio = groups.find((g) => g[1] === 3);
    if (trio && groups.find((g) => g[1] === 1)) return { type: COMBO.TRIO_SINGLE, rank: trio[0], len: 1, size: 4 };
  }
  if (n === 5) {
    const trio = groups.find((g) => g[1] === 3);
    const pair = groups.find((g) => g[1] === 2);
    if (trio && pair && groups.length === 2) return { type: COMBO.TRIO_PAIR, rank: trio[0], len: 1, size: 5 };
  }

  // 顺子 (straight): ≥5 distinct consecutive singles, all count 1, max A.
  if (n >= 5 && groups.every((g) => g[1] === 1) && isConsecutive(uniq, uniq[0], n)) {
    return { type: COMBO.STRAIGHT, rank: uniq[0], len: n, size: n };
  }
  // 连对 (double straight): ≥3 consecutive pairs.
  if (n >= 6 && n % 2 === 0 && groups.every((g) => g[1] === 2) && isConsecutive(uniq, uniq[0], n / 2)) {
    return { type: COMBO.DOUBLE_STRAIGHT, rank: uniq[0], len: n / 2, size: n };
  }

  // 飞机 family: k consecutive trios (k≥2), optionally with k single or k pair "wings".
  const trios = groups.filter((g) => g[1] >= 3).map((g) => g[0]).sort((a, b) => a - b);
  for (let k = trios.length; k >= 2; k--) {
    // try every window of k consecutive trio ranks
    for (let i = 0; i + k <= trios.length; i++) {
      const window = trios.slice(i, i + k);
      if (!isConsecutive(window, window[0], k)) continue;
      const lo = window[0];
      // pure plane
      if (n === 3 * k) {
        if (groups.length === k) return { type: COMBO.PLANE, rank: lo, len: k, size: n };
      }
      // plane + k singles (wings are any k cards outside the trio block; total 4k)
      if (n === 4 * k) {
        const used = new Map(window.map((r) => [r, 3]));
        if (wingsValid(cnt, used, k, 1)) return { type: COMBO.PLANE_SINGLE, rank: lo, len: k, size: n };
      }
      // plane + k pairs (total 5k)
      if (n === 5 * k) {
        const used = new Map(window.map((r) => [r, 3]));
        if (wingsValid(cnt, used, k, 2)) return { type: COMBO.PLANE_PAIR, rank: lo, len: k, size: n };
      }
    }
  }

  // 四带二: a four + two singles, or a four + two pairs.
  const four = groups.find((g) => g[1] === 4);
  if (four) {
    if (n === 6) { // four + 2 singles (kickers may be a pair, that's fine — two single cards)
      const rest = ranks.filter((r) => r !== four[0]);
      if (rest.length === 2) return { type: COMBO.FOUR_SINGLE, rank: four[0], len: 1, size: 6 };
    }
    if (n === 8) { // four + 2 distinct pairs
      const others = groups.filter((g) => g[0] !== four[0]);
      if (others.length === 2 && others.every((g) => g[1] === 2)) return { type: COMBO.FOUR_PAIR, rank: four[0], len: 1, size: 8 };
    }
  }
  return null;
}

// Validate the "wings" of a plane: after removing the `k` trio cards (used map: rank→3),
// the remaining cards must be exactly k wings, each of width `w` (1 single / 2 pair),
// and a wing rank must not coincide with a trio rank (can't reuse the trio's own cards).
// Singles-wings may repeat a rank only up to its leftover count; pair-wings need count≥2.
function wingsValid(cnt, used, k, w) {
  let wings = 0;
  for (const [r, c] of cnt) {
    let left = c - (used.get(r) || 0);
    if (left < 0) return false;
    if (left === 0) continue;
    if (w === 2) { // pair wings: each leftover rank contributes floor(left/2) pairs, must be exact
      if (left % 2 !== 0) return false;
      wings += left / 2;
    } else { // single wings: each leftover card is a wing
      wings += left;
    }
  }
  return wings === k;
}

// Does play `cur` (descriptor) beat `prev` (descriptor, or null = free lead)?
export function beats(cur, prev) {
  if (!cur) return false;
  if (!prev) return true;                              // free lead: any legal combo
  if (cur.type === COMBO.ROCKET) return true;          // 火箭 beats everything
  if (prev.type === COMBO.ROCKET) return false;
  if (cur.type === COMBO.BOMB) {
    if (prev.type === COMBO.BOMB) return cur.rank > prev.rank;
    return true;                                       // bomb beats any non-bomb
  }
  if (prev.type === COMBO.BOMB) return false;          // only a bigger bomb/rocket beats a bomb
  // same type, same shape (length & size), higher lead rank
  if (cur.type !== prev.type || cur.len !== prev.len || cur.size !== prev.size) return false;
  return cur.rank > prev.rank;
}

// ---- legal move generation -------------------------------------------------
// All legal plays from `handRanks` (array of rank numbers) that beat `against` (a descriptor
// or null for a free lead). Returns an array of { type, rank, len, size, ranks } where `ranks`
// is the multiset of rank numbers to play. Used by ai.js and to validate human plays.
// This is the combinatorial heart, so it's written to be exhaustive but pruned.
export function legalMoves(handRanks, against = null) {
  const cnt = countRanks(handRanks);
  const uniq = [...cnt.keys()].sort((a, b) => a - b);
  const has = (r, c) => (cnt.get(r) || 0) >= c;
  const out = [];
  const add = (ranks) => { const d = classify(ranks); if (d && beats(d, against)) out.push({ ...d, ranks }); };

  // ROCKET — always available if held.
  if (has(16, 1) && has(17, 1)) add([16, 17]);
  // BOMBs — every four-of-a-kind.
  for (const r of uniq) if (cnt.get(r) === 4) add([r, r, r, r]);

  // If we only need to beat a bomb/rocket, bombs+rocket above are the only options.
  if (against && (against.type === COMBO.BOMB || against.type === COMBO.ROCKET)) return dedupe(out);

  // Singles, pairs, trios (and trio kickers).
  for (const r of uniq) {
    if (has(r, 1)) add([r]);
    if (has(r, 2)) add([r, r]);
    if (has(r, 3)) {
      add([r, r, r]);
      // trio + single kicker
      for (const k of uniq) if (k !== r && has(k, 1)) add([r, r, r, k]);
      // trio + pair kicker
      for (const k of uniq) if (k !== r && has(k, 2)) add([r, r, r, k, k]);
    }
  }

  // Straights: every consecutive run of length ≥5 among ranks 3..A present as singles.
  const seqRanks = uniq.filter((r) => r <= RANK.A);
  for (let i = 0; i < seqRanks.length; i++) {
    let run = [seqRanks[i]];
    for (let j = i + 1; j < seqRanks.length; j++) {
      if (seqRanks[j] !== run[run.length - 1] + 1) break;
      run.push(seqRanks[j]);
    }
    for (let len = 5; len <= run.length; len++) {
      for (let s = 0; s + len <= run.length; s++) add(run.slice(s, s + len));
    }
  }
  // 连对: consecutive runs of pairs, length ≥3.
  const pairRanks = seqRanks.filter((r) => has(r, 2));
  for (let i = 0; i < pairRanks.length; i++) {
    let run = [pairRanks[i]];
    for (let j = i + 1; j < pairRanks.length; j++) {
      if (pairRanks[j] !== run[run.length - 1] + 1) break;
      run.push(pairRanks[j]);
    }
    for (let len = 3; len <= run.length; len++) {
      for (let s = 0; s + len <= run.length; s++) {
        const block = run.slice(s, s + len);
        add(block.flatMap((r) => [r, r]));
      }
    }
  }
  // 飞机 (and wings). Find consecutive runs of trio-capable ranks (≤A), length ≥2.
  const trioRanks = seqRanks.filter((r) => has(r, 3));
  for (let i = 0; i < trioRanks.length; i++) {
    let run = [trioRanks[i]];
    for (let j = i + 1; j < trioRanks.length; j++) {
      if (trioRanks[j] !== run[run.length - 1] + 1) break;
      run.push(trioRanks[j]);
    }
    for (let k = 2; k <= run.length; k++) {
      for (let s = 0; s + k <= run.length; s++) {
        const block = run.slice(s, s + k);
        const core = block.flatMap((r) => [r, r, r]);
        add(core); // pure plane
        addPlaneWings(out, cnt, block, k, against); // + single / pair wings
      }
    }
  }
  // 四带二: each four-of-a-kind + 2 single kickers OR 2 pairs.
  for (const r of uniq) {
    if (cnt.get(r) !== 4) continue;
    const four = [r, r, r, r];
    // two single kickers: choose 2 cards from the rest (allow a held pair as two singles)
    const singleKickers = [];
    for (const k of uniq) if (k !== r) for (let c = 0; c < cnt.get(k); c++) singleKickers.push(k);
    for (let a = 0; a < singleKickers.length; a++)
      for (let b = a + 1; b < singleKickers.length; b++)
        add([...four, singleKickers[a], singleKickers[b]]);
    // two pair kickers
    const pk = uniq.filter((k) => k !== r && has(k, 2));
    for (let a = 0; a < pk.length; a++)
      for (let b = a + 1; b < pk.length; b++)
        add([...four, pk[a], pk[a], pk[b], pk[b]]);
  }
  return dedupe(out);
}

// Helper: append all valid wing combinations for a plane core (block of k trio ranks).
function addPlaneWings(out, cnt, block, k, against) {
  const add = (ranks) => { const d = classify(ranks); if (d && beats(d, against)) out.push({ ...d, ranks }); };
  const core = block.flatMap((r) => [r, r, r]);
  const inBlock = new Set(block);
  // single wings: choose k single cards from outside the block (cards leftover after the trios)
  const leftoverSingles = [];
  for (const [r, c] of cnt) {
    const used = inBlock.has(r) ? 3 : 0;
    for (let i = 0; i < c - used; i++) leftoverSingles.push(r);
  }
  // pick k singles (combinations) — keep it bounded by only generating from distinct-rank multiset
  combos(leftoverSingles, k).forEach((w) => add([...core, ...w]));
  // pair wings: choose k pairs from ranks (outside block) that have ≥2 leftover
  const pairCandidates = [];
  for (const [r, c] of cnt) {
    const used = inBlock.has(r) ? 3 : 0;
    if (c - used >= 2) pairCandidates.push(r);
  }
  choose(pairCandidates, k).forEach((rs) => add([...core, ...rs.flatMap((r) => [r, r])]));
}

// k-combinations of a multiset array (values), returning arrays of length k (order-insensitive,
// de-duplicated by value-sequence). Bounded use only (k ≤ ~4 in practice).
function combos(arr, k) {
  const res = [];
  const a = arr.slice().sort((x, y) => x - y);
  const rec = (start, picked) => {
    if (picked.length === k) { res.push(picked.slice()); return; }
    let prev = null;
    for (let i = start; i < a.length; i++) {
      if (a[i] === prev) continue; // skip duplicate at this position
      prev = a[i];
      picked.push(a[i]); rec(i + 1, picked); picked.pop();
    }
  };
  rec(0, []);
  return res;
}
// k-subsets of distinct values.
function choose(arr, k) {
  const res = [];
  const rec = (start, picked) => {
    if (picked.length === k) { res.push(picked.slice()); return; }
    for (let i = start; i < arr.length; i++) { picked.push(arr[i]); rec(i + 1, picked); picked.pop(); }
  };
  rec(0, []);
  return res;
}
// Remove duplicate moves (same type+rank+ranks-multiset).
function dedupe(moves) {
  const seen = new Set();
  const res = [];
  for (const m of moves) {
    const key = m.type + ':' + [...m.ranks].sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key); res.push(m);
  }
  return res;
}

// ---- game state machine ----------------------------------------------------
export const PHASE = { BID: 'bid', PLAY: 'play', OVER: 'over' };
export const ROLE = { PEASANT: 0, LANDLORD: 1 };

// One 斗地主 hand: deal → bidding (叫分) → trick play → settlement.
// Seats are 0,1,2. The human is seat 0 in offline play (the UI rotates as needed).
export class Game {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.firstBidder = opts.firstBidder ?? Math.floor(this.rng() * 3); // who calls 叫分 first
    const deck = shuffle(makeDeck(), this.rng);
    // 17 each + 3 底牌.
    this.hands = [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)].map(sortHand);
    this.bottom = deck.slice(51, 54);          // the 3 landlord cards (revealed after bidding)
    this.landlord = -1;
    this.bid = 0;                               // winning call (1..3) = base score
    this.bids = [];                             // log of {seat, call}
    this.bidTurn = this.firstBidder;
    this.bidsMade = 0;
    this.highBid = 0;
    this.highBidder = -1;

    this.phase = PHASE.BID;
    this.turn = -1;                             // whose move (set when play starts)
    this.lead = null;                           // descriptor of the play to beat (null = free lead)
    this.leadSeat = -1;                         // who made the current `lead`
    this.passesInARow = 0;
    this.playLog = [];                          // {seat, move|null(pass), ranks}
    this.handCounts = [17, 17, 17];             // cards left per seat (kept in sync)
    this.bombs = 0;                             // bombs+rockets played → multiplier
    this.firstPlayDone = false;                 // for 春天/反春天 detection
    this.peasantPlayed = false;                 // did any peasant ever play a (non-pass) card?
    this.landlordPlays = 0;                     // how many times the landlord has played
    this.result = null;
  }

  // ----- bidding (叫分 0..3) -----
  // call ∈ {0(不叫),1,2,3}. A call of 3 ends bidding at once. Returns true if bidding continues.
  placeBid(seat, call) {
    if (this.phase !== PHASE.BID || seat !== this.bidTurn) return false;
    call = Math.max(0, Math.min(3, call | 0));
    if (call !== 0 && call <= this.highBid) call = 0; // must outbid; otherwise treated as 不叫
    this.bids.push({ seat, call });
    this.bidsMade++;
    if (call > this.highBid) { this.highBid = call; this.highBidder = seat; }
    if (call === 3 || this.bidsMade >= 3) { this._finishBidding(); return false; }
    this.bidTurn = (this.bidTurn + 1) % 3;
    return true;
  }

  _finishBidding() {
    if (this.highBidder < 0) { // everyone passed → no landlord; caller should redeal
      this.phase = PHASE.OVER;
      this.result = { redeal: true };
      return;
    }
    this.landlord = this.highBidder;
    this.bid = this.highBid;
    this.hands[this.landlord] = sortHand(this.hands[this.landlord].concat(this.bottom));
    this.handCounts[this.landlord] = this.hands[this.landlord].length; // 20
    this.phase = PHASE.PLAY;
    this.turn = this.landlord;     // landlord leads first
    this.lead = null;
    this.leadSeat = this.landlord;
  }

  roleOf(seat) { return seat === this.landlord ? ROLE.LANDLORD : ROLE.PEASANT; }

  // ----- play -----
  // Validate that `cardIds` (ids from seat's hand) form a legal play vs the current lead.
  // Returns the descriptor (with .ranks) if legal, else null.
  validatePlay(seat, cardIds) {
    if (this.phase !== PHASE.PLAY || seat !== this.turn) return null;
    const hand = this.hands[seat];
    const chosen = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
    if (chosen.length !== cardIds.length) return null; // some id not in hand
    const ranks = chosen.map((c) => c.rank);
    const d = classify(ranks);
    if (!d) return null;
    const against = seat === this.leadSeat ? null : this.lead; // leader plays free
    if (!beats(d, against)) return null;
    return { ...d, ranks, cardIds };
  }

  // Apply a play (cardIds) or a pass (cardIds null/empty). Returns true on success.
  play(seat, cardIds) {
    if (this.phase !== PHASE.PLAY || seat !== this.turn) return false;
    const isLeadSeat = seat === this.leadSeat;
    if (!cardIds || cardIds.length === 0) {
      if (isLeadSeat) return false;               // the leader cannot pass
      this.playLog.push({ seat, move: null, ranks: [] });
      this.passesInARow++;
      // two passes after a lead → that lead wins the trick; its player leads anew, free.
      if (this.passesInARow >= 2) { this.lead = null; this.leadSeat = (this.leadSeat); this.passesInARow = 0; this.turn = this.leadSeat; this._afterAdvance(); return true; }
      this.turn = (this.turn + 1) % 3;
      return true;
    }
    const d = this.validatePlay(seat, cardIds);
    if (!d) return false;
    // remove the cards
    const idset = new Set(cardIds);
    this.hands[seat] = this.hands[seat].filter((c) => !idset.has(c.id));
    this.handCounts[seat] = this.hands[seat].length;
    this.playLog.push({ seat, move: d, ranks: d.ranks });
    if (d.type === COMBO.BOMB || d.type === COMBO.ROCKET) this.bombs++;
    if (this.roleOf(seat) === ROLE.LANDLORD) this.landlordPlays++;
    else this.peasantPlayed = true;
    this.lead = d;
    this.leadSeat = seat;
    this.passesInARow = 0;

    if (this.hands[seat].length === 0) { this._win(seat); return true; }
    this.turn = (this.turn + 1) % 3;
    return true;
  }

  _afterAdvance() { /* hook: a trick was won by pass-out; nothing extra for now */ }

  _win(seat) {
    this.phase = PHASE.OVER;
    const landlordWon = this.roleOf(seat) === ROLE.LANDLORD;
    // 春天: landlord won and no peasant ever played. 反春天: a peasant won and the landlord
    // only ever played its single opening lead.
    const spring = landlordWon && !this.peasantPlayed;
    const antiSpring = !landlordWon && this.landlordPlays <= 1;
    const springMult = (spring || antiSpring) ? 1 : 0;
    const mult = Math.pow(2, this.bombs + springMult);
    const total = this.bid * mult;
    // settlement: landlord ± total vs EACH peasant (so ±2×total net).
    const delta = [0, 0, 0];
    for (let s = 0; s < 3; s++) {
      if (s === this.landlord) delta[s] = landlordWon ? +2 * total : -2 * total;
      else delta[s] = landlordWon ? -total : +total;
    }
    this.result = {
      winner: seat, landlord: this.landlord, landlordWon,
      bid: this.bid, bombs: this.bombs, spring, antiSpring, multiplier: mult,
      total, delta,
    };
  }
}

// Sort a hand strongest-last for stable display (rank asc, then suit).
export function sortHand(cards) {
  return cards.slice().sort((a, b) => a.rank - b.rank || a.suit - b.suit);
}
