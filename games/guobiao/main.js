// 国标麻将 — UI glue. Reuses the mahjong rendering (scene.js), audio (sound.js)
// and hand-order (handorder.js) layers; brings its own rules engine + AI and the
// claim-queue orchestration (胡 > 碰/杠 > 吃 priority, win off discards, 听).
import { PHASE, tileName, MIN_FAN } from './engine.js';
import { LEVELS, LEVEL_NAMES } from './ai.js';
import { createBackend } from './backend.js';
import { MahjongScene } from '../mahjong-tianjin/scene.js';
import { MahjongScene2D } from '../mahjong-tianjin/scene2d.js';
import { Sound } from '../mahjong-tianjin/sound.js';
import { buildOrder } from '../mahjong-tianjin/handorder.js';
import { $, faceTileEl, mkBtn, makeToast, bindKeys, startGamepad, forceLandscape, renderSeatHands } from '../mahjong-tianjin/ui-util.js';

const sound = new Sound();
const toast = makeToast();
const HUMAN = 0;
const SEAT_LABEL = ['玩家', '下家', '对家', '上家'];
const WIND = ['东', '南', '西', '北'];
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
const ONLINE_URL = new URLSearchParams(location.search).get('server') ||
  ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? `ws://${location.hostname}:8090` : 'wss://mahjongonline-fhc2e9hcfuafdgh0.canadacentral-01.azurewebsites.net');
let onlineReadied = false, onlineEndsPot = false;

// Online turn countdown (国标 / 无定番) — same as 天津: drives the shared scene timer (the 3D ring on
// the felt, or the flat 2D #turn-timer ring) whenever a player is on the server's clock.
let ttHandle = null, ttDeadline = 0, ttTotal = 30000, ttWaiting = false;
function drawTurnTimer() {
  if (!ttWaiting) {
    if (ttHandle) { clearInterval(ttHandle); ttHandle = null; }
    if (scene && scene.setTurnTimer) scene.setTurnTimer({ show: false });
    return;
  }
  const left = Math.max(0, ttDeadline - Date.now());
  if (scene && scene.setTurnTimer) scene.setTurnTimer({ show: true, secs: Math.round(left / 1000), frac: ttTotal > 0 ? Math.min(1, left / ttTotal) : 0, low: left <= 5000 });
}
function syncTurnTimer(ev) {
  if (ev.type === 'await') { // a human is on the clock
    ttWaiting = true;
    ttDeadline = Date.now() + (+ev.timeout > 0 ? +ev.timeout : 30000);
    ttTotal = +ev.total || +ev.timeout || 30000;
    if (!ttHandle) ttHandle = setInterval(drawTurnTimer, 100);
  } else ttWaiting = false; // bot's turn / 下一局 / between hands → no clock
  drawTurnTimer();
}
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
if (FLAT) document.body.classList.add('flat');
const Renderer = FLAT ? MahjongScene2D : MahjongScene;

// `game` is the READ-ONLY GameView the backend hands back (see backend.js) — the UI renders it but
// never mutates it; every move goes through `backend` (local engine+AI today, the remote server when
// online). `backend` is created via the factory and driven through events.
let game = null, backend = null, scene = null, level = LEVELS.NORMAL;
let session = loadSession();
let selIndex = 0, focusIndex = 0, lastLogLen = 0, gameStarted = false;
let dealing = false;           // the initial-deal animation is running (input is held)
let animating = false;         // a bot's discard fly is playing — tick + input are held
let fastMode = localStorage.getItem(CFG.sessionKey + '-fast') !== '0'; // checked (on) by default
let lockedTing = false, tingWaits = []; // once 听, the seat auto-plays (tsumogiri)
let tsumogiriPending = false; // the next human discard event is a 听 auto-draw-discard → reveal deck→pool
let tingRevealIdx = -1;        // discardLog index of a 听 tsumogiri to reveal deck→center→pool
let isPortrait = false;        // device held portrait → page force-rotated to landscape

forceLandscape((p) => { isPortrait = p; if (scene) { scene.setRotated(p); scene.resize(); } });

function loadSession() {
  try { const s = JSON.parse(localStorage.getItem(CFG.sessionKey + '-session')); if (s && Array.isArray(s.scores)) return s; } catch {}
  return { scores: [0, 0, 0, 0], dealer: 0, roundWind: 0, hand: 1 };
}
function saveSession() {
  session.scores = game ? game.scores.slice() : session.scores;
  localStorage.setItem(CFG.sessionKey + '-session', JSON.stringify(session));
  localStorage.setItem(CFG.sessionKey + '-level', String(level));
}
{ const lv = parseInt(localStorage.getItem(CFG.sessionKey + '-level'), 10); if (lv >= 1 && lv <= 3) level = lv; }

// ---- hand order (no wilds → just sorted; scene.js flanks the drawn tile) ----
const noWild = () => false;
function renderedHand() { return buildOrder(game.hands[HUMAN], noWild); }
function selectableHandIndices() { return renderedHand().map((_, i) => i); }

// ---- rendering ----
// The HTML HUD (header / scores / nameplates), split out so the deal animation
// can show it without driving the 3D table.
function renderHud() {
  const minTxt = CFG.minFan > 0 ? `起和 ${CFG.minFan}番` : '无定番';
  // Online the server owns the match (no local session) — read the 圈 from the view; offline use the session.
  const roundWind = (ONLINE && game) ? (game.roundWind || 0) : session.roundWind;
  $('round-info').innerHTML = `<b>${WIND[roundWind]}圈</b> · ${ONLINE ? '联机' : `第 ${session.hand} 局 · 难度 <b>${LEVEL_NAMES[level]}</b>`} · ${minTxt}`;
  renderScores();
  $('wall-count').textContent = `余 ${game.wall.length} 张`;
  for (let p = 0; p < 4; p++) renderPlate(p);
}

// Top-right scoreboard: a cross mirroring the table (对家 top, 上家 left, 下家 right,
// 玩家 bottom). 庄 gets 👑; score green/red, no + on positives.
const SCORE_GRID = { 0: [3, 2], 1: [2, 3], 2: [1, 2], 3: [2, 1] };
function renderScores() {
  const el = $('scores'); el.innerHTML = '';
  for (let p = 0; p < 4; p++) {
    const pts = game.scores[p];
    const color = pts > 0 ? '#7ddf8a' : pts < 0 ? '#ef9a9a' : '#cfe7db';
    const [row, col] = SCORE_GRID[p];
    const cell = document.createElement('div');
    cell.className = 'sb-seat' + (p === HUMAN ? ' me' : '');
    cell.style.gridRow = row; cell.style.gridColumn = col;
    cell.innerHTML = `<span class="sb-name">${p === game.dealer ? '👑' : ''}${SEAT_LABEL[p]}</span>` +
      `<span class="sb-pt" style="color:${color}">${pts}</span>`;
    el.appendChild(cell);
  }
}

function render() {
  renderHud();
  const selectable = selectableHandIndices();
  if (selIndex >= selectable.length) selIndex = Math.max(0, selectable.length - 1);
  const myTurn = game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD;
  const showSel = myTurn && !lockedTing; // no manual selection once 听
  // Reveal the drawn tile into the hand when it's a live turn, or — in 听 — only
  // when it WINS (it then stays for the 胡 confirmation). A non-winning 听 draw is
  // never shown in the hand; it reveals straight into the pool (see tick()).
  const tingWin = lockedTing && myTurn && game.selfDrawWin;
  const revealing = scene && scene.handDrawRevealing; // drawn tile still flying in → no selection yet
  // While a bot's discard fly is playing, hold the human's turn: the turn may have
  // advanced (the human drew), but we don't reveal that draw or allow selection yet —
  // show the pre-draw 13 tiles; the reveal plays when the tick resumes.
  const mtSel = showSel && !animating;
  let handForSync = renderedHand();
  // Only when it's the HUMAN's turn has the human drawn — drop that one drawn tile so
  // its reveal waits for the bot's discard fly. (game.drawnTile is a KIND; without the
  // myTurn guard a bot drawing a kind the human holds would wrongly trim a held tile.)
  if (animating && myTurn && game.drawnTile != null) {
    const di = handForSync.lastIndexOf(game.drawnTile);
    if (di >= 0) handForSync = handForSync.slice(0, di).concat(handForSync.slice(di + 1));
  }
  if (scene) scene.sync(game, { renderedHand: handForSync, myTurn: mtSel, selRendered: mtSel && !revealing ? selectable[selIndex] : null, claimable: !animating && isClaimPhase() && !lockedTing,
    drawnTile: (!animating && (showSel || tingWin) && game.drawnTile != null) ? game.drawnTile : null,
    tingFlat: lockedTing, tingRevealDiscardIdx: tingRevealIdx, reveal: game.phase === PHASE.OVER });
  renderActions();
  positionClaimUI();
  positionTingBanner();
  flushLog();
}

// Pin the claim buttons (胡/碰/杠/吃/过) under the big pending tile (front-center).
// The 打出 button stays in the bottom bar; 打出并听牌 floats at screen center (CSS).
function positionClaimUI() {
  const hud = $('action-hud');
  if (scene && !animating && isClaimPhase() && !lockedTing) {
    // Anchor the buttons' BOTTOM just above the hand row so the 吃/碰 prompt never
    // covers the hand, in any aspect/orientation.
    const a = scene.worldToScreen(0, 0, 5.0);
    hud.classList.add('claim');
    hud.style.left = a.x + 'px'; hud.style.top = a.y + 'px';
    hud.style.bottom = 'auto'; hud.style.transform = 'translate(-50%, -100%)';
  } else {
    hud.classList.remove('claim');
    hud.style.left = hud.style.top = hud.style.bottom = hud.style.transform = '';
  }
}

// The 听 waits disclaimer floats big, just above the (flat) hand row — anchored to
// a world point in front of the player's tiles so it tracks the table in any aspect.
function positionTingBanner() {
  const b = $('ting-banner');
  if (scene && lockedTing && b.textContent) {
    const a = scene.worldToScreen(0, 0, 6.0); // a touch toward centre from the hand row
    b.classList.add('show');
    b.style.left = a.x + 'px'; b.style.top = a.y + 'px';
  } else {
    b.classList.remove('show');
  }
}

// Seat label: online shows the real player name (机器人 for a bot seat); offline the relation label.
// Names are sanitized server-side to CJK/letters only, so they're safe to interpolate.
function plateName(p) {
  if (ONLINE && game.seatNames) return game.seatNames[p] || (game.seatKinds && game.seatKinds[p] === 'bot' ? '机器人' : SEAT_LABEL[p]);
  return SEAT_LABEL[p];
}
function renderPlate(p) {
  const seat = $('plate-' + p);
  const thinking = game.phase !== PHASE.OVER && game.turn === p && p !== HUMAN;
  const listen = p === HUMAN && (lockedTing || game.tenpaiInfo(p).tenpai);
  seat.innerHTML =
    `<div class="nameplate${game.turn === p && game.phase !== PHASE.OVER ? ' active' : ''}">` +
    `<span class="wind">${WIND[game.seatWind(p)]}</span><span>${plateName(p)}</span>` +
    (p === game.dealer ? '<span class="dealer-dot" title="庄"></span>' : '') +
    (listen ? '<span class="listen">听</span>' : '') +
    (thinking ? '<span class="think">思考中…</span>' : '') + `</div>`;
}

// Which distinct discards leave the human 听 (ready), with their waits. Cached
// per hand so it isn't recomputed on every cursor move.
let _tingSig = '', _ting = [];
function tingDiscards() {
  const hand = game.hands[HUMAN];
  const sig = hand.slice().sort((a, b) => a - b).join(',');
  if (sig === _tingSig) return _ting;
  _tingSig = sig; _ting = [];
  for (const k of new Set(hand)) {
    const rest = hand.slice(); rest.splice(rest.indexOf(k), 1);
    const waits = game.handWaits(rest, HUMAN);
    if (waits.length) _ting.push({ kind: k, waits });
  }
  return _ting;
}

function renderActions() {
  const bar = $('action-bar'); bar.innerHTML = '';
  const center = $('ting-center'); center.innerHTML = ''; // 打出并听牌 / 胡 float here
  const hint = $('hand-hint'); hint.textContent = '';
  const banner = $('ting-banner'); banner.textContent = ''; // 听 waits, floats above the hand
  const buttons = [];

  if (lockedTing) {
    // already 听 — autopilot. A winning self-draw pauses it for the pending 胡
    // (shown alone); otherwise the waits disclaimer floats big just above the hand.
    if (game.selfDrawWin) {
      const w = game.selfDrawWin;
      center.appendChild(mkBtn(`胡 · ${w.fans[0].name} · ${w.fan}番`, () => doDeclareWin(), false, 'hu'));
    } else {
      banner.textContent = `已听 · 自动出牌（等 ${tingWaits.map(tileName).join(' ')}）`;
    }
  } else if (animating) {
    // a bot's discard fly is playing — hold all action UI (the 听 banner above still
    // shows via the lockedTing branch when applicable)
  } else if (game.phase === PHASE.AWAIT_CLAIM && game.currentClaim() && game.currentClaim().player === HUMAN) {
    const c = game.currentClaim();
    // 点炮 win — a confirm: take it (胡, showing pattern + score) or 过 to play on.
    // The 胡 floats big + centered (like 打出并听牌); 过 stays in the bottom bar.
    if (c.type === 'win') { center.appendChild(mkBtn(`胡 · ${c.result.fans[0].name} · ${c.result.fan}番`, () => doClaimTake(), false, 'hu')); }
    else if (c.type === 'pung') buttons.push(mkBtn('碰', () => doClaimTake()));
    else if (c.type === 'kong') buttons.push(mkBtn('杠', () => doClaimTake()));
    else if (c.type === 'chow') {
      c.options.forEach((opt) => buttons.push(mkChowBtn(opt, game.lastDiscard.kind)));
    }
    buttons.push(mkBtn('过', () => doClaimPass(), true));
    hint.textContent = `${SEAT_LABEL[game.lastDiscard.player]} 打出 ${tileName(game.lastDiscard.kind)}`;
  } else if (game.phase === PHASE.AWAIT_DISCARD && game.turn === HUMAN) {
    if (game.selfDrawWin) { // self-draw win available — offer 胡 (you may still play on)
      const w = game.selfDrawWin;
      center.appendChild(mkBtn(`胡 · ${w.fans[0].name} · ${w.fan}番`, () => doDeclareWin(), false, 'hu')); // big + centered, like 打出并听牌
    }
    for (const k of game.selfKongOptions(HUMAN)) buttons.push(mkBtn(`杠 ${tileName(k.kind)}`, () => doSelfKong(k.kind), true));
    // If the selected discard would leave a ready hand, present 打出并听牌 (declare
    // 听, red) at screen center with the plain 打出 to its right; otherwise 打出
    // stays in the bottom bar. No text disclaimer — the red button is the 听 signal.
    const sel = renderedHand()[selectableHandIndices()[selIndex]];
    if (tingDiscards().some((t) => t.kind === sel)) {
      center.appendChild(mkBtn('打出并听牌', () => discardSelected(true), false, 'riichi'));
    }
    // plain discard has no button — tap the selected tile / A / controller-A
  }
  if (focusIndex >= buttons.length) focusIndex = buttons.length - 1;
  buttons.forEach((b, i) => { if (i === focusIndex && isClaimPhase()) b.classList.add('focus'); bar.appendChild(b); });
}
// A 吃 option rendered as the actual 3-tile run (faces), with a red ▼ over the
// claimed tile, as one big button. `opt` is the two hand tiles; `claimed` is the
// discard being chowed.
function mkChowBtn(opt, claimed) {
  const b = document.createElement('button'); b.className = 'act-btn chow-btn';
  for (const t of [opt[0], opt[1], claimed].sort((a, b) => a - b)) {
    const cell = document.createElement('div');
    cell.className = 'chow-cell' + (t === claimed ? ' claimed' : '');
    cell.appendChild(faceTileEl(t, { lg: true }));
    b.appendChild(cell);
  }
  b.addEventListener('click', () => doClaimTake(opt));
  return b;
}
function isClaimPhase() { return game.phase === PHASE.AWAIT_CLAIM && game.currentClaim() && game.currentClaim().player === HUMAN; }

function flushLog() {
  for (let i = lastLogLen; i < game.log.length; i++) {
    const line = game.log[i];
    // log lines start with the seat's WIND (东/南/西/北) — map it back to the seat so
    // the call is spoken in that seat's voice.
    const tok = line.split(' ')[0];
    let seat = 0; for (let p = 0; p < 4; p++) if (WIND[game.seatWind(p)] === tok) { seat = p; break; }
    if (/自摸|和牌/.test(line)) { toast(line, true); (game.result && game.result.winner === HUMAN ? sound.win() : sound.lose()); }
    else if (/荒牌/.test(line)) { toast(line, true); sound.drawGame(); }
    else if (/杠/.test(line)) { toast(line, false); sound.kong(); sound.voice('kong', seat); }
    else if (/碰/.test(line)) { toast(line, false); sound.pung(); sound.voice('pung', seat); }
    else if (/吃/.test(line)) { toast(line, false); sound.select(); sound.voice('chow', seat); }
  }
  lastLogLen = game.log.length;
}

// ---- orchestration (backend-driven) ----
// The backend pushes one event per move; this async handler is the whole UI-side orchestration
// (it replaced the old synchronous tick() loop). Each case renders + plays the matching
// animation/sound and AWAITS it, so the backend (local sim or remote server) is held until the
// table catches up before the next event. The 吃/碰/杠/和 toasts + voices ride the engine log and
// flush inside render(), so most cases just call render().
async function onBackendEvent(ev) {
  if (ev.type === 'disconnected') { showReconnecting(); return; } // lost the server → banner, then bail to lobby
  if (ev.type === 'gameGone') { returnHub(); return; }            // server has no game for us → lobby
  if (ONLINE) hideReconnecting();                                 // any real frame means we're connected again
  const st = backend.getState();
  if (st) game = st;
  if (ONLINE) syncTurnTimer(ev); // show the countdown whenever a player is on the clock (no-op offline)
  switch (ev.type) {
    case 'deal':
      $('result-overlay').classList.add('hidden'); // the next hand is dealing → hide the result panel
      selIndex = 0; focusIndex = 0; lockedTing = false; tingWaits = []; lastLogLen = 0;
      sound.stopMusic();
      if (!ONLINE) saveSession();
      if (scene && !FAST) { // serve the tiles from the wall, then play
        dealing = true;
        renderHud();
        $('action-bar').innerHTML = ''; $('ting-center').innerHTML = '';
        $('hand-hint').textContent = '发牌中…';
        await new Promise((res) => scene.beginDeal(game, res, () => sound.select()));
        dealing = false;
      }
      render();
      if (ONLINE && backend.dealDone) backend.dealDone(); // table's dealt → let the server start the opponents
      return;

    case 'discard': {
      const human = ev.player === HUMAN;
      sound.discard();
      // 听 tsumogiri (an AUTO draw-discard, never shown in the hand) → reveal it deck→center→pool.
      // The manually-declared 听 discard (报听) is a normal hand discard, so it animates below.
      if (human && tsumogiriPending) {
        tsumogiriPending = false;
        if (!fastMode) sound.say(tileName(ev.tile), HUMAN);
        tingRevealIdx = ev.discardIndex; render(); tingRevealIdx = -1;
        return;
      }
      if (human) selIndex = Math.min(selIndex, selectableHandIndices().length - 1);
      else if (!fastMode) sound.say(tileName(ev.tile), ev.player); // bot speaks its discard
      if (scene && !FAST && !fastMode) { // fly to the center halt, hold, drop into the pool
        if (human) sound.say(tileName(ev.tile), HUMAN);
        animating = true;
        try {
          scene.beginDiscardDemo(ev.player, ev.discardIndex, DISCARD_DEMO_MS);
          render();
          await delay(DISCARD_DEMO_MS + DISCARD_SETTLE_MS);
        } finally { animating = false; }
      }
      render();
      return;
    }

    case 'claim':
      if (ev.player === HUMAN) { selIndex = 0; } // then they discard
      else if (scene && !FAST) { // show the bot's 吃/碰/杠 lifted, hold until it settles
        scene.beginClaimDemo(ev.player, CLAIM_DEMO_MS);
        render();
        await delay(CLAIM_DEMO_MS + CLAIM_SETTLE_MS);
      }
      render();
      return;

    case 'selfKong':
      render(); // the 杠 toast + voice flush from the engine log
      return;

    case 'await': // the human must act: a claimable discard, or their own turn
      if (ev.who === 'claim') {
        // Once 听, the seat is on autopilot: take a 胡, pass everything else.
        if (lockedTing) { const c = game.currentClaim(); if (c && c.type === 'win') backend.claim('win'); else backend.pass(); return; }
        focusIndex = 0; render();
        return;
      }
      // who === 'discard'. 听: a non-winning draw is tsumogiri'd automatically (never shown);
      // a winning draw pauses for the centered 胡 confirmation.
      if (lockedTing && !game.selfDrawWin) { tsumogiriPending = true; backend.discard(game.drawnTile); return; }
      ensureSelection(); render();
      return;

    case 'over':
      render(); // flush the 自摸 / 点炮 / 荒牌 toast + win/lose sound from the log
      onlineEndsPot = ONLINE && !!ev.potEnd; // set BEFORE showResult so it picks the right button label
      showResult();
      if (ev.readied) { // resync after a refresh: reflect a choice we'd already made
        const b = $('next-hand-btn');
        if (onlineEndsPot) { b.disabled = true; b.textContent = '结算中…'; }
        else { onlineReadied = true; b.textContent = '✓ 已准备 · 取消'; b.classList.add('readied'); }
      }
      return;

    // ---- online only ----
    case 'sync': // (re)joined a game in progress, or reconnected — render the current state
      lastLogLen = game.log ? game.log.length : 0; // online views carry no log; suppress toasts
      ensureSelection(); render();
      return;
    case 'potOver': // server finished the 锅 → final standings
      $('result-overlay').classList.add('hidden');
      showFinalBoard({ scores: ev.scores, rounds: ev.rounds });
      return;
  }
}

function ensureSelection() {
  const sel = selectableHandIndices();
  if (selIndex >= sel.length) selIndex = sel.length - 1;
  if (selIndex < 0) selIndex = 0;
}

// ---- human actions ----
function onPickTile(idx) {
  if (dealing || animating) return;
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || lockedTing) return;
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  const id = renderedHand()[idx];
  if (id == null) return;
  const pos = selectableHandIndices().indexOf(idx);
  if (pos < 0) return;
  if (pos === selIndex) discardSelected();
  else { selIndex = pos; sound.select(); render(); }
}
// declare=true → 打出并听牌: discard the selected tile AND lock 听 (报听). From
// then on the seat auto-plays. declare=false → a plain discard with no lock.
function discardSelected(declare) {
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || lockedTing) return;
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  const id = renderedHand()[selectableHandIndices()[selIndex]];
  if (id == null) return;
  if (declare) { // 报听: lock 听 + start music NOW (synchronously) before handing off to the backend
    const rest = game.hands[HUMAN].slice(); rest.splice(rest.indexOf(id), 1);
    const waits = game.handWaits(rest, HUMAN);
    if (waits.length) { lockedTing = true; tingWaits = waits; toast('听！自动出牌', true); sound.startMusic(); } // else not actually 听 → plain discard
  }
  selIndex = Math.min(selIndex, Math.max(0, selectableHandIndices().length - 1));
  backend.discard(id); // the 'discard' event animates it, then the backend drives the bots
}
function doDeclareWin() { if (scene && scene.handDrawRevealing) return; backend.declareWin(); }
function doSelfKong(kind) { if (scene && scene.handDrawRevealing) return; if (game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD) backend.selfKong(kind); }
// When the freshly-drawn tile finishes its reveal, auto-select it (ready to discard).
function selectDrawnTile() {
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || lockedTing || game.drawnTile == null) return;
  const si = selectableHandIndices().indexOf(renderedHand().lastIndexOf(game.drawnTile));
  if (si >= 0) selIndex = si;
  render();
}
// Take the head claim (碰/杠/吃, or a 点炮 win) — `opt` is the chosen 吃 run; 过 declines it.
function doClaimTake(opt) { if (isClaimPhase()) { selIndex = 0; backend.claim(game.currentClaim().type, opt); } }
function doClaimPass() { if (isClaimPhase()) backend.pass(); }

// ---- result / new hand ----
// 得分明细 for the result panel: every seat's net (本局得分) laid out as a 3×3 grid
// mirroring the table (对家 top, 上家 left, 下家 right, 玩家 bottom), then the human's net vs
// each opponent with the reason (自摸 / 点炮 / 底) as a subitem. Mirrors 天津's layout.
function breakdownHtml(r) {
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
  const discarder = (r.byDiscard && game.lastDiscard) ? game.lastDiscard.player : -1;
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
  return `<div class="bd-title">本局得分</div><div class="bd-all">${all}</div>` +
    `<div class="bd-title">玩家明细 · <span style="letter-spacing:normal;font-size:1.05rem;font-weight:800;color:${col(total)}">${sgn(total)}</span></div>` +
    grps.join('');
}

function showResult() {
  const r = game.result, ov = $('result-overlay');
  const fansEl = $('result-fans'), scoreEl = $('result-score'), handEl = $('result-hand'), payEl = $('result-payments');
  const winEl = $('result-winning');
  $('ting-center').innerHTML = ''; // clear any floating 打出并听牌 before the modal
  fansEl.innerHTML = ''; handEl.innerHTML = ''; winEl.innerHTML = ''; winEl.classList.remove('show');
  if (r.type === 'draw') {
    $('result-title').textContent = '荒牌 · 流局'; scoreEl.textContent = ''; payEl.textContent = '本局无人和牌';
  } else {
    const w = r.winner;
    $('result-title').textContent = `${SEAT_LABEL[w]}（${WIND[game.seatWind(w)]}）${r.byDiscard ? '和牌' : '自摸'}！`;
    for (const f of r.fans) { const c = document.createElement('span'); c.className = 'fan-chip'; c.textContent = `${f.name} ${f.points}`; fansEl.appendChild(c); }
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
      const hand = game.hands[w].slice();
      if (r.byDiscard && r.winningTile != null) hand.push(r.winningTile);
      addGroup(hand, ' span');
    }
    payEl.innerHTML = breakdownHtml(r);
  }
  renderSeatHands(game); // reveal every seat's hand on its border
  sound.stopMusic(); // 听 (if any) is over
  if (!ONLINE) saveSession();
  // Online: 下一局 becomes a readiness toggle (我准备好了); the final hand of a 锅 ENDS it.
  const nb = $('next-hand-btn'); nb.disabled = false; nb.classList.remove('readied'); onlineReadied = false;
  nb.textContent = onlineEndsPot ? '结束并查看总成绩 🏆' : (ONLINE ? '我准备好了' : '下一局');
  ov.classList.remove('hidden');
  resultFocus = 0; focusResultBtn(); // 下一局 focused by default
}
function nextHand() {
  if (VIEWER) return; // a spectator can't ready up — the next hand deals when the real players are ready
  if (ONLINE) {
    if (onlineEndsPot) { backend.next(); const b = $('next-hand-btn'); b.disabled = true; b.textContent = '结算中…'; return; }
    onlineReadied = !onlineReadied; // toggle readiness; the server deals once EVERY human is ready
    const b = $('next-hand-btn');
    if (onlineReadied) { backend.next(); b.textContent = '✓ 已准备 · 取消'; b.classList.add('readied'); }
    else { backend.unready(); b.textContent = '我准备好了'; b.classList.remove('readied'); }
    return;
  }
  $('result-overlay').classList.add('hidden');
  const nd = game.nextDealer();
  session.hand += 1;
  if (nd === 0 && game.dealer !== 0) session.roundWind = (session.roundWind + 1) % 4;
  session.dealer = nd;
  startHand();
}
// Online: connect to the server's table (or spectate a seat). The server is the ground truth — it
// deals, drives opponents, and PUSHES frames into onBackendEvent; no local session/锅 bookkeeping.
function connectOnline() {
  if (!scene) { scene = new Renderer($('scene')); scene.setRotated(isPortrait); scene.resize(); scene.onHandDrawSettled = selectDrawnTile; }
  backend = createBackend({ mode: 'remote', url: ONLINE_URL, uid: localStorage.getItem('mahjong-online-uid') || '', name: localStorage.getItem('mahjong-online-name') || '',
    spectate: VIEWER ? { table: VIEWER_TABLE, seat: VIEWER_SEAT } : null });
  backend.onEvent(onBackendEvent);
  backend.connect();
}

// ---- online: lost-connection banner (auto-returns to the lobby if it can't get back) ----
let reconnectTimer = null;
function showReconnecting() {
  const el = $('reconnect-overlay'); if (el) el.classList.remove('hidden');
  if (!reconnectTimer) reconnectTimer = setTimeout(returnHub, 8000);
}
function hideReconnecting() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const el = $('reconnect-overlay'); if (el) el.classList.add('hidden');
}

// 一锅结束 · 最终成绩 (online only — the server owns the 锅). data: { scores, rounds }.
function showFinalBoard(data) {
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
  $('final-congrats').textContent = scores[HUMAN] === top ? (tiedTop ? '🎉 恭喜并列第一！' : '🎉 恭喜你赢得这一锅！') : '本锅惜败，下一锅再战！';
  $('final-rounds').innerHTML = roundsTableHtml(data.rounds || []);
  $('final-overlay').classList.remove('hidden');
}
// 每圈成绩 table from the 锅's completed-圈 snapshots (cumulative scores per 圈).
function roundsTableHtml(rounds) {
  const seats = [0, 1, 2, 3];
  const cell = (v) => `<td class="${v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'}">${v > 0 ? '+' : ''}${v}</td>`;
  let prev = [0, 0, 0, 0], body = '';
  for (const r of rounds) { body += `<tr><td class="rd-wind">${WIND[r.wind]}圈</td>${seats.map((p) => cell(r.scores[p] - prev[p])).join('')}</tr>`; prev = r.scores; }
  if (!body) body = `<tr><td class="rd-empty" colspan="5">本锅还没有完成的圈</td></tr>`;
  const total = rounds.length ? rounds[rounds.length - 1].scores : [0, 0, 0, 0];
  const head = `<tr><th></th>${seats.map((p) => `<th class="${p === HUMAN ? 'me' : ''}">${SEAT_LABEL[p]}</th>`).join('')}</tr>`;
  const foot = `<tr><td class="rd-wind">合计</td>${seats.map((p) => cell(total[p])).join('')}</tr>`;
  return `<table class="rounds-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}
function startHand() {
  if (!scene) { scene = new Renderer($('scene')); scene.setRotated(isPortrait); scene.resize(); scene.onHandDrawSettled = selectDrawnTile; }
  if (!backend) { backend = createBackend({ mode: 'local', rng: Math.random, thinkDelay: AI_DELAY }); backend.onEvent(onBackendEvent); }
  selIndex = 0; focusIndex = 0; lockedTing = false; tingWaits = []; tsumogiriPending = false; lastLogLen = 0;
  sound.stopMusic();
  saveSession();
  // Hand off to the backend: it deals (the 'deal' event plays the serving flourish), then drives
  // the bots, pausing on an 'await' for the human. Under ?fast=1 (tests) the deal animation is skipped.
  backend.startHand({ dealer: session.dealer, roundWind: session.roundWind, scores: session.scores, minFan: CFG.minFan, level });
}
function newGame() { game = null; session = { scores: [0, 0, 0, 0], dealer: 0, roundWind: 0, hand: 1 }; startHand(); }

$('scene').addEventListener('pointerdown', (e) => {
  if (!scene || !gameStarted || dealing || animating) return;
  sound.resume();
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx != null) onPickTile(idx);
});
// PC only: hovering a hand tile selects it (same as a click-to-select). Mouse-only
// so touch is unaffected; respects the same turn/听/draw-settle guards.
$('scene').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !scene || !gameStarted || dealing || animating) return;
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || lockedTing || scene.handDrawRevealing) return;
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx == null) return;
  const pos = selectableHandIndices().indexOf(idx);
  if (pos >= 0 && pos !== selIndex) { selIndex = pos; sound.select(); render(); }
});

// ---- input dispatch (keyboard + gamepad) ----
function onAction(name) {
  if (!gameStarted) return;
  sound.resume();
  if (!$('forfeit-confirm-overlay').classList.contains('hidden')) {
    if (name === 'confirm') doForfeit();                                                     // 确认认输
    else if (name === 'cancel' || name === 'menu') $('forfeit-confirm-overlay').classList.add('hidden'); // 取消
    return;
  }
  if (!$('menu-overlay').classList.contains('hidden') || !$('rules-overlay').classList.contains('hidden') || !$('start-overlay').classList.contains('hidden')) {
    if (name === 'cancel' || name === 'menu') closeOverlays();
    return;
  }
  if (!$('result-overlay').classList.contains('hidden')) {
    if (name === 'left') { resultFocus = 1; focusResultBtn(); }      // 返回 (top-left)
    else if (name === 'right') { resultFocus = 0; focusResultBtn(); } // 下一局 (top-right)
    else if (name === 'confirm') (resultFocus === 0 ? nextHand() : returnHub());
    else if (name === 'menu') nextHand();
    return;
  }
  if (dealing || animating) return; // serving tiles / a discard fly is playing — hold input
  if (isClaimPhase()) {
    // 点炮 win: the 胡 floats centered (not in the bar), so confirm/win takes it and
    // cancel/pass declines — no bar navigation. (Pad has no 'win' key, so A=confirm.)
    if (game.currentClaim().type === 'win') {
      if (name === 'confirm' || name === 'win') doClaimTake();
      else if (name === 'cancel' || name === 'pass') doClaimPass();
      else if (name === 'menu') openMenu();
      return;
    }
    const btns = [...$('action-bar').children];
    if (name === 'left') { focusIndex = (focusIndex - 1 + btns.length) % btns.length; render(); }
    else if (name === 'right') { focusIndex = (focusIndex + 1) % btns.length; render(); }
    else if (name === 'confirm') btns[focusIndex]?.click();
    else if (name === 'cancel' || name === 'pass') doClaimPass();
    else if (name === 'menu') openMenu();
    return;
  }
  if (lockedTing && game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD && game.selfDrawWin) {
    // 听 paused for a winning self-draw: confirm/win takes the centered 胡.
    if (name === 'win' || name === 'confirm') doDeclareWin();
    else if (name === 'menu') openMenu();
    return;
  }
  if (game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD && !lockedTing) {
    const n = selectableHandIndices().length;
    if (name === 'win') doDeclareWin();
    else if (name === 'left') { selIndex = (selIndex - 1 + n) % n; sound.select(); render(); }
    else if (name === 'right') { selIndex = (selIndex + 1) % n; sound.select(); render(); }
    else if (name === 'confirm') discardSelected(false);
    else if (name === 'declare') discardSelected(true); // 打出并听牌 (falls back to plain if not 听)
    else if (name === 'kong') { const o = game.selfKongOptions(HUMAN)[0]; if (o) doSelfKong(o.kind); }
    else if (name === 'menu' || name === 'cancel') openMenu();
    return;
  }
  if (name === 'menu') openMenu();
}
bindKeys(onAction, {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'left', ArrowDown: 'right',
  Enter: 'confirm', ' ': 'confirm', Escape: 'cancel', Backspace: 'pass',
  m: 'menu', M: 'menu', g: 'kong', G: 'kong', k: 'kong', K: 'kong', t: 'declare', T: 'declare', h: 'win', H: 'win',
});
// Xbox: A=confirm B=cancel X=declare(听) Y=kong, d-pad/stick = left/right, Menu = menu.
startGamepad(onAction, { 14: 'left', 12: 'left', 15: 'right', 13: 'right', 0: 'confirm', 1: 'cancel', 2: 'declare', 3: 'kong', 9: 'menu' });

// ---- overlays + boot ----
function openMenu() { $('menu-overlay').classList.remove('hidden'); }
function closeOverlays() { for (const id of ['menu-overlay', 'rules-overlay']) $(id).classList.add('hidden'); }
function fillRules() {
  $('rules-body').innerHTML = `
    <h3>基本</h3>136 张牌（无花）。可<b>吃、碰、杠</b>；和牌可<b>自摸</b>或<b>点炮</b>（食他人打出之牌）。
    <h3>起和</h3>${CFG.minFan > 0 ? `和牌至少 <b>${CFG.minFan} 番</b>（番种总和），不足则不可和。` : '<b>无定番</b>：任意番数（含 0 番）皆可和。'}
    <h3>番种</h3>采用国标 81 番的常见番种子集：清一色24、混一色6、碰碰和6、字一色88、清/混幺九、大小三元、大小四喜、
    四/三/双暗刻、三色三同顺8、花龙8、一色三步高16、平和2、门前清/不求人、五门齐6、箭/风/幺九刻、单钓/边/坎张等。
    <h3>计分</h3>${CFG.minFan > 0
      ? `和牌得 (番 + ${CFG.minFan})；自摸三家各付，点炮则点炮者付 (番+${CFG.minFan})，余两家各付 ${CFG.minFan}。`
      : '无定番：和牌只按实际番数结算（无固定底分）；自摸三家各付 番，点炮则仅点炮者付 番。'}
    <h3>操作</h3>点牌选中、再点该牌或按 <b>A</b> 出牌（听牌时可「打出并听牌」）。轮到可<b>胡/碰/杠/吃</b>时点对应按钮，或<b>过</b>。`;
}
function bindUI() {
  $('level-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.level-btn'); if (!btn) return;
    [...$('level-row').children].forEach((c) => c.classList.remove('sel')); btn.classList.add('sel');
    level = parseInt(btn.dataset.level, 10);
  });
  [...$('level-row').children].forEach((c) => c.classList.toggle('sel', parseInt(c.dataset.level, 10) === level));
  $('start-btn').addEventListener('click', () => { $('start-overlay').classList.add('hidden'); gameStarted = true; sound.resume(); startHand(); });
  $('start-hub-link').addEventListener('click', returnHub); // difficulty screen → main hub (../../)
  $('rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
  $('menu-rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
  $('rules-close').addEventListener('click', () => $('rules-overlay').classList.add('hidden'));
  $('menu-btn').addEventListener('click', openMenu);
  const sb = $('sound-btn'); const upd = () => { sb.textContent = sound.muted ? '🔇' : '🔊'; };
  sb.addEventListener('click', () => { sound.resume(); sound.toggleMuted(); upd(); }); upd();
  const fastChk = $('fast-mode-chk');
  if (fastChk) {
    fastChk.checked = fastMode;
    fastChk.addEventListener('change', () => { fastMode = fastChk.checked; localStorage.setItem(CFG.sessionKey + '-fast', fastMode ? '1' : '0'); });
  }
  $('resume-btn').addEventListener('click', closeOverlays);
  $('newgame-btn').addEventListener('click', () => { closeOverlays(); newGame(); });
  $('next-hand-btn').addEventListener('click', nextHand);
  $('back-hub-btn').addEventListener('click', returnHub);
  $('menu-hub-btn').addEventListener('click', returnHub);
  const fh = $('final-hub-btn'); if (fh) fh.addEventListener('click', returnHub);
  $('menu-hub-btn').textContent = ONLINE ? '← 返回大厅' : '← 返回主页';
  // 认输 (forfeit) — online players only; a red two-step confirm.
  $('menu-forfeit-btn').addEventListener('click', () => { $('menu-overlay').classList.add('hidden'); $('forfeit-confirm-overlay').classList.remove('hidden'); });
  $('forfeit-confirm-yes').addEventListener('click', doForfeit);
  $('forfeit-confirm-no').addEventListener('click', () => $('forfeit-confirm-overlay').classList.add('hidden'));
  if (ONLINE) { const ng = $('newgame-btn'); if (ng) ng.style.display = 'none'; } // server owns the match online
  if (ONLINE && !VIEWER) $('menu-forfeit-btn').hidden = false; // a forfeit only makes sense for a seated online player
  fillRules();
}

// Forfeit the live game: tell the server (our seat becomes a bot; this 锅 isn't scored for us), then
// return to the lobby. The server concludes the 锅 if we were the last human.
function doForfeit() {
  $('forfeit-confirm-overlay').classList.add('hidden');
  if (backend && backend.forfeit) backend.forfeit();
  returnHub();
}

// Leave the game: offline → the main hub; online → back to the 联机 lobby (carry ?server/fast/flat).
function returnHub() {
  if (!ONLINE) { location.href = '../../'; return; }
  const params = new URLSearchParams(location.search);
  for (const k of ['online', 'viewer', 'vseat', 'vtable']) params.delete(k);
  params.set('game', CFG.sessionKey === 'guobiao-free' ? 'guobiao-free' : 'guobiao'); // return to THIS game's split lobby
  const qs = params.toString();
  location.href = '../mahjong-tianjin-online/' + (qs ? '?' + qs : '');
}

// Keyboard/gamepad focus between the result panel's two buttons (下一局 / 返回).
let resultFocus = 0;
function focusResultBtn() {
  const btns = [$('next-hand-btn'), $('back-hub-btn')];
  btns.forEach((b, i) => b && b.classList.toggle('focus', i === resultFocus));
  btns[resultFocus] && btns[resultFocus].focus();
}
bindUI();

// Online boot: no start overlay / difficulty — the lobby already started the table. Connect and let
// the server drive. (Gated on ONLINE; the offline boot via the start overlay is unchanged.)
if (ONLINE) { $('start-overlay').classList.add('hidden'); gameStarted = true; connectOnline(); }

if (new URLSearchParams(location.search).get('fast')) {
  window.__gb = {
    phase: () => game && game.phase,
    scene: () => scene,
    selInfo: () => ({ selIndex, drawn: game && game.drawnTile, selKind: renderedHand()[selectableHandIndices()[selIndex]], revealing: !!(scene && scene.handDrawRevealing) }),
    claim: () => game && game.currentClaim(),
    humanTurn: () => !!game && game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD,
    discard: () => discardSelected(false),
    locked: () => lockedTing,
    music: () => !!(sound._musicWanted || sound._musicOn),
    hint: () => $('hand-hint').textContent,
    actions: () => [...$('action-bar').children, ...$('ting-center').children].map((b) => ({ text: b.textContent, cls: b.className })),
    // Force a deterministic state where the human holds `hand13` (tenpai) plus a
    // freshly drawn `drawn` tile, so discarding `drawn` leaves a ready hand.
    forceTing: (hand13, drawn) => {
      lockedTing = false; tingWaits = []; _tingSig = '';
      game.hands[HUMAN] = hand13.concat(drawn);
      game.drawnTile = drawn; selIndex = 0; render();
      if (scene) scene.handDrawRevealing = false; // instant test setup — don't gate input
    },
    setLocked: (waits) => { lockedTing = true; tingWaits = waits; render(); },
    selectKind: (kind) => {
      const idxs = selectableHandIndices();
      for (let i = 0; i < idxs.length; i++) if (renderedHand()[idxs[i]] === kind) { selIndex = i; render(); return true; }
      return false;
    },
    clickAction: (text) => { const b = [...$('action-bar').children, ...$('ting-center').children].find((x) => x.textContent === text); if (b) { b.click(); return true; } return false; },
    debugChow: () => {
      game.phase = PHASE.AWAIT_CLAIM;
      game.lastDiscard = { player: 3, kind: 3 }; // 上家 discards 4万 (id 3)
      game.currentClaim = () => ({ player: HUMAN, type: 'chow', options: [[1, 2], [2, 4], [4, 5]] });
      render();
    },
    // self-draw win available → the big centered 胡 should appear (visual check).
    debugWin: () => {
      game.phase = PHASE.AWAIT_DISCARD; game.turn = HUMAN;
      game.selfDrawWin = { fan: 24, fans: [{ name: '清一色', points: 24 }] };
      render();
    },
    // 点炮 win claim → the centered 胡 (take) with 过 in the bar (visual check).
    debugWinClaim: () => {
      game.phase = PHASE.AWAIT_CLAIM;
      game.lastDiscard = { player: 3, kind: 5 };
      game.currentClaim = () => ({ player: HUMAN, type: 'win', result: { fan: 16, fans: [{ name: '混一色', points: 16 }] } });
      render();
    },
    debugResult: () => {
      game.phase = PHASE.OVER;
      game.result = { type: 'win', winner: HUMAN, fan: 24, byDiscard: false, winningTile: game.hands[HUMAN][0],
        fans: [{ name: '清一色', points: 24 }, { name: '碰碰和', points: 6 }], payments: [72, -24, -24, -24] };
      showResult();
    },
  };
}
