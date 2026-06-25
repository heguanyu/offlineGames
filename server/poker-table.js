// One online 斗地主 table's authoritative game — the ground truth, the poker analogue of
// server/table.js (which hosts the 4-seat mahjong variants). Runs the SAME engine + AI the
// offline game uses (games/doudizhu/engine.js + ai.js), drives the bots, AWAITS each seated
// human's move (bid / play / pass) with a turn timeout so a stalled or disconnected player can't
// freeze the table, tracks a running-score 场 across a fixed number of hands, and after every move
// pushes each human a REDACTED view (own hand full, opponents hidden) plus the event. The client
// (games/doudizhu via the RemoteBackend) is a pure renderer of these frames and can reconnect (by
// uid) for a fresh sync.
//
// The protocol mirrors the mahjong table's { type:'game', ev, view } framing so the lobby/server
// (server/index.js) routes both games identically — only the seat count (3) and the per-hand flow
// (deal → 叫分 → trick play → settle) differ. Seats are ABSOLUTE here (0,1,2); the client rotates
// the view so the receiving human sits at index 0 (frame.view.yourSeat tells it which seat it is).
import { Game, PHASE, ROLE, legalMoves } from '../games/doudizhu/engine.js';
import { chooseBid, chooseMove } from '../games/doudizhu/ai.js';

const BOT_THINK_MS = +process.env.BOT_THINK_MS || 700;   // bot "thinking" pace (tests set it low)
const TURN_TIMEOUT_MS = 30000;   // auto-act if a human doesn't move
const DEAL_ACK_TIMEOUT_MS = 8000; // proceed even if a client never reports its deal animation done
const MATCH_TARGET = +process.env.DOU_MATCH_TARGET || 100; // a 场 ends the hand AFTER any player first reaches this score
const SEATS = 3;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class PokerTable {
  // seats: [3] of { kind:'human', uid, name } | { kind:'bot', name }
  // emit(seat, msg): deliver to that seat's live human socket (no-op if bot/offline)
  // onMatchOver(finalScores): the 场 finished — caller returns the table to the lobby + records scores
  // resume: a snapshot() from a previous run — continue the 场 from those standings (drop any live hand)
  // onState(): called between hands so the caller can persist 场 progress
  constructor(id, seats, emit, onMatchOver, level = 2, resume = null, onState = null) {
    this.id = id;
    this.seats = seats;
    this.emit = emit;
    this.onMatchOver = onMatchOver;
    this.level = level;
    this.onState = onState;
    this.scores = resume ? (resume.scores || [0, 0, 0]).slice() : [0, 0, 0];
    this.handsPlayed = resume ? (resume.handsPlayed | 0) : 0;
    this.firstBidder = resume ? (resume.firstBidder | 0) % SEATS : Math.floor(Math.random() * SEATS);
    this.game = null;
    this._gen = 0;
    this._waiting = null;   // { seat, kind, gen, deadline, finish } — one human move in flight
    this._next = null;      // { need:Set, gen, finish } — 下一局 acks in flight
    this._dealAck = null;   // { need:Set, gen, finish } — clients finishing the deal animation
    this._run().catch(() => {});
  }

  isHuman(s) { return this.seats[s].kind === 'human'; }
  humans() { const a = []; for (let s = 0; s < SEATS; s++) if (this.isHuman(s)) a.push(s); return a; }

  // Between-hands standings to persist; a restart resumes the 场 from here (an in-progress hand is
  // dropped, like a fresh deal — simpler than mahjong's mid-hand serialize and good enough for poker).
  snapshot() { return { scores: this.scores.slice(), handsPlayed: this.handsPlayed, firstBidder: this.firstBidder }; }
  _save() { if (this.onState) this.onState(); }

  // ---- redacted per-seat view ----------------------------------------------
  // Own hand full; opponents hidden (count only) until the showdown (phase OVER → reveal all). The
  // 底牌 is sent as face-down placeholders during bidding (no leak) and the real cards ride the
  // 'bidEnd' event. playLog is public (every played combo is shown), so it's sent whole — the client
  // rebuilds its AI view (card memory) from it.
  viewFor(seat) {
    const g = this.game;
    if (!g) return { yourSeat: seat, phase: 'idle' };
    const reveal = g.phase === PHASE.OVER;
    const hands = {};
    for (let s = 0; s < SEATS; s++) if (s === seat || reveal) hands[s] = g.hands[s];
    const bottom = g.phase === PHASE.BID ? [{ id: -1, rank: 0, suit: -1 }, { id: -2, rank: 0, suit: -1 }, { id: -3, rank: 0, suit: -1 }] : null;
    return {
      yourSeat: seat,
      phase: g.phase, turn: g.turn, bidTurn: g.bidTurn, highBid: g.highBid, bid: g.bid, landlord: g.landlord,
      lead: g.lead, leadSeat: g.leadSeat, bombs: g.bombs, landlordPlays: g.landlordPlays, peasantPlayed: g.peasantPlayed,
      handCounts: g.handCounts.slice(), hands, bottom, scores: this.scores.slice(),
      playLog: g.playLog.map((e) => ({ seat: e.seat, move: e.move ? { type: e.move.type } : null, ranks: e.ranks })),
      result: reveal ? g.result : null,
    };
  }

  pushEvent(ev) { for (const s of this.humans()) this.emit(s, { type: 'game', ev, view: this.viewFor(s) }); }

  // reconnection / spectator catch-up: re-send full state, re-issuing whatever request this seat
  // must answer (its bid / its turn / the result it hasn't acked).
  resync(seat) { if (this.isHuman(seat)) this.emit(seat, this._syncFrame(seat)); }
  _syncFrame(seat) {
    let ev = { t: 'sync' };
    if (this._dealAck && this._dealAck.need.has(seat)) ev = { t: 'deal' };
    else if (this._waiting && this._waiting.seat === seat) ev = { t: 'await', who: this._waiting.kind, seat, highBid: this.game ? this.game.highBid : 0, timeout: Math.max(1000, this._waiting.deadline - Date.now()), total: TURN_TIMEOUT_MS };
    else if (this._next) ev = { t: 'over', result: this.game ? this.game.result : null, readied: !this._next.need.has(seat), matchEnd: this._matchEnd() };
    return { type: 'game', ev, view: this.viewFor(seat) };
  }
  spectateFrame(seat) { return this.isHuman(seat) ? this._syncFrame(seat) : null; }

  // ---- action routing (called from index.js for the seat's socket) ----------
  onAction(seat, msg) {
    if (this._waiting && this._waiting.seat === seat && this._isMoveFor(this._waiting.kind, msg)) {
      this._waiting.finish(msg);
    } else if (this._next && this.isHuman(seat) && (msg.do === 'next' || msg.do === 'unready')) {
      if (msg.do === 'unready') this._next.need.add(seat);
      else { this._next.need.delete(seat); if (this._next.need.size === 0) this._next.finish(); }
    } else if (this._dealAck && this.isHuman(seat) && msg.do === 'dealDone') {
      this._dealAck.need.delete(seat); if (this._dealAck.need.size === 0) this._dealAck.finish();
    }
  }
  _isMoveFor(kind, msg) {
    if (kind === 'bid') return msg.do === 'bid';
    if (kind === 'play') return msg.do === 'play' || msg.do === 'pass';
    return false;
  }

  // Does the just-ended hand close the 场? The 场 ends as soon as a player reaches MATCH_TARGET (100)
  // points — so PROJECT this hand's settlement onto the standings and check the top score. Lets the
  // result modal show the "结束并查看总成绩" button instead of the ready-toggle. (Called at OVER, when
  // game.result is set; false before then.)
  _matchEnd() {
    const g = this.game;
    if (!g || !g.result || !g.result.delta) return false;
    return Math.max(...this.scores.map((s, i) => s + (g.result.delta[i] || 0))) >= MATCH_TARGET;
  }

  // ---- the match loop (one 场 = HANDS_PER_POT hands) ------------------------
  async _run() {
    const gen = ++this._gen;
    for (;;) {
      if (gen !== this._gen) return;
      // Deal a fresh hand; loop re-runs the deal on a redeal (everyone passed 叫分).
      let landlordSet = false;
      for (;;) {
        this.game = new Game({ rng: Math.random, firstBidder: this.firstBidder });
        this.pushEvent({ t: 'deal' });
        await this._awaitDealDone(gen); if (gen !== this._gen) return;
        landlordSet = await this._runBidding(gen); if (gen !== this._gen) return;
        if (landlordSet) break;
        this.pushEvent({ t: 'redeal' }); await delay(400); if (gen !== this._gen) return;
      }
      await this._playHand(gen); if (gen !== this._gen) return;

      // settle this hand into the 场 standings; the 场 ends once any player reaches MATCH_TARGET
      const r = this.game.result;
      for (let s = 0; s < SEATS; s++) this.scores[s] += r.delta[s];
      this.handsPlayed++;
      const matchOver = Math.max(...this.scores) >= MATCH_TARGET;
      this.firstBidder = (this.firstBidder + 1) % SEATS; // rotate who calls first next hand

      await this._awaitNext(gen); if (gen !== this._gen) return;
      if (matchOver) { this.pushEvent({ t: 'matchOver', scores: this.scores.slice() }); this.onMatchOver(this.scores.slice()); return; }
      this._save(); // persist 场 standings between hands (a restart resumes here)
    }
  }

  // Drive 叫分 until a landlord emerges (true) or everyone passes → redeal (false). Each resolved
  // bid pushes a 'bid' event; a human's turn awaits their decideBid.
  async _runBidding(gen) {
    const g = this.game;
    while (g.phase === PHASE.BID) {
      const seat = g.bidTurn;
      let call;
      if (this.isHuman(seat)) {
        const m = await this._await(seat, 'bid', gen); if (gen !== this._gen) return false;
        call = m && Number.isFinite(+m.call) ? +m.call : 0; // timeout / illegal → 不叫
      } else {
        await delay(BOT_THINK_MS); if (gen !== this._gen) return false;
        call = chooseBid(g, seat, this.level, Math.random);
      }
      const highBefore = g.highBid;
      g.placeBid(seat, call);
      const effective = g.highBid > highBefore ? g.highBid : 0; // a call ≤ highBid was treated as 不叫
      this.pushEvent({ t: 'bid', seat, call: effective, highBid: g.highBid });
      if (gen !== this._gen) return false;
    }
    if (g.result && g.result.redeal) return false;
    this.pushEvent({ t: 'bidEnd', landlord: g.landlord, bid: g.bid, bottom: g.bottom.slice() });
    return true;
  }

  async _playHand(gen) {
    const g = this.game;
    for (;;) {
      if (gen !== this._gen) return;
      this._save();
      if (g.phase === PHASE.OVER) { this.pushEvent({ t: 'over', result: g.result, matchEnd: this._matchEnd() }); return; }
      const seat = g.turn;
      if (this.isHuman(seat)) {
        const m = await this._await(seat, 'play', gen); if (gen !== this._gen) return;
        this._applyHumanPlay(seat, m);
      } else {
        await delay(BOT_THINK_MS); if (gen !== this._gen) return;
        this._applyBotPlay(seat);
      }
    }
  }

  // A human's play move. cardIds → validate + play; pass → only if not the leader; a timeout/illegal
  // move (null msg) auto-acts: pass if following, else the smallest legal lead.
  _applyHumanPlay(seat, m) {
    const g = this.game;
    if (m && m.do === 'play' && Array.isArray(m.cardIds)) {
      const d = g.validatePlay(seat, m.cardIds);
      if (d) { const cards = m.cardIds.map((id) => g.hands[seat].find((c) => c.id === id)); g.play(seat, m.cardIds); this._emitPlay(seat, m.cardIds, cards, d); return; }
    }
    if (m && m.do === 'pass' && seat !== g.leadSeat) { this._emitPass(seat); g.play(seat, []); this._afterPass(g); return; }
    this._autoAct(seat); // timeout or illegal
  }
  _applyBotPlay(seat) {
    const g = this.game;
    const mv = chooseMove(g, seat, this.level, Math.random);
    if (mv.pass || !mv.cardIds || !mv.cardIds.length) {
      if (seat === g.leadSeat) return this._autoAct(seat); // a leader cannot pass (safety)
      this._emitPass(seat); g.play(seat, []); this._afterPass(g); return;
    }
    const d = g.validatePlay(seat, mv.cardIds);
    if (!d) return this._autoAct(seat);
    const cards = mv.cardIds.map((id) => g.hands[seat].find((c) => c.id === id));
    g.play(seat, mv.cardIds); this._emitPlay(seat, mv.cardIds, cards, d);
  }
  _autoAct(seat) {
    const g = this.game;
    if (seat !== g.leadSeat) { this._emitPass(seat); g.play(seat, []); this._afterPass(g); return; }
    const moves = legalMoves(g.hands[seat].map((c) => c.rank), null);
    const mv = moves.sort((a, b) => a.size - b.size || a.rank - b.rank)[0];
    const ids = mapRanksToIds(g.hands[seat], mv.ranks);
    const d = g.validatePlay(seat, ids); const cards = ids.map((id) => g.hands[seat].find((c) => c.id === id));
    g.play(seat, ids); this._emitPlay(seat, ids, cards, d);
  }
  // 'play' must be emitted BEFORE g.play() so the view still shows the played cards in-hand? No — the
  // client reads ev.cards (the played card objects) for the felt; the view's hand should already be
  // without them. So emit AFTER applying. (cards captured before removal above.)
  _emitPlay(seat, cardIds, cards, d) {
    this.pushEvent({ t: 'play', seat, cardIds, cards, move: { type: d.type, rank: d.rank, len: d.len, size: d.size, ranks: d.ranks } });
  }
  _emitPass(seat) { this.pushEvent({ t: 'pass', seat }); }
  // After a pass that ENDED a trick (lead reset to free), tell clients so they clear the felt.
  _afterPass(g) { if (g.phase === PHASE.PLAY && g.lead === null) this.pushEvent({ t: 'trickEnd', winner: g.leadSeat }); }

  // await ONE human's move; the 'await' frame tells that seat it's on the clock. Times out → null.
  _await(seat, kind, gen) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this._waiting && this._waiting.gen === gen) { this._waiting = null; resolve(null); } }, TURN_TIMEOUT_MS);
      this._waiting = { seat, kind, gen, deadline: Date.now() + TURN_TIMEOUT_MS, finish: (m) => { clearTimeout(timer); this._waiting = null; resolve(m); } };
      this.pushEvent({ t: 'await', who: kind, seat, highBid: this.game ? this.game.highBid : 0, timeout: TURN_TIMEOUT_MS, total: TURN_TIMEOUT_MS });
    });
  }

  // wait for every human to click 下一局 (bots/offline don't block; no timeout — hold for humans).
  _awaitNext(gen) {
    const need = new Set(this.humans());
    if (need.size === 0) return delay(600);
    this.pushEvent({ t: 'handEnd' });
    return new Promise((resolve) => { this._next = { need, gen, finish: () => { this._next = null; resolve(); } }; });
  }

  // Hold the bots until every human's deal animation finishes (each sends 'dealDone'), so the bots
  // start playing on a clean, dealt table — exactly like offline. A timeout guards a client that
  // never acks so the hand can't wedge.
  _awaitDealDone(gen) {
    const need = new Set(this.humans());
    if (need.size === 0) return delay(200);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this._dealAck && this._dealAck.gen === gen) this._dealAck.finish(); }, DEAL_ACK_TIMEOUT_MS);
      this._dealAck = { need, gen, finish: () => { clearTimeout(timer); this._dealAck = null; resolve(); } };
    });
  }

  // A human gives up the live game → their seat becomes a bot in place; the play loop drives it from
  // here on. Any request pending from that seat is released so the bot takes over immediately. Score
  // recording (keyed on seat.kind==='human' in index.js) skips it. Returns true if it was a human.
  forfeit(seat) {
    if (!this.isHuman(seat)) return false;
    this.seats[seat] = { kind: 'bot', name: this.seats[seat].name };
    if (this._next && this._next.need.has(seat)) { this._next.need.delete(seat); if (this._next.need.size === 0) this._next.finish(); }
    if (this._dealAck && this._dealAck.need.has(seat)) { this._dealAck.need.delete(seat); if (this._dealAck.need.size === 0) this._dealAck.finish(); }
    if (this._waiting && this._waiting.seat === seat) this._waiting.finish(null); // null → the loop auto-acts, then plays as a bot
    return true;
  }

  dispose() {
    this._gen++;
    const w = this._waiting, nx = this._next, da = this._dealAck;
    this._waiting = this._next = this._dealAck = null;
    if (w) w.finish(null);
    if (nx) nx.finish();
    if (da) da.finish();
  }
}

// Map a multiset of rank numbers to concrete card ids from a hand (used for auto-acting).
function mapRanksToIds(hand, ranks) {
  const pool = hand.slice(); const ids = [];
  for (const r of ranks) { const i = pool.findIndex((c) => c.rank === r); if (i >= 0) { ids.push(pool[i].id); pool.splice(i, 1); } }
  return ids;
}
