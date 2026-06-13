// Computer opponents for 国标 (MCR) mahjong. Decisions: which tile to discard,
// and whether to claim 胡 / 碰 / 杠 / 吃 off a discard. Three strengths. Because
// the win minimum is 8 fan, the bots steer toward high-fan shapes (one-suit
// flush, honor/terminal pungs, all-pungs) which naturally clear the bar.
import { KINDS, suitOf, rankOf, isNumberSuit, toCounts, groupOf } from '../mahjong/engine.js';

export const LEVELS = { EASY: 1, NORMAL: 2, HARD: 3 };
export const LEVEL_NAMES = { 1: '新手', 2: '普通', 3: '高手' };

const isHonor = (id) => id >= 27;
const W_MELD = 10, W_PARTIAL = 3, W_PAIR = 4;

// Max structural value of arranging counts into up to meldsLeft melds + partials
// + one pair (a coarse shanten proxy). Memoized per call.
function structScore(counts, meldsLeft, wantPair, memo) {
  if (meldsLeft <= 0 && !wantPair) return 0;
  const key = counts.join('') + meldsLeft + (wantPair ? 1 : 0);
  const c = memo.get(key); if (c !== undefined) return c;
  let k = -1;
  for (let i = 0; i < KINDS; i++) if (counts[i] > 0) { k = i; break; }
  if (k === -1) { memo.set(key, 0); return 0; }
  let best = 0;
  const cc = counts.slice();
  cc[k]--; best = Math.max(best, structScore(cc, meldsLeft, wantPair, memo)); cc[k]++; // float
  if (meldsLeft > 0) {
    if (counts[k] >= 3) { cc[k] -= 3; best = Math.max(best, W_MELD + structScore(cc, meldsLeft - 1, wantPair, memo)); cc[k] += 3; }
    if (isNumberSuit(k)) {
      const [, gEnd] = groupOf(k);
      if (k + 2 <= gEnd && counts[k + 1] && counts[k + 2]) { cc[k]--; cc[k + 1]--; cc[k + 2]--; best = Math.max(best, W_MELD + structScore(cc, meldsLeft - 1, wantPair, memo)); cc[k]++; cc[k + 1]++; cc[k + 2]++; }
    }
    if (counts[k] >= 2) { cc[k] -= 2; best = Math.max(best, W_PARTIAL + structScore(cc, meldsLeft - 1, wantPair, memo)); cc[k] += 2; }
    if (isNumberSuit(k)) {
      const [, gEnd] = groupOf(k);
      for (const d of [1, 2]) if (k + d <= gEnd && counts[k + d]) { cc[k]--; cc[k + d]--; best = Math.max(best, W_PARTIAL + structScore(cc, meldsLeft - 1, wantPair, memo)); cc[k]++; cc[k + d]++; }
    }
  }
  if (wantPair && counts[k] >= 2) { cc[k] -= 2; best = Math.max(best, W_PAIR + structScore(cc, meldsLeft, false, memo)); cc[k] += 2; }
  memo.set(key, best);
  return best;
}

function evalHand(hand, needMelds) { return structScore(toCounts(hand), needMelds, true, new Map()); }

function isTenpai(hand, needMelds) {
  const counts = toCounts(hand);
  for (let k = 0; k < KINDS; k++) {
    counts[k]++;
    const win = needMelds * W_MELD + W_PAIR;
    if (structScore(counts, needMelds, true, new Map()) >= win) { counts[k]--; return true; }
    counts[k]--;
  }
  return false;
}

// The suit a hand is leaning toward (for flush) — the number suit with the most
// tiles; honors always help a flush, so they don't count against it.
function dominantSuit(hand) {
  const c = { m: 0, p: 0, s: 0 };
  for (const id of hand) if (isNumberSuit(id)) c[suitOf(id)]++;
  return ['m', 'p', 's'].reduce((a, b) => (c[a] >= c[b] ? a : b));
}
function fanBias(id, dom, ctx) {
  let b = 0;
  if (isNumberSuit(id)) { if (suitOf(id) === dom) b += 1.2; else b -= 0.8; } // concentrate one suit
  else { b += 1.5; if (id >= 31) b += 0.6; else if (id - 27 === ctx.roundWind || id - 27 === ctx.seatWind) b += 0.8; }
  return b;
}

export function chooseDiscard(game, player, level, rng = Math.random) {
  const hand = game.hands[player];
  const needMelds = 4 - game.melds[player].length;
  const cands = [...new Set(hand)];
  if (level === LEVELS.EASY && rng() < 0.5) { // weak: dump the least-connected tile
    const counts = toCounts(hand);
    let worst = cands[0], ws = Infinity;
    for (const c of cands) {
      const adj = isNumberSuit(c) ? (counts[c] - 1) + (counts[c - 1] ? 1 : 0) + (counts[c + 1] ? 1 : 0) : (counts[c] - 1) * 2;
      if (adj < ws) { ws = adj; worst = c; }
    }
    return worst;
  }
  const dom = dominantSuit(hand);
  const ctx = { roundWind: game.roundWind, seatWind: game.seatWind(player) };
  let best = cands[0], bestVal = -Infinity;
  for (const c of cands) {
    const rest = hand.slice(); rest.splice(rest.indexOf(c), 1);
    let val = evalHand(rest, needMelds);
    if (level >= LEVELS.NORMAL && isTenpai(rest, needMelds)) val += 100;
    if (level >= LEVELS.NORMAL) val -= fanBias(c, dom, ctx); // keep fan-building tiles
    if (level === LEVELS.NORMAL) val += (rng() - 0.5) * 0.4;
    if (val > bestVal) { bestVal = val; best = c; }
  }
  return best;
}

// Decide a claim. Returns { take:true, option? } or { take:false }. `claim` is
// the engine's current offer ({ type, kind, options? }).
export function chooseClaim(game, player, claim, level, rng = Math.random) {
  if (claim.type === 'win') return { take: true }; // engine only offers ≥8-fan wins
  if (level === LEVELS.EASY) {
    if (claim.type === 'chow') return { take: false };
    return { take: rng() < 0.3, option: undefined };
  }
  const hand = game.hands[player];
  const exposed = game.melds[player].length;
  const before = evalHand(hand, 4 - exposed);
  const dom = dominantSuit(hand);
  const ctx = { roundWind: game.roundWind, seatWind: game.seatWind(player) };

  if (claim.type === 'chow') {
    let best = null, bestGain = -Infinity;
    for (const opt of claim.options) {
      const after = hand.slice();
      for (const t of opt) after.splice(after.indexOf(t), 1);
      const gain = evalHand(after, 4 - exposed - 1) + W_MELD - before;
      if (gain > bestGain) { bestGain = gain; best = opt; }
    }
    // chow loses concealment (no 门前清/不求人); only take if it clearly helps and
    // the tile fits the flush plan.
    const fits = isNumberSuit(claim.kind) && suitOf(claim.kind) === dom;
    const margin = level >= LEVELS.HARD ? (fits ? -0.5 : 1.5) : 0.5;
    return bestGain >= margin ? { take: true, option: best } : { take: false };
  }
  // pung / kong
  const after = hand.slice();
  const take = claim.type === 'kong' ? 3 : 2;
  for (let i = 0; i < take; i++) after.splice(after.indexOf(claim.kind), 1);
  const gain = evalHand(after, 4 - exposed - 1) + W_MELD - before;
  const fanTile = isHonor(claim.kind) || !isNumberSuit(claim.kind);
  const bonus = fanTile ? 1.5 : 0;                 // honor pungs are worth fan
  const margin = level >= LEVELS.HARD ? 0.5 : -0.5;
  return (gain + bonus) >= margin ? { take: true } : { take: false };
}

export function chooseSelfKong(game, player, level, rng = Math.random) {
  const opts = game.selfKongOptions(player);
  if (!opts.length) return null;
  if (level === LEVELS.EASY) return rng() < 0.5 ? opts[0].kind : null;
  return isTenpai(game.hands[player], 4 - game.melds[player].length) && level < LEVELS.HARD
    ? (rng() < 0.5 ? opts[0].kind : null) : opts[0].kind;
}
