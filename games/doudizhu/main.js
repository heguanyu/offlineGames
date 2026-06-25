// 斗地主 UI controller. Renders the read-only Game from the backend, sends the human's moves
// through it (async), and reacts to the backend's awaited events — the same UI↔Backend split as
// the mahjong games, so this whole layer is offline/online-agnostic.
import { createBackend, HUMAN } from './backend.js';
import { legalMoves, classify, beats, rankLabel, COMBO } from './engine.js';
import { chooseMove } from './ai.js';
import { DouScene } from './scene.js';
import { DouScene2D } from './scene2d.js';
import { SmartSelection } from './select.js';
import { sfx, speak, setMuted, isMuted, resume } from './sound.js';
import { serverUrl } from '../mahjong-common-online/server-url.js';
import { clientUidSync } from '../../shared/client-id.js';

const $ = (id) => document.getElementById(id);
// Online mode (?online=1): the authoritative game lives on the server (server/poker-table.js); this
// page becomes a pure renderer talking to it via the RemoteBackend. ?viewer=1 + ?vtable/?vseat is a
// read-only spectator of a seat. Offline (no ?online) is the original local engine+AI game.
const QS = new URLSearchParams(location.search);
const ONLINE = QS.has('online');
const VIEWER = QS.has('viewer');
const LOBBY_URL = '../mahjong-common-online/?game=doudizhu';
// FAST is a hidden test override (?fast=1) — there's no user-facing 快速 mode.
const FAST = new URLSearchParams(location.search).has('fast');
// Phones use the flat 2D DOM board (rectangle table); desktops use the 3D scene. ?flat=1 / ?d3=1 override.
const FLAT = (() => {
  const p = new URLSearchParams(location.search);
  if (p.has('d3')) return false;
  if (p.has('flat')) return true;
  return Math.min(screen.width, screen.height) < 600 || /iPhone|iPod/.test(navigator.userAgent);
})();
document.body.classList.toggle('flat', FLAT);
const LS = {
  get level() { return +(localStorage.getItem('doudizhu-level') ?? 1); },
  set level(v) { localStorage.setItem('doudizhu-level', v); },
  get scores() { try { return JSON.parse(localStorage.getItem('doudizhu-scores')) || [0, 0, 0]; } catch { return [0, 0, 0]; } },
  set scores(v) { localStorage.setItem('doudizhu-scores', JSON.stringify(v)); },
  get mute() { return localStorage.getItem('doudizhu-mute') === '1'; },
  set mute(v) { localStorage.setItem('doudizhu-mute', v ? '1' : '0'); },
};
const SEAT_NAME = ['你', '下家', '上家'];

const state = {
  scene: null, backend: null, level: 1,
  sel: new SmartSelection(), // smart card selection (group-tap + swipe), a dedicated module
  hint: new Set(),            // tinted candidate cards (keyboard/gamepad focus)
  cursor: 0,                  // keyboard/gamepad focus index into the human hand
  trick: {},                  // seat -> cards currently shown on the felt
  discard: [],                // cards from COMPLETED tricks, shown face-down in the middle
  reveal: false,              // after game over, show everyone's remaining cards face-up
  passStreak: 0,
  bottom: null,               // 底牌 shown during/just after bidding
  phase: 'idle',
  awaiting: null,             // 'play' | 'bid' | null
  userTouched: false,         // has the human adjusted the auto-selection this turn?
  hintMoves: null, hintIdx: -1,
  // ---- online ----
  online: false, viewer: false,
  readied: false, matchEnd: false, // result-modal ready toggle / final-hand flag
  reconnectTimer: null,
  ttHandle: null, ttDeadline: 0, ttTotal: 30000, ttSeat: -1, // turn-countdown ring
};

// ---- boot ------------------------------------------------------------------
// On a phone held PORTRAIT, CSS-rotate <body> 90° so the game fills the screen as landscape (iOS
// Safari has no orientation-lock). Only ever rotated one way; calls apply(isPortrait) on each change.
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
  const resume = () => { update(); setTimeout(update, 150); setTimeout(update, 450); };
  addEventListener('pageshow', resume); addEventListener('focus', resume);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  update();
}

function boot() {
  state.scene = new (FLAT ? DouScene2D : DouScene)($('scene'));
  // mobile (flat) mode is always landscape — rotate the page when the phone is held portrait
  if (FLAT) forceLandscape((portrait) => { state.scene.setRotated(portrait); state.scene.resize(); if (state.backend) render(); });
  state.level = LS.level;
  setMuted(LS.mute); $('mute-btn').textContent = LS.mute ? '🔇' : '🔊';

  for (const b of document.querySelectorAll('.diff-btn')) {
    if (+b.dataset.level === state.level) markDiff(b);
    b.addEventListener('click', () => { state.level = +b.dataset.level; LS.level = state.level; markDiff(b); });
  }
  $('start-btn').addEventListener('click', () => { resume(); $('start-overlay').hidden = true; newGame(); });
  $('next-btn').addEventListener('click', onNextBtn);
  $('result-home').addEventListener('click', returnHome);
  $('mute-btn').addEventListener('click', () => { LS.mute = !isMuted(); setMuted(LS.mute); $('mute-btn').textContent = LS.mute ? '🔇' : '🔊'; });
  $('menu-btn').addEventListener('click', () => { $('menu-overlay').hidden = false; });
  $('menu-continue').addEventListener('click', () => { $('menu-overlay').hidden = true; });
  $('menu-restart').addEventListener('click', () => { LS.scores = [0, 0, 0]; updateScoreboard(null); $('menu-overlay').hidden = true; $('result-overlay').hidden = true; newGame(); });
  $('menu-home').addEventListener('click', returnHome);
  $('menu-forfeit').addEventListener('click', () => { $('menu-overlay').hidden = true; if (state.backend && state.backend.forfeit) state.backend.forfeit(); returnHome(); });

  $('scene').addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', positionOverlays);
  window.addEventListener('resize', () => drawTurnTimer());
  updateScoreboard(null);
  pollPad();
  if (ONLINE) startOnline();
}

// Result modal's primary button: offline deals a fresh local hand; online readies for the next hand
// (or, on the 场's final hand, sends the ack that closes it → back to the lobby).
function onNextBtn() {
  if (!state.online) { $('result-overlay').hidden = true; newGame(); return; }
  if (state.matchEnd) { state.backend.next(); return; } // final hand → closes the 场, server sends matchOver
  state.readied = !state.readied;
  if (state.readied) state.backend.next(); else state.backend.unready();
  refreshResultBtn();
}
function returnHome() { location.replace(state.online ? LOBBY_URL : '../../index.html'); }

// ---- online: connect to the authoritative server -------------------------
function startOnline() {
  state.online = true; state.viewer = VIEWER;
  document.body.classList.add('online');
  $('start-overlay').hidden = true;
  $('menu-restart').hidden = true;                 // no local score reset online
  $('menu-forfeit').hidden = VIEWER;               // spectators can't forfeit
  // round-info shows the 场 progress online; difficulty is server-controlled
  const uid = clientUidSync();
  const name = localStorage.getItem('mahjong-online-name') || '';
  const cfg = { mode: 'remote', url: serverUrl(), uid, name };
  if (VIEWER) cfg.spectate = { table: +QS.get('vtable') || 0, seat: +QS.get('vseat') || 0 };
  state.backend = createBackend(cfg);
  state.backend.onEvent(onEvent);
  state.backend.connect();
  resume(); // unlock audio (best-effort; a user gesture may still be needed on iOS)
}
function markDiff(btn) { for (const b of document.querySelectorAll('.diff-btn')) b.classList.toggle('sel', b === btn); }

function newGame() {
  if (state.backend) state.backend.dispose();
  state.sel.clear(); state.hint.clear(); state.trick = {}; state.discard = []; state.reveal = false; state.passStreak = 0; state.bottom = null; state.cursor = 0;
  state.backend = createBackend({ mode: 'local', level: state.level, thinkDelay: thinkMs() });
  state.backend.onEvent(onEvent);
  clearBubbles();
  state.backend.startHand();
}
function thinkMs() { return FAST ? 80 : 650; }

// ---- backend events --------------------------------------------------------
async function onEvent(ev) {
  const g = state.backend.getState();
  switch (ev.type) {
    case 'deal': {
      if (state.online) { $('result-overlay').hidden = true; state.readied = false; state.matchEnd = false; clearTurnTimer(); }
      state.phase = 'bid'; state.trick = {}; state.discard = []; state.reveal = false; state.sel.clear(); state.hint.clear();
      state.bottom = null; clearBubbles();
      const dealt = state.scene.beginDeal({ hand: g.hands[HUMAN], fast: FAST });
      sfx.deal(); render();
      await dealt; render();
      state.scene.showBottomReveal(g.bottom, { faceDown: true, title: '底 牌' }); // 底牌 box (face-down) shown through bidding
      if (state.online) state.backend.dealDone(); // tell the server our deal animation finished → it drives the bots
      break;
    }
    case 'askBid':
      clearTurnTimer();
      if (!state.viewer) { state.awaiting = 'bid'; showBidBar(g); startTurnTimer(HUMAN, ev); }
      render(); break;
    case 'bid': {
      clearTurnTimer();
      bubble(ev.seat, ev.call > 0 ? `叫 ${ev.call} 分` : '不叫', ev.call === 0);
      const dur = speak(ev.call > 0 ? [`${ev.call}分`] : ['过'], ev.seat);
      hideActions(); render();
      if (dur) await wait(dur);                  // let the call finish before the next seat bids
      break;
    }
    case 'bidEnd':
      state.bottom = null; state.phase = 'play'; state.trick = {};
      clearBubbles(); render();
      bubble(ev.landlord, '地主', false);
      if (!isMuted()) speak(['我是地主'], ev.landlord);
      // reveal the three 底牌, double-sized in a labelled box at table centre, for ≥3s
      showBottomReveal(ev.bottom);
      await wait(3200);
      hideBottomReveal(); render(); break;
    case 'redeal':
      clearBubbles(); state.bottom = null; state.scene.hideBottomReveal(); render(); await wait(500); break;
    case 'play': {
      clearTurnTimer();
      state.trick[ev.seat] = ev.cards;
      const dur = announcePlay(ev); clearBubble(ev.seat);
      if (ev.seat === HUMAN) { state.sel.clear(); state.hint.clear(); }
      render();
      if (dur) await wait(dur);                  // wait for the call to finish before the next turn
      break;
    }
    case 'pass': {
      clearTurnTimer();
      bubble(ev.seat, '不出', true);
      const dur = speak(['过'], ev.seat);
      render();
      if (dur) await wait(dur);
      break;
    }
    case 'trickEnd': {
      // a trick was won → free play. A CONTESTED trick (more than one seat played) holds ~3s so
      // players can read the battle; a consecutive/uncontested free win (only the leader played)
      // clears in 1s, so a player running the table doesn't stall the game.
      const free = Object.keys(state.trick).length <= 1;
      await wait(FAST ? (free ? 250 : 450) : (free ? 1000 : 2000));
      flushTrickToDiscard(); clearBubbles(); render(); break;
    }
    case 'await': {
      clearTurnTimer();
      if (state.viewer) { render(); break; }     // a spectator never acts
      state.awaiting = 'play'; state.cursor = Math.min(state.cursor, g.hands[HUMAN].length - 1);
      const against = g.leadSeat === HUMAN ? null : g.lead;
      state.sel.setHand(g.hands[HUMAN]);
      state.sel.setContext({ legalMoves: legalMoves(g.hands[HUMAN].map((c) => c.rank), against) });
      autoSelect(g);
      showPlayBar(); startTurnTimer(HUMAN, ev); render(); break;
    }
    case 'over':
      clearTurnTimer();
      state.awaiting = null; state.reveal = true; state.matchEnd = !!ev.matchEnd; hideActions(); render(); showResult(ev.result); break;

    // ---- online-only events ----
    case 'turn':                                   // another seat is on the clock → ring over them
      startTurnTimer(ev.seat, ev); break;
    case 'sync':                                   // reconnect/spectator catch-up: rebuild the table from the view
      hideReconnecting(); resyncFromView(g); break;
    case 'handEnd':                                // server is waiting for 下一局 acks (result modal already shown by 'over')
      break;
    case 'matchOver':                                // the 场 finished → its scores are recorded; back to the lobby
      clearTurnTimer(); returnHome(); break;
    case 'disconnected':                           // socket dropped; the RemoteBackend auto-retries
      showReconnecting(); break;
    case 'gameGone':                               // no live game on the server for us → lobby
      returnHome(); break;
  }
}

// Move the just-won trick's cards into the face-down discard pile (called when a new trick starts).
function flushTrickToDiscard() {
  for (const seat in state.trick) for (const c of state.trick[seat]) state.discard.push(c);
  state.trick = {};
}

// 底牌展示 — carved into the 3D table (border + title + cards), rendered by the scene.
function showBottomReveal(cards) { state.scene.showBottomReveal(cards); }
function hideBottomReveal() { state.scene.hideBottomReveal(); }

// Speak a rank: say its number, with the 斗地主 nicknames J→勾, Q→圈, A→尖 (jokers say 小王/大王).
function rankSpeak(r) {
  return { 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十', 11: '勾', 12: '圈', 13: 'K', 14: '尖', 15: '二', 16: '小王', 17: '大王' }[r] || '';
}
// Build the spoken token sequence for a played combo. Most are now single preset clips (no combining):
//   single→[N] · pair→[俩N] · trio→[仨,N] · 3+1→[三带一] · 3+2→[三带二]
//   顺/连对→[串] · 飞机→[飞机] · 四带二→[四带二] · 炸弹→[炸弹] · 王炸→[王炸]
function speakMove(d) {
  const R = rankSpeak;
  switch (d.type) {
    case COMBO.SINGLE: return [R(d.rank)];
    case COMBO.PAIR: return ['俩' + R(d.rank)];
    case COMBO.TRIO: return ['仨', R(d.rank)];
    case COMBO.TRIO_SINGLE: return ['三带一'];
    case COMBO.TRIO_PAIR: return ['三带二'];
    case COMBO.STRAIGHT: return ['顺子'];                       // was 串; now 顺子！
    case COMBO.DOUBLE_STRAIGHT: return ['串'];
    case COMBO.PLANE: case COMBO.PLANE_SINGLE: case COMBO.PLANE_PAIR: return ['飞机'];
    case COMBO.FOUR_SINGLE: case COMBO.FOUR_PAIR: return ['四带二'];
    case COMBO.BOMB: return ['炸弹'];
    case COMBO.ROCKET: return ['王炸'];
    default: return [];
  }
}
// Announce a play and return the voice duration (ms) so the caller can wait for it to finish.
const PLANE_TYPES = [COMBO.PLANE, COMBO.PLANE_SINGLE, COMBO.PLANE_PAIR];
function announcePlay(ev) {
  const d = ev.move;
  if (d.type === COMBO.BOMB) { sfx.bomb(); state.scene.bombFx?.(); }
  else if (d.type === COMBO.ROCKET) { sfx.rocket(); state.scene.bombFx?.(); }
  else { sfx.play(); if (PLANE_TYPES.includes(d.type)) state.scene.planeFx?.(); }
  return speak(speakMove(d), ev.seat);
}

// ---- rendering -------------------------------------------------------------
function render() {
  const g = state.backend && state.backend.getState();
  if (!g) return;
  const hand = g.hands[HUMAN] || [];
  const table = Object.entries(state.trick).map(([seat, cards]) => ({ seat: +seat, cards }));
  state.scene.sync({
    hand, selected: state.sel.selected, hint: state.hint,
    counts: g.handCounts, landlord: g.landlord, turn: g.phase === 'bid' ? g.bidTurn : g.turn, leadSeat: g.leadSeat, phase: g.phase,
    table, discard: state.discard,
    revealHands: state.reveal ? { 1: g.hands[1], 2: g.hands[2] } : null,
  });
  positionOverlays();
  updateRoundInfo(g);
  updateScoreboard(g);
  if (state.awaiting === 'play') refreshPlayBar();
}

// Cumulative scoreboard (top-right): each seat's running total, 👑 on the landlord. Online reads the
// server's running 场 scores (carried on the view, rotated so seat 0 is me); offline uses LS.
function updateScoreboard(g) {
  const scores = (state.online && g && g.scores) ? g.scores : LS.scores;
  $('scores').innerHTML = [0, 1, 2].map((s) => {
    const crown = g && g.landlord === s ? '👑' : '';
    const v = scores[s];
    return `<div class="sb-row"><span class="sb-name">${crown}${SEAT_NAME[s]}</span><span class="sb-pt ${v >= 0 ? 's-pos' : 's-neg'}">${v >= 0 ? '+' : ''}${v}</span></div>`;
  }).join('');
}

// Top-bar round info: difficulty, and during play the 底分 + 倍数.
function updateRoundInfo(g) {
  const diff = state.online ? '📶 联机' : (['新手', '普通', '高手'][state.level] || '');
  let s = `<b>${diff}</b>`;
  if (g && g.phase === 'play' && g.bid > 0) {
    const mult = Math.pow(2, g.bombs || 0);
    s += ` · 底分 ${g.bid}` + (mult > 1 ? ` · ${mult}倍` : '');
  }
  $('round-info').innerHTML = s;
}

// per-seat name/count tags, landlord crown, turn highlight — DOM overlays placed via worldToScreen
function positionOverlays() {
  const g = state.backend && state.backend.getState();
  if (!g) return;
  const host = $('overlays');
  for (const seat of [0, 1, 2]) {
    let tag = host.querySelector(`.seat-tag[data-seat="${seat}"]`);
    if (!tag) { tag = document.createElement('div'); tag.className = 'seat-tag'; tag.dataset.seat = seat; tag.innerHTML = '<span class="crown">👑</span><div class="name"></div><div class="count"></div>'; host.appendChild(tag); }
    tag.classList.toggle('me', seat === 0);
    // YOU: bottom-CENTRE under the hand row in 3D, but the bottom-LEFT corner in flat landscape (the
    // hand fills the whole bottom edge there, so centre would overlap it). Opponents follow their anchor.
    if (seat === 0 && FLAT) { tag.style.left = '8px'; tag.style.top = 'auto'; tag.style.bottom = '6px'; tag.style.transform = 'none'; }
    else if (seat === 0) { tag.style.left = '50%'; tag.style.top = 'auto'; tag.style.bottom = '6px'; tag.style.transform = 'translateX(-50%)'; }
    else { const p = state.scene.seatScreen(seat, 2.7); tag.style.left = p.x + 'px'; tag.style.top = (p.y - 8) + 'px'; tag.style.bottom = 'auto'; tag.style.transform = 'translate(-50%, -50%)'; }
    const isLL = g.landlord === seat;
    const role = isLL ? '（地主）' : (g.landlord >= 0 ? '（农民）' : '');
    tag.classList.toggle('landlord', isLL); // 👑 shown via CSS — right of YOUR card, above the opponents'
    tag.querySelector('.name').textContent = SEAT_NAME[seat] + (g.landlord >= 0 ? role : '');
    tag.querySelector('.count').textContent = g.phase === 'play' ? `${g.handCounts[seat]} 张` : '';
    tag.classList.toggle('turn', g.phase === 'play' && g.turn === seat);
  }
}

// ---- speech-bubble helpers (bids / passes) ---------------------------------
function bubble(seat, text, isPass) {
  if (seat === HUMAN) return;          // the human's own bid/pass is already conveyed by the UI; no bubble over their hand
  clearBubble(seat);
  const b = document.createElement('div'); b.className = 'bubble' + (isPass ? ' pass' : ''); b.dataset.seat = seat; b.textContent = text;
  $('overlays').appendChild(b);
  const p = state.scene.seatScreen(seat); b.style.left = p.x + 'px'; b.style.top = (p.y - 36) + 'px';
}
function clearBubble(seat) { const b = $('overlays').querySelector(`.bubble[data-seat="${seat}"]`); if (b) b.remove(); }
function clearBubbles() { for (const b of $('overlays').querySelectorAll('.bubble')) b.remove(); }

// ---- action bar: bidding ---------------------------------------------------
function showBidBar(g) {
  const bar = $('actions'); bar.hidden = false; bar.innerHTML = ''; bar.classList.remove('play-bar'); bar.classList.add('bid-bar');
  const labels = [['不叫', 0], ['1 分', 1], ['2 分', 2], ['3 分', 3]];
  for (const [lbl, val] of labels) {
    const btn = document.createElement('button'); btn.className = 'act-btn bid-btn' + (val === 0 ? ' no' : ''); btn.textContent = lbl;
    if (val !== 0 && val <= g.highBid) btn.disabled = true; // must outbid
    btn.addEventListener('click', () => { state.awaiting = null; bar.hidden = true; state.backend.decideBid(val); });
    bar.appendChild(btn);
  }
}

// ---- action bar: play / pass / hint ---------------------------------------
function showPlayBar() {
  const bar = $('actions'); bar.hidden = false; bar.innerHTML = ''; bar.classList.remove('bid-bar'); bar.classList.add('play-bar');
  const pass = mkBtn('不出', 'act-btn pass', () => doPass()); pass.id = 'pass-btn';
  const play = mkBtn('出牌', 'act-btn', () => doPlay()); play.id = 'play-btn';
  bar.append(pass, play);            // 提示 is gone — a playable combo is auto-selected each turn
  refreshPlayBar();
}

// Pre-select a playable combo at the start of the human's turn (the old 提示, now the default) —
// but ONLY when FOLLOWING a lead. On a free play (leading) the human chooses freely; we don't
// pre-pick a combo for them.
function autoSelect(g) {
  state.userTouched = false; resetHint();
  const hand = g.hands[HUMAN] || [];
  // QoL: if the whole remaining hand is itself a legal play right now (valid pattern that also
  // beats the lead, or any pattern on a free lead), that single play empties the hand and wins —
  // so auto-select every card. Takes priority over the normal follow-pick, and applies even when
  // leading. validatePlay already enforces turn/phase/beat rules.
  if (hand.length && g.validatePlay(HUMAN, hand.map((c) => c.id))) { state.sel.set(hand.map((c) => c.id)); return; }
  if (g.leadSeat === HUMAN) { state.sel.clear(); return; }   // freeplay → no smart-select
  const mv = chooseMove(g, HUMAN, 1, Math.random);
  if (mv.pass || !mv.cardIds.length) state.sel.clear(); else state.sel.set(mv.cardIds);
}
function mkBtn(label, cls, on) { const b = document.createElement('button'); b.className = cls; b.textContent = label; b.addEventListener('click', on); return b; }
function hideActions() { $('actions').hidden = true; $('actions').innerHTML = ''; }

function refreshPlayBar() {
  const g = state.backend.getState();
  const playBtn = $('play-btn'), passBtn = $('pass-btn');
  if (!playBtn) return;
  playBtn.disabled = !selectionLegal(g);
  passBtn.disabled = g.leadSeat === HUMAN; // the leader must play
}
function selectionLegal(g) {
  const ids = state.sel.ids;
  if (ids.length === 0) return false;
  return !!g.validatePlay(HUMAN, ids);
}

async function doPlay() {
  const g = state.backend.getState();
  if (!selectionLegal(g)) return;
  const ids = state.sel.ids;
  state.awaiting = null; hideActions();
  await state.backend.play(ids);
}
async function doPass() {
  const g = state.backend.getState();
  if (g.leadSeat === HUMAN) return;
  state.awaiting = null; hideActions(); state.sel.clear(); state.hint.clear();
  await state.backend.pass();
}
// Cycle through the alternative legal moves (no on-screen button — bound to keyboard h / gamepad X).
function doHint() {
  const g = state.backend.getState();
  const against = g.leadSeat === HUMAN ? null : g.lead;
  if (!state.hintMoves) {
    state.hintMoves = legalMoves(g.hands[HUMAN].map((c) => c.rank), against).sort((a, b) => a.size - b.size || a.rank - b.rank);
    state.hintIdx = -1;
  }
  if (state.hintMoves.length === 0) return; // nothing to suggest → user should pass
  state.hintIdx = (state.hintIdx + 1) % state.hintMoves.length;
  const mv = state.hintMoves[state.hintIdx];
  state.sel.set(mapRanksToIds(g.hands[HUMAN], mv.ranks)); state.userTouched = true;
  render();
}
function mapRanksToIds(hand, ranks) {
  const pool = hand.slice(); const ids = [];
  for (const r of ranks) { const i = pool.findIndex((c) => c.rank === r); ids.push(pool[i].id); pool.splice(i, 1); }
  return ids;
}

// ---- input: pointer (context-aware tap + swipe to select/deselect) ---------
function onPointerDown(e) {
  if (state.awaiting !== 'play') return;
  const startId = state.scene.pick(e.clientX, e.clientY);
  if (startId == null) return;
  let moved = false, mode = null; // mode: true = painting selected, false = painting deselected
  const onMove = (ev) => {
    const id = state.scene.pick(ev.clientX, ev.clientY);
    if (id == null) return;
    if (!moved) {
      if (id === startId) return;        // still on the start card → not a swipe yet
      moved = true;
      mode = !state.sel.has(startId);    // direction of the swipe is set by the first card's state
      state.sel.paint(startId, mode);    // include the card the swipe began on
    }
    state.sel.paint(id, mode); resetHint(); render();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!moved) { freshTouch(); state.sel.tap(startId); cursorTo(startId); resetHint(); render(); } // a tap → context-aware select
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
// First manual interaction this turn discards the auto-suggestion so the human starts fresh.
function freshTouch() { if (!state.userTouched) { state.sel.clear(); state.userTouched = true; } }
function toggleCard(id) { freshTouch(); state.sel.tap(id); cursorTo(id); render(); }
function cursorTo(id) { const g = state.backend.getState(); state.cursor = g.hands[HUMAN].findIndex((c) => c.id === id); }
function resetHint() { state.hintMoves = null; state.hintIdx = -1; }

// ---- input: keyboard -------------------------------------------------------
function onKey(e) {
  if (state.awaiting === 'bid') {
    if (e.key >= '0' && e.key <= '3') { const v = +e.key; const btn = [...document.querySelectorAll('.bid-btn')][v]; if (btn && !btn.disabled) btn.click(); }
    return;
  }
  if (state.awaiting !== 'play') return;
  const g = state.backend.getState(); const hand = g.hands[HUMAN];
  if (e.key === 'ArrowLeft') { state.cursor = Math.max(0, state.cursor - 1); focusCursor(hand); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { state.cursor = Math.min(hand.length - 1, state.cursor + 1); focusCursor(hand); e.preventDefault(); }
  else if (e.key === ' ') { if (hand[state.cursor]) toggleCard(hand[state.cursor].id); resetHint(); e.preventDefault(); }
  else if (e.key === 'Enter') { doPlay(); e.preventDefault(); }
  else if (e.key === 'Escape' || e.key === 'Backspace') { doPass(); e.preventDefault(); }
  else if (e.key.toLowerCase() === 'h') { doHint(); }
}
function focusCursor(hand) {
  state.hint = new Set(hand[state.cursor] ? [hand[state.cursor].id] : []);
  render();
}

// ---- input: gamepad (Xbox) -------------------------------------------------
let padPrev = {};
function pollPad() {
  requestAnimationFrame(pollPad);
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = [...pads].find((p) => p); if (!gp) return;
  const g = state.backend && state.backend.getState();
  const press = (i) => gp.buttons[i] && gp.buttons[i].pressed;
  const edge = (i) => { const now = press(i); const was = padPrev[i]; padPrev[i] = now; return now && !was; };
  const ax = gp.axes[0] || 0;
  if (state.awaiting === 'play' && g) {
    const hand = g.hands[HUMAN];
    if (edge(14) || (ax < -0.6 && !padPrev.axL)) { state.cursor = Math.max(0, state.cursor - 1); focusCursor(hand); }
    if (edge(15) || (ax > 0.6 && !padPrev.axR)) { state.cursor = Math.min(hand.length - 1, state.cursor + 1); focusCursor(hand); }
    padPrev.axL = ax < -0.6; padPrev.axR = ax > 0.6;
    if (edge(0)) { if (hand[state.cursor]) toggleCard(hand[state.cursor].id); resetHint(); } // A: select
    if (edge(2)) doHint();                                                                   // X: hint
    if (edge(3)) doPlay();                                                                    // Y: play
    if (edge(1)) doPass();                                                                    // B: pass
  } else if (state.awaiting === 'bid') {
    const btns = [...document.querySelectorAll('.bid-btn')];
    if (edge(0)) { const b = btns.find((x) => !x.disabled); if (b) b.click(); } // A: lowest valid call
    if (edge(3)) { const b = btns[3]; if (b && !b.disabled) b.click(); }        // Y: 3 分
  } else if (edge(0)) {
    if (!$('start-overlay').hidden) $('start-btn').click();
    else if (!$('result-overlay').hidden) $('next-btn').click();
  }
}

// ---- result ----------------------------------------------------------------
function showResult(r) {
  const youWon = (r.landlord === HUMAN) === r.landlordWon;
  // Cumulative 场 standings: online reads the server's running scores (which don't yet include THIS
  // hand at result time) + this hand's delta; offline accumulates into LS.
  let scores;
  if (state.online) {
    const g = state.backend.getState();
    const base = (g && g.scores) || [0, 0, 0];
    scores = base.map((v, s) => v + (r.delta[s] || 0));
  } else {
    scores = LS.scores; for (let s = 0; s < 3; s++) scores[s] += r.delta[s]; LS.scores = scores;
  }
  updateScoreboard(state.backend && state.backend.getState());
  $('result-title').textContent = youWon ? '你赢了！' : '你输了';
  $('result-title').className = youWon ? 'win' : 'lose';
  const tags = [];
  if (r.spring) tags.push('春天 ×2'); if (r.antiSpring) tags.push('反春天 ×2');
  if (r.bombs) tags.push(`炸弹 ×${Math.pow(2, r.bombs)}`);
  const llName = r.landlord === HUMAN ? '你' : SEAT_NAME[r.landlord];
  $('result-detail').innerHTML = `地主：${llName} · 底分 ${r.bid}` + (tags.length ? `<br>${tags.join(' · ')}` : '');
  $('result-score').textContent = (r.delta[HUMAN] >= 0 ? '+' : '') + r.delta[HUMAN];
  const bar = $('result-scorebar'); bar.innerHTML = '';
  scores.forEach((v, s) => { const d = document.createElement('div'); d.innerHTML = `${SEAT_NAME[s]}<br><span class="${v >= 0 ? 's-pos' : 's-neg'}">${v >= 0 ? '+' : ''}${v}</span>`; bar.appendChild(d); });
  if (youWon) sfx.win(); else sfx.lose();
  refreshResultBtn();
  $('result-overlay').hidden = false;
}

// The result modal's primary button: offline "再来一局"; online toggles readiness for the next hand,
// or on the 场's final hand shows the closer. Hidden for a spectator (they can't ready).
function refreshResultBtn() {
  const btn = $('next-btn');
  if (!state.online) { btn.hidden = false; btn.textContent = '再来一局'; return; }
  if (state.viewer) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.textContent = state.matchEnd ? '结束并查看总成绩' : (state.readied ? '✓ 已准备' : '我准备好了');
}

// ---- online: reconnect banner --------------------------------------------
function showReconnecting() {
  const el = $('reconnect-overlay'); if (el) el.classList.remove('hidden');
  if (!state.reconnectTimer) state.reconnectTimer = setTimeout(returnHome, 8000); // can't recover in time → lobby
}
function hideReconnecting() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  const el = $('reconnect-overlay'); if (el) el.classList.add('hidden');
}

// ---- online: reconnect/spectator catch-up — rebuild the table from a fresh view --------
function resyncFromView(g) {
  if (!g) { render(); return; }
  state.phase = g.phase === 'bid' ? 'bid' : 'play';
  state.trick = {}; state.discard = []; // we can't reconstruct opponents' exact played cards/suits — start the felt clean
  state.reveal = g.phase === 'over';
  state.bottom = null; state.sel.clear(); state.hint.clear(); clearBubbles();
  if (g.phase === 'bid') state.scene.showBottomReveal(g.bottom, { faceDown: true, title: '底 牌' });
  else state.scene.hideBottomReveal();
  render();
}

// ---- online: turn-countdown ring over whoever is on the clock ------------
function startTurnTimer(seat, ev) {
  if (!state.online) return;
  state.ttSeat = seat;
  state.ttDeadline = Date.now() + (ev && +ev.timeout > 0 ? +ev.timeout : 30000);
  state.ttTotal = ev && +ev.total > 0 ? +ev.total : 30000;
  if (!state.ttHandle) state.ttHandle = setInterval(drawTurnTimer, 100);
  drawTurnTimer();
}
function clearTurnTimer() {
  state.ttSeat = -1;
  if (state.ttHandle) { clearInterval(state.ttHandle); state.ttHandle = null; }
  const el = $('turn-timer'); if (el) el.classList.add('hidden');
}
function drawTurnTimer() {
  const el = $('turn-timer'); if (!el) return;
  if (!state.online || state.ttSeat < 0) { el.classList.add('hidden'); return; }
  const left = Math.max(0, state.ttDeadline - Date.now());
  const frac = state.ttTotal > 0 ? Math.min(1, left / state.ttTotal) : 0;
  el.classList.remove('hidden');
  el.classList.toggle('low', left <= 5000);
  el.querySelector('.tt-secs').textContent = Math.ceil(left / 1000);
  const arc = el.querySelector('.tt-arc'); const C = 2 * Math.PI * 16;
  arc.style.strokeDasharray = C; arc.style.strokeDashoffset = C * (1 - frac);
  // anchor: under the hand for me; over the seat tag for opponents
  if (state.ttSeat === HUMAN) { el.style.left = '50%'; el.style.bottom = '92px'; el.style.top = 'auto'; el.style.transform = 'translateX(-50%)'; }
  else { const p = state.scene.seatScreen(state.ttSeat, 2.7); el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.bottom = 'auto'; el.style.transform = 'translate(-50%, -50%)'; }
  if (left <= 0) clearTurnTimer();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Debug hook for the e2e test: drive the human seat headlessly.
window.__dou = {
  awaiting: () => state.awaiting,
  resultShown: () => !$('result-overlay').hidden,
  scene: () => state.scene,
  state: () => state.backend && state.backend.getState(),
  step() {                                  // perform one auto action for the human seat
    if (state.awaiting === 'bid') { state.awaiting = null; $('actions').hidden = true; state.backend.decideBid(0); return 'bid'; }
    if (state.awaiting === 'play') {
      const g = state.backend.getState();
      const against = g.leadSeat === HUMAN ? null : g.lead;
      const mv = legalMoves(g.hands[HUMAN].map((c) => c.rank), against).sort((a, b) => a.size - b.size || a.rank - b.rank)[0];
      if (!mv) { if (g.leadSeat !== HUMAN) { doPass(); return 'pass'; } return 'stuck'; }
      state.sel.set(mapRanksToIds(g.hands[HUMAN], mv.ranks)); doPlay(); return 'play';
    }
    return 'wait';
  },
};
boot();
