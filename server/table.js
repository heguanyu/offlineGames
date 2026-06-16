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
const DEAL_ACK_TIMEOUT_MS = 8000; // proceed even if a client never reports its deal animation done
const LZ_TIMEOUT_MS = 15000;    // auto-不拉 if a human doesn't answer 拉庄
const NEXT_TIMEOUT_MS = 25000;  // auto-advance if a human doesn't click 下一局
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// each bot takes a blind 50% gamble on 拉庄 (server-side decision, same odds as the client backend)
const botLaZhuang = (/* seat, dealer */) => Math.random() < 0.5;
// safe auto-move when a human stalls: discard the first non-wild (a 混儿 can't be discarded).
const autoDiscardTile = (g, p) => g.hands[p].find((t) => !g.isWild(t));

// Strip the win result to JSON-safe fields. decomp's per-group `natural` is a Set → send it as an
// array; the client rebuilds the Set so the result modal can render the winning hand pattern.
function safeResult(r) {
  if (!r) return null;
  return { type: r.type, winner: r.winner, score: r.score, fans: r.fans,
    winningTile: r.winningTile, payments: r.payments, kong: r.kong, kongPts: r.kongPts,
    decomp: r.decomp ? r.decomp.map((g) => ({ type: g.type, kinds: g.kinds, jokers: g.jokers, natural: g.natural ? [...g.natural] : [] })) : null,
    meta: r.meta ? { winGroupIdx: r.meta.winGroupIdx, long: r.meta.long, longSuit: r.meta.longSuit } : null };
}

export class Table {
  // seats: [4] of { kind:'human', uid, name } | { kind:'bot' }
  // emit(seat, msg): deliver to that seat's live human socket (no-op if bot/offline)
  // onPotOver(): the 锅 finished — caller returns the table to the lobby
  // resume: a snapshot() from a previous run — continue the 锅 from those standings (drop the hand).
  // onState(): called after each hand so the caller can persist the 锅 progress.
  constructor(id, seats, emit, onPotOver, level = 2, resume = null, onState = null) {
    this.id = id;
    this.seats = seats;
    this.emit = emit;
    this.onPotOver = onPotOver;
    this.level = level;
    this.onState = onState;
    this.scores = resume ? (resume.scores || [0, 0, 0, 0]).slice() : [0, 0, 0, 0];
    this.dealer = resume ? (resume.dealer | 0) : 0;
    this.prevailingWind = resume ? (resume.prevailingWind | 0) : 0;
    this.seatBase = resume ? (resume.seatBase | 0) : 0;
    this.rounds = resume && Array.isArray(resume.rounds) ? resume.rounds.slice() : [];
    // the last CONSISTENT between-hands snapshot (what persist() saves). Updated only after a hand
    // commits, so a crash mid-hand resumes from the prior completed hand — never a half-applied 圈.
    this._committed = { scores: this.scores.slice(), dealer: this.dealer, prevailingWind: this.prevailingWind, seatBase: this.seatBase, rounds: this.rounds.slice() };
    // A live hand serialized by a previous run — restore it so play CONTINUES mid-hand after a
    // restart/redeploy instead of re-dealing (and losing the hand). Falls back to a fresh deal if
    // it can't be rebuilt. Restored in the constructor (synchronously) so this.game exists by the
    // time index.js calls resync() on the reconnecting seat.
    this._resumeLive = null;
    if (resume && resume.live) { try { this._resumeLive = Game.restore(resume.live); } catch { this._resumeLive = null; } }
    this.game = null;
    this._gen = 0;
    this._waiting = null;   // { seat, kind, finish } — a single human move in flight
    this._lz = null;        // { need:Set, answers:{}, finish } — 拉庄 answers in flight
    this._next = null;      // { need:Set, finish } — 下一局 acks in flight
    this._dealAck = null;   // { need:Set, finish } — clients finishing the deal animation
    this._lzPending = null; // Set of seats whose own hand stays hidden (blind 拉庄, dealt-but-undecided)
    this._run().catch(() => {});
  }

  isHuman(s) { return this.seats[s].kind === 'human'; }
  humans() { const a = []; for (let s = 0; s < 4; s++) if (this.isHuman(s)) a.push(s); return a; }

  // Does the just-ended hand close the 锅? The 庄 button laps back to the 锅's first 庄 (seat 0) at
  // the end of the 北圈 (prevailingWind 3) — same rule _run uses to fire 'potOver'. Lets the result
  // modal show "结束并查看总成绩" (no ready-toggle) on the final hand.
  _potEnd() { const g = this.game; return !!(g && g.phase === PHASE.OVER && g.nextDealer() === 0 && this.dealer !== 0 && this.prevailingWind === 3); }

  // What to persist so a restart resumes the 锅: the last COMMITTED between-hands standings PLUS,
  // when a hand is actually in play, the serialized live hand (so the restart resumes mid-hand, not
  // just between hands). The pre-hand 拉庄 window (_lzPending/_lz set) is skipped — nothing's been
  // played there, so a fresh deal on resume loses nothing.
  snapshot() {
    const c = this._committed;
    const snap = { scores: c.scores.slice(), dealer: c.dealer, prevailingWind: c.prevailingWind, seatBase: c.seatBase, rounds: c.rounds.slice() };
    const g = this.game;
    if (g && !this._lzPending && !this._lz) snap.live = g.serialize();
    return snap;
  }

  // Persist the current state (between-hands standings + the live hand, via snapshot()). onState is
  // index.js's persist(); a no-op offline / in tests that don't wire it. Called at every decision
  // point during a hand AND between hands, so a restart never loses more than the move in flight.
  _save() { if (this.onState) this.onState(); }

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
    // own hand always; everyone's revealed at the showdown (OVER) for the result modal. EXCEPT a
    // seat still in _lzPending sees its own hand as backs too — blind 拉庄 over the dealt hand. The
    // 混儿 (wilds + indicator) is part of the hand "starting", so it's withheld from that seat too.
    const hideOwn = this._lzPending && this._lzPending.has(seat);
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
  }

  pushEvent(ev) { for (const s of this.humans()) this.emit(s, { type: 'game', ev, view: this.viewFor(s) }); }
  // reconnection: re-send the full current state to one seat
  // reconnection: re-send the full state, RE-EMITTING any request pending from this seat so
  // a returning client can still answer (its 拉庄 prompt, or its turn).
  resync(seat) {
    if (!this.isHuman(seat)) return;
    let ev = { t: 'sync' };
    if (this._lz && this.isHuman(seat)) ev = { t: 'lazhuang', dealer: this.dealer, need: [...this._lz.need], answers: { ...this._lz.answers } }; // re-show the 拉庄 decision / 庄 tally
    else if (this._dealAck && this._dealAck.need.has(seat)) ev = { t: 'deal' }; // re-run the deal animation; its 'dealDone' releases the bots
    else if (this._waiting && this._waiting.seat === seat) ev = { t: 'await', who: this._waiting.kind, seat, timeout: Math.max(1000, this._waiting.deadline - Date.now()), total: TURN_TIMEOUT_MS };
    else if (this._next) ev = { t: 'over', readied: !this._next.need.has(seat), potEnd: this._potEnd() }; // re-show the result on refresh — even for a player who already readied (then it's a 'waiting' state)
    this.emit(seat, { type: 'game', ev, view: this.viewFor(seat) });
  }

  // ---- action routing (called from index.js for the seat's socket) ----------
  onAction(seat, msg) {
    if (this._lz && this._lz.need.has(seat) && msg.do === 'lazhuang') {
      this._lz.answers[seat] = !!msg.yes; this._lz.need.delete(seat); // leaves _lzPending too → reveals this seat's hand
      if (this._lz.need.size === 0) this._lz.finish();
      else this._emitLz(); // update everyone's tally; the answerer's next frame shows their revealed hand
    } else if (this._waiting && this._waiting.seat === seat && this._isMoveFor(this._waiting.kind, msg)) {
      this._waiting.finish(msg);
    } else if (this._next && this.isHuman(seat) && (msg.do === 'next' || msg.do === 'unready')) {
      if (msg.do === 'unready') this._next.need.add(seat);           // cancel readiness — hold the next hand
      else { this._next.need.delete(seat); if (this._next.need.size === 0) this._next.finish(); } // ready → deal once all are
    } else if (this._dealAck && this.isHuman(seat) && msg.do === 'dealDone') {
      this._dealAck.need.delete(seat); if (this._dealAck.need.size === 0) this._dealAck.finish(); // bots wait for all deal animations
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
    let resumed = this._resumeLive; this._resumeLive = null; // a hand restored from a previous run
    for (;;) {
      if (gen !== this._gen) return;
      if (resumed) {
        // Pick the restored hand up in place — skip the deal + 拉庄. Clients re-render it through
        // their normal reconnect sync (index.js → resync), so nothing special is pushed; _playHand
        // resumes from the saved phase/turn. An already-finished hand just re-shows its result.
        this.game = resumed; resumed = null;
      } else {
        // Deal FIRST so every client's table refreshes to the new hand; 拉庄 is asked AFTER (still
        // blind — each challenger's own hand is redacted by viewFor while it sits in _lzPending).
        this._lzPending = new Set(this.humans().filter((s) => s !== this.dealer));
        this.game = new Game({ dealer: this.dealer, prevailingWind: this.prevailingWind, scores: this.scores, seatBase: this.seatBase, laZhuang: [] });
        this.pushEvent({ t: 'deal' });
        await this._awaitDealDone(gen);        // hold until every client's deal animation finishes
        if (gen !== this._gen) return;
        this.game.laZhuang = await this._collectLaZhuang(gen); // blind 拉庄 over the dealt-but-hidden hands
        if (gen !== this._gen) return;
        this._lzPending = null;                // everyone answered → hands reveal, play begins
      }
      if (this.game.phase !== PHASE.OVER) {
        await this._playHand(gen);
        if (gen !== this._gen) return;
      } else {
        // resumed an already-finished hand → re-show the result, then wait for 下一局 as usual
        this.pushEvent({ t: 'over', result: safeResult(this.game.result), winningTile: this.game.drawnTile, potEnd: this._potEnd() });
      }
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
      this._committed = { scores: this.scores.slice(), dealer: this.dealer, prevailingWind: this.prevailingWind, seatBase: this.seatBase, rounds: this.rounds.slice() };
      if (this.onState) this.onState(); // persist the 锅 standings between hands (a restart resumes here)
    }
  }

  async _playHand(gen) {
    const g = this.game;
    for (;;) {
      if (gen !== this._gen) return;
      this._save(); // persist this decision point so a restart resumes exactly here (incl. the OVER showdown)
      if (g.phase === PHASE.OVER) { this.pushEvent({ t: 'over', result: safeResult(g.result), winningTile: g.drawnTile, potEnd: this._potEnd() }); return; }

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
      this._waiting = { seat, kind, gen, deadline: Date.now() + TURN_TIMEOUT_MS, finish: (m) => { clearTimeout(timer); this._waiting = null; resolve(m); } };
      this.pushEvent({ t: 'await', who: kind, seat, timeout: TURN_TIMEOUT_MS, total: TURN_TIMEOUT_MS });
    });
  }

  // 拉庄 (blind, AFTER the deal): ask each non-庄 human; bots decide via botLaZhuang. `need` is the
  // _lzPending set (the same one viewFor redacts), so answering a seat both records it AND reveals
  // that seat's hand. Every human (challengers AND the 庄) gets the frame: challengers decide,
  // the 庄 + already-answered seats watch the live tally.
  _collectLaZhuang(gen) {
    const botChallengers = [];
    for (let s = 0; s < 4; s++) if (s !== this.dealer && !this.isHuman(s) && botLaZhuang(s, this.dealer)) botChallengers.push(s);
    const need = this._lzPending || new Set();
    if (need.size === 0) return Promise.resolve(botChallengers.sort((a, b) => a - b));
    return new Promise((resolve) => {
      const answers = {};
      const finish = () => {
        this._lz = null;
        const all = botChallengers.concat(Object.keys(answers).filter((s) => answers[s]).map(Number));
        resolve(all.sort((a, b) => a - b));
      };
      this._lz = { need, answers, gen, finish }; // no timeout — play halts until EVERY challenger chooses 拉庄/不拉
      this._emitLz();
    });
  }
  // The 拉庄 frame, sent to every human (the view is redacted per-seat by viewFor). need/answers are
  // ABSOLUTE seats; the client rotates them to its display.
  _emitLz() {
    if (!this._lz) return;
    const ev = { t: 'lazhuang', dealer: this.dealer, need: [...this._lz.need], answers: { ...this._lz.answers } };
    for (const s of this.humans()) this.emit(s, { type: 'game', ev, view: this.viewFor(s) });
  }

  // wait for every human to click 下一局 (bots/offline don't block; timeout auto-advances).
  _awaitNext(gen) {
    const need = new Set(this.humans());
    if (need.size === 0) return delay(800);
    this.pushEvent({ t: 'handEnd' });
    return new Promise((resolve) => {
      const finish = () => { this._next = null; resolve(); };
      this._next = { need, gen, finish }; // no timeout — wait until EVERY human clicks 我准备好了
    });
  }

  // Hold the opponents until every human's deal animation has finished (each client sends
  // 'dealDone' when it does), so the bots don't burn their think-time during the deal and then
  // dump a burst of moves the instant the table appears — they start playing on a clean, dealt
  // table, paced one move at a time, exactly like offline. A timeout guards against a client that
  // never acks (old client / lost frame) so the hand can never wedge.
  _awaitDealDone(gen) {
    const need = new Set(this.humans());
    if (need.size === 0) return delay(300);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this._dealAck && this._dealAck.gen === gen) this._dealAck.finish(); }, DEAL_ACK_TIMEOUT_MS);
      const finish = () => { clearTimeout(timer); this._dealAck = null; resolve(); };
      this._dealAck = { need, gen, finish };
    });
  }

  dispose() {
    this._gen++; // any in-flight wait now resolves and _run bails on the gen check (no timeouts to rely on)
    const w = this._waiting, lz = this._lz, nx = this._next, da = this._dealAck;
    this._waiting = this._lz = this._next = this._dealAck = this._lzPending = null;
    if (w) w.finish(null);
    if (lz) lz.finish();
    if (nx) nx.finish();
    if (da) da.finish();
  }
}
