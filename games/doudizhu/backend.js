// The 斗地主 game BACKEND boundary — same idea as games/mahjong-tianjin/backend.js. The UI
// (main.js) never touches the engine or the AI directly; it talks to a Backend that owns the
// authoritative Game, validates/applies the human's moves, drives the two bots with a think
// delay, and pushes AWAITED events so the UI can finish each animation before the next move
// lands. createBackend() picks the implementation; the UI is identical either way, so going
// online later is a config flip.
//
// The UI ↔ Backend contract:
//   - getState() → the live Game (read-only for the UI; all changes go through actions). The UI
//     imports engine.js's legalMoves()/classify() to render hints + validate its own selection.
//   - onEvent(handler): AWAITED events the backend pushes (see below).
//   - actions (async): decideBid(call), play(cardIds), pass(). They resolve once applied.
//
// Events:
//   { type:'deal' }                              a fresh 17/17/17 + 3 底牌 was dealt
//   { type:'askBid', seat, highBid }             the human must 叫分 → answer with decideBid(call)
//   { type:'bid', seat, call, highBid }          a seat called (bot or human)
//   { type:'bidEnd', landlord, bid, bottom }     bidding resolved; reveal 底牌 + landlord
//   { type:'redeal' }                            everyone passed → re-deal (a new 'deal' follows)
//   { type:'play', seat, cardIds, cards, move }   a seat played a combo (cards = the card objects, move = descriptor)
//   { type:'pass', seat }                        a seat passed
//   { type:'await', who:'play' }                 the human must play or pass
//   { type:'over', result }                      the hand ended (result carries the settlement)
import { Game, PHASE, legalMoves, classify, beats } from './engine.js';
import { chooseBid, chooseMove } from './ai.js';
import { RemoteBackendBase } from '../mahjong-common/remote-backend.js';

const SEATS = 3;

export const HUMAN = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBackend(config = {}) {
  switch (config.mode || 'local') {
    case 'local': return new LocalBackend(config);
    case 'remote': return new RemoteBackend(config);
    default: throw new Error('unknown backend mode: ' + config.mode);
  }
}

// ---------------------------------------------------------------------------
// LocalBackend — engine + AI as an in-process "server". Lift this onto a real server and the
// RemoteBackend below talks to it with the identical contract.
// ---------------------------------------------------------------------------
export class LocalBackend {
  constructor(config = {}) {
    this.rng = config.rng || Math.random;
    this.level = config.level ?? 1;
    this.thinkDelay = config.thinkDelay ?? 650;
    this._game = null;
    this._handler = null;
    this._bidResolve = null;
    this._gen = 0;
  }

  onEvent(handler) { this._handler = handler; }
  getState() { return this._game; }
  dispose() { this._gen++; this._handler = null; this._bidResolve = null; }

  async _emit(ev) { if (this._handler) await this._handler(ev); }
  _askBid(ev) { return new Promise((res) => { this._bidResolve = res; this._emit(ev); }); }
  decideBid(call) { const r = this._bidResolve; this._bidResolve = null; if (r) r(call); }

  // Deal and play one hand. cfg: { level }.
  async startHand(cfg = {}) {
    const gen = ++this._gen;
    if (cfg.level != null) this.level = cfg.level;
    for (;;) {                                 // loop only re-runs on a redeal (everyone passed)
      this._game = new Game({ rng: this.rng });
      await this._emit({ type: 'deal' });
      if (gen !== this._gen) return;
      const ok = await this._runBidding(gen);
      if (gen !== this._gen) return;
      if (ok) break;
      await this._emit({ type: 'redeal' });
      if (gen !== this._gen) return;
    }
    await this._advance(gen);
  }

  // Drive 叫分 until a landlord emerges (or everyone passes → redeal). Returns true if a landlord
  // was set, false on a redeal.
  async _runBidding(gen) {
    const g = this._game;
    while (g.phase === PHASE.BID) {
      const seat = g.bidTurn;
      let call;
      if (seat === HUMAN) {
        call = await this._askBid({ type: 'askBid', seat, highBid: g.highBid });
        if (gen !== this._gen) return false;
      } else {
        await delay(this.thinkDelay); if (gen !== this._gen) return false;
        call = chooseBid(g, seat, this.level, this.rng);
      }
      const highBefore = g.highBid;
      g.placeBid(seat, call);
      const effective = g.highBid > highBefore ? g.highBid : 0; // a call ≤ highBid is treated as 不叫
      await this._emit({ type: 'bid', seat, call: effective, highBid: g.highBid });
      if (gen !== this._gen) return false;
    }
    if (g.result && g.result.redeal) return false;
    await this._emit({ type: 'bidEnd', landlord: g.landlord, bid: g.bid, bottom: g.bottom.slice() });
    return true;
  }

  // ---- human actions ----
  async play(cardIds) {
    const g = this._game;
    if (!g || g.phase !== PHASE.PLAY || g.turn !== HUMAN) return false;
    const d = g.validatePlay(HUMAN, cardIds);
    if (!d) return false;
    const cards = cardIds.map((id) => g.hands[HUMAN].find((c) => c.id === id));
    g.play(HUMAN, cardIds);
    await this._emit({ type: 'play', seat: HUMAN, cardIds, cards, move: d });
    await this._advance(this._gen);
    return true;
  }
  async pass() {
    const g = this._game;
    if (!g || g.phase !== PHASE.PLAY || g.turn !== HUMAN || g.leadSeat === HUMAN) return false;
    g.play(HUMAN, []);
    await this._emit({ type: 'pass', seat: HUMAN });
    if (g.phase === PHASE.PLAY && g.lead === null) await this._emit({ type: 'trickEnd', winner: g.leadSeat });
    await this._advance(this._gen);
    return true;
  }

  // Drive the bots until the human must act or the hand ends, one event per move.
  async _advance(gen) {
    const g = this._game;
    for (;;) {
      if (gen !== this._gen) return;
      if (g.phase === PHASE.OVER) { await this._emit({ type: 'over', result: g.result }); return; }
      if (g.turn === HUMAN) { await this._emit({ type: 'await', who: 'play' }); return; }
      await delay(this.thinkDelay); if (gen !== this._gen) return;
      const seat = g.turn;
      const mv = chooseMove(g, seat, this.level, this.rng);
      if (mv.pass) {
        g.play(seat, []); await this._emit({ type: 'pass', seat });
        if (g.phase === PHASE.PLAY && g.lead === null) await this._emit({ type: 'trickEnd', winner: g.leadSeat });
      } else { const d = g.validatePlay(seat, mv.cardIds); const cards = mv.cardIds.map((id) => g.hands[seat].find((c) => c.id === id)); g.play(seat, mv.cardIds); await this._emit({ type: 'play', seat, cardIds: mv.cardIds, cards, move: d }); }
    }
  }
}

// ---------------------------------------------------------------------------
// RemoteBackend — online play over the shared WebSocket transport (../mahjong-common/remote-backend.js,
// the same one the mahjong variants use). The server (server/poker-table.js) is the authoritative
// game; it pushes ABSOLUTE-seat redacted views + events. The two per-game mappers here make the online
// path render identically to the offline one:
//   - buildView(serverView, mySeat): rebuild the GameView the UI renders, ROTATED so my seat is index
//     0 (HUMAN). It exposes the SAME read fields + methods the offline Game does — crucially
//     validatePlay() and roleOf(), and enough state (hands[0] / playLog / lead…) that the UI's
//     local auto-select (ai.chooseMove) works unchanged. main.js never knows it isn't a real Game.
//   - mapEvent(serverEv, mySeat, view): translate a server event (absolute seats) into the UI event
//     the offline backend emits (deal / askBid / bid / bidEnd / play / pass / trickEnd / await / over),
//     rotating every seat reference to my perspective.
// The human's actions (decideBid / play / pass / next / dealDone / forfeit) ride the transport's
// action channel; the server knows which seat the socket is, so only card ids (seat-agnostic) travel.
// ---------------------------------------------------------------------------
export class RemoteBackend extends RemoteBackendBase {
  constructor(config = {}) {
    const rot = (mySeat) => (s) => (s < 0 ? -1 : (s - mySeat + SEATS) % SEATS);
    super(config, {
      buildView: (sv, mySeat) => buildView(sv, mySeat),
      mapEvent: (ev, mySeat, view) => mapEvent(ev, rot(mySeat), view),
    });
  }
  // human action senders (the transport gates them to no-ops for a spectator)
  decideBid(call) { this._act({ do: 'bid', call: call | 0 }); }
  async play(cardIds) { this._act({ do: 'play', cardIds }); return true; }
  async pass() { this._act({ do: 'pass' }); return true; }
  next() { this._act({ do: 'next' }); }
  unready() { this._act({ do: 'unready' }); }
  dealDone() { this._act({ do: 'dealDone' }); }
  forfeit() { this._act({ do: 'forfeit' }); }
  // online has no offline-style startHand — the server drives the deal. Provided so callers that
  // poke it generically don't throw.
  startHand() {}
}

// Rebuild the per-seat GameView the UI renders from a server view, rotated so `mySeat` → 0.
function buildView(sv, mySeat) {
  const r = (s) => (s < 0 ? -1 : (s - mySeat + SEATS) % SEATS);   // absolute seat → my-relative
  const ir = (rel) => (rel + mySeat) % SEATS;                     // my-relative → absolute
  const hands = {};
  for (const k of Object.keys(sv.hands || {})) hands[r(+k)] = sv.hands[k];
  const handCounts = [0, 1, 2].map((rel) => (sv.handCounts || [])[ir(rel)] ?? 0);
  const scores = [0, 1, 2].map((rel) => (sv.scores || [])[ir(rel)] ?? 0);
  const playLog = (sv.playLog || []).map((e) => ({ seat: r(e.seat), move: e.move, ranks: e.ranks }));
  let result = null;
  if (sv.result && !sv.result.redeal) {
    const a = sv.result;
    result = { ...a, winner: r(a.winner), landlord: r(a.landlord), delta: [0, 1, 2].map((rel) => a.delta[ir(rel)]) };
  }
  return {
    phase: sv.phase, turn: r(sv.turn ?? -1), bidTurn: r(sv.bidTurn ?? -1), highBid: sv.highBid || 0, bid: sv.bid || 0,
    landlord: r(sv.landlord ?? -1), lead: sv.lead || null, leadSeat: r(sv.leadSeat ?? -1),
    bombs: sv.bombs || 0, landlordPlays: sv.landlordPlays || 0, peasantPlayed: !!sv.peasantPlayed,
    handCounts, hands, bottom: sv.bottom || null, scores, playLog, result,
    // --- methods the UI (and its local ai auto-select) call on a "Game" ---
    roleOf(seat) { return seat === this.landlord ? 1 : 0; },
    validatePlay(seat, cardIds) {
      if (this.phase !== 'play' || this.turn !== seat) return null;
      const hand = this.hands[seat]; if (!hand) return null;
      const chosen = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
      if (chosen.length !== cardIds.length) return null;
      const d = classify(chosen.map((c) => c.rank));
      if (!d) return null;
      const against = seat === this.leadSeat ? null : this.lead;
      if (!beats(d, against)) return null;
      return { ...d, ranks: d.ranks ?? chosen.map((c) => c.rank), cardIds };
    },
  };
}

// Translate a server event (absolute seats) → the UI event the offline backend emits. `r` rotates a
// seat to my perspective; `view` is the freshly-rebuilt rotated view (used for the settled result).
function mapEvent(ev, r, view) {
  switch (ev.t) {
    case 'deal': return { type: 'deal' };
    case 'bid': return { type: 'bid', seat: r(ev.seat), call: ev.call, highBid: ev.highBid };
    case 'bidEnd': return { type: 'bidEnd', landlord: r(ev.landlord), bid: ev.bid, bottom: ev.bottom };
    case 'redeal': return { type: 'redeal' };
    case 'play': return { type: 'play', seat: r(ev.seat), cardIds: ev.cardIds, cards: ev.cards, move: ev.move };
    case 'pass': return { type: 'pass', seat: r(ev.seat) };
    case 'trickEnd': return { type: 'trickEnd', winner: r(ev.winner) };
    case 'await': {
      // my own clock → the offline-style prompt (askBid / play); another seat's clock → a 'turn'
      // hint the online UI uses to drive the countdown ring over that player. timeout/total drive the ring.
      const clk = { timeout: ev.timeout, total: ev.total };
      if (r(ev.seat) === 0) return ev.who === 'bid' ? { type: 'askBid', seat: 0, highBid: ev.highBid, ...clk } : { type: 'await', who: 'play', ...clk };
      return { type: 'turn', seat: r(ev.seat), who: ev.who, ...clk };
    }
    case 'over': return { type: 'over', result: view.result, matchEnd: !!ev.matchEnd, readied: !!ev.readied };
    case 'handEnd': return { type: 'handEnd' };
    case 'matchOver': return { type: 'matchOver' };
    case 'sync': return { type: 'sync' };
    default: return null;
  }
}
