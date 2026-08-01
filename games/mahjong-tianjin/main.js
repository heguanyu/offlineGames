// Tianjin mahjong — UI glue: drives the 3D scene (scene.js), the HTML HUD, input
// (touch raycast / keyboard / Xbox controller) and the turn orchestration that
// paces the AI so the human can follow along. A subtype of the shared MahjongGame
// controller (mahjong-common/game-base.js): the turn-timer/scoreboard/reconnect/menu
// plumbing lives in the base; this file adds 天津's rules-specific UI (混儿 wilds,
// 拉庄, 起和 2番 scoring, 历史战绩).
import { PHASE, tileName } from './engine.js';
import { createBackend } from './backend.js';
import { MahjongScene } from '../mahjong-common/scene.js';
import { MahjongScene2D } from '../mahjong-common/scene2d.js';
import { useFlatRenderer, applyFlatScale, mountPowerControl } from '../../shared/power-mode.js';
import { Sound } from '../mahjong-common/sound.js';
import { buildOrder } from '../mahjong-common/handorder.js';
import { $, faceTileEl, mkBtn, makeToast, bindKeys, startGamepad, forceLandscape, renderSeatHands, seatBadgeHtml } from '../mahjong-common/ui-util.js';
import { BOT_NAMES } from '../mahjong-common/bot-names.js';
import { serverUrl } from '../mahjong-common-online/server-url.js';
import { clientUidSync } from '../../shared/client-id.js';
import { homeHref } from '../../shared/hub-home.js';
import { MahjongGame, HUMAN, WIND, SEAT_LABEL } from '../mahjong-common/game-base.js';

const sound = new Sound();
const toast = makeToast();

const REL_LABEL = ['自己', '下家', '对家', '上家']; // online nameplate: HUMAN reads 自己, not 玩家
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const backTileEl = () => { const d = document.createElement('div'); d.className = 'tile back'; return d; }; // a face-down tile

// Pace between AI moves so the human can follow; `?fast=1` speeds it up for the
// automated e2e test.
const FAST = !!new URLSearchParams(location.search).get('fast');
const AI_DELAY = FAST ? 35 : 600;

// Phones get a flat 2D (DOM) board instead of the WebGL table — smaller screen,
// lower battery. The deciding signal is screen real estate (the short side in CSS
// px: iPhones ≈320–440, iPads ≥744), with the iPhone UA as a confirming hint.
// `?flat=1` / `?d3=1` force a renderer for testing on any device.
const FLAT = (() => {
  const q = new URLSearchParams(location.search);
  if (q.get('flat')) return true;
  if (q.get('d3')) return false;
  return useFlatRenderer(); // 省电模式: 省电→2D, 流畅/均衡→3D, unset→phones 2D (shared/power-mode.js)
})();
if (FLAT) {
  document.body.classList.add('flat');
  // The 混儿 indicator + the scoreboard float over the 3D table; in the flat layout they
  // belong in the left nav rail. main.js fills them by id, so moving the nodes changes
  // nothing else. The scoreboard (+ 每圈成绩 button) sits just under 局况 at the rail top.
  const wh = document.getElementById('wild-hud'), hdr = document.querySelector('header');
  if (wh && hdr) hdr.appendChild(wh);
  const ss = document.getElementById('score-stack'), ri = document.getElementById('round-info');
  if (ss && hdr) hdr.insertBefore(ss, ri ? ri.nextSibling : hdr.firstChild);
  applyFlatScale(document.getElementById('table')); // 省电 (2D) on a tablet: scale the flat board to fill the screen
}
const Renderer = FLAT ? MahjongScene2D : MahjongScene;
// A bot's 碰/杠 is shown lifted for CLAIM_DEMO_MS; the game logic is held until the
// meld has settled (+ CLAIM_SETTLE_MS). Both collapse to ~0 under ?fast=1 for tests.
const CLAIM_DEMO_MS = FAST ? 60 : 2000;
const CLAIM_SETTLE_MS = FAST ? 20 : 380;
// A bot's discard flies from its hand to the center halt, holds ~1s, then drops into
// the pool; the tick is locked for the whole duration. 快速模式 (fastMode) or ?fast=1
// turns the animation + lock off.
const DISCARD_DEMO_MS = 500;  // 0.2s rise + 0.3s halt at the center
const DISCARD_SETTLE_MS = 140; // covers the ~0.1s fall into the pool

// Online mode: ?online=1 means this page is driven by the remote server (the lobby navigates
// here once a table starts). EVERYTHING online is gated on ONLINE; with it unset the page is
// the offline single-player game, byte-for-byte unchanged.
const ONLINE = !!new URLSearchParams(location.search).get('online');
// Viewer mode (online only): ?viewer=1&vseat=N → watch human seat N read-only. The server sends us
// that seat's frames (so the UI renders exactly as that player sees it) and ignores any action.
const VIEWER = ONLINE && !!new URLSearchParams(location.search).get('viewer');
const VIEWER_SEAT = VIEWER ? (parseInt(new URLSearchParams(location.search).get('vseat'), 10) || 0) : 0;
const ONLINE_URL = serverUrl(); // the game server endpoint — see mahjong-common-online/server-url.js

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-fan scoring gain shown on each result chip. Additive fans add 分 into the base (joined with
// ·, e.g. 龙·4分); multiplier fans multiply it (shown ` xN`, e.g. 素 x2, matching the 庄x2 tags).
// When no additive fan is present the base is 1 (提溜/小和), shown as a 小和·1分 chip so the math
// reads. Mirrors the FAN table + scoreFromDecomp() in engine.js — keep in sync if those change.
const FAN_ADD = { '捉五': 3, '龙': 4, '本混龙': 8, '天和': 4, '地和': 4 };
const FAN_MULT = { '素': 2, '混吊': 2, '双混吊': 2, '杠开': 2 };

class TianjinGame extends MahjongGame {
  constructor() {
    super();
    this.session = this.loadSession();   // { scores, dealer, prevailingWind, hand }
    this.noSel = VIEWER;          // nothing lifted (set right after you discard; any pick/hover/turn clears it). A
                                  // viewer starts with NOTHING lifted — the selection is local UI, not the watched
                                  // player's, so showing a default highlight would be misleading (they can still pick).
    this.lzBlind = false;          // blind 拉庄: my hand is dealt but shown face-down until I answer
    this.lzActive = false;         // a 拉庄 modal is up (for me or others) → the 混儿 stays hidden ('new hand' hasn't begun)
    this.drawnWildSelected = false; // a freshly-drawn 混儿 is the lifted tile (can't discard)
    this.fastMode = localStorage.getItem('mahjong-fast') !== '0'; // checked (on) by default
    this.lzCallback = null; this.lzFocus = 1; // panel: 0 = 拉庄, 1 = 不拉 (default, no accidental double)
    this.lzTestChoice = false;           // FAST/e2e override for the human's answer (no panel in tests)
    this.histClearArm = false; // 清空历史 needs two clicks to confirm
  }

  // ---------------------------------------------------------------------------
  // Persistence (lightweight prefs + running score; localStorage is fine here)
  // ---------------------------------------------------------------------------
  loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem('mahjong-session'));
      if (s && Array.isArray(s.scores)) {
        if (!Array.isArray(s.rounds)) s.rounds = [];
        if (s.seatBase == null) s.seatBase = 0; // 座风 base (东 seat) for the 锅
        // A finished 锅 (four 圈 recorded) left unreset — e.g. closed from the 最终成绩
        // board via 返回大厅 — starts the next 锅 fresh rather than resuming the old one.
        if (s.rounds.length >= 4) return this.freshSession();
        return s;
      }
    } catch {}
    return this.freshSession();
  }
  // A blank session: zeroed scores, 庄 at seat 0, 东圈, no 圈 recorded yet. seatBase fixes
  // the 座风 (seat 0 = 东) for the whole 锅; `rounds` accumulates one snapshot per completed
  // 圈 (东南西北 = a 锅) for 每圈成绩 + 最终成绩.
  freshSession() { return { scores: [0, 0, 0, 0], dealer: 0, prevailingWind: 0, hand: 1, rounds: [], seatBase: 0 }; }
  saveSession() {
    this.session.scores = this.game ? this.game.scores.slice() : this.session.scores;
    localStorage.setItem('mahjong-session', JSON.stringify(this.session));
  }

  // Persistent 锅 history — one record { at, scores } per FINISHED 锅. Kept under its own
  // key so resetting the live session (重开 / 再来一锅 / reload) never clears it; only the
  // explicit 清空历史 does. Read/append lazily so it survives even a freshSession().
  loadHistory() {
    try { const h = JSON.parse(localStorage.getItem('mahjong-history')); if (Array.isArray(h)) return h; } catch {}
    return [];
  }
  recordMatchHistory() {
    const hist = this.loadHistory();
    hist.push({ at: Date.now(), scores: this.game.scores.slice() });
    while (hist.length > 50) hist.shift(); // cap growth; keep the most recent 50 锅
    localStorage.setItem('mahjong-history', JSON.stringify(hist));
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  selectableHandIndices() {
    // Indices into the rendered hand that are NOT wild (wilds can't be discarded).
    return this.renderedHand().map((id, i) => (this.game.isWild(id) ? -1 : i)).filter((i) => i >= 0);
  }

  // The human's display order: 混儿 on the left, the rest sorted ascending. The
  // freshly drawn tile sorts into place; scene.js flanks it with a small margin.
  renderedHand() { return buildOrder(this.game.hands[HUMAN], (id) => this.game.isWild(id)); }

  // The HTML HUD around the canvas (header / scores / 混儿 / nameplates). Split out
  // so the deal animation can show it without touching the 3D table.
  renderHud() {
    // ---- header ----
    // 圈 (prevailing wind) · 庄 (the 庄's fixed 座风 — only the 庄 moves within the 锅) · 难度
    const watching = VIEWER && this.game.seatNames ? `<span class="viewing">👁 观战 ${esc(this.game.seatNames[HUMAN] || '')}</span> · ` : '';
    $('round-info').innerHTML = watching +
      `<span class="ri-round"><b>${WIND[this.game.prevailingWind]}圈</b> · <b>${WIND[this.game.seatWind(this.game.dealer)]}庄</b></span>` +
      (ONLINE ? '<span class="ri-level">联机</span>' : '');
    this.renderScores();

    // ---- the round's two 混儿 (e.g. 7万 + 8万), shown with their real faces ----
    // During 拉庄 the 混儿 isn't decided yet (the hand hasn't "started") → show two face-down backs.
    const wc = $('wild-indicator');
    wc.innerHTML = '';
    if (this.lzBlind || this.lzActive) { wc.appendChild(backTileEl()); wc.appendChild(backTileEl()); }
    else for (const w of this.game.wilds) wc.appendChild(faceTileEl(w, { wild: true }));
    $('wall-count').textContent = `余 ${this.game.wall.length} 张`;

    // ---- nameplates ----
    for (let p = 0; p < 4; p++) this.renderPlate(p);
  }

  // 天津's scoreboard adds the ⚔️ 拉庄 marker; the rest of the cross is the base's renderScores.
  laZhuangBadge(p) { return this.game.isLaZhuang(p) ? '⚔️' : ''; }

  render() {
    this.renderHud();

    // ---- 3D table ----
    const selectable = this.selectableHandIndices();
    if (this.selIndex >= selectable.length) this.selIndex = Math.max(0, selectable.length - 1);
    const myTurn = this.game.turn === HUMAN && this.game.phase === PHASE.AWAIT_DISCARD;
    const revealing = this.scene && this.scene.handDrawRevealing; // drawn tile still flying in → no selection yet
    // A freshly-drawn 混儿 is still shown drawn (gap + reveal) and CAN be the lifted/
    // highlighted tile even though it can't be discarded; picking any normal tile drops
    // that selection back onto the non-wild cursor.
    const rh = this.renderedHand();
    const drawnWildIdx = (this.game.drawnTile != null && this.game.isWild(this.game.drawnTile)) ? rh.lastIndexOf(this.game.drawnTile) : -1;
    const selRendered = (this.drawnWildSelected && drawnWildIdx >= 0) ? drawnWildIdx : selectable[this.selIndex];
    // While a bot's discard fly is playing, hold the human's turn: the turn has already
    // advanced (the human drew), but we don't reveal that draw or allow selection yet —
    // show the pre-draw 13 tiles, and let the reveal play when the tick resumes.
    const mt = myTurn && !this.animating;
    // You can browse/lift your hand even while waiting for another player (you just can't discard yet),
    // so the table never feels frozen — both online and offline.
    const canLift = !this.animating && !revealing && this.game.phase !== PHASE.OVER && !this.isClaimPhase();
    let handForSync = rh;
    // Only when it's actually the HUMAN's turn has the human drawn — drop that one drawn
    // tile so its reveal is held until the bot's discard fly ends. (game.drawnTile is a
    // KIND, so without the myTurn guard a bot drawing a kind the human holds would wrongly
    // trim one of the human's tiles, flickering the hand.)
    if (this.animating && myTurn && this.game.drawnTile != null) {
      const di = rh.lastIndexOf(this.game.drawnTile);
      if (di >= 0) handForSync = rh.slice(0, di).concat(rh.slice(di + 1));
    }
    if (this.scene) this.scene.sync(this.game, {
      renderedHand: handForSync,
      myTurn: mt,
      selRendered: canLift && !revealing && !this.noSel && !this.lzBlind ? selRendered : null,
      claimable: !this.animating && this.isClaimPhase(),
      drawnTile: (mt && this.game.drawnTile != null) ? this.game.drawnTile : null,
      reveal: this.game.phase === PHASE.OVER,
      ownBacks: this.lzBlind, // hand dealt but face-down during a blind 拉庄 you haven't answered
      hideWilds: this.lzBlind || this.lzActive, // 混儿 undecided during 拉庄 → don't mark wild tiles (e.g. the 庄's revealed hand)
    });

    // ---- action bar / hint + toasts ----
    this.renderActions();
    this.positionClaimUI();
    this.flushLogToasts();
  }

  renderPlate(p) {
    const seat = $('plate-' + p);
    const thinking = this.game.phase !== PHASE.OVER && this.game.turn === p && p !== HUMAN;
    const isDealer = p === this.game.dealer;
    const active = this.game.turn === p && this.game.phase !== PHASE.OVER;
    // Online: 东/南/西/北 · 名字 · 自己/下家/对家/上家. Offline: the human reads 玩家; each bot reads its
    // seat name (东方雨…) over its relation label, matching the online layout.
    let label;
    if (ONLINE && this.game.seatNames) {
      const name = this.game.seatNames[p] || (p === HUMAN ? '' : BOT_NAMES[p]);
      label = (name ? `<span class="pname">${esc(name)}</span>` : '') + `<span class="prel">${REL_LABEL[p]}</span>`;
    } else if (p === HUMAN) {
      label = `<span>${SEAT_LABEL[p]}</span>`;
    } else {
      label = `<span class="pname">${BOT_NAMES[p]}</span><span class="prel">${SEAT_LABEL[p]}</span>`;
    }
    seat.innerHTML =
      seatBadgeHtml(this.game, p) + // 👑 (庄) / ⚔️ (拉庄), above the nameplate
      `<div class="nameplate${active ? ' active' : ''}${isDealer ? ' dealer' : ''}">` +
      `<span class="wind">${WIND[this.game.seatWind(p)]}</span>` +
      label +
      (thinking ? '<span class="think">思考中…</span>' : '') +
      `</div>`;
  }

  renderActions() {
    const bar = $('action-bar');
    bar.innerHTML = '';
    const center = $('ting-center'); center.innerHTML = ''; // the 和牌(胡) button floats here
    const hint = $('hand-hint');
    hint.textContent = '';
    if (this.animating) return; // a bot's discard fly is playing — show no action UI yet
    const buttons = [];

    if (this.game.phase === PHASE.AWAIT_CLAIM && this.game.claim && this.game.claim.player === HUMAN) {
      const c = this.game.claim;
      if (c.options.includes('pung')) buttons.push(mkBtn('碰', () => this.doClaim('pung')));
      if (c.options.includes('kong')) buttons.push(mkBtn('杠', () => this.doClaim('kong')));
      buttons.push(mkBtn('过', () => this.doPass(), true));
      hint.textContent = `${SEAT_LABEL[c.player === HUMAN ? this.game.lastDiscard.player : c.player]} 打出 ${tileName(c.kind)}`;
    } else if (this.game.phase === PHASE.AWAIT_DISCARD && this.game.turn === HUMAN) {
      // self-draw win available → offer 胡 (but you may still play on). Big + centered.
      if (this.game.selfDrawWin) {
        const w = this.game.selfDrawWin;
        center.appendChild(mkBtn(`胡 · ${w.fans[0]} · ${w.score}分`, () => this.doDeclareWin(), false, 'hu'));
      }
      // self-kong options (金杠 = a concealed kong of four 混儿)
      for (const k of this.game.selfKongOptions(HUMAN)) {
        buttons.push(mkBtn(`${k.type === 'gold' ? '金杠' : '杠'} ${tileName(k.kind)}`, () => this.doSelfKong(k.kind), true));
      }
    }

    if (this.focusIndex >= buttons.length) this.focusIndex = buttons.length - 1;
    buttons.forEach((b, i) => { if (i === this.focusIndex && this.isClaimPhase()) b.classList.add('focus'); bar.appendChild(b); });
  }

  isClaimPhase() { return this.game.phase === PHASE.AWAIT_CLAIM && this.game.claim && this.game.claim.player === HUMAN; }

  // ---------------------------------------------------------------------------
  // Toasts for 碰 / 杠 / 自摸 / 荒
  // ---------------------------------------------------------------------------
  // Which 杠: 金杠 (a kong of 混儿), 暗杠 (concealed), else 明杠 — read off the seat's latest kong meld.
  kongSlug(seat) {
    const km = (this.game.melds[seat] || []).filter((m) => m.type === 'kong').pop();
    if (!km) return 'mingkong';
    if (this.game.isWild && this.game.isWild(km.kind)) return 'jinkong';
    return km.concealed ? 'ankong' : 'mingkong';
  }
  flushLogToasts() {
    if (!this.game || !this.game.log) return; // online views carry no engine log (toasts ride events instead)
    for (let i = this.lastLogLen; i < this.game.log.length; i++) {
      const line = this.game.log[i];
      // the claim log line starts with the seat's WIND (东/南/西/北) — map it back to the
      // seat index so the call is spoken in that seat's voice.
      const tok = line.split(' ')[0];
      let seat = 0; for (let p = 0; p < 4; p++) if (WIND[this.game.seatWind(p)] === tok) { seat = p; break; }
      const w = this.game.seatWind(seat);   // voice persona = the seat's wind (0..3 东南西北)
      if (/自摸/.test(line)) { toast(line, true); (this.game.result && this.game.result.winner === HUMAN ? sound.win() : sound.lose()); sound.call('hula', w); }
      else if (/荒牌/.test(line)) { toast(line, true); sound.drawGame(); }
      else if (/杠/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.kong(); sound.call(this.kongSlug(seat), w); }
      else if (/碰/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.pung(); sound.call('pung', w); }
    }
    this.lastLogLen = this.game.log.length;
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------
  // The backend pushes one event per move; this async handler is the whole UI-side
  // orchestration that used to be the synchronous tick() loop. Each case renders + plays
  // the matching animation/sound and AWAITS it, so the backend (local sim or remote server)
  // is held until the table catches up before sending the next event. The 碰/杠/自摸/荒 toasts
  // + voices ride the engine log and flush inside render(), so most cases just call render().
  async onBackendEvent(ev) {
    if (ev.type === 'disconnected') { this.showReconnecting(); return; } // lost the server → reconnect banner (then bail to the lobby)
    if (ev.type === 'gameGone') { this.returnHub(); return; }            // server has no game for us (e.g. it restarted) → lobby
    if (ONLINE) this.hideReconnecting();                                 // any real frame means we're connected again
    const st = this.backend.getState();
    if (st) this.game = st;
    if (ev.type !== 'deal' && ev.type !== 'lazhuang') this.lzBlind = false; // play resumed → reveal my hand
    if (ev.type !== 'lazhuang') this.hideLaZhuangPanel();                   // any other frame means 拉庄 is over
    if (ONLINE) this.syncTurnTimer(ev); // show the ring whenever a player is on the clock (no-op offline)
    switch (ev.type) {
      case 'lazhuang': // blind 拉庄 over the freshly-dealt (still hidden) hand
        $('result-overlay').classList.add('hidden'); // a new hand is starting → drop any lingering result panel
        this.lzBlind = ev.need.includes(HUMAN); // still my turn to choose → keep my hand face-down
        if (FAST) { if (ev.need.includes(HUMAN)) this.backend.decideLaZhuang(this.lzTestChoice); this.render(); return; } // tests skip the panel
        this.showLaZhuangPanel(ev.dealer, ev.need, ev.answers, (yes) => this.backend.decideLaZhuang(yes));
        this.render();
        return;

      case 'deal':
        $('result-overlay').classList.add('hidden'); // the next hand is dealing → auto-hide the result panel
        this.selIndex = 0; this.focusIndex = 0; this.drawnWildSelected = false; this.noSel = VIEWER; this.lastLogLen = 0; // viewer: no default lift
        this.lzBlind = this.game.dealer !== HUMAN; // a non-dealer is about to be asked 拉庄 (blind) → keep the hand face-down
        if (!ONLINE) this.saveSession(); // online: the server is the source of truth, nothing to persist
        if (this.scene && !FAST && this.lzBlind) { if (this.scene._clearKongBounds) this.scene._clearKongBounds(); } // blind: no flourish, render shows backs
        else if (this.scene && !FAST) { // serve the tiles from the wall, then play
          this.dealing = true;
          this.renderHud();
          $('action-bar').innerHTML = ''; $('ting-center').innerHTML = '';
          $('hand-hint').textContent = '发牌中…';
          await new Promise((res) => this.scene.beginDeal(this.game, res, () => sound.select()));
          this.dealing = false;
        }
        this.render();
        if (ONLINE && this.backend.dealDone) this.backend.dealDone(); // table's dealt → let the server start the opponents (paced, not bunched)
        return;

      case 'discard': {
        const human = ev.player === HUMAN;
        sound.discard();
        if (human) this.selIndex = Math.min(this.selIndex, this.selectableHandIndices().length - 1);
        else if (!this.fastMode) sound.sayTile(ev.tile, this.game.seatWind(ev.player)); // bot speaks its discard
        if (this.scene && !FAST && !this.fastMode) { // fly to the center halt, hold, drop into the pool
          if (human) sound.sayTile(ev.tile, this.game.seatWind(HUMAN));
          this.animating = true;
          try {
            this.scene.beginDiscardDemo(ev.player, ev.discardIndex, DISCARD_DEMO_MS);
            this.render(); // place the flying tile; claim UI + the human's drawn tile stay held
            await delay(DISCARD_DEMO_MS + DISCARD_SETTLE_MS);
          } finally { this.animating = false; } // never leave the action bar wedged if a frame mid-animation throws
        }
        this.render();
        return;
      }

      case 'claim':
        if (ev.player === HUMAN) { this.selIndex = 0; this.drawnWildSelected = false; this.noSel = VIEWER; } // then they discard (viewer: no default lift)
        else if (this.scene) { // show the bot's 碰/杠 lifted, hold until it settles
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
        if (ev.who === 'claim') this.focusIndex = 0; else this.ensureSelection();
        this.render();
        return;

      case 'over':
        this.render();      // flush the 自摸 / 荒牌 toast + win/lose sound from the log
        this.onlineEndsMatch = ONLINE && !!ev.matchEnd; // set BEFORE showResult so it picks the right button label
        this.showResult();
        // resync after a refresh: reflect a choice we'd already made
        if (ev.readied) {
          const b = $('next-hand-btn');
          if (this.onlineEndsMatch) { b.disabled = true; b.textContent = '结算中…'; }        // already chose to finish the 锅
          else { this.onlineReadied = true; b.textContent = '✓ 已准备 · 取消'; b.classList.add('readied'); } // already readied
        }
        return;

      // ---- online only ----
      case 'sync': // (re)joined a game in progress, or reconnected — render the current state
        this.lastLogLen = this.game.log ? this.game.log.length : 0; // online views carry no log; suppress toasts
        this.ensureSelection();
        this.render();
        return;

      case 'matchOver': // the server finished the 锅 → final standings (server-authoritative)
        $('result-overlay').classList.add('hidden');
        this.showFinalBoard({ scores: ev.scores, rounds: ev.rounds });
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Human actions
  // ---------------------------------------------------------------------------
  // Tapping a tile only SELECTS it (lifts + highlights); discarding is a separate
  // confirm (打出 button / A / Enter). Tapping the already-selected tile confirms.
  onPickTile(renderedIdx) {
    if (!this.game || this.dealing || this.animating) return;
    if (this.scene && this.scene.handDrawRevealing) return; // wait until the drawn tile settles
    if (this.game.phase === PHASE.OVER || this.isClaimPhase()) return; // not while the result / a claim prompt is up
    const mine = !VIEWER && this.game.turn === HUMAN && this.game.phase === PHASE.AWAIT_DISCARD; // browse off-turn; discard only on yours (never as a viewer)
    const id = this.renderedHand()[renderedIdx];
    if (id == null) return;
    if (this.game.isWild(id)) { toast('混儿不能打出'); return; } // 混儿 (incl. the drawn one): complain, no action
    const wasWildSel = this.drawnWildSelected;
    this.drawnWildSelected = false;                  // picking a normal tile drops the drawn-混儿 selection
    const pos = this.selectableHandIndices().indexOf(renderedIdx);
    if (pos < 0) return;
    if (pos === this.selIndex && !wasWildSel && !this.noSel && mine) this.discardSelected(); // second tap confirms — only on your turn, and only if something was already lifted
    else { this.noSel = false; this.selIndex = pos; sound.select(); this.render(); }         // otherwise just select (also while waiting online)
  }

  discardSelected() {
    if (!this.game || this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD) return;
    if (this.scene && this.scene.handDrawRevealing) return; // wait until the drawn tile settles
    if (this.drawnWildSelected) { toast('混儿不能打出'); return; } // the lifted tile is the drawn 混儿
    const hand = this.renderedHand();
    const sel = this.selectableHandIndices();
    const id = hand[sel[this.selIndex]];
    if (id == null || this.game.isWild(id)) return;
    this.noSel = true;        // drop the lifted-tile highlight the instant you discard (you can re-select off-turn)
    this.backend.discard(id); // the 'discard' event animates it, then the backend drives the bots
  }

  // Can the tile under the finger be discarded now? Only on your turn, never a 混儿
  // (or as a viewer), and not mid drawn-tile reveal. Gates the slide-up drag.
  canPlayTileAt(renderedIdx) {
    if (VIEWER) return false;
    if (!this.game || this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD) return false;
    if (this.scene && this.scene.handDrawRevealing) return false; // wait until the drawn tile settles
    const id = this.renderedHand()[renderedIdx];
    if (id == null || this.game.isWild(id)) return false; // 混儿 can't be discarded
    return this.selectableHandIndices().indexOf(renderedIdx) >= 0;
  }
  // Slide-up-to-play: discard the exact tile under the finger, skipping the tap-to-select step.
  playTileAt(renderedIdx) {
    if (!this.canPlayTileAt(renderedIdx)) return false;
    const id = this.renderedHand()[renderedIdx];
    this.selIndex = this.selectableHandIndices().indexOf(renderedIdx);
    this.drawnWildSelected = false; this.noSel = true;
    this.backend.discard(id);
    return true;
  }
  // A slide takes over the selection: lift this tile, deselect any other. No discard.
  selectTileAt(renderedIdx) {
    const pos = this.selectableHandIndices().indexOf(renderedIdx);
    if (pos < 0) return;
    this.selIndex = pos; this.drawnWildSelected = false; this.noSel = false;
    this.render();
  }

  doDeclareWin() {
    if (this.scene && this.scene.handDrawRevealing) return; // wait until the drawn tile settles
    this.backend.declareWin();
  }
  // When the freshly-drawn tile finishes its reveal, auto-select it (ready to discard).
  // A drawn 混儿 is selected too (lifted/highlighted) but isn't discardable — it stays
  // flagged so confirm/tap on it just complains; picking any normal tile clears it.
  selectDrawnTile() {
    if (VIEWER) return; // a viewer's hand isn't theirs to play — don't auto-lift the drawn tile (manual pick still works)
    if (this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD || this.game.drawnTile == null) return;
    this.noSel = false; // a fresh draw on your turn re-lifts a tile
    if (this.game.isWild(this.game.drawnTile)) {
      this.drawnWildSelected = true;
    } else {
      this.drawnWildSelected = false;
      const si = this.selectableHandIndices().indexOf(this.renderedHand().lastIndexOf(this.game.drawnTile));
      if (si >= 0) this.selIndex = si;
    }
    this.render();
  }
  doSelfKong(kind) {
    if (this.scene && this.scene.handDrawRevealing) return; // wait until the drawn tile settles
    if (this.game.turn !== HUMAN || this.game.phase !== PHASE.AWAIT_DISCARD) return;
    this.backend.selfKong(kind);
  }
  doClaim(type) {
    if (!this.isClaimPhase()) return;
    if (!this.game.claim.options.includes(type)) return;
    // After 碰/杠 the human must discard; the 'claim'/'await' events reset the selection.
    this.backend.claim(type);
  }
  doPass() {
    if (!this.isClaimPhase()) return;
    this.backend.pass();
  }

  // ---------------------------------------------------------------------------
  // Result / new hand
  // ---------------------------------------------------------------------------

  // Render the winning hand grouped by meld + pair from the decomposition. Each
  // 混儿 is placed in its slot but shown with its ORIGINAL wildcard face (the round's
  // 混 tile the player actually held), marked 混 — not the tile it stands for.
  renderWinningHand(handEl, w, r) {
    // The actual 混 tiles the winner held (incl. a wild winning tile), in order.
    const heldWilds = this.game.hands[w].filter((id) => this.game.isWild(id)).sort((a, b) => a - b);
    let wp = 0;
    const wildFace = () => (heldWilds.length ? heldWilds[wp++ % heldWilds.length] : this.game.wilds[0]);
    const meldTilesOf = (g) => {
      if (g.type === 'pung') { const k = g.kinds[0], nat = 3 - g.jokers; return [0, 1, 2].map((i) => ({ kind: k, wild: i >= nat })); }
      return g.kinds.map((id) => ({ kind: id, wild: !g.natural.has(id) })); // chow
    };
    const pairTilesOf = (g) => {
      if (g.kinds.length) { const k = g.kinds[0], nat = 2 - g.jokers; return [0, 1].map((i) => ({ kind: k, wild: i >= nat })); }
      return [{ kind: this.game.wilds[0], wild: true }, { kind: this.game.wilds[0], wild: true }];
    };
    // Highlight the winning (drawn) tile in the exact group the engine says it completed
    // (winGroupIdx, from the scored decomposition) — so a 混吊 glows the 混 in the 将, not an
    // identical 混 used elsewhere, and a natural win glows the 6筒 in its own group, not a
    // copy. Within that group: the 混 slot if the drawn tile was wild, else the natural slot
    // matching its kind. 'called' groups never hold it; mark exactly one tile.
    const winKind = r.winningTile;
    const winIsWild = winKind != null && this.game.isWild(winKind);
    const winGrp = (r.decomp && r.meta && r.meta.winGroupIdx >= 0) ? r.decomp[r.meta.winGroupIdx] : null;
    let winMarked = false;
    const isWinTile = (t, srcGroup) => {
      if (winKind == null) return false;
      if (winGrp ? srcGroup !== winGrp : false) return false; // only the completed group
      return winIsWild ? t.wild : (!t.wild && t.kind === winKind);
    };
    const addGroup = (tiles, extra, parent = handEl, srcGroup = null) => {
      const wrap = document.createElement('div');
      wrap.className = 'meld-group' + (extra || '');
      // wild slots show the original 混 face; natural slots show their own tile.
      for (const t of tiles) {
        const el = faceTileEl(t.wild ? wildFace() : t.kind, { lg: true, wild: t.wild });
        if (!winMarked && srcGroup !== 'called' && isWinTile(t, srcGroup)) { el.classList.add('win-tile'); winMarked = true; }
        wrap.appendChild(el);
      }
      parent.appendChild(wrap);
    };
    if (!r.decomp) { // fallback: plain sorted hand
      addGroup(this.game.hands[w].slice().sort((a, b) => a - b).map((id) => ({ kind: id, wild: this.game.isWild(id) })), '', handEl, 'hand');
      for (const m of this.game.melds[w]) addGroup(m.tiles.map((k) => ({ kind: k, wild: false })), '', handEl, 'called');
      return;
    }
    for (const m of this.game.melds[w]) addGroup(m.tiles.map((k) => ({ kind: k, wild: false })), '', handEl, 'called');
    // 龙 — the three same-suit chows render as ONE continuous 1-9 run of flat tiles
    // (not per-chow groups) so CSS can wrap it tight as 5+4 over two rows. Every other
    // meld is its own grid cell (2 per row); the 将 spans the bottom.
    const longBase = (r.meta && r.meta.long) ? { m: 0, p: 9, s: 18 }[r.meta.longSuit] : null;
    const inLong = (g) => longBase != null && g.type === 'chow' && [longBase, longBase + 3, longBase + 6].includes(g.kinds[0]);
    let pair = null, pairG = null, longTiles = null;
    for (const g of r.decomp) {
      if (g.type === 'pair') { pair = pairTilesOf(g); pairG = g; continue; }
      if (inLong(g)) { (longTiles ||= []).push(...meldTilesOf(g).map((t) => ({ ...t, g }))); }
      else addGroup(meldTilesOf(g), '', handEl, g);
    }
    if (longTiles) {
      longTiles.sort((a, b) => a.kind - b.kind);
      const lr = document.createElement('div'); lr.className = 'long-run'; handEl.appendChild(lr);
      for (const t of longTiles) {
        const el = faceTileEl(t.wild ? wildFace() : t.kind, { lg: true, wild: t.wild });
        if (!winMarked && isWinTile(t, t.g)) { el.classList.add('win-tile'); winMarked = true; }
        lr.appendChild(el);
      }
    }
    if (pair) addGroup(pair, ' pair', handEl, pairG);
  }

  showResult() {
    const r = this.game.result;
    const ov = $('result-overlay');
    const fansEl = $('result-fans');
    const scoreEl = $('result-score');
    const handEl = $('result-hand');
    const payEl = $('result-payments');
    fansEl.innerHTML = ''; handEl.innerHTML = '';

    const winEl = $('result-winning');
    winEl.innerHTML = '';
    winEl.classList.remove('show');
    if (r.type === 'draw') {
      $('result-title').textContent = '荒牌 · 流局';
      scoreEl.textContent = '';
      // a draw still settles 杠分, so show payments if any kong scored
      const hasPay = r.payments && r.payments.some((a) => a !== 0);
      payEl.innerHTML = hasPay ? this.breakdownHtml(r) : '本局无人和牌';
    } else {
      const w = r.winner;
      $('result-title').textContent = `本局结束，${SEAT_LABEL[w]} 获胜！`;
      // No additive fan → the base term is 1 (提溜/小和); lead with a 小和·1分 chip so the score reads.
      const chips = [];
      if (!r.fans.some((f) => FAN_ADD[f] != null)) chips.push('小和·1分');
      for (const f of r.fans) {
        if (FAN_ADD[f] != null) chips.push(`${f}·${FAN_ADD[f]}分`);     // additive: 龙·4分
        else if (FAN_MULT[f] != null) chips.push(`${f} x${FAN_MULT[f]}`); // multiplier: 素 x2
        else chips.push(f);
      }
      for (const text of chips) {
        const c = document.createElement('span'); c.className = 'fan-chip'; c.textContent = text;
        fansEl.appendChild(c);
      }
      scoreEl.textContent = '';                          // total winning score removed; each fan chip carries its own gain
      if (r.winningTile != null) {
        const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = '和这张';
        winEl.appendChild(cap);
        winEl.appendChild(faceTileEl(r.winningTile, { lg: true, wild: this.game.isWild(r.winningTile) }));
        winEl.classList.add('show');
      }
      if (r.decomp) this.renderWinningHand(handEl, w, r); // the winning hand pattern (server sends decomp online too)
      payEl.innerHTML = this.breakdownHtml(r);
    }
    renderSeatHands(this.game, (id) => this.game.isWild(id)); // reveal every seat's hand on its border
    if (!ONLINE) this.saveSession();
    // If this hand closes the 北圈, the 锅 is finished — the button ENDS it and shows the 最终成绩.
    // Offline we compute it from the session; online the server flags it (onlineEndsMatch, set on 'over')
    // because the rotated view can't tell which absolute seat is the 锅's first 庄.
    const endsPot = ONLINE ? this.onlineEndsMatch : (this.game.nextDealer() === 0 && this.game.dealer !== 0 && this.session.prevailingWind === 3);
    const nb = $('next-hand-btn'); nb.disabled = false; nb.classList.remove('readied'); this.onlineReadied = false; // fresh result → not ready
    nb.textContent = endsPot ? '结束并查看总成绩 🏆' : (ONLINE ? '我准备好了' : '下一局');
    ov.classList.remove('hidden');
    this.resultFocus = 0; this.focusResultBtn(); // 下一局 focused by default
  }

  // 得分明细 for the result panel. First the overall result — every seat's net laid out as
  // a 3×3 grid mirroring the table (对家 top, 上家 left, 下家 right, 玩家 bottom) — then the
  // human's own breakdown: net vs each opponent with 胡 / 明杠 / 暗杠 / 金杠 as subitems and
  // 庄x2 / 拉庄x2 tags where they apply. The multipliers come from game.settlementFactors,
  // the same source _settle + _settleKongs use, so the panel can never drift from the math.
  breakdownHtml(r) {
    const me = HUMAN, dealer = this.game.dealer;
    const winner = r.type === 'win' ? r.winner : -1;
    const score = r.score || 0;
    const col = (v) => (v > 0 ? '#7ddf8a' : v < 0 ? '#ef9a9a' : '#cfe7db');
    const sgn = (v) => (v > 0 ? '+' : '') + v;
    // per-seat kong points split by type (明杠 / 暗杠 / 金杠) from the just-finished melds
    const kt = (p) => {
      let open = 0, conc = 0, gold = 0;
      for (const m of this.game.melds[p]) {
        if (m.type !== 'kong') continue;
        if (this.game.isWild(m.kind)) gold += 4; else if (m.concealed) conc += 2; else open += 1;
      }
      return { open, conc, gold };
    };
    const KT = [0, 1, 2, 3].map(kt);
    // overall — 3×3 grid placing each seat where it sits at the table
    const GRID = { 0: [3, 2], 1: [2, 3], 2: [1, 2], 3: [2, 1] };
    const all = [0, 1, 2, 3].map((p) => {
      const [row, c] = GRID[p];
      return `<span class="bd-all-seat${p === me ? ' me' : ''}" style="grid-row:${row};grid-column:${c}">` +
        `${p === dealer ? '👑' : ''}${SEAT_LABEL[p]} <b style="color:${col(r.payments[p])}">${sgn(r.payments[p])}</b></span>`;
    }).join('');
    // your breakdown — vs each opponent, with the 胡/杠 reasons as subitems (no per-opponent total)
    const grps = [1, 2, 3].map((off) => {
      const q = (me + off) % 4, factors = this.game.settlementFactors(me, q);
      const f = factors.reduce((m, x) => m * x.factor, 1);
      const km = KT[me], kq = KT[q];
      const subs = [];
      const hu = winner === me ? score * f : winner === q ? -score * f : 0;
      if (hu) subs.push(['胡', hu]);
      // 杠分 settles pairwise: against this opponent I COLLECT my own 杠 points and PAY theirs.
      // Show the two directions separately (a gain line +, a loss line −) so an opponent who
      // also has a 杠 doesn't silently cancel mine into a smaller, confusing net.
      for (const [label, mine, theirs] of [['明杠', km.open, kq.open], ['暗杠', km.conc, kq.conc], ['金杠', km.gold, kq.gold]]) {
        if (mine) subs.push([label, mine * f]);                                  // my 杠 → this opponent pays me
        if (theirs) subs.push([`${SEAT_LABEL[q]}${label}`, -theirs * f]);        // their 杠 → I pay them
      }
      const tag = factors.map((x) => ` <span class="dbl">${x.label}x${x.factor}</span>`).join('');
      const subHtml = (subs.length ? subs : [['—', 0]]).map(([w, v]) =>
        `<div class="bd-sub"><span>${w}</span><span class="s-net" style="color:${col(v)}">${v ? sgn(v) : '—'}</span></div>`
      ).join('');
      return `<div class="bd-grp"><div class="bd-row"><span class="bd-seat">${q === dealer ? '👑 ' : ''}${SEAT_LABEL[q]}${tag}</span></div>${subHtml}</div>`;
    });
    return `<div class="bd-totals"><div class="bd-title">本局得分</div><div class="bd-all">${all}</div></div>` +
      `<div class="bd-title">玩家明细</div>` +
      grps.join('');
  }

  nextHand() {
    if (VIEWER) return; // a spectator can't ready up — the next hand deals when the real players are ready
    if (ONLINE) {
      if (this.onlineEndsMatch) {
        // Final hand of the 锅: this only ENDS it — the server replies with 'matchOver' → 最终成绩. No
        // un-ready toggle (you can't un-finish a 锅); just lock the button while the server settles.
        this.backend.next();
        const btn = $('next-hand-btn'); btn.disabled = true; btn.textContent = '结算中…';
        return;
      }
      // Toggle readiness. The server deals the next hand only once EVERY human is ready (no timeout),
      // so you can ready up and change your mind; the result panel auto-hides when the next hand deals.
      this.onlineReadied = !this.onlineReadied;
      const btn = $('next-hand-btn');
      if (this.onlineReadied) { this.backend.next(); btn.textContent = '✓ 已准备 · 取消'; btn.classList.add('readied'); }
      else { this.backend.unready(); btn.textContent = '我准备好了'; btn.classList.remove('readied'); }
      return;
    }
    $('result-overlay').classList.add('hidden');
    const nextDealer = this.game.nextDealer();
    // A 圈 ends when the 庄 button laps back to seat 0 (东). Four 圈 (东南西北) make a
    // 锅: when the 北圈 (prevailingWind 3) laps, the 锅 is over → final scoreboard.
    const roundDone = nextDealer === 0 && this.game.dealer !== 0;
    if (roundDone) {
      // Snapshot the cumulative scores at the close of the 圈 just finished (每圈成绩).
      this.session.rounds.push({ wind: this.session.prevailingWind, scores: this.game.scores.slice() });
      if (this.session.prevailingWind === 3) { // 北圈 done → 锅 complete; stop and tally
        this.recordMatchHistory(); // append this 锅's final scores to the persistent 历史战绩
        this.saveSession();
        this.showFinalBoard();
        return;
      }
      this.session.prevailingWind = (this.session.prevailingWind + 1) % 4;
    }
    this.session.hand += 1;
    this.session.dealer = nextDealer;
    this.startHand();
  }

  startHand() {
    if (!this.scene) { this.scene = new Renderer($('scene')); this.scene.setRotated(this.isPortrait); this.scene.resize(); this.scene.onHandDrawSettled = () => this.selectDrawnTile(); }
    if (!this.backend) { this.backend = createBackend({ mode: 'local', rng: Math.random }); this.backend.onEvent((ev) => this.onBackendEvent(ev)); }
    this.backend.thinkDelay = AI_DELAY; // bot "think" pacing — the online-latency stand-in
    // Hand off to the backend: it resolves 拉庄 (emitting 'lazhuang' for the human to
    // answer), deals (emits 'deal'), then drives the opponents — the UI reacts in
    // onBackendEvent. The 锅/圈 progression + persistence stay UI-side (nextHand/session).
    this.backend.startHand({
      dealer: this.session.dealer, prevailingWind: this.session.prevailingWind,
      scores: this.session.scores, seatBase: this.session.seatBase,
    });
  }

  // Online: connect to the server's table. The server is the ground truth — it deals, drives
  // the opponents, and PUSHES frames into onBackendEvent; there is NO local match logic, no
  // session, no 锅/圈 bookkeeping here (all of that lives server-side). On (re)connect the server
  // resyncs the game in progress.
  connectOnline() {
    if (!this.scene) { this.scene = new Renderer($('scene')); this.scene.setRotated(this.isPortrait); this.scene.resize(); this.scene.onHandDrawSettled = () => this.selectDrawnTile(); }
    this.backend = createBackend({ mode: 'remote', url: ONLINE_URL, uid: clientUidSync(), name: localStorage.getItem('mahjong-online-name') || '',
      spectate: VIEWER ? { table: 0, seat: VIEWER_SEAT } : null });
    this.backend.onEvent((ev) => this.onBackendEvent(ev));
    this.backend.connect();
  }

  // ---------------------------------------------------------------------------
  // 拉庄 (blind double-down) panel — a table-shaped cross: every seat shown around the centre
  // (名字 + 庄/拉庄 status), the question + ⚔️/不拉 buttons in the middle, and an arrow pointing at
  // the 庄. The hand is already dealt but kept face-down (lzBlind) so the choice stays blind. A
  // non-deciding viewer (the 庄, or a challenger who already chose) sees the live tally instead of
  // buttons. The DECISION wiring (who's asked) lives in the backend; we just render + answer.
  // ---------------------------------------------------------------------------
  lzSeatName(p) {
    if (ONLINE && this.game && this.game.seatNames) return this.game.seatNames[p] || (this.game.seatKinds && this.game.seatKinds[p] === 'bot' ? '机器人' : '');
    return SEAT_LABEL[p];
  }
  showLaZhuangPanel(dealer, need, answers, cb) {
    const deciding = need.includes(HUMAN);
    this.lzCallback = deciding ? cb : null; this.lzFocus = 1; // watchers (the 庄 / already-chosen) can't answer

    for (let p = 0; p < 4; p++) {
      const el = $('lz-seat-' + p);
      let st = '';
      if (p === dealer) st = '<span class="lz-st dealer">庄家</span>';
      else if (need.includes(p)) st = '<span class="lz-st pend">…</span>';
      else if (answers[p] !== undefined) st = answers[p] ? '<span class="lz-st yes">⚔️ 拉</span>' : '<span class="lz-st no">不拉</span>';
      const pts = this.game && this.game.scores ? (this.game.scores[p] | 0) : 0; // current 锅 running total
      const col = pts > 0 ? '#7ddf8a' : pts < 0 ? '#ef9a9a' : '#cfe7db';
      const wind = (this.game && this.game.seatWind) ? WIND[this.game.seatWind(p)] : WIND[p]; // the seat's 座风 (东西南北)
      el.className = 'lz-seat lz-pos-' + p + (p === HUMAN ? ' me' : '') + (p === dealer ? ' dealer' : '');
      el.innerHTML = `<span class="lz-nm">${p === dealer ? '👑 ' : ''}${esc(this.lzSeatName(p))}</span>` +
        `<span class="lz-rel"><b class="lz-wind">${wind}</b> · ${(ONLINE ? REL_LABEL : SEAT_LABEL)[p]}</span>` +
        `<span class="lz-score" style="color:${col}">${pts > 0 ? '+' : ''}${pts} 分</span>` + st;
    }
    $('lazhuang-text').textContent = deciding ? `${this.lzSeatName(dealer)}坐庄，是否拉庄？` : `${this.lzSeatName(dealer)}坐庄`;
    $('lz-btns').style.display = deciding ? '' : 'none';
    $('lz-wait').style.display = deciding ? 'none' : '';
    $('lz-wait').textContent = '等待拉庄确认…';
    $('lz-arrow').className = 'lz-arrow lz-arrow-' + dealer; // points at the 庄
    this.lzActive = true; // the 混儿 stays hidden while the panel is up
    $('lazhuang-overlay').classList.remove('hidden');
    if (deciding) this.focusLzBtn();
  }
  hideLaZhuangPanel() { this.lzCallback = null; this.lzActive = false; $('lazhuang-overlay').classList.add('hidden'); }
  focusLzBtn() {
    const btns = [$('lazhuang-yes'), $('lazhuang-no')];
    btns.forEach((b, i) => b && b.classList.toggle('focus', i === this.lzFocus));
    btns[this.lzFocus] && btns[this.lzFocus].focus();
  }
  resolveLz(yes) {
    if (VIEWER) return; // a spectator can't answer — the panel updates from the real player's choice
    if (!this.lzCallback) return;
    const cb = this.lzCallback; this.lzCallback = null;
    cb(yes); // send the answer; keep the panel up (now in 'waiting' state) until play resumes
    $('lz-btns').style.display = 'none';
    $('lazhuang-text').textContent = yes ? '你选择了 ⚔️ 拉庄' : '你选择了 不拉';
    $('lz-wait').style.display = ''; $('lz-wait').textContent = '等待其他玩家…';
    if (!ONLINE) { this.lzBlind = false; this.render(); } // offline: reveal the hand right away (online waits for the server)
  }

  newGame() {
    if (ONLINE) { this.returnHub(); return; } // online: 重开/再来一锅 go back to the lobby (server owns the match)
    // Drop the finished view; the next 'deal' installs the fresh one. (Starting a new hand
    // bumps the backend's generation, so any in-flight opponent loop abandons quietly.)
    this.game = null;
    this.session = this.freshSession();
    this.startHand(); // backend deals from the zeroed session; the 'deal' event persists it
  }

  // ---------------------------------------------------------------------------
  // 每圈成绩 / 一锅最终成绩 — 圈 = one 庄 lap (东南西北 winds); 锅 = four 圈.
  // ---------------------------------------------------------------------------

  // The 每圈成绩 table: one row per completed 圈 (its net change per seat), a 进行中 row
  // for the 圈 still in play, and a 合计 footer (cumulative). `live` = the current running
  // scores (game.scores) while a 锅 is in progress, or null.
  roundsTableHtml(live, rounds = this.session.rounds) {
    const seats = [0, 1, 2, 3];
    const cell = (v) => `<td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'}">${v > 0 ? '+' : ''}${v}</td>`;
    const row = (label, delta, cls = '') =>
      `<tr class="${cls}"><td class="rd-wind">${label}</td>${seats.map((p) => cell(delta[p])).join('')}</tr>`;
    let prev = [0, 0, 0, 0], body = '';
    for (const r of rounds) {
      body += row(`${WIND[r.wind]}圈`, r.scores.map((s, i) => s - prev[i]));
      prev = r.scores;
    }
    // the 圈 currently being played is not snapshotted yet — show its partial delta (offline only;
    // online passes the completed 4 圈 so this branch never fires)
    if (live && rounds.length < 4) {
      body += row(`${WIND[this.session.prevailingWind]}圈 · 进行中`, live.map((s, i) => s - prev[i]), 'live');
    }
    if (!body) body = `<tr><td class="rd-empty" colspan="5">本锅还没有完成的圈</td></tr>`;
    const total = live || (rounds.length ? rounds[rounds.length - 1].scores : [0, 0, 0, 0]);
    const head = `<tr><th></th>${seats.map((p) => `<th class="${p === HUMAN ? 'me' : ''}">${SEAT_LABEL[p]}</th>`).join('')}</tr>`;
    const foot = `<tr><td class="rd-wind">合计</td>${seats.map((p) => cell(total[p])).join('')}</tr>`;
    return `<table class="rounds-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
  }

  openRounds() {
    $('rounds-body').innerHTML = this.roundsTableHtml(this.game ? this.game.scores : null);
    $('rounds-overlay').classList.remove('hidden');
  }

  // 历史战绩: one row per finished 锅 (date + its final per-seat scores) and a 合计 footer
  // with the lifetime total. Columns are the human-relative seats (玩家/下家/对家/上家).
  historyTableHtml() {
    const hist = this.loadHistory();
    if (!hist.length) return '<p class="sub" style="padding:16px 8px;">还没有打完的锅</p>';
    const seats = [0, 1, 2, 3];
    const cell = (v) => `<td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'}">${v > 0 ? '+' : ''}${v}</td>`;
    const z = (n) => String(n).padStart(2, '0');
    const date = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
    const total = [0, 0, 0, 0];
    const body = hist.map((rec) => {
      rec.scores.forEach((s, p) => { total[p] += s; });
      return `<tr><td class="rd-wind">${date(rec.at)}</td>${seats.map((p) => cell(rec.scores[p])).join('')}</tr>`;
    }).join('');
    const head = `<tr><th></th>${seats.map((p) => `<th class="${p === HUMAN ? 'me' : ''}">${SEAT_LABEL[p]}</th>`).join('')}</tr>`;
    const foot = `<tr><td class="rd-wind">合计 (${hist.length}锅)</td>${seats.map((p) => cell(total[p])).join('')}</tr>`;
    return `<table class="rounds-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
  }

  openHistory() {
    $('history-body').innerHTML = this.historyTableHtml();
    this.histClearArm = false; $('history-clear').textContent = '清空历史';
    $('menu-overlay').classList.add('hidden');
    $('history-overlay').classList.remove('hidden');
  }

  // The 锅 is over (four 圈 done): final standings, a 恭喜 line when the human placed
  // first, the 每圈成绩 breakdown, and a reset to deal a fresh 锅.
  showFinalBoard(data) {
    const scores = (data ? data.scores : this.game.scores).slice(); // online: server-provided final scores
    const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a]); // display: high → low
    const top = Math.max(...scores);
    const MEDAL = ['🥇', '🥈', '🥉'];
    const rankOf = (p) => scores.filter((s) => s > scores[p]).length; // 0-based; ties share a medal
    $('final-standings').innerHTML = order.map((p) => {
      const r = rankOf(p), v = scores[p];
      return `<div class="standing${p === HUMAN ? ' me' : ''}">` +
        `<span class="rank">${MEDAL[r] || (r + 1)}</span>` +
        `<span class="who">${SEAT_LABEL[p]}${p === HUMAN ? '（你）' : ''}</span>` +
        `<span class="pts ${v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'}">${v > 0 ? '+' : ''}${v}</span></div>`;
    }).join('');
    const tiedTop = scores.filter((s) => s === top).length > 1;
    $('final-congrats').textContent = scores[HUMAN] === top
      ? (tiedTop ? '🎉 恭喜并列第一！' : '🎉 恭喜你赢得这一锅！')
      : '本锅惜败，下一锅再战！';
    $('final-rounds').innerHTML = this.roundsTableHtml(scores, data ? data.rounds : this.session.rounds);
    // Online the server owns the match, so 再来一锅 just returns to the lobby — identical to 返回大厅.
    // Drop the duplicate; offline it genuinely starts a fresh zeroed 锅, so keep it there.
    $('final-reset-btn').style.display = ONLINE ? 'none' : '';
    $('final-overlay').classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // Input: unified action dispatch from keyboard + gamepad
  // ---------------------------------------------------------------------------
  onAction(name) {
    if (!this.gameStarted) return;
    sound.resume(); // a key/pad press is a user gesture — unlock audio
    if (!$('leave-confirm-overlay').classList.contains('hidden')) {
      if (name === 'confirm') this.returnHub();                                                  // 确定返回 → lobby
      else if (name === 'cancel' || name === 'menu') $('leave-confirm-overlay').classList.add('hidden'); // 继续游戏
      return;
    }
    if (!$('forfeit-confirm-overlay').classList.contains('hidden')) {
      if (name === 'confirm') this.doForfeit();                                                  // 确认认输
      else if (name === 'cancel' || name === 'menu') $('forfeit-confirm-overlay').classList.add('hidden'); // 取消
      return;
    }
    if (!$('menu-overlay').classList.contains('hidden') ||
        !$('rules-overlay').classList.contains('hidden') ||
        !$('start-overlay').classList.contains('hidden')) {
      if (name === 'cancel' || name === 'menu') this.closeOverlays();
      return;
    }
    if (!$('lazhuang-overlay').classList.contains('hidden')) {
      if (name === 'left' || name === 'right') { this.lzFocus ^= 1; this.focusLzBtn(); }
      else if (name === 'confirm') this.resolveLz(this.lzFocus === 0);
      else if (name === 'cancel') this.resolveLz(false); // 不拉
      return;
    }
    if (!$('rounds-overlay').classList.contains('hidden')) {
      if (name === 'cancel' || name === 'menu' || name === 'confirm') $('rounds-overlay').classList.add('hidden');
      return;
    }
    if (!$('history-overlay').classList.contains('hidden')) {
      if (name === 'cancel' || name === 'menu' || name === 'confirm') $('history-overlay').classList.add('hidden');
      return;
    }
    if (!$('final-overlay').classList.contains('hidden')) {
      if (name === 'confirm') { $('final-overlay').classList.add('hidden'); this.newGame(); } // 再来一锅
      else if (name === 'menu') this.returnHub();
      return;
    }
    if (!$('result-overlay').classList.contains('hidden')) {
      if (name === 'left') { this.resultFocus = 1; this.focusResultBtn(); }      // 返回 (top-left)
      else if (name === 'right') { this.resultFocus = 0; this.focusResultBtn(); } // 下一局 (top-right)
      else if (name === 'confirm') (this.resultFocus === 0 ? this.nextHand() : this.leaveToLobby());
      else if (name === 'menu') this.nextHand();
      return;
    }

    if (this.dealing || this.animating) return; // serving tiles / a discard fly is playing — hold input
    if (!this.game) { if (name === 'menu') this.openMenu(); return; } // between hands (backend dealing)

    if (this.isClaimPhase()) {
      const btns = [...$('action-bar').children];
      if (name === 'left') { this.focusIndex = (this.focusIndex - 1 + btns.length) % btns.length; this.render(); }
      else if (name === 'right') { this.focusIndex = (this.focusIndex + 1) % btns.length; this.render(); }
      else if (name === 'confirm') btns[this.focusIndex]?.click();
      else if (name === 'pung') this.doClaim('pung');
      else if (name === 'kong') this.doClaim('kong');
      else if (name === 'cancel' || name === 'pass') this.doPass();
      else if (name === 'menu') this.openMenu();
      return;
    }

    if (this.game.turn === HUMAN && this.game.phase === PHASE.AWAIT_DISCARD) {
      const n = this.selectableHandIndices().length;
      if (name === 'win') this.doDeclareWin();
      else if (name === 'left') { this.drawnWildSelected = false; this.noSel = false; this.selIndex = (this.selIndex - 1 + n) % n; sound.select(); this.render(); }
      else if (name === 'right') { this.drawnWildSelected = false; this.noSel = false; this.selIndex = (this.selIndex + 1) % n; sound.select(); this.render(); }
      else if (name === 'confirm') this.discardSelected();
      else if (name === 'kong') { const o = this.game.selfKongOptions(HUMAN)[0]; if (o) this.doSelfKong(o.kind); }
      else if (name === 'menu') this.openMenu();
      else if (name === 'cancel') this.openMenu();
      return;
    }

    // Keep the hand browsable while waiting for another player (no discard) so the table isn't frozen.
    if (name === 'left' || name === 'right') {
      const n = this.selectableHandIndices().length;
      if (n) { this.drawnWildSelected = false; this.noSel = false; this.selIndex = (this.selIndex + (name === 'left' ? -1 : 1) + n) % n; sound.select(); this.render(); return; }
    }

    if (name === 'menu') this.openMenu();
  }

  // ---------------------------------------------------------------------------
  // Overlays + boot
  // ---------------------------------------------------------------------------
  fillRules() {
    $('rules-body').innerHTML = `
      <h3>基本</h3>
      136 张牌（无花）。<b>只能碰、杠，不能吃</b>；<b>胡牌只能自摸</b>（包括杠上开花），不能点炮。
      胡牌必须<b>四副 + 一将</b>（无七对等特殊牌型）。
      <h3>混儿（百搭）</h3>
      发牌后翻一张指示牌，<b>该牌及其下一张</b>都是混儿，可代替任意牌组成胡牌。
      混儿<b>不能用于碰杠</b>，也<b>不能打出</b>。
      <h3>番种</h3>
      提溜（底）<code>1</code>，混吊（将带混）/ 双混吊（一副带两混）<code>×2</code>，素（没混儿）<code>×2</code>，
      捉五（独胡五万，五万/四六万可为混儿）<code>+3</code>，龙（一色 1-9）<code>+4</code>，本混龙（龙与混同色）<code>×2 → 8</code>，
      杠开 <code>×2</code>，天和/地和（起手/首摸即胡）<code>+4</code>——“天胡算龙”：按龙记底、随意摆，
      其余番照常叠加（如天和+混吊 = 混吊龙 <code>8</code>）。
      <h3>算番</h3>
      天和/地和、捉五、龙<b>相加</b>成底（无则底为 1，即提溜）；本混、混吊、素、杠开各<b>×2</b>。先加后乘。
      <b>起和 2 番</b>，不足 2 番为小和、不能胡。庄家加倍。
      <h3>杠分</h3>
      明杠 <code>+1</code>，暗杠 <code>+2</code>，金杠（暗杠四张混儿）<code>+4</code>。每家杠分由其它三家补，局末单独结算；涉及<b>庄家</b>的杠分<b>加倍</b>（庄x2）。
      <h3>拉庄</h3>
      发牌前，非庄家可<b>拉庄</b>：你与<b>庄家</b>之间的全部得分（底分 + 杠分）再<b>翻倍</b>（拉庄x2，与庄x2叠加）。盲选，牌未发，搏一把。
      <h3>操作</h3>
      自摸成胡时出现 <b>胡</b> 按钮（含番种与得分），点它才和牌，也可继续打牌；快捷键 <b>H</b>。
      点牌选中、再点该牌或按 <b>A</b> 出牌；左右/摇杆移动光标。
      可碰/杠时：<b>X</b>=碰，<b>Y</b>=杠，<b>B</b>=过。<b>Menu</b> 打开菜单。`;
  }

  bindUI() {
    $('start-btn').addEventListener('click', () => {
      $('start-overlay').classList.add('hidden');
      this.gameStarted = true;
      sound.resume();
      this.startHand();
    });
    $('rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
    $('start-hub-link').addEventListener('click', () => { location.replace(homeHref()); }); // start screen → hub (or the /mj/ sub-hub)
    $('menu-rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
    $('rules-close').addEventListener('click', () => $('rules-overlay').classList.add('hidden'));
    $('menu-btn').addEventListener('click', () => this.openMenu());
    mountPowerControl($('menu-hub-btn').parentNode, $('menu-hub-btn')); // 省电模式 picker, above 返回大厅
    const soundBtn = $('sound-btn');
    const updateSoundIcon = () => { soundBtn.textContent = sound.muted ? '🔇' : '🔊'; };
    soundBtn.addEventListener('click', () => { sound.resume(); sound.toggleMuted(); updateSoundIcon(); });
    updateSoundIcon();
    const fastChk = $('fast-mode-chk');
    if (fastChk) {
      fastChk.checked = this.fastMode;
      fastChk.addEventListener('change', () => { this.fastMode = fastChk.checked; localStorage.setItem('mahjong-fast', this.fastMode ? '1' : '0'); });
    }
    $('resume-btn').addEventListener('click', () => this.closeOverlays());
    $('newgame-btn').addEventListener('click', () => { this.closeOverlays(); this.newGame(); });
    $('next-hand-btn').addEventListener('click', () => this.nextHand());
    $('back-hub-btn').addEventListener('click', () => this.leaveToLobby());
    $('leave-confirm-yes').addEventListener('click', () => this.returnHub());
    $('leave-confirm-no').addEventListener('click', () => $('leave-confirm-overlay').classList.add('hidden'));
    $('rounds-btn').addEventListener('click', () => this.openRounds());
    $('rounds-close').addEventListener('click', () => $('rounds-overlay').classList.add('hidden'));
    $('lazhuang-yes').addEventListener('click', () => { sound.resume(); this.resolveLz(true); });
    $('lazhuang-no').addEventListener('click', () => { sound.resume(); this.resolveLz(false); });
    $('final-reset-btn').addEventListener('click', () => { $('final-overlay').classList.add('hidden'); this.newGame(); });
    $('final-hub-btn').addEventListener('click', () => this.returnHub());
    $('menu-history-btn').addEventListener('click', () => this.openHistory());
    $('history-close').addEventListener('click', () => $('history-overlay').classList.add('hidden'));
    $('history-clear').addEventListener('click', () => {
      if (!this.histClearArm) { this.histClearArm = true; $('history-clear').textContent = '确定清空？（再点一次）'; return; }
      localStorage.removeItem('mahjong-history'); this.histClearArm = false; $('history-clear').textContent = '清空历史';
      $('history-body').innerHTML = this.historyTableHtml();
    });
    $('menu-hub-btn').addEventListener('click', () => this.leaveToLobby());
    // 认输 (forfeit) — online players only; a red two-step confirm.
    $('menu-forfeit-btn').addEventListener('click', () => { $('menu-overlay').classList.add('hidden'); $('forfeit-confirm-overlay').classList.remove('hidden'); });
    $('forfeit-confirm-yes').addEventListener('click', () => this.doForfeit());
    $('forfeit-confirm-no').addEventListener('click', () => $('forfeit-confirm-overlay').classList.add('hidden'));
    // Online: no 重开 (the server owns the match) and no local 历史战绩 (scores live on the lobby
    // leaderboard); offer 认输 instead. Hidden rather than removed so the offline build is untouched.
    if (ONLINE) { $('newgame-btn').style.display = 'none'; $('menu-history-btn').style.display = 'none'; }
    if (ONLINE && !VIEWER) $('menu-forfeit-btn').hidden = false; // a forfeit only makes sense for a seated online player
    this.fillRules();
  }

  // User-initiated "返回大厅". Leaving a live online game (as a seated player) keeps your seat —
  // the server auto-plays it (random discards) until the hand ends — so confirm first. Spectators,
  // offline play, and the 锅-over final board leave straight away (no auto-play at stake).
  leaveToLobby() {
    if (ONLINE && this.game && !VIEWER) { $('menu-overlay').classList.add('hidden'); $('leave-confirm-overlay').classList.remove('hidden'); return; }
    this.returnHub();
  }

  // Leave the game: offline → the hub we came from (main or a sub-hub); online → back to the lobby.
  returnHub() {
    if (!ONLINE) { location.replace(homeHref()); return; }
    const params = new URLSearchParams(location.search); // carry ?server=/fast/flat back to the lobby
    for (const k of ['online', 'viewer', 'vseat', 'vtable']) params.delete(k);
    params.set('game', 'tianjin'); // return to THIS game's split lobby
    const qs = params.toString();
    location.replace('../mahjong-common-online/' + (qs ? '?' + qs : ''));
  }
}

const app = new TianjinGame();

// Always render landscape; when the scene exists, keep it in sync with the rotation.
forceLandscape((p) => { app.isPortrait = p; if (app.scene) { app.scene.setRotated(p); app.scene.resize(); } });

// Touch / mouse on the 3D table → raycast → select the picked hand tile.
$('scene').addEventListener('pointerdown', (e) => {
  if (!app.scene || !app.gameStarted || app.dealing || app.animating) return;
  sound.resume(); // touch is a user gesture — unlock audio
  const idx = app.scene.pick(e.clientX, e.clientY);
  if (idx != null) app.trackTileGesture(e, idx); // tap = select / second-tap discard; slide up ~2 tiles = play directly
});
// PC only: hovering a hand tile selects it (same as a click-to-select). Mouse-only
// so touch is unaffected; 混儿 aren't selectable so hovering them is ignored.
$('scene').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !app.scene || !app.gameStarted || app.dealing || app.animating || !app.game) return;
  if (app.scene.handDrawRevealing || app.game.phase === PHASE.OVER || app.isClaimPhase()) return; // hover-select even off-turn (no discard)
  const idx = app.scene.pick(e.clientX, e.clientY);
  if (idx == null) return;
  const pos = app.selectableHandIndices().indexOf(idx);
  if (pos >= 0 && (pos !== app.selIndex || app.drawnWildSelected || app.noSel)) { app.drawnWildSelected = false; app.noSel = false; app.selIndex = pos; sound.select(); app.render(); }
});

bindKeys((name) => app.onAction(name), {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'left', ArrowDown: 'right',
  Enter: 'confirm', ' ': 'confirm',
  p: 'pung', P: 'pung', g: 'kong', G: 'kong', k: 'kong', K: 'kong', h: 'win', H: 'win',
  Escape: 'cancel', Backspace: 'pass', m: 'menu', M: 'menu',
});
// Xbox: A=confirm B=cancel X=pung Y=kong, d-pad/stick = left/right, Menu = menu.
startGamepad((name) => app.onAction(name), { 14: 'left', 12: 'left', 15: 'right', 13: 'right', 0: 'confirm', 1: 'cancel', 2: 'pung', 3: 'kong', 9: 'menu' });

app.bindUI();

// Tile-back color palette (3D table only) — hidden by default; add ?palette=1 to show it. Pick a color
// (or type a #rrggbb) to live-update the back via scene.setBackColor(), then copy the hex into scene.js
// (`this.back` color). The setBackColor() API stays regardless, for changing the color dynamically.
if (!FLAT && new URLSearchParams(location.search).get('palette')) {
  const DEFAULT_BACK = '#4165af'; // current source value of the 3D tile back
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9999;background:rgba(4,18,12,0.9);' +
    'border:1px solid #2c8160;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;' +
    'font:12px system-ui,sans-serif;color:#eaf6f0;box-shadow:0 4px 14px rgba(0,0,0,0.5)';
  box.innerHTML = '<b style="font-size:11px;letter-spacing:.05em">TILE BACK (temp)</b>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    `<input type="color" id="tb-color" value="${DEFAULT_BACK}" style="width:42px;height:30px;border:none;background:none;cursor:pointer">` +
    `<input type="text" id="tb-hex" value="${DEFAULT_BACK}" spellcheck="false" style="width:84px;background:#06150f;border:1px solid #1c5a44;border-radius:6px;color:#eaf6f0;padding:5px 6px;font:12px monospace">` +
    '</div>';
  document.body.appendChild(box);
  const color = box.querySelector('#tb-color'), hex = box.querySelector('#tb-hex');
  const apply = (v) => { if (app.scene && app.scene.setBackColor) app.scene.setBackColor(v); };
  color.addEventListener('input', () => { hex.value = color.value; apply(color.value); });
  hex.addEventListener('input', () => {
    const v = hex.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) { color.value = v; apply(v); }
  });
}

// Online boot: no start overlay / difficulty — the lobby already started the table. Connect
// and let the server drive. (Gated on ONLINE; the offline boot below the start overlay is
// completely unchanged.)
if (ONLINE) { $('start-overlay').classList.add('hidden'); app.gameStarted = true; app.connectOnline(); }

// Debug hook (only under ?fast=1) for visual checks.
if (new URLSearchParams(location.search).get('fast')) {
  window.__mj = {
    humanTurn: () => !!app.game && app.game.turn === HUMAN && app.game.phase === PHASE.AWAIT_DISCARD,
    // emulate a real user: a drawn 混儿 can't be discarded, so fall back to a non-wild tile
    discard: () => { app.drawnWildSelected = false; app.discardSelected(); },
    scene: () => app.scene,
    game: () => app.game,
    // visual check: melds for every seat + a full pool + a pending claim
    debugMelds: () => {
      const w = app.game.wilds[0];
      app.game.melds[HUMAN] = [
        { type: 'kong', kind: 0, tiles: [0, 0, 0, 0] },                  // 明杠
        { type: 'kong', kind: 9, tiles: [9, 9, 9, 9], concealed: true }, // 暗杠
        { type: 'kong', kind: w, tiles: [w, w, w, w], concealed: true }, // 金杠
      ];
      for (let p = 1; p < 4; p++) app.game.melds[p] = [
        { type: 'pung', kind: p * 4, tiles: [p * 4, p * 4, p * 4] },
        { type: 'kong', kind: 9 + p * 3, tiles: [9 + p * 3, 9 + p * 3, 9 + p * 3, 9 + p * 3], concealed: p === 2 },
      ];
      app.game.discardLog = [];
      for (let i = 0; i < 40; i++) app.game.discardLog.push({ player: i % 4, kind: (i * 7) % 34 });
      app.game.discardLog.push({ player: 1, kind: 4 });       // pending tile
      app.game.phase = PHASE.AWAIT_CLAIM;
      app.game.lastDiscard = { player: 1, kind: 4 };
      app.game.claim = { player: HUMAN, kind: 4, options: ['pung'] };
      app.render();
    },
    // visual check: a full discard pool laid out in suit columns, no pending tile
    debugPool: () => {
      app.game.discardLog = [];
      const base = [0, 9, 18, 27]; // 万 筒 条 字 starting ids
      const order = [3, 7, 1, 8, 0, 5, 2, 6, 4]; // scrambled, to show id-sorting
      for (let s = 0; s < 4; s++) for (let k = 0; k < 9; k++) {
        app.game.discardLog.push({ player: k % 4, kind: base[s] + (order[k] % (s === 3 ? 7 : 9)) });
      }
      app.game.phase = PHASE.AWAIT_DISCARD; app.game.claim = null; app.game.turn = HUMAN;
      app.render();
    },
    // visual check: the self-draw 胡 button (win available, not yet claimed)
    debugHu: () => {
      app.game.hands[HUMAN] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 26, 26];
      app.game.turn = HUMAN; app.game.phase = PHASE.AWAIT_DISCARD; app.game.drawnTile = 26; app.game.claim = null;
      app.game.selfDrawWin = { score: 8, fans: ['龙'], decomp: null };
      app.render();
    },
    // visual check: 金杠 available (four 混儿 held)
    debugGold: () => {
      const w = app.game.wilds[1];
      app.game.hands[HUMAN] = [w, w, w, w, 0, 1, 2, 9, 10, 11, 18, 19, 20, 26];
      app.game.turn = HUMAN; app.game.phase = PHASE.AWAIT_DISCARD; app.game.drawnTile = 26; app.game.claim = null; app.game.selfDrawWin = null;
      app.render();
    },
    // visual check: a 混吊 win — the 混 (here 1万) stands in the 9条 pair but is
    // shown with its original 1万 face + 混 badge, not as 9条.
    debugWin: () => {
      app.game.wilds = [0, 1]; app.game.wildSet = new Set([0, 1]);
      app.game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 0];
      app.game.melds[HUMAN] = [];
      app.game.dealer = 1; // 下家 is 庄 — exercises the crown + 庄x2 on a non-winner
      app.game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      app.game.result = {
        type: 'win', winner: HUMAN, score: 2, fans: ['混吊'], winningTile: 26,
        decomp: [
          { type: 'chow', kinds: [3, 4, 5], jokers: 0, natural: S(3, 4, 5) },
          { type: 'chow', kinds: [6, 7, 8], jokers: 0, natural: S(6, 7, 8) },
          { type: 'chow', kinds: [9, 10, 11], jokers: 0, natural: S(9, 10, 11) },
          { type: 'chow', kinds: [12, 13, 14], jokers: 0, natural: S(12, 13, 14) },
          { type: 'pair', kinds: [26], jokers: 1, natural: S(26) },
        ],
        meta: { su: false, hunDiao: true, shuangHun: false, winGroupIdx: 4 },
        payments: [8, -4, -2, -2], kong: [0, 0, 0, 0], kongPts: [0, 0, 0, 0],
      };
      app.showResult();
    },
    // visual/e2e check: fill four 圈 then open the 一锅最终成绩 board (human = 🥇).
    debugFinal: () => {
      app.session.rounds = [
        { wind: 0, scores: [6, -2, -2, -2] },
        { wind: 1, scores: [3, 1, -1, -3] },
        { wind: 2, scores: [9, -1, -3, -5] },
        { wind: 3, scores: [12, -3, -4, -5] },
      ];
      app.game.scores = app.session.rounds[3].scores.slice();
      app.showFinalBoard();
    },
    // e2e: deal a real hand with the human 拉庄 vs 庄 = 下家(1) (exercises the backend 拉庄 flow).
    dealLz: () => { app.lzTestChoice = true; app.session.dealer = 1; app.startHand(); },
    // e2e: append the live game's scores to 历史战绩 (the 锅-completion record path).
    recordMatch: () => app.recordMatchHistory(),
    // e2e/visual: the 拉庄 confirmation panel (records the click on window.__lz).
    debugLzPanel: () => app.showLaZhuangPanel(1, [HUMAN], {}, (yes) => { window.__lz = yes; }),
    // visual/e2e: a 拉庄 win — human (0) 拉庄 vs 庄 = 下家(1); the 下家 row carries 庄x2 +
    // 拉庄x2 (12 = 2×4) and the human's plate/scoreboard show ⚔️.
    debugLzWin: () => {
      app.game.wilds = [0, 1]; app.game.wildSet = new Set([0, 1]);
      app.game.laZhuang = [HUMAN]; app.game.dealer = 1;
      app.game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 0];
      app.game.melds[HUMAN] = [];
      app.game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      app.game.result = {
        type: 'win', winner: HUMAN, score: 2, fans: ['混吊'], winningTile: 26,
        decomp: [
          { type: 'chow', kinds: [3, 4, 5], jokers: 0, natural: S(3, 4, 5) },
          { type: 'chow', kinds: [6, 7, 8], jokers: 0, natural: S(6, 7, 8) },
          { type: 'chow', kinds: [9, 10, 11], jokers: 0, natural: S(9, 10, 11) },
          { type: 'chow', kinds: [12, 13, 14], jokers: 0, natural: S(12, 13, 14) },
          { type: 'pair', kinds: [26], jokers: 1, natural: S(26) },
        ],
        meta: { su: false, hunDiao: true, shuangHun: false, winGroupIdx: 4 },
        payments: [12, -8, -2, -2], kong: [0, 0, 0, 0], kongPts: [0, 0, 0, 0],
      };
      app.showResult();
    },
    // e2e/visual: a 拉庄 win where BOTH the human and the 庄(下家) hold a 金杠 of the same
    // value. Against the 庄 the two 杠分 net to zero — the breakdown must still show the gain
    // (金杠 +16) and the loss (下家金杠 −16) as separate lines, not a vanished net.
    debugKongSplit: () => {
      app.game.wilds = [0, 1]; app.game.wildSet = new Set([0, 1]);
      app.game.laZhuang = [HUMAN]; app.game.dealer = 1;
      app.game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 0];
      app.game.melds[HUMAN] = [{ type: 'kong', kind: 0, tiles: [0, 0, 0, 0], concealed: true }]; // 金杠 (wild)
      app.game.melds[1] = [{ type: 'kong', kind: 1, tiles: [1, 1, 1, 1], concealed: true }];      // 庄 also 金杠
      app.game.melds[2] = []; app.game.melds[3] = [];
      app.game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      app.game.result = {
        type: 'win', winner: HUMAN, score: 2, fans: ['混吊'], winningTile: 26,
        decomp: [
          { type: 'chow', kinds: [3, 4, 5], jokers: 0, natural: S(3, 4, 5) },
          { type: 'chow', kinds: [6, 7, 8], jokers: 0, natural: S(6, 7, 8) },
          { type: 'chow', kinds: [9, 10, 11], jokers: 0, natural: S(9, 10, 11) },
          { type: 'chow', kinds: [12, 13, 14], jokers: 0, natural: S(12, 13, 14) },
          { type: 'pair', kinds: [26], jokers: 1, natural: S(26) },
        ],
        meta: { su: false, hunDiao: true, shuangHun: false, winGroupIdx: 4 },
        payments: [20, 8, -14, -14], kong: [8, 16, -12, -12], kongPts: [4, 4, 0, 0],
      };
      app.showResult();
    },
    // e2e/visual: a 混吊 self-draw — the winning tile is itself a 混儿 closing the 将 (a pair
    // of two 混儿). The highlight must land on a 混 IN THE PAIR (the group the engine flags via
    // winGroupIdx), not on a 混 used inside an earlier meld.
    debugHunDiao: () => {
      app.game.wilds = [0, 1]; app.game.wildSet = new Set([0, 1]);
      app.game.laZhuang = []; app.game.dealer = 0;
      // 3 natural chows + a chow that consumes a 混 (id 0) + the 将 of two 混儿 (ids 0,0).
      app.game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 12, 13, 14, 0, 16, 17, 0, 0];
      app.game.melds[HUMAN] = []; app.game.melds[1] = []; app.game.melds[2] = []; app.game.melds[3] = [];
      app.game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      app.game.result = {
        type: 'win', winner: HUMAN, score: 2, fans: ['混吊'], winningTile: 0, // 和的这张是混儿
        decomp: [
          { type: 'chow', kinds: [3, 4, 5], jokers: 0, natural: S(3, 4, 5) },
          { type: 'chow', kinds: [6, 7, 8], jokers: 0, natural: S(6, 7, 8) },
          { type: 'chow', kinds: [12, 13, 14], jokers: 0, natural: S(12, 13, 14) },
          { type: 'chow', kinds: [15, 16, 17], jokers: 1, natural: S(16, 17) }, // 15 filled by a 混
          { type: 'pair', kinds: [], jokers: 2, natural: S() },                  // 将 = 两张混儿 (混吊)
        ],
        meta: { su: false, hunDiao: true, shuangHun: false, winGroupIdx: 4 },
        payments: [6, -2, -2, -2], kong: [0, 0, 0, 0], kongPts: [0, 0, 0, 0],
      };
      app.showResult();
    },
  };
}
