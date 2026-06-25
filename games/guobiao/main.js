// 国标麻将 — UI glue. A subtype of the shared MahjongGame controller (mahjong-common/
// game-base.js): it reuses the mahjong rendering (scene.js), audio (sound.js) and
// hand-order (handorder.js) layers and the base controller's turn-timer/scoreboard/
// reconnect/menu plumbing, and brings its own rules engine + AI and the claim-queue
// orchestration (胡 > 碰/杠 > 吃 priority, win off discards 点炮, 听).
import { PHASE, tileName, MIN_FAN } from './engine.js';
import { LEVELS, LEVEL_NAMES } from './ai.js';
import { createBackend } from './backend.js';
import { MahjongScene } from '../mahjong-common/scene.js';
import { MahjongScene2D } from '../mahjong-common/scene2d.js';
import { Sound } from '../mahjong-common/sound.js';
import { buildOrder } from '../mahjong-common/handorder.js';
import { $, faceTileEl, mkBtn, makeToast, bindKeys, startGamepad, forceLandscape, renderSeatHands } from '../mahjong-common/ui-util.js';
import { BOT_NAMES } from '../mahjong-common/bot-names.js';
import { serverUrl } from '../mahjong-common-online/server-url.js';
import { clientUidSync } from '../../shared/client-id.js';
import { MahjongGame, HUMAN, WIND, SEAT_LABEL } from '../mahjong-common/game-base.js';

const sound = new Sound();
const toast = makeToast();
const FAST = !!new URLSearchParams(location.search).get('fast');
const AI_DELAY = FAST ? 35 : 650;
// Online mode (mirrors 天津). ?online=1 means the lobby started a 国标 table and this page is driven
// by the remote server via the RemoteBackend (games/guobiao/backend.js); everything online is gated
// on ONLINE, so with it unset the page is the offline single-player game, unchanged.
const ONLINE = !!new URLSearchParams(location.search).get('online');
// Viewer mode (online only): ?viewer=1&vseat=N&vtable=T → watch human seat N of table T, read-only.
const VIEWER = ONLINE && !!new URLSearchParams(location.search).get('viewer');
const VIEWER_SEAT = VIEWER ? (parseInt(new URLSearchParams(location.search).get('vseat'), 10) || 0) : 0;
const VIEWER_TABLE = VIEWER ? (parseInt(new URLSearchParams(location.search).get('vtable'), 10) || 0) : 0;
const ONLINE_URL = serverUrl(); // the game server endpoint — see mahjong-common-online/server-url.js

// A bot's 吃/碰/杠 is shown lifted for CLAIM_DEMO_MS; logic is held until it settles
// (+ CLAIM_SETTLE_MS). Both collapse to ~0 under ?fast=1 for tests.
const CLAIM_DEMO_MS = FAST ? 60 : 2000;
const CLAIM_SETTLE_MS = FAST ? 20 : 380;
// A bot's discard flies from its hand to the center halt, holds ~1s, then drops into
// the pool; the tick is locked for the duration. 快速模式 (fastMode) / ?fast=1 disables it.
const DISCARD_DEMO_MS = 900;  // 0.4s rise + ~0.5s halt at the center
const DISCARD_SETTLE_MS = 220; // covers the ~0.18s fall into the pool
const delay = (ms) => new Promise((r) => setTimeout(r, ms)); // awaited by onBackendEvent to hold the backend during animations

// Per-page config (set by each index.html before this module loads). The 无定番
// variant uses minFan: 0 and its own storage key so the two games keep separate
// scores. Defaults to standard MCR.
const CFG = window.MJ_CONFIG || { minFan: MIN_FAN, sessionKey: 'guobiao' };

// Phones get the flat 2D (DOM) board instead of the WebGL table (see scene2d.js):
// smaller screen, lower battery. Decide by screen real estate (short side in CSS px)
// with the iPhone UA as a hint; `?flat=1` / `?d3=1` force a renderer for testing.
const FLAT = (() => {
  const q = new URLSearchParams(location.search);
  if (q.get('flat')) return true;
  if (q.get('d3')) return false;
  return Math.min(screen.width, screen.height) < 600 || /iPhone|iPod/.test(navigator.userAgent);
})();
if (FLAT) {
  document.body.classList.add('flat');
  // Flat layout: move the floating scoreboard into the left nav rail (just under 局况).
  const hdr = document.querySelector('header');
  const ss = document.getElementById('score-stack'), ri = document.getElementById('round-info');
  if (ss && hdr) hdr.insertBefore(ss, ri ? ri.nextSibling : hdr.firstChild);
}
const Renderer = FLAT ? MahjongScene2D : MahjongScene;

// One 番种 label for the win UI (buttons + result chips). Fans are { name, points }; this renders
// defensively so an unexpected shape can never surface as "[object Object]" (the winning reason).
function fanLabel(f) { return (f && typeof f === 'object') ? (f.name != null ? String(f.name) : '') : String(f ?? ''); }

const noWild = () => false; // 国标 has no wilds → hand order is just sorted

class GuobiaoGame extends MahjongGame {
  constructor() {
    super();
    this.level = LEVELS.NORMAL;
    this.session = this.loadSession();
    this.fastMode = localStorage.getItem(CFG.sessionKey + '-fast') !== '0'; // checked (on) by default
    this.lockedTing = false; this.tingWaits = []; // once 听, the seat auto-plays (tsumogiri)
    this.tsumogiriPending = false; // the next human discard event is a 听 auto-draw-discard → reveal deck→pool
    this.tingRevealIdx = -1;       // discardLog index of a 听 tsumogiri to reveal deck→center→pool
    this._tingSig = ''; this._ting = []; // tingDiscards() cache, keyed by the sorted hand
    const lv = parseInt(localStorage.getItem(CFG.sessionKey + '-level'), 10); if (lv >= 1 && lv <= 3) this.level = lv;
  }

  loadSession() {
    try { const s = JSON.parse(localStorage.getItem(CFG.sessionKey + '-session')); if (s && Array.isArray(s.scores)) return s; } catch {}
    return { scores: [0, 0, 0, 0], dealer: 0, roundWind: 0, hand: 1 };
  }
  saveSession() {
    this.session.scores = this.game ? this.game.scores.slice() : this.session.scores;
    localStorage.setItem(CFG.sessionKey + '-session', JSON.stringify(this.session));
    localStorage.setItem(CFG.sessionKey + '-level', String(this.level));
  }

  // ---- hand order (no wilds → just sorted; scene.js flanks the drawn tile) ----
  renderedHand() { return buildOrder(this.game.hands[HUMAN], noWild); }
  selectableHandIndices() { return this.renderedHand().map((_, i) => i); }

  // ---- rendering ----
  // The HTML HUD (header / scores / nameplates), split out so the deal animation
  // can show it without driving the 3D table.
  renderHud() {
    const minTxt = CFG.minFan > 0 ? `起和 ${CFG.minFan}番` : '无定番';
    // Online the server owns the match (no local session) — read the 圈 from the view; offline use the session.
    const roundWind = (ONLINE && this.game) ? (this.game.roundWind || 0) : this.session.roundWind;
    const r1 = ONLINE ? `<b>${WIND[roundWind]}圈</b> · 联机` : `<b>${WIND[roundWind]}圈</b> · 第 ${this.session.hand} 局`;
    const r2 = ONLINE ? minTxt : `难度 · <b>${LEVEL_NAMES[this.level]}</b> · ${minTxt}`;
    $('round-info').innerHTML = `<span class="ri-round">${r1}</span><span class="ri-level">${r2}</span>`;
    this.renderScores();
    $('wall-count').textContent = `余 ${this.game.wall.length} 张`;
    for (let p = 0; p < 4; p++) this.renderPlate(p);
  }

  render() {
    this.renderHud();
    const selectable = this.selectableHandIndices();
    if (this.selIndex >= selectable.length) this.selIndex = Math.max(0, selectable.length - 1);
    const myTurn = this.game.turn === HUMAN && this.game.phase === PHASE.AWAIT_DISCARD;
    const showSel = myTurn && !this.lockedTing; // no manual selection once 听
    // Reveal the drawn tile into the hand when it's a live turn, or — in 听 — only
    // when it WINS (it then stays for the 胡 confirmation). A non-winning 听 draw is
    // never shown in the hand; it reveals straight into the pool (see tick()).
    const tingWin = this.lockedTing && myTurn && this.game.selfDrawWin;
    const revealing = this.scene && this.scene.handDrawRevealing; // drawn tile still flying in → no selection yet
    // While a bot's discard fly is playing, hold the human's turn: the turn may have
    // advanced (the human drew), but we don't reveal that draw or allow selection yet —
    // show the pre-draw 13 tiles; the reveal plays when the tick resumes.
    const mtSel = showSel && !this.animating;
    let handForSync = this.renderedHand();
    // Only when it's the HUMAN's turn has the human drawn — drop that one drawn tile so
    // its reveal waits for the bot's discard fly. (game.drawnTile is a KIND; without the
    // myTurn guard a bot drawing a kind the human holds would wrongly trim a held tile.)
    if (this.animating && myTurn && this.game.drawnTile != null) {
      const di = handForSync.lastIndexOf(this.game.drawnTile);
      if (di >= 0) handForSync = handForSync.slice(0, di).concat(handForSync.slice(di + 1));
    }
    if (this.scene) this.scene.sync(this.game, { renderedHand: handForSync, myTurn: mtSel, selRendered: mtSel && !revealing ? selectable[this.selIndex] : null, claimable: !this.animating && this.isClaimPhase() && !this.lockedTing,
      drawnTile: (!this.animating && (showSel || tingWin) && this.game.drawnTile != null) ? this.game.drawnTile : null,
      tingFlat: this.lockedTing, tingRevealDiscardIdx: this.tingRevealIdx, reveal: this.game.phase === PHASE.OVER });
    this.renderActions();
    this.positionClaimUI();
    this.positionTingBanner();
    this.flushLog();
  }

  // 国标 hides the claim UI during 听 autopilot too (base default is just isClaimPhase).
  claimUIVisible() { return this.isClaimPhase() && !this.lockedTing; }

  // The 听 waits disclaimer floats big, just above the (flat) hand row — anchored to
  // a world point in front of the player's tiles so it tracks the table in any aspect.
  positionTingBanner() {
    const b = $('ting-banner');
    if (this.scene && this.lockedTing && b.textContent) {
      const a = this.scene.worldToScreen(0, 0, 6.0); // a touch toward centre from the hand row
      b.classList.add('show');
      b.style.left = a.x + 'px'; b.style.top = a.y + 'px';
    } else {
      b.classList.remove('show');
    }
  }

  // Seat label: the human shows 玩家; a bot shows its seat name (东方雨…). Online uses the server's
  // name (same seat-based bot name, or a real player's name) with the bot name as fallback. Names are
  // sanitized server-side to CJK/letters only, so they're safe to interpolate.
  plateName(p) {
    if (ONLINE && this.game.seatNames) return this.game.seatNames[p] || (p === HUMAN ? SEAT_LABEL[p] : BOT_NAMES[p]);
    return p === HUMAN ? SEAT_LABEL[p] : BOT_NAMES[p];
  }
  renderPlate(p) {
    const seat = $('plate-' + p);
    const thinking = this.game.phase !== PHASE.OVER && this.game.turn === p && p !== HUMAN;
    const listen = p === HUMAN && (this.lockedTing || this.game.tenpaiInfo(p).tenpai);
    seat.innerHTML =
      `<div class="nameplate${this.game.turn === p && this.game.phase !== PHASE.OVER ? ' active' : ''}">` +
      `<span class="wind">${WIND[this.game.seatWind(p)]}</span><span>${this.plateName(p)}</span>` +
      (p === this.game.dealer ? '<span class="dealer-dot" title="庄"></span>' : '') +
      (listen ? '<span class="listen">听</span>' : '') +
      (thinking ? '<span class="think">思考中…</span>' : '') + `</div>`;
  }

  // Which distinct discards leave the human 听 (ready), with their waits. Cached
  // per hand so it isn't recomputed on every cursor move.
  tingDiscards() {
    const hand = this.game.hands[HUMAN];
    const sig = hand.slice().sort((a, b) => a - b).join(',');
    if (sig === this._tingSig) return this._ting;
    this._tingSig = sig; this._ting = [];
    for (const k of new Set(hand)) {
      const rest = hand.slice(); rest.splice(rest.indexOf(k), 1);
      const waits = this.game.handWaits(rest, HUMAN);
      if (waits.length) this._ting.push({ kind: k, waits });
    }
    return this._ting;
  }

  renderActions() {
    const bar = $('action-bar'); bar.innerHTML = '';
    const center = $('ting-center'); center.innerHTML = ''; // 打出并听牌 / 胡 float here
    const hint = $('hand-hint'); hint.textContent = '';
    const banner = $('ting-banner'); banner.textContent = ''; // 听 waits, floats above the hand
    const buttons = [];

    if (this.lockedTing) {
      // already 听 — autopilot. A winning self-draw pauses it for the pending 胡
      // (shown alone); otherwise the waits disclaimer floats big just above the hand.
      if (this.game.selfDrawWin) {
        const w = this.game.selfDrawWin;
        center.appendChild(mkBtn(`胡 · ${fanLabel(w.fans[0])} · ${w.fan}番`, () => this.doDeclareWin(), false, 'hu'));
      } else {
        banner.textContent = `已听 · 自动出牌（等 ${this.tingWaits.map(tileName).join(' ')}）`;
      }
    } else if (this.animating) {
      // a bot's discard fly is playing — hold all action UI (the 听 banner above still
      // shows via the lockedTing branch when applicable)
    } else if (this.game.phase === PHASE.AWAIT_CLAIM && this.game.currentClaim() && this.game.currentClaim().player === HUMAN) {
      const c = this.game.currentClaim();
      // 点炮 win — a confirm: take it (胡, showing pattern + score) or 过 to play on.
      // The 胡 floats big + centered (like 打出并听牌); 过 stays in the bottom bar.
      if (c.type === 'win') { center.appendChild(mkBtn(`胡 · ${fanLabel(c.result.fans[0])} · ${c.result.fan}番`, () => this.doClaimTake(), false, 'hu')); }
      else if (c.type === 'pung') buttons.push(mkBtn('碰', () => this.doClaimTake()));
      else if (c.type === 'kong') buttons.push(mkBtn('杠', () => this.doClaimTake()));
      else if (c.type === 'chow') {
        c.options.forEach((opt) => buttons.push(this.mkChowBtn(opt, this.game.lastDiscard.kind)));
      }
      buttons.push(mkBtn('过', () => this.doClaimPass(), true));
      hint.textContent = `${SEAT_LABEL[this.game.lastDiscard.player]} 打出 ${tileName(this.game.lastDiscard.kind)}`;
    } else if (this.game.phase === PHASE.AWAIT_DISCARD && this.game.turn === HUMAN) {
      if (this.game.selfDrawWin) { // self-draw win available — offer 胡 (you may still play on)
        const w = this.game.selfDrawWin;
        center.appendChild(mkBtn(`胡 · ${fanLabel(w.fans[0])} · ${w.fan}番`, () => this.doDeclareWin(), false, 'hu')); // big + centered, like 打出并听牌
      }
      for (const k of this.game.selfKongOptions(HUMAN)) buttons.push(mkBtn(`杠 ${tileName(k.kind)}`, () => this.doSelfKong(k.kind), true));
      // If the selected discard would leave a ready hand, present 打出并听牌 (declare
      // 听, red) at screen center with the plain 打出 to its right; otherwise 打出
      // stays in the bottom bar. No text disclaimer — the red button is the 听 signal.
      const sel = this.renderedHand()[this.selectableHandIndices()[this.selIndex]];
      if (this.tingDiscards().some((t) => t.kind === sel)) {
        center.appendChild(mkBtn('打出并听牌', () => this.discardSelected(true), false, 'riichi'));
      }
      // plain discard has no button — tap the selected tile / A / controller-A
    }
    if (this.focusIndex >= buttons.length) this.focusIndex = buttons.length - 1;
    buttons.forEach((b, i) => { if (i === this.focusIndex && this.isClaimPhase()) b.classList.add('focus'); bar.appendChild(b); });
  }
  // A 吃 option rendered as the actual 3-tile run (faces), with a red ▼ over the
  // claimed tile, as one big button. `opt` is the two hand tiles; `claimed` is the
  // discard being chowed.
  mkChowBtn(opt, claimed) {
    const b = document.createElement('button'); b.className = 'act-btn chow-btn';
    for (const t of [opt[0], opt[1], claimed].sort((a, b) => a - b)) {
      const cell = document.createElement('div');
      cell.className = 'chow-cell' + (t === claimed ? ' claimed' : '');
      cell.appendChild(faceTileEl(t, { lg: true }));
      b.appendChild(cell);
    }
    b.addEventListener('click', () => this.doClaimTake(opt));
    return b;
  }
  isClaimPhase() { return this.game.phase === PHASE.AWAIT_CLAIM && this.game.currentClaim() && this.game.currentClaim().player === HUMAN; }

  // Which 杠: 暗杠 (concealed) else 明杠 — read off the seat's latest kong meld (国标 has no 金杠).
  kongSlug(seat) {
    const km = (this.game.melds[seat] || []).filter((m) => m.type === 'kong').pop();
    return km && km.concealed ? 'ankong' : 'mingkong';
  }
  flushLog() {
    for (let i = this.lastLogLen; i < this.game.log.length; i++) {
      const line = this.game.log[i];
      // log lines start with the seat's WIND (东/南/西/北) — map it back to the seat so
      // the call is spoken in that seat's voice.
      const tok = line.split(' ')[0];
      let seat = 0; for (let p = 0; p < 4; p++) if (WIND[this.game.seatWind(p)] === tok) { seat = p; break; }
      const w = this.game.seatWind(seat);   // voice persona = the seat's wind (0..3 东南西北)
      if (/自摸|和牌/.test(line)) {
        toast(line, true); (this.game.result && this.game.result.winner === HUMAN ? sound.win() : sound.lose());
        if (this.game.result) sound.call(this.game.result.byDiscard ? 'dianpao' : 'zimo', this.game.seatWind(this.game.result.winner));
      }
      else if (/荒牌/.test(line)) { toast(line, true); sound.drawGame(); }
      else if (/杠/.test(line)) { toast(line, false); sound.kong(); sound.call(this.kongSlug(seat), w); }
      else if (/碰/.test(line)) { toast(line, false); sound.pung(); sound.call('pung', w); }
      else if (/吃/.test(line)) { toast(line, false); sound.select(); sound.call('chi', w); }
    }
    this.lastLogLen = this.game.log.length;
  }

  // ---- orchestration (backend-driven) ----
  // The backend pushes one event per move; this async handler is the whole UI-side orchestration
  // (it replaced the old synchronous tick() loop). Each case renders + plays the matching
  // animation/sound and AWAITS it, so the backend (local sim or remote server) is held until the
  // table catches up before the next event. The 吃/碰/杠/和 toasts + voices ride the engine log and
  // flush inside render(), so most cases just call render().
  async onBackendEvent(ev) {
    if (ev.type === 'disconnected') { this.showReconnecting(); return; } // lost the server → banner, then bail to lobby
    if (ev.type === 'gameGone') { this.returnHub(); return; }            // server has no game for us → lobby
    if (ONLINE) this.hideReconnecting();                                 // any real frame means we're connected again
    const st = this.backend.getState();
    if (st) this.game = st;
    if (ONLINE) this.syncTurnTimer(ev); // show the countdown whenever a player is on the clock (no-op offline)
    switch (ev.type) {
      case 'deal':
        $('result-overlay').classList.add('hidden'); // the next hand is dealing → hide the result panel
        this.selIndex = 0; this.focusIndex = 0; this.lockedTing = false; this.tingWaits = []; this.lastLogLen = 0;
        sound.stopMusic();
        // Drop a 听 disclaimer left over from the hand just played — synchronously, before
        // the deal animation, so it never lingers over 发牌中… (render() only clears it once
        // the deal finishes). positionTingBanner re-adds 'show' later only while 听.
        { const tb = $('ting-banner'); tb.textContent = ''; tb.classList.remove('show'); }
        if (!ONLINE) this.saveSession();
        if (this.scene && !FAST) { // serve the tiles from the wall, then play
          this.dealing = true;
          this.renderHud();
          $('action-bar').innerHTML = ''; $('ting-center').innerHTML = '';
          $('hand-hint').textContent = '发牌中…';
          await new Promise((res) => this.scene.beginDeal(this.game, res, () => sound.select()));
          this.dealing = false;
        }
        this.render();
        if (ONLINE && this.backend.dealDone) this.backend.dealDone(); // table's dealt → let the server start the opponents
        return;

      case 'discard': {
        const human = ev.player === HUMAN;
        sound.discard();
        // 听 tsumogiri (an AUTO draw-discard, never shown in the hand) → reveal it deck→center→pool.
        // The manually-declared 听 discard (报听) is a normal hand discard, so it animates below.
        if (human && this.tsumogiriPending) {
          this.tsumogiriPending = false;
          if (!this.fastMode) sound.sayTile(ev.tile, this.game.seatWind(HUMAN));
          this.tingRevealIdx = ev.discardIndex; this.render(); this.tingRevealIdx = -1;
          return;
        }
        if (human) this.selIndex = Math.min(this.selIndex, this.selectableHandIndices().length - 1);
        else if (!this.fastMode) sound.sayTile(ev.tile, this.game.seatWind(ev.player)); // bot speaks its discard
        if (this.scene && !FAST && !this.fastMode) { // fly to the center halt, hold, drop into the pool
          if (human) sound.sayTile(ev.tile, this.game.seatWind(HUMAN));
          this.animating = true;
          try {
            this.scene.beginDiscardDemo(ev.player, ev.discardIndex, DISCARD_DEMO_MS);
            this.render();
            await delay(DISCARD_DEMO_MS + DISCARD_SETTLE_MS);
          } finally { this.animating = false; }
        }
        this.render();
        return;
      }

      case 'claim':
        if (ev.player === HUMAN) { this.selIndex = 0; } // then they discard
        else if (this.scene && !FAST) { // show the bot's 吃/碰/杠 lifted, hold until it settles
          this.scene.beginClaimDemo(ev.player, CLAIM_DEMO_MS);
          this.render();
          await delay(CLAIM_DEMO_MS + CLAIM_SETTLE_MS);
        }
        this.render();
        return;

      case 'selfKong':
        this.render(); // the 杠 toast + voice flush from the engine log
        return;

      case 'await': // the human must act: a claimable discard, or their own turn
        if (ev.who === 'claim') {
          // Once 听, the seat is on autopilot: take a 胡, pass everything else.
          if (this.lockedTing) { const c = this.game.currentClaim(); if (c && c.type === 'win') this.backend.claim('win'); else this.backend.pass(); return; }
          this.focusIndex = 0; this.render();
          return;
        }
        // who === 'discard'. 听: a non-winning draw is tsumogiri'd automatically (never shown);
        // a winning draw pauses for the centered 胡 confirmation.
        if (this.lockedTing && !this.game.selfDrawWin) { this.tsumogiriPending = true; this.backend.discard(this.game.drawnTile); return; }
        this.ensureSelection(); this.render();
        return;

      case 'over':
        this.render(); // flush the 自摸 / 点炮 / 荒牌 toast + win/lose sound from the log
        this.onlineEndsMatch = ONLINE && !!ev.matchEnd; // set BEFORE showResult so it picks the right button label
        this.showResult();
        if (ev.readied) { // resync after a refresh: reflect a choice we'd already made
          const b = $('next-hand-btn');
          if (this.onlineEndsMatch) { b.disabled = true; b.textContent = '结算中…'; }
          else { this.onlineReadied = true; b.textContent = '✓ 已准备 · 取消'; b.classList.add('readied'); }
        }
        return;

      // ---- online only ----
      case 'sync': // (re)joined a game in progress, or reconnected — render the current state
        this.lastLogLen = this.game.log ? this.game.log.length : 0; // online views carry no log; suppress toasts
        this.ensureSelection(); this.render();
        return;
      case 'matchOver': // server finished the 场 → final standings
        $('result-overlay').classList.add('hidden');
        this.showFinalBoard({ scores: ev.scores, rounds: ev.rounds });
        return;
    }
  }

  // ---- human actions ----
  onPickTile(idx) {
    if (this.dealing || this.animating) return;
    if (this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD || this.lockedTing) return;
    if (this.scene && this.scene.handDrawRevealing) return; // wait until the drawn tile settles
    const id = this.renderedHand()[idx];
    if (id == null) return;
    const pos = this.selectableHandIndices().indexOf(idx);
    if (pos < 0) return;
    if (pos === this.selIndex) this.discardSelected();
    else { this.selIndex = pos; sound.select(); this.render(); }
  }
  // declare=true → 打出并听牌: discard the selected tile AND lock 听 (报听). From
  // then on the seat auto-plays. declare=false → a plain discard with no lock.
  discardSelected(declare) {
    if (this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD || this.lockedTing) return;
    if (this.scene && this.scene.handDrawRevealing) return; // wait until the drawn tile settles
    const id = this.renderedHand()[this.selectableHandIndices()[this.selIndex]];
    if (id == null) return;
    if (declare) { // 报听: lock 听 + start music NOW (synchronously) before handing off to the backend
      const rest = this.game.hands[HUMAN].slice(); rest.splice(rest.indexOf(id), 1);
      const waits = this.game.handWaits(rest, HUMAN);
      if (waits.length) { this.lockedTing = true; this.tingWaits = waits; toast('听！自动出牌', true); sound.startMusic(); } // else not actually 听 → plain discard
    }
    this.selIndex = Math.min(this.selIndex, Math.max(0, this.selectableHandIndices().length - 1));
    this.backend.discard(id); // the 'discard' event animates it, then the backend drives the bots
  }
  // Can the tile under the finger be discarded now? Only on your turn, not while 听
  // autopilot, and not mid drawn-tile reveal. Gates the slide-up drag.
  canPlayTileAt(renderedIdx) {
    if (this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD || this.lockedTing) return false;
    if (this.scene && this.scene.handDrawRevealing) return false; // wait until the drawn tile settles
    return this.renderedHand()[renderedIdx] != null;
  }
  // Slide-up-to-play: discard the exact tile under the finger (a plain discard — slide-up doesn't declare 听).
  playTileAt(renderedIdx) {
    if (!this.canPlayTileAt(renderedIdx)) return false;
    const id = this.renderedHand()[renderedIdx];
    this.selIndex = this.selectableHandIndices().indexOf(renderedIdx);
    this.backend.discard(id);
    return true;
  }
  // A slide takes over the selection: lift this tile, deselect any other. No discard.
  selectTileAt(renderedIdx) {
    const pos = this.selectableHandIndices().indexOf(renderedIdx);
    if (pos < 0) return;
    this.selIndex = pos; this.render();
  }
  doDeclareWin() { if (this.scene && this.scene.handDrawRevealing) return; this.backend.declareWin(); }
  doSelfKong(kind) { if (this.scene && this.scene.handDrawRevealing) return; if (this.game.turn === HUMAN && this.game.phase === PHASE.AWAIT_DISCARD) this.backend.selfKong(kind); }
  // When the freshly-drawn tile finishes its reveal, auto-select it (ready to discard).
  selectDrawnTile() {
    if (this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD || this.lockedTing || this.game.drawnTile == null) return;
    const si = this.selectableHandIndices().indexOf(this.renderedHand().lastIndexOf(this.game.drawnTile));
    if (si >= 0) this.selIndex = si;
    this.render();
  }
  // Take the head claim (碰/杠/吃, or a 点炮 win) — `opt` is the chosen 吃 run; 过 declines it.
  doClaimTake(opt) { if (this.isClaimPhase()) { this.selIndex = 0; this.backend.claim(this.game.currentClaim().type, opt); } }
  doClaimPass() { if (this.isClaimPhase()) this.backend.pass(); }

  // ---- result / new hand ----
  // 得分明细 for the result panel: every seat's net (本局得分) laid out as a 3×3 grid
  // mirroring the table (对家 top, 上家 left, 下家 right, 玩家 bottom), then the human's net vs
  // each opponent with the reason (自摸 / 点炮 / 底) as a subitem. Mirrors 天津's layout.
  breakdownHtml(r) {
    const me = HUMAN;
    const col = (v) => (v > 0 ? '#7ddf8a' : v < 0 ? '#ef9a9a' : '#cfe7db');
    const sgn = (v) => (v > 0 ? '+' : '') + v;
    // overall — 3×3 grid placing each seat where it sits at the table
    const GRID = { 0: [3, 2], 1: [2, 3], 2: [1, 2], 3: [2, 1] };
    const all = [0, 1, 2, 3].map((p) => {
      const [row, c] = GRID[p];
      return `<span class="bd-all-seat${p === me ? ' me' : ''}" style="grid-row:${row};grid-column:${c}">` +
        `${SEAT_LABEL[p]} <b style="color:${col(r.payments[p])}">${sgn(r.payments[p])}</b></span>`;
    }).join('');
    const discarder = (r.byDiscard && this.game.lastDiscard) ? this.game.lastDiscard.player : -1;
    const grps = [1, 2, 3].map((off) => {
      const q = (me + off) % 4;
      let net = 0, why = '—';
      if (r.winner === me) { net = -r.payments[q]; why = !r.byDiscard ? '自摸' : q === discarder ? '点炮' : '底'; }
      else if (q === r.winner) { net = r.payments[me]; why = !r.byDiscard ? '自摸' : discarder === me ? '点炮' : '底'; }
      const sub = `<div class="bd-sub"><span>${net ? why : '—'}</span>` +
        `<span class="s-net" style="color:${col(net)}">${net ? sgn(net) : '—'}</span></div>`;
      return `<div class="bd-grp"><div class="bd-row"><span class="bd-seat">${SEAT_LABEL[q]}</span>` +
        `<span class="bd-net" style="color:${col(net)}">${sgn(net)}</span></div>${sub}</div>`;
    });
    const total = r.payments[me];
    return `<div class="bd-totals"><div class="bd-title">本局得分</div><div class="bd-all">${all}</div></div>` +
      `<div class="bd-title">玩家明细 · <span style="letter-spacing:normal;font-size:1.05rem;font-weight:800;color:${col(total)}">${sgn(total)}</span></div>` +
      grps.join('');
  }

  showResult() {
    const r = this.game.result, ov = $('result-overlay');
    const fansEl = $('result-fans'), scoreEl = $('result-score'), handEl = $('result-hand'), payEl = $('result-payments');
    const winEl = $('result-winning');
    $('ting-center').innerHTML = ''; // clear any floating 打出并听牌 before the modal
    fansEl.innerHTML = ''; handEl.innerHTML = ''; winEl.innerHTML = ''; winEl.classList.remove('show');
    if (r.type === 'draw') {
      $('result-title').textContent = '荒牌 · 流局'; scoreEl.textContent = ''; payEl.textContent = '本局无人和牌';
    } else {
      const w = r.winner;
      $('result-title').textContent = `${SEAT_LABEL[w]}（${WIND[this.game.seatWind(w)]}）${r.byDiscard ? '和牌' : '自摸'}！`;
      for (const f of r.fans) { const c = document.createElement('span'); c.className = 'fan-chip'; c.textContent = `${fanLabel(f)} ${f.points ?? ''}`.trim(); fansEl.appendChild(c); }
      scoreEl.textContent = r.fan + ' 番';
      if (r.winningTile != null) {
        const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = (r.byDiscard ? '点炮' : '自摸') + ' · 和这张';
        winEl.appendChild(cap);
        winEl.appendChild(faceTileEl(r.winningTile, { lg: true }));
        winEl.classList.add('show');
      }
      // Show the winning hand grouped by its pattern (each meld + the 将), so the
      // structure behind the 番种 is visible — not a flat row.
      const winKind = r.winningTile;
      let winMarked = false;
      const addGroup = (tiles, extra) => {
        const wrap = document.createElement('div'); wrap.className = 'meld-group' + (extra || '');
        for (const t of tiles.slice().sort((a, b) => a - b)) {
          const el = faceTileEl(t, { lg: true });
          if (!winMarked && winKind != null && t === winKind) { el.classList.add('win-tile'); winMarked = true; }
          wrap.appendChild(el);
        }
        handEl.appendChild(wrap);
      };
      if (r.melds) {
        for (const m of r.melds) addGroup(m.tiles);
        if (r.pair != null) addGroup([r.pair, r.pair], ' pair');
      } else { // 七对 / 十三幺 — no meld structure; show the sorted hand (+ the 点炮 tile)
        const hand = this.game.hands[w].slice();
        if (r.byDiscard && r.winningTile != null) hand.push(r.winningTile);
        addGroup(hand, ' span');
      }
      payEl.innerHTML = this.breakdownHtml(r);
    }
    renderSeatHands(this.game); // reveal every seat's hand on its border
    sound.stopMusic(); // 听 (if any) is over
    if (!ONLINE) this.saveSession();
    // Online: 下一局 becomes a readiness toggle (我准备好了); the final hand of a 场 ENDS it.
    const nb = $('next-hand-btn'); nb.disabled = false; nb.classList.remove('readied'); this.onlineReadied = false;
    nb.textContent = this.onlineEndsMatch ? '结束并查看总成绩 🏆' : (ONLINE ? '我准备好了' : '下一局');
    ov.classList.remove('hidden');
    this.resultFocus = 0; this.focusResultBtn(); // 下一局 focused by default
  }
  nextHand() {
    if (VIEWER) return; // a spectator can't ready up — the next hand deals when the real players are ready
    if (ONLINE) {
      if (this.onlineEndsMatch) { this.backend.next(); const b = $('next-hand-btn'); b.disabled = true; b.textContent = '结算中…'; return; }
      this.onlineReadied = !this.onlineReadied; // toggle readiness; the server deals once EVERY human is ready
      const b = $('next-hand-btn');
      if (this.onlineReadied) { this.backend.next(); b.textContent = '✓ 已准备 · 取消'; b.classList.add('readied'); }
      else { this.backend.unready(); b.textContent = '我准备好了'; b.classList.remove('readied'); }
      return;
    }
    $('result-overlay').classList.add('hidden');
    const nd = this.game.nextDealer();
    this.session.hand += 1;
    if (nd === 0 && this.game.dealer !== 0) this.session.roundWind = (this.session.roundWind + 1) % 4;
    this.session.dealer = nd;
    this.startHand();
  }
  // Online: connect to the server's table (or spectate a seat). The server is the ground truth — it
  // deals, drives opponents, and PUSHES frames into onBackendEvent; no local session/场 bookkeeping.
  connectOnline() {
    if (!this.scene) { this.scene = new Renderer($('scene')); this.scene.setRotated(this.isPortrait); this.scene.resize(); this.scene.onHandDrawSettled = () => this.selectDrawnTile(); }
    this.backend = createBackend({ mode: 'remote', url: ONLINE_URL, uid: clientUidSync(), name: localStorage.getItem('mahjong-online-name') || '',
      spectate: VIEWER ? { table: VIEWER_TABLE, seat: VIEWER_SEAT } : null });
    this.backend.onEvent((ev) => this.onBackendEvent(ev));
    this.backend.connect();
  }

  // 一场结束 · 最终成绩 (online only — the server owns the 场). data: { scores, rounds }.
  showFinalBoard(data) {
    const scores = data.scores.slice();
    const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a]);
    const top = Math.max(...scores);
    const MEDAL = ['🥇', '🥈', '🥉'];
    const rankOf = (p) => scores.filter((s) => s > scores[p]).length;
    $('final-standings').innerHTML = order.map((p) => {
      const r = rankOf(p), v = scores[p];
      return `<div class="standing${p === HUMAN ? ' me' : ''}"><span class="rank">${MEDAL[r] || (r + 1)}</span>` +
        `<span class="who">${SEAT_LABEL[p]}${p === HUMAN ? '（你）' : ''}</span>` +
        `<span class="pts ${v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'}">${v > 0 ? '+' : ''}${v}</span></div>`;
    }).join('');
    const tiedTop = scores.filter((s) => s === top).length > 1;
    $('final-congrats').textContent = scores[HUMAN] === top ? (tiedTop ? '🎉 恭喜并列第一！' : '🎉 恭喜你赢得这一场！') : '本场惜败，下一场再战！';
    $('final-rounds').innerHTML = this.roundsTableHtml(data.rounds || []);
    $('final-overlay').classList.remove('hidden');
  }
  // 每圈成绩 table from the 场's completed-圈 snapshots (cumulative scores per 圈).
  roundsTableHtml(rounds) {
    const seats = [0, 1, 2, 3];
    const cell = (v) => `<td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'}">${v > 0 ? '+' : ''}${v}</td>`;
    let prev = [0, 0, 0, 0], body = '';
    for (const r of rounds) { body += `<tr><td class="rd-wind">${WIND[r.wind]}圈</td>${seats.map((p) => cell(r.scores[p] - prev[p])).join('')}</tr>`; prev = r.scores; }
    if (!body) body = `<tr><td class="rd-empty" colspan="5">本场还没有完成的圈</td></tr>`;
    const total = rounds.length ? rounds[rounds.length - 1].scores : [0, 0, 0, 0];
    const head = `<tr><th></th>${seats.map((p) => `<th class="${p === HUMAN ? 'me' : ''}">${SEAT_LABEL[p]}</th>`).join('')}</tr>`;
    const foot = `<tr><td class="rd-wind">合计</td>${seats.map((p) => cell(total[p])).join('')}</tr>`;
    return `<table class="rounds-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
  }
  startHand() {
    if (!this.scene) { this.scene = new Renderer($('scene')); this.scene.setRotated(this.isPortrait); this.scene.resize(); this.scene.onHandDrawSettled = () => this.selectDrawnTile(); }
    if (!this.backend) { this.backend = createBackend({ mode: 'local', rng: Math.random, thinkDelay: AI_DELAY }); this.backend.onEvent((ev) => this.onBackendEvent(ev)); }
    this.selIndex = 0; this.focusIndex = 0; this.lockedTing = false; this.tingWaits = []; this.tsumogiriPending = false; this.lastLogLen = 0;
    sound.stopMusic();
    this.saveSession();
    // Hand off to the backend: it deals (the 'deal' event plays the serving flourish), then drives
    // the bots, pausing on an 'await' for the human. Under ?fast=1 (tests) the deal animation is skipped.
    this.backend.startHand({ dealer: this.session.dealer, roundWind: this.session.roundWind, scores: this.session.scores, minFan: CFG.minFan, baseScore: CFG.baseScore, level: this.level });
  }
  newGame() { this.game = null; this.session = { scores: [0, 0, 0, 0], dealer: 0, roundWind: 0, hand: 1 }; this.startHand(); }

  // ---- input dispatch (keyboard + gamepad) ----
  onAction(name) {
    if (!this.gameStarted) return;
    sound.resume();
    if (!$('forfeit-confirm-overlay').classList.contains('hidden')) {
      if (name === 'confirm') this.doForfeit();                                                     // 确认认输
      else if (name === 'cancel' || name === 'menu') $('forfeit-confirm-overlay').classList.add('hidden'); // 取消
      return;
    }
    if (!$('menu-overlay').classList.contains('hidden') || !$('rules-overlay').classList.contains('hidden') || !$('start-overlay').classList.contains('hidden')) {
      if (name === 'cancel' || name === 'menu') this.closeOverlays();
      return;
    }
    if (!$('result-overlay').classList.contains('hidden')) {
      if (name === 'left') { this.resultFocus = 1; this.focusResultBtn(); }      // 返回 (top-left)
      else if (name === 'right') { this.resultFocus = 0; this.focusResultBtn(); } // 下一局 (top-right)
      else if (name === 'confirm') (this.resultFocus === 0 ? this.nextHand() : this.returnHub());
      else if (name === 'menu') this.nextHand();
      return;
    }
    if (this.dealing || this.animating) return; // serving tiles / a discard fly is playing — hold input
    if (this.isClaimPhase()) {
      // 点炮 win: the 胡 floats centered (not in the bar), so confirm/win takes it and
      // cancel/pass declines — no bar navigation. (Pad has no 'win' key, so A=confirm.)
      if (this.game.currentClaim().type === 'win') {
        if (name === 'confirm' || name === 'win') this.doClaimTake();
        else if (name === 'cancel' || name === 'pass') this.doClaimPass();
        else if (name === 'menu') this.openMenu();
        return;
      }
      const btns = [...$('action-bar').children];
      if (name === 'left') { this.focusIndex = (this.focusIndex - 1 + btns.length) % btns.length; this.render(); }
      else if (name === 'right') { this.focusIndex = (this.focusIndex + 1) % btns.length; this.render(); }
      else if (name === 'confirm') btns[this.focusIndex]?.click();
      else if (name === 'cancel' || name === 'pass') this.doClaimPass();
      else if (name === 'menu') this.openMenu();
      return;
    }
    if (this.lockedTing && this.game.turn === HUMAN && this.game.phase === PHASE.AWAIT_DISCARD && this.game.selfDrawWin) {
      // 听 paused for a winning self-draw: confirm/win takes the centered 胡.
      if (name === 'win' || name === 'confirm') this.doDeclareWin();
      else if (name === 'menu') this.openMenu();
      return;
    }
    if (this.game.turn === HUMAN && this.game.phase === PHASE.AWAIT_DISCARD && !this.lockedTing) {
      const n = this.selectableHandIndices().length;
      if (name === 'win') this.doDeclareWin();
      else if (name === 'left') { this.selIndex = (this.selIndex - 1 + n) % n; sound.select(); this.render(); }
      else if (name === 'right') { this.selIndex = (this.selIndex + 1) % n; sound.select(); this.render(); }
      else if (name === 'confirm') this.discardSelected(false);
      else if (name === 'declare') this.discardSelected(true); // 打出并听牌 (falls back to plain if not 听)
      else if (name === 'kong') { const o = this.game.selfKongOptions(HUMAN)[0]; if (o) this.doSelfKong(o.kind); }
      else if (name === 'menu' || name === 'cancel') this.openMenu();
      return;
    }
    if (name === 'menu') this.openMenu();
  }

  // ---- overlays + boot ----
  fillRules() {
    const base = CFG.baseScore ?? CFG.minFan;  // 底分: standard MCR follows minFan (8); 无定番 has its own
    $('rules-body').innerHTML = `
      <h3>基本</h3>136 张牌（无花）。可<b>吃、碰、杠</b>；和牌可<b>自摸</b>或<b>点炮</b>（食他人打出之牌）。
      <h3>起和</h3>${CFG.minFan > 0 ? `和牌至少 <b>${CFG.minFan} 番</b>（番种总和），不足则不可和。` : '<b>无定番</b>：任意番数（含 0 番）皆可和。'}
      <h3>番种</h3>采用国标 81 番的常见番种子集：清一色24、混一色6、碰碰和6、字一色88、清/混幺九、大小三元、大小四喜、
      四/三/双暗刻、三色三同顺8、花龙8、一色三步高16、平和2、门前清/不求人、五门齐6、箭/风/幺九刻、单钓/边/坎张等。
      <h3>计分</h3>${base > 0
        ? `和牌得 (番 + ${base})；自摸三家各付，点炮则点炮者付 (番+${base})，余两家各付 ${base}。`
        : '和牌只按实际番数结算（无固定底分）；自摸三家各付 番，点炮则仅点炮者付 番。'}
      <h3>操作</h3>点牌选中、再点该牌或按 <b>A</b> 出牌（听牌时可「打出并听牌」）。轮到可<b>胡/碰/杠/吃</b>时点对应按钮，或<b>过</b>。`;
  }
  bindUI() {
    $('level-row').addEventListener('click', (e) => {
      const btn = e.target.closest('.level-btn'); if (!btn) return;
      [...$('level-row').children].forEach((c) => c.classList.remove('sel')); btn.classList.add('sel');
      this.level = parseInt(btn.dataset.level, 10);
    });
    [...$('level-row').children].forEach((c) => c.classList.toggle('sel', parseInt(c.dataset.level, 10) === this.level));
    $('start-btn').addEventListener('click', () => { $('start-overlay').classList.add('hidden'); this.gameStarted = true; sound.resume(); this.startHand(); });
    $('start-hub-link').addEventListener('click', () => this.returnHub()); // difficulty screen → main hub (../../)
    $('rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
    $('menu-rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
    $('rules-close').addEventListener('click', () => $('rules-overlay').classList.add('hidden'));
    $('menu-btn').addEventListener('click', () => this.openMenu());
    const sb = $('sound-btn'); const upd = () => { sb.textContent = sound.muted ? '🔇' : '🔊'; };
    sb.addEventListener('click', () => { sound.resume(); sound.toggleMuted(); upd(); }); upd();
    const fastChk = $('fast-mode-chk');
    if (fastChk) {
      fastChk.checked = this.fastMode;
      fastChk.addEventListener('change', () => { this.fastMode = fastChk.checked; localStorage.setItem(CFG.sessionKey + '-fast', this.fastMode ? '1' : '0'); });
    }
    $('resume-btn').addEventListener('click', () => this.closeOverlays());
    $('newgame-btn').addEventListener('click', () => { this.closeOverlays(); this.newGame(); });
    $('next-hand-btn').addEventListener('click', () => this.nextHand());
    $('back-hub-btn').addEventListener('click', () => this.returnHub());
    $('menu-hub-btn').addEventListener('click', () => this.returnHub());
    const fh = $('final-hub-btn'); if (fh) fh.addEventListener('click', () => this.returnHub());
    $('menu-hub-btn').textContent = ONLINE ? '← 返回大厅' : '← 返回主页';
    // 认输 (forfeit) — online players only; a red two-step confirm.
    $('menu-forfeit-btn').addEventListener('click', () => { $('menu-overlay').classList.add('hidden'); $('forfeit-confirm-overlay').classList.remove('hidden'); });
    $('forfeit-confirm-yes').addEventListener('click', () => this.doForfeit());
    $('forfeit-confirm-no').addEventListener('click', () => $('forfeit-confirm-overlay').classList.add('hidden'));
    if (ONLINE) { const ng = $('newgame-btn'); if (ng) ng.style.display = 'none'; } // server owns the match online
    if (ONLINE && !VIEWER) $('menu-forfeit-btn').hidden = false; // a forfeit only makes sense for a seated online player
    this.fillRules();
  }

  // Leave the game: offline → the main hub; online → back to the 联机 lobby (carry ?server/fast/flat).
  returnHub() {
    if (!ONLINE) { location.replace('../../'); return; }
    const params = new URLSearchParams(location.search);
    for (const k of ['online', 'viewer', 'vseat', 'vtable']) params.delete(k);
    params.set('game', CFG.sessionKey === 'guobiao-free' ? 'guobiao-free' : 'guobiao'); // return to THIS game's split lobby
    const qs = params.toString();
    location.replace('../mahjong-common-online/' + (qs ? '?' + qs : ''));
  }
}

const app = new GuobiaoGame();

forceLandscape((p) => { app.isPortrait = p; if (app.scene) { app.scene.setRotated(p); app.scene.resize(); } });

$('scene').addEventListener('pointerdown', (e) => {
  if (!app.scene || !app.gameStarted || app.dealing || app.animating) return;
  sound.resume();
  if (app.game.turn !== HUMAN || app.game.phase !== PHASE.AWAIT_DISCARD) return;
  const idx = app.scene.pick(e.clientX, e.clientY);
  if (idx != null) app.trackTileGesture(e, idx); // tap = select / second-tap discard; slide up ~2 tiles = play directly
});
// PC only: hovering a hand tile selects it (same as a click-to-select). Mouse-only
// so touch is unaffected; respects the same turn/听/draw-settle guards.
$('scene').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !app.scene || !app.gameStarted || app.dealing || app.animating) return;
  if (app.game.turn !== HUMAN || app.game.phase !== PHASE.AWAIT_DISCARD || app.lockedTing || app.scene.handDrawRevealing) return;
  const idx = app.scene.pick(e.clientX, e.clientY);
  if (idx == null) return;
  const pos = app.selectableHandIndices().indexOf(idx);
  if (pos >= 0 && pos !== app.selIndex) { app.selIndex = pos; sound.select(); app.render(); }
});

bindKeys((name) => app.onAction(name), {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'left', ArrowDown: 'right',
  Enter: 'confirm', ' ': 'confirm', Escape: 'cancel', Backspace: 'pass',
  m: 'menu', M: 'menu', g: 'kong', G: 'kong', k: 'kong', K: 'kong', t: 'declare', T: 'declare', h: 'win', H: 'win',
});
// Xbox: A=confirm B=cancel X=declare(听) Y=kong, d-pad/stick = left/right, Menu = menu.
startGamepad((name) => app.onAction(name), { 14: 'left', 12: 'left', 15: 'right', 13: 'right', 0: 'confirm', 1: 'cancel', 2: 'declare', 3: 'kong', 9: 'menu' });

app.bindUI();

// Online boot: no start overlay / difficulty — the lobby already started the table. Connect and let
// the server drive. (Gated on ONLINE; the offline boot via the start overlay is unchanged.)
if (ONLINE) { $('start-overlay').classList.add('hidden'); app.gameStarted = true; app.connectOnline(); }

if (new URLSearchParams(location.search).get('fast')) {
  window.__gb = {
    phase: () => app.game && app.game.phase,
    game: () => app.game,
    scene: () => app.scene,
    selInfo: () => ({ selIndex: app.selIndex, drawn: app.game && app.game.drawnTile, selKind: app.renderedHand()[app.selectableHandIndices()[app.selIndex]], revealing: !!(app.scene && app.scene.handDrawRevealing) }),
    claim: () => app.game && app.game.currentClaim(),
    humanTurn: () => !!app.game && app.game.turn === HUMAN && app.game.phase === PHASE.AWAIT_DISCARD,
    discard: () => app.discardSelected(false),
    locked: () => app.lockedTing,
    music: () => !!(sound._musicWanted || sound._musicOn),
    hint: () => $('hand-hint').textContent,
    actions: () => [...$('action-bar').children, ...$('ting-center').children].map((b) => ({ text: b.textContent, cls: b.className })),
    // Force a deterministic state where the human holds `hand13` (tenpai) plus a
    // freshly drawn `drawn` tile, so discarding `drawn` leaves a ready hand.
    forceTing: (hand13, drawn) => {
      app.lockedTing = false; app.tingWaits = []; app._tingSig = '';
      app.game.hands[HUMAN] = hand13.concat(drawn);
      app.game.drawnTile = drawn; app.selIndex = 0; app.render();
      if (app.scene) app.scene.handDrawRevealing = false; // instant test setup — don't gate input
    },
    setLocked: (waits) => { app.lockedTing = true; app.tingWaits = waits; app.render(); },
    selectKind: (kind) => {
      const idxs = app.selectableHandIndices();
      for (let i = 0; i < idxs.length; i++) if (app.renderedHand()[idxs[i]] === kind) { app.selIndex = i; app.render(); return true; }
      return false;
    },
    clickAction: (text) => { const b = [...$('action-bar').children, ...$('ting-center').children].find((x) => x.textContent === text); if (b) { b.click(); return true; } return false; },
    debugChow: () => {
      app.game.phase = PHASE.AWAIT_CLAIM;
      app.game.lastDiscard = { player: 3, kind: 3 }; // 上家 discards 4万 (id 3)
      app.game.currentClaim = () => ({ player: HUMAN, type: 'chow', options: [[1, 2], [2, 4], [4, 5]] });
      app.render();
    },
    // self-draw win available → the big centered 胡 should appear (visual check).
    debugWin: () => {
      app.game.phase = PHASE.AWAIT_DISCARD; app.game.turn = HUMAN;
      app.game.selfDrawWin = { fan: 24, fans: [{ name: '清一色', points: 24 }] };
      app.render();
    },
    // 点炮 win claim → the centered 胡 (take) with 过 in the bar (visual check).
    debugWinClaim: () => {
      app.game.phase = PHASE.AWAIT_CLAIM;
      app.game.lastDiscard = { player: 3, kind: 5 };
      app.game.currentClaim = () => ({ player: HUMAN, type: 'win', result: { fan: 16, fans: [{ name: '混一色', points: 16 }] } });
      app.render();
    },
    debugResult: () => {
      app.game.phase = PHASE.OVER;
      app.game.result = { type: 'win', winner: HUMAN, fan: 24, byDiscard: false, winningTile: app.game.hands[HUMAN][0],
        fans: [{ name: '清一色', points: 24 }, { name: '碰碰和', points: 6 }], payments: [72, -24, -24, -24] };
      app.showResult();
    },
  };
}
