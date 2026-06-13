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
  update();
  return () => window.innerHeight > window.innerWidth; // query current state
}

// Poll the gamepad each frame (edge-detected) and dispatch to onAction. `buttonMap`
// is { buttonIndex: actionName }; the left-stick X axis also emits left/right.
export function startGamepad(onAction, buttonMap) {
  const prev = {}; let axisLatch = false;
  const press = (pad, i) => { const d = !!pad.buttons[i]?.pressed, was = prev[i]; prev[i] = d; return d && !was; };
  (function poll() {
    const pad = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).find((p) => p && p.connected);
    if (pad) {
      for (const i in buttonMap) if (press(pad, +i)) onAction(buttonMap[i]);
      const x = pad.axes[0] || 0;
      if (Math.abs(x) > 0.5) { if (!axisLatch) { onAction(x < 0 ? 'left' : 'right'); axisLatch = true; } } else axisLatch = false;
    }
    requestAnimationFrame(poll);
  })();
}
