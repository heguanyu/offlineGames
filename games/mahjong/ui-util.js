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
