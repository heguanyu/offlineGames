// Flat 2D (DOM) board for 掼蛋 on phones — a drop-in alternative to the 3D GuandanScene (scene.js),
// implementing the SAME interface main.js drives (sync / seatScreen / worldToScreen / pick /
// beginDeal / resize / setRotated / setLevel). A RECTANGLE felt; cards as DOM elements (no three.js,
// no WebGL, no rAF loop — repaint only on sync, so it's battery-cheap). Nameplates / bubbles stay
// main.js's overlays, positioned via seatScreen(); this renderer only draws the cards.
// FOUR seats: 0 bottom (you), 1 right, 2 top (partner), 3 left.
import { rankLabel, isWild } from './engine.js';

// Append U+FE0E (text variation selector) so iOS renders ♥/♦ as instant TEXT glyphs (honoring the CSS
// red), not color emoji — the emoji-font load was a 1–2s stall on the first card paint on old iPhones.
const SUIT = ['♠︎', '♥︎', '♣︎', '♦︎'];
const RED = [false, true, false, true];

function faceCard(card, wild) {
  const el = document.createElement('div');
  el.className = 'c2';
  if (card.rank >= 16) {
    el.classList.add(card.rank === 17 ? 'red' : 'blk', 'jk');
    el.innerHTML = `<span class="rk">${card.rank === 17 ? '大' : '小'}</span><span class="su">王</span>`;
  } else {
    el.classList.add(RED[card.suit] ? 'red' : 'blk');
    el.innerHTML = `<span class="rk">${rankLabel(card.rank)}</span><span class="su">${SUIT[card.suit]}</span>`;
  }
  if (wild) el.classList.add('wild');
  return el;
}
function backCard() { const el = document.createElement('div'); el.className = 'c2 back'; return el; }

export class GuandanScene2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.mount = canvas.parentElement;
    this.rotated = false;
    this.level = 2;
    this.board = document.createElement('div');
    this.board.id = 'board2d';
    this.mount.insertBefore(this.board, this.canvas);
    this.handRects = [];
    this._last = null;
    new ResizeObserver(() => this.resize()).observe(this.mount);
  }

  setRotated(r) { this.rotated = !!r; }
  setLevel(l) { this.level = l; }
  resize() { if (this._last) this._render(this._last); }
  sync(view) { this._render(view); }
  beginDeal({ fast } = {}) { return new Promise((r) => setTimeout(r, fast ? 60 : 220)); }

  // Anchor where main.js places a seat's nameplate / bubble (MOUNT-LOCAL coords).
  seatScreen(seat) {
    const W = this.mount.clientWidth, H = this.mount.clientHeight;
    if (seat === 1) return { x: W * 0.91, y: H * 0.12 };  // right — hugging the border
    if (seat === 2) return { x: W * 0.5, y: 66 };         // top (teammate) — UNDER its card fan
    if (seat === 3) return { x: W * 0.09, y: H * 0.12 };  // left — hugging the border
    return { x: W * 0.5, y: H - 22 };                     // you (bottom; flat shows a right-side plate instead)
  }
  worldToScreen() { return { x: this.mount.clientWidth / 2, y: this.mount.clientHeight / 2 }; }

  pick(clientX, clientY) {
    for (let i = this.handRects.length - 1; i >= 0; i--) {
      const r = this.handRects[i].rect;
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return this.handRects[i].id;
    }
    return null;
  }

  _render(view) {
    this._last = view;
    const b = this.board;
    b.innerHTML = '';
    this.handRects = [];
    const W = this.mount.clientWidth, H = this.mount.clientHeight;
    const lv = this.level;

    // on-turn ring — a glowing 1/4 arc rotated to point at the active seat
    const ts = (view.turn != null && view.phase === 'play') ? view.turn : -1;
    if (ts >= 0) {
      const cx = W / 2, cy = H * 0.46, s = this.seatScreen(ts);
      const ang = Math.atan2(s.x - cx, -(s.y - cy)) * 180 / Math.PI;
      const ring = document.createElement('div'); ring.className = 'turn2d';
      ring.style.left = cx + 'px'; ring.style.top = cy + 'px';
      ring.style.transform = `translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`;
      b.appendChild(ring);
    }

    // opponents: the TOP seat (2/partner) fans horizontally; the SIDE seats (1 right, 3 left) stack
    // VERTICALLY along the edge so they don't block the play area (like mahjong's 上下家 rows). The
    // numeric "N 张" nameplate keeps the count explicit.
    for (const seat of [1, 2, 3]) {
      const reveal = view.revealHands && view.revealHands[seat];
      const cards = reveal || Array((view.counts || [0, 0, 0, 0])[seat]).fill(null);
      const m = cards.length;
      cards.forEach((c, i) => {
        const el = c ? faceCard(c, isWild(c, lv)) : backCard();
        el.classList.add('mini');
        if (seat === 2) {                                   // teammate: horizontal fan along the TOP edge (nameplate sits below it)
          const step = Math.min(9, m > 1 ? (W * 0.34) / (m - 1) : 0);
          el.style.left = (W * 0.5 - step * (m - 1) / 2 + i * step) + 'px';
          el.style.top = '20px';
        } else {                                            // sides: vertical column hugging the edge
          const vstep = Math.min(8, m > 1 ? (H * 0.46) / (m - 1) : 0);
          el.style.left = (seat === 1 ? W - 30 : 8) + 'px';
          el.style.top = (H * 0.27 + i * vstep) + 'px';
        }
        el.style.zIndex = 10 + i;
        b.appendChild(el);
      });
    }

    // discard pile — a small face-down stack near the centre
    const disc = view.discard || [];
    if (disc.length) {
      const show = Math.min(disc.length, 10);
      for (let i = 0; i < show; i++) {
        const el = backCard(); el.classList.add('mini');
        el.style.left = (W * 0.5 - 14 + (i % 5) * 3.5) + 'px';
        el.style.top = (H * 0.26 + Math.floor(i / 5) * 4) + 'px';
        el.style.zIndex = 5 + i;
        b.appendChild(el);
      }
    }

    // current plays on the felt, one cluster per seat
    const spot = { 0: { x: W * 0.5, y: H * 0.52 }, 1: { x: W * 0.68, y: H * 0.44 }, 2: { x: W * 0.5, y: H * 0.36 }, 3: { x: W * 0.32, y: H * 0.44 } };
    for (const t of (view.table || [])) {
      const s = spot[t.seat]; const m = t.cards.length;
      const lead = t.seat === view.leadSeat;
      const step = Math.min(18, m > 1 ? Math.min(W * 0.46, 230) / (m - 1) : 0);
      const x0 = s.x - step * (m - 1) / 2;
      t.cards.forEach((c, i) => {
        const el = faceCard(c, isWild(c, lv)); el.classList.add('play'); if (lead) el.classList.add('lead');
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
    const cw = 42;
    const step = Math.min(cw * 0.72, n > 1 ? (avail - cw) / (n - 1) : 0);
    const x0 = (W - (cw + step * (n - 1))) / 2;
    hand.forEach((card, i) => {
      const sel = view.selected && view.selected.has(card.id);
      const hint = view.hint && view.hint.has(card.id);
      const el = faceCard(card, isWild(card, lv));
      el.classList.add('h');
      if (sel) el.classList.add('sel');
      if (hint) el.classList.add('hint');
      el.style.left = (x0 + i * step) + 'px';
      el.style.zIndex = 100 + i;
      b.appendChild(el);
    });
    let i = 0;
    for (const el of b.querySelectorAll('.c2.h')) { this.handRects.push({ id: hand[i].id, rect: el.getBoundingClientRect() }); i++; }
  }

  // no-op FX hooks (the flat board doesn't animate); main.js calls these guarded with ?.
  flushFx() {}
  bombFx() {}
}
