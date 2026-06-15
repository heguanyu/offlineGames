// One online table's authoritative game — the ground truth. Runs the engine, drives the
// bots, AWAITS each seated human's move (with a turn timeout so a stalled or disconnected
// player can't freeze the table), tracks the 锅/圈 match flow + scores, and after every move
// pushes each human a REDACTED view (own hand full, opponents hidden) plus the event. The
// client is a pure renderer of these frames; it can reconnect (by uid) and get a fresh sync.
//
// Mirrors the client LocalBackend's loop, fanned out to four seats. Engine/AI are imported
// read-only from the shared offline game — nothing here changes the offline build.
import { Game, PHASE } from '../games/mahjong-tianjin/engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong } from '../games/mahjong-tianjin/ai.js';

const BOT_THINK_MS = +process.env.BOT_THINK_MS || 700; // bot "thinking" pace (tests set it low)
const TURN_TIMEOUT_MS = 30000;  // auto-act if a human doesn't move
const LZ_TIMEOUT_MS = 15000;    // auto-不拉 if a human doesn't answer 拉庄
const NEXT_TIMEOUT_MS = 25000;  // auto-advance if a human doesn't click 下一局
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// bots never 拉庄 yet (server-side decision, same stub as the client)
const botLaZhuang = (/* seat, dealer */) => false;
// safe auto-move when a human stalls: discard the first non-wild (a 混儿 can't be discarded).
const autoDiscardTile = (g, p) => g.hands[p].find((t) => !g.isWild(t));

// Strip the win result to JSON-safe fields (decomp carries Sets → omit it for now; the
// result modal's hand breakdown is wired with the client RemoteBackend later).
function safeResult(r) {
  if (!r) return null;
  return { type: r.type, winner: r.winner, score: r.score, fans: r.fans,
    winningTile: r.winningTile, payments: r.payments, kong: r.kong, kongPts: r.kongPts };
}

export class Table {
  // seats: [4] of { kind:'human', uid, name } | { kind:'bot' }
  // emit(seat, msg): deliver to that seat's live human socket (no-op if bot/offline)
  // onPotOver(): the 锅 finished — caller returns the table to the lobby
  constructor(id, seats, emit, onPotOver, level = 2) {
    this.id = id;
    this.seats = seats;
    this.emit = emit;
    this.onPotOver = onPotOver;
    this.level = level;
    this.scores = [0, 0, 0, 0];
    this.dealer = 0; this.prevailingWind = 0; this.seatBase = 0; this.rounds = [];
    this.game = null;
    this._gen = 0;
    this._waiting = null;   // { seat, kind, finish } — a single human move in flight
    this._lz = null;        // { need:Set, answers:{}, finish } — 拉庄 answers in flight
    this._next = null;      // { need:Set, finish } — 下一局 acks in flight
    this._run().catch(() => {});
  }

  isHuman(s) { return this.seats[s].kind === 'human'; }
  humans() { const a = []; for (let s = 0; s < 4; s++) if (this.isHuman(s)) a.push(s); return a; }

  // ---- redacted per-seat view ----------------------------------------------
  viewFor(seat) {
    const g = this.game;
    const base = {
      yourSeat: seat, scores: this.scores, dealer: this.dealer, prevailingWind: this.prevailingWind,
      seatBase: this.seatBase, rounds: this.rounds,
      seatNames: this.seats.map((s) => (s.kind === 'bot' ? '机器人' : s.name)),
      seatKinds: this.seats.map((s) => s.kind),
    };
    if (!g) return base;
    // own hand always; everyone's revealed at the showdown (OVER) for the result modal.
    const hand = (p) => (p === seat || g.phase === PHASE.OVER ? g.hands[p].slice() : g.hands[p].map(() => -1));
    return {
      ...base,
      phase: g.phase, turn: g.turn, dealer: g.dealer, wilds: g.wilds, indicator: g.indicator,
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
  }

  pushEvent(ev) { for (const s of this.humans()) this.emit(s, { type: 'game', ev, view: this.viewFor(s) }); }
  // reconnection: re-send the full current state to one seat
  // reconnection: re-send the full state, RE-EMITTING any request pending from this seat so
  // a returning client can still answer (its 拉庄 prompt, or its turn).
  resync(seat) {
    if (!this.isHuman(seat)) return;
    let ev = { t: 'sync' };
    if (this._lz && this._lz.need.has(seat)) ev = { t: 'lazhuang', dealer: this.dealer };
    else if (this._waiting && this._waiting.seat === seat) ev = { t: 'await', who: this._waiting.kind, seat };
    this.emit(seat, { type: 'game', ev, view: this.viewFor(seat) });
  }

  // ---- action routing (called from index.js for the seat's socket) ----------
  onAction(seat, msg) {
    if (this._lz && this._lz.need.has(seat) && msg.do === 'lazhuang') {
      this._lz.answers[seat] = !!msg.yes; this._lz.need.delete(seat);
      if (this._lz.need.size === 0) this._lz.finish();
    } else if (this._waiting && this._waiting.seat === seat && this._isMoveFor(this._waiting.kind, msg)) {
      this._waiting.finish(msg);
    } else if (this._next && this._next.need.has(seat) && msg.do === 'next') {
      this._next.need.delete(seat);
      if (this._next.need.size === 0) this._next.finish();
    }
  }
  _isMoveFor(kind, msg) {
    if (kind === 'claim') return msg.do === 'claim' || msg.do === 'pass';
    if (kind === 'discard') return msg.do === 'discard' || msg.do === 'selfKong' || msg.do === 'win';
    return false;
  }

  // ---- the match loop (one 锅 = four 圈) ------------------------------------
  async _run() {
    const gen = ++this._gen;
    for (;;) {
      if (gen !== this._gen) return;
      const laZhuang = await this._collectLaZhuang(gen);
      if (gen !== this._gen) return;
      this.game = new Game({ dealer: this.dealer, prevailingWind: this.prevailingWind, scores: this.scores, seatBase: this.seatBase, laZhuang });
      this.pushEvent({ t: 'deal' });
      await this._playHand(gen);
      if (gen !== this._gen) return;
      this.scores = this.game.scores.slice();
      await this._awaitNext(gen);            // wait for 下一局 from every human (or time out)
      if (gen !== this._gen) return;

      // 锅/圈 flow (same rule as the offline nextHand): a 圈 ends when the 庄 button laps
      // back to seat 0; the 北圈 (prevailingWind 3) lap ends the 锅.
      const nd = this.game.nextDealer();
      if (nd === 0 && this.dealer !== 0) {
        this.rounds.push({ wind: this.prevailingWind, scores: this.scores.slice() });
        if (this.prevailingWind === 3) { this.pushEvent({ t: 'potOver', rounds: this.rounds, scores: this.scores }); this.onPotOver(this.scores.slice()); return; }
        this.prevailingWind = (this.prevailingWind + 1) % 4;
      }
      this.dealer = nd;
    }
  }

  async _playHand(gen) {
    const g = this.game;
    for (;;) {
      if (gen !== this._gen) return;
      if (g.phase === PHASE.OVER) { this.pushEvent({ t: 'over', result: safeResult(g.result), winningTile: g.drawnTile }); return; }

      if (g.phase === PHASE.AWAIT_CLAIM) {
        const p = g.claim.player;
        if (this.isHuman(p)) {
          const m = await this._await(p, 'claim', gen);
          if (gen !== this._gen) return;
          if (m && m.do === 'claim' && g.claim.options.includes(m.claim)) { const k = g.claim.kind; g.claimDiscard(m.claim); this.pushEvent({ t: 'claim', player: p, claim: m.claim, kind: k }); }
          else g.passClaim();
        } else {
          await delay(BOT_THINK_MS); if (gen !== this._gen) return;
          const dec = chooseClaim(g, p, g.claim, this.level);
          if (dec) { const k = g.claim.kind; g.claimDiscard(dec); this.pushEvent({ t: 'claim', player: p, claim: dec, kind: k }); }
          else g.passClaim();
        }
        continue;
      }

      // AWAIT_DISCARD
      const p = g.turn;
      if (this.isHuman(p)) {
        const m = await this._await(p, 'discard', gen);
        if (gen !== this._gen) return;
        if (m && m.do === 'win' && g.selfDrawWin) g.declareWin();
        else if (m && m.do === 'selfKong' && g.selfKongOptions(p).some((o) => o.kind === m.kind)) { g.selfKong(p, m.kind); this.pushEvent({ t: 'selfKong', player: p, kind: m.kind }); }
        else if (m && m.do === 'discard' && !g.isWild(m.tile) && g.hands[p].includes(m.tile)) { g.discard(p, m.tile); this.pushEvent({ t: 'discard', player: p, tile: m.tile }); }
        else { const t = autoDiscardTile(g, p); g.discard(p, t); this.pushEvent({ t: 'discard', player: p, tile: t, auto: true }); } // timeout / illegal → safe auto
      } else {
        await delay(BOT_THINK_MS); if (gen !== this._gen) return;
        if (g.selfDrawWin) { g.declareWin(); continue; }
        const kong = chooseSelfKong(g, p, this.level);
        if (kong !== null) { g.selfKong(p, kong); this.pushEvent({ t: 'selfKong', player: p, kind: kong }); continue; }
        const t = chooseDiscard(g, p, this.level);
        g.discard(p, t); this.pushEvent({ t: 'discard', player: p, tile: t });
      }
    }
  }

  // await ONE human's move; the 'await' frame tells everyone whose turn it is (and reveals
  // the actor's drawn tile in their own view). Times out → null (the loop auto-acts).
  _await(seat, kind, gen) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this._waiting && this._waiting.gen === gen) { this._waiting = null; resolve(null); } }, TURN_TIMEOUT_MS);
      this._waiting = { seat, kind, gen, finish: (m) => { clearTimeout(timer); this._waiting = null; resolve(m); } };
      this.pushEvent({ t: 'await', who: kind, seat });
    });
  }

  // 拉庄 (blind, pre-deal): ask each non-庄 human; bots decide via botLaZhuang.
  _collectLaZhuang(gen) {
    const challengers = [];
    for (let s = 0; s < 4; s++) if (s !== this.dealer && !this.isHuman(s) && botLaZhuang(s, this.dealer)) challengers.push(s);
    const need = new Set(this.humans().filter((s) => s !== this.dealer));
    if (need.size === 0) return Promise.resolve(challengers.sort((a, b) => a - b));
    return new Promise((resolve) => {
      const answers = {};
      const finish = () => {
        clearTimeout(timer); this._lz = null;
        const all = challengers.concat(Object.keys(answers).filter((s) => answers[s]).map(Number));
        resolve(all.sort((a, b) => a - b));
      };
      const timer = setTimeout(() => { if (this._lz && this._lz.gen === gen) finish(); }, LZ_TIMEOUT_MS);
      this._lz = { need, answers, gen, finish };
      for (const s of need) this.emit(s, { type: 'game', ev: { t: 'lazhuang', dealer: this.dealer }, view: this.viewFor(s) });
    });
  }

  // wait for every human to click 下一局 (bots/offline don't block; timeout auto-advances).
  _awaitNext(gen) {
    const need = new Set(this.humans());
    if (need.size === 0) return delay(800);
    this.pushEvent({ t: 'handEnd' });
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this._next = null; resolve(); };
      const timer = setTimeout(() => { if (this._next && this._next.gen === gen) finish(); }, NEXT_TIMEOUT_MS);
      this._next = { need, gen, finish };
    });
  }

  dispose() { this._gen++; this._waiting = this._lz = this._next = null; }
}
