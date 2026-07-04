// Shared 2D billiards physics. Balls live on the table plane; the 3D scene only *renders* in 3D,
// so one simulation serves both views. Fixed-substep integration (1/600 s — at the 8 m/s speed
// cap a ball moves <7 mm per substep, well under a ball radius, so nothing tunnels).
//
// A shot produces an `events` record the rule engines consume:
//   firstHit  — id of the first ball the cue ball touched (null = whiff)
//   potted    — ball ids in the order they dropped (may include the cue, id 0)
//   cuePotted — the scratch flag
//   railAfter — did any ball touch a cushion AFTER the first contact? (the "no rail" foul)
import { closestOnSeg, norm } from './geometry.js';

const H = 1 / 600;            // physics substep (s)
const ROLL_DEC = 0.62;        // rolling-friction deceleration (m/s²)
const DRAG = 0.10;            // proportional drag (per second) — kills endless slow crawls
const STOP_V = 0.035;         // below this speed a ball just stops (m/s)
const E_BALL = 0.96;          // ball-ball restitution
const E_RAIL = 0.72;          // cushion normal restitution
const RAIL_T = 0.86;          // cushion tangential keep
export const MAX_SPEED = 8;

export function makeBall(id, x, y, visual) {
  return { id, x, y, vx: 0, vy: 0, inPlay: true, ...visual };
}

export class Simulation {
  // `hooks` (all optional): onHit(speed), onRail(speed), onPot(ball, pocket) — sound/FX taps.
  constructor(spec, balls, hooks = {}) {
    this.spec = spec; this.balls = balls; this.hooks = hooks;
    this.events = null;
  }
  cue() { return this.balls.find((b) => b.id === 0); }

  shoot(dir, speed) {
    const c = this.cue();
    const d = norm(dir.x, dir.y);
    const v = Math.min(speed, MAX_SPEED);
    c.vx = d.x * v; c.vy = d.y * v;
    this.events = { firstHit: null, potted: [], cuePotted: false, railAfter: false };
  }

  moving() { return this.balls.some((b) => b.inPlay && (b.vx || b.vy)); }

  // Advance by real elapsed `dt` seconds. Returns true while anything still moves.
  step(dt) {
    let t = Math.min(dt, 0.06);
    while (t > 0) { this._sub(Math.min(H, t)); t -= H; }
    return this.moving();
  }

  _sub(h) {
    const { spec, balls, events: ev } = this;
    const r = spec.ballR;
    // integrate + friction
    for (const b of balls) {
      if (!b.inPlay) continue;
      let v = Math.hypot(b.vx, b.vy);
      if (!v) continue;
      b.x += b.vx * h; b.y += b.vy * h;
      const nv = Math.max(0, v - ROLL_DEC * h) * (1 - DRAG * h);
      if (nv < STOP_V) { b.vx = b.vy = 0; continue; }
      b.vx *= nv / v; b.vy *= nv / v;
    }
    // ball–ball collisions
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]; if (!a.inPlay) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j]; if (!b.inPlay) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= r * 2 || d === 0) continue;
        const nx = dx / d, ny = dy / d;
        const push = (r * 2 - d) / 2 + 1e-5;      // positional de-overlap, split evenly
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;   // closing speed along the normal
        if (rel <= 0) continue;
        const imp = rel * (1 + E_BALL) / 2;
        a.vx -= imp * nx; a.vy -= imp * ny;
        b.vx += imp * nx; b.vy += imp * ny;
        if (ev && ev.firstHit === null && (a.id === 0 || b.id === 0)) ev.firstHit = (a.id === 0 ? b : a).id;
        if (this.hooks.onHit) this.hooks.onHit(rel);
      }
    }
    // cushions (+ pocket capture)
    for (const b of balls) {
      if (!b.inPlay) continue;
      for (const p of spec.pockets) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < p.r) {
          b.inPlay = false; b.vx = b.vy = 0; b.pocket = p.id;
          if (ev) { ev.potted.push(b.id); if (b.id === 0) ev.cuePotted = true; }
          if (this.hooks.onPot) this.hooks.onPot(b, p);
          break;
        }
      }
      if (!b.inPlay) continue;
      for (const s of spec.cushions) {
        const c = closestOnSeg(s.ax, s.ay, s.bx, s.by, b.x, b.y);
        const dx = b.x - c.x, dy = b.y - c.y;
        const d = Math.hypot(dx, dy);
        if (d >= r || d === 0) continue;
        const nx = dx / d, ny = dy / d;                 // from cushion toward the ball
        b.x += nx * (r - d + 1e-5); b.y += ny * (r - d + 1e-5);
        const vn = b.vx * nx + b.vy * ny;
        if (vn >= 0) continue;
        const tx = b.vx - vn * nx, ty = b.vy - vn * ny;
        b.vx = tx * RAIL_T - vn * E_RAIL * nx;
        b.vy = ty * RAIL_T - vn * E_RAIL * ny;
        if (ev && ev.firstHit !== null) ev.railAfter = true;
        if (this.hooks.onRail) this.hooks.onRail(-vn);
      }
      // escape hatch: the jaws seal the field, but if a ball ever tunnels out, drop it
      // into the nearest pocket rather than losing it off-world.
      if (Math.abs(b.x) > spec.hx + r * 4 || Math.abs(b.y) > spec.hy + r * 4) {
        let best = spec.pockets[0], bd = Infinity;
        for (const p of spec.pockets) { const d = Math.hypot(b.x - p.x, b.y - p.y); if (d < bd) { bd = d; best = p; } }
        b.inPlay = false; b.vx = b.vy = 0; b.pocket = best.id;
        if (ev) { ev.potted.push(b.id); if (b.id === 0) ev.cuePotted = true; }
      }
    }
  }
}

// ---- aim-line / AI ray casting ----------------------------------------------
// Sweep a ball-sized circle from `from` along unit `dir`; find the first thing it meets.
// Returns { t, x, y, type:'ball'|'cushion'|'pocket'|'none', ball?, nx?, ny? } where (x,y) is
// the CENTER of the moving ball at contact and (nx,ny) the cushion normal when type='cushion'.
export function castRay(spec, balls, from, dir, excludeId = 0, maxT = 20) {
  const r = spec.ballR;
  let best = { t: maxT, type: 'none', x: from.x + dir.x * maxT, y: from.y + dir.y * maxT };
  for (const b of balls) {                                   // balls: |P+td − B| = 2r
    if (!b.inPlay || b.id === excludeId) continue;
    const ex = b.x - from.x, ey = b.y - from.y;
    const proj = ex * dir.x + ey * dir.y;
    if (proj <= 0) continue;
    const perp2 = ex * ex + ey * ey - proj * proj;
    const R = r * 2, back = R * R - perp2;
    if (back < 0) continue;
    const t = proj - Math.sqrt(back);
    if (t > 1e-6 && t < best.t) best = { t, type: 'ball', ball: b, x: from.x + dir.x * t, y: from.y + dir.y * t };
  }
  for (const p of spec.pockets) {                            // pockets: enter the capture circle
    const ex = p.x - from.x, ey = p.y - from.y;
    const proj = ex * dir.x + ey * dir.y;
    if (proj <= 0) continue;
    const perp2 = ex * ex + ey * ey - proj * proj;
    const back = p.r * p.r - perp2;
    if (back < 0) continue;
    const t = proj - Math.sqrt(back);
    if (t > 1e-6 && t < best.t) best = { t, type: 'pocket', pocket: p, x: from.x + dir.x * t, y: from.y + dir.y * t };
  }
  for (const s of spec.cushions) {                           // cushions: moving circle vs capsule
    const sx = s.bx - s.ax, sy = s.by - s.ay;
    const sl = Math.hypot(sx, sy) || 1;
    let nx = -sy / sl, ny = sx / sl;                         // segment normal
    const d0 = (from.x - s.ax) * nx + (from.y - s.ay) * ny;  // signed dist of P from the line
    if (d0 < 0) { nx = -nx; ny = -ny; }                      // normal toward the ball's side
    const dist0 = Math.abs(d0);
    const vn = dir.x * nx + dir.y * ny;
    if (vn < -1e-9 && dist0 > r) {
      const t = (dist0 - r) / -vn;
      if (t > 1e-6 && t < best.t) {
        const cx = from.x + dir.x * t, cy = from.y + dir.y * t;
        const along = ((cx - s.ax) * sx + (cy - s.ay) * sy) / (sl * sl);
        if (along >= 0 && along <= 1) best = { t, type: 'cushion', x: cx, y: cy, nx, ny };
      }
    }
    for (const [px, py] of [[s.ax, s.ay], [s.bx, s.by]]) {   // endpoint caps
      const ex = px - from.x, ey = py - from.y;
      const proj = ex * dir.x + ey * dir.y;
      if (proj <= 0) continue;
      const perp2 = ex * ex + ey * ey - proj * proj;
      const back = r * r - perp2;
      if (back < 0) continue;
      const t = proj - Math.sqrt(back);
      if (t > 1e-6 && t < best.t) {
        const cx = from.x + dir.x * t, cy = from.y + dir.y * t;
        const n = norm(cx - px, cy - py);
        best = { t, type: 'cushion', x: cx, y: cy, nx: n.x, ny: n.y };
      }
    }
  }
  return best;
}

// The aiming assist: where does the cue ball go, and (on a ball hit) where does the object
// ball go + where does the cue deflect. Consumed by both renderers to draw the dotted line.
export function predictShot(spec, balls, from, dir) {
  const hit = castRay(spec, balls, from, dir);
  const out = { from: { ...from }, contact: { x: hit.x, y: hit.y }, type: hit.type };
  if (hit.type === 'ball') {
    const b = hit.ball;
    const n = norm(b.x - hit.x, b.y - hit.y);
    out.ballId = b.id;
    out.ballFrom = { x: b.x, y: b.y };
    out.ballDir = n;
    const dot = dir.x * n.x + dir.y * n.y;
    const tx = dir.x - dot * n.x, ty = dir.y - dot * n.y;
    const tl = Math.hypot(tx, ty);
    out.cueDir = tl > 0.05 ? { x: tx / tl, y: ty / tl } : null;   // near-full hit → cue stops
    out.cut = Math.max(0, Math.min(1, dot));                      // 1 = full ball, →0 = thin
  } else if (hit.type === 'cushion') {
    const dot = dir.x * hit.nx + dir.y * hit.ny;
    out.reflectDir = norm(dir.x - 2 * dot * hit.nx, dir.y - 2 * dot * hit.ny);
  }
  return out;
}
