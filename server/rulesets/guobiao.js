// 国标麻将 (MCR) ruleset — the game-specific half of an online Table, mirroring
// server/rulesets/tianjin.js. Differences from 天津: a priority claim QUEUE (胡 > 碰/杠 > 吃)
// with 吃 (chow) and wins off a discard (点炮); no 拉庄 (no pre-hand decision); no 混儿. The
// generic Table drives the same deal / 下一局 / 锅-圈 loop around these hooks.
import { Game, PHASE, MIN_FAN } from '../../games/guobiao/engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong } from '../../games/guobiao/ai.js';

// 国标 results are already plain JSON (no Sets) — copy the fields the client renders.
function safeResult(r) {
  if (!r) return null;
  return { type: r.type, winner: r.winner, fan: r.fan, fans: r.fans, melds: r.melds, pair: r.pair,
    byDiscard: r.byDiscard, payer: r.payer, winningTile: r.winningTile, payments: r.payments };
}

export const ruleset = {
  id: 'guobiao',
  PHASE,
  minFan: MIN_FAN, // 8 for standard MCR; the 无定番 variant (freeRuleset below) overrides to 0

  // `prevailingWind` is the Table's generic round-wind counter → the 国标 engine's roundWind.
  newGame({ dealer, prevailingWind, scores }) {
    return new Game({ dealer, roundWind: prevailingWind, scores, minFan: this.minFan });
  },
  restore(s) { return Game.restore(s); },
  serialize(g) { return g.serialize(); },
  safeResult,

  preHand: null, // 国标 has no 拉庄

  // ---- claim protocol (priority queue; head offer is decided take/pass) ----------------------
  claimSeat(g) { return g.currentClaim().player; },
  humanClaim(g, m) {
    const c = g.currentClaim(), p = c.player, kind = g.lastDiscard ? g.lastDiscard.kind : c.kind;
    if (m && m.do === 'claim') {
      if (c.type === 'win') { g.claimTake(); return null; }                 // 点炮 → OVER; loop emits 'over'
      g.claimTake(c.type === 'chow' ? (m.option || c.options[0]) : undefined);
      return { t: 'claim', player: p, claim: c.type, kind };
    }
    g.claimPass(); return null;
  },
  botClaim(g, level) {
    const c = g.currentClaim(), p = c.player, kind = g.lastDiscard ? g.lastDiscard.kind : c.kind;
    const dec = chooseClaim(g, p, c, level);
    if (dec && dec.take) {
      if (c.type === 'win') { g.claimTake(); return null; }
      g.claimTake(c.type === 'chow' ? dec.option : undefined);
      return { t: 'claim', player: p, claim: c.type, kind };
    }
    g.claimPass(); return null;
  },

  botTurn(g, p, level) {
    if (g.selfDrawWin) { g.declareWin(); return null; }
    const kong = chooseSelfKong(g, p, level);
    if (kong !== null) { g.selfKong(p, kong); return { t: 'selfKong', player: p, kind: kong }; }
    const t = chooseDiscard(g, p, level);
    g.discard(p, t); return { t: 'discard', player: p, tile: t };
  },

  viewFor(t, seat) {
    const g = t.game;
    const base = {
      yourSeat: seat, scores: t.scores, dealer: t.dealer, roundWind: t.prevailingWind, rounds: t.rounds,
      seatNames: t.seats.map((s) => (s.name || '机器人')), // bots carry a seat-based name (东方雨…)
      seatKinds: t.seats.map((s) => s.kind),
    };
    if (!g) return base;
    const hand = (p) => ((p === seat || g.phase === PHASE.OVER) ? g.hands[p].slice() : g.hands[p].map(() => -1));
    const head = g.claimQueue && g.claimQueue[0];
    return {
      ...base,
      phase: g.phase, turn: g.turn, dealer: g.dealer, minFan: g.minFan,
      scores: g.scores, wallCount: g.wall.length,
      hands: [0, 1, 2, 3].map(hand),
      melds: g.melds, discards: g.discards, discardLog: g.discardLog,
      lastDiscard: g.lastDiscard || null,
      drawnTile: seat === g.turn ? g.drawnTile : null,
      // the head claim, full to the seat that may take it (carries chow options / win score), just
      // the player to everyone else (so the table knows who's deciding).
      claim: head ? (head.player === seat ? head : { player: head.player }) : null,
      canWin: seat === g.turn && !!g.selfDrawWin,
      winInfo: seat === g.turn && g.selfDrawWin ? { fan: g.selfDrawWin.fan, fans: g.selfDrawWin.fans } : null,
      result: safeResult(g.result),
    };
  },
};

// 无定番 (no-minimum) MCR — identical rules, but any fan count (incl. 0) may win. Same methods; only
// minFan differs (newGame reads this.minFan). The 国标 engine charges just the actual fan with no floor.
export const freeRuleset = { ...ruleset, id: 'guobiao-free', minFan: 0 };
