// Tianjin mahjong — UI glue: drives the 3D scene (scene.js), the HTML HUD, input
// (touch raycast / keyboard / Xbox controller) and the turn orchestration that
// paces the AI so the human can follow along.
import { Game, PHASE, tileName } from './engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS, LEVEL_NAMES } from './ai.js';
import { MahjongScene } from './scene.js';
import { MahjongScene2D } from './scene2d.js';
import { Sound } from './sound.js';
import { buildOrder } from './handorder.js';
import { $, faceTileEl, mkBtn, makeToast, bindKeys, startGamepad, forceLandscape, showClaimArrow, renderSeatHands, SEAT_PORTRAIT } from './ui-util.js';

const sound = new Sound();
const toast = makeToast();

const HUMAN = 0;
// Relative seat names from the human's perspective (play order 0→1→2→3).
const SEAT_LABEL = ['玩家', '下家', '对家', '上家'];
const WIND = ['东', '南', '西', '北'];

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
const DISCARD_DEMO_MS = 1100; // 0.4s rise + ~0.7s halt at the center
const DISCARD_SETTLE_MS = 360;
let fastMode = localStorage.getItem('mahjong-fast') === '1';

let game = null;
let scene = null;             // MahjongScene (3D table)
let level = LEVELS.NORMAL;
let session = loadSession();   // { scores, dealer, prevailingWind, hand }
let selIndex = 0;              // cursor into the human's selectable (non-wild) tiles
let drawnWildSelected = false; // a freshly-drawn 混儿 is the lifted tile (can't discard)
let focusIndex = 0;           // cursor into action-bar buttons (claims)
let pendingTimer = null;
let lastLogLen = 0;
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
    if (s && Array.isArray(s.scores)) return s;
  } catch {}
  return { scores: [0, 0, 0, 0], dealer: 0, prevailingWind: 0, hand: 1 };
}
function saveSession() {
  session.scores = game ? game.scores.slice() : session.scores;
  localStorage.setItem('mahjong-session', JSON.stringify(session));
  localStorage.setItem('mahjong-level', String(level));
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
  $('round-info').innerHTML =
    `<b>${WIND[session.prevailingWind]}圈</b> · 第 ${session.hand} 局 · ` +
    `难度 <b>${LEVEL_NAMES[level]}</b>`;
  const scoresEl = $('scores');
  scoresEl.innerHTML = '';
  for (let p = 0; p < 4; p++) {
    const chip = document.createElement('div');
    chip.className = 'score-chip' + (p === game.dealer ? ' dealer' : '');
    const pts = game.scores[p];
    chip.innerHTML = `<span class="nm">${SEAT_LABEL[p]}</span> ` +
      `<span class="pt ${pts < 0 ? 'neg' : ''}">${pts >= 0 ? '+' : ''}${pts}</span>`;
    scoresEl.appendChild(chip);
  }

  // ---- the round's two 混儿 (e.g. 7万 + 8万), shown with their real faces ----
  const wc = $('wild-indicator');
  wc.innerHTML = '';
  for (const w of game.wilds) wc.appendChild(faceTileEl(w, { wild: true }));
  $('wall-count').textContent = `余 ${game.wall.length} 张`;

  // ---- nameplates ----
  for (let p = 0; p < 4; p++) renderPlate(p);
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
    selRendered: mt && !revealing ? selRendered : null,
    claimable: !animating && isClaimPhase(),
    drawnTile: (mt && game.drawnTile != null) ? game.drawnTile : null,
    reveal: game.phase === PHASE.OVER,
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
  showClaimArrow(animating ? null : scene); // points from the discarder to the centred pending tile
}

function renderPlate(p) {
  const seat = $('plate-' + p);
  const thinking = game.phase !== PHASE.OVER && game.turn === p && p !== HUMAN;
  const isDealer = p === game.dealer;
  seat.innerHTML =
    `<div class="nameplate${game.turn === p && game.phase !== PHASE.OVER ? ' active' : ''}${isDealer ? ' dealer' : ''}">` +
    (SEAT_PORTRAIT[p] ? `<span class="portrait">${SEAT_PORTRAIT[p]}</span>` : '') +
    (isDealer ? '<span class="crown" title="庄家">👑</span>' : '') +
    `<span class="wind">${WIND[game.seatWind(p)]}</span>` +
    `<span>${SEAT_LABEL[p]}</span>` +
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
  } else if (game.phase !== PHASE.OVER) {
    hint.textContent = `${SEAT_LABEL[game.turn]} 行动中…`;
  }

  if (focusIndex >= buttons.length) focusIndex = buttons.length - 1;
  buttons.forEach((b, i) => { if (i === focusIndex && isClaimPhase()) b.classList.add('focus'); bar.appendChild(b); });
}

function isClaimPhase() { return game.phase === PHASE.AWAIT_CLAIM && game.claim && game.claim.player === HUMAN; }

// ---------------------------------------------------------------------------
// Toasts for 碰 / 杠 / 自摸 / 荒
// ---------------------------------------------------------------------------
function flushLogToasts() {
  for (let i = lastLogLen; i < game.log.length; i++) {
    const line = game.log[i];
    // the claim log line starts with the seat's WIND (东/南/西/北) — map it back to the
    // seat index so the call is spoken in that seat's voice.
    const tok = line.split(' ')[0];
    let seat = 0; for (let p = 0; p < 4; p++) if (WIND[game.seatWind(p)] === tok) { seat = p; break; }
    if (/自摸/.test(line)) { toast(line, true); (game.result && game.result.winner === HUMAN ? sound.win() : sound.lose()); }
    else if (/荒牌/.test(line)) { toast(line, true); sound.drawGame(); }
    else if (/杠/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.kong(); sound.voice('kong', seat); }
    else if (/碰/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.pung(); sound.voice('pung', seat); }
  }
  lastLogLen = game.log.length;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
function tick() {
  render();
  if (game.phase === PHASE.OVER) { showResult(); return; }

  if (game.phase === PHASE.AWAIT_CLAIM) {
    if (game.claim.player === HUMAN) { focusIndex = 0; render(); return; } // wait for human
    schedule(() => {
      const c = game.claim;
      const dec = chooseClaim(game, c.player, c, level);
      if (dec) {
        game.claimDiscard(dec);
        if (scene) { // show the bot's 碰/杠 off, then HOLD all logic until it settles
          scene.beginClaimDemo(c.player, CLAIM_DEMO_MS);
          render();                                        // lift the meld + play the voice now
          schedule(tick, CLAIM_DEMO_MS + CLAIM_SETTLE_MS); // pause draws/turns until the animation ends
          return;
        }
      } else game.passClaim();
      tick();
    }, AI_DELAY);
    return;
  }

  if (game.phase === PHASE.AWAIT_DISCARD) {
    if (game.turn === HUMAN) { ensureSelection(); render(); return; } // wait for human (胡 button or discard)
    schedule(() => {
      const p = game.turn;
      if (game.selfDrawWin) { game.declareWin(); tick(); return; } // bots take their self-draw win
      const kong = chooseSelfKong(game, p, level);
      if (kong !== null) { game.selfKong(p, kong); tick(); return; }
      const dt = chooseDiscard(game, p, level);
      game.discard(p, dt);
      sound.discard();
      sound.say(tileName(dt), p); // speak the discarded tile in the bot's voice
      if (scene && !FAST && !fastMode) { // fly the discard to the center halt, hold, then drop to pool
        animating = true;
        scene.beginDiscardDemo(p, game.discardLog.length - 1, DISCARD_DEMO_MS);
        render();                                              // place the flying tile; claim UI suppressed
        schedule(() => { animating = false; tick(); }, DISCARD_DEMO_MS + DISCARD_SETTLE_MS);
        return;
      }
      tick();
    }, AI_DELAY);
  }
}

function schedule(fn, delay) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(fn, delay);
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
  if (dealing || animating) return;
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  const id = renderedHand()[renderedIdx];
  if (id == null) return;
  if (game.isWild(id)) { toast('混儿不能打出'); return; } // 混儿 (incl. the drawn one): complain, no action
  const wasWildSel = drawnWildSelected;
  drawnWildSelected = false;                  // picking a normal tile drops the drawn-混儿 selection
  const pos = selectableHandIndices().indexOf(renderedIdx);
  if (pos < 0) return;
  if (pos === selIndex && !wasWildSel) discardSelected(); // second tap on the lifted tile confirms
  else { selIndex = pos; sound.select(); render(); }
}

function discardSelected() {
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  if (drawnWildSelected) { toast('混儿不能打出'); return; } // the lifted tile is the drawn 混儿
  const hand = renderedHand();
  const sel = selectableHandIndices();
  const id = hand[sel[selIndex]];
  if (id == null || game.isWild(id)) return;
  game.discard(HUMAN, id);
  sound.discard();
  sound.say(tileName(id), HUMAN); // speak the discarded tile in the player's voice
  selIndex = Math.min(selIndex, selectableHandIndices().length - 1);
  tick();
}

function doDeclareWin() {
  if (scene && scene.handDrawRevealing) return; // wait until the drawn tile settles
  if (game.declareWin()) tick();
}
// When the freshly-drawn tile finishes its reveal, auto-select it (ready to discard).
// A drawn 混儿 is selected too (lifted/highlighted) but isn't discardable — it stays
// flagged so confirm/tap on it just complains; picking any normal tile clears it.
function selectDrawnTile() {
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || game.drawnTile == null) return;
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
  game.selfKong(HUMAN, kind);
  tick();
}
function doClaim(type) {
  if (!isClaimPhase()) return;
  if (!game.claim.options.includes(type)) return;
  game.claimDiscard(type);
  // After 碰/杠 the player must discard — default-select the first non-混 tile. (A 杠's
  // replacement draw re-fires selectDrawnTile afterwards, which overrides this.)
  selIndex = 0; drawnWildSelected = false;
  tick();
}
function doPass() {
  if (!isClaimPhase()) return;
  game.passClaim();
  tick();
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
  // Highlight the winning (drawn) tile: a 混 if it was wild, else the natural tile
  // in the very group it completed (winGroupIdx, from the scored decomposition) so
  // we glow the 6筒 in the 将 rather than an identical 6筒 elsewhere. 'called' groups
  // never hold it; mark exactly one tile.
  const winKind = r.winningTile;
  const winIsWild = winKind != null && game.isWild(winKind);
  const winGrp = (r.decomp && r.meta && r.meta.winGroupIdx >= 0) ? r.decomp[r.meta.winGroupIdx] : null;
  let winMarked = false;
  const addGroup = (tiles, extra, parent = handEl, srcGroup = null) => {
    const wrap = document.createElement('div');
    wrap.className = 'meld-group' + (extra || '');
    // wild slots show the original 混 face; natural slots show their own tile.
    for (const t of tiles) {
      const el = faceTileEl(t.wild ? wildFace() : t.kind, { lg: true, wild: t.wild });
      if (!winMarked && winKind != null && srcGroup !== 'called') {
        const hit = winIsWild
          ? t.wild
          : (!t.wild && t.kind === winKind && (winGrp ? srcGroup === winGrp : true));
        if (hit) { el.classList.add('win-tile'); winMarked = true; }
      }
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
      if (!winMarked && winKind != null && (winIsWild ? t.wild : (!t.wild && t.kind === winKind && (winGrp ? t.g === winGrp : true)))) {
        el.classList.add('win-tile'); winMarked = true;
      }
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
    renderWinningHand(handEl, w, r);
    payEl.innerHTML = breakdownHtml(r);
  }
  renderSeatHands(game, (id) => game.isWild(id)); // reveal every seat's hand on its border
  saveSession();
  ov.classList.remove('hidden');
  resultFocus = 0; focusResultBtn(); // 下一局 focused by default
}

// 得分明细 for the result panel. First the overall result — every seat's net laid out as
// a 3×3 grid mirroring the table (对家 top, 上家 left, 下家 right, 玩家 bottom) — then the
// human's own breakdown: net vs each opponent with 胡 / 明杠 / 暗杠 / 金杠 as subitems and a
// 庄x2 tag where the flow is to/from the 庄家. Mirrors _settle + _settleKongs (庄家加倍).
function breakdownHtml(r) {
  const me = HUMAN, dealer = game.dealer, dd = game.dealerDouble;
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
  const dbl = (q) => (dd && (me === dealer || q === dealer)) ? 2 : 1;
  let total = 0;
  const grps = [1, 2, 3].map((off) => {
    const q = (me + off) % 4, f = dbl(q);
    const km = KT[me], kq = KT[q];
    const subs = [];
    const hu = winner === me ? score * f : winner === q ? -score * f : 0;
    if (hu) subs.push(['胡', hu]);
    const open = (km.open - kq.open) * f; if (open) subs.push(['明杠', open]);
    const conc = (km.conc - kq.conc) * f; if (conc) subs.push(['暗杠', conc]);
    const gold = (km.gold - kq.gold) * f; if (gold) subs.push(['金杠', gold]);
    const net = subs.reduce((s, [, v]) => s + v, 0); total += net;
    const tag = f === 2 ? ' <span class="dbl">庄x2</span>' : '';
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

function nextHand() {
  $('result-overlay').classList.add('hidden');
  const nextDealer = game.nextDealer();
  // Advance prevailing wind after the dealer button completes a lap back to seat 0.
  session.hand += 1;
  if (nextDealer === 0 && game.dealer !== 0) {
    session.prevailingWind = (session.prevailingWind + 1) % 4;
  }
  session.dealer = nextDealer;
  startHand();
}

function startHand() {
  clearTimeout(pendingTimer);
  if (!scene) { scene = new Renderer($('scene')); scene.setRotated(isPortrait); scene.resize(); scene.onHandDrawSettled = selectDrawnTile; }
  game = new Game({
    dealer: session.dealer,
    prevailingWind: session.prevailingWind,
    scores: session.scores,
  });
  lastLogLen = 0;
  selIndex = 0; focusIndex = 0; drawnWildSelected = false;
  saveSession();
  // Deal the hand with a serving flourish (tiles fly from the wall), then play.
  // Under ?fast=1 (tests) skip straight to play so the timing stays tight.
  if (scene && !FAST) {
    dealing = true;
    renderHud();
    $('action-bar').innerHTML = '';
    $('ting-center').innerHTML = '';
    $('hand-hint').textContent = '发牌中…';
    scene.beginDeal(game, () => { dealing = false; tick(); }, () => sound.select());
  } else {
    tick();
  }
}

// Touch / mouse on the 3D table → raycast → select the picked hand tile.
$('scene').addEventListener('pointerdown', (e) => {
  if (!scene || !gameStarted || dealing || animating) return;
  sound.resume(); // touch is a user gesture — unlock audio
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx != null) onPickTile(idx);
});
// PC only: hovering a hand tile selects it (same as a click-to-select). Mouse-only
// so touch is unaffected; 混儿 aren't selectable so hovering them is ignored.
$('scene').addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !scene || !gameStarted || dealing || animating) return;
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || scene.handDrawRevealing) return;
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx == null) return;
  const pos = selectableHandIndices().indexOf(idx);
  if (pos >= 0 && (pos !== selIndex || drawnWildSelected)) { drawnWildSelected = false; selIndex = pos; sound.select(); render(); }
});

function newGame() {
  // Drop the finished game first: saveSession() derives session.scores from the
  // live game, so leaving the old one around would overwrite the reset scores.
  game = null;
  session = { scores: [0, 0, 0, 0], dealer: 0, prevailingWind: 0, hand: 1 };
  startHand(); // builds a fresh game from the zeroed session, then persists it
}

// ---------------------------------------------------------------------------
// Input: unified action dispatch from keyboard + gamepad
// ---------------------------------------------------------------------------
function onAction(name) {
  if (!gameStarted) return;
  sound.resume(); // a key/pad press is a user gesture — unlock audio
  if (!$('menu-overlay').classList.contains('hidden') ||
      !$('rules-overlay').classList.contains('hidden') ||
      !$('start-overlay').classList.contains('hidden')) {
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
    else if (name === 'left') { drawnWildSelected = false; selIndex = (selIndex - 1 + n) % n; sound.select(); render(); }
    else if (name === 'right') { drawnWildSelected = false; selIndex = (selIndex + 1) % n; sound.select(); render(); }
    else if (name === 'confirm') discardSelected();
    else if (name === 'kong') { const o = game.selfKongOptions(HUMAN)[0]; if (o) doSelfKong(o.kind); }
    else if (name === 'menu') openMenu();
    else if (name === 'cancel') openMenu();
    return;
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
  $('back-hub-btn').addEventListener('click', returnHub);
  fillRules();
}

// Leave the game for the main hub (../../ from games/<mode>/).
function returnHub() { location.href = '../../'; }

// Keyboard/gamepad focus between the result panel's two buttons (下一局 / 返回).
let resultFocus = 0;
function focusResultBtn() {
  const btns = [$('next-hand-btn'), $('back-hub-btn')];
  btns.forEach((b, i) => b && b.classList.toggle('focus', i === resultFocus));
  btns[resultFocus] && btns[resultFocus].focus();
}

bindUI();

// Debug hook (only under ?fast=1) for visual checks.
if (new URLSearchParams(location.search).get('fast')) {
  window.__mj = {
    humanTurn: () => !!game && game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD,
    // emulate a real user: a drawn 混儿 can't be discarded, so fall back to a non-wild tile
    discard: () => { drawnWildSelected = false; discardSelected(); },
    scene: () => scene,
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
  };
}
