// Shared mahjong tile model + win solver — pure logic, no DOM, importable in Node.
// Ruleset-agnostic: the per-variant rules engines (mahjong-tianjin/engine.js,
// guobiao/engine.js) import these primitives and build their own scoring + Game
// state machine on top. Originally lived inside the Tianjin engine when it was the
// only mahjong; extracted here so Tianjin is just one variant, not the base.
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
