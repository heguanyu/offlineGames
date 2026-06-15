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
import { chooseDiscard, chooseClaim, chooseSelfKong } from './ai.js';

export const HUMAN = 0;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether bot `seat` 拉庄s against `dealer`. This is a SERVER-SIDE decision (the bots live
// behind the backend), so it belongs here, not in the UI. A stub today — bots never 拉庄
// yet; wiring real logic in is a one-function change.
export function shouldBotLaZhuang(seat, dealer) { return false; }

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
    this.level = config.level ?? 2;
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

  // Deal and play one hand. cfg: { dealer, prevailingWind, scores, seatBase, level }.
  async startHand(cfg) {
    const gen = ++this._gen;
    if (cfg.level != null) this.level = cfg.level;
    // 拉庄 is decided BEFORE the deal (blind). Bots decide here; the human is asked.
    const challengers = [];
    for (let p = 0; p < 4; p++) if (p !== cfg.dealer && p !== HUMAN && shouldBotLaZhuang(p, cfg.dealer)) challengers.push(p);
    if (cfg.dealer !== HUMAN) {
      const yes = await this._ask({ type: 'lazhuang', dealer: cfg.dealer });
      if (gen !== this._gen) return; // abandoned (e.g. 重开) while the panel was open
      if (yes) challengers.push(HUMAN);
    }
    this._game = new Game({
      rng: this.rng,
      dealer: cfg.dealer, prevailingWind: cfg.prevailingWind,
      scores: cfg.scores, seatBase: cfg.seatBase,
      laZhuang: challengers.sort((a, b) => a - b),
    });
    await this._emit({ type: 'deal' });
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
        const c = g.claim, dec = chooseClaim(g, c.player, c, this.level, this.rng);
        if (dec) { const kind = c.kind; g.claimDiscard(dec); await this._emit({ type: 'claim', player: c.player, claimType: dec, kind }); }
        else g.passClaim();
        continue;
      }
      // AWAIT_DISCARD
      if (g.turn === HUMAN) { await this._emit({ type: 'await', who: 'discard' }); return; }
      await delay(this.thinkDelay); if (gen !== this._gen) return;
      const p = g.turn;
      if (g.selfDrawWin) { g.declareWin(); continue; }                 // bot takes its self-draw win → OVER
      const kong = chooseSelfKong(g, p, this.level, this.rng);
      if (kong !== null) { g.selfKong(p, kong); await this._emit({ type: 'selfKong', player: p, kind: kong }); continue; }
      const dt = chooseDiscard(g, p, this.level, this.rng);
      g.discard(p, dt);
      await this._emit({ type: 'discard', player: p, tile: dt, discardIndex: g.discardLog.length - 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// RemoteBackend — the online implementation, stubbed. It fulfils the SAME contract,
// so the UI is unchanged; only the bodies below talk to the server. Sketch:
//   - one WebSocket (or SSE) carries server → client events; feed each into _emit so the
//     UI's awaited handler sequences them exactly like LocalBackend.
//   - each action POSTs the move (or sends a socket frame) and resolves on the ack; the
//     authoritative state then arrives as events, and getState() returns the last view
//     the server sent (its own hand + the public table — opponents' tiles stay hidden).
// ---------------------------------------------------------------------------
export class RemoteBackend {
  constructor(config = {}) {
    this.baseUrl = config.url || '/api/mahjong';
    this._handler = null;
    this._state = null;   // last GameView pushed by the server
    this._socket = null;  // WebSocket carrying server → client events
  }

  onEvent(handler) { this._handler = handler; }
  getState() { return this._state; }
  dispose() { if (this._socket) this._socket.close(); this._socket = null; this._handler = null; }

  async _emit(ev) { if (this._handler) await this._handler(ev); }

  async startHand(/* cfg */) {
    // TODO(online): open this._socket = new WebSocket(...); on each server frame, update
    // this._state from frame.view and `await this._emit(frame.event)`. POST /hand to join
    // the table and resolve once the server confirms the deal.
    throw new Error('RemoteBackend.startHand: connect the socket + POST /hand here');
  }

  // Each action sends the move and resolves on the server's ack; resulting state changes
  // (incl. opponents' moves) stream back as events into _emit.
  async discard(/* tile */) { throw new Error('RemoteBackend.discard: POST /move {type:"discard", tile}'); }
  async claim(/* type */)   { throw new Error('RemoteBackend.claim: POST /move {type:"claim", claim}'); }
  async pass()              { throw new Error('RemoteBackend.pass: POST /move {type:"pass"}'); }
  async selfKong(/* kind */){ throw new Error('RemoteBackend.selfKong: POST /move {type:"selfKong", kind}'); }
  async declareWin()        { throw new Error('RemoteBackend.declareWin: POST /move {type:"win"}'); }
  decideLaZhuang(/* yes */) { throw new Error('RemoteBackend.decideLaZhuang: POST /move {type:"lazhuang", yes}'); }
}
