// Computer opponents for Tianjin mahjong, three strengths. Decisions: which tile
// to discard, whether to claim a 碰/杠 off a discard, and whether to self-kong.
//
// All levels share one hand evaluator (structScore + tenpai detection); the
// levels differ in how much they trust it, how aggressively they claim, and
// whether they steer toward high-fan shapes (本混龙 / 捉五).
import {
  KINDS, toCounts, isNumberSuit, suitOf, rankOf, groupOf, isWinningHand,
} from './engine.js';

export const LEVELS = { EASY: 1, NORMAL: 2, HARD: 3 };
export const LEVEL_NAMES = { 1: '新手', 2: '普通', 3: '高手' };

// Structure weights — a coarse shanten proxy. A complete meld is worth much more
// than a partial; a pair (eye) a little more than a generic partial.
const W_MELD = 10, W_PARTIAL = 3, W_PAIR = 4, W_JOKER_SPARE = 2;

// Maximum value of arranging (counts + jokers) into up to `meldsLeft` melds plus
// partials plus one pair. Memoized per call. Anchors on the lowest natural tile;
// each branch either consumes it into a group or leaves it floating.
function structScore(counts, jokers, meldsLeft, wantPair, memo) {
  if (meldsLeft <= 0 && !wantPair) return jokers * W_JOKER_SPARE;
  const key = counts.join('') + '|' + jokers + '|' + meldsLeft + '|' + (wantPair ? 1 : 0);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let k = -1;
  for (let i = 0; i < KINDS; i++) if (counts[i] > 0) { k = i; break; }
  if (k === -1) {
    // Only jokers remain: spend them on whatever is still wanted.
    let v = 0, j = jokers, m = meldsLeft;
    while (m > 0 && j >= 3) { v += W_MELD; j -= 3; m--; }
    if (wantPair && j >= 2) { v += W_PAIR; j -= 2; }
    else if (m > 0 && j >= 2) { v += W_PARTIAL; j -= 2; }
    v += j * W_JOKER_SPARE;
    memo.set(key, v);
    return v;
  }

  let best = 0;
  const c = counts.slice();

  // Leave k floating (use one copy as an isolated tile, no value).
  c[k]--; best = Math.max(best, structScore(c, jokers, meldsLeft, wantPair, memo)); c[k]++;

  if (meldsLeft > 0) {
    // Complete pung: natural copies + jokers to reach 3.
    for (let j = 0; j <= 2; j++) {
      const nat = 3 - j;
      if (nat >= 1 && counts[k] >= nat && jokers >= j) {
        c[k] -= nat;
        best = Math.max(best, W_MELD + structScore(c, jokers - j, meldsLeft - 1, wantPair, memo));
        c[k] += nat;
      }
    }
    // Complete chow (number suits): windows anchored at/above k, jokers fill gaps.
    if (isNumberSuit(k)) {
      const [gStart, gEnd] = groupOf(k);
      for (let start = k - 2; start <= k; start++) {
        if (start < gStart || start + 2 > gEnd) continue;
        const cc = counts.slice();
        let jUsed = 0;
        for (const r of [start, start + 1, start + 2]) {
          if (r === k) { cc[r]--; continue; }   // anchor, natural
          if (r < k) { jUsed++; continue; }      // below anchor → joker
          if (cc[r] > 0) cc[r]--; else jUsed++;  // prefer natural
        }
        if (jUsed <= jokers) {
          best = Math.max(best, W_MELD + structScore(cc, jokers - jUsed, meldsLeft - 1, wantPair, memo));
        }
      }
    }
    // Partial proto-meld: a pair-toward-pung, or two tiles of a run (k,k+1 / k,k+2).
    if (counts[k] >= 2) {
      c[k] -= 2;
      best = Math.max(best, W_PARTIAL + structScore(c, jokers, meldsLeft - 1, wantPair, memo));
      c[k] += 2;
    }
    if (isNumberSuit(k)) {
      const [, gEnd] = groupOf(k);
      for (const d of [1, 2]) {
        if (k + d <= gEnd && counts[k + d] > 0) {
          c[k]--; c[k + d]--;
          best = Math.max(best, W_PARTIAL + structScore(c, jokers, meldsLeft - 1, wantPair, memo));
          c[k]++; c[k + d]++;
        }
      }
    }
  }

  // Use k as the pair (eye).
  if (wantPair) {
    if (counts[k] >= 2) {
      c[k] -= 2;
      best = Math.max(best, W_PAIR + structScore(c, jokers, meldsLeft, false, memo));
      c[k] += 2;
    }
    if (jokers >= 1 && counts[k] >= 1) {
      c[k] -= 1;
      best = Math.max(best, W_PAIR + structScore(c, jokers - 1, meldsLeft, false, memo));
      c[k] += 1;
    }
  }

  memo.set(key, best);
  return best;
}

// Split a concealed hand into natural counts + joker count.
function split(hand, wildSet) {
  const natural = [];
  let jokers = 0;
  for (const id of hand) { if (wildSet.has(id)) jokers++; else natural.push(id); }
  return { counts: toCounts(natural), natural, jokers };
}

function evalHand(hand, wildSet, needMelds) {
  const { counts, jokers } = split(hand, wildSet);
  return structScore(counts, jokers, needMelds, true, new Map());
}

// Is a 13-tile concealed hand one tile from a win, and on how many distinct
// tiles? Also true if a wild draw would complete it.
function tenpaiInfo(hand, wildSet, needMelds) {
  const { natural, jokers } = split(hand, wildSet);
  let waits = 0;
  if (isWinningHand(natural, jokers + 1, needMelds)) waits++; // drawing a 混儿 wins
  for (let k = 0; k < KINDS; k++) {
    if (wildSet.has(k)) continue;
    natural.push(k);
    if (isWinningHand(natural, jokers, needMelds)) waits++;
    natural.pop();
  }
  return { tenpai: waits > 0, waits };
}

// Fan-steering bonus for HARD: value tiles that build the big hands — middle
// characters (捉五 / 龙) and anything in the wild's suit (本混龙).
function fanBias(id, wildSuit) {
  let b = 0;
  if (isNumberSuit(id)) {
    if (suitOf(id) === wildSuit) b += 1.5;
    if (suitOf(id) === 'm' && rankOf(id) >= 3 && rankOf(id) <= 7) b += 0.5;
  }
  return b;
}

function rngPick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

// Choose a tile to discard from the current player's 14-tile hand. Never a wild.
export function chooseDiscard(game, player, level, rng = Math.random) {
  const hand = game.hands[player];
  const wildSet = game.wildSet;
  const needMelds = 4 - game.melds[player].length;
  const candidates = [...new Set(hand.filter((t) => !wildSet.has(t)))];

  // EASY: mostly dump the least-connected tile, with frequent random slips.
  if (level === LEVELS.EASY && rng() < 0.5) {
    const counts = toCounts(hand);
    let worst = candidates[0], worstScore = Infinity;
    for (const c of candidates) {
      const adj = isNumberSuit(c)
        ? (counts[c] - 1) + (counts[c - 1] ? 1 : 0) + (counts[c + 1] ? 1 : 0)
        : (counts[c] - 1) * 2;
      if (adj < worstScore) { worstScore = adj; worst = c; }
    }
    return worst;
  }

  const wildSuit = game.wildSuit;
  let best = null, bestVal = -Infinity;
  for (const c of candidates) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(c), 1);
    let val = evalHand(rest, wildSet, needMelds);

    if (level >= LEVELS.NORMAL) {
      const t = tenpaiInfo(rest, wildSet, needMelds);
      if (t.tenpai) val += 100 + t.waits * 3;
    }
    if (level >= LEVELS.HARD) {
      // Reward keeping fan-building tiles (i.e. penalize discarding them).
      val -= fanBias(c, wildSuit);
    }
    if (level === LEVELS.NORMAL) val += (rng() - 0.5) * 0.5; // mild noise
    if (val > bestVal) { bestVal = val; best = c; }
  }
  return best;
}

// Decide whether to claim a pending discard. Returns 'pung' | 'kong' | null.
export function chooseClaim(game, player, claim, level, rng = Math.random) {
  if (level === LEVELS.EASY) {
    // Easy bots only occasionally pung, never strategically.
    return claim.options.includes('pung') && rng() < 0.25 ? 'pung' : null;
  }
  const hand = game.hands[player];
  const wildSet = game.wildSet;
  const exposed = game.melds[player].length;
  const before = evalHand(hand, wildSet, 4 - exposed);

  // Simulate the pung: remove two of the kind, gain a meld, then discard best.
  const after = hand.slice();
  for (let i = 0; i < 2; i++) after.splice(after.indexOf(claim.kind), 1);
  const needMelds = 4 - (exposed + 1);
  // Best residual structure after claiming and discarding our worst tile.
  let bestAfter = -Infinity;
  const cands = [...new Set(after.filter((t) => !wildSet.has(t)))];
  for (const c of cands.length ? cands : [null]) {
    const rest = after.slice();
    if (c !== null) rest.splice(rest.indexOf(c), 1);
    bestAfter = Math.max(bestAfter, evalHand(rest, wildSet, needMelds) + W_MELD);
  }

  const kong = claim.options.includes('kong');
  // HARD claims when it strictly improves the position; NORMAL when it doesn't
  // hurt. A kong also yields a bonus draw, nudging the threshold down.
  const margin = level >= LEVELS.HARD ? 0.5 : -0.5;
  if (bestAfter >= before + margin) return kong ? 'kong' : 'pung';
  if (kong && level >= LEVELS.HARD && rng() < 0.5) return 'kong'; // bonus draw is tempting
  return null;
}

// Decide whether to declare a self-kong on your turn. Returns the kind or null.
export function chooseSelfKong(game, player, level, rng = Math.random) {
  const opts = game.selfKongOptions(player);
  if (opts.length === 0) return null;
  if (level === LEVELS.EASY) return rng() < 0.5 ? rngPick(opts, rng).kind : null;
  // NORMAL/HARD: kong unless the hand is already tenpai and the kong would not
  // keep it so (rare); the replacement draw + 杠开 chance is generally worth it.
  const wildSet = game.wildSet;
  const t = tenpaiInfo(game.hands[player], wildSet, 4 - game.melds[player].length);
  if (!t.tenpai) return opts[0].kind;
  return level >= LEVELS.HARD ? opts[0].kind : (rng() < 0.5 ? opts[0].kind : null);
}
