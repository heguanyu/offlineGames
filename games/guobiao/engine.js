// 国标麻将 (Chinese Official / MCR) rules engine. Pure logic, no DOM. Reuses the
// shared tile model + decomposition from ../mahjong/engine.js and the fan scorer
// in ./score.js. Distinctive vs. the Tianjin game: 吃 (chow), win off a discard
// (点炮) as well as self-draw, no wilds, and an 8-fan minimum to win (起和8番).
import {
  KINDS, suitOf, rankOf, isNumberSuit, tileName, freshTiles, shuffle, toCounts, decompose,
} from '../mahjong/engine.js';
import { scoreStandard, scoreSpecial } from './score.js';

export { tileName };
export const MIN_FAN = 8;

export const PHASE = {
  AWAIT_DISCARD: 'await-discard',
  AWAIT_CLAIM: 'await-claim', // a discard is on the table; claimQueue[0] decides
  OVER: 'over',
};

const WIND_NAMES = ['东', '南', '西', '北'];

// Convert an engine meld + decomposition into the scorer's meld shape, marking
// the meld completed by a winning discard as exposed (it isn't a concealed set).
function buildMelds(exposed, decompGroups, ctx) {
  const out = exposed.map((m) => ({ type: m.type, tiles: m.tiles.slice(), concealed: !!m.concealed }));
  for (const g of decompGroups) {
    if (g.type === 'pair') continue;
    const isPung = g.type === 'pung';
    const tiles = isPung ? [g.kinds[0], g.kinds[0], g.kinds[0]] : g.kinds.slice();
    const concealed = !(ctx.winByDiscard && tiles.includes(ctx.winningTile));
    out.push({ type: isPung ? 'pung' : 'chow', tiles, concealed });
  }
  return out;
}

// Best fan result for a 14-tile hand (concealed incl. the winning tile) plus the
// already-exposed melds, or null if it isn't a legal mahjong shape.
export function analyzeWin(concealed, exposed, ctx) {
  let best = null;
  if (exposed.length === 0 && concealed.length === 14) best = scoreSpecial(concealed, ctx);
  const needMelds = 4 - exposed.length;
  for (const d of decompose(concealed, 0, needMelds)) {
    const pairG = d.find((g) => g.type === 'pair');
    if (!pairG) continue;
    const melds = buildMelds(exposed, d, ctx);
    const r = scoreStandard(melds, pairG.kinds[0], { ...ctx, concealedHand: exposed.every((m) => m.concealed) });
    if (!best || r.fan > best.fan) best = { ...r, pair: pairG.kinds[0] };
  }
  return best;
}

// Chow options for `kind` (number tile): the pairs of held tiles that complete a
// run with it. Returns arrays of two tile ids each.
function chowPairs(handCounts, kind) {
  if (!isNumberSuit(kind)) return [];
  const r = rankOf(kind), base = kind - (r - 1); // suit's rank-1 id
  const at = (rr) => base + (rr - 1);
  const opts = [];
  if (r >= 3 && handCounts[at(r - 2)] && handCounts[at(r - 1)]) opts.push([at(r - 2), at(r - 1)]);
  if (r >= 2 && r <= 8 && handCounts[at(r - 1)] && handCounts[at(r + 1)]) opts.push([at(r - 1), at(r + 1)]);
  if (r <= 7 && handCounts[at(r + 1)] && handCounts[at(r + 2)]) opts.push([at(r + 1), at(r + 2)]);
  return opts;
}

export class Game {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.dealer = opts.dealer ?? 0;
    this.roundWind = opts.roundWind ?? 0;
    this.scores = opts.scores ? opts.scores.slice() : [0, 0, 0, 0];
    this.minFan = opts.minFan ?? MIN_FAN; // 8 for standard MCR; 0 for 无定番
    this.log = [];
    this._deal(opts);
  }

  _emit(m) { this.log.push(m); }
  isWild() { return false; }          // no wilds in 国标 (kept for scene.js reuse)
  seatWind(p) { return (p - this.dealer + 4) % 4; }
  seatName(p) { return WIND_NAMES[this.seatWind(p)]; }

  _deal(opts) {
    const wall = opts.wall ? opts.wall.slice() : shuffle(freshTiles(), this.rng);
    this.hands = [[], [], [], []];
    for (let n = 0; n < 13; n++) for (let p = 0; p < 4; p++) this.hands[(this.dealer + p) % 4].push(wall.pop());
    this.wall = wall;
    this.melds = [[], [], [], []];
    this.discards = [[], [], [], []];
    this.discardLog = [];
    for (const h of this.hands) h.sort((a, b) => a - b);
    this.turn = this.dealer;
    this.phase = PHASE.AWAIT_DISCARD;
    this.drawnTile = null;
    this.afterKong = false;
    this.firstGoAround = true;
    this.claimQueue = null;
    this.result = null;
    this._draw(this.dealer, false);
  }

  _winCtx(player, winningTile, byDiscard) {
    return {
      selfDraw: !byDiscard,
      winByDiscard: byDiscard,
      winningTile,
      roundWind: this.roundWind,
      seatWind: this.seatWind(player),
      lastTile: this.wall.length === 0,
      afterKong: this.afterKong && !byDiscard,
    };
  }

  _draw(player, fromKong) {
    if (this.wall.length === 0) { this._drawGame(); return; }
    const tile = this.wall.pop();
    this.hands[player].push(tile);
    this.hands[player].sort((a, b) => a - b);
    this.drawnTile = tile;
    this.afterKong = fromKong;
    this.turn = player;

    const r = analyzeWin(this.hands[player], this.melds[player], this._winCtx(player, tile, false));
    if (r && r.fan >= this.minFan) { this._win(player, r, false, null); return; }
    this.phase = PHASE.AWAIT_DISCARD;
  }

  // ---- self kong (concealed / added) ----
  selfKongOptions(player) {
    if (this.phase !== PHASE.AWAIT_DISCARD || this.turn !== player) return [];
    const counts = toCounts(this.hands[player]);
    const opts = [];
    for (let k = 0; k < KINDS; k++) if (counts[k] === 4) opts.push({ type: 'concealed', kind: k });
    for (const m of this.melds[player]) if (m.type === 'pung' && this.hands[player].includes(m.kind ?? m.tiles[0])) opts.push({ type: 'added', kind: m.tiles[0] });
    return opts;
  }
  selfKong(player, kind) {
    const hand = this.hands[player];
    const added = this.melds[player].find((m) => m.type === 'pung' && m.tiles[0] === kind);
    if (added) {
      hand.splice(hand.indexOf(kind), 1);
      added.type = 'kong'; added.tiles = [kind, kind, kind, kind];
    } else {
      for (let c = 0; c < 4; c++) hand.splice(hand.indexOf(kind), 1);
      this.melds[player].push({ type: 'kong', kind, tiles: [kind, kind, kind, kind], concealed: true });
    }
    this._emit(`${this.seatName(player)} 杠`);
    this._draw(player, true);
  }

  discard(player, tile) {
    if (this.turn !== player || this.phase !== PHASE.AWAIT_DISCARD) throw new Error('not your turn');
    const hand = this.hands[player];
    const i = hand.indexOf(tile);
    if (i < 0) throw new Error('tile not in hand');
    hand.splice(i, 1);
    this.discards[player].push(tile);
    this.discardLog.push({ player, kind: tile });
    this.lastDiscard = { player, kind: tile };
    this.drawnTile = null;
    this.firstGoAround = this.firstGoAround && player !== (this.dealer + 3) % 4;

    this.claimQueue = this._buildClaims(player, tile);
    if (this.claimQueue.length) this.phase = PHASE.AWAIT_CLAIM;
    else this._advance(player);
  }

  // Ordered list of claim offers: wins (by turn order) > pung/kong > chow.
  _buildClaims(discarder, kind) {
    const offers = [];
    for (let off = 1; off <= 3; off++) {
      const p = (discarder + off) % 4;
      const test = analyzeWin(this.hands[p].concat(kind), this.melds[p], this._winCtx(p, kind, true));
      if (test && test.fan >= this.minFan) offers.push({ player: p, type: 'win', result: test });
    }
    for (let off = 1; off <= 3; off++) {
      const p = (discarder + off) % 4;
      const n = this.hands[p].filter((id) => id === kind).length;
      if (n >= 3) { offers.push({ player: p, type: 'kong', kind }); break; }
      if (n >= 2) { offers.push({ player: p, type: 'pung', kind }); break; }
    }
    const xia = (discarder + 1) % 4; // 下家 may 吃
    const pairs = chowPairs(toCounts(this.hands[xia]), kind);
    if (pairs.length) offers.push({ player: xia, type: 'chow', kind, options: pairs });
    return offers;
  }

  currentClaim() { return this.claimQueue && this.claimQueue[0]; }

  claimPass() {
    if (this.phase !== PHASE.AWAIT_CLAIM) throw new Error('no claim');
    this.claimQueue.shift();
    if (this.claimQueue.length === 0) this._advance(this.lastDiscard.player);
  }

  // Take the head claim. `detail` = chosen chow option (array of 2 ids) for 吃.
  claimTake(detail) {
    const c = this.currentClaim();
    if (!c) throw new Error('no claim');
    const discarder = this.lastDiscard.player;
    const kind = this.lastDiscard.kind;
    if (c.type === 'win') { this._win(c.player, c.result, true, discarder); return; }
    // consume the discarded tile into a meld
    this.discards[discarder].pop();
    this.discardLog.pop();
    const hand = this.hands[c.player];
    this.firstGoAround = false;
    this.claimQueue = null;
    if (c.type === 'chow') {
      const opt = detail || c.options[0];
      for (const t of opt) hand.splice(hand.indexOf(t), 1);
      const tiles = [opt[0], opt[1], kind].sort((a, b) => a - b);
      this.melds[c.player].push({ type: 'chow', tiles, concealed: false, fromDiscard: discarder });
      this._emit(`${this.seatName(c.player)} 吃`);
      this.turn = c.player; this.phase = PHASE.AWAIT_DISCARD; this.drawnTile = null;
    } else if (c.type === 'pung') {
      for (let i = 0; i < 2; i++) hand.splice(hand.indexOf(kind), 1);
      this.melds[c.player].push({ type: 'pung', kind, tiles: [kind, kind, kind], concealed: false, fromDiscard: discarder });
      this._emit(`${this.seatName(c.player)} 碰`);
      this.turn = c.player; this.phase = PHASE.AWAIT_DISCARD; this.drawnTile = null;
    } else { // kong from discard (明杠)
      for (let i = 0; i < 3; i++) hand.splice(hand.indexOf(kind), 1);
      this.melds[c.player].push({ type: 'kong', kind, tiles: [kind, kind, kind, kind], concealed: false, fromDiscard: discarder });
      this._emit(`${this.seatName(c.player)} 杠`);
      this.turn = c.player;
      this._draw(c.player, true); // replacement draw → may 杠上开花
    }
  }

  _advance(fromPlayer) {
    this._draw((fromPlayer + 1) % 4, false);
  }

  _win(player, result, byDiscard, payer) {
    this.phase = PHASE.OVER;
    const payments = this._settle(player, result.fan, byDiscard ? payer : null);
    this.result = { type: 'win', winner: player, fan: result.fan, fans: result.fans, byDiscard, payer, payments };
    this._emit(`${this.seatName(player)} ${byDiscard ? '和牌' : '自摸'} ${result.fan}番`);
  }

  // MCR payment: winner gets (fan + 8). Self-draw → each pays it. Discard → the
  // 点炮者 pays (fan + 8), the other two pay the 8 base each.
  _settle(winner, fan, payer) {
    const pay = new Array(4).fill(0);
    const full = fan + 8;
    for (let p = 0; p < 4; p++) {
      if (p === winner) continue;
      const amt = (payer == null) ? full : (p === payer ? full : 8);
      pay[p] = -amt; pay[winner] += amt;
    }
    for (let p = 0; p < 4; p++) this.scores[p] += pay[p];
    return pay;
  }

  _drawGame() { this.phase = PHASE.OVER; this.result = { type: 'draw' }; this._emit('荒牌'); }

  nextDealer() { return (this.dealer + 1) % 4; } // MCR: dealer passes every hand

  // Tiles that complete a win of at least `minFan` for `player` from the given
  // 13-tile hand. Uses the self-draw context (the highest-scoring way to win on
  // a tile: it includes 自摸 / 不求人 / 暗刻), so a hand that's ready by self-draw
  // counts as 听 even if winning off a discard would fall short of the minimum.
  handWaits(hand, player) {
    const waits = [];
    for (let k = 0; k < KINDS; k++) {
      const r = analyzeWin(hand.concat(k), this.melds[player], {
        selfDraw: true, winByDiscard: false, winningTile: k,
        roundWind: this.roundWind, seatWind: this.seatWind(player),
        lastTile: false, afterKong: false,
      });
      if (r && r.fan >= this.minFan) waits.push(k);
    }
    return waits;
  }

  // Listening status for the UI: tiles that complete a winning hand.
  tenpaiInfo(player) {
    const hand = this.hands[player];
    if ((hand.length % 3) !== 1) return { tenpai: false, waits: [] };
    const waits = this.handWaits(hand, player);
    return { tenpai: waits.length > 0, waits };
  }
}
