// Reusable circular countdown ring, shared by the lobby ready timer and the in-game turn timer
// (the flat 2D ring is a .ring-timer DOM element; the 3D canvas ring reuses ringColor()). The look
// lives in timer-ring.css; this drives it through CSS vars + classes. The colour sweeps smoothly
// green → yellow → red as time runs out, and the ring shakes through the final seconds.

// frac is the remaining fraction (1 → 0). Hue 120 (green) → 60 (yellow at half) → 0 (red), linear.
export const ringHue = (frac) => 120 * Math.max(0, Math.min(1, frac));
export const ringColor = (frac) => `hsl(${ringHue(frac).toFixed(1)}, 78%, 52%)`;

// Update a .ring-timer element from { show, secs, frac, shake }. Hidden when !show.
export function updateRing(el, o) {
  if (!el) return;
  if (!o || !o.show) { el.classList.add('hidden'); return; }
  const frac = Math.max(0, Math.min(1, o.frac));
  el.style.setProperty('--rt-pct', (frac * 100).toFixed(1));
  el.style.setProperty('--rt-hue', ringHue(frac).toFixed(1));
  el.classList.toggle('shake', !!o.shake);
  const num = el.querySelector('.rt-num'); if (num) num.textContent = o.secs;
  el.classList.remove('hidden');
}

// Build a fresh ring element (the lobby creates its ring on the fly; the in-game ring is in markup).
export function createRing(extraClass = '') {
  const el = document.createElement('div');
  el.className = 'ring-timer' + (extraClass ? ' ' + extraClass : '');
  el.innerHTML = '<span class="rt-num"></span>';
  return el;
}
