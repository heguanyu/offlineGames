// Computer opponents for Tianjin mahjong. Production always uses HARD; EASY/NORMAL remain as
// deterministic baselines for AI regression tests. Decisions: which tile to discard, whether to
// claim a 碰/杠 off a discard, and whether to self-kong.
//
// All levels share one hand evaluator (structScore + tenpai detection); the
// levels differ in how much they trust it, how aggressively they claim, and
// whether they steer toward high-fan shapes (本混龙 / 捉五).
import {
  KINDS, toCounts, isNumberSuit, suitOf, groupOf, isWinningHand, analyzeWin,
} from './engine.js';

export const LEVELS = { EASY: 1, NORMAL: 2, HARD: 3 };

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

// ---- tile counting: what the bot can still draw -----------------------------
// Everything VISIBLE to this player — its own hand, every meld + discard (both public), and the
// round indicator. Other players' concealed hands are unknown, so remaining[k] is an upper bound.
function liveCounts(game, player) {
  const seen = new Array(KINDS).fill(0);
  for (const id of game.hands[player]) seen[id]++;
  for (let p = 0; p < 4; p++) {
    for (const id of game.discards[p]) seen[id]++;
    for (const m of game.melds[p]) for (const id of m.tiles) seen[id]++;
  }
  if (game.indicator != null) seen[game.indicator]++;
  const rem = seen.map((c) => Math.max(0, 4 - c));
  let wilds = 0; for (const w of game.wilds) wilds += rem[w];
  return { rem, wilds };
}

// Tianjin "tenpai" must be both structurally complete AND worth the 2-fan minimum. A plain hand
// that uses a 混儿 inside an ordinary meld may be shape-ready but is still 小和 and cannot win.
// Probe only structural waits with the authoritative scorer, then weight legal waits by remaining
// live copies. `afterKong` makes the immediate replacement draw eligible for 杠开.
function scoringTenpaiLive(hand, game, player, melds, rem, afterKong = false) {
  const needMelds = 4 - melds.length;
  let waits = 0, kinds = 0;
  for (let k = 0; k < KINDS; k++) {
    if (rem[k] <= 0) continue;
    const drawn = hand.concat(k);
    const { natural, jokers } = split(drawn, game.wildSet);
    if (!isWinningHand(natural, jokers, needMelds)) continue;
    const win = analyzeWin(drawn, melds, {
      wilds: game.wilds, winningKind: k, wildSuit: game.wildSuit,
      afterKong, tianOrDi: false, dealerWin: player === game.dealer,
    });
    if (win) { waits += rem[k]; kinds++; }
  }
  return { tenpai: waits > 0, waits, kinds };
}

// Live tile-acceptance below tenpai: how many LIVE tiles raise the hand's structure value, weighted
// by how many remain — the availability-aware efficiency the bot maximises. One shared memo speeds
// the per-tile structScore probes.
function ukeireLive(natural, jokers, needMelds, wildSet, rem, liveWilds) {
  const counts = toCounts(natural), memo = new Map();
  const base = structScore(counts, jokers, needMelds, true, memo);
  let acc = 0;
  if (structScore(counts, jokers + 1, needMelds, true, memo) > base) acc += liveWilds;
  for (let k = 0; k < KINDS; k++) {
    if (wildSet.has(k) || rem[k] === 0) continue;
    counts[k]++;
    if (structScore(counts, jokers, needMelds, true, memo) > base) acc += rem[k];
    counts[k]--;
  }
  return acc;
}

// Small score lean toward Tianjin shapes. 捉五 and standing 混儿 stay the quickest routes to 起和;
// a 龙 lean only activates with at least seven covered ranks (counting held 混儿), so the bot does
// not wreck an efficient ordinary hand to chase a remote jackpot.
function scorePotential(natural, jokers, rem = null, wildSuit = null) {
  let s = jokers * 0.8;
  const counts = toCounts(natural);
  if (counts[3] > 0 && counts[5] > 0) s += 1.2; // 4万 (id 3) + 6万 (id 5) → 捉五
  for (const base of [0, 9, 18]) {
    let covered = 0, missingLive = true;
    for (let k = base; k < base + 9; k++) {
      if (counts[k] > 0) covered++;
      else if (rem && rem[k] <= 0) missingLive = false;
    }
    const effective = Math.min(9, covered + jokers);
    if (effective >= 7 && missingLive) {
      s += (effective - 6) * 0.35;
      if (wildSuit && suitOf(base) === wildSuit) s += 0.25; // 本混龙 tie-break
    }
  }
  return s;
}

function positionQuality(hand, game, player, melds, live, afterKong = false) {
  const needMelds = 4 - melds.length;
  const { natural, jokers } = split(hand, game.wildSet);
  const base = structScore(toCounts(natural), jokers, needMelds, true, new Map()) + melds.length * W_MELD;
  const t = scoringTenpaiLive(hand, game, player, melds, live.rem, afterKong);
  const uke = t.tenpai ? 0 : ukeireLive(natural, jokers, needMelds, game.wildSet, live.rem, live.wilds);
  return {
    tenpai: t.tenpai, live: t.waits, kinds: t.kinds, base, uke,
    sp: scorePotential(natural, jokers, live.rem, game.wildSuit),
  };
}

function compareQuality(a, b) {
  return (a.tenpai - b.tenpai) ||
    (a.tenpai ? (a.live - b.live) || (a.kinds - b.kinds) || (a.sp - b.sp)
              : (a.base - b.base) || (a.uke - b.uke) || (a.sp - b.sp));
}

function rngPick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

// Choose a tile to discard from the current player's 14-tile hand. Never a wild. NORMAL/HARD weigh
// hand efficiency, tile AVAILABILITY (live outs — don't chase dead tiles) and SCORE potential (steer
// toward 捉五 / 龙 / 双混); HARD also folds in availability-aware acceptance below tenpai.
export function chooseDiscard(game, player, level, rng = Math.random) {
  const hand = game.hands[player];
  const wildSet = game.wildSet;
  const needMelds = 4 - game.melds[player].length;
  const candidates = [...new Set(hand.filter((t) => !wildSet.has(t)))];
  if (candidates.length === 0) return null; // an all-混儿 concealed hand — the caller should declare the win

  // EASY: dump the least-connected tile, with the occasional random slip.
  if (level === LEVELS.EASY) {
    const counts = toCounts(hand);
    let worst = candidates[0], worstScore = Infinity;
    for (const c of candidates) {
      const adj = isNumberSuit(c)
        ? (counts[c] - 1) + (counts[c - 1] ? 1 : 0) + (counts[c + 1] ? 1 : 0)
        : (counts[c] - 1) * 2;
      if (adj < worstScore) { worstScore = adj; worst = c; }
    }
    return rng() < 0.35 ? rngPick(candidates, rng) : worst;
  }

  // NORMAL: solid efficiency — keep the shape worth most, prefer tenpai, with a little noise.
  if (level < LEVELS.HARD) {
    let best = null, bestVal = -Infinity;
    for (const c of candidates) {
      const rest = hand.slice(); rest.splice(rest.indexOf(c), 1);
      let val = evalHand(rest, wildSet, needMelds);
      const t = tenpaiInfo(rest, wildSet, needMelds);
      if (t.tenpai) val += 100 + t.waits * 3;
      val += (rng() - 0.5) * 0.6;
      if (val > bestVal) { bestVal = val; best = c; }
    }
    return best;
  }

  // HARD: a clean lexicographic choice so availability + score never cost a win. Rank residual hands:
  //   tenpai over not → among tenpai, the WIDEST LIVE wait (most outs still in the wall, counting 混儿
  //   — never a dead wait) → among non-tenpai, lowest shanten (structScore) then most LIVE acceptance
  //   (the discard-aware efficiency) → finally a small score lean (混吊 / 捉五) breaks remaining ties.
  const { rem, wilds: liveWilds } = liveCounts(game, player);
  const cands = candidates.map((c) => {
    const rest = hand.slice(); rest.splice(rest.indexOf(c), 1);
    const { natural, jokers } = split(rest, wildSet);
    const base = structScore(toCounts(natural), jokers, needMelds, true, new Map());
    const t = scoringTenpaiLive(rest, game, player, game.melds[player], rem, false);
    return {
      c, natural, jokers, base, tenpai: t.tenpai, live: t.waits, kinds: t.kinds,
      sp: scorePotential(natural, jokers, rem, game.wildSuit), uke: 0,
      claimRisk: rem[c], // fewer unseen copies → less chance this discard feeds a 碰/杠
    };
  });
  if (!cands.some((x) => x.tenpai)) { // ukeire only matters below tenpai — compute it for the top shapes
    const maxBase = Math.max(...cands.map((x) => x.base));
    for (const x of cands) if (x.base >= maxBase - 3) x.uke = ukeireLive(x.natural, x.jokers, needMelds, wildSet, rem, liveWilds);
  }
  cands.sort((a, b) =>
    (b.tenpai - a.tenpai) ||
    (a.tenpai ? (b.live - a.live) || (b.kinds - a.kinds) || (b.sp - a.sp)
              : (b.base - a.base) || (b.uke - a.uke) || (b.sp - a.sp)) ||
    (a.claimRisk - b.claimRisk));
  return cands[0].c;
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

  // Keep NORMAL as the stable internal baseline used by the strength tests.
  if (level < LEVELS.HARD) {
    const before = evalHand(hand, wildSet, 4 - exposed);
    const after = hand.slice();
    for (let i = 0; i < 2; i++) after.splice(after.indexOf(claim.kind), 1);
    const needMelds = 4 - (exposed + 1);
    let bestAfter = -Infinity;
    const cands = [...new Set(after.filter((t) => !wildSet.has(t)))];
    for (const c of cands.length ? cands : [null]) {
      const rest = after.slice();
      if (c !== null) rest.splice(rest.indexOf(c), 1);
      bestAfter = Math.max(bestAfter, evalHand(rest, wildSet, needMelds) + W_MELD);
    }
    if (bestAfter >= before - 0.5) return claim.options.includes('kong') ? 'kong' : 'pung';
    return null;
  }

  const live = liveCounts(game, player);
  const beforeQ = positionQuality(hand, game, player, game.melds[player], live, false);

  // Pung: take two copies, expose the meld, then choose the best mandatory discard.
  const pungHand = hand.slice();
  for (let i = 0; i < 2; i++) pungHand.splice(pungHand.indexOf(claim.kind), 1);
  const pungMelds = game.melds[player].concat({ type: 'pung', kind: claim.kind, tiles: [claim.kind, claim.kind, claim.kind] });
  let pungQ = null;
  for (const c of [...new Set(pungHand.filter((t) => !wildSet.has(t)))]) {
    const rest = pungHand.slice(); rest.splice(rest.indexOf(c), 1);
    const q = positionQuality(rest, game, player, pungMelds, live, false);
    if (!pungQ || compareQuality(q, pungQ) > 0) pungQ = q;
  }

  // Discard-kong is NOT a pung simulation: it consumes all three concealed copies, then receives
  // a replacement draw. The remaining hand is already at its stable post-discard size.
  let kongQ = null;
  if (claim.options.includes('kong')) {
    const kongHand = hand.slice();
    for (let i = 0; i < 3; i++) kongHand.splice(kongHand.indexOf(claim.kind), 1);
    const kongMelds = game.melds[player].concat({ type: 'kong', kind: claim.kind, tiles: [claim.kind, claim.kind, claim.kind, claim.kind] });
    kongQ = positionQuality(kongHand, game, player, kongMelds, live, true);
  }

  const keepsTenpai = (q) => !beforeQ.tenpai || !!q?.tenpai;
  const pungOK = !!pungQ && keepsTenpai(pungQ) && compareQuality(pungQ, beforeQ) > 0;
  // A kong's guaranteed points + replacement draw justify an equal shape, but not destroying a
  // ready hand. If both actions work, take the one with the better actual post-claim position.
  const kongOK = !!kongQ && keepsTenpai(kongQ) && (beforeQ.tenpai || compareQuality(kongQ, beforeQ) >= 0);
  if (pungOK && kongOK) return compareQuality(kongQ, pungQ) >= 0 ? 'kong' : 'pung';
  if (kongOK) return 'kong';
  if (pungOK) return 'pung';
  return null;
}

// Decide whether to declare a self-kong on your turn. Returns the kind or null.
export function chooseSelfKong(game, player, level, rng = Math.random) {
  // Bots never 金杠 — konging away four 混儿 is almost always a losing play; only a
  // human would choose it deliberately.
  const opts = game.selfKongOptions(player).filter((o) => o.type !== 'gold');
  if (opts.length === 0) return null;
  if (level === LEVELS.EASY) return rng() < 0.5 ? rngPick(opts, rng).kind : null;
  if (level < LEVELS.HARD) {
    // Stable internal baseline: usually take the replacement draw and kong points.
    const t = tenpaiInfo(game.hands[player], game.wildSet, 4 - game.melds[player].length);
    if (!t.tenpai) return opts[0].kind;
    return rng() < 0.5 ? opts[0].kind : null;
  }

  const live = liveCounts(game, player);
  // Compare against the real 13-tile state after the best ordinary discard; the old code passed
  // the 14-tile turn hand to tenpaiInfo(), so its supposed "don't break tenpai" guard never worked.
  const ordinaryDiscard = chooseDiscard(game, player, LEVELS.HARD, rng);
  const ordinary = game.hands[player].slice();
  if (ordinaryDiscard != null) ordinary.splice(ordinary.indexOf(ordinaryDiscard), 1);
  const beforeQ = positionQuality(ordinary, game, player, game.melds[player], live, false);

  let best = null;
  for (const opt of opts) {
    const hand = game.hands[player].slice();
    const melds = game.melds[player].map((m) => ({ ...m, tiles: m.tiles.slice() }));
    let points;
    if (opt.type === 'added') {
      hand.splice(hand.indexOf(opt.kind), 1);
      const pung = melds.find((m) => m.type === 'pung' && m.kind === opt.kind);
      if (!pung) continue;
      pung.type = 'kong'; pung.tiles = [opt.kind, opt.kind, opt.kind, opt.kind]; points = 1;
    } else {
      for (let i = 0; i < 4; i++) hand.splice(hand.indexOf(opt.kind), 1);
      melds.push({ type: 'kong', kind: opt.kind, tiles: [opt.kind, opt.kind, opt.kind, opt.kind], concealed: true });
      points = 2;
    }
    const q = positionQuality(hand, game, player, melds, live, true);
    // Keep every legal wait when already ready. Outside tenpai, accept only a shape that is no
    // worse; the fixed kong points and immediate 杠开 draw break an otherwise equal tie.
    const viable = beforeQ.tenpai ? q.tenpai : compareQuality(q, beforeQ) >= 0;
    if (!viable) continue;
    if (!best || compareQuality(q, best.q) > 0 || (compareQuality(q, best.q) === 0 && points > best.points)) best = { opt, q, points };
  }
  return best ? best.opt.kind : null;
}
