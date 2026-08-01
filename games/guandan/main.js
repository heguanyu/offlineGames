// 掼蛋 UI controller. Renders the read-only Round/Match from the backend, sends the human's moves
// through it (async), and reacts to the backend's awaited events — the same UI↔Backend split as the
// 斗地主 / mahjong games, so this whole layer is offline/online-agnostic.
import { createBackend, HUMAN } from './backend.js';
import { legalMoves, classify, rankLabel, isWild, teamOf, partnerOf, isBombType, COMBO } from './engine.js';
import { chooseMove, orderedHints, cleanestBeat } from './ai.js';
import { GuandanScene } from './scene.js';
import { GuandanScene2D } from './scene2d.js';
import { useFlatRenderer, applyFlatScale, mountPowerControl } from '../../shared/power-mode.js';
import { SmartSelection } from './select.js';
import { bestStacks, groupSelection, normalizeStacks, rankStacks, selectionCombo } from './arrange.js';
import { sfx, speak, setMuted, isMuted, resume } from './sound.js';

const $ = (id) => document.getElementById(id);
const FAST = new URLSearchParams(location.search).has('fast');
const AI_LEVEL = 2;
// Renderer choice driven by 省电模式 (shared/power-mode.js); ?flat=1 / ?d3=1 override (tests).
const FLAT = (() => {
  const p = new URLSearchParams(location.search);
  if (p.has('d3')) return false;
  if (p.has('flat')) return true;
  return useFlatRenderer();
})();
document.body.classList.toggle('flat', FLAT);

const LS = {
  get mute() { return localStorage.getItem('guandan-mute') === '1'; },
  set mute(v) { localStorage.setItem('guandan-mute', v ? '1' : '0'); },
  // Saved level-ladder progress (between rounds) — { teamLevel, hostTeam, lastOrder, roundIndex }.
  get progress() { try { return JSON.parse(localStorage.getItem('guandan-progress')); } catch { return null; } },
  set progress(v) { if (v) localStorage.setItem('guandan-progress', JSON.stringify(v)); else localStorage.removeItem('guandan-progress'); },
};
const SEAT_NAME = ['你', '右家', '对家', '左家'];
const TEAM_NAME = ['你方', '对方'];
const PLACE = ['头游', '二游', '三游', '末游'];

const state = {
  scene: null, backend: null,
  sel: new SmartSelection(),
  hint: new Set(),
  cursor: 0,
  trick: {},                  // seat -> cards currently on the felt
  discard: [],                // cards from completed tricks (face-down centre)
  reveal: false,
  places: {},                 // seat -> place index (0..3) as they finish
  phase: 'idle',
  awaiting: null,
  userTouched: false,
  hintMoves: null, hintIdx: -1,
  lastSettle: null,
  handStacks: [],
};

// On a phone held PORTRAIT, CSS-rotate <body> 90° so the game fills the screen as landscape.
function forceLandscape(apply) {
  const b = document.body;
  const update = () => {
    const portrait = window.innerHeight > window.innerWidth;
    if (portrait) {
      const w = window.innerWidth, h = window.innerHeight;
      Object.assign(b.style, { position: 'fixed', top: '0', left: '0', overflow: 'hidden', width: h + 'px', height: w + 'px', transformOrigin: '0 0', transform: `translateX(${w}px) rotate(90deg)` });
    } else {
      for (const k of ['position', 'top', 'left', 'overflow', 'width', 'height', 'transformOrigin', 'transform']) b.style[k] = '';
    }
    apply(portrait);
  };
  addEventListener('resize', update);
  addEventListener('orientationchange', () => setTimeout(update, 50));
  const resumeFn = () => { update(); setTimeout(update, 150); setTimeout(update, 450); };
  addEventListener('pageshow', resumeFn); addEventListener('focus', resumeFn);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeFn(); });
  update();
}

function boot() {
  state.scene = new (FLAT ? GuandanScene2D : GuandanScene)($('scene'));
  if (FLAT) forceLandscape((portrait) => { state.scene.setRotated(portrait); state.scene.resize(); if (state.backend) render(); });
  if (FLAT) applyFlatScale($('table')); // 省电 (2D) on a tablet: scale the flat board to fill the screen
  setMuted(LS.mute); $('mute-btn').textContent = LS.mute ? '🔇' : '🔊';
  refreshStartOverlay();
  $('start-btn').addEventListener('click', () => { resume(); $('start-overlay').hidden = true; newMatch(!!LS.progress); });
  $('reset-btn').addEventListener('click', () => { LS.progress = null; refreshStartOverlay(); });
  $('next-btn').addEventListener('click', () => { $('result-overlay').hidden = true; continueGame(); });
  $('result-home').addEventListener('click', () => { location.replace('../../index.html'); });
  $('mute-btn').addEventListener('click', () => { LS.mute = !isMuted(); setMuted(LS.mute); $('mute-btn').textContent = LS.mute ? '🔇' : '🔊'; });
  $('menu-btn').addEventListener('click', () => { $('menu-overlay').hidden = false; });
  mountPowerControl($('menu-home').parentNode, $('menu-home')); // 省电模式 picker, above 返回大厅
  $('menu-continue').addEventListener('click', () => { $('menu-overlay').hidden = true; });
  $('menu-restart').addEventListener('click', () => { LS.progress = null; $('menu-overlay').hidden = true; $('result-overlay').hidden = true; newMatch(false); });
  $('menu-home').addEventListener('click', () => { location.replace('../../index.html'); });
  $('auto-arrange-btn').addEventListener('click', autoArrange);
  $('group-btn').addEventListener('click', groupCards);

  $('scene').addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', positionOverlays);
  startPadPolling();
}

// Start a match. resume=true continues the saved level ladder; resume=false starts fresh (2/2) and
// clears any saved progress.
function newMatch(resume = false) {
  if (state.backend) state.backend.dispose();
  resetRoundState();
  state.lastSettle = null;
  const saved = resume ? LS.progress : null;
  if (!resume) LS.progress = null;
  state.backend = createBackend({ mode: 'local', aiLevel: AI_LEVEL, thinkDelay: thinkMs() });
  state.backend.onEvent(onEvent);
  clearBubbles();
  state.backend.newMatch({ aiLevel: AI_LEVEL, state: saved });
}
// Show the saved-ladder prompt on the start screen (継続 vs fresh 开始).
function refreshStartOverlay() {
  const p = LS.progress;
  const note = $('resume-note');
  if (p && p.teamLevel && p.teamLevel.length === 2) {
    note.hidden = false;
    note.innerHTML = `继续上局 · 你方 <b>${rankLabel(p.teamLevel[0])}</b> 级　对方 <b>${rankLabel(p.teamLevel[1])}</b> 级`;
    $('start-btn').textContent = '继续'; $('reset-btn').hidden = false;
  } else {
    note.hidden = true; $('start-btn').textContent = '开始'; $('reset-btn').hidden = true;
  }
}
function continueGame() {
  // after a round: a champion ends the match → start a fresh ladder; otherwise deal the next round.
  if (state.lastSettle && state.lastSettle.champion >= 0) { newMatch(); return; }
  resetRoundState(); clearBubbles();
  state.backend.nextRound();
}
function resetRoundState() {
  state.sel.clear(); state.hint.clear(); state.trick = {}; state.discard = [];
  state.reveal = false; state.places = {}; state.cursor = 0; state.phase = 'idle'; state.awaiting = null;
  state.handStacks = [];
}
function thinkMs() { return FAST ? 70 : 620; }

// ---- backend events --------------------------------------------------------
async function onEvent(ev) {
  const st = state.backend.getState();
  const g = st && st.round;
  switch (ev.type) {
    case 'deal': {
      resetRoundState(); clearBubbles();
      state.scene.setLevel(ev.level);
      state.handStacks = rankStacks(g.hands[HUMAN]);
      const dealt = state.scene.beginDeal({ hand: g.hands[HUMAN], counts: g.handCounts, fast: FAST });
      sfx.deal(); render();
      await dealt; render();
      break;
    }
    case 'tribute': {
      showTribute(ev); sfx.tribute();
      render();
      await wait(FAST ? 200 : 2400);
      hideTribute(); render();
      break;
    }
    case 'roundStart':
      state.phase = 'play'; render(); break;
    case 'play': {
      state.trick[ev.seat] = ev.cards;
      const dur = announcePlay(ev); clearBubble(ev.seat);
      if (ev.seat === HUMAN) { state.sel.clear(); state.hint.clear(); }
      render();
      if (dur) await wait(dur);
      break;
    }
    case 'pass': {
      bubble(ev.seat, '不要', true);
      const dur = speak(['不要'], ev.seat);
      render();
      if (dur) await wait(Math.min(dur, 500));
      break;
    }
    case 'finish': {
      state.places[ev.seat] = ev.place - 1;
      bubble(ev.seat, PLACE[ev.place - 1], false);
      speak([PLACE[ev.place - 1]], ev.seat);
      render();
      await wait(FAST ? 120 : 600);
      break;
    }
    case 'trickEnd': {
      // A CONTESTED trick (more than one seat played) holds so the battle is readable. An
      // UNCONTESTED win (everyone just passed) doesn't stall before the next free lead — and when
      // the human is the one about to free-play, there's no wait at all, so running the table is snappy.
      const contested = Object.keys(state.trick).length > 1;
      const ms = contested ? (FAST ? 360 : 1500) : (ev.winner === HUMAN ? 0 : (FAST ? 100 : 280));
      if (ms) await wait(ms);
      flushTrickToDiscard(); clearBubbles(); render(); break;
    }
    case 'await': {
      state.awaiting = 'play'; state.cursor = Math.min(state.cursor, g.hands[HUMAN].length - 1);
      state.sel.setHand(g.hands[HUMAN]);
      const handIds = new Set(g.hands[HUMAN].map((card) => card.id));
      if (state.sel.ids.length && state.sel.ids.every((id) => handIds.has(id))) {
        state.userTouched = true; resetHint();
      } else autoSelect(g);
      showPlayBar(); render(); break;
    }
    case 'over':
      state.awaiting = null; state.reveal = true; hideActions(); render(); showResult(ev.result); break;
  }
}

function flushTrickToDiscard() {
  for (const seat in state.trick) for (const c of state.trick[seat]) state.discard.push(c);
  state.trick = {};
}

// ---- announce / voice ------------------------------------------------------
const SEQ_TYPES = new Set([COMBO.STRAIGHT, COMBO.PLATE, COMBO.TUBE, COMBO.STRAIGHT_FLUSH]);
// rank -> spoken word (the 斗地主 nicknames: J→勾, Q→圈, A→尖; 2→二; jokers 小王/大王).
const RANK_WORD = { 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十', 11: '勾', 12: '圈', 13: 'K', 14: '尖', 16: '小王', 17: '大王' };
// The rank a single/pair/trip "represents" — the natural card's rank (or the level rank if all wild).
function comboRank(cards, level) { const nat = cards.find((c) => !isWild(c, level)); return nat ? nat.rank : level; }
// Token sequence for a played combo (resolved to clips by sound.js's SLUG; combo callouts carry ！).
function speakMove(d, cards, level) {
  const R = RANK_WORD[comboRank(cards, level)] || '';
  switch (d.type) {
    case COMBO.SINGLE: return [R];
    case COMBO.PAIR: return ['俩' + R];
    case COMBO.TRIO: return ['仨' + R];
    case COMBO.TRIO_PAIR: return ['三带二！'];
    case COMBO.STRAIGHT: return ['顺子！'];
    case COMBO.TUBE: return ['钢板！'];
    case COMBO.PLATE: return ['三连对！'];
    case COMBO.STRAIGHT_FLUSH: return ['同花顺！'];
    case COMBO.BOMB: return ['炸弹！'];
    case COMBO.JOKER_BOMB: return ['王炸！'];
    default: return [d.name || ''];
  }
}
function announcePlay(ev) {
  const d = ev.move;
  if (isBombType(d.type)) { sfx.bomb(); state.scene.bombFx?.(); }
  else if (SEQ_TYPES.has(d.type)) { sfx.flush(); state.scene.flushFx?.(); }
  else sfx.play();
  return speak(speakMove(d, ev.cards, state.backend.getState().level), ev.seat);
}

// ---- tribute notice --------------------------------------------------------
function showTribute(ev) {
  hideTribute();
  const box = document.createElement('div'); box.id = 'tribute-toast'; box.className = 'toast';
  if (ev.plan.antiTribute) {
    box.innerHTML = `<div class="toast-t">抗贡</div><div class="toast-b">败方握有双大王，本局免进贡</div>`;
  } else {
    const lines = ev.exchanges.map((x) => {
      const give = cardText(x.tributeCard); const back = x.returnCard ? cardText(x.returnCard) : '—';
      return `<div class="toast-row">${SEAT_NAME[x.from]} 进贡 <b>${give}</b> → ${SEAT_NAME[x.to]}，回礼 <b>${back}</b></div>`;
    }).join('');
    box.innerHTML = `<div class="toast-t">进贡 / 还贡</div><div class="toast-b">${lines}</div>`;
  }
  $('table').appendChild(box);
}
function hideTribute() { const b = $('tribute-toast'); if (b) b.remove(); }
function cardText(c) { return c.rank >= 16 ? (c.rank === 17 ? '大王' : '小王') : (['♠', '♥', '♣', '♦'][c.suit] + rankLabel(c.rank)); }

// ---- rendering -------------------------------------------------------------
function render() {
  const st = state.backend && state.backend.getState();
  const g = st && st.round;
  if (!g) return;
  state.scene.setLevel(st.level);
  const hand = g.hands[HUMAN] || [];
  state.handStacks = normalizeStacks(hand, state.handStacks, st.level);
  const table = Object.entries(state.trick).map(([seat, cards]) => ({ seat: +seat, cards }));
  state.scene.sync({
    hand, handStacks: state.handStacks, selected: state.sel.selected, hint: state.hint,
    counts: g.handCounts, turn: g.turn, leadSeat: g.leadSeat, phase: g.phase,
    table, discard: state.discard,
    revealHands: state.reveal ? { 1: g.hands[1], 2: g.hands[2], 3: g.hands[3] } : null,
  });
  positionOverlays();
  updateRoundInfo(st);
  updateScoreboard(st);
  refreshHandTools(g, st.level);
  if (state.awaiting === 'play') refreshPlayBar();
}

function refreshHandTools(g, level) {
  const hand = g.hands[HUMAN] || [];
  $('hand-tools').hidden = g.phase !== 'play' || hand.length === 0;
  $('auto-arrange-btn').disabled = g.phase !== 'play' || hand.length === 0;
  $('group-btn').disabled = !selectionCombo(hand, state.sel.ids, level);
}

function autoArrange() {
  const st = state.backend && state.backend.getState();
  const g = st && st.round;
  if (!g || g.phase !== 'play' || !g.hands[HUMAN].length) return;
  state.handStacks = bestStacks(g.hands[HUMAN], st.level);
  state.sel.clear(); state.hint.clear(); state.userTouched = true; resetHint(); render();
}

function groupCards() {
  const st = state.backend && state.backend.getState();
  const g = st && st.round;
  if (!g || !selectionCombo(g.hands[HUMAN], state.sel.ids, st.level)) return;
  state.handStacks = groupSelection(g.hands[HUMAN], state.handStacks, state.sel.ids, st.level);
  state.userTouched = true; resetHint(); render();
}

// Team-level scoreboard (top-right): each team's grade, 庄 on the host team, current-round level.
function updateScoreboard(st) {
  const lvl = (n) => rankLabel(n);
  $('scores').innerHTML = [0, 1].map((tm) => {
    const host = st.hostTeam === tm ? '<span class="host">庄</span>' : '';
    return `<div class="sb-row"><span class="sb-name">${host}${TEAM_NAME[tm]}</span><span class="sb-pt">${lvl(st.teamLevel[tm])} 级</span></div>`;
  }).join('');
}
function updateRoundInfo(st) {
  let s = `第 ${st.roundIndex} 局 · 打 <b>${rankLabel(st.level)}</b>`;
  $('round-info').innerHTML = s;
}

function positionOverlays() {
  const st = state.backend && state.backend.getState();
  const g = st && st.round;
  if (!g) return;
  const host = $('overlays');
  for (const seat of [0, 1, 2, 3]) {
    let tag = host.querySelector(`.seat-tag[data-seat="${seat}"]`);
    if (!tag) { tag = document.createElement('div'); tag.className = 'seat-tag'; tag.dataset.seat = seat; tag.innerHTML = '<div class="badge"></div><div class="name"></div><div class="count"></div>'; host.appendChild(tag); }
    // Keep YOUR plate clear of both the raised turn actions and the below-hand arrangement tools.
    const meFlat = seat === HUMAN && FLAT;
    tag.classList.toggle('me', seat === HUMAN);
    tag.classList.toggle('me-flat', meFlat);
    if (meFlat) { tag.style.left = 'calc(50% + 110px)'; tag.style.right = 'auto'; tag.style.top = 'auto'; tag.style.bottom = 'calc(var(--gd-hand-stack-top, 102px) + 24px)'; tag.style.transform = 'none'; }
    else if (seat === HUMAN) { tag.style.left = 'calc(50% + 155px)'; tag.style.right = 'auto'; tag.style.top = 'auto'; tag.style.bottom = '10px'; tag.style.transform = 'translateX(-50%)'; }
    else { const p = state.scene.seatScreen(seat, 2.5); tag.style.left = p.x + 'px'; tag.style.right = 'auto'; tag.style.top = (p.y - 6) + 'px'; tag.style.bottom = 'auto'; tag.style.transform = 'translate(-50%, -50%)'; }
    const partner = seat === partnerOf(HUMAN);
    tag.classList.toggle('partner', partner);
    const role = seat === HUMAN ? '' : (partner ? '（队友）' : '（对手）');
    tag.querySelector('.name').textContent = meFlat ? '' : (SEAT_NAME[seat] + role);
    const place = state.places[seat];
    const badge = tag.querySelector('.badge');
    badge.textContent = place != null ? PLACE[place] : '';
    badge.style.display = place != null ? 'block' : 'none';
    const cnt = g.handCounts[seat];
    tag.querySelector('.count').textContent = g.phase === 'play' ? (meFlat ? `剩余 ${cnt} 张` : `${cnt} 张`) : '';
    tag.classList.toggle('turn', g.phase === 'play' && g.turn === seat);
  }
}

// ---- bubbles ---------------------------------------------------------------
function bubble(seat, text, isPass) {
  if (seat === HUMAN) return;
  clearBubble(seat);
  const b = document.createElement('div'); b.className = 'bubble' + (isPass ? ' pass' : ''); b.dataset.seat = seat; b.textContent = text;
  $('overlays').appendChild(b);
  const p = state.scene.seatScreen(seat); b.style.left = p.x + 'px'; b.style.top = (p.y - 34) + 'px';
}
function clearBubble(seat) { const b = $('overlays').querySelector(`.bubble[data-seat="${seat}"]`); if (b) b.remove(); }
function clearBubbles() { for (const b of $('overlays').querySelectorAll('.bubble')) b.remove(); }

// ---- action bar: play / pass / hint ---------------------------------------
function showPlayBar() {
  const bar = $('actions'); bar.hidden = false; bar.innerHTML = ''; bar.classList.add('play-bar');
  const note = document.createElement('div'); note.id = 'action-hint'; note.className = 'action-hint'; note.hidden = true;
  const pass = mkBtn('不要', 'act-btn pass', () => doPass()); pass.id = 'pass-btn';
  const hint = mkBtn('提示', 'act-btn ghost', () => doHint()); hint.id = 'hint-btn';
  const play = mkBtn('出牌', 'act-btn', () => doPlay()); play.id = 'play-btn';
  bar.append(note, pass, hint, play);
  refreshPlayBar();
}
// Pre-select a sensible default ONLY when following; leave a free lead empty. The bot decides
// whether to play and WHICH SHAPE (type/size); we then pick the CLEANEST cards of that shape so the
// suggestion never carves a pair/single out of a trip or breaks a 顺子 when a tidier option exists.
function autoSelect(g) {
  state.userTouched = false; resetHint();
  state.sel.clear();
  if (g.leadSeat === HUMAN) return;
  const mv = chooseMove(g, HUMAN, AI_LEVEL, Math.random);
  if (mv.pass || !mv.cardIds.length) return;
  const picked = mv.cardIds.map((id) => g.hands[HUMAN].find((c) => c.id === id));
  const d = classify(picked, g.level);
  const clean = cleanestBeat(g.hands[HUMAN], g.lead, g.level, d ? d.type : null, d ? d.n : null);
  state.sel.set(clean || mv.cardIds);
}
function mkBtn(label, cls, on) { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.addEventListener('click', on); return b; }
function hideActions() { $('actions').hidden = true; $('actions').innerHTML = ''; }

function refreshPlayBar() {
  const g = state.backend.getState().round;
  const playBtn = $('play-btn'), passBtn = $('pass-btn'), hintBtn = $('hint-btn'), note = $('action-hint');
  if (!playBtn) return;
  const following = g.leadSeat !== HUMAN;
  const noBeat = following && legalMoves(g.hands[HUMAN], g.lead, g.level).length === 0;
  playBtn.disabled = !selectionLegal(g);
  passBtn.disabled = !following;
  passBtn.classList.toggle('recommended', noBeat);
  hintBtn.disabled = noBeat;
  note.hidden = !noBeat;
  note.textContent = noBeat ? '无牌可压，只能不要' : '';
}
function selectionLegal(g) {
  const ids = state.sel.ids;
  if (ids.length === 0) return false;
  return !!g.validate(HUMAN, ids);
}

async function doPlay() {
  const g = state.backend.getState().round;
  if (!selectionLegal(g)) return;
  const ids = state.sel.ids;
  state.awaiting = null; hideActions();
  await state.backend.play(ids);
}
async function doPass() {
  const g = state.backend.getState().round;
  if (g.leadSeat === HUMAN) return;
  state.awaiting = null; hideActions(); state.sel.clear(); state.hint.clear();
  await state.backend.pass();
}
// Cycle through the legal moves (also bound to keyboard h / gamepad X).
function doHint() {
  const g = state.backend.getState().round;
  const against = g.leadSeat === HUMAN ? null : g.lead;
  if (!state.hintMoves) {
    state.hintMoves = orderedHints(g.hands[HUMAN], against, g.level); // clean groups first; never splits a 顺子/炸弹 ahead of a clean play
    state.hintIdx = -1;
  }
  if (state.hintMoves.length === 0) return;
  state.hintIdx = (state.hintIdx + 1) % state.hintMoves.length;
  const mv = state.hintMoves[state.hintIdx];
  state.sel.set(mv.cardIds); state.userTouched = true;
  render();
}

// ---- input: pointer (tap + swipe paint) ------------------------------------
function onPointerDown(e) {
  const st = state.backend && state.backend.getState();
  const g = st && st.round;
  if (!g || g.phase !== 'play' || !g.hands[HUMAN].length) return;
  const startId = state.scene.pick(e.clientX, e.clientY);
  if (startId == null) return;
  let moved = false, mode = null;
  const onMove = (ev) => {
    const id = state.scene.pick(ev.clientX, ev.clientY);
    if (id == null) return;
    if (!moved) {
      if (id === startId) return;
      moved = true; freshTouch(); mode = !state.sel.has(startId);
      state.sel.paint(startId, mode);
    }
    state.sel.paint(id, mode); resetHint(); render();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (!moved) { freshTouch(); state.sel.tap(startId); cursorTo(startId); resetHint(); render(); }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
// First manual interaction this turn discards the auto-suggestion so the human starts fresh.
function freshTouch() { if (!state.userTouched) { state.sel.clear(); state.userTouched = true; } }
function toggleCard(id) { freshTouch(); state.sel.tap(id); cursorTo(id); render(); }
function cursorTo(id) { const g = state.backend.getState().round; state.cursor = g.hands[HUMAN].findIndex((c) => c.id === id); }
function resetHint() { state.hintMoves = null; state.hintIdx = -1; }

// ---- input: keyboard -------------------------------------------------------
function onKey(e) {
  if (state.awaiting !== 'play') return;
  const g = state.backend.getState().round; const hand = g.hands[HUMAN];
  if (e.key === 'ArrowLeft') { state.cursor = Math.max(0, state.cursor - 1); focusCursor(hand); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { state.cursor = Math.min(hand.length - 1, state.cursor + 1); focusCursor(hand); e.preventDefault(); }
  else if (e.key === ' ') { if (hand[state.cursor]) toggleCard(hand[state.cursor].id); resetHint(); e.preventDefault(); }
  else if (e.key === 'Enter') { doPlay(); e.preventDefault(); }
  else if (e.key === 'Escape' || e.key === 'Backspace') { doPass(); e.preventDefault(); }
  else if (e.key.toLowerCase() === 'h') { doHint(); }
}
function focusCursor(hand) { state.hint = new Set(hand[state.cursor] ? [hand[state.cursor].id] : []); render(); }

// ---- input: gamepad (Xbox) -------------------------------------------------
let padPrev = {};
// Poll the gamepad ONLY while one is connected (battery: a touch iPad never wakes the CPU for an absent
// pad). gamepadconnected starts the loop; it self-stops when no pad remains. See doudizhu/main.js.
let padLoopOn = false;
function startPadPolling() {
  if (padLoopOn) return;
  padLoopOn = true;
  pollPad();
}
addEventListener('gamepadconnected', startPadPolling);
function pollPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = [...pads].find((p) => p);
  if (!gp) { padLoopOn = false; return; } // no pad → stop until the next gamepadconnected
  requestAnimationFrame(pollPad);
  const g = state.backend && state.backend.getState() && state.backend.getState().round;
  const press = (i) => gp.buttons[i] && gp.buttons[i].pressed;
  const edge = (i) => { const now = press(i); const was = padPrev[i]; padPrev[i] = now; return now && !was; };
  const ax = gp.axes[0] || 0;
  if (state.awaiting === 'play' && g) {
    const hand = g.hands[HUMAN];
    if (edge(14) || (ax < -0.6 && !padPrev.axL)) { state.cursor = Math.max(0, state.cursor - 1); focusCursor(hand); }
    if (edge(15) || (ax > 0.6 && !padPrev.axR)) { state.cursor = Math.min(hand.length - 1, state.cursor + 1); focusCursor(hand); }
    padPrev.axL = ax < -0.6; padPrev.axR = ax > 0.6;
    if (edge(0)) { if (hand[state.cursor]) toggleCard(hand[state.cursor].id); resetHint(); } // A: select
    if (edge(2)) doHint();   // X: hint
    if (edge(3)) doPlay();   // Y: play
    if (edge(1)) doPass();   // B: pass
  } else if (edge(0)) {
    if (!$('start-overlay').hidden) $('start-btn').click();
    else if (!$('result-overlay').hidden) $('next-btn').click();
  }
}

// ---- result ----------------------------------------------------------------
function showResult(r) {
  state.lastSettle = r;
  // Persist the ladder between rounds; clear it once the match is decided (champion crowned).
  LS.progress = r.champion >= 0 ? null : state.backend.matchState();
  const youWon = r.winTeam === teamOf(HUMAN);
  $('result-title').textContent = r.champion >= 0
    ? (r.champion === teamOf(HUMAN) ? '🏆 你方过 A，大胜！' : '对方过 A · 你方落败')
    : (youWon ? '本局你方胜' : '本局你方负');
  $('result-title').className = youWon ? 'win' : 'lose';
  const order = r.order.map((s, i) => `${PLACE[i]}：${s === HUMAN ? '你' : SEAT_NAME[s]}`).join(' · ');
  // At A, only 双上游 (头游+二游, advance≥2) wins; 头游 with the partner last just holds at A.
  const adv = r.stayedAtA
    ? `${TEAM_NAME[r.winTeam]} 打 A 未过 — 需双上游（头游+二游）方可获胜`
    : `${TEAM_NAME[r.winTeam]} 升级 +${r.advance}（${rankLabel(r.levelBefore)} → ${rankLabel(r.levelAfter)}）`;
  $('result-detail').innerHTML = `${order}<br>${adv}`;
  $('result-score').innerHTML = `你方 <b>${rankLabel(r.teamLevel[0])}</b> 级　对方 <b>${rankLabel(r.teamLevel[1])}</b> 级`;
  $('next-btn').textContent = r.champion >= 0 ? '再来一盘' : '下一局';
  if (youWon) sfx.win(); else sfx.lose();
  $('result-overlay').hidden = false;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Debug hook for an e2e test: drive the human seat headlessly.
window.__gd = {
  awaiting: () => state.awaiting,
  resultShown: () => !$('result-overlay').hidden,
  scene: () => state.scene,
  state: () => state.backend && state.backend.getState(),
  render: () => render(),
  step() {
    if (state.awaiting !== 'play') return 'wait';
    const g = state.backend.getState().round;
    const mv = chooseMove(g, HUMAN, AI_LEVEL, Math.random);
    if (mv.pass) { if (g.leadSeat !== HUMAN) { doPass(); return 'pass'; } return 'stuck'; }
    state.sel.set(mv.cardIds); doPlay(); return 'play';
  },
};
boot();
