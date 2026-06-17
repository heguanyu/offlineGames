// Flat 2D (DOM) board for 斗地主 on phones — a drop-in alternative to the 3D DouScene (scene.js),
// implementing the SAME interface main.js drives (sync / seatScreen / worldToScreen / pick /
// beginDeal / showBottomReveal / hideBottomReveal / resize / setRotated). Picking the renderer is a
// one-line choice in main.js. A RECTANGLE felt, cards as DOM elements (no three.js, no WebGL, no rAF
// loop — repaint only on sync, so it's battery-cheap on a phone). The nameplates / crown / bubbles
// stay main.js's overlays, positioned via seatScreen(); this renderer only draws the cards.
import { rankLabel } from './engine.js';

const SUIT = ['♠', '♥', '♣', '♦'];
const RED = [false, true, false, true];

function faceCard(card) {
  const el = document.createElement('div');
  el.className = 'c2';
  if (card.rank >= 16) {
    el.classList.add(card.rank === 17 ? 'red' : 'blk', 'jk');
    el.innerHTML = `<span class="rk">${card.rank === 17 ? '大' : '小'}</span><span class="su">王</span>`;
  } else {
    el.classList.add(RED[card.suit] ? 'red' : 'blk');
    el.innerHTML = `<span class="rk">${rankLabel(card.rank)}</span><span class="su">${SUIT[card.suit]}</span>`;
  }
  return el;
}
function backCard() { const el = document.createElement('div'); el.className = 'c2 back'; return el; }

export class DouScene2D {
  constructor(canvas) {
    this.canvas = canvas;                 // kept as a transparent input overlay (main binds pointerdown to it)
    this.mount = canvas.parentElement;    // #table
    this.rotated = false;
    this.board = document.createElement('div');
    this.board.id = 'board2d';
    this.mount.insertBefore(this.board, this.canvas); // behind the (transparent) canvas
    this.handRects = [];                  // [{ id, rect }] for pick()
    this._last = null;                    // last view, so resize() re-renders
    this._reveal = null;                  // 底牌展示 panel element
    new ResizeObserver(() => this.resize()).observe(this.mount);
  }

  setRotated(r) { this.rotated = !!r; }
  resize() { if (this._last) this._render(this._last); }
  sync(view) { this._render(view); }

  // The deal has no flight animation in 2D — just render the hand and resolve after a beat.
  beginDeal({ fast } = {}) { return new Promise((r) => setTimeout(r, fast ? 80 : 250)); }

  // Anchor where main.js places a seat's nameplate / crown / bubble. MOUNT-LOCAL coords (not visual)
  // so the overlays sit right even when the whole page is CSS-rotated to force landscape.
  seatScreen(seat) {
    const W = this.mount.clientWidth, H = this.mount.clientHeight;
    if (seat === 1) return { x: W * 0.82, y: 60 };   // 下家 top-right (no top bar in flat — nav is a side rail)
    if (seat === 2) return { x: W * 0.18, y: 60 };   // 上家 top-left
    return { x: W * 0.5, y: H - 24 };                // 玩家 bottom (mostly unused)
  }
  worldToScreen() { return { x: this.mount.clientWidth / 2, y: this.mount.clientHeight / 2 }; }

  pick(clientX, clientY) {
    for (let i = this.handRects.length - 1; i >= 0; i--) { // topmost (right-most) card wins
      const r = this.handRects[i].rect;
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return this.handRects[i].id;
    }
    return null;
  }

  // ---- 底牌展示 (DOM panel) ----
  showBottomReveal(cards, { faceDown = false, title = '底牌展示' } = {}) {
    this.hideBottomReveal();
    const p = document.createElement('div');
    p.className = 'b2-reveal';
    const titleEl = document.createElement('div'); titleEl.className = 'b2-reveal-t'; titleEl.textContent = title;
    const row = document.createElement('div'); row.className = 'b2-reveal-row';
    for (const c of cards) { const el = faceDown ? backCard() : faceCard(c); el.classList.add('big'); row.appendChild(el); }
    p.append(titleEl, row);
    this.mount.appendChild(p);
    this._reveal = p;
  }
  hideBottomReveal() { if (this._reveal) { this._reveal.remove(); this._reveal = null; } }

  // ---- render -------------------------------------------------------------
  _render(view) {
    this._last = view;
    const b = this.board;
    b.innerHTML = '';
    this.handRects = [];
    const W = this.mount.clientWidth, H = this.mount.clientHeight;

    // on-turn ring — a glowing 1/3 arc in the play area, rotated to point at the active seat (bid/play)
    const ts = (view.turn != null && (view.phase === 'bid' || view.phase === 'play')) ? view.turn : -1;
    if (ts >= 0) {
      const cx = W / 2, cy = H * 0.44, s = this.seatScreen(ts);
      const ang = Math.atan2(s.x - cx, -(s.y - cy)) * 180 / Math.PI; // 0 = up, clockwise
      const ring = document.createElement('div'); ring.className = 'turn2d';
      ring.style.left = cx + 'px'; ring.style.top = cy + 'px';
      ring.style.transform = `translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`;
      b.appendChild(ring);
    }

    // opponents: face-down fans (or revealed faces at game over), top-left / top-right
    for (const seat of [1, 2]) {
      const reveal = view.revealHands && view.revealHands[seat];
      const cards = reveal || Array((view.counts || [0, 0, 0])[seat]).fill(null);
      const cx = seat === 1 ? W * 0.84 : W * 0.16;
      const m = cards.length;
      const step = Math.min(13, m > 1 ? Math.min(W * 0.26, 150) / (m - 1) : 0);
      const x0 = cx - step * (m - 1) / 2;
      cards.forEach((c, i) => {
        const el = c ? faceCard(c) : backCard();
        el.classList.add('mini');
        el.style.left = (x0 + i * step) + 'px';
        el.style.top = '86px';                          // below the nameplate (which main places at y≈60)
        el.style.zIndex = 10 + i;
        b.appendChild(el);
      });
    }

    // discard pile — a small face-down stack near the centre-top
    const disc = view.discard || [];
    if (disc.length) {
      const show = Math.min(disc.length, 8);
      for (let i = 0; i < show; i++) {
        const el = backCard(); el.classList.add('mini');
        el.style.left = (W * 0.5 - 14 + i * 3.5) + 'px';
        el.style.top = (H * 0.30 + (i % 2) * 3) + 'px';
        el.style.zIndex = 5 + i;
        b.appendChild(el);
      }
    }

    // current plays on the felt, one cluster per seat
    const spot = { 0: { x: W * 0.5, y: H * 0.47 }, 1: { x: W * 0.7, y: H * 0.40 }, 2: { x: W * 0.3, y: H * 0.40 } };
    for (const t of (view.table || [])) {
      const s = spot[t.seat]; const m = t.cards.length;
      const lead = t.seat === view.leadSeat;
      const step = Math.min(20, m > 1 ? Math.min(W * 0.5, 240) / (m - 1) : 0);
      const x0 = s.x - step * (m - 1) / 2;
      t.cards.forEach((c, i) => {
        const el = faceCard(c); el.classList.add('play'); if (lead) el.classList.add('lead');
        el.style.left = (x0 + i * step) + 'px';
        el.style.top = s.y + 'px';
        el.style.zIndex = 40 + i;
        b.appendChild(el);
      });
    }

    // human hand — overlapping row along the bottom; selected cards lift
    const hand = view.hand || [];
    const n = hand.length;
    const avail = W - 16;
    const cw = 46;
    const step = Math.min(cw * 0.66, n > 1 ? (avail - cw) / (n - 1) : 0);
    const x0 = (W - (cw + step * (n - 1))) / 2;
    hand.forEach((card, i) => {
      const sel = view.selected && view.selected.has(card.id);
      const hint = view.hint && view.hint.has(card.id);
      const el = faceCard(card);
      el.classList.add('h');
      if (sel) el.classList.add('sel');
      if (hint) el.classList.add('hint');
      el.style.left = (x0 + i * step) + 'px';
      el.style.zIndex = 100 + i;
      b.appendChild(el);
    });
    // record hit rects after layout (client coords)
    let i = 0;
    for (const el of b.querySelectorAll('.c2.h')) { this.handRects.push({ id: hand[i].id, rect: el.getBoundingClientRect() }); i++; }
  }
}
