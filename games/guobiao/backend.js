// 国标麻将 game BACKEND boundary — the 国标 counterpart of games/mahjong-tianjin/backend.js, so
// guobiao/main.js talks to a Backend instead of the engine directly and going online is a config
// flip. Same UI ↔ Backend contract; the differences from 天津 are the game's: a priority claim
// QUEUE with 吃 (chow) and wins off a discard (点炮), no 拉庄 (no pre-hand decision), no 混儿.
//
// Events pushed to the UI: 'deal' / 'discard' / 'claim' / 'selfKong' / 'await' / 'over'
// (+ 'sync' / 'potOver' / 'disconnected' / 'gameGone' online). There is no 'lazhuang'.
import { Game, PHASE } from './engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong } from './ai.js';
import { RemoteBackendBase } from '../mahjong-common/remote-backend.js';

export const HUMAN = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBackend(config = {}) {
  switch (config.mode || 'local') {
    case 'local':  return new LocalBackend(config);
    case 'remote': return new RemoteBackend(config);
    default: throw new Error('unknown backend mode: ' + config.mode);
  }
}

// ---------------------------------------------------------------------------
// LocalBackend — the 国标 engine + AI as an in-process "server" (offline play). A bot's
// "thinking" is a simulated delay, standing in for online latency, so the table is paced the
// same whether local or remote.
// ---------------------------------------------------------------------------
export class LocalBackend {
  constructor(config = {}) {
    this.rng = config.rng || Math.random;
    this.level = config.level ?? 2;
    this.thinkDelay = config.thinkDelay ?? 600;
    this._game = null;
    this._handler = null;
    this._gen = 0; // bumped each hand; a stale auto-advance loop bails when it changes
  }

  onEvent(handler) { this._handler = handler; }
  getState() { return this._game; }
  dispose() { this._gen++; this._handler = null; }

  async _emit(ev) { if (this._handler) await this._handler(ev); }

  // Deal and play one hand. cfg: { dealer, roundWind, scores, minFan, baseScore, level }.
  async startHand(cfg) {
    const gen = ++this._gen;
    if (cfg.level != null) this.level = cfg.level;
    this._game = new Game({ rng: this.rng, dealer: cfg.dealer, roundWind: cfg.roundWind, scores: cfg.scores, minFan: cfg.minFan, baseScore: cfg.baseScore });
    await this._emit({ type: 'deal' });
    if (gen !== this._gen) return;
    await this._advance(gen);
  }

  // ---- human actions: validate against the live game, apply, then auto-advance ----
  async discard(tile) {
    const g = this._game;
    if (!g || g.turn !== HUMAN || g.phase !== PHASE.AWAIT_DISCARD) return;
    if (!g.hands[HUMAN].includes(tile)) return;
    g.discard(HUMAN, tile);
    await this._emit({ type: 'discard', player: HUMAN, tile, discardIndex: g.discardLog.length - 1 });
    await this._advance(this._gen);
  }
  // Take the head claim (the one offered to the human): a 碰/杠/吃, or a 点炮 win. `option` is the
  // chosen 吃 run (the two hand tiles) when claimType === 'chow'.
  async claim(type, option) {
    const g = this._game;
    if (!g || g.phase !== PHASE.AWAIT_CLAIM) return;
    const c = g.currentClaim();
    if (!c || c.player !== HUMAN) return;
    if (c.type === 'win') { g.claimTake(); await this._advance(this._gen); return; } // → OVER
    const kind = g.lastDiscard.kind;
    g.claimTake(c.type === 'chow' ? (option || c.options[0]) : undefined);
    await this._emit({ type: 'claim', player: HUMAN, claimType: c.type, kind });
    await this._advance(this._gen);
  }
  async pass() {
    const g = this._game;
    if (!g || g.phase !== PHASE.AWAIT_CLAIM) return;
    g.claimPass();
    await this._advance(this._gen);
  }
  async selfKong(kind) {
    const g = this._game;
    if (!g || g.turn !== HUMAN || g.phase !== PHASE.AWAIT_DISCARD) return;
    g.selfKong(HUMAN, kind);
    await this._emit({ type: 'selfKong', player: HUMAN, kind });
    await this._advance(this._gen);
  }
  async declareWin() {
    const g = this._game;
    if (!g || !g.selfDrawWin) return;
    g.declareWin();
    await this._advance(this._gen);
  }

  // Drive the opponents (with a think delay each) until the human must act or the hand ends,
  // emitting one event per move. `gen` pins this loop to its hand: a new hand bumps _gen, so a
  // loop that was mid-delay bails instead of touching the new game.
  async _advance(gen) {
    const g = this._game;
    for (;;) {
      if (gen !== this._gen) return;
      if (g.phase === PHASE.OVER) { await this._emit({ type: 'over', result: g.result }); return; }
      if (g.phase === PHASE.AWAIT_CLAIM) {
        const c = g.currentClaim();
        if (c.player === HUMAN) { await this._emit({ type: 'await', who: 'claim' }); return; }
        await delay(this.thinkDelay); if (gen !== this._gen) return;
        const dec = chooseClaim(g, c.player, c, this.level, this.rng);
        if (dec && dec.take) {
          if (c.type === 'win') { g.claimTake(); continue; }              // bot takes a 点炮 win → OVER
          const kind = g.lastDiscard.kind;
          g.claimTake(c.type === 'chow' ? dec.option : undefined);
          await this._emit({ type: 'claim', player: c.player, claimType: c.type, kind });
        } else g.claimPass();
        continue;
      }
      // AWAIT_DISCARD
      if (g.turn === HUMAN) { await this._emit({ type: 'await', who: 'discard' }); return; }
      await delay(this.thinkDelay); if (gen !== this._gen) return;
      const p = g.turn;
      if (g.selfDrawWin) { g.declareWin(); continue; }                     // bot takes its self-draw win → OVER
      const kong = chooseSelfKong(g, p, this.level, this.rng);
      if (kong !== null) { g.selfKong(p, kong); await this._emit({ type: 'selfKong', player: p, kind: kong }); continue; }
      const dt = chooseDiscard(g, p, this.level, this.rng);
      g.discard(p, dt);
      await this._emit({ type: 'discard', player: p, tile: dt, discardIndex: g.discardLog.length - 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// RemoteBackend — online 国标 over the shared transport (RemoteBackendBase) with 国标 mappers.
// ---------------------------------------------------------------------------
export class RemoteBackend extends RemoteBackendBase {
  constructor(config = {}) {
    super(config, { buildView: buildRemoteView, mapEvent: mapServerEvent });
  }
}

// Rotate a server view (absolute seats) to the player's perspective and rebuild a GameView carrying
// the 国标 engine's helper methods (seatWind / isWild / currentClaim / selfKongOptions / tenpaiInfo),
// so the UI renders it exactly like a local Game. `c` is the player's absolute seat.
export function buildRemoteView(sv, c) {
  const rot = (p) => (p - c + 4) % 4;
  const byD = (arr) => (arr ? [0, 1, 2, 3].map((d) => arr[(c + d) % 4]) : arr);
  // result melds/pair/winningTile are tile KINDS (not seat-relative) — only the seats rotate.
  const result = sv.result ? {
    ...sv.result, winner: rot(sv.result.winner), payer: sv.result.payer != null ? rot(sv.result.payer) : null,
    payments: byD(sv.result.payments),
  } : null;
  const head = sv.claim ? { ...sv.claim, player: rot(sv.claim.player) } : null; // chow options / win result stay (kinds)
  const snap = {
    dealer: rot(sv.dealer ?? 0), roundWind: sv.roundWind ?? 0, turn: sv.turn != null ? rot(sv.turn) : 0,
    phase: sv.phase, minFan: sv.minFan ?? 8, scores: byD(sv.scores) || [0, 0, 0, 0],
    hands: byD(sv.hands) || [[], [], [], []], melds: byD(sv.melds) || [[], [], [], []], discards: byD(sv.discards) || [[], [], [], []],
    discardLog: (sv.discardLog || []).map((e) => ({ player: rot(e.player), kind: e.kind })),
    lastDiscard: sv.lastDiscard ? { player: rot(sv.lastDiscard.player), kind: sv.lastDiscard.kind } : null,
    drawnTile: sv.drawnTile != null ? sv.drawnTile : null,
    claimQueue: head ? [head] : null, // the head offer, redacted by the server (full only to its own seat)
    selfDrawWin: sv.canWin ? (sv.winInfo || { fan: 0, fans: [] }) : null,
    result, wall: { length: sv.wallCount ?? 0 },
    seatNames: byD(sv.seatNames), seatKinds: byD(sv.seatKinds), online: true, log: [],
  };
  return Object.assign(Object.create(Game.prototype), snap);
}

// Map a server event (absolute) to the UI event guobiao/main.js's handler expects (rotated).
export function mapServerEvent(ev, c, view) {
  const rot = (p) => (p - c + 4) % 4;
  const byD = (arr) => (arr ? [0, 1, 2, 3].map((d) => arr[(c + d) % 4]) : arr);
  switch (ev.t) {
    case 'deal': return { type: 'deal' };
    case 'await': return { type: 'await', who: ev.who, timeout: ev.timeout, total: ev.total };
    case 'discard': return { type: 'discard', player: rot(ev.player), tile: ev.tile, discardIndex: view.discardLog.length - 1 };
    case 'claim': return { type: 'claim', player: rot(ev.player), claimType: ev.claim, kind: ev.kind };
    case 'selfKong': return { type: 'selfKong', player: rot(ev.player), kind: ev.kind };
    case 'over': return { type: 'over', result: view.result, readied: ev.readied, potEnd: ev.potEnd };
    case 'potOver': return { type: 'potOver', scores: byD(ev.scores), rounds: (ev.rounds || []).map((r) => ({ wind: r.wind, scores: byD(r.scores) })) };
    case 'sync': return { type: 'sync' };
    default: return null;
  }
}
