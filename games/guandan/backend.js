// The 掼蛋 game BACKEND boundary — same idea as games/doudizhu/backend.js. The UI (main.js) never
// touches the engine or the AI directly; it talks to a Backend that owns the authoritative Match,
// validates/applies the human's moves, drives the three bots with a think delay, and pushes AWAITED
// events so the UI can finish each animation before the next move lands. createBackend() picks the
// implementation; the UI is identical either way, so going online later is a config flip.
//
// The UI ↔ Backend contract:
//   - getState() → a live snapshot { round, level, teamLevel, hostTeam, roundIndex, champion }.
//     round is the engine Round (read-only for the UI); the UI imports legalMoves()/classify() to
//     render hints + validate its own selection. Match-level fields drive the level/score display.
//   - onEvent(handler): AWAITED events the backend pushes (see below).
//   - actions (async): play(cardIds), pass(). They resolve once applied.
//   - newMatch(cfg) / nextRound(): start a fresh ladder, or deal the next round after one ends.
//
// Events:
//   { type:'deal', roundIndex, level, teamLevel, hostTeam }   a fresh 27×4 deal
//   { type:'tribute', plan, exchanges }                       进贡/还贡 resolved (cards already moved)
//   { type:'roundStart', firstLeader }                        trick play begins
//   { type:'play', seat, cardIds, cards, move }               a seat played a combo
//   { type:'pass', seat }                                     a seat passed
//   { type:'finish', seat, place }                            a seat emptied its hand (place 1..4)
//   { type:'trickEnd', winner }                               a trick was won → free lead
//   { type:'await', who:'play' }                              the human must play or pass
//   { type:'over', result }                                   the round ended (result carries settlement + champion)
import { Match, PHASE, legalMoves, partnerOf } from './engine.js';
import { chooseMove, chooseTributeReturn } from './ai.js';
import { RemoteBackendBase } from '../mahjong-common/remote-backend.js';

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
// LocalBackend — engine + AI as an in-process "server". Lift this onto a real server and a
// RemoteBackend talks to it with the identical contract.
// ---------------------------------------------------------------------------
export class LocalBackend {
  constructor(config = {}) {
    this.rng = config.rng || Math.random;
    this.level = config.level ?? 1;          // AI difficulty (0/1/2), NOT the card level
    this.thinkDelay = config.thinkDelay ?? 650;
    this.match = null;
    this._handler = null;
    this._gen = 0;
  }

  onEvent(handler) { this._handler = handler; }
  getState() {
    const m = this.match;
    if (!m) return null;
    return { round: m.round, level: m.level(), teamLevel: m.teamLevel.slice(), hostTeam: m.hostTeam, roundIndex: m.roundIndex, champion: m.champion };
  }
  // Between-rounds ladder state, for the UI to persist (save/resume the team levels).
  matchState() { return this.match ? this.match.toState() : null; }
  dispose() { this._gen++; this._handler = null; }
  async _emit(ev) { if (this._handler) await this._handler(ev); }

  // Start a match and deal the first round. `cfg.state` resumes a saved level ladder; omit for fresh.
  newMatch(cfg = {}) {
    if (cfg.aiLevel != null) this.level = cfg.aiLevel;
    this.match = new Match({ rng: this.rng, state: cfg.state || null });
    return this._startRound();
  }
  // Deal the next round (after one ended). If a champion was crowned, the UI should call newMatch().
  nextRound() { return this._startRound(); }

  async _startRound() {
    const gen = ++this._gen;
    const m = this.match;
    const dealt = m.deal();

    // resolve tribute returns FIRST (receivers give back their lowest eligible card — auto in v1),
    // computed from the pre-tribute hands, then apply the exchange via beginRound().
    const tribute = dealt.tribute;
    const returns = {};
    if (tribute && !tribute.antiTribute) {
      for (const pay of tribute.pays) returns[pay.from] = chooseTributeReturn(dealt.hands[pay.to], dealt.level);
    }
    const round = m.beginRound(returns); // creates match.round (hands now tribute-resolved)

    // emit 'deal' AFTER the round exists, so getState().round is live in the handler.
    await this._emit({ type: 'deal', roundIndex: m.roundIndex, level: dealt.level, teamLevel: m.teamLevel.slice(), hostTeam: m.hostTeam });
    if (gen !== this._gen) return;

    if (tribute) {
      const exchanges = tribute.antiTribute ? [] : tribute.pays.map((pay) => ({
        from: pay.from, to: pay.to, tributeCard: pay.card,
        returnCard: round.hands[pay.from].find((c) => c.id === returns[pay.from]) || dealtCardById(dealt, returns[pay.from]),
      }));
      await this._emit({ type: 'tribute', plan: tribute, exchanges });
      if (gen !== this._gen) return;
    }
    await this._emit({ type: 'roundStart', firstLeader: round.turn });
    if (gen !== this._gen) return;
    await this._advance(gen);
  }

  // ---- human actions ----
  async play(cardIds) {
    const r = this.match && this.match.round;
    if (!r || r.phase !== PHASE.PLAY || r.turn !== HUMAN) return false;
    const d = r.validate(HUMAN, cardIds);
    if (!d) return false;
    const cards = cardIds.map((id) => r.hands[HUMAN].find((c) => c.id === id));
    const before = r.finished.length;
    r.play(HUMAN, cardIds);
    await this._emit({ type: 'play', seat: HUMAN, cardIds, cards, move: d });
    // place = where THIS seat finished (before+1). An early 双下 exit appends the other seats too, so
    // r.finished.length would over-count — index `before` is the seat that just went out.
    if (r.finished[before] === HUMAN) await this._emit({ type: 'finish', seat: HUMAN, place: before + 1 });
    await this._advance(this._gen);
    return true;
  }
  async pass() {
    const r = this.match && this.match.round;
    if (!r || r.phase !== PHASE.PLAY || r.turn !== HUMAN || r.leadSeat === HUMAN) return false;
    const leadBefore = r.lead;
    r.play(HUMAN, []);
    await this._emit({ type: 'pass', seat: HUMAN });
    if (r.phase === PHASE.PLAY && r.lead === null && leadBefore !== null) await this._emit({ type: 'trickEnd', winner: r.lastPlaySeat });
    await this._advance(this._gen);
    return true;
  }

  // Drive the bots until the human must act or the round ends, one event per move.
  async _advance(gen) {
    const r = this.match.round;
    for (;;) {
      if (gen !== this._gen) return;
      if (r.phase === PHASE.OVER) {
        const settle = this.match.settleRound();
        await this._emit({ type: 'over', result: settle });
        return;
      }
      if (r.turn === HUMAN) { await this._emit({ type: 'await', who: 'play' }); return; }
      await delay(this.thinkDelay); if (gen !== this._gen) return;
      const seat = r.turn;
      const before = r.finished.length;
      const leadBefore = r.lead;
      const mv = chooseMove(r, seat, this.level, this.rng);
      if (mv.pass || !mv.cardIds.length) {
        if (!r.play(seat, [])) { r.play(seat, mv.cardIds || []); } // safety; shouldn't happen
        await this._emit({ type: 'pass', seat });
        if (r.phase === PHASE.PLAY && r.lead === null && leadBefore !== null) await this._emit({ type: 'trickEnd', winner: r.lastPlaySeat });
      } else {
        const d = r.validate(seat, mv.cardIds);
        const cards = mv.cardIds.map((id) => r.hands[seat].find((c) => c.id === id));
        r.play(seat, mv.cardIds);
        await this._emit({ type: 'play', seat, cardIds: mv.cardIds, cards, move: d });
        if (r.finished[before] === seat) await this._emit({ type: 'finish', seat, place: before + 1 }); // place at finish time (early 双下 appends others)
      }
    }
  }
}
function dealtCardById(dealt, id) { for (const h of dealt.hands) { const c = h.find((x) => x.id === id); if (c) return c; } return null; }

// ---------------------------------------------------------------------------
// RemoteBackend — online stub (not built yet). Same contract as LocalBackend over the shared
// transport. When online play is built, supply buildView (rebuild a per-seat view rotated so
// HUMAN=0 is the bottom seat) and mapEvent (server event → the UI events above).
// ---------------------------------------------------------------------------
export class RemoteBackend extends RemoteBackendBase {
  constructor(config = {}) {
    super(config, { buildView: (sv) => sv, mapEvent: (ev) => ev });
  }
}
