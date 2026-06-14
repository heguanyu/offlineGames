// Shared UI / input helpers for the mahjong games (天津 + 国标 + 无定番). These are
// ruleset-agnostic DOM and controller utilities, so both main.js files import them
// from here instead of each keeping its own copy.
import { tileFaceUrl } from './scene.js';

export const $ = (id) => document.getElementById(id);

// A DOM tile showing its real SVG face (混儿 header, result panel, 吃 buttons, …).
// The 3D table is rendered by scene.js; these flat tiles are for the HTML overlays.
export function faceTileEl(kind, { lg = false, wild = false } = {}) {
  const el = document.createElement('div');
  el.className = 'tile face-tile' + (lg ? ' lg' : '') + (wild ? ' wild' : '');
  const img = document.createElement('img');
  img.className = 'face'; img.src = tileFaceUrl(kind); img.alt = '';
  el.appendChild(img);
  return el;
}

// Draw (or hide) a gold arrow from the discarder's seat to the centred pending
// claim tile, so when you can 碰/吃/杠 it's obvious which player the tile came
// from. Reads scene.claimArrowGeometry(); call it every render — it self-hides
// when no claim tile is up. The SVG lives in #table (same box as the canvas, so
// it inherits the force-landscape rotation and shares worldToScreen's px space).
export function showClaimArrow(scene) {
  const table = $('table');
  if (!table) return;
  let svg = $('claim-arrow');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'claim-arrow';
    table.appendChild(svg);
  }
  const g = scene && scene.claimArrowGeometry ? scene.claimArrowGeometry() : null;
  if (!g) { svg.style.display = 'none'; return; }
  const { from, center, box } = g;
  // unit vector from the tile centre outward toward the discarder
  let ox = from.x - center.x, oy = from.y - center.y;
  const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
  // distance from centre to where that ray leaves the tile's box; tip sits a gap beyond it
  let t = Infinity;
  if (ox > 0) t = Math.min(t, (box.maxX - center.x) / ox); else if (ox < 0) t = Math.min(t, (box.minX - center.x) / ox);
  if (oy > 0) t = Math.min(t, (box.maxY - center.y) / oy); else if (oy < 0) t = Math.min(t, (box.minY - center.y) / oy);
  if (!isFinite(t)) { svg.style.display = 'none'; return; }
  const GAP = 12;
  const tip = { x: center.x + ox * (t + GAP), y: center.y + oy * (t + GAP) };
  // arrow runs from the discarder (tail) to the tile boundary (wide head)
  let dx = tip.x - from.x, dy = tip.y - from.y;
  const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  const HEAD = 34, HALFW = 18, SHAFT = 9;
  const base = { x: tip.x - dx * HEAD, y: tip.y - dy * HEAD };
  const px = -dy, py = dx; // perpendicular, for the wide head
  const head = `${tip.x.toFixed(1)},${tip.y.toFixed(1)} ` +
    `${(base.x + px * HALFW).toFixed(1)},${(base.y + py * HALFW).toFixed(1)} ` +
    `${(base.x - px * HALFW).toFixed(1)},${(base.y - py * HALFW).toFixed(1)}`;
  svg.innerHTML =
    `<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${base.x.toFixed(1)}" y2="${base.y.toFixed(1)}" ` +
    `stroke="#f0d275" stroke-width="${SHAFT}" stroke-linecap="round"/>` +
    `<polygon points="${head}" fill="#f0d275"/>`;
  svg.style.display = '';
}

// A face-down tile (green back) — used to mask the middle two tiles of a 暗杠 /
// 金杠 so a concealed kong reads differently from an open 明杠.
export function backTileEl(lg = false) {
  const el = document.createElement('div');
  el.className = 'tile tile-back' + (lg ? ' lg' : '');
  return el;
}

// Reveal all four seats' final hands around the result overlay — one row pinned
// to each border (玩家 bottom / 下家 right / 对家 top / 上家 left, via #seat-hand-N's
// edge class). Each row is the sorted concealed hand followed by every meld as a
// SEPARATE group (碰 / 吃 / 明杠 / 暗杠 / 金杠); a 暗杠's middle two show as backs.
// `isWild(id)` flags 混儿 (天津); pass nothing for 国标.
export function renderSeatHands(game, isWild = () => false) {
  for (let p = 0; p < 4; p++) {
    const el = $('seat-hand-' + p);
    if (!el) continue;
    el.innerHTML = '';
    const row = document.createElement('div'); row.className = 'meld-group';
    for (const id of game.hands[p].slice().sort((a, b) => a - b)) row.appendChild(faceTileEl(id, { wild: isWild(id) }));
    el.appendChild(row);
    for (const m of game.melds[p] || []) {
      const g = document.createElement('div'); g.className = 'meld-group';
      const hidden = m.type === 'kong' && m.concealed; // 暗杠 / 金杠 — mask the inner pair
      m.tiles.forEach((id, i) => g.appendChild(
        hidden && (i === 1 || i === 2) ? backTileEl() : faceTileEl(id, { wild: isWild(id) })));
      el.appendChild(g);
    }
  }
}

// An action-bar button. `ghost` = secondary style; `extra` = an extra class name.
export function mkBtn(label, fn, ghost, extra) {
  const b = document.createElement('button');
  b.className = 'act-btn' + (ghost ? ' ghost' : '') + (extra ? ' ' + extra : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

// A transient toast bound to a #toast element; returns a toast(msg, big) function
// that owns its own dismiss timer.
export function makeToast(id = 'toast') {
  let timer = null;
  return (msg, big) => {
    const t = $(id); if (!t) return;
    t.textContent = msg; t.className = 'show' + (big ? ' big' : '');
    clearTimeout(timer); timer = setTimeout(() => { t.className = big ? 'big' : ''; }, 1100);
  };
}

// Dispatch keydown to onAction via a { key: actionName } map.
export function bindKeys(onAction, keyMap) {
  addEventListener('keydown', (e) => { const a = keyMap[e.key]; if (a) { e.preventDefault(); onAction(a); } });
}

// Force the page to render landscape (width > height): when the device is held
// portrait, CSS-rotate <body> 90° so it fills the screen as landscape (iOS Safari
// has no orientation-lock API and ignores the manifest's orientation). Never
// upside-down — we only rotate in portrait, always the same way. Calls
// apply(isPortrait) on every change so the caller can tell the 3D scene.
export function forceLandscape(apply) {
  const b = document.body;
  function update() {
    const portrait = window.innerHeight > window.innerWidth;
    if (portrait) {
      const w = window.innerWidth, h = window.innerHeight;
      Object.assign(b.style, {
        position: 'fixed', top: '0', left: '0', overflow: 'hidden',
        width: h + 'px', height: w + 'px',
        transformOrigin: '0 0', transform: `translateX(${w}px) rotate(90deg)`,
      });
    } else {
      for (const k of ['position', 'top', 'left', 'overflow', 'width', 'height', 'transformOrigin', 'transform']) b.style[k] = '';
    }
    apply(portrait);
  }
  addEventListener('resize', update);
  addEventListener('orientationchange', () => setTimeout(update, 50)); // metrics settle late
  // Returning to the PWA (iPad app-switch / unlock) often fires no resize, and iOS
  // may report stale (portrait) metrics for a beat — leaving the page mis-rotated and
  // the canvas mis-sized until a manual rotate. Re-apply on every resume, repeating
  // as the metrics settle so it self-corrects without the user rotating the device.
  const resume = () => { update(); setTimeout(update, 150); setTimeout(update, 450); };
  addEventListener('pageshow', resume);
  addEventListener('focus', resume);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  update();
  return () => window.innerHeight > window.innerWidth; // query current state
}

// Poll the gamepad each frame and dispatch to onAction. `buttonMap` is
// { buttonIndex: actionName }; non-nav buttons are edge-detected (one press = one
// action). left/right — from the left-stick X axis OR the mapped d-pad — key-repeat
// while held, so the selected card keeps moving without re-flicking.
export function startGamepad(onAction, buttonMap) {
  const prev = {};
  let navDir = 0, navNext = 0;
  const REPEAT_DELAY = 380, REPEAT_RATE = 120; // ms: initial hold delay, then steady rate
  const press = (pad, i) => { const d = !!pad.buttons[i]?.pressed, was = prev[i]; prev[i] = d; return d && !was; };
  (function poll() {
    const pad = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).find((p) => p && p.connected);
    if (pad) {
      for (const i in buttonMap) { const a = buttonMap[i]; if (a !== 'left' && a !== 'right' && press(pad, +i)) onAction(a); }
      // left/right with auto-repeat (stick axis, else a held d-pad direction)
      const x = pad.axes[0] || 0;
      let dir = x < -0.5 ? -1 : x > 0.5 ? 1 : 0;
      if (!dir) for (const i in buttonMap) if (pad.buttons[+i]?.pressed) { if (buttonMap[i] === 'left') dir = -1; else if (buttonMap[i] === 'right') dir = 1; }
      const now = performance.now();
      if (dir) {
        if (dir !== navDir) { onAction(dir < 0 ? 'left' : 'right'); navNext = now + REPEAT_DELAY; navDir = dir; }
        else if (now >= navNext) { onAction(dir < 0 ? 'left' : 'right'); navNext = now + REPEAT_RATE; }
      } else navDir = 0;
    }
    requestAnimationFrame(poll);
  })();
}
