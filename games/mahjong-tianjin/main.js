// Tianjin mahjong — UI glue: drives the 3D scene (scene.js), the HTML HUD, input
// (touch raycast / keyboard / Xbox controller) and the turn orchestration that
// paces the AI so the human can follow along.
import { PHASE, tileName } from './engine.js';
import { LEVELS, LEVEL_NAMES } from './ai.js';
import { createBackend } from './backend.js';
import { MahjongScene } from './scene.js';
import { MahjongScene2D } from './scene2d.js';
import { Sound } from './sound.js';
import { buildOrder } from './handorder.js';
import { $, faceTileEl, mkBtn, makeToast, bindKeys, startGamepad, forceLandscape, renderSeatHands, seatBadgeHtml } from './ui-util.js';
import { BOT_NAMES } from '../mahjong-common/bot-names.js';

const sound = new Sound();
const toast = makeToast();

const HUMAN = 0;
// Relative seat names from the human's perspective (play order 0→1→2→3).
const SEAT_LABEL = ['玩家', '下家', '对家', '上家'];
const REL_LABEL = ['自己', '下家', '对家', '上家']; // online nameplate: HUMAN reads 自己, not 玩家
const WIND = ['东', '南', '西', '北'];
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
  const ua = navigator.userAgent;
  const shortSide = Math.min(screen.width, screen.height);
  return shortSide < 600 || /iPhone|iPod/.test(ua);
})();
if (FLAT) {
  document.body.classList.add('flat');
  // The 混儿 indicator floats over the 3D table; in the flat layout it belongs in
  // the left rail. main.js fills it by id, so moving the element changes nothing else.
  const wh = document.getElementById('wild-hud'), hdr = document.querySelector('header');
  if (wh && hdr) hdr.appendChild(wh);
}
const Renderer = FLAT ? MahjongScene2D : MahjongScene;
// A bot's 碰/杠 is shown lifted for CLAIM_DEMO_MS; the game logic is held until the
// meld has settled (+ CLAIM_SETTLE_MS). Both collapse to ~0 under ?fast=1 for tests.
const CLAIM_DEMO_MS = FAST ? 60 : 2000;
const CLAIM_SETTLE_MS = FAST ? 20 : 380;
// A bot's discard flies from its hand to the center halt, holds ~1s, then drops into
// the pool; the tick is locked for the whole duration. 快速模式 (fastMode) or ?fast=1
// turns the animation + lock off.
const DISCARD_DEMO_MS = 900;  // 0.4s rise + ~0.5s halt at the center
const DISCARD_SETTLE_MS = 220; // covers the ~0.18s fall into the pool
let fastMode = localStorage.getItem('mahjong-fast') !== '0'; // checked (on) by default

// Online mode: ?online=1 means this page is driven by the remote server (the lobby navigates
// here once a table starts). EVERYTHING online is gated on ONLINE; with it unset the page is
// the offline single-player game, byte-for-byte unchanged.
const ONLINE = !!new URLSearchParams(location.search).get('online');
// Viewer mode (online only): ?viewer=1&vseat=N → watch human seat N read-only. The server sends us
// that seat's frames (so the UI renders exactly as that player sees it) and ignores any action.
const VIEWER = ONLINE && !!new URLSearchParams(location.search).get('viewer');
const VIEWER_SEAT = VIEWER ? (parseInt(new URLSearchParams(location.search).get('vseat'), 10) || 0) : 0;
const ONLINE_URL = new URLSearchParams(location.search).get('server') ||
  ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? `ws://${location.hostname}:8090` : 'wss://mahjongonline-fhc2e9hcfuafdgh0.canadacentral-01.azurewebsites.net');

// `game` is the READ-ONLY GameView handed back by the backend (see backend.js) — the UI
// renders it but never mutates it; every move goes through `backend`. `backend` is the
// calculation layer (local engine+AI today, a remote server tomorrow), created via the
// factory and driven through events.
let game = null;
let backend = null;
let scene = null;             // MahjongScene (3D table)
let level = LEVELS.NORMAL;
let session = loadSession();   // { scores, dealer, prevailingWind, hand }
let selIndex = 0;              // cursor into the human's selectable (non-wild) tiles
let noSel = VIEWER;          // nothing lifted (set right after you discard; any pick/hover/turn clears it). A
                             // viewer starts with NOTHING lifted — the selection is local UI, not the watched
                             // player's, so showing a default highlight would be misleading (they can still pick).
let lzBlind = false;          // blind 拉庄: my hand is dealt but shown face-down until I answer
let lzActive = false;         // a 拉庄 modal is up (for me or others) → the 混儿 stays hidden ('new hand' hasn't begun)
let drawnWildSelected = false; // a freshly-drawn 混儿 is the lifted tile (can't discard)
let focusIndex = 0;           // cursor into action-bar buttons (claims)
let lastLogLen = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let dealing = false;          // the initial-deal animation is running (input is held)
let animating = false;        // a bot's discard fly is playing — tick + input are held
let isPortrait = false;        // device held portrait → page force-rotated to landscape

// Always render landscape; when the scene exists, keep it in sync with the rotation.
forceLandscape((p) => { isPortrait = p; if (scene) { scene.setRotated(p); scene.resize(); } });

// ---------------------------------------------------------------------------
// Persistence (lightweight prefs + running score; localStorage is fine here)
// ---------------------------------------------------------------------------
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem('mahjong-session'));
    if (s && Array.isArray(s.scores)) {
      if (!Array.isArray(s.rounds)) s.rounds = [];
      if (s.seatBase == null) s.seatBase = 0; // 座风 base (东 seat) for the 锅
      // A finished 锅 (four 圈 recorded) left unreset — e.g. closed from the 最终成绩
      // board via 返回大厅 — starts the next 锅 fresh rather than resuming the old one.
      if (s.rounds.length >= 4) return freshSession();
      return s;
    }
  } catch {}
  return freshSession();
}
// A blank session: zeroed scores, 庄 at seat 0, 东圈, no 圈 recorded yet. seatBase fixes
// the 座风 (seat 0 = 东) for the whole 锅; `rounds` accumulates one snapshot per completed
// 圈 (东南西北 = a 锅) for 每圈成绩 + 最终成绩.
function freshSession() { return { scores: [0, 0, 0, 0], dealer: 0, prevailingWind: 0, hand: 1, rounds: [], seatBase: 0 }; }
function saveSession() {
  session.scores = game ? game.scores.slice() : session.scores;
  localStorage.setItem('mahjong-session', JSON.stringify(session));
  localStorage.setItem('mahjong-level', String(level));
}

// Persistent 锅 history — one record { at, scores } per FINISHED 锅. Kept under its own
// key so resetting the live session (重开 / 再来一锅 / reload) never clears it; only the
// explicit 清空历史 does. Read/append lazily so it survives even a freshSession().
function loadHistory() {
  try { const h = JSON.parse(localStorage.getItem('mahjong-history')); if (Array.isArray(h)) return h; } catch {}
  return [];
}
function recordPotHistory() {
  const hist = loadHistory();
  hist.push({ at: Date.now(), scores: game.scores.slice() });
  while (hist.length > 50) hist.shift(); // cap growth; keep the most recent 50 锅
  localStorage.setItem('mahjong-history', JSON.stringify(hist));
}
{
  const lv = parseInt(localStorage.getItem('mahjong-level'), 10);
  if (lv >= 1 && lv <= 3) level = lv;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function selectableHandIndices() {
  // Indices into the rendered hand that are NOT wild (wilds can't be discarded).
  return renderedHand().map((id, i) => (game.isWild(id) ? -1 : i)).filter((i) => i >= 0);
}

// The human's display order: 混儿 on the left, the rest sorted ascending. The
// freshly drawn tile sorts into place; scene.js flanks it with a small margin.
const isWildFn = (id) => game.isWild(id);
function renderedHand() { return buildOrder(game.hands[HUMAN], isWildFn); }

// The HTML HUD around the canvas (header / scores / 混儿 / nameplates). Split out
// so the deal animation can show it without touching the 3D table.
function renderHud() {
  // ---- header ----
  // 圈 (prevailing wind) · 庄 (the 庄's fixed 座风 — only the 庄 moves within the 锅) · 难度
  const watching = VIEWER && game.seatNames ? `<span class="viewing">👁 观战 ${esc(game.seatNames[HUMAN] || '')}</span> · ` : '';
  $('round-info').innerHTML = watching +
    `<b>${WIND[game.prevailingWind]}圈</b> · <b>${WIND[game.seatWind(game.dealer)]}庄</b> · ` +
    (ONLINE ? '联机' : `难度 <b>${LEVEL_NAMES[level]}</b>`);
  renderScores();

  // ---- the round's two 混儿 (e.g. 7万 + 8万), shown with their real faces ----
  // During 拉庄 the 混儿 isn't decided yet (the hand hasn't "started") → show two face-down backs.
  const wc = $('wild-indicator');
  wc.innerHTML = '';
  if (lzBlind || lzActive) { wc.appendChild(backTileEl()); wc.appendChild(backTileEl()); }
  else for (const w of game.wilds) wc.appendChild(faceTileEl(w, { wild: true }));
  $('wall-count').textContent = `余 ${game.wall.length} 张`;

  // ---- nameplates ----
  for (let p = 0; p < 4; p++) renderPlate(p);
}

// The top-right scoreboard: a cross mirroring the table (对家 top, 上家 left, 下家
// right, 玩家 bottom). 庄 gets a 👑 prefix; score is green/red (no + on positives).
const SCORE_GRID = { 0: [3, 2], 1: [2, 3], 2: [1, 2], 3: [2, 1] }; // seat → [gridRow, gridCol]
function renderScores() {
  const el = $('scores');
  el.innerHTML = '';
  for (let p = 0; p < 4; p++) {
    const pts = game.scores[p];
    const color = pts > 0 ? '#7ddf8a' : pts < 0 ? '#ef9a9a' : '#cfe7db';
    const [row, col] = SCORE_GRID[p];
    const cell = document.createElement('div');
    cell.className = 'sb-seat' + (p === HUMAN ? ' me' : '');
    cell.style.gridRow = row; cell.style.gridColumn = col;
    cell.innerHTML = `<span class="sb-name">${p === game.dealer ? '👑' : ''}${game.isLaZhuang(p) ? '⚔️' : ''}${SEAT_LABEL[p]}</span>` +
      `<span class="sb-pt" style="color:${color}">${pts}</span>`;
    el.appendChild(cell);
  }
}

function render() {
  renderHud();

  // ---- 3D table ----
  const selectable = selectableHandIndices();
  if (selIndex >= selectable.length) selIndex = Math.max(0, selectable.length - 1);
  const myTurn = game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD;
  const revealing = scene && scene.handDrawRevealing; // drawn tile still flying in → no selection yet
  // A freshly-drawn 混儿 is still shown drawn (gap + reveal) and CAN be the lifted/
  // highlighted tile even though it can't be discarded; picking any normal tile drops
  // that selection back onto the non-wild cursor.
  const rh = renderedHand();
  const drawnWildIdx = (game.drawnTile != null && game.isWild(game.drawnTile)) ? rh.lastIndexOf(game.drawnTile) : -1;
  const selRendered = (drawnWildSelected && drawnWildIdx >= 0) ? drawnWildIdx : selectable[selIndex];
  // While a bot's discard fly is playing, hold the human's turn: the turn has already
  // advanced (the human drew), but we don't reveal that draw or allow selection yet —
  // show the pre-draw 13 tiles, and let the reveal play when the tick resumes.
  const mt = myTurn && !animating;
  // You can browse/lift your hand even while waiting for another player (you just can't discard yet),
  // so the table never feels frozen — both online and offline.
  const canLift = !animating && !revealing && game.phase !== PHASE.OVER && !isClaimPhase();
  let handForSync = rh;
  // Only when it's actually the HUMAN's turn has the human drawn — drop that one drawn
  // tile so its reveal is held until the bot's discard fly ends. (game.drawnTile is a
  // KIND, so without the myTurn guard a bot drawing a kind the human holds would wrongly
  // trim one of the human's tiles, flickering the hand.)
  if (animating && myTurn && game.drawnTile != null) {
    const di = rh.lastIndexOf(game.drawnTile);
    if (di >= 0) handForSync = rh.slice(0, di).concat(rh.slice(di + 1));
  }
  if (scene) scene.sync(game, {
    renderedHand: handForSync,
    myTurn: mt,
    selRendered: canLift && !revealing && !noSel && !lzBlind ? selRendered : null,
    claimable: !animating && isClaimPhase(),
    drawnTile: (mt && game.drawnTile != null) ? game.drawnTile : null,
    reveal: game.phase === PHASE.OVER,
    ownBacks: lzBlind, // hand dealt but face-down during a blind 拉庄 you haven't answered
    hideWilds: lzBlind || lzActive, // 混儿 undecided during 拉庄 → don't mark wild tiles (e.g. the 庄's revealed hand)
  });

  // ---- action bar / hint + toasts ----
  renderActions();
  positionClaimUI();
  flushLogToasts();
}

// Pin the claim buttons (碰/杠/过) under the big pending tile (front-center). The
// 打出 button stays in the default bottom bar, under the player's hand.
function positionClaimUI() {
  const hud = $('action-hud');
  if (scene && !animating && isClaimPhase()) {
    // Anchor the buttons' BOTTOM just above the hand row (z=5, in front of the
    // central pending tile) so the prompt never covers the hand, in any aspect.
    const a = scene.worldToScreen(0, 0, 5.0);
    hud.classList.add('claim');
    hud.style.left = a.x + 'px';
    hud.style.top = a.y + 'px';
    hud.style.bottom = 'auto';
    hud.style.transform = 'translate(-50%, -100%)';
  } else {
    hud.classList.remove('claim');
    hud.style.left = hud.style.top = hud.style.bottom = hud.style.transform = '';
  }
}

function renderPlate(p) {
  const seat = $('plate-' + p);
  const thinking = game.phase !== PHASE.OVER && game.turn === p && p !== HUMAN;
  const isDealer = p === game.dealer;
  const active = game.turn === p && game.phase !== PHASE.OVER;
  // Online: 东/南/西/北 · 名字 · 自己/下家/对家/上家. Offline: the human reads 玩家; each bot reads its
  // seat name (东方雨…) over its relation label, matching the online layout.
  let label;
  if (ONLINE && game.seatNames) {
    const name = game.seatNames[p] || (p === HUMAN ? '' : BOT_NAMES[p]);
    label = (name ? `<span class="pname">${esc(name)}</span>` : '') + `<span class="prel">${REL_LABEL[p]}</span>`;
  } else if (p === HUMAN) {
    label = `<span>${SEAT_LABEL[p]}</span>`;
  } else {
    label = `<span class="pname">${BOT_NAMES[p]}</span><span class="prel">${SEAT_LABEL[p]}</span>`;
  }
  seat.innerHTML =
    seatBadgeHtml(game, p) + // 👑 (庄) / ⚔️ (拉庄), above the nameplate
    `<div class="nameplate${active ? ' active' : ''}${isDealer ? ' dealer' : ''}">` +
    `<span class="wind">${WIND[game.seatWind(p)]}</span>` +
    label +
    (thinking ? '<span class="think">思考中…</span>' : '') +
    `</div>`;
}

function renderActions() {
  const bar = $('action-bar');
  bar.innerHTML = '';
  const center = $('ting-center'); center.innerHTML = ''; // the 和牌(胡) button floats here
  const hint = $('hand-hint');
  hint.textContent = '';
  if (animating) return; // a bot's discard fly is playing — show no action UI yet
  const buttons = [];

  if (game.phase === PHASE.AWAIT_CLAIM && game.claim && game.claim.player === HUMAN) {
    const c = game.claim;
    if (c.options.includes('pung')) buttons.push(mkBtn('碰', () => doClaim('pung')));
    if (c.options.includes('kong')) buttons.push(mkBtn('杠', () => doClaim('kong')));
    buttons.push(mkBtn('过', () => doPass(), true));
    hint.textContent = `${SEAT_LABEL[c.player === HUMAN ? game.lastDiscard.player : c.player]} 打出 ${tileName(c.kind)}`;
  } else if (game.phase === PHASE.AWAIT_DISCARD && game.turn === HUMAN) {
    // self-draw win available → offer 胡 (but you may still play on). Big + centered.
    if (game.selfDrawWin) {
      const w = game.selfDrawWin;
      center.appendChild(mkBtn(`胡 · ${w.fans[0]} · ${w.score}分`, () => doDeclareWin(), false, 'hu'));
    }
    // self-kong options (金杠 = a concealed kong of four 混儿)
    for (const k of game.selfKongOptions(HUMAN)) {
      buttons.push(mkBtn(`${k.type === 'gold' ? '金杠' : '杠'} ${tileName(k.kind)}`, () => doSelfKong(k.kind), true));
    }
  }

  if (focusIndex >= buttons.length) focusIndex = buttons.length - 1;
  buttons.forEach((b, i) => { if (i === focusIndex && isClaimPhase()) b.classList.add('focus'); bar.appendChild(b); });
}

function isClaimPhase() { return game.phase === PHASE.AWAIT_CLAIM && game.claim && game.claim.player === HUMAN; }

// ---- online turn countdown -------------------------------------------------
// The server awaits ONLY humans (bots act on their own clock), so an 'await' frame means a PLAYER
// is on the clock — show the ring with the server's remaining ms + full window (`total`). EVERY
// other frame means the wait is over (a bot is acting, or the player moved) → hide. So it tracks
// whoever is being waited on — your own turn or another human's — and stays hidden through bots'
// turns. The ring counts to 0; the next frame hides it. Offline never sends 'await' → never shows.
let ttHandle = null, ttDeadline = 0, ttTotal = 30000, ttWaiting = false;
function drawTurnTimer() {
  if (!ttWaiting) {
    if (ttHandle) { clearInterval(ttHandle); ttHandle = null; }
    if (scene && scene.setTurnTimer) scene.setTurnTimer({ show: false }); // 3D panel (or flat's DOM ring)
    return;
  }
  const left = Math.max(0, ttDeadline - Date.now());
  if (scene && scene.setTurnTimer) scene.setTurnTimer({ show: true, secs: Math.round(left / 1000), frac: ttTotal > 0 ? Math.min(1, left / ttTotal) : 0, low: left <= 5000 });
}
function syncTurnTimer(ev) {
  if (ev.type === 'await') { // a player (human) is on the clock
    ttWaiting = true;
    ttDeadline = Date.now() + (+ev.timeout > 0 ? +ev.timeout : 30000);
    ttTotal = +ev.total || +ev.timeout || 30000;
    if (!ttHandle) ttHandle = setInterval(drawTurnTimer, 100);
  } else ttWaiting = false; // bot's turn / 拉庄 / 下一局 / between hands → no clock
  drawTurnTimer();
}

// ---------------------------------------------------------------------------
// Toasts for 碰 / 杠 / 自摸 / 荒
// ---------------------------------------------------------------------------
// Which 杠: 金杠 (a kong of 混儿), 暗杠 (concealed), else 明杠 — read off the seat's latest kong meld.
function kongSlug(seat) {
  const km = (game.melds[seat] || []).filter((m) => m.type === 'kong').pop();
  if (!km) return 'mingkong';
  if (game.isWild && game.isWild(km.kind)) return 'jinkong';
  return km.concealed ? 'ankong' : 'mingkong';
}
function flushLogToasts() {
  if (!game || !game.log) return; // online views carry no engine log (toasts ride events instead)
  for (let i = lastLogLen; i < game.log.length; i++) {
    const line = game.log[i];
    // the claim log line starts with the seat's WIND (东/南/西/北) — map it back to the
    // seat index so the call is spoken in that seat's voice.
    const tok = line.split(' ')[0];
    let seat = 0; for (let p = 0; p < 4; p++) if (WIND[game.seatWind(p)] === tok) { seat = p; break; }
    const w = game.seatWind(seat);   // voice persona = the seat's wind (0..3 东南西北)
    if (/自摸/.test(line)) { toast(line, true); (game.result && game.result.winner === HUMAN ? sound.win() : sound.lose()); sound.call('hula', w); }
    else if (/荒牌/.test(line)) { toast(line, true); sound.drawGame(); }
    else if (/杠/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.kong(); sound.call(kongSlug(seat), w); }
    else if (/碰/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.pung(); sound.call('pung', w); }
  }
  lastLogLen = game.log.length;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
// ---- online: lost-connection banner ----------------------------------------
// On a dropped socket the RemoteBackend keeps retrying; we show a banner and, if it can't get
// back into the live game within a few seconds (e.g. the server restarted), return to the lobby —
// which shows the server status and lets you re-ready to resume the same 锅.
let reconnectTimer = null;
function showReconnecting() {
  const el = $('reconnect-overlay'); if (el) el.classList.remove('hidden');
  if (!reconnectTimer) reconnectTimer = setTimeout(returnHub, 8000);
}
function hideReconnecting() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const el = $('reconnect-overlay'); if (el) el.classList.add('hidden');
}

// The backend pushes one event per move; this async handler is the whole UI-side
// orchestration that used to be the synchronous tick() loop. Each case renders + plays
// the matching animation/sound and AWAITS it, so the backend (local sim or remote server)
// is held until the table catches up before sending the next event. The 碰/杠/自摸/荒 toasts
// + voices ride the engine log and flush inside render(), so most cases just call render().
async function onBackendEvent(ev) {
  if (ev.type === 'disconnected') { showReconnecting(); return; } // lost the server → reconnect banner (then bail to the lobby)
  if (ev.type === 'gameGone') { returnHub(); return; }            // server has no game for us (e.g. it restarted) → lobby
  if (ONLINE) hideReconnecting();                                 // any real frame means we're connected again
  const st = backend.getState();
  if (st) game = st;
  if (ev.type !== 'deal' && ev.type !== 'lazhuang') lzBlind = false; // play resumed → reveal my hand
  if (ev.type !== 'lazhuang') hideLaZhuangPanel();                   // any other frame means 拉庄 is over
  if (ONLINE) syncTurnTimer(ev); // show the ring whenever a player is on the clock (no-op offline)
  switch (ev.type) {
    case 'lazhuang': // blind 拉庄 over the freshly-dealt (still hidden) hand
      $('result-overlay').classList.add('hidden'); // a new hand is starting → drop any lingering result panel
      lzBlind = ev.need.includes(HUMAN); // still my turn to choose → keep my hand face-down
      if (FAST) { if (ev.need.includes(HUMAN)) backend.decideLaZhuang(lzTestChoice); render(); return; } // tests skip the panel
      showLaZhuangPanel(ev.dealer, ev.need, ev.answers, (yes) => backend.decideLaZhuang(yes));
      render();
      return;

    case 'deal':
      $('result-overlay').classList.add('hidden'); // the next hand is dealing → auto-hide the result panel
      selIndex = 0; focusIndex = 0; drawnWildSelected = false; noSel = VIEWER; lastLogLen = 0; // viewer: no default lift
      lzBlind = game.dealer !== HUMAN; // a non-dealer is about to be asked 拉庄 (blind) → keep the hand face-down
      if (!ONLINE) saveSession(); // online: the server is the source of truth, nothing to persist
      if (scene && !FAST && lzBlind) { if (scene._clearKongBounds) scene._clearKongBounds(); } // blind: no flourish, render shows backs
      else if (scene && !FAST) { // serve the tiles from the wall, then play
        dealing = true;
        renderHud();
        $('action-bar').innerHTML = ''; $('ting-center').innerHTML = '';
        $('hand-hint').textContent = '发牌中…';
        await new Promise((res) => scene.beginDeal(game, res, () => sound.select()));
        dealing = false;
      }
      render();
      if (ONLINE && backend.dealDone) backend.dealDone(); // table's dealt → let the server start the opponents (paced, not bunched)
      return;

    case 'discard': {
      const human = ev.player === HUMAN;
      sound.discard();
      if (human) selIndex = Math.min(selIndex, selectableHandIndices().length - 1);
      else if (!fastMode) sound.sayTile(ev.tile, game.seatWind(ev.player)); // bot speaks its discard
      if (scene && !FAST && !fastMode) { // fly to the center halt, hold, drop into the pool
        if (human) sound.sayTile(ev.tile, game.seatWind(HUMAN));
        animating = true;
        try {
          scene.beginDiscardDemo(ev.player, ev.discardIndex, DISCARD_DEMO_MS);
          render(); // place the flying tile; claim UI + the human's drawn tile stay held
          await delay(DISCARD_DEMO_MS + DISCARD_SETTLE_MS);
        } finally { animating = false; } // never leave the action bar wedged if a frame mid-animation throws
      }
      render();
      return;
    }

    case 'claim':
      if (ev.player === HUMAN) { selIndex = 0; drawnWildSelected = false; noSel = VIEWER; } // then they discard (viewer: no default lift)
      else if (scene) { // show the bot's 碰/杠 lifted, hold until it settles
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
      if (ev.who === 'claim') focusIndex = 0; else ensureSelection();
      render();
      return;

    case 'over':
      render();      // flush the 自摸 / 荒牌 toast + win/lose sound from the log
      onlineEndsPot = ONLINE && !!ev.potEnd; // set BEFORE showResult so it picks the right button label
      showResult();
      // resync after a refresh: reflect a choice we'd already made
      if (ev.readied) {
        const b = $('next-hand-btn');
        if (onlineEndsPot) { b.disabled = true; b.textContent = '结算中…'; }        // already chose to finish the 锅
        else { onlineReadied = true; b.textContent = '✓ 已准备 · 取消'; b.classList.add('readied'); } // already readied
      }
      return;

    // ---- online only ----
    case 'sync': // (re)joined a game in progress, or reconnected — render the current state
      lastLogLen = game.log ? game.log.length : 0; // online views carry no log; suppress toasts
      ensureSelection();
      render();
      return;

    case 'potOver': // the server finished the 锅 → final standings (server-authoritative)
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

// ---------------------------------------------------------------------------
// Human actions
// ---------------------------------------------------------------------------
// Tapping a tile only SELECTS it (lifts + highlights); discarding is a separate
// confirm (打出 button / A / Enter). Tapping the already-selected tile confirms.
function onPickTile(renderedIdx) {
  if (!game || dealing || animating) return;
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  if (game.phase === PHASE.OVER || isClaimPhase()) return; // not while the result / a claim prompt is up
  const mine = !VIEWER && game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD; // browse off-turn; discard only on yours (never as a viewer)
  const id = renderedHand()[renderedIdx];
  if (id == null) return;
  if (game.isWild(id)) { toast('混儿不能打出'); return; } // 混儿 (incl. the drawn one): complain, no action
  const wasWildSel = drawnWildSelected;
  drawnWildSelected = false;                  // picking a normal tile drops the drawn-混儿 selection
  const pos = selectableHandIndices().indexOf(renderedIdx);
  if (pos < 0) return;
  if (pos === selIndex && !wasWildSel && !noSel && mine) discardSelected(); // second tap confirms — only on your turn, and only if something was already lifted
  else { noSel = false; selIndex = pos; sound.select(); render(); }         // otherwise just select (also while waiting online)
}

function discardSelected() {
  if (!game || game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  if (drawnWildSelected) { toast('混儿不能打出'); return; } // the lifted tile is the drawn 混儿
  const hand = renderedHand();
  const sel = selectableHandIndices();
  const id = hand[sel[selIndex]];
  if (id == null || game.isWild(id)) return;
  noSel = true;        // drop the lifted-tile highlight the instant you discard (you can re-select off-turn)
  backend.discard(id); // the 'discard' event animates it, then the backend drives the bots
}

function doDeclareWin() {
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  backend.declareWin();
}
// When the freshly-drawn tile finishes its reveal, auto-select it (ready to discard).
// A drawn 混儿 is selected too (lifted/highlighted) but isn't discardable — it stays
// flagged so confirm/tap on it just complains; picking any normal tile clears it.
function selectDrawnTile() {
  if (VIEWER) return; // a viewer's hand isn't theirs to play — don't auto-lift the drawn tile (manual pick still works)
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || game.drawnTile == null) return;
  noSel = false; // a fresh draw on your turn re-lifts a tile
  if (game.isWild(game.drawnTile)) {
    drawnWildSelected = true;
  } else {
    drawnWildSelected = false;
    const si = selectableHandIndices().indexOf(renderedHand().lastIndexOf(game.drawnTile));
    if (si >= 0) selIndex = si;
  }
  render();
}
function doSelfKong(kind) {
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  backend.selfKong(kind);
}
function doClaim(type) {
  if (!isClaimPhase()) return;
  if (!game.claim.options.includes(type)) return;
  // After 碰/杠 the human must discard; the 'claim'/'await' events reset the selection.
  backend.claim(type);
}
function doPass() {
  if (!isClaimPhase()) return;
  backend.pass();
}

// ---------------------------------------------------------------------------
// Result / new hand
// ---------------------------------------------------------------------------

// Render the winning hand grouped by meld + pair from the decomposition. Each
// 混儿 is placed in its slot but shown with its ORIGINAL wildcard face (the round's
// 混 tile the player actually held), marked 混 — not the tile it stands for.
function renderWinningHand(handEl, w, r) {
  // The actual 混 tiles the winner held (incl. a wild winning tile), in order.
  const heldWilds = game.hands[w].filter((id) => game.isWild(id)).sort((a, b) => a - b);
  let wp = 0;
  const wildFace = () => (heldWilds.length ? heldWilds[wp++ % heldWilds.length] : game.wilds[0]);
  const meldTilesOf = (g) => {
    if (g.type === 'pung') { const k = g.kinds[0], nat = 3 - g.jokers; return [0, 1, 2].map((i) => ({ kind: k, wild: i >= nat })); }
    return g.kinds.map((id) => ({ kind: id, wild: !g.natural.has(id) })); // chow
  };
  const pairTilesOf = (g) => {
    if (g.kinds.length) { const k = g.kinds[0], nat = 2 - g.jokers; return [0, 1].map((i) => ({ kind: k, wild: i >= nat })); }
    return [{ kind: game.wilds[0], wild: true }, { kind: game.wilds[0], wild: true }];
  };
  // Highlight the winning (drawn) tile in the exact group the engine says it completed
  // (winGroupIdx, from the scored decomposition) — so a 混吊 glows the 混 in the 将, not an
  // identical 混 used elsewhere, and a natural win glows the 6筒 in its own group, not a
  // copy. Within that group: the 混 slot if the drawn tile was wild, else the natural slot
  // matching its kind. 'called' groups never hold it; mark exactly one tile.
  const winKind = r.winningTile;
  const winIsWild = winKind != null && game.isWild(winKind);
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
    addGroup(game.hands[w].slice().sort((a, b) => a - b).map((id) => ({ kind: id, wild: game.isWild(id) })), '', handEl, 'hand');
    for (const m of game.melds[w]) addGroup(m.tiles.map((k) => ({ kind: k, wild: false })), '', handEl, 'called');
    return;
  }
  for (const m of game.melds[w]) addGroup(m.tiles.map((k) => ({ kind: k, wild: false })), '', handEl, 'called');
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

function showResult() {
  const r = game.result;
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
    payEl.innerHTML = hasPay ? breakdownHtml(r) : '本局无人和牌';
  } else {
    const w = r.winner;
    $('result-title').textContent = `${SEAT_LABEL[w]}（${WIND[game.seatWind(w)]}）自摸！`;
    for (const f of r.fans) {
      const c = document.createElement('span'); c.className = 'fan-chip'; c.textContent = f;
      fansEl.appendChild(c);
    }
    scoreEl.textContent = r.score + ' 分';
    if (r.winningTile != null) {
      const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = '自摸 · 和这张';
      winEl.appendChild(cap);
      winEl.appendChild(faceTileEl(r.winningTile, { lg: true, wild: game.isWild(r.winningTile) }));
      winEl.classList.add('show');
    }
    if (r.decomp) renderWinningHand(handEl, w, r); // the winning hand pattern (server sends decomp online too)
    payEl.innerHTML = breakdownHtml(r);
  }
  renderSeatHands(game, (id) => game.isWild(id)); // reveal every seat's hand on its border
  if (!ONLINE) saveSession();
  // If this hand closes the 北圈, the 锅 is finished — the button ENDS it and shows the 最终成绩.
  // Offline we compute it from the session; online the server flags it (onlineEndsPot, set on 'over')
  // because the rotated view can't tell which absolute seat is the 锅's first 庄.
  const endsPot = ONLINE ? onlineEndsPot : (game.nextDealer() === 0 && game.dealer !== 0 && session.prevailingWind === 3);
  const nb = $('next-hand-btn'); nb.disabled = false; nb.classList.remove('readied'); onlineReadied = false; // fresh result → not ready
  nb.textContent = endsPot ? '结束并查看总成绩 🏆' : (ONLINE ? '我准备好了' : '下一局');
  ov.classList.remove('hidden');
  resultFocus = 0; focusResultBtn(); // 下一局 focused by default
}

// 得分明细 for the result panel. First the overall result — every seat's net laid out as
// a 3×3 grid mirroring the table (对家 top, 上家 left, 下家 right, 玩家 bottom) — then the
// human's own breakdown: net vs each opponent with 胡 / 明杠 / 暗杠 / 金杠 as subitems and
// 庄x2 / 拉庄x2 tags where they apply. The multipliers come from game.settlementFactors,
// the same source _settle + _settleKongs use, so the panel can never drift from the math.
function breakdownHtml(r) {
  const me = HUMAN, dealer = game.dealer;
  const winner = r.type === 'win' ? r.winner : -1;
  const score = r.score || 0;
  const col = (v) => (v > 0 ? '#7ddf8a' : v < 0 ? '#ef9a9a' : '#cfe7db');
  const sgn = (v) => (v > 0 ? '+' : '') + v;
  // per-seat kong points split by type (明杠 / 暗杠 / 金杠) from the just-finished melds
  const kt = (p) => {
    let open = 0, conc = 0, gold = 0;
    for (const m of game.melds[p]) {
      if (m.type !== 'kong') continue;
      if (game.isWild(m.kind)) gold += 4; else if (m.concealed) conc += 2; else open += 1;
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
  // your breakdown — net vs each opponent, with the 胡/杠 reasons as subitems
  let total = 0;
  const grps = [1, 2, 3].map((off) => {
    const q = (me + off) % 4, factors = game.settlementFactors(me, q);
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
    const net = subs.reduce((s, [, v]) => s + v, 0); total += net;
    const tag = factors.map((x) => ` <span class="dbl">${x.label}x${x.factor}</span>`).join('');
    const subHtml = (subs.length ? subs : [['—', 0]]).map(([w, v]) =>
      `<div class="bd-sub"><span>${w}</span><span class="s-net" style="color:${col(v)}">${v ? sgn(v) : '—'}</span></div>`
    ).join('');
    return `<div class="bd-grp"><div class="bd-row"><span class="bd-seat">${q === dealer ? '👑 ' : ''}${SEAT_LABEL[q]}${tag}</span>` +
      `<span class="bd-net" style="color:${col(net)}">${sgn(net)}</span></div>${subHtml}</div>`;
  });
  return `<div class="bd-title">本局得分</div><div class="bd-all">${all}</div>` +
    `<div class="bd-title">玩家明细 · <span style="letter-spacing:normal;font-size:1.05rem;font-weight:800;color:${col(total)}">${sgn(total)}</span></div>` +
    grps.join('');
}

let onlineReadied = false;  // result-modal ready toggle (online): 我准备好了 ⇄ ✓已准备
let onlineEndsPot = false;  // this result closes the 锅 (server-flagged) → finish button, no toggle
function nextHand() {
  if (VIEWER) return; // a spectator can't ready up — the next hand deals when the real players are ready
  if (ONLINE) {
    if (onlineEndsPot) {
      // Final hand of the 锅: this only ENDS it — the server replies with 'potOver' → 最终成绩. No
      // un-ready toggle (you can't un-finish a 锅); just lock the button while the server settles.
      backend.next();
      const btn = $('next-hand-btn'); btn.disabled = true; btn.textContent = '结算中…';
      return;
    }
    // Toggle readiness. The server deals the next hand only once EVERY human is ready (no timeout),
    // so you can ready up and change your mind; the result panel auto-hides when the next hand deals.
    onlineReadied = !onlineReadied;
    const btn = $('next-hand-btn');
    if (onlineReadied) { backend.next(); btn.textContent = '✓ 已准备 · 取消'; btn.classList.add('readied'); }
    else { backend.unready(); btn.textContent = '我准备好了'; btn.classList.remove('readied'); }
    return;
  }
  $('result-overlay').classList.add('hidden');
  const nextDealer = game.nextDealer();
  // A 圈 ends when the 庄 button laps back to seat 0 (东). Four 圈 (东南西北) make a
  // 锅: when the 北圈 (prevailingWind 3) laps, the 锅 is over → final scoreboard.
  const roundDone = nextDealer === 0 && game.dealer !== 0;
  if (roundDone) {
    // Snapshot the cumulative scores at the close of the 圈 just finished (每圈成绩).
    session.rounds.push({ wind: session.prevailingWind, scores: game.scores.slice() });
    if (session.prevailingWind === 3) { // 北圈 done → 锅 complete; stop and tally
      recordPotHistory(); // append this 锅's final scores to the persistent 历史战绩
      saveSession();
      showFinalBoard();
      return;
    }
    session.prevailingWind = (session.prevailingWind + 1) % 4;
  }
  session.hand += 1;
  session.dealer = nextDealer;
  startHand();
}

function startHand() {
  if (!scene) { scene = new Renderer($('scene')); scene.setRotated(isPortrait); scene.resize(); scene.onHandDrawSettled = selectDrawnTile; }
  if (!backend) { backend = createBackend({ mode: 'local', rng: Math.random }); backend.onEvent(onBackendEvent); }
  backend.thinkDelay = AI_DELAY; // bot "think" pacing — the online-latency stand-in
  // Hand off to the backend: it resolves 拉庄 (emitting 'lazhuang' for the human to
  // answer), deals (emits 'deal'), then drives the opponents — the UI reacts in
  // onBackendEvent. The 锅/圈 progression + persistence stay UI-side (nextHand/session).
  backend.startHand({
    dealer: session.dealer, prevailingWind: session.prevailingWind,
    scores: session.scores, seatBase: session.seatBase, level,
  });
}

// Online: connect to the server's table. The server is the ground truth — it deals, drives
// the opponents, and PUSHES frames into onBackendEvent; there is NO local match logic, no
// session, no 锅/圈 bookkeeping here (all of that lives server-side). On (re)connect the server
// resyncs the game in progress.
function connectOnline() {
  if (!scene) { scene = new Renderer($('scene')); scene.setRotated(isPortrait); scene.resize(); scene.onHandDrawSettled = selectDrawnTile; }
  backend = createBackend({ mode: 'remote', url: ONLINE_URL, uid: localStorage.getItem('mahjong-online-uid') || '', name: localStorage.getItem('mahjong-online-name') || '',
    spectate: VIEWER ? { table: 0, seat: VIEWER_SEAT } : null });
  backend.onEvent(onBackendEvent);
  backend.connect();
}

// ---------------------------------------------------------------------------
// 拉庄 (blind double-down) panel — a table-shaped cross: every seat shown around the centre
// (名字 + 庄/拉庄 status), the question + ⚔️/不拉 buttons in the middle, and an arrow pointing at
// the 庄. The hand is already dealt but kept face-down (lzBlind) so the choice stays blind. A
// non-deciding viewer (the 庄, or a challenger who already chose) sees the live tally instead of
// buttons. The DECISION wiring (who's asked) lives in the backend; we just render + answer.
// ---------------------------------------------------------------------------
let lzCallback = null, lzFocus = 1; // panel: 0 = 拉庄, 1 = 不拉 (default, no accidental double)
let lzTestChoice = false;           // FAST/e2e override for the human's answer (no panel in tests)

function lzSeatName(p) {
  if (ONLINE && game && game.seatNames) return game.seatNames[p] || (game.seatKinds && game.seatKinds[p] === 'bot' ? '机器人' : '');
  return SEAT_LABEL[p];
}
function showLaZhuangPanel(dealer, need, answers, cb) {
  const deciding = need.includes(HUMAN);
  lzCallback = deciding ? cb : null; lzFocus = 1; // watchers (the 庄 / already-chosen) can't answer

  for (let p = 0; p < 4; p++) {
    const el = $('lz-seat-' + p);
    let st = '';
    if (p === dealer) st = '<span class="lz-st dealer">庄家</span>';
    else if (need.includes(p)) st = '<span class="lz-st pend">…</span>';
    else if (answers[p] !== undefined) st = answers[p] ? '<span class="lz-st yes">⚔️ 拉</span>' : '<span class="lz-st no">不拉</span>';
    const pts = game && game.scores ? (game.scores[p] | 0) : 0; // current 锅 running total
    const col = pts > 0 ? '#7ddf8a' : pts < 0 ? '#ef9a9a' : '#cfe7db';
    const wind = (game && game.seatWind) ? WIND[game.seatWind(p)] : WIND[p]; // the seat's 座风 (东西南北)
    el.className = 'lz-seat lz-pos-' + p + (p === HUMAN ? ' me' : '') + (p === dealer ? ' dealer' : '');
    el.innerHTML = `<span class="lz-nm">${p === dealer ? '👑 ' : ''}${esc(lzSeatName(p))}</span>` +
      `<span class="lz-rel"><b class="lz-wind">${wind}</b> · ${(ONLINE ? REL_LABEL : SEAT_LABEL)[p]}</span>` +
      `<span class="lz-score" style="color:${col}">${pts > 0 ? '+' : ''}${pts} 分</span>` + st;
  }
  $('lazhuang-text').textContent = deciding ? `${lzSeatName(dealer)}坐庄，是否拉庄？` : `${lzSeatName(dealer)}坐庄`;
  $('lz-btns').style.display = deciding ? '' : 'none';
  $('lz-wait').style.display = deciding ? 'none' : '';
  $('lz-wait').textContent = '等待拉庄确认…';
  $('lz-arrow').className = 'lz-arrow lz-arrow-' + dealer; // points at the 庄
  lzActive = true; // the 混儿 stays hidden while the panel is up
  $('lazhuang-overlay').classList.remove('hidden');
  if (deciding) focusLzBtn();
}
function hideLaZhuangPanel() { lzCallback = null; lzActive = false; $('lazhuang-overlay').classList.add('hidden'); }
function focusLzBtn() {
  const btns = [$('lazhuang-yes'), $('lazhuang-no')];
  btns.forEach((b, i) => b && b.classList.toggle('focus', i === lzFocus));
  btns[lzFocus] && btns[lzFocus].focus();
}
function resolveLz(yes) {
  if (VIEWER) return; // a spectator can't answer — the panel updates from the real player's choice
  if (!lzCallback) return;
  const cb = lzCallback; lzCallback = null;
  cb(yes); // send the answer; keep the panel up (now in 'waiting' state) until play resumes
  $('lz-btns').style.display = 'none';
  $('lazhuang-text').textContent = yes ? '你选择了 ⚔️ 拉庄' : '你选择了 不拉';
  $('lz-wait').style.display = ''; $('lz-wait').textContent = '等待其他玩家…';
  if (!ONLINE) { lzBlind = false; render(); } // offline: reveal the hand right away (online waits for the server)
}

// Touch / mouse on the 3D table → raycast → select the picked hand tile.
$('scene').addEventListener('pointerdown', (e) => {
  if (!scene || !gameStarted || dealing || animating) return;
  sound.resume(); // touch is a user gesture — unlock audio
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx != null) onPickTile(idx); // onPickTile selects always (online) but only discards on your turn
});
// PC only: hovering a hand tile selects it (same as a click-to-select). Mouse-only
// so touch is unaffected; 混儿 aren't selectable so hovering them is ignored.
$('scene').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !scene || !gameStarted || dealing || animating || !game) return;
  if (scene.handDrawRevealing || game.phase === PHASE.OVER || isClaimPhase()) return; // hover-select even off-turn (no discard)
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx == null) return;
  const pos = selectableHandIndices().indexOf(idx);
  if (pos >= 0 && (pos !== selIndex || drawnWildSelected || noSel)) { drawnWildSelected = false; noSel = false; selIndex = pos; sound.select(); render(); }
});

function newGame() {
  if (ONLINE) { returnHub(); return; } // online: 重开/再来一锅 go back to the lobby (server owns the match)
  // Drop the finished view; the next 'deal' installs the fresh one. (Starting a new hand
  // bumps the backend's generation, so any in-flight opponent loop abandons quietly.)
  game = null;
  session = freshSession();
  startHand(); // backend deals from the zeroed session; the 'deal' event persists it
}

// ---------------------------------------------------------------------------
// 每圈成绩 / 一锅最终成绩 — 圈 = one 庄 lap (东南西北 winds); 锅 = four 圈.
// ---------------------------------------------------------------------------

// The 每圈成绩 table: one row per completed 圈 (its net change per seat), a 进行中 row
// for the 圈 still in play, and a 合计 footer (cumulative). `live` = the current running
// scores (game.scores) while a 锅 is in progress, or null.
function roundsTableHtml(live, rounds = session.rounds) {
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
    body += row(`${WIND[session.prevailingWind]}圈 · 进行中`, live.map((s, i) => s - prev[i]), 'live');
  }
  if (!body) body = `<tr><td class="rd-empty" colspan="5">本锅还没有完成的圈</td></tr>`;
  const total = live || (rounds.length ? rounds[rounds.length - 1].scores : [0, 0, 0, 0]);
  const head = `<tr><th></th>${seats.map((p) => `<th class="${p === HUMAN ? 'me' : ''}">${SEAT_LABEL[p]}</th>`).join('')}</tr>`;
  const foot = `<tr><td class="rd-wind">合计</td>${seats.map((p) => cell(total[p])).join('')}</tr>`;
  return `<table class="rounds-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
}

function openRounds() {
  $('rounds-body').innerHTML = roundsTableHtml(game ? game.scores : null);
  $('rounds-overlay').classList.remove('hidden');
}

// 历史战绩: one row per finished 锅 (date + its final per-seat scores) and a 合计 footer
// with the lifetime total. Columns are the human-relative seats (玩家/下家/对家/上家).
function historyTableHtml() {
  const hist = loadHistory();
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

let histClearArm = false; // 清空历史 needs two clicks to confirm
function openHistory() {
  $('history-body').innerHTML = historyTableHtml();
  histClearArm = false; $('history-clear').textContent = '清空历史';
  $('menu-overlay').classList.add('hidden');
  $('history-overlay').classList.remove('hidden');
}

// The 锅 is over (four 圈 done): final standings, a 恭喜 line when the human placed
// first, the 每圈成绩 breakdown, and a reset to deal a fresh 锅.
function showFinalBoard(data) {
  const scores = (data ? data.scores : game.scores).slice(); // online: server-provided final scores
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
  $('final-rounds').innerHTML = roundsTableHtml(scores, data ? data.rounds : session.rounds);
  // Online the server owns the match, so 再来一锅 just returns to the lobby — identical to 返回大厅.
  // Drop the duplicate; offline it genuinely starts a fresh zeroed 锅, so keep it there.
  $('final-reset-btn').style.display = ONLINE ? 'none' : '';
  $('final-overlay').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Input: unified action dispatch from keyboard + gamepad
// ---------------------------------------------------------------------------
function onAction(name) {
  if (!gameStarted) return;
  sound.resume(); // a key/pad press is a user gesture — unlock audio
  if (!$('leave-confirm-overlay').classList.contains('hidden')) {
    if (name === 'confirm') returnHub();                                                  // 确定返回 → lobby
    else if (name === 'cancel' || name === 'menu') $('leave-confirm-overlay').classList.add('hidden'); // 继续游戏
    return;
  }
  if (!$('forfeit-confirm-overlay').classList.contains('hidden')) {
    if (name === 'confirm') doForfeit();                                                  // 确认认输
    else if (name === 'cancel' || name === 'menu') $('forfeit-confirm-overlay').classList.add('hidden'); // 取消
    return;
  }
  if (!$('menu-overlay').classList.contains('hidden') ||
      !$('rules-overlay').classList.contains('hidden') ||
      !$('start-overlay').classList.contains('hidden')) {
    if (name === 'cancel' || name === 'menu') closeOverlays();
    return;
  }
  if (!$('lazhuang-overlay').classList.contains('hidden')) {
    if (name === 'left' || name === 'right') { lzFocus ^= 1; focusLzBtn(); }
    else if (name === 'confirm') resolveLz(lzFocus === 0);
    else if (name === 'cancel') resolveLz(false); // 不拉
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
    if (name === 'confirm') { $('final-overlay').classList.add('hidden'); newGame(); } // 再来一锅
    else if (name === 'menu') returnHub();
    return;
  }
  if (!$('result-overlay').classList.contains('hidden')) {
    if (name === 'left') { resultFocus = 1; focusResultBtn(); }      // 返回 (top-left)
    else if (name === 'right') { resultFocus = 0; focusResultBtn(); } // 下一局 (top-right)
    else if (name === 'confirm') (resultFocus === 0 ? nextHand() : leaveToLobby());
    else if (name === 'menu') nextHand();
    return;
  }

  if (dealing || animating) return; // serving tiles / a discard fly is playing — hold input
  if (!game) { if (name === 'menu') openMenu(); return; } // between hands (backend dealing)

  if (isClaimPhase()) {
    const btns = [...$('action-bar').children];
    if (name === 'left') { focusIndex = (focusIndex - 1 + btns.length) % btns.length; render(); }
    else if (name === 'right') { focusIndex = (focusIndex + 1) % btns.length; render(); }
    else if (name === 'confirm') btns[focusIndex]?.click();
    else if (name === 'pung') doClaim('pung');
    else if (name === 'kong') doClaim('kong');
    else if (name === 'cancel' || name === 'pass') doPass();
    else if (name === 'menu') openMenu();
    return;
  }

  if (game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD) {
    const n = selectableHandIndices().length;
    if (name === 'win') doDeclareWin();
    else if (name === 'left') { drawnWildSelected = false; noSel = false; selIndex = (selIndex - 1 + n) % n; sound.select(); render(); }
    else if (name === 'right') { drawnWildSelected = false; noSel = false; selIndex = (selIndex + 1) % n; sound.select(); render(); }
    else if (name === 'confirm') discardSelected();
    else if (name === 'kong') { const o = game.selfKongOptions(HUMAN)[0]; if (o) doSelfKong(o.kind); }
    else if (name === 'menu') openMenu();
    else if (name === 'cancel') openMenu();
    return;
  }

  // Keep the hand browsable while waiting for another player (no discard) so the table isn't frozen.
  if (name === 'left' || name === 'right') {
    const n = selectableHandIndices().length;
    if (n) { drawnWildSelected = false; noSel = false; selIndex = (selIndex + (name === 'left' ? -1 : 1) + n) % n; sound.select(); render(); return; }
  }

  if (name === 'menu') openMenu();
}

bindKeys(onAction, {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'left', ArrowDown: 'right',
  Enter: 'confirm', ' ': 'confirm',
  p: 'pung', P: 'pung', g: 'kong', G: 'kong', k: 'kong', K: 'kong', h: 'win', H: 'win',
  Escape: 'cancel', Backspace: 'pass', m: 'menu', M: 'menu',
});
// Xbox: A=confirm B=cancel X=pung Y=kong, d-pad/stick = left/right, Menu = menu.
startGamepad(onAction, { 14: 'left', 12: 'left', 15: 'right', 13: 'right', 0: 'confirm', 1: 'cancel', 2: 'pung', 3: 'kong', 9: 'menu' });

// ---------------------------------------------------------------------------
// Overlays + boot
// ---------------------------------------------------------------------------
let gameStarted = false;
function openMenu() { $('menu-overlay').classList.remove('hidden'); }
function closeOverlays() {
  for (const id of ['menu-overlay', 'rules-overlay']) $(id).classList.add('hidden');
}

function fillRules() {
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
    杠开 <code>×2</code>，天和/地和 <code>= 28（封顶）</code>。
    <h3>算番</h3>
    捉五、龙<b>相加</b>成底（无则底为 1，即提溜）；本混、混吊、素、杠开各<b>×2</b>。先加后乘。
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

function bindUI() {
  // difficulty selection
  $('level-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.level-btn');
    if (!btn) return;
    [...$('level-row').children].forEach((c) => c.classList.remove('sel'));
    btn.classList.add('sel');
    level = parseInt(btn.dataset.level, 10);
  });
  // preselect saved level
  [...$('level-row').children].forEach((c) =>
    c.classList.toggle('sel', parseInt(c.dataset.level, 10) === level));

  $('start-btn').addEventListener('click', () => {
    $('start-overlay').classList.add('hidden');
    gameStarted = true;
    sound.resume();
    startHand();
  });
  $('rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
  $('start-hub-link').addEventListener('click', () => { location.replace('../../'); }); // difficulty screen → main hub
  $('menu-rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
  $('rules-close').addEventListener('click', () => $('rules-overlay').classList.add('hidden'));
  $('menu-btn').addEventListener('click', openMenu);
  const soundBtn = $('sound-btn');
  const updateSoundIcon = () => { soundBtn.textContent = sound.muted ? '🔇' : '🔊'; };
  soundBtn.addEventListener('click', () => { sound.resume(); sound.toggleMuted(); updateSoundIcon(); });
  updateSoundIcon();
  const fastChk = $('fast-mode-chk');
  if (fastChk) {
    fastChk.checked = fastMode;
    fastChk.addEventListener('change', () => { fastMode = fastChk.checked; localStorage.setItem('mahjong-fast', fastMode ? '1' : '0'); });
  }
  $('resume-btn').addEventListener('click', closeOverlays);
  $('newgame-btn').addEventListener('click', () => { closeOverlays(); newGame(); });
  $('next-hand-btn').addEventListener('click', nextHand);
  $('back-hub-btn').addEventListener('click', leaveToLobby);
  $('leave-confirm-yes').addEventListener('click', returnHub);
  $('leave-confirm-no').addEventListener('click', () => $('leave-confirm-overlay').classList.add('hidden'));
  $('rounds-btn').addEventListener('click', openRounds);
  $('rounds-close').addEventListener('click', () => $('rounds-overlay').classList.add('hidden'));
  $('lazhuang-yes').addEventListener('click', () => { sound.resume(); resolveLz(true); });
  $('lazhuang-no').addEventListener('click', () => { sound.resume(); resolveLz(false); });
  $('final-reset-btn').addEventListener('click', () => { $('final-overlay').classList.add('hidden'); newGame(); });
  $('final-hub-btn').addEventListener('click', returnHub);
  $('menu-history-btn').addEventListener('click', openHistory);
  $('history-close').addEventListener('click', () => $('history-overlay').classList.add('hidden'));
  $('history-clear').addEventListener('click', () => {
    if (!histClearArm) { histClearArm = true; $('history-clear').textContent = '确定清空？（再点一次）'; return; }
    localStorage.removeItem('mahjong-history'); histClearArm = false; $('history-clear').textContent = '清空历史';
    $('history-body').innerHTML = historyTableHtml();
  });
  $('menu-hub-btn').addEventListener('click', leaveToLobby);
  // 认输 (forfeit) — online players only; a red two-step confirm.
  $('menu-forfeit-btn').addEventListener('click', () => { $('menu-overlay').classList.add('hidden'); $('forfeit-confirm-overlay').classList.remove('hidden'); });
  $('forfeit-confirm-yes').addEventListener('click', doForfeit);
  $('forfeit-confirm-no').addEventListener('click', () => $('forfeit-confirm-overlay').classList.add('hidden'));
  // Online: no 重开 (the server owns the match) and no local 历史战绩 (scores live on the lobby
  // leaderboard); offer 认输 instead. Hidden rather than removed so the offline build is untouched.
  if (ONLINE) { $('newgame-btn').style.display = 'none'; $('menu-history-btn').style.display = 'none'; }
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

// User-initiated "返回大厅". Leaving a live online game (as a seated player) keeps your seat —
// the server auto-plays it (random discards) until the hand ends — so confirm first. Spectators,
// offline play, and the 锅-over final board leave straight away (no auto-play at stake).
function leaveToLobby() {
  if (ONLINE && game && !VIEWER) { $('menu-overlay').classList.add('hidden'); $('leave-confirm-overlay').classList.remove('hidden'); return; }
  returnHub();
}

// Leave the game: offline → the main hub; online → back to the lobby.
function returnHub() {
  if (!ONLINE) { location.replace('../../'); return; }
  const params = new URLSearchParams(location.search); // carry ?server=/fast/flat back to the lobby
  for (const k of ['online', 'viewer', 'vseat', 'vtable']) params.delete(k);
  params.set('game', 'tianjin'); // return to THIS game's split lobby
  const qs = params.toString();
  location.replace('../mahjong-common-online/' + (qs ? '?' + qs : ''));
}

// Keyboard/gamepad focus between the result panel's two buttons (下一局 / 返回).
let resultFocus = 0;
function focusResultBtn() {
  const btns = [$('next-hand-btn'), $('back-hub-btn')];
  btns.forEach((b, i) => b && b.classList.toggle('focus', i === resultFocus));
  btns[resultFocus] && btns[resultFocus].focus();
}

bindUI();

// Online boot: no start overlay / difficulty — the lobby already started the table. Connect
// and let the server drive. (Gated on ONLINE; the offline boot below the start overlay is
// completely unchanged.)
if (ONLINE) { $('start-overlay').classList.add('hidden'); gameStarted = true; connectOnline(); }

// Debug hook (only under ?fast=1) for visual checks.
if (new URLSearchParams(location.search).get('fast')) {
  window.__mj = {
    humanTurn: () => !!game && game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD,
    // emulate a real user: a drawn 混儿 can't be discarded, so fall back to a non-wild tile
    discard: () => { drawnWildSelected = false; discardSelected(); },
    scene: () => scene,
    game: () => game,
    // visual check: melds for every seat + a full pool + a pending claim
    debugMelds: () => {
      const w = game.wilds[0];
      game.melds[HUMAN] = [
        { type: 'kong', kind: 0, tiles: [0, 0, 0, 0] },                  // 明杠
        { type: 'kong', kind: 9, tiles: [9, 9, 9, 9], concealed: true }, // 暗杠
        { type: 'kong', kind: w, tiles: [w, w, w, w], concealed: true }, // 金杠
      ];
      for (let p = 1; p < 4; p++) game.melds[p] = [
        { type: 'pung', kind: p * 4, tiles: [p * 4, p * 4, p * 4] },
        { type: 'kong', kind: 9 + p * 3, tiles: [9 + p * 3, 9 + p * 3, 9 + p * 3, 9 + p * 3], concealed: p === 2 },
      ];
      game.discardLog = [];
      for (let i = 0; i < 40; i++) game.discardLog.push({ player: i % 4, kind: (i * 7) % 34 });
      game.discardLog.push({ player: 1, kind: 4 });       // pending tile
      game.phase = PHASE.AWAIT_CLAIM;
      game.lastDiscard = { player: 1, kind: 4 };
      game.claim = { player: HUMAN, kind: 4, options: ['pung'] };
      render();
    },
    // visual check: a full discard pool laid out in suit columns, no pending tile
    debugPool: () => {
      game.discardLog = [];
      const base = [0, 9, 18, 27]; // 万 筒 条 字 starting ids
      const order = [3, 7, 1, 8, 0, 5, 2, 6, 4]; // scrambled, to show id-sorting
      for (let s = 0; s < 4; s++) for (let k = 0; k < 9; k++) {
        game.discardLog.push({ player: k % 4, kind: base[s] + (order[k] % (s === 3 ? 7 : 9)) });
      }
      game.phase = PHASE.AWAIT_DISCARD; game.claim = null; game.turn = HUMAN;
      render();
    },
    // visual check: the self-draw 胡 button (win available, not yet claimed)
    debugHu: () => {
      game.hands[HUMAN] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 26, 26];
      game.turn = HUMAN; game.phase = PHASE.AWAIT_DISCARD; game.drawnTile = 26; game.claim = null;
      game.selfDrawWin = { score: 8, fans: ['龙'], decomp: null };
      render();
    },
    // visual check: 金杠 available (four 混儿 held)
    debugGold: () => {
      const w = game.wilds[1];
      game.hands[HUMAN] = [w, w, w, w, 0, 1, 2, 9, 10, 11, 18, 19, 20, 26];
      game.turn = HUMAN; game.phase = PHASE.AWAIT_DISCARD; game.drawnTile = 26; game.claim = null; game.selfDrawWin = null;
      render();
    },
    // visual check: a 混吊 win — the 混 (here 1万) stands in the 9条 pair but is
    // shown with its original 1万 face + 混 badge, not as 9条.
    debugWin: () => {
      game.wilds = [0, 1]; game.wildSet = new Set([0, 1]);
      game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 0];
      game.melds[HUMAN] = [];
      game.dealer = 1; // 下家 is 庄 — exercises the crown + 庄x2 on a non-winner
      game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      game.result = {
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
      showResult();
    },
    // visual/e2e check: fill four 圈 then open the 一锅最终成绩 board (human = 🥇).
    debugFinal: () => {
      session.rounds = [
        { wind: 0, scores: [6, -2, -2, -2] },
        { wind: 1, scores: [3, 1, -1, -3] },
        { wind: 2, scores: [9, -1, -3, -5] },
        { wind: 3, scores: [12, -3, -4, -5] },
      ];
      game.scores = session.rounds[3].scores.slice();
      showFinalBoard();
    },
    // e2e: deal a real hand with the human 拉庄 vs 庄 = 下家(1) (exercises the backend 拉庄 flow).
    dealLz: () => { lzTestChoice = true; session.dealer = 1; startHand(); },
    // e2e: append the live game's scores to 历史战绩 (the 锅-completion record path).
    recordPot: () => recordPotHistory(),
    // e2e/visual: the 拉庄 confirmation panel (records the click on window.__lz).
    debugLzPanel: () => showLaZhuangPanel(1, [HUMAN], {}, (yes) => { window.__lz = yes; }),
    // visual/e2e: a 拉庄 win — human (0) 拉庄 vs 庄 = 下家(1); the 下家 row carries 庄x2 +
    // 拉庄x2 (12 = 2×4) and the human's plate/scoreboard show ⚔️.
    debugLzWin: () => {
      game.wilds = [0, 1]; game.wildSet = new Set([0, 1]);
      game.laZhuang = [HUMAN]; game.dealer = 1;
      game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 0];
      game.melds[HUMAN] = [];
      game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      game.result = {
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
      showResult();
    },
    // e2e/visual: a 拉庄 win where BOTH the human and the 庄(下家) hold a 金杠 of the same
    // value. Against the 庄 the two 杠分 net to zero — the breakdown must still show the gain
    // (金杠 +16) and the loss (下家金杠 −16) as separate lines, not a vanished net.
    debugKongSplit: () => {
      game.wilds = [0, 1]; game.wildSet = new Set([0, 1]);
      game.laZhuang = [HUMAN]; game.dealer = 1;
      game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26, 0];
      game.melds[HUMAN] = [{ type: 'kong', kind: 0, tiles: [0, 0, 0, 0], concealed: true }]; // 金杠 (wild)
      game.melds[1] = [{ type: 'kong', kind: 1, tiles: [1, 1, 1, 1], concealed: true }];      // 庄 also 金杠
      game.melds[2] = []; game.melds[3] = [];
      game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      game.result = {
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
      showResult();
    },
    // e2e/visual: a 混吊 self-draw — the winning tile is itself a 混儿 closing the 将 (a pair
    // of two 混儿). The highlight must land on a 混 IN THE PAIR (the group the engine flags via
    // winGroupIdx), not on a 混 used inside an earlier meld.
    debugHunDiao: () => {
      game.wilds = [0, 1]; game.wildSet = new Set([0, 1]);
      game.laZhuang = []; game.dealer = 0;
      // 3 natural chows + a chow that consumes a 混 (id 0) + the 将 of two 混儿 (ids 0,0).
      game.hands[HUMAN] = [3, 4, 5, 6, 7, 8, 12, 13, 14, 0, 16, 17, 0, 0];
      game.melds[HUMAN] = []; game.melds[1] = []; game.melds[2] = []; game.melds[3] = [];
      game.phase = PHASE.OVER;
      const S = (...a) => new Set(a);
      game.result = {
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
      showResult();
    },
  };
}
