// 天津麻将 ruleset — the game-specific half of an online Table. The generic Table
// (server/table.js) owns the transport, the per-seat awaits/timeouts, the deal/拉庄/下一局
// orchestration and the 锅/圈 match flow; everything that differs between games lives here:
// the engine + AI, the pre-hand 拉庄 decision, the claim protocol, the redacted per-seat view
// and the result serialization. 国标 supplies the same shape (server/rulesets/guobiao.js), so
// adding it online is "write a ruleset", not "fork the server".
import { Game, PHASE } from '../../games/mahjong-tianjin/engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong } from '../../games/mahjong-tianjin/ai.js';

// Strip the win result to JSON-safe fields. decomp's per-group `natural` is a Set → send it as an
// array; the client rebuilds the Set so the result modal can render the winning hand pattern.
function safeResult(r) {
  if (!r) return null;
  return { type: r.type, winner: r.winner, score: r.score, fans: r.fans,
    winningTile: r.winningTile, payments: r.payments, kong: r.kong, kongPts: r.kongPts,
    decomp: r.decomp ? r.decomp.map((g) => ({ type: g.type, kinds: g.kinds, jokers: g.jokers, natural: g.natural ? [...g.natural] : [] })) : null,
    meta: r.meta ? { winGroupIdx: r.meta.winGroupIdx, long: r.meta.long, longSuit: r.meta.longSuit } : null };
}

export const ruleset = {
  id: 'tianjin',
  PHASE,

  newGame({ dealer, prevailingWind, scores, seatBase }) {
    return new Game({ dealer, prevailingWind, scores, seatBase, laZhuang: [] });
  },
  restore(s) { return Game.restore(s); },
  serialize(g) { return g.serialize(); },
  safeResult,

  // ---- pre-hand 拉庄 (blind double-down, AFTER the deal) -------------------------------------
  // base gamble 25%, but only 10% when the 庄 plays right after this bot (its 下家 is the 庄), since
  // the bot feeds the 庄 directly. The Table collects the human answers; this only decides the bots
  // and records the final challenger set on the game.
  preHand: {
    botOptIn(seat, dealer) { return Math.random() < (dealer === (seat + 1) % 4 ? 0.10 : 0.25); },
    apply(game, challengers) { game.laZhuang = challengers.slice().sort((a, b) => a - b); },
  },

  // ---- claim protocol (single claim: at most one 碰/杠 off a discard) ------------------------
  claimSeat(g) { return g.claim.player; },
  humanClaim(g, m) {
    const p = g.claim.player, kind = g.claim.kind;
    if (m && m.do === 'claim' && g.claim.options.includes(m.claim)) { g.claimDiscard(m.claim); return { t: 'claim', player: p, claim: m.claim, kind }; }
    g.passClaim(); return null;
  },
  botClaim(g, level) {
    const c = g.claim, p = c.player, kind = c.kind;
    const dec = chooseClaim(g, p, c, level);
    if (dec) { g.claimDiscard(dec); return { t: 'claim', player: p, claim: dec, kind }; }
    g.passClaim(); return null;
  },

  // ---- bot turn (AWAIT_DISCARD): take a self-draw win, else 自杠, else discard ----------------
  botTurn(g, p, level) {
    if (g.selfDrawWin) { g.declareWin(); return null; } // → OVER; the loop emits 'over'
    const kong = chooseSelfKong(g, p, level);
    if (kong !== null) { g.selfKong(p, kong); return { t: 'selfKong', player: p, kind: kong }; }
    const t = chooseDiscard(g, p, level);
    g.discard(p, t); return { t: 'discard', player: p, tile: t };
  },

  // ---- redacted per-seat view -----------------------------------------------------------------
  viewFor(t, seat) {
    const g = t.game;
    const base = {
      yourSeat: seat, scores: t.scores, dealer: t.dealer, prevailingWind: t.prevailingWind,
      seatBase: t.seatBase, rounds: t.rounds,
      seatNames: t.seats.map((s) => (s.name || '机器人')), // bots carry a seat-based name (东方雨…)
      seatKinds: t.seats.map((s) => s.kind),
    };
    if (!g) return base;
    // own hand always; everyone's revealed at the showdown (OVER) for the result modal. EXCEPT a
    // seat still in _lzPending sees its own hand as backs too — blind 拉庄 over the dealt hand. The
    // 混儿 (wilds + indicator) is part of the hand "starting", so it's withheld from that seat too.
    const hideOwn = t._lzPending && t._lzPending.has(seat);
    const hand = (p) => (((p === seat && !hideOwn) || g.phase === PHASE.OVER) ? g.hands[p].slice() : g.hands[p].map(() => -1));
    return {
      ...base,
      phase: g.phase, turn: g.turn, dealer: g.dealer,
      wilds: hideOwn ? [] : g.wilds, indicator: hideOwn ? null : g.indicator,
      scores: g.scores, wallCount: g.wall.length, laZhuang: g.laZhuang, dealerDouble: g.dealerDouble,
      hands: [0, 1, 2, 3].map(hand),
      melds: g.melds, discards: g.discards, discardLog: g.discardLog,
      lastDiscard: g.lastDiscard || null, // public: who discarded the tile on the table (for the claim hint)
      drawnTile: seat === g.turn ? g.drawnTile : null,
      claim: g.claim ? (g.claim.player === seat ? g.claim : { player: g.claim.player }) : null,
      canWin: seat === g.turn && !!g.selfDrawWin,
      winInfo: seat === g.turn && g.selfDrawWin ? { score: g.selfDrawWin.score, fans: g.selfDrawWin.fans } : null,
      result: safeResult(g.result),
    };
  },
};
