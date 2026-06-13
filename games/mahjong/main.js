// Tianjin mahjong — UI glue: drives the 3D scene (scene.js), the HTML HUD, input
// (touch raycast / keyboard / Xbox controller) and the turn orchestration that
// paces the AI so the human can follow along.
import { Game, PHASE, tileName } from './engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS, LEVEL_NAMES } from './ai.js';
import { MahjongScene } from './scene.js';
import { Sound } from './sound.js';
import { buildOrder } from './handorder.js';
import { $, faceTileEl, mkBtn, makeToast, bindKeys, startGamepad, forceLandscape } from './ui-util.js';

const sound = new Sound();
const toast = makeToast();

const HUMAN = 0;
// Relative seat names from the human's perspective (play order 0→1→2→3).
const SEAT_LABEL = ['你', '下家', '对家', '上家'];
const WIND = ['东', '南', '西', '北'];

// Pace between AI moves so the human can follow; `?fast=1` speeds it up for the
// automated e2e test.
const AI_DELAY = new URLSearchParams(location.search).get('fast') ? 35 : 600;

let game = null;
let scene = null;             // MahjongScene (3D table)
let level = LEVELS.NORMAL;
let session = loadSession();   // { scores, dealer, prevailingWind, hand }
let selIndex = 0;              // cursor into the human's selectable (non-wild) tiles
let focusIndex = 0;           // cursor into action-bar buttons (claims)
let pendingTimer = null;
let lastLogLen = 0;
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

// The human's display order: 混儿 on the left, the rest sorted with the freshly
// drawn tile on the right.
const isWildFn = (id) => game.isWild(id);
function renderedHand() { return buildOrder(game.hands[HUMAN], isWildFn, game.turn === HUMAN ? game.drawnTile : null); }

function render() {
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

  // ---- 3D table ----
  const selectable = selectableHandIndices();
  if (selIndex >= selectable.length) selIndex = Math.max(0, selectable.length - 1);
  const myTurn = game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD;
  if (scene) scene.sync(game, {
    renderedHand: renderedHand(),
    myTurn,
    selRendered: myTurn ? selectable[selIndex] : null,
    claimable: isClaimPhase(),
    drawnTile: (myTurn && game.drawnTile != null && !game.isWild(game.drawnTile)) ? game.drawnTile : null,
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
  if (scene && isClaimPhase()) {
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
  seat.innerHTML =
    `<div class="nameplate${game.turn === p && game.phase !== PHASE.OVER ? ' active' : ''}">` +
    `<span class="wind">${WIND[game.seatWind(p)]}</span>` +
    `<span>${SEAT_LABEL[p]}</span>` +
    (p === game.dealer ? '<span class="dealer-dot" title="庄"></span>' : '') +
    (thinking ? '<span class="think">思考中…</span>' : '') +
    `</div>`;
}

function renderActions() {
  const bar = $('action-bar');
  bar.innerHTML = '';
  const hint = $('hand-hint');
  hint.textContent = '';
  const buttons = [];

  if (game.phase === PHASE.AWAIT_CLAIM && game.claim && game.claim.player === HUMAN) {
    const c = game.claim;
    if (c.options.includes('pung')) buttons.push(mkBtn('碰', () => doClaim('pung')));
    if (c.options.includes('kong')) buttons.push(mkBtn('杠', () => doClaim('kong')));
    buttons.push(mkBtn('过', () => doPass(), true));
    hint.textContent = `${SEAT_LABEL[c.player === HUMAN ? game.lastDiscard.player : c.player]} 打出 ${tileName(c.kind)}`;
  } else if (game.phase === PHASE.AWAIT_DISCARD && game.turn === HUMAN) {
    // self-draw win available → offer 胡 (but you may still play on)
    if (game.selfDrawWin) {
      const w = game.selfDrawWin;
      buttons.push(mkBtn(`胡 · ${w.fans[0]} · ${w.score}分`, () => doDeclareWin(), false, 'hu'));
    }
    // self-kong options (金杠 = a concealed kong of four 混儿)
    for (const k of game.selfKongOptions(HUMAN)) {
      buttons.push(mkBtn(`${k.type === 'gold' ? '金杠' : '杠'} ${tileName(k.kind)}`, () => doSelfKong(k.kind), true));
    }
    buttons.push(mkBtn('打出', () => discardSelected()));
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
    if (/自摸/.test(line)) { toast(line, true); (game.result && game.result.winner === HUMAN ? sound.win() : sound.lose()); }
    else if (/荒牌/.test(line)) { toast(line, true); sound.drawGame(); }
    else if (/杠/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.kong(); }
    else if (/碰/.test(line)) { toast(line.split(' ').slice(1).join(' ')); sound.pung(); }
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
      if (dec) game.claimDiscard(dec); else game.passClaim();
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
      game.discard(p, chooseDiscard(game, p, level));
      sound.discard();
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
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  const id = renderedHand()[renderedIdx];
  if (id == null) return;
  if (game.isWild(id)) { toast('混儿不能打出'); return; }
  const pos = selectableHandIndices().indexOf(renderedIdx);
  if (pos < 0) return;
  if (pos === selIndex) discardSelected();   // second tap on the lifted tile confirms
  else { selIndex = pos; sound.select(); render(); }
}

function discardSelected() {
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  const hand = renderedHand();
  const sel = selectableHandIndices();
  const id = hand[sel[selIndex]];
  if (id == null || game.isWild(id)) return;
  game.discard(HUMAN, id);
  sound.discard();
  selIndex = Math.min(selIndex, selectableHandIndices().length - 1);
  tick();
}

function doDeclareWin() {
  if (game.declareWin()) tick();
}
function doSelfKong(kind) {
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  game.selfKong(HUMAN, kind);
  tick();
}
function doClaim(type) {
  if (!isClaimPhase()) return;
  if (!game.claim.options.includes(type)) return;
  game.claimDiscard(type);
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
  const addGroup = (tiles, extra) => {
    const wrap = document.createElement('div');
    wrap.className = 'meld-group' + (extra || '');
    // wild slots show the original 混 face; natural slots show their own tile.
    for (const t of tiles) wrap.appendChild(faceTileEl(t.wild ? wildFace() : t.kind, { lg: true, wild: t.wild }));
    handEl.appendChild(wrap);
  };
  if (!r.decomp) { // fallback: plain sorted hand
    addGroup(game.hands[w].slice().sort((a, b) => a - b).map((id) => ({ kind: id, wild: game.isWild(id) })));
    for (const m of game.melds[w]) addGroup(m.tiles.map((k) => ({ kind: k, wild: false })));
    return;
  }
  for (const m of game.melds[w]) addGroup(m.tiles.map((k) => ({ kind: k, wild: false })));
  let pair = null;
  for (const g of r.decomp) { if (g.type === 'pair') pair = pairTilesOf(g); else addGroup(meldTilesOf(g)); }
  if (pair) addGroup(pair, ' pair');
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
    payEl.innerHTML = hasPay ? '杠分　' + payHtml(r.payments) : '本局无人和牌';
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
    payEl.innerHTML = payHtml(r.payments);
  }
  saveSession();
  ov.classList.remove('hidden');
}

// Per-seat payment chips (the net includes 杠分 settled on top of the 胡分).
function payHtml(payments) {
  return payments.map((amt, p) =>
    `${SEAT_LABEL[p]} <b style="color:${amt >= 0 ? '#7ddf8a' : '#ef9a9a'}">${amt >= 0 ? '+' : ''}${amt}</b>`
  ).join('　');
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
  if (!scene) { scene = new MahjongScene($('scene')); scene.setRotated(isPortrait); scene.resize(); }
  game = new Game({
    dealer: session.dealer,
    prevailingWind: session.prevailingWind,
    scores: session.scores,
  });
  lastLogLen = 0;
  selIndex = 0; focusIndex = 0;
  saveSession();
  tick();
}

// Touch / mouse on the 3D table → raycast → select the picked hand tile.
$('scene').addEventListener('pointerdown', (e) => {
  if (!scene || !gameStarted) return;
  sound.resume(); // touch is a user gesture — unlock audio
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx != null) onPickTile(idx);
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
    if (name === 'confirm' || name === 'menu') nextHand();
    return;
  }

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
    else if (name === 'left') { selIndex = (selIndex - 1 + n) % n; sound.select(); render(); }
    else if (name === 'right') { selIndex = (selIndex + 1) % n; sound.select(); render(); }
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
    提溜（底）<code>1</code>，混吊 / 双混吊 / 双混儿 <code>×2</code>，素（没混儿）<code>×2</code>，
    捉五（独胡五万，五万/四六万可为混儿）<code>+3</code>，龙（一色 1-9）<code>+4</code>，本混龙（龙与混同色）<code>×2 → 8</code>，
    杠开 <code>×2</code>，天和/地和 <code>= 28（封顶）</code>。
    <h3>算番</h3>
    捉五、龙<b>相加</b>成底（无则底为 1，即提溜）；本混、混吊、素、杠开各<b>×2</b>。先加后乘。
    <b>起和 2 番</b>，不足 2 番为小和、不能胡。庄家加倍。
    <h3>杠分</h3>
    明杠 <code>+1</code>，暗杠 <code>+2</code>，金杠（暗杠四张混儿）<code>+4</code>。每家杠分由其它三家补，局末单独结算（不受坐庄翻倍，暂略）。
    <h3>操作</h3>
    自摸成胡时出现 <b>胡</b> 按钮（含番种与得分），点它才和牌，也可继续打牌；快捷键 <b>H</b>。
    点牌选中、再点或按「打出」/<b>A</b> 出牌；左右/摇杆移动光标。
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
  $('resume-btn').addEventListener('click', closeOverlays);
  $('newgame-btn').addEventListener('click', () => { closeOverlays(); newGame(); });
  $('next-hand-btn').addEventListener('click', nextHand);
  fillRules();
}

bindUI();

// Debug hook (only under ?fast=1) for visual checks.
if (new URLSearchParams(location.search).get('fast')) {
  window.__mj = {
    humanTurn: () => !!game && game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD,
    scene: () => scene,
    // visual check: melds for every seat + a full pool + a pending claim
    debugMelds: () => {
      for (let p = 0; p < 4; p++) game.melds[p] = [
        { type: 'pung', kind: p * 4, tiles: [p * 4, p * 4, p * 4] },
        { type: 'kong', kind: 9 + p * 3, tiles: [9 + p * 3, 9 + p * 3, 9 + p * 3, 9 + p * 3] },
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
        payments: [6, -2, -2, -2],
      };
      showResult();
    },
  };
}
