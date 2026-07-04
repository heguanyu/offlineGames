// Shared billiards table geometry — used by BOTH games (黑八 pool8 + 斯诺克 snooker), which
// differ only in the numbers they feed in (a 9ft pool table vs a 12ft snooker table, ball and
// pocket sizes). All physics/render/AI code works off the spec this builds, in METERS:
//   x = the LONG axis (−L/2 … +L/2; the break/baulk end is NEGATIVE x), y = the short axis.
// The 3D scene maps (x, y) → world (x, ·, z); the 2D scene projects it top-down.
//
// The play field boundary is the cushion NOSE line (|x| = L/2, |y| = W/2). Rails are segments
// along that line with gaps at the six pockets; each gap is closed by two angled "jaw" segments
// that funnel a ball toward the pocket circle, so the table is geometrically sealed — a ball
// can only leave the field by entering a pocket's capture circle.

// Build the runtime table spec from a per-game config:
//   { L, W, ballR, cornerR, sideR, cornerGap, sideGap, ...extras }
//   cornerR/sideR   = pocket capture radii (ball center inside → potted)
//   cornerGap/sideGap = rail cut-back from the corner point / side-pocket center
// Extra fields (feltColor, markings, …) are passed through untouched for the renderers.
export function buildTable(cfg) {
  const { L, W, ballR, cornerR, sideR, cornerGap, sideGap } = cfg;
  const hx = L / 2, hy = W / 2;

  // Pocket centers sit a bit OUTSIDE the nose line so a ball must really commit to fall.
  const co = cornerR * 0.30;             // corner center offset (diagonal, outward)
  const so = sideR * 0.42;               // side-pocket center offset (straight out)
  const pockets = [
    { id: 0, x: -hx - co, y: -hy - co, r: cornerR, corner: true },
    { id: 1, x: +hx + co, y: -hy - co, r: cornerR, corner: true },
    { id: 2, x: -hx - co, y: +hy + co, r: cornerR, corner: true },
    { id: 3, x: +hx + co, y: +hy + co, r: cornerR, corner: true },
    { id: 4, x: 0, y: -hy - so, r: sideR, corner: false },
    { id: 5, x: 0, y: +hy + so, r: sideR, corner: false },
  ];

  // Each segment carries its OUTWARD normal (nx, ny) — the side the visual cushion body sits
  // on. Rails: away from the table center. Jaws: away from their pocket, so the body flares
  // the throat open instead of blocking the mouth. (Physics ignores this — it reflects off
  // the closest-point normal — it's for the renderers.)
  const cushions = [];
  const seg = (ax, ay, bx, by, jaw = false) => {
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
    let nx = -dy / l, ny = dx / l;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let rx = mx, ry = my;                // rails: side test vs the table center (0,0)
    if (jaw) {                           // jaws: side test vs their (nearest) pocket center
      let best = null, bd = Infinity;
      for (const p of pockets) { const d = Math.hypot(mx - p.x, my - p.y); if (d < bd) { bd = d; best = p; } }
      rx = mx - best.x; ry = my - best.y;
    }
    if (rx * nx + ry * ny < 0) { nx = -nx; ny = -ny; }
    cushions.push({ ax, ay, bx, by, nx, ny });
  };
  const cg = cornerGap, sg = sideGap;
  const jl = cornerGap * 0.9;            // jaw length
  const jd = jl * Math.SQRT1_2;          // 45° jaw component

  // Long rails (top y=+hy, bottom y=−hy), each split by the side pocket.
  for (const s of [-1, +1]) {
    const y = hy * s;
    seg(-hx + cg, y, -sg, y);            // baulk-side half
    seg(+sg, y, +hx - cg, y);            // top-side half
    // corner jaws (45° outward, away from the field)
    seg(-hx + cg, y, -hx + cg - jd, y + jd * s, true);
    seg(+hx - cg, y, +hx - cg + jd, y + jd * s, true);
    // side-pocket jaws (steep, slightly flared so the mouth funnels in)
    const sj = sideGap * 0.85;
    seg(-sg, y, -sg - sj * 0.3, y + sj * s, true);
    seg(+sg, y, +sg + sj * 0.3, y + sj * s, true);
  }
  // Short rails (left x=−hx, right x=+hx) — no side pockets.
  for (const s of [-1, +1]) {
    const x = hx * s;
    seg(x, -hy + cg, x, +hy - cg);
    seg(x, -hy + cg, x + jd * s, -hy + cg - jd, true);
    seg(x, +hy - cg, x + jd * s, +hy - cg + jd, true);
  }

  return { ...cfg, hx, hy, pockets, cushions };
}

// ---- shared vector helpers (used by physics + AI + renderers) ---------------
export const vlen = (x, y) => Math.hypot(x, y);
export const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };

// Closest point on segment AB to P; returns {x, y, t}.
export function closestOnSeg(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + dx * t, y: ay + dy * t, t };
}

// Is the corridor from A to B (width 2*rad) free of every in-play ball not in `skip`?
export function corridorClear(balls, ax, ay, bx, by, rad, skip) {
  for (const b of balls) {
    if (!b.inPlay || skip.has(b.id)) continue;
    const c = closestOnSeg(ax, ay, bx, by, b.x, b.y);
    if (Math.hypot(b.x - c.x, b.y - c.y) < rad) return false;
  }
  return true;
}

// Is (x,y) a legal resting spot for a ball? (inside the field, off every other ball)
export function spotFree(spec, balls, x, y, ignoreId = -1) {
  const r = spec.ballR;
  if (Math.abs(x) > spec.hx - r || Math.abs(y) > spec.hy - r) return false;
  for (const b of balls) {
    if (!b.inPlay || b.id === ignoreId) continue;
    if (Math.hypot(b.x - x, b.y - y) < r * 2) return false;
  }
  return true;
}

// Clamp a requested in-hand placement into `region`, one of:
//   'anywhere'  — the whole field
//   'kitchen'   — behind the head string (x ≤ spec.kitchenX; 黑八 break / scratch-casual)
//   'D'         — snooker's D semicircle (center (spec.baulkX, 0), radius spec.dR, opening toward −x)
export function clampToRegion(spec, region, x, y) {
  const r = spec.ballR;
  x = Math.max(-spec.hx + r, Math.min(spec.hx - r, x));
  y = Math.max(-spec.hy + r, Math.min(spec.hy - r, y));
  if (region === 'kitchen') x = Math.min(x, spec.kitchenX - r * 0.5);
  else if (region === 'D') {
    x = Math.min(x, spec.baulkX);                   // the D bulges toward the baulk cushion (−x)
    const dx = x - spec.baulkX, dy = y - 0;
    const d = Math.hypot(dx, dy);
    if (d > spec.dR) { x = spec.baulkX + (dx / d) * spec.dR; y = (dy / d) * spec.dR; }
  }
  return { x, y };
}
