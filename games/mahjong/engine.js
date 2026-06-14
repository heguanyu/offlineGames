// Tianjin Mahjong (天津麻将) rules engine — pure logic, no DOM, importable in Node.
//
// Distinctive rules implemented (see README / rules panel for the player-facing
// version):
//   - 136 tiles, no flowers. Chow (吃) is NOT allowed; only Pung (碰) and Kong
//     (杠). You may still form sequences inside your own concealed hand.
//   - Win by SELF-DRAW ONLY (自摸), including the kong-replacement draw (杠开)
//     and the final wall tile (海底). There is no winning off a discard (点炮).
//   - 混儿 (wild): after the deal an indicator tile is flipped; the indicator's
//     kind AND the next kind in its cycle both become wild. Wilds substitute for
//     any tile when completing a winning hand, but may NOT be used to pung/kong,
//     and may NOT be discarded.
//   - 起和 2番: a win must reach 2番, so a fan-less 小和 is NOT a legal win.
//     Fans: 混吊 / 双混吊 (both 2番), 素 (没混儿, no wild at all), 捉五 (self-draw
//     the 5万 into a 4-5-6万 run), 龙 (full 1-9 run in one suit), 本混龙 (龙 in the
//     wild's suit, doubles 龙), 杠开, 天和/地和. 捉五/龙/天地和 ADD into a base term;
//     本混/混吊/素/杠开 each ×2. See scoreFromDecomp(). Matches the zh.wikipedia
//     《天津麻将》 combination table (双混儿伍儿 6 … 双混儿捉伍儿本混儿龙 28).
//
// Tile id scheme (34 kinds, 4 copies each = 136):
//   0..8   characters 万 (m) ranks 1..9
//   9..17  dots       筒 (p) ranks 1..9
//   18..26 bamboo     条 (s) ranks 1..9
//   27..30 winds      东 南 西 北
//   31..33 dragons    中 發 白

export const KINDS = 34;
export const COPIES = 4;

export const SUIT = { M: 'm', P: 'p', S: 's', W: 'w', D: 'd' };

// Inclusive [start, end] id range of the cycle each kind wraps within, used both
// for the wild "next kind" and for sequence/suit logic.
const GROUPS = [
  [0, 8],   // m
  [9, 17],  // p
  [18, 26], // s
  [27, 30], // winds
  [31, 33], // dragons
];

export function groupOf(id) {
  for (const g of GROUPS) if (id >= g[0] && id <= g[1]) return g;
  throw new Error('bad tile id ' + id);
}
export function suitOf(id) {
  if (id < 9) return SUIT.M;
  if (id < 18) return SUIT.P;
  if (id < 27) return SUIT.S;
  if (id < 31) return SUIT.W;
  return SUIT.D;
}
export function isNumberSuit(id) { return id < 27; }
export function rankOf(id) {
  if (id < 27) return (id % 9) + 1;
  if (id < 31) return id - 27 + 1; // winds 1..4
  return id - 31 + 1;              // dragons 1..3
}

// The next kind in the cycle (wraps at the end of the group). Used to derive the
// second wild kind from the flipped indicator.
export function nextInCycle(id) {
  const [start, end] = groupOf(id);
  return id === end ? start : id + 1;
}

// The two wild kinds produced by an indicator tile.
export function wildKindsFromIndicator(indicatorId) {
  return [indicatorId, nextInCycle(indicatorId)];
}

const SUIT_NAMES = { m: '万', p: '筒', s: '条' };
const WIND_NAMES = ['东', '南', '西', '北'];
const DRAGON_NAMES = ['中', '發', '白'];

// Human-readable label, e.g. "5万", "东", "白". Used by UI + debugging.
export function tileName(id) {
  if (id < 27) return rankOf(id) + SUIT_NAMES[suitOf(id)];
  if (id < 31) return WIND_NAMES[id - 27];
  return DRAGON_NAMES[id - 31];
}

// ---------------------------------------------------------------------------
// Wall
// ---------------------------------------------------------------------------

export function freshTiles() {
  const t = [];
  for (let k = 0; k < KINDS; k++) for (let c = 0; c < COPIES; c++) t.push(k);
  return t;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Convert a list of tile ids into a 34-length count vector.
export function toCounts(ids) {
  const c = new Array(KINDS).fill(0);
  for (const id of ids) c[id]++;
  return c;
}

// ---------------------------------------------------------------------------
// Win solver (with wilds as jokers)
//
// Given a concealed multiset and a number of joker tiles, enumerate every way to
// partition them into `needMelds` melds (pung or chow) + 1 pair. Returns a list
// of decompositions; each group records how many jokers it consumed and which
// natural kinds it used (needed for fan detection). Sequences only exist in the
// number suits. The anchor is always the lowest remaining natural tile, and a
// joker may stand in for ranks below the anchor in a chow (this is what makes
// edge runs like 7-8-9 reachable when the natural anchor is the 8 or 9).
// ---------------------------------------------------------------------------

function cloneCounts(c) { return c.slice(); }

// Cap on decompositions kept per analysis — 14 tiles never produce many, but
// guard against pathological joker-heavy hands.
const MAX_DECOMPS = 2000;

function searchDecomps(counts, jokers, needMelds, needPair, groups, out) {
  if (out.length >= MAX_DECOMPS) return;

  let k = -1;
  for (let i = 0; i < KINDS; i++) if (counts[i] > 0) { k = i; break; }

  if (k === -1) {
    // Only jokers remain; they must fill the outstanding melds/pairs exactly.
    const need = needMelds * 3 + needPair * 2;
    if (jokers === need) {
      const extra = [];
      for (let i = 0; i < needMelds; i++) extra.push({ type: 'pung', kinds: [], jokers: 3, natural: new Set() });
      if (needPair) extra.push({ type: 'pair', kinds: [], jokers: 2, natural: new Set() });
      out.push(groups.concat(extra));
    }
    return;
  }

  // --- Option: pair on anchor k (anchor always contributes one natural) ---
  if (needPair > 0) {
    if (counts[k] >= 2) {
      const c2 = cloneCounts(counts); c2[k] -= 2;
      searchDecomps(c2, jokers, needMelds, needPair - 1,
        groups.concat([{ type: 'pair', kinds: [k], jokers: 0, natural: new Set([k]) }]), out);
    }
    if (jokers >= 1 && counts[k] >= 1) {
      const c2 = cloneCounts(counts); c2[k] -= 1;
      searchDecomps(c2, jokers - 1, needMelds, needPair - 1,
        groups.concat([{ type: 'pair', kinds: [k], jokers: 1, natural: new Set([k]) }]), out);
    }
  }

  if (needMelds > 0) {
    // --- Option: pung on anchor k (1..3 naturals, rest jokers) ---
    for (let j = 0; j <= 2; j++) {
      const nat = 3 - j;
      if (nat >= 1 && counts[k] >= nat && jokers >= j) {
        const c2 = cloneCounts(counts); c2[k] -= nat;
        searchDecomps(c2, jokers - j, needMelds - 1, needPair,
          groups.concat([{ type: 'pung', kinds: [k], jokers: j, natural: new Set([k]) }]), out);
      }
    }

    // --- Option: chow windows containing anchor k ---
    // The anchor k is natural and the lowest remaining kind, so ranks below k in
    // the window must be jokers. Ranks above k may use a natural (if one is free)
    // OR a joker — BOTH branches are explored, so a wild can stand in for a tile
    // that is more useful elsewhere (e.g. read 567万 natural + 4万-[混]-[混] for 捉五
    // instead of locking 456万 together).
    if (isNumberSuit(k)) {
      const [gStart, gEnd] = groupOf(k);
      for (let start = k - 2; start <= k; start++) {
        if (start < gStart || start + 2 > gEnd) continue; // run must stay in suit
        const ranks = [start, start + 1, start + 2];
        const choices = ranks.map((r) =>
          r === k ? ['n'] : r < k ? ['j'] : counts[r] > 0 ? ['n', 'j'] : ['j']);
        let combos = [[]];
        for (const ch of choices) {
          const nx = [];
          for (const combo of combos) for (const o of ch) nx.push(combo.concat(o));
          combos = nx;
        }
        for (const combo of combos) {
          const c2 = cloneCounts(counts);
          let jUsed = 0;
          const natural = new Set();
          for (let i = 0; i < 3; i++) {
            if (combo[i] === 'n') { c2[ranks[i]] -= 1; natural.add(ranks[i]); } else jUsed++;
          }
          if (jUsed <= jokers) {
            searchDecomps(c2, jokers - jUsed, needMelds - 1, needPair,
              groups.concat([{ type: 'chow', kinds: ranks.slice(), jokers: jUsed, natural }]), out);
          }
        }
      }
    }
  }
}

// All decompositions of (concealed ids + wildCount jokers) into needMelds melds +
// 1 pair. Wild tiles must be passed as `jokers`; do NOT include them in `ids`.
export function decompose(naturalIds, jokers, needMelds) {
  const counts = toCounts(naturalIds);
  const out = [];
  searchDecomps(counts, jokers, needMelds, 1, [], out);
  return out;
}

export function isWinningHand(naturalIds, jokers, needMelds) {
  const counts = toCounts(naturalIds);
  const out = [];
  searchDecomps(counts, jokers, needMelds, 1, [], out);
  return out.length > 0;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// Fan constants — the documented Tianjin combination rule, verified against the
// wiki's full combination table: 捉五 / 龙 / 天地和 ADD into a base term; 本混 (本混龙),
// 混吊 / 双混吊, 素, 杠开 each MULTIPLY by 2. "Add first, then multiply." When no
// additive fan is present the base is 1, so a fan-less win scores 1 — below 起和
// (WIN_MIN), i.e. a 小和, which analyzeWin() rejects. Single source of truth.
export const FAN = {
  HUNDIAO: 2,    // 混吊 — the 将 (pair) is the 单吊 wait carrying a STANDING 混儿 (×2)
  SHUANGHUN: 2,  // 双混吊 — a MELD carries two STANDING 混儿, closed by the winning tile (×2)
  SU: 2,         // 素 / 没混儿 — no wild in the hand at all (×2)
  ZHUOWU: 3,     // 捉五 — self-draw the 5万 into a 4-5-6万 run (+)
  LONG: 4,       // 龙 — full 1-9 run in one suit, as three chows (+)
  BENHUN: 2,     // 本混 — 龙's suit equals the wild's suit; doubles 龙 → 本混龙 = 8 (×2)
  GANGKAI: 2,    // 杠开 — win on a kong-replacement draw (×2)
  TIANDI: 28,    // 天和 / 地和 — win off the very first draw → flat max (算龙 + 随意摆, capped)
};
export const WIN_MIN = 2; // 起和番: a win must reach 2番 (小和 is disallowed)

function suitHasDragon(seqStartsBySuit, suit) {
  const starts = seqStartsBySuit[suit];
  if (!starts) return false;
  // Full 1-9 needs runs starting at rank 1, 4 and 7 (ids offset within the suit).
  const base = suit === 'm' ? 0 : suit === 'p' ? 9 : 18;
  return starts.has(base) && starts.has(base + 3) && starts.has(base + 6);
}

// Evaluate one decomposition under the win context and return { score, fans }.
function scoreFromDecomp(decomp, ctx) {
  const { winningKind, wildCount, wildSuit, afterKong, tianOrDi } = ctx;
  const winIsWild = ctx.wilds.includes(winningKind);

  // 天胡 / 地胡 — a first-draw win. 算龙 + 随意摆, capped at a flat max (no search).
  if (tianOrDi) {
    return { score: FAN.TIANDI, fans: [ctx.dealerWin ? '天和' : '地和'],
      meta: { tian: true, su: wildCount === 0, hunDiao: false, shuangHun: false, zhuoWu: false, long: false, benHunLong: false } };
  }

  const fans = [];
  // 素 — no wild present in the hand at all (decomposition-independent).
  const su = wildCount === 0;

  const groupSize = (g) => (g.type === 'pair' ? 2 : 3);

  // 捉五 — a 4-5-6万 run capturing the 5万: won by a natural 5万 (id 4), by a 混儿 standing
  // as the 5万 (4/6万 may be 混儿 too), or by a meld of three 混儿 as 4-5-6万. The hand is
  // scored in its best reading, so even four complete runs + a 混 that can stand as the
  // 5万 (the natural 5万 sliding into the 将) is a genuine 捉五 — the same shape as a 4_6万
  // kanchan wait, and consistent with catching the spot on a natural 5万.
  const zhuoWu = (winIsWild && decomp.some((g) => g.jokers >= 3))
    || decomp.some((g) => g.type === 'chow' && g.kinds[0] === 3 &&
      ((winningKind === 4 && g.natural.has(4)) || (winIsWild && !g.natural.has(4))));

  // 龙 / 本混龙 — three runs covering 1-9 in a single number suit.
  const seqStartsBySuit = {};
  for (const g of decomp) {
    if (g.type !== 'chow') continue;
    const s = suitOf(g.kinds[0]);
    (seqStartsBySuit[s] ||= new Set()).add(g.kinds[0]);
  }
  let long = false, benHunLong = false, longSuit = null;
  for (const s of ['m', 'p', 's']) {
    if (suitHasDragon(seqStartsBySuit, s)) { long = true; longSuit = s; if (s === wildSuit) benHunLong = true; }
  }

  // 混吊 / 双混吊 (×2) — STANDING (hand-row) 混儿 that complete the hand no matter what
  // tile arrives: 混吊 = the 将 (pair) is the 单吊 wait carrying a 混儿; 双混吊 = a MELD
  // carries two 混儿, closed by the winning tile. With a NATURAL winning tile the closed
  // group is all-but-one 混儿 (jokers ≥ size−1): a pair (size 2) needs ≥1 → 混吊, a meld
  // (size 3) needs ≥2 → 双混吊. When the winning tile is itself a 混儿 it fills one slot,
  // so the STANDING 混儿 must make up the rest (jokers ≥ size): a 将 of two 混儿 → 混吊, an
  // all-混儿 meld (two standing + the drawn) → 双混吊 (e.g. an all-混儿 4-5-6万 = 双混捉五).
  // A lone 混儿 drawn into a meld with no standing-混儿 partner earns nothing — it may
  // still win as plain 捉五 / 龙.
  let wildCompleted = false, shuangHun = false, hunDiao = false, winPair = false, winGroup = null;
  if (!winIsWild) {
    // Only groups that use the natural winning tile in a real slot count — a run
    // whose winning-rank slot is filled by a JOKER (g.kinds lists the rank, but
    // g.natural does NOT) is NOT completed by the drawn tile, so filtering on
    // g.natural (not g.kinds) avoids mis-crediting 双混吊 to such a run.
    const winByKind = decomp.filter((g) => g.natural.has(winningKind));
    winGroup = winByKind.find((g) => g.jokers >= groupSize(g) - 1) || winByKind[0] || null;
    const j = winGroup ? winGroup.jokers : 0;
    wildCompleted = !su && !!winGroup && j >= groupSize(winGroup) - 1;
    winPair = !!(winGroup && winGroup.type === 'pair');
    hunDiao = wildCompleted && winPair;   // 混吊 — the 将 carries the 混儿 wait
    shuangHun = wildCompleted && !winPair; // 双混吊 — a meld carries two 混儿
  } else {
    // The winning tile is itself a 混儿. It fills one slot of its group, so a STANDING-
    // 混儿 wait needs jokers ≥ size (the drawn 混儿 + the standing ones fill the group):
    //   • 混吊  — a 单吊将 (pair, size 2) of two 混儿: one STANDING 混儿 (the 混吊 wait)
    //     paired by the drawn 混儿.
    //   • 双混吊 — an all-混儿 MELD (size 3): two STANDING 混儿 (the 双混 wait) closed by
    //     the drawn 混儿 as its 3rd tile (e.g. the 5万 of an all-混儿 4-5-6万 → 双混捉五).
    // A meld with only ONE standing 混儿 (2 jokers + a natural) has no standing-混儿 wait,
    // so it earns no fan and still scores plain 捉五 / 龙.
    const cand = decomp.filter((g) => g.jokers >= groupSize(g));
    winGroup = cand.find((g) => g.type !== 'pair') || cand[0] || null; // prefer 双混 on a tie
    wildCompleted = !!winGroup;
    winPair = !!(winGroup && winGroup.type === 'pair');
    hunDiao = wildCompleted && winPair;   // 混吊 — the 将 carries the 混儿 wait
    shuangHun = wildCompleted && !winPair; // 双混吊 — a meld carries two 混儿
  }

  // --- combine: additive base term (捉五 / 龙), then ×2 fans ---
  let add = 0;
  if (zhuoWu) { add += FAN.ZHUOWU; fans.push('捉五'); }
  if (long) { add += FAN.LONG; fans.push(benHunLong ? '本混龙' : '龙'); }
  const base = add > 0 ? add : 1;

  let mult = 1;
  if (benHunLong) mult *= FAN.BENHUN;            // 本混 doubles 龙 → 本混龙 = 8
  if (su) { mult *= FAN.SU; fans.push('素'); }
  else if (wildCompleted) {                       // 混吊 (将) / 双混吊 (a 2-混儿 meld) — both ×2
    mult *= FAN.HUNDIAO;
    fans.push(winPair ? '混吊' : '双混吊');
  }
  if (afterKong) { mult *= FAN.GANGKAI; fans.push('杠开'); }

  return { score: base * mult, fans,
    meta: { su, hunDiao, shuangHun, zhuoWu, long, benHunLong, longSuit,
      winGroupIdx: winGroup ? decomp.indexOf(winGroup) : -1 } };
}

// Analyze a self-draw win. `concealedIds` includes the winning tile and any wild
// tiles. `exposedMelds` is the list of called pung/kong (each reduces needMelds).
// Returns the best-scoring result, or null if the hand does not win.
export function analyzeWin(concealedIds, exposedMelds, ctx) {
  const wildSet = new Set(ctx.wilds);
  const natural = [];
  let wildCount = 0;
  for (const id of concealedIds) {
    if (wildSet.has(id)) wildCount++; else natural.push(id);
  }
  const needMelds = 4 - exposedMelds.length;
  const decomps = decompose(natural, wildCount, needMelds);
  if (decomps.length === 0) return null;

  const wildSuit = isNumberSuit(ctx.wilds[0]) ? suitOf(ctx.wilds[0]) : null;
  const full = { ...ctx, wildCount, wildSuit };

  // Pick the highest-scoring decomposition. On a score tie, prefer the more
  // valuable wild pattern (双混吊 over 混吊, 本混龙) then the richer fan set — so a
  // hand is always credited its best reading rather than the first one found.
  let best = null, bestQ = -1;
  for (const d of decomps) {
    const r = scoreFromDecomp(d, full);
    const q = r.score * 1000 + (r.meta.shuangHun ? 200 : 0) + (r.meta.benHunLong ? 100 : 0) + r.fans.length;
    if (q > bestQ) { bestQ = q; best = { ...r, decomp: d }; }
  }
  // 起和番: a hand that cannot reach 2番 is a 小和 and not a legal win.
  if (!best || best.score < WIN_MIN) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Game state machine — drives turns, draws, discards, claims. No DOM, no AI;
// the caller (browser main.js or a test) supplies decisions. Synchronous.
// ---------------------------------------------------------------------------

export const PHASE = {
  AWAIT_DISCARD: 'await-discard', // current player must discard (or self-kong)
  AWAIT_CLAIM: 'await-claim',     // a discard is on the table, one player may 碰/杠
  OVER: 'over',
};

export class Game {
  // opts: { rng, dealer (0..3), prevailingWind (0..3), seatWinds:[4] }
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.dealer = opts.dealer ?? 0;
    this.prevailingWind = opts.prevailingWind ?? 0;
    this.scores = opts.scores ? opts.scores.slice() : [0, 0, 0, 0];
    this.dealerDouble = opts.dealerDouble ?? true; // 庄家加倍
    this.log = [];
    this._deal(opts);
  }

  _emit(msg) { this.log.push(msg); }

  _deal(opts) {
    const wall = opts.wall ? opts.wall.slice() : shuffle(freshTiles(), this.rng);
    this.hands = [[], [], [], []];
    // 13 to each, in dealing order starting from the dealer.
    for (let n = 0; n < 13; n++) {
      for (let p = 0; p < 4; p++) this.hands[(this.dealer + p) % 4].push(wall.pop());
    }
    // Flip the indicator from the wall; it is set aside (out of play).
    this.indicator = opts.indicator ?? wall.pop();
    this.wilds = wildKindsFromIndicator(this.indicator);
    this.wildSet = new Set(this.wilds);
    this.wildSuit = isNumberSuit(this.wilds[0]) ? suitOf(this.wilds[0]) : null;
    this.wall = wall;

    this.melds = [[], [], [], []];
    this.discards = [[], [], [], []];
    this.discardLog = []; // global, ordered: { player, kind } — drives the center pool
    for (const h of this.hands) h.sort((a, b) => a - b);

    this.turn = this.dealer;
    this.phase = PHASE.AWAIT_DISCARD;
    this.drawnTile = null;
    this.afterKong = false;
    this.firstGoAround = true; // for 天和 / 地和
    this.result = null;
    this.selfDrawWin = null; // a detected-but-unclaimed self-draw win (the 胡 button)

    // Dealer starts by drawing their 14th tile.
    this._draw(this.dealer, false);
  }

  seatWind(player) { return (player - this.dealer + 4) % 4; } // 0=东 for dealer

  isWild(id) { return this.wildSet.has(id); }

  // How many tiles are concealed for a player (excludes called melds).
  concealedCount(player) { return this.hands[player].length; }

  // Draw a tile for `player`. `fromKong` marks a kong-replacement draw.
  _draw(player, fromKong) {
    if (this.wall.length === 0) { this._drawGame(); return; }
    const tile = this.wall.pop();
    this.hands[player].push(tile);
    this.hands[player].sort((a, b) => a - b);
    this.drawnTile = tile;
    this.afterKong = fromKong;
    this.turn = player;
    this.lastTileDraw = this.wall.length === 0; // this draw emptied the wall → 海底

    // Detect a self-draw win but DON'T fire it — the player may decline it and
    // play on (or declare it via declareWin()). The UI offers a 胡 button.
    this.selfDrawWin = this._checkSelfDraw(player) || null;
    this.phase = PHASE.AWAIT_DISCARD;
  }

  // Claim the pending self-draw win (the 胡 button). Returns true if a win fired.
  declareWin() {
    if (this.phase !== PHASE.AWAIT_DISCARD || !this.selfDrawWin) return false;
    const win = this.selfDrawWin; this.selfDrawWin = null;
    this._win(this.turn, win);
    return true;
  }

  _checkSelfDraw(player) {
    // 天和 = dealer wins on the very first draw; 地和 = a non-dealer wins on their
    // first draw with no prior claim. Approximated by firstGoAround + no melds.
    const noMelds = this.melds.every((m) => m.length === 0);
    const ctx = {
      wilds: this.wilds,
      winningKind: this.drawnTile,
      afterKong: this.afterKong,
      lastTile: this.lastTileDraw,
      tianOrDi: this.firstGoAround && noMelds,
      dealerWin: player === this.dealer,
    };
    return analyzeWin(this.hands[player], this.melds[player], ctx);
  }

  // The set of self-kong options available to the current player right now.
  // Four identical 混儿 is a 金杠 (gold kong) — the only way a wild may be konged.
  selfKongOptions(player) {
    if (this.phase !== PHASE.AWAIT_DISCARD || this.turn !== player) return [];
    const counts = toCounts(this.hands[player]); // includes 混儿 (for 金杠)
    const opts = [];
    for (let k = 0; k < KINDS; k++) if (counts[k] === 4) opts.push({ type: this.isWild(k) ? 'gold' : 'concealed', kind: k });
    // Added kong (补杠): an exposed pung whose 4th tile is now in hand.
    for (const m of this.melds[player]) {
      if (m.type === 'pung' && this.hands[player].includes(m.kind) && !this.isWild(m.kind)) {
        opts.push({ type: 'added', kind: m.kind });
      }
    }
    return opts;
  }

  selfKong(player, kind) {
    if (this.turn !== player || this.phase !== PHASE.AWAIT_DISCARD) throw new Error('not your turn');
    const hand = this.hands[player];
    const wild = this.isWild(kind);
    const added = !wild && this.melds[player].find((m) => m.type === 'pung' && m.kind === kind);
    if (added) {
      // 补杠 — upgrade the exposed pung (明杠). 混儿 can never be an exposed pung.
      const i = hand.indexOf(kind);
      if (i < 0) throw new Error('no tile to add');
      hand.splice(i, 1);
      added.type = 'kong';
      added.tiles = [kind, kind, kind, kind];
    } else {
      // concealed kong (暗杠), or 金杠 when the kind is a 混儿.
      const n = hand.filter((id) => id === kind).length;
      if (n < 4) throw new Error('need 4 to conceal-kong');
      for (let c = 0; c < 4; c++) hand.splice(hand.indexOf(kind), 1);
      this.melds[player].push({ type: 'kong', kind, tiles: [kind, kind, kind, kind], concealed: true });
    }
    this._emit(`${this.seatName(player)} ${wild ? '金杠' : '杠'} ${tileName(kind)}`);
    this._draw(player, true); // kong replacement draw → may be 杠开 (incl. 金杠开)
  }

  // Current player discards `tile`. Wilds may never be discarded.
  discard(player, tile) {
    if (this.turn !== player || this.phase !== PHASE.AWAIT_DISCARD) throw new Error('not your turn');
    if (this.isWild(tile)) throw new Error('cannot discard a wild (混儿)');
    this.selfDrawWin = null; // declined any pending self-draw win
    const hand = this.hands[player];
    const i = hand.indexOf(tile);
    if (i < 0) throw new Error('tile not in hand');
    hand.splice(i, 1);
    this.discards[player].push(tile);
    this.discardLog.push({ player, kind: tile });
    this.lastDiscard = { player, kind: tile };
    this.drawnTile = null;

    // Who, if anyone, can claim this discard? At most one player ever can (the
    // counts make a 碰/杠 conflict impossible), so no priority resolution needed.
    this.claim = this._findClaim(player, tile);
    if (this.claim) {
      this.phase = PHASE.AWAIT_CLAIM;
    } else {
      this._advance(player);
    }
  }

  _findClaim(discarder, kind) {
    if (this.isWild(kind)) return null; // discarder never discards a wild anyway
    for (let off = 1; off <= 3; off++) {
      const p = (discarder + off) % 4;
      const n = this.hands[p].filter((id) => id === kind).length;
      if (n >= 3) return { player: p, kind, options: ['kong', 'pung'] };
      if (n >= 2) return { player: p, kind, options: ['pung'] };
    }
    return null;
  }

  // The player named in this.claim acts on the pending discard.
  claimDiscard(type) {
    if (this.phase !== PHASE.AWAIT_CLAIM || !this.claim) throw new Error('nothing to claim');
    const { player, kind } = this.claim;
    const discarder = this.lastDiscard.player;
    this.discards[discarder].pop(); // the tile leaves the discard pile into the meld
    this.discardLog.pop();          // ...and out of the center pool (always the latest)
    const hand = this.hands[player];
    const take = type === 'kong' ? 3 : 2;
    for (let c = 0; c < take; c++) hand.splice(hand.indexOf(kind), 1);
    const tiles = new Array(take + 1).fill(kind);
    this.melds[player].push({ type, kind, tiles, fromDiscard: discarder });
    this.firstGoAround = false;
    this.claim = null;
    this._emit(`${this.seatName(player)} ${type === 'kong' ? '杠' : '碰'} ${tileName(kind)}`);
    this.turn = player;
    if (type === 'kong') {
      this._draw(player, true); // 明杠 → replacement draw, may be 杠开
    } else {
      this.drawnTile = null;            // pung → discard, no fresh draw
      this.phase = PHASE.AWAIT_DISCARD;
    }
  }

  // Decline the pending claim → play continues from the discarder.
  passClaim() {
    if (this.phase !== PHASE.AWAIT_CLAIM) throw new Error('no claim pending');
    const discarder = this.lastDiscard.player;
    this.claim = null;
    this._advance(discarder);
  }

  _advance(fromPlayer) {
    // After the first full go-around of discards, 天和/地和 are no longer possible.
    if (fromPlayer === (this.dealer + 3) % 4) this.firstGoAround = false;
    const next = (fromPlayer + 1) % 4;
    this._draw(next, false);
  }

  _win(player, result) {
    this.phase = PHASE.OVER;
    const payments = this._settle(player, result.score);
    const kongPts = this.melds.map((ms) => ms.reduce((s, m) => s + this._kongPoints(m), 0));
    const kong = this._settleKongs(payments); // 杠分, added on top of the 胡分
    this.result = { type: 'win', winner: player, score: result.score, fans: result.fans,
      decomp: result.decomp, winningTile: this.drawnTile, payments, kong, kongPts };
    this._emit(`${this.seatName(player)} 自摸 ${result.fans.join('+')} (${result.score})`);
  }

  // Self-draw: every other player pays the winner. The dealer pays/collects
  // double when dealerDouble is on (classic 庄家加倍).
  _settle(winner, score) {
    const pay = new Array(4).fill(0);
    for (let p = 0; p < 4; p++) {
      if (p === winner) continue;
      const dbl = this.dealerDouble && (winner === this.dealer || p === this.dealer);
      const amt = score * (dbl ? 2 : 1);
      pay[p] = -amt;
      pay[winner] += amt;
    }
    for (let p = 0; p < 4; p++) this.scores[p] += pay[p];
    return pay;
  }

  // 杠分 — every kong scores 明杠 1 / 暗杠 2 / 金杠 4. Each player's kong points are
  // paid by the other three (incl. the winner), settled pairwise at hand end.
  // 庄家加倍: any kong payment to or from the dealer is doubled, mirroring the 胡分
  // rule. Adds the net into `pay` (and this.scores) and returns the per-seat net.
  _kongPoints(m) {
    if (m.type !== 'kong') return 0;
    if (this.isWild(m.kind)) return 4;   // 金杠
    return m.concealed ? 2 : 1;          // 暗杠 : 明杠
  }
  _settleKongs(pay) {
    const K = this.melds.map((ms) => ms.reduce((s, m) => s + this._kongPoints(m), 0));
    const net = [0, 0, 0, 0];
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        // q pays p for p's kong points and vice-versa; double the pairwise flow
        // when the dealer is one of the pair (庄家加倍).
        const dbl = this.dealerDouble && (p === this.dealer || q === this.dealer) ? 2 : 1;
        const flow = (K[p] - K[q]) * dbl; // net points to p from q
        net[p] += flow; net[q] -= flow;
      }
    }
    for (let p = 0; p < 4; p++) { this.scores[p] += net[p]; pay[p] += net[p]; }
    return net;
  }

  _drawGame() {
    this.phase = PHASE.OVER;
    const pay = [0, 0, 0, 0];
    const kongPts = this.melds.map((ms) => ms.reduce((s, m) => s + this._kongPoints(m), 0));
    const kong = this._settleKongs(pay); // 杠分 still settles on a draw
    this.result = { type: 'draw', payments: pay, kong, kongPts };
    this._emit('荒牌');
  }

  // Who becomes the next dealer, and the seed for the next hand. Dealer repeats
  // (连庄) on a dealer win; otherwise the seat rotates.
  nextDealer() {
    if (this.result?.type === 'win' && this.result.winner === this.dealer) return this.dealer;
    return (this.dealer + 1) % 4;
  }

  seatName(player) { return WIND_NAMES[this.seatWind(player)]; }
}
