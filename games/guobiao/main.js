// 国标麻将 — UI glue. Reuses the mahjong rendering (scene.js), audio (sound.js)
// and hand-order (handorder.js) layers; brings its own rules engine + AI and the
// claim-queue orchestration (胡 > 碰/杠 > 吃 priority, win off discards, 听).
import { Game, PHASE, tileName, MIN_FAN } from './engine.js';
import { chooseDiscard, chooseClaim, chooseSelfKong, LEVELS, LEVEL_NAMES } from './ai.js';
import { MahjongScene, tileFaceUrl } from '../mahjong/scene.js';
import { Sound } from '../mahjong/sound.js';
import { buildOrder } from '../mahjong/handorder.js';
import { suitOf, rankOf } from '../mahjong/engine.js';

const sound = new Sound();
const HUMAN = 0;
const SEAT_LABEL = ['你', '下家', '对家', '上家'];
const WIND = ['东', '南', '西', '北'];
const AI_DELAY = new URLSearchParams(location.search).get('fast') ? 35 : 650;
const $ = (id) => document.getElementById(id);

// Per-page config (set by each index.html before this module loads). The 无定番
// variant uses minFan: 0 and its own storage key so the two games keep separate
// scores. Defaults to standard MCR.
const CFG = window.MJ_CONFIG || { minFan: MIN_FAN, sessionKey: 'guobiao' };

let game = null, scene = null, level = LEVELS.NORMAL;
let session = loadSession();
let selIndex = 0, focusIndex = 0, pendingTimer = null, lastLogLen = 0, gameStarted = false;
let lockedTing = false, tingWaits = []; // once 听, the seat auto-plays (tsumogiri)

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

// ---- small DOM tile (result panel + 听 display) ----
const SUIT_CHAR = { m: '万', p: '筒', s: '条' };
const DRAGON_CLASS = ['z-c', 'z-f', 'z-b'];
function tileEl(id, opts = {}) {
  const el = document.createElement('div');
  el.className = 'tile' + (opts.size ? ' ' + opts.size : '');
  if (id < 27) { el.classList.add('suit-' + suitOf(id)); el.innerHTML = `<span class="rk">${rankOf(id)}</span><span class="st">${SUIT_CHAR[suitOf(id)]}</span>`; }
  else if (id < 31) { el.classList.add('honor', 'wind'); el.innerHTML = `<span class="rk">${WIND[id - 27]}</span>`; }
  else { el.classList.add('honor', DRAGON_CLASS[id - 31]); el.innerHTML = `<span class="rk">${['中', '發', '白'][id - 31]}</span>`; }
  return el;
}
function faceTileEl(kind, opts = {}) {
  const el = document.createElement('div'); el.className = 'tile face-tile' + (opts.lg ? ' lg' : '');
  const img = document.createElement('img'); img.className = 'face'; img.src = tileFaceUrl(kind); el.appendChild(img);
  return el;
}

// ---- hand order (no wilds → just sorted, drawn on the right) ----
const noWild = () => false;
function renderedHand() { return buildOrder(game.hands[HUMAN], noWild, game.turn === HUMAN ? game.drawnTile : null); }
function selectableHandIndices() { return renderedHand().map((_, i) => i); }

// ---- rendering ----
function render() {
  const minTxt = CFG.minFan > 0 ? `起和 ${CFG.minFan}番` : '无定番';
  $('round-info').innerHTML = `<b>${WIND[session.roundWind]}圈</b> · 第 ${session.hand} 局 · 难度 <b>${LEVEL_NAMES[level]}</b> · ${minTxt}`;
  const scoresEl = $('scores'); scoresEl.innerHTML = '';
  for (let p = 0; p < 4; p++) {
    const chip = document.createElement('div');
    chip.className = 'score-chip' + (p === game.dealer ? ' dealer' : '');
    const pts = game.scores[p];
    chip.innerHTML = `<span class="nm">${SEAT_LABEL[p]}</span> <span class="pt ${pts < 0 ? 'neg' : ''}">${pts >= 0 ? '+' : ''}${pts}</span>`;
    scoresEl.appendChild(chip);
  }
  $('wall-count').textContent = `余 ${game.wall.length} 张`;
  for (let p = 0; p < 4; p++) renderPlate(p);

  const selectable = selectableHandIndices();
  if (selIndex >= selectable.length) selIndex = Math.max(0, selectable.length - 1);
  const myTurn = game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD;
  const showSel = myTurn && !lockedTing; // no manual selection once 听
  if (scene) scene.sync(game, { renderedHand: renderedHand(), myTurn: showSel, selRendered: showSel ? selectable[selIndex] : null, claimable: isClaimPhase() && !lockedTing,
    drawnTile: (showSel && game.drawnTile != null) ? game.drawnTile : null });
  renderActions();
  positionClaimUI();
  flushLog();
}

// Pin the claim buttons (胡/碰/杠/吃/过) under the big pending tile (front-center).
// The 打出 button stays in the bottom bar; 打出并听牌 floats at screen center (CSS).
function positionClaimUI() {
  const hud = $('action-hud');
  if (scene && isClaimPhase() && !lockedTing) {
    const p = scene.worldToScreen(0, 0, 3.9);
    hud.classList.add('claim');
    hud.style.left = p.x + 'px'; hud.style.top = p.y + 'px';
    hud.style.bottom = 'auto'; hud.style.transform = 'translate(-50%, 0)';
  } else {
    hud.classList.remove('claim');
    hud.style.left = hud.style.top = hud.style.bottom = hud.style.transform = '';
  }
}

function renderPlate(p) {
  const seat = $('plate-' + p);
  const thinking = game.phase !== PHASE.OVER && game.turn === p && p !== HUMAN;
  const listen = p === HUMAN && (lockedTing || game.tenpaiInfo(p).tenpai);
  seat.innerHTML =
    `<div class="nameplate${game.turn === p && game.phase !== PHASE.OVER ? ' active' : ''}">` +
    `<span class="wind">${WIND[game.seatWind(p)]}</span><span>${SEAT_LABEL[p]}</span>` +
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
  const center = $('ting-center'); center.innerHTML = ''; // 打出并听牌 floats here
  const hint = $('hand-hint'); hint.textContent = '';
  const buttons = [];

  if (lockedTing) {
    // already 听 — the seat is on autopilot; never offer 吃/碰/杠/打出.
    hint.textContent = `已听 · 自动出牌（等 ${tingWaits.map(tileName).join(' ')}）`;
  } else if (game.phase === PHASE.AWAIT_CLAIM && game.currentClaim() && game.currentClaim().player === HUMAN) {
    const c = game.currentClaim();
    if (c.type === 'win') { buttons.push(mkBtn(`胡 (${c.result.fan}番)`, () => doClaimTake())); }
    else if (c.type === 'pung') buttons.push(mkBtn('碰', () => doClaimTake()));
    else if (c.type === 'kong') buttons.push(mkBtn('杠', () => doClaimTake()));
    else if (c.type === 'chow') {
      c.options.forEach((opt) => buttons.push(mkChowBtn(opt, game.lastDiscard.kind)));
    }
    buttons.push(mkBtn('过', () => doClaimPass(), true));
    hint.textContent = `${SEAT_LABEL[game.lastDiscard.player]} 打出 ${tileName(game.lastDiscard.kind)}`;
  } else if (game.phase === PHASE.AWAIT_DISCARD && game.turn === HUMAN) {
    for (const k of game.selfKongOptions(HUMAN)) buttons.push(mkBtn(`杠 ${tileName(k.kind)}`, () => doSelfKong(k.kind), true));
    buttons.push(mkBtn('打出', () => discardSelected(false)));
    // If the selected discard would leave a ready hand, float 打出并听牌 (declare
    // 听) at screen center. No text disclaimer — the red button is the 听 signal.
    const sel = renderedHand()[selectableHandIndices()[selIndex]];
    if (tingDiscards().some((t) => t.kind === sel)) {
      center.appendChild(mkBtn('打出并听牌', () => discardSelected(true), false, 'riichi'));
    }
  } else if (game.phase !== PHASE.OVER) {
    hint.textContent = `${SEAT_LABEL[game.turn]} 行动中…`;
  }
  if (focusIndex >= buttons.length) focusIndex = buttons.length - 1;
  buttons.forEach((b, i) => { if (i === focusIndex && isClaimPhase()) b.classList.add('focus'); bar.appendChild(b); });
}
function mkBtn(label, fn, ghost, extra) {
  const b = document.createElement('button'); b.className = 'act-btn' + (ghost ? ' ghost' : '') + (extra ? ' ' + extra : ''); b.textContent = label;
  b.addEventListener('click', fn); return b;
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
    if (/自摸|和牌/.test(line)) { toast(line, true); sound.win(); }
    else if (/荒牌/.test(line)) { toast(line, true); sound.drawGame(); }
    else if (/杠/.test(line)) { toast(line, false); sound.kong(); }
    else if (/碰/.test(line)) { toast(line, false); sound.pung(); }
    else if (/吃/.test(line)) { toast(line, false); sound.select(); }
  }
  lastLogLen = game.log.length;
}
let toastTimer = null;
function toast(msg, big) {
  const t = $('toast'); t.textContent = msg; t.className = 'show' + (big ? ' big' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = big ? 'big' : ''; }, 1100);
}

// ---- orchestration ----
function tick() {
  render();
  if (game.phase === PHASE.OVER) { showResult(); return; }
  if (game.phase === PHASE.AWAIT_CLAIM) {
    const c = game.currentClaim();
    if (c.player === HUMAN) {
      // Once 听, the human seat is on autopilot: take a 胡, pass everything else.
      if (lockedTing) { schedule(() => { if (c.type === 'win') game.claimTake(); else game.claimPass(); tick(); }, AI_DELAY); return; }
      focusIndex = 0; render(); return;
    }
    schedule(() => {
      const dec = chooseClaim(game, c.player, c, level);
      if (dec.take) game.claimTake(dec.option); else game.claimPass();
      tick();
    }, AI_DELAY);
    return;
  }
  if (game.phase === PHASE.AWAIT_DISCARD) {
    if (game.turn === HUMAN) {
      // Locked 听: auto-discard the drawn tile (a self-draw win already fired in
      // the engine), so the hand is preserved until it wins or the wall runs out.
      if (lockedTing) { schedule(() => { game.discard(HUMAN, game.drawnTile); sound.discard(); tick(); }, AI_DELAY); return; }
      render(); return;
    }
    schedule(() => {
      const p = game.turn;
      const kong = chooseSelfKong(game, p, level);
      if (kong != null) { game.selfKong(p, kong); tick(); return; }
      game.discard(p, chooseDiscard(game, p, level)); sound.discard(); tick();
    }, AI_DELAY);
  }
}
function schedule(fn, delay) { clearTimeout(pendingTimer); pendingTimer = setTimeout(fn, delay); }

// ---- human actions ----
function onPickTile(idx) {
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD || lockedTing) return;
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
  const id = renderedHand()[selectableHandIndices()[selIndex]];
  if (id == null) return;
  let waits = null;
  if (declare) {
    const rest = game.hands[HUMAN].slice(); rest.splice(rest.indexOf(id), 1);
    waits = game.handWaits(rest, HUMAN);
    if (!waits.length) declare = false; // safety: not actually 听 → plain discard
  }
  game.discard(HUMAN, id); sound.discard();
  selIndex = Math.min(selIndex, selectableHandIndices().length - 1);
  if (declare) { lockedTing = true; tingWaits = waits; toast('听！自动出牌', true); sound.startMusic(); }
  tick();
}
function doSelfKong(kind) { if (game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD) { game.selfKong(HUMAN, kind); tick(); } }
function doClaimTake(opt) { if (isClaimPhase()) { game.claimTake(opt); tick(); } }
function doClaimPass() { if (isClaimPhase()) { game.claimPass(); tick(); } }

// ---- result / new hand ----
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
    const hand = game.hands[w].slice().sort((a, b) => a - b);
    for (const id of hand) handEl.appendChild(faceTileEl(id, { lg: true }));
    for (const m of game.melds[w]) for (const t of m.tiles) handEl.appendChild(faceTileEl(t, { lg: true }));
    payEl.innerHTML = r.payments.map((amt, p) => `${SEAT_LABEL[p]} <b style="color:${amt >= 0 ? '#7ddf8a' : '#ef9a9a'}">${amt >= 0 ? '+' : ''}${amt}</b>`).join('　');
  }
  sound.stopMusic(); // 听 (if any) is over
  saveSession(); ov.classList.remove('hidden');
}
function nextHand() {
  $('result-overlay').classList.add('hidden');
  const nd = game.nextDealer();
  session.hand += 1;
  if (nd === 0 && game.dealer !== 0) session.roundWind = (session.roundWind + 1) % 4;
  session.dealer = nd;
  startHand();
}
function startHand() {
  clearTimeout(pendingTimer);
  if (!scene) scene = new MahjongScene($('scene'));
  game = new Game({ dealer: session.dealer, roundWind: session.roundWind, scores: session.scores, minFan: CFG.minFan });
  lastLogLen = 0; selIndex = 0; focusIndex = 0; lockedTing = false; tingWaits = [];
  sound.stopMusic();
  saveSession(); tick();
}
function newGame() { game = null; session = { scores: [0, 0, 0, 0], dealer: 0, roundWind: 0, hand: 1 }; startHand(); }

$('scene').addEventListener('pointerdown', (e) => {
  if (!scene || !gameStarted) return;
  sound.resume();
  if (game.turn !== HUMAN || game.phase !== PHASE.AWAIT_DISCARD) return;
  const idx = scene.pick(e.clientX, e.clientY);
  if (idx != null) onPickTile(idx);
});

// ---- input dispatch (keyboard + gamepad) ----
function onAction(name) {
  if (!gameStarted) return;
  sound.resume();
  if (!$('menu-overlay').classList.contains('hidden') || !$('rules-overlay').classList.contains('hidden') || !$('start-overlay').classList.contains('hidden')) {
    if (name === 'cancel' || name === 'menu') closeOverlays();
    return;
  }
  if (!$('result-overlay').classList.contains('hidden')) { if (name === 'confirm' || name === 'menu') nextHand(); return; }
  if (isClaimPhase()) {
    const btns = [...$('action-bar').children];
    if (name === 'left') { focusIndex = (focusIndex - 1 + btns.length) % btns.length; render(); }
    else if (name === 'right') { focusIndex = (focusIndex + 1) % btns.length; render(); }
    else if (name === 'confirm') btns[focusIndex]?.click();
    else if (name === 'cancel' || name === 'pass') doClaimPass();
    else if (name === 'menu') openMenu();
    return;
  }
  if (game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD && !lockedTing) {
    const n = selectableHandIndices().length;
    if (name === 'left') { selIndex = (selIndex - 1 + n) % n; sound.select(); render(); }
    else if (name === 'right') { selIndex = (selIndex + 1) % n; sound.select(); render(); }
    else if (name === 'confirm') discardSelected(false);
    else if (name === 'declare') discardSelected(true); // 打出并听牌 (falls back to plain if not 听)
    else if (name === 'kong') { const o = game.selfKongOptions(HUMAN)[0]; if (o) doSelfKong(o.kind); }
    else if (name === 'menu' || name === 'cancel') openMenu();
    return;
  }
  if (name === 'menu') openMenu();
}
addEventListener('keydown', (e) => {
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'left', ArrowDown: 'right', Enter: 'confirm', ' ': 'confirm', Escape: 'cancel', Backspace: 'pass', m: 'menu', M: 'menu', g: 'kong', G: 'kong', k: 'kong', K: 'kong', t: 'declare', T: 'declare' };
  const a = map[e.key]; if (a) { e.preventDefault(); onAction(a); }
});
const padPrev = {}; let axisLatch = false;
function pollGamepad() {
  const pad = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).find((p) => p && p.connected);
  if (pad) {
    const press = (i) => { const d = !!pad.buttons[i]?.pressed, was = padPrev[i]; padPrev[i] = d; return d && !was; };
    if (press(14) || press(12)) onAction('left');
    if (press(15) || press(13)) onAction('right');
    if (press(0)) onAction('confirm'); if (press(1)) onAction('cancel'); if (press(2)) onAction('declare'); if (press(3)) onAction('kong'); if (press(9)) onAction('menu');
    const x = pad.axes[0] || 0;
    if (Math.abs(x) > 0.5) { if (!axisLatch) { onAction(x < 0 ? 'left' : 'right'); axisLatch = true; } } else axisLatch = false;
  }
  requestAnimationFrame(pollGamepad);
}
requestAnimationFrame(pollGamepad);

// ---- overlays + boot ----
function openMenu() { $('menu-overlay').classList.remove('hidden'); }
function closeOverlays() { for (const id of ['menu-overlay', 'rules-overlay']) $(id).classList.add('hidden'); }
function fillRules() {
  $('rules-body').innerHTML = `
    <h3>基本</h3>136 张牌（无花）。可<b>吃、碰、杠</b>；和牌可<b>自摸</b>或<b>点炮</b>（食他人打出之牌）。
    <h3>起和</h3>${CFG.minFan > 0 ? `和牌至少 <b>${CFG.minFan} 番</b>（番种总和），不足则不可和。` : '<b>无定番</b>：任意番数（含 0 番）皆可和。'}
    <h3>番种</h3>采用国标 81 番的常见番种子集：清一色24、混一色6、碰碰和6、字一色88、清/混幺九、大小三元、大小四喜、
    四/三/双暗刻、三色三同顺8、花龙8、一色三步高16、平和2、门前清/不求人、五门齐6、箭/风/幺九刻、单钓/边/坎张等。
    <h3>计分</h3>和牌得 (番 + 8)；自摸三家各付，点炮则点炮者付 (番+8)，余两家各付 8。
    <h3>操作</h3>点牌选中、再点或按「打出」/<b>A</b> 出牌。轮到可<b>胡/碰/杠/吃</b>时点对应按钮，或<b>过</b>。`;
}
function bindUI() {
  $('level-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.level-btn'); if (!btn) return;
    [...$('level-row').children].forEach((c) => c.classList.remove('sel')); btn.classList.add('sel');
    level = parseInt(btn.dataset.level, 10);
  });
  [...$('level-row').children].forEach((c) => c.classList.toggle('sel', parseInt(c.dataset.level, 10) === level));
  $('start-btn').addEventListener('click', () => { $('start-overlay').classList.add('hidden'); gameStarted = true; sound.resume(); startHand(); });
  $('rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
  $('menu-rules-link').addEventListener('click', () => $('rules-overlay').classList.remove('hidden'));
  $('rules-close').addEventListener('click', () => $('rules-overlay').classList.add('hidden'));
  $('menu-btn').addEventListener('click', openMenu);
  const sb = $('sound-btn'); const upd = () => { sb.textContent = sound.muted ? '🔇' : '🔊'; };
  sb.addEventListener('click', () => { sound.resume(); sound.toggleMuted(); upd(); }); upd();
  $('resume-btn').addEventListener('click', closeOverlays);
  $('newgame-btn').addEventListener('click', () => { closeOverlays(); newGame(); });
  $('next-hand-btn').addEventListener('click', nextHand);
  fillRules();
}
bindUI();

if (new URLSearchParams(location.search).get('fast')) {
  window.__gb = {
    phase: () => game && game.phase,
    claim: () => game && game.currentClaim(),
    humanTurn: () => !!game && game.turn === HUMAN && game.phase === PHASE.AWAIT_DISCARD,
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
    debugResult: () => {
      game.phase = PHASE.OVER;
      game.result = { type: 'win', winner: HUMAN, fan: 24, byDiscard: false, winningTile: game.hands[HUMAN][0],
        fans: [{ name: '清一色', points: 24 }, { name: '碰碰和', points: 6 }], payments: [72, -24, -24, -24] };
      showResult();
    },
  };
}
