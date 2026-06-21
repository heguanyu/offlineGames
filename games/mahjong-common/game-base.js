// Base controller shared by every mahjong variant's main.js (天津 / 国标). It owns the
// state + methods that are identical across the variants — the online turn-timer ring,
// the top-right scoreboard, anchoring the claim buttons under the pending tile, the
// reconnect banner, the menu/forfeit plumbing and the result-button focus. Each variant
// subclasses it (TianjinGame / GuobiaoGame) and implements the divergent hooks
// (isClaimPhase, selectableHandIndices, renderActions, showResult, onBackendEvent, …)
// plus its own rules/AI/UI. This is what makes 天津 a *subtype* of mahjong rather than
// the base every other variant reaches into.
import { $ } from './ui-util.js';

export const HUMAN = 0;
export const WIND = ['东', '南', '西', '北'];
// Relative seat names from the human's perspective (play order 0→1→2→3).
export const SEAT_LABEL = ['玩家', '下家', '对家', '上家'];
// seat → [gridRow, gridCol] in the 3×3 scoreboard cross (对家 top, 上家 left, 下家 right, 玩家 bottom).
const SCORE_GRID = { 0: [3, 2], 1: [2, 3], 2: [1, 2], 3: [2, 1] };

export class MahjongGame {
  constructor() {
    // `game` is the READ-ONLY GameView the backend hands back — the UI renders it but never
    // mutates it; every move goes through `backend` (local engine+AI offline, the remote
    // server online). `scene` is the 3D table (or the flat 2D board).
    this.game = null;
    this.backend = null;
    this.scene = null;
    this.selIndex = 0;        // cursor into the human's selectable tiles
    this.focusIndex = 0;      // cursor into action-bar buttons (claims)
    this.lastLogLen = 0;
    this.dealing = false;     // the initial-deal animation is running (input is held)
    this.animating = false;   // a bot's discard fly is playing — tick + input are held
    this.isPortrait = false;  // device held portrait → page force-rotated to landscape
    this.gameStarted = false;
    this.resultFocus = 0;     // 0 = 下一局, 1 = 返回
    this.onlineReadied = false; // result-modal ready toggle (online): 我准备好了 ⇄ ✓已准备
    this.onlineEndsPot = false; // this result closes the 锅 (server-flagged) → finish button
    this.reconnectTimer = null;
    // online turn countdown: ttDeadline/ttTotal in ms, ttWaiting while a human is on the clock.
    this.ttHandle = null; this.ttDeadline = 0; this.ttTotal = 30000; this.ttWaiting = false;
  }

  // ---- online turn countdown ring -----------------------------------------
  // The server awaits ONLY humans (bots act on their own clock), so an 'await' frame means a
  // PLAYER is on the clock — show the ring with the server's remaining ms + window. Every other
  // frame hides it. Offline never sends 'await', so the ring never shows.
  drawTurnTimer() {
    if (!this.ttWaiting) {
      if (this.ttHandle) { clearInterval(this.ttHandle); this.ttHandle = null; }
      if (this.scene && this.scene.setTurnTimer) this.scene.setTurnTimer({ show: false }); // 3D panel (or flat's DOM ring)
      return;
    }
    const left = Math.max(0, this.ttDeadline - Date.now());
    if (this.scene && this.scene.setTurnTimer) this.scene.setTurnTimer({ show: true, secs: Math.round(left / 1000), frac: this.ttTotal > 0 ? Math.min(1, left / this.ttTotal) : 0, low: left <= 5000 });
  }
  syncTurnTimer(ev) {
    if (ev.type === 'await') { // a player (human) is on the clock
      this.ttWaiting = true;
      this.ttDeadline = Date.now() + (+ev.timeout > 0 ? +ev.timeout : 30000);
      this.ttTotal = +ev.total || +ev.timeout || 30000;
      if (!this.ttHandle) this.ttHandle = setInterval(() => this.drawTurnTimer(), 100);
    } else this.ttWaiting = false; // bot's turn / 拉庄 / 下一局 / between hands → no clock
    this.drawTurnTimer();
  }

  // ---- top-right scoreboard ------------------------------------------------
  // A cross mirroring the table. 庄 gets a 👑 prefix; score is green/red (no + on positives).
  renderScores() {
    const el = $('scores');
    el.innerHTML = '';
    for (let p = 0; p < 4; p++) {
      const pts = this.game.scores[p];
      const color = pts > 0 ? '#7ddf8a' : pts < 0 ? '#ef9a9a' : '#cfe7db';
      const [row, col] = SCORE_GRID[p];
      const cell = document.createElement('div');
      cell.className = 'sb-seat' + (p === HUMAN ? ' me' : '');
      cell.style.gridRow = row; cell.style.gridColumn = col;
      cell.innerHTML = `<span class="sb-name">${p === this.game.dealer ? '👑' : ''}${this.laZhuangBadge(p)}${SEAT_LABEL[p]}</span>` +
        `<span class="sb-pt" style="color:${color}">${pts}</span>`;
      el.appendChild(cell);
    }
  }
  // 天津 overrides this with the ⚔️ 拉庄 marker; 国标 has no 拉庄, so the default is blank.
  laZhuangBadge(p) { return ''; }

  // ---- claim buttons pinned under the pending tile -------------------------
  // Anchor the buttons' BOTTOM just above the hand row (in front of the central pending tile)
  // so the prompt never covers the hand, in any aspect. The 打出 button stays in the bottom bar.
  positionClaimUI() {
    const hud = $('action-hud');
    if (this.scene && !this.animating && this.claimUIVisible()) {
      const a = this.scene.worldToScreen(0, 0, 5.0);
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
  // 国标 overrides to also hide the claim UI during 听 autopilot.
  claimUIVisible() { return this.isClaimPhase(); }

  ensureSelection() {
    const sel = this.selectableHandIndices();
    if (this.selIndex >= sel.length) this.selIndex = sel.length - 1;
    if (this.selIndex < 0) this.selIndex = 0;
  }

  // ---- online: lost-connection banner --------------------------------------
  // On a dropped socket the RemoteBackend keeps retrying; show a banner and, if it can't get
  // back into the live game within a few seconds, return to the lobby.
  showReconnecting() {
    const el = $('reconnect-overlay'); if (el) el.classList.remove('hidden');
    if (!this.reconnectTimer) this.reconnectTimer = setTimeout(() => this.returnHub(), 8000);
  }
  hideReconnecting() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const el = $('reconnect-overlay'); if (el) el.classList.add('hidden');
  }

  // ---- menus / forfeit / result-button focus -------------------------------
  openMenu() { $('menu-overlay').classList.remove('hidden'); }
  closeOverlays() { for (const id of ['menu-overlay', 'rules-overlay']) $(id).classList.add('hidden'); }

  // Forfeit the live game: tell the server (our seat becomes a bot; this 锅 isn't scored for us),
  // then return to the lobby. The server concludes the 锅 if we were the last human.
  doForfeit() {
    $('forfeit-confirm-overlay').classList.add('hidden');
    if (this.backend && this.backend.forfeit) this.backend.forfeit();
    this.returnHub();
  }

  // Keyboard/gamepad focus between the result panel's two buttons (下一局 / 返回).
  focusResultBtn() {
    const btns = [$('next-hand-btn'), $('back-hub-btn')];
    btns.forEach((b, i) => b && b.classList.toggle('focus', i === this.resultFocus));
    btns[this.resultFocus] && btns[this.resultFocus].focus();
  }

  // ---- slide-up-to-play gesture (touch/iPad + mobile) ----------------------
  // Was the drag from (sx,sy) to (ex,ey) an upward slide past ~2 tile-heights?
  // The page force-rotates 90° on portrait, so the on-screen "up" axis is -Δy
  // normally but +Δx when rotated. The rotation is rigid (1:1 px), so the scene's
  // tile-height (in px) is directly comparable. We also require the up component to
  // dominate the sideways one, so a horizontal swipe never plays a tile.
  isSlideUp(sx, sy, ex, ey) {
    const rotated = !!(this.scene && this.scene.rotated);
    const up = rotated ? (ex - sx) : (sy - ey);
    const side = rotated ? (ey - sy) : (ex - sx);
    const tileH = (this.scene && this.scene.handTilePixelHeight) ? this.scene.handTilePixelHeight() : 48;
    return up >= 2 * tileH && up >= Math.abs(side);
  }

  // Track a hand-tile pointer from pointerdown: on release, a big enough upward
  // slide plays that tile directly (playTileAt); otherwise it's a normal tap
  // (onPickTile — select / second-tap-to-discard). Call from each game's
  // pointerdown after picking the tile under the finger.
  trackTileGesture(e, idx) {
    const sx = e.clientX, sy = e.clientY;
    const onMove = () => {}; // tracked via the pointerup coords; move is a no-op
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const onUp = (ev) => {
      cleanup();
      if (this.isSlideUp(sx, sy, ev.clientX, ev.clientY) && this.playTileAt(idx)) return; // slid up → play directly
      this.onPickTile(idx); // otherwise the normal tap (select, or second-tap discard)
    };
    const onCancel = () => { cleanup(); }; // gesture stolen (scroll/etc.) → neither play nor select
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  // ---- hooks each variant must implement -----------------------------------
  isClaimPhase() { throw new Error('isClaimPhase() not implemented'); }
  selectableHandIndices() { throw new Error('selectableHandIndices() not implemented'); }
  returnHub() { throw new Error('returnHub() not implemented'); }
  onPickTile(idx) { throw new Error('onPickTile() not implemented'); }
  // Discard the hand tile at rendered index `idx` directly if it's legal to play
  // right now (the human's turn, a discardable tile). Returns true if it played.
  playTileAt(idx) { return false; }
}
