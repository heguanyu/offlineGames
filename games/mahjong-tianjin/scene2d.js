// Flat 2D (DOM) table renderer for phones — a drop-in alternative to the 3D
// MahjongScene (scene.js). It implements the exact same interface main.js drives
// (sync / pick / worldToScreen / claimArrowGeometry / beginDeal / beginClaimDemo /
// resize / setRotated, plus handDrawRevealing & onHandDrawSettled), so picking the
// renderer is a one-line choice in main.js and 国标 can reuse it unchanged.
//
// Why DOM over a 2D <canvas>: a canvas needs a requestAnimationFrame loop redrawing
// every frame (constant CPU/GPU wakeups even when idle) — the same battery profile
// as WebGL, which is what we're avoiding on iPhone. The DOM board is rebuilt only
// when sync() is called (i.e. on a real game event); a static board between turns
// costs ~zero. No deck wall, no flight animations — just the live state.
import { faceTileEl, seatBadgeHtml } from './ui-util.js';
import { updateRing } from '../mahjong-common/timer-ring.js';

const WIND = ['东', '南', '西', '北'];
const SEAT_LABEL = ['玩家', '下家', '对家', '上家'];
const HUMAN = 0;

function meldLabel(m, isWild) {
  if (m.type === 'pung') return '碰';
  if (m.type === 'chow') return '吃';
  if (m.type === 'kong') return m.concealed ? (isWild(m.kind ?? m.tiles[0]) ? '金杠' : '暗杠') : '明杠';
  return '';
}

export class MahjongScene2D {
  constructor(canvas) {
    this.canvas = canvas;            // kept as a transparent input overlay (main.js binds it)
    this.mount = canvas.parentElement; // #table — the board lives here, under the canvas
    this.rotated = false;
    this.handDrawRevealing = false;  // no draw animation → input is never gated
    this.onHandDrawSettled = null;

    this.board = document.createElement('div');
    this.board.id = 'board2d';
    this.mount.insertBefore(this.board, this.canvas); // behind the (transparent) canvas

    this.handRects = [];     // [{ pick, rect }] for pick()
    this.oppAnchor = {};     // seat -> { x, y } table-local px, for the claim arrow
    this.pending = null;     // { el } the big claimable tile, for worldToScreen/arrow
    this.handEl = null;
    this.claimDemo = null;   // { player, until } a bot's just-claimed meld, highlighted
    this.discardDemo = null; // { player, idx, t0, ms } a bot's discard flying via the center halt
    this._last = null;       // last { game, ui } so resize() can re-render
    this._lastDrawn = undefined;

    new ResizeObserver(() => this.resize()).observe(this.mount);
  }

  setRotated(r) { this.rotated = !!r; }
  resize() { if (this._last) this._render(this._last.game, this._last.ui); }

  // ---- the interface main.js drives --------------------------------------
  sync(game, ui) {
    this._render(game, ui);
    // No reveal animation: when a fresh tile is drawn, tell main.js it has "settled"
    // so it auto-selects (selectDrawnTile). Fire once per distinct draw; drawnTile
    // returns to null after each discard, so the next draw (even same kind) re-fires.
    const d = ui.drawnTile ?? null;
    if (d !== this._lastDrawn) {
      this._lastDrawn = d;
      if (d != null && ui.myTurn && this.onHandDrawSettled) {
        const cb = this.onHandDrawSettled;
        queueMicrotask(() => cb()); // avoid re-entrant render() within this sync()
      }
    }
  }

  // The initial deal is skipped (no animation): render the dealt board and let play
  // begin on the next frame. onLand is the per-tile clack — we don't stagger, so it
  // goes unused; done() resumes main.js's tick().
  beginDeal(game, done) { this._render(game, { renderedHand: game.hands[HUMAN], myTurn: false }); requestAnimationFrame(() => done()); }

  // Flat mode has no 3D table, so the turn countdown uses the 2D DOM ring (#turn-timer), the shared
  // .ring-timer component (green→yellow→red, shakes in the final seconds).
  setTurnTimer(o) {
    const el = document.getElementById('turn-timer'); if (!el) return;
    updateRing(el, o && o.show ? { show: true, secs: o.secs, frac: o.frac, shake: !!o.low } : { show: false });
  }

  beginClaimDemo(player, ms = 2000) { this.claimDemo = { player, until: performance.now() + ms }; if (this._last) this._render(this._last.game, this._last.ui); }
  // A bot's discard (discardLog index `idx`) flies from its seat to the center halt,
  // holds, then drops into the pool. The fly element is built in _render; main.js holds
  // the tick for `ms`, so no re-sync interrupts it until it's done.
  beginDiscardDemo(player, idx, ms = 1350) { this.discardDemo = { player, idx, t0: performance.now(), ms }; }

  // Anchor for the claim prompt (碰/杠/过): centred horizontally, just above the
  // hand row. main.js calls this only as worldToScreen(0,0,5). Table-local px.
  worldToScreen() {
    const mr = this.mount.getBoundingClientRect();
    let y = mr.height * 0.6;
    if (this.handEl) y = this.handEl.getBoundingClientRect().top - mr.top - 8;
    return { x: mr.width / 2, y };
  }

  pick(clientX, clientY) {
    for (const h of this.handRects) {
      const r = h.rect;
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return h.pick;
    }
    return null;
  }

  // ---- rendering ----------------------------------------------------------
  _render(game, ui) {
    this._last = { game, ui };
    const isWild = (id) => !!(game.isWild && game.isWild(id));
    const b = this.board;
    b.innerHTML = '';
    this.handRects = [];
    this.oppAnchor = {};
    this.pending = null;
    this.handEl = null;
    const over = ui.reveal || (game.phase != null && game.result); // result overlay covers the board

    // ---- opponents: compact nameplate + back-count + melds ----
    const SIDE = { 1: 'right', 2: 'top', 3: 'left' }; // 下家 right, 对家 top, 上家 left
    for (const p of [1, 2, 3]) {
      const opp = document.createElement('div');
      opp.className = 'b2-opp b2-opp-' + SIDE[p];
      const active = game.turn === p && !over;
      const dealer = p === game.dealer;
      const plate = document.createElement('div');
      plate.className = 'b2-plate' + (active ? ' active' : '') + (dealer ? ' dealer' : '');
      plate.innerHTML = seatBadgeHtml(game, p) +
        `<span class="wind">${WIND[game.seatWind(p)]}</span><span>${SEAT_LABEL[p]}</span>` +
        (active ? '<span class="think">思考中…</span>' : '');
      opp.appendChild(plate);
      // back-count: a small fan of tile-backs + ×N
      const n = game.hands[p].length;
      const backs = document.createElement('div');
      backs.className = 'b2-backs';
      backs.innerHTML = '<span class="b2-back"></span><span class="b2-back"></span><span class="b2-back"></span>' +
        `<span class="b2-cnt">×${n}</span>`;
      opp.appendChild(backs);
      // exposed melds
      const melds = game.melds[p] || [];
      if (melds.length) {
        const demo = this.claimDemo && this.claimDemo.player === p && performance.now() < this.claimDemo.until;
        const mrow = document.createElement('div');
        mrow.className = 'b2-melds' + (demo ? ' demo' : '');
        for (const m of melds) mrow.appendChild(this._meld(m, isWild));
        opp.appendChild(mrow);
      }
      b.appendChild(opp);
    }

    // ---- central discard pool: one wide block per suit, spread across the wide
    // dimension. Within a suit, rank-sorted tiles fill POOL_COLS per row, left→right
    // then bottom→top (oldest/lowest at the bottom, the block growing upward). ----
    const log = game.discardLog || [];
    const pendingIdx = ui.claimable && log.length ? log.length - 1 : -1;
    // A bot's discard flying via the center halt is drawn as a separate fly element
    // (below), so it's left out of the static pool until it lands.
    const dd = this.discardDemo;
    const demoIdx = (dd && performance.now() < dd.t0 + dd.ms) ? dd.idx : -1;
    const POOL_COLS = 5;
    const pool = document.createElement('div');
    pool.className = 'b2-pool';
    const cols = [[], [], [], []]; // 万 筒 条 字
    const colOf = (kind) => (kind < 9 ? 0 : kind < 18 ? 1 : kind < 27 ? 2 : 3);
    log.forEach((d, i) => { if (i !== pendingIdx && i !== demoIdx) cols[colOf(d.kind)].push(d); });
    for (const list of cols) {
      list.sort((a, b2) => a.kind - b2.kind);
      const block = document.createElement('div');
      block.className = 'b2-pool-type';
      const rows = [];
      for (let k = 0; k < list.length; k += POOL_COLS) rows.push(list.slice(k, k + POOL_COLS));
      // bottom→top piling: render the last row first so the first row sits at the bottom
      for (let ri = rows.length - 1; ri >= 0; ri--) {
        const row = document.createElement('div');
        row.className = 'b2-pool-row';
        for (const d of rows[ri]) row.appendChild(faceTileEl(d.kind, { wild: isWild(d.kind) }));
        block.appendChild(row);
      }
      pool.appendChild(block);
    }
    b.appendChild(pool);

    // ---- the big claimable tile, front-centre, glowing ----
    if (pendingIdx >= 0) {
      const d = log[pendingIdx];
      const wrap = document.createElement('div');
      wrap.className = 'b2-pending';
      const tile = faceTileEl(d.kind, { lg: true, wild: isWild(d.kind) });
      wrap.appendChild(tile);
      b.appendChild(wrap);
      this.pending = { el: wrap, player: d.player };
    }

    // ---- the human's own melds (just above the hand) ----
    const myMelds = game.melds[HUMAN] || [];
    if (myMelds.length) {
      const mrow = document.createElement('div');
      mrow.className = 'b2-mymelds';
      for (const m of myMelds) mrow.appendChild(this._meld(m, isWild));
      b.appendChild(mrow);
    }

    // ---- the human's hand (bottom) ----
    const hand = ui.renderedHand || game.hands[HUMAN] || [];
    const handEl = document.createElement('div');
    handEl.className = 'b2-hand';
    // Tile size is keyed to a FIXED reference count (a full hand for the current meld
    // count: 14 - 3·melds) so it doesn't shrink/grow as the hand cycles 13↔14 tiles —
    // the row keeps a steady size. Set inline per tile so it beats the base .tile rule.
    const DRAW_GAP = 8; // flanks the freshly-drawn tile so it reads as just-drawn
    const refCount = Math.max(hand.length, 14 - 3 * myMelds.length);
    const avail = this.mount.clientWidth - 16;
    const tw = Math.max(24, Math.min(52, Math.floor((avail - 2 * DRAW_GAP) / refCount) - 4));
    const th = Math.round(tw * 1.35);
    // renderedHand already sorts the drawn tile into place; flank that slot with a gap.
    const drawnIdx = ui.drawnTile != null ? hand.lastIndexOf(ui.drawnTile) : -1;
    const ownBacks = !!ui.ownBacks; // blind 拉庄: show your own hand face-down until you answer
    const hideWilds = !!ui.hideWilds; // 拉庄: 混儿 undecided → don't mark wild tiles
    hand.forEach((id, i) => {
      let t;
      if (ownBacks) { t = document.createElement('div'); t.className = 'tile face-tile back'; }
      else t = faceTileEl(id, { wild: !hideWilds && isWild(id) });
      t.classList.add('b2-htile');
      t.style.setProperty('--tw', tw + 'px');
      t.style.setProperty('--th', th + 'px');
      if (i === drawnIdx) { t.style.marginLeft = DRAW_GAP + 'px'; t.style.marginRight = DRAW_GAP + 'px'; }
      t.dataset.pick = i;
      if (!ownBacks && i === ui.selRendered) t.classList.add('sel'); // selRendered gated by render() (on-turn offline; also waiting online)
      handEl.appendChild(t);
    });
    b.appendChild(handEl);
    this.handEl = handEl;

    // Anchor the pool's bottom edge above the hand row (it grows upward): a 20px gap
    // plus another 10% of the board height, so it sits clear of the hand.
    const pr = this.mount.getBoundingClientRect();
    const handTopLocal = handEl.getBoundingClientRect().top - pr.top;
    pool.style.top = 'auto';
    pool.style.transform = 'translateX(-50%)';
    pool.style.bottom = (pr.height - handTopLocal + 20 + pr.height * 0.1) + 'px';

    // Record hand-tile hit rects for pick() (client coords; getBoundingClientRect
    // already accounts for the force-landscape body rotation).
    for (const t of handEl.children) {
      this.handRects.push({ pick: +t.dataset.pick, rect: t.getBoundingClientRect() });
    }

    // Opponent anchors for the claim arrow (table-local centres).
    const mr = this.mount.getBoundingClientRect();
    for (const opp of b.querySelectorAll('.b2-opp')) {
      const r = opp.getBoundingClientRect();
      const cls = opp.className;
      const p = cls.includes('b2-opp-right') ? 1 : cls.includes('b2-opp-top') ? 2 : 3;
      this.oppAnchor[p] = { x: r.left + r.width / 2 - mr.left, y: r.top + r.height / 2 - mr.top };
    }

    // ---- turn-ring: a glowing quarter-arc pointing at the active seat (mirrors the 3D
    // felt ring). A conic-gradient ring masked to a thin band; the `from` angle aims the
    // bright quarter at the seat (玩家 down / 下家 right / 对家 up / 上家 left). ----
    if (!over) {
      const ring = document.createElement('div');
      ring.className = 'b2-ring';
      const D = Math.min(mr.width, mr.height) * 0.66;
      ring.style.width = ring.style.height = D + 'px';
      ring.style.left = (mr.width / 2) + 'px';
      ring.style.top = (mr.height * 0.42) + 'px';
      const FROM = { 0: 135, 1: 45, 2: -45, 3: 225 };
      ring.style.background = `conic-gradient(from ${FROM[game.turn] ?? 135}deg, #ffd23a 0deg 90deg, transparent 90deg 360deg)`;
      b.insertBefore(ring, b.firstChild); // behind the tiles
    }

    // ---- a bot's discard flying via the center halt: seat → center (hold) → pool ----
    if (demoIdx >= 0) this._flyDiscard(log[demoIdx], dd, pool);

    b.classList.toggle('over', !!over);
  }

  // Build + animate the flying discard tile with CSS transitions (no rAF loop). The
  // tick is held by main.js for dd.ms, so the next _render (which clears the board)
  // only happens after the tile has landed.
  _flyDiscard(d, dd, pool) {
    const isWild = (id) => !!(this._last.game.isWild && this._last.game.isWild(id));
    const mr = this.mount.getBoundingClientRect();
    // bots fly from their nameplate; the player (no oppAnchor) flies up from the hand row.
    const start = this.oppAnchor[dd.player] || { x: mr.width / 2, y: mr.height - 70 };
    const center = { x: mr.width / 2, y: mr.height * 0.4 };
    const pr = pool.getBoundingClientRect();
    const end = { x: pr.left + pr.width / 2 - mr.left, y: pr.top + pr.height / 2 - mr.top };
    const fly = faceTileEl(d.kind, { wild: isWild(d.kind) });
    fly.className += ' b2-fly';
    fly.style.setProperty('--tw', '40px');
    fly.style.setProperty('--th', '54px');
    const at = (pt, s) => `translate(${pt.x}px, ${pt.y}px) translate(-50%, -50%) scale(${s})`;
    fly.style.transform = at(start, 0.6);
    this.board.appendChild(fly);
    fly.getBoundingClientRect(); // force reflow so the first transition runs
    requestAnimationFrame(() => {        // phase 1: rise to the center halt, enlarged (~0.4s)
      fly.style.transition = 'transform 0.4s ease-out';
      fly.style.transform = at(center, 1.5);
    });
    setTimeout(() => {                    // phase 3: after the halt, drop into the pool (fast)
      fly.style.transition = 'transform 0.16s ease-in';
      fly.style.transform = at(end, 0.55);
    }, dd.ms); // halt ends at dd.ms (= 0.4s rise + ~0.5s hold); the quick drop runs into the settle window
  }

  _meld(m, isWild) {
    const g = document.createElement('div');
    g.className = 'b2-meld';
    const tag = document.createElement('span');
    const lbl = meldLabel(m, isWild); // 明杠 yellow · 暗杠 red · 金杠 gold (match the 3D 杠 indicator)
    tag.className = 'b2-tag' + (lbl === '明杠' ? ' open' : lbl === '暗杠' ? ' conc' : '');
    tag.textContent = lbl;
    g.appendChild(tag);
    for (const id of m.tiles) g.appendChild(faceTileEl(id, { wild: isWild(id) }));
    return g;
  }
}
