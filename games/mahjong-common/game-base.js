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
    this.onlineEndsMatch = false; // this result closes the match (天津 锅 / 国标 场, server-flagged) → finish button
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

  // Forfeit the live game: tell the server (our seat becomes a bot; this match isn't scored for us),
  // then return to the lobby. The server concludes the match if we were the last human.
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
  // Upward drag distance (px) from the pointerdown. The page force-rotates 90° on
  // portrait, so the on-screen "up" axis is -Δy normally but +Δx when rotated.
  _dragUpPx(sx, sy, ex, ey) {
    return (this.scene && this.scene.rotated) ? (ex - sx) : (sy - ey);
  }

  // Track a hand-tile pointer from pointerdown.
  //   - A small upward move "takes over" the selection (this tile becomes the lifted
  //     one, deselecting whatever was selected) and the tile then tracks the finger.
  //   - Crossing ~2 tile-heights up = "play": auto-discards immediately (no wait for
  //     release), so the tile never drags up past that point.
  //   - Releasing below the threshold leaves the tile SELECTED in the hand row (it
  //     snaps back to the selected lift) — it does not discard.
  //   - A plain tap (no real drag) keeps the old behaviour via onPickTile (select, or
  //     second-tap-to-discard).
  // Side movement must not dominate, so a horizontal swipe never engages.
  trackTileGesture(e, idx) {
    const sx = e.clientX, sy = e.clientY;
    const tileH = (this.scene && this.scene.handTilePixelHeight) ? this.scene.handTilePixelHeight() : 48;
    const PLAY = 2 * tileH;                 // slide this far up → play
    const DEAD = Math.max(8, tileH * 0.2);  // past this → it's a drag, not a tap
    const canPlay = this.canPlayTileAt(idx);
    let dragging = false, done = false;
    const drop = () => { if (this.scene && this.scene.clearDragLift) this.scene.clearDragLift(); };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const onMove = (ev) => {
      if (done || !canPlay) return; // 混儿 / off-turn → no drag; the release falls through to a tap
      const up = this._dragUpPx(sx, sy, ev.clientX, ev.clientY);
      const side = (this.scene && this.scene.rotated) ? (ev.clientY - sy) : (ev.clientX - sx);
      if (up < DEAD || up < Math.abs(side)) return; // not (yet) an upward drag
      if (up >= PLAY) { done = true; cleanup(); drop(); this.playTileAt(idx); return; } // reached play height → play now
      if (!dragging) { dragging = true; this.selectTileAt(idx); } // take over the selection from any prior tile
      if (this.scene && this.scene.setDragLift) this.scene.setDragLift(idx, up); // follow the finger (capped < PLAY)
    };
    const onUp = () => {
      if (done) return;
      cleanup(); drop();
      if (dragging) return; // released below the play height → stays SELECTED (snaps back to the selected lift)
      this.onPickTile(idx); // a tap (no real drag) → normal select / second-tap discard
    };
    const onCancel = () => { if (done) return; cleanup(); drop(); }; // gesture stolen (scroll/etc.) → snap back, no action
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  // ---- hooks each variant must implement -----------------------------------
  isClaimPhase() { throw new Error('isClaimPhase() not implemented'); }
  selectableHandIndices() { throw new Error('selectableHandIndices() not implemented'); }
  returnHub() { throw new Error('returnHub() not implemented'); }
  onPickTile(idx) { throw new Error('onPickTile() not implemented'); }
  // Can the hand tile at rendered index `idx` be played right now (human's turn, a
  // discardable tile)? Gates the slide-up drag so 混儿/off-turn tiles don't lift.
  canPlayTileAt(idx) { return false; }
  // Discard the hand tile at `idx` directly. Returns true if it played.
  playTileAt(idx) { return false; }
  // Make the tile at `idx` the selected (lifted) tile in the hand row, deselecting any
  // other — used when a slide takes over the selection. No discard.
  selectTileAt(idx) {}
}
