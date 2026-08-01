// The game BACKEND boundary. The UI (main.js) never touches the engine or the bots
// directly — it talks to a Backend, which owns the authoritative game, validates and
// applies moves, drives the opponents, and pushes events back. createBackend() picks the
// implementation; the UI code is identical either way, so going online is a config flip:
//
//   • LocalBackend  — runs the engine + AI in-process (this device, offline). A bot's
//     "thinking" is a simulated delay, standing in for the opponent/network latency you
//     get online, so the table is paced the same whether local or remote.
//   • RemoteBackend — (stub) the SAME contract over the wire: the action methods become
//     API/WebSocket calls and the events arrive from the server. Fill in the marked spots
//     and the UI needs no changes.
//
// The UI ↔ Backend contract:
//   - getState() → a READ-ONLY GameView the UI renders. LocalBackend hands back the live
//     Game (which already carries the fields + helper methods the UI reads — isWild,
//     seatWind, selfKongOptions, settlementFactors, …); a RemoteBackend would rebuild an
//     equivalent view from the server's JSON. The UI must treat it as read-only and never
//     mutate it — all changes go through the action methods.
//   - onEvent(handler): the backend pushes events ('lazhuang' / 'deal' / 'discard' /
//     'claim' / 'selfKong' / 'await' / 'over'). The handler is AWAITED, so the UI gets
//     backpressure to finish its animation before the next event lands (a fast server
//     can't outrun the table). For a RemoteBackend, server pushes are queued and fed
//     through the same awaited handler, so the UI sequencing is unchanged.
//   - the async action methods (discard / claim / pass / selfKong / declareWin) and
//     decideLaZhuang carry the human's moves. They resolve once the move is applied
//     (online: acknowledged by the server).
//
// Events:
//   { type:'lazhuang', dealer }                 human must choose 拉庄 (blind, pre-deal);
//                                               the UI answers with decideLaZhuang(yes)
//   { type:'deal' }                             a hand was dealt; play the deal animation
//   { type:'discard', player, tile, discardIndex }
//   { type:'claim',   player, claimType, kind } a 碰/杠 off the last discard
//   { type:'selfKong', player, kind }           an 暗杠/补杠/金杠 from hand
//   { type:'await', who:'discard'|'claim' }     the human must act (turn, or a claimable discard)
//   { type:'over', result }                     the hand ended

import { Game, PHASE } from './engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS } from './ai.js';
import { RemoteBackendBase } from '../mahjong-common/remote-backend.js';

export const HUMAN = 0;
const AI_LEVEL = LEVELS.HARD;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether bot `seat` 拉庄s against `dealer`. This is a SERVER-SIDE decision (the bots live behind
// the backend), so it belongs here, not in the UI. Base gamble is 25%; but if the 庄 plays right
// after this bot (its 下家 is the 庄 — e.g. bot 南, 庄 西), the bot feeds the 庄 directly, so it's
// more cautious at 10%. `rng` (defaulting to Math.random) keeps a seeded backend deterministic.
export function botLaZhuangChance(seat, dealer) { return dealer === (seat + 1) % 4 ? 0.10 : 0.25; }
export function shouldBotLaZhuang(seat, dealer, rng = Math.random) { return rng() < botLaZhuangChance(seat, dealer); }

// Pick a backend implementation. `config.mode`: 'local' (default) | 'remote'.
export function createBackend(config = {}) {
  switch (config.mode || 'local') {
    case 'local':  return new LocalBackend(config);
    case 'remote': return new RemoteBackend(config);
    default: throw new Error('unknown backend mode: ' + config.mode);
  }
}

// ---------------------------------------------------------------------------
// LocalBackend — the engine + AI as an in-process "server". This is the whole of
// the calculation layer the UI is decoupled from; lift this onto a real server and
// the RemoteBackend below talks to it with the identical contract.
// ---------------------------------------------------------------------------
export class LocalBackend {
  constructor(config = {}) {
    this.rng = config.rng || Math.random;
    this.thinkDelay = config.thinkDelay ?? 600; // bot "thinking" (the online latency stand-in)
    this._game = null;
    this._handler = null;
    this._lzResolve = null;
    this._gen = 0; // bumped each hand; a stale auto-advance loop bails when it changes
  }

  onEvent(handler) { this._handler = handler; }
  getState() { return this._game; }
  dispose() { this._gen++; this._handler = null; this._lzResolve = null; }

  // Push an event to the UI and await its handler (backpressure for animations).
  async _emit(ev) { if (this._handler) await this._handler(ev); }
  // Ask the human a question (拉庄) and suspend until decideLaZhuang() answers it. Store
  // the resolver BEFORE emitting: under FAST the UI answers synchronously inside _emit,
  // so _lzResolve must already be set or the answer would be lost.
  _ask(ev) { return new Promise((res) => { this._lzResolve = res; this._emit(ev); }); }
  decideLaZhuang(yes) { const r = this._lzResolve; this._lzResolve = null; if (r) r(yes); }

  // Deal and play one hand. cfg: { dealer, prevailingWind, scores, seatBase }.
  async startHand(cfg) {
    const gen = ++this._gen;
    // Deal FIRST (the UI refreshes to the new hand); 拉庄 is asked AFTER, still blind — the UI keeps
    // the human's own hand face-down until they answer. Each bot takes a 50% gamble (shouldBotLaZhuang).
    this._game = new Game({
      rng: this.rng,
      dealer: cfg.dealer, prevailingWind: cfg.prevailingWind,
      scores: cfg.scores, seatBase: cfg.seatBase,
      laZhuang: [],
    });
    await this._emit({ type: 'deal' });
    if (gen !== this._gen) return;
    const challengers = [];
    for (let p = 0; p < 4; p++) if (p !== cfg.dealer && p !== HUMAN && shouldBotLaZhuang(p, cfg.dealer, this.rng)) challengers.push(p);
    if (cfg.dealer !== HUMAN) {
      const yes = await this._ask({ type: 'lazhuang', dealer: cfg.dealer, need: [HUMAN], answers: {} });
      if (gen !== this._gen) return; // abandoned (e.g. 重开) while the panel was open
      if (yes) challengers.push(HUMAN);
    }
    this._game.laZhuang = challengers.sort((a, b) => a - b);
    await this._advance(gen);
  }

  // ---- human actions: validate against the live game, apply, then auto-advance ----
  async discard(tile) {
    const g = this._game;
    if (!g || g.turn !== HUMAN || g.phase !== PHASE.AWAIT_DISCARD || g.isWild(tile)) return;
    g.discard(HUMAN, tile);
    await this._emit({ type: 'discard', player: HUMAN, tile, discardIndex: g.discardLog.length - 1 });
    await this._advance(this._gen);
  }
  async claim(type) {
    const g = this._game;
    if (!g || g.phase !== PHASE.AWAIT_CLAIM || !g.claim || g.claim.player !== HUMAN) return;
    if (!g.claim.options.includes(type)) return;
    const kind = g.claim.kind;
    g.claimDiscard(type);
    await this._emit({ type: 'claim', player: HUMAN, claimType: type, kind });
    await this._advance(this._gen);
  }
  async pass() {
    const g = this._game;
    if (!g || g.phase !== PHASE.AWAIT_CLAIM) return;
    g.passClaim();
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

  // Drive the opponents (with a think delay each) until the human must act or the hand
  // ends, emitting one event per move. `gen` pins this loop to its hand: a 重开/new hand
  // bumps _gen, so a loop that was mid-delay bails instead of touching the new game.
  async _advance(gen) {
    const g = this._game;
    for (;;) {
      if (gen !== this._gen) return;
      if (g.phase === PHASE.OVER) { await this._emit({ type: 'over', result: g.result }); return; }
      if (g.phase === PHASE.AWAIT_CLAIM) {
        if (g.claim.player === HUMAN) { await this._emit({ type: 'await', who: 'claim' }); return; }
        await delay(this.thinkDelay); if (gen !== this._gen) return;
        const c = g.claim, dec = chooseClaim(g, c.player, c, AI_LEVEL, this.rng);
        if (dec) { const kind = c.kind; g.claimDiscard(dec); await this._emit({ type: 'claim', player: c.player, claimType: dec, kind }); }
        else g.passClaim();
        continue;
      }
      // AWAIT_DISCARD
      if (g.turn === HUMAN) { await this._emit({ type: 'await', who: 'discard' }); return; }
      await delay(this.thinkDelay); if (gen !== this._gen) return;
      const p = g.turn;
      if (g.selfDrawWin) { g.declareWin(); continue; }                 // bot takes its self-draw win → OVER
      const kong = chooseSelfKong(g, p, AI_LEVEL, this.rng);
      if (kong !== null) { g.selfKong(p, kong); await this._emit({ type: 'selfKong', player: p, kind: kong }); continue; }
      const dt = chooseDiscard(g, p, AI_LEVEL, this.rng);
      g.discard(p, dt);
      await this._emit({ type: 'discard', player: p, tile: dt, discardIndex: g.discardLog.length - 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// RemoteBackend — the online implementation. Same contract as LocalBackend, so the UI is
// unchanged. The transport/reconnect/action layer is the shared RemoteBackendBase; the only
// 天津-specific parts are buildRemoteView (rebuild the GameView rotated to the player's seat, so
// main.js's HUMAN=0 rendering puts you at the bottom with correct winds) and mapServerEvent
// (server event → UI event). 国标 reuses the same base with its own mappers.
// ---------------------------------------------------------------------------
export class RemoteBackend extends RemoteBackendBase {
  constructor(config = {}) {
    super(config, { buildView: buildRemoteView, mapEvent: mapServerEvent });
  }
}

// Rotate a server view (absolute seats) to the player's perspective and rebuild a GameView
// carrying the engine's helper methods (isWild/seatWind/selfKongOptions/settlementFactors/…),
// so the UI renders it exactly like a local Game. `c` is the player's absolute seat.
export function buildRemoteView(sv, c) {
  const rot = (p) => (p - c + 4) % 4;                 // absolute seat → display index
  const byD = (arr) => (arr ? [0, 1, 2, 3].map((d) => arr[(c + d) % 4]) : arr); // re-index a per-seat array
  const result = sv.result ? {
    ...sv.result, winner: rot(sv.result.winner), // decomp tiles are kinds (not seat-relative) — only rebuild the natural Sets
    payments: byD(sv.result.payments), kong: byD(sv.result.kong), kongPts: byD(sv.result.kongPts),
    decomp: sv.result.decomp ? sv.result.decomp.map((g) => ({ ...g, natural: new Set(g.natural || []) })) : null,
  } : null;
  const snap = {
    prevailingWind: sv.prevailingWind ?? 0, seatBase: ((sv.seatBase ?? 0) - c + 4) % 4,
    dealer: rot(sv.dealer ?? 0), turn: sv.turn != null ? rot(sv.turn) : 0,
    phase: sv.phase, wilds: sv.wilds || [], indicator: sv.indicator,
    scores: byD(sv.scores) || [0, 0, 0, 0], laZhuang: (sv.laZhuang || []).map(rot), dealerDouble: sv.dealerDouble ?? true,
    hands: byD(sv.hands) || [[], [], [], []], melds: byD(sv.melds) || [[], [], [], []], discards: byD(sv.discards) || [[], [], [], []],
    discardLog: (sv.discardLog || []).map((e) => ({ player: rot(e.player), kind: e.kind })),
    lastDiscard: sv.lastDiscard ? { player: rot(sv.lastDiscard.player), kind: sv.lastDiscard.kind } : null,
    drawnTile: sv.drawnTile != null ? sv.drawnTile : null,
    claim: sv.claim ? { ...sv.claim, player: rot(sv.claim.player) } : null,
    selfDrawWin: sv.canWin ? (sv.winInfo || { fans: ['胡'], score: 0 }) : null,
    result,
    wall: { length: sv.wallCount ?? 0 },
    seatNames: byD(sv.seatNames), seatKinds: byD(sv.seatKinds), online: true,
  };
  const view = Object.assign(Object.create(Game.prototype), snap);
  view.wildSet = new Set(snap.wilds);
  return view;
}

// Map a server event (absolute) to the UI event main.js's onBackendEvent expects (rotated).
export function mapServerEvent(ev, c, view) {
  const rot = (p) => (p - c + 4) % 4;
  const byD = (arr) => (arr ? [0, 1, 2, 3].map((d) => arr[(c + d) % 4]) : arr);
  switch (ev.t) {
    case 'deal': return { type: 'deal' };
    case 'await': return { type: 'await', who: ev.who, timeout: ev.timeout, total: ev.total };
    case 'discard': return { type: 'discard', player: rot(ev.player), tile: ev.tile, discardIndex: view.discardLog.length - 1 };
    case 'claim': return { type: 'claim', player: rot(ev.player), claimType: ev.claim, kind: ev.kind };
    case 'selfKong': return { type: 'selfKong', player: rot(ev.player), kind: ev.kind };
    case 'over': return { type: 'over', result: view.result, readied: ev.readied, matchEnd: ev.matchEnd }; // matchEnd: this hand closes the 锅
    case 'lazhuang': return { type: 'lazhuang', dealer: rot(ev.dealer), // halts for everyone — no countdown
      need: (ev.need || []).map(rot), // seats still to choose (rotated to display)
      answers: Object.fromEntries(Object.entries(ev.answers || {}).map(([s, v]) => [rot(+s), v])) };
    case 'matchOver': return { type: 'matchOver', scores: byD(ev.scores), rounds: (ev.rounds || []).map((r) => ({ wind: r.wind, scores: byD(r.scores) })) };
    case 'sync': return { type: 'sync' };
    default: return null; // 'handEnd' is server-internal (the result modal's 我准备好了 sends 'next')
  }
}
