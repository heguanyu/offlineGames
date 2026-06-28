// 省电模式 (power mode) — a shared, persisted 3-tier setting for the card games (麻将 天津/国标/
// 国标无定番, 斗地主, 掼蛋), part of the battery-reduction work (see docs/card-battery.md).
//
//   流畅 smooth   — full 3D: pixelRatio≤2 (Retina), shadows + antialias on. The default on devices
//                   that already ran 3D (no visual change for existing users).
//   均衡 balanced — cheaper 3D: pixelRatio 1, no shadows, no antialias. ~½–¾ the per-frame fill.
//   省电 eco      — the flat 2D (DOM) renderer even on a tablet, uniformly scaled up to fill the
//                   bigger screen. Near-zero idle cost (no WebGL loop at all).
//
// One localStorage key shared across all the games. The renderer (2D vs 3D) is chosen at page load,
// so changing the tier re-loads the page to apply (changePowerMode does this).

const KEY = 'power-mode';
export const POWER_MODES = ['smooth', 'balanced', 'eco'];
export const POWER_LABELS = { smooth: '流畅', balanced: '均衡', eco: '省电' };
const POWER_SUB = { smooth: '3D', balanced: '省电 3D', eco: '2D' };

// '' = unset (auto: phones flat-2D, tablets/desktop full-3D — the historical behaviour).
export function getPowerMode() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
export function setPowerMode(m) { try { localStorage.setItem(KEY, m); } catch {} }

// Is this a phone-class screen? (the historical flat-2D trigger: short side < 600 CSS px, or an iPhone)
export function isPhone() {
  return Math.min(screen.width, screen.height) < 600 || /iPhone|iPod/.test(navigator.userAgent);
}

// Should the flat 2D renderer be used? eco → always; smooth/balanced → never; unset → phones only.
export function useFlatRenderer(phone = isPhone()) {
  const m = getPowerMode();
  if (m === 'eco') return true;
  if (m === 'smooth' || m === 'balanced') return false;
  return phone;
}

// The effective 3D tier for the WebGL scenes. Default (and 'smooth') → full; only 'balanced' is cheap.
export function is3DLite() { return getPowerMode() === 'balanced'; }

// Apply the tier's profile to a freshly-created THREE.WebGLRenderer. Antialias can't change after
// construction, so the scene must pass `antialias: !is3DLite()` to the constructor itself; this sets
// the rest (pixel ratio + shadows). Returns the chosen lite flag for the caller.
export function apply3DProfile(renderer) {
  const lite = is3DLite();
  renderer.setPixelRatio(lite ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = !lite;
  return lite;
}

// Persist a new tier and reload so the renderer choice (made at load) takes effect. Re-loads the same
// URL via replace (keeps history shallow — see the repo's navigation rule).
export function changePowerMode(m) {
  if (!POWER_MODES.includes(m)) return;
  setPowerMode(m);
  location.replace(location.href);
}

// ---- uniform scale wrapper (eco-on-a-big-screen) --------------------------
// The flat 2D layout is tuned for a phone-landscape logical width. On a tablet we render it at that
// design width and CSS-transform-scale the whole #table up to fill the screen, so cards/text/spacing
// all grow together (the "uniform scale wrapper"). Phones keep their native 1:1 layout. The 2D
// renderers read `mount.clientWidth` for layout, so sizing #table to the design width makes them lay
// out in design space; the transform then scales the result. Returns the fit() fn (also re-runs on
// resize). No-op unless the flat renderer is actually active.
const FLAT_REF_W = 760; // phone-landscape logical width the flat layouts are designed against
export function applyFlatScale(tableEl) {
  if (!tableEl) return () => {};
  const fit = () => {
    const winW = window.innerWidth, winH = window.innerHeight;
    // small screen (real phone) → native layout; clear any scaling we may have set
    if (winW <= FLAT_REF_W * 1.06) {
      for (const p of ['position', 'left', 'top', 'width', 'height', 'transform', 'transformOrigin']) tableEl.style[p] = '';
      return;
    }
    const scale = winW / FLAT_REF_W;
    tableEl.style.position = 'absolute';
    tableEl.style.left = '0';
    tableEl.style.top = '0';
    tableEl.style.width = FLAT_REF_W + 'px';
    tableEl.style.height = (winH / scale) + 'px'; // design height so the scaled height fills the viewport
    tableEl.style.transformOrigin = 'top left';
    tableEl.style.transform = `scale(${scale})`;
  };
  fit();
  window.addEventListener('resize', fit);
  return fit;
}

// ---- settings control (injected into each game's menu) --------------------
// Builds the 省电模式 row (three segmented buttons) and appends it to `container`. Selecting a tier
// persists it and reloads. `before` (optional) inserts the row before that node instead of appending.
export function mountPowerControl(container, before = null) {
  if (!container) return;
  const cur = getPowerMode() || (isPhone() ? 'eco' : 'smooth'); // reflect the effective default
  const wrap = document.createElement('div');
  wrap.className = 'power-mode-row';
  wrap.style.cssText = 'margin-bottom:10px;text-align:left;';
  const label = document.createElement('div');
  label.textContent = '省电模式';
  label.style.cssText = 'font-size:0.82rem;color:#9a9ab3;margin-bottom:6px;';
  wrap.appendChild(label);
  const seg = document.createElement('div');
  seg.style.cssText = 'display:flex;gap:6px;';
  for (const m of POWER_MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m;
    b.innerHTML = `${POWER_LABELS[m]}<span style="display:block;font-size:0.62rem;opacity:0.7">${POWER_SUB[m]}</span>`;
    b.style.cssText = 'flex:1;padding:7px 4px;border-radius:9px;border:1px solid #2c3a63;background:none;color:#9fb4ff;font:inherit;font-size:0.82rem;cursor:pointer;line-height:1.2;';
    if (m === cur) { b.style.background = '#0f3460'; b.style.color = '#fff'; b.style.borderColor = '#1b4b8a'; }
    b.addEventListener('click', () => { if (m !== cur) changePowerMode(m); });
    seg.appendChild(b);
  }
  wrap.appendChild(seg);
  if (before && before.parentNode === container) container.insertBefore(wrap, before);
  else container.appendChild(wrap);
}
