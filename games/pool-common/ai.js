// Shared billiards AI — rule-agnostic. The rule engine supplies the set of legal target ball
// ids; this module picks WHERE to aim and HOW hard, at three difficulty tiers:
//   0 新手 — picks a RANDOM feasible target/pocket (or just whacks a legal ball), big aim noise
//   1 普通 — picks among the top few candidates, moderate noise
//   2 高手 — scores every target×pocket combo (cut angle, distances, pocket opening, scratch
//            risk) and takes the best, tiny noise
// Aiming is classic ghost-ball: to send ball B into pocket P, drive the cue ball's center to
// G = B − 2r·(P−B)/|P−B|.
import { norm, corridorClear, spotFree, clampToRegion } from './geometry.js';
import { castRay } from './physics.js';

export const AI_LEVELS = [
  { angleSd: 0.030, powerSd: 0.22 },   // ~1.7° σ — misses most long pots
  { angleSd: 0.011, powerSd: 0.10 },   // ~0.6° σ
  { angleSd: 0.0035, powerSd: 0.04 },  // ~0.2° σ — near-pro
];

function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const rot = (d, a) => ({ x: d.x * Math.cos(a) - d.y * Math.sin(a), y: d.x * Math.sin(a) + d.y * Math.cos(a) });

// Speed to send the object ball ~`dPocket`+margin meters after a cut, from `dCue` away.
// Derived from the physics constants (ROLL_DEC≈0.62 + drag): v ≈ √(2·0.7·dist).
function shotSpeed(dCue, dPocket, cut) {
  const vObj = Math.sqrt(2 * 0.7 * (dPocket + 0.35));
  const vAtContact = vObj / Math.max(0.3, cut);
  const v = Math.sqrt(vAtContact * vAtContact + 2 * 0.7 * dCue);
  return Math.max(0.9, Math.min(6.5, v * 1.08));
}

// Enumerate every feasible (target, pocket) pot from `from` (usually the cue position).
// `weight(ballId)` lets the rules bias targets (snooker: prefer the black over the yellow).
function candidates(spec, balls, targetIds, from, weight = () => 1) {
  const r = spec.ballR, out = [];
  const tset = new Set(targetIds);
  for (const b of balls) {
    if (!b.inPlay || !tset.has(b.id)) continue;
    for (const p of spec.pockets) {
      const toP = norm(p.x - b.x, p.y - b.y);
      const gx = b.x - toP.x * r * 2, gy = b.y - toP.y * r * 2;   // ghost-ball center
      if (Math.abs(gx) > spec.hx - r * 0.5 || Math.abs(gy) > spec.hy - r * 0.5) continue;
      const aim = norm(gx - from.x, gy - from.y);
      const cut = aim.x * toP.x + aim.y * toP.y;                  // cos of the cut angle
      if (cut < 0.28) continue;                                   // >~74° cut → hopeless
      // side pockets only open along ±y; a shallow approach rattles out
      if (!p.corner && Math.abs(toP.y) < 0.55) continue;
      if (p.corner) {                                             // corner opens along its diagonal
        const diag = norm(Math.sign(p.x), Math.sign(p.y));
        if (toP.x * diag.x + toP.y * diag.y < 0.25) continue;
      }
      if (!corridorClear(balls, from.x, from.y, gx, gy, r * 2 * 0.95, new Set([0, b.id]))) continue;
      if (!corridorClear(balls, b.x, b.y, p.x, p.y, r * 2 * 0.95, new Set([0, b.id]))) continue;
      const dCue = Math.hypot(gx - from.x, gy - from.y);
      const dP = Math.hypot(p.x - b.x, p.y - b.y);
      const score = Math.pow(cut, 1.6) / ((0.35 + dCue) * (0.35 + dP)) * weight(b.id);
      out.push({ ball: b, pocket: p, aim, cut, dCue, dP, score, gx, gy });
    }
  }
  return out;
}

// Pick a shot. Returns { dir, speed, targetId } (dir already noise-perturbed).
export function planShot(spec, balls, targetIds, level, rand = Math.random, weight = () => 1) {
  const L = AI_LEVELS[level] || AI_LEVELS[1];
  const cue = balls.find((b) => b.id === 0);
  const cands = candidates(spec, balls, targetIds, cue, level >= 2 ? weight : () => 1);

  let pick = null;
  if (cands.length) {
    if (level === 0) {
      pick = cands[Math.floor(rand() * cands.length)];            // 新手: any feasible pot at random
    } else if (level === 1) {
      cands.sort((a, b) => b.score - a.score);
      pick = cands[Math.floor(rand() * Math.min(3, cands.length))];
    } else {
      for (const c of cands) {                                    // 高手: penalize follow-through scratches
        const n = norm(c.ball.x - c.gx, c.ball.y - c.gy);
        const nd = c.aim.x * n.x + c.aim.y * n.y;
        const tx = c.aim.x - nd * n.x, ty = c.aim.y - nd * n.y;
        const tl = Math.hypot(tx, ty);
        if (tl > 0.05) {
          const roll = castRay(spec, balls, { x: c.gx, y: c.gy }, { x: tx / tl, y: ty / tl }, c.ball.id);
          if (roll.type === 'pocket' && roll.t < 0.55) c.score *= 0.2;
        }
      }
      cands.sort((a, b) => b.score - a.score);
      pick = cands[0];
    }
  }

  let dir, speed, targetId = null;
  if (pick) {
    dir = pick.aim; speed = shotSpeed(pick.dCue, pick.dP, pick.cut); targetId = pick.ball.id;
  } else {
    const plan = safetyShot(spec, balls, targetIds, cue, level, rand);
    dir = plan.dir; speed = plan.speed; targetId = plan.targetId;
  }
  dir = rot(dir, gauss(rand) * L.angleSd);
  speed = Math.max(0.6, speed * (1 + gauss(rand) * L.powerSd));
  return { dir, speed, targetId };
}

// No pot available: reach a legal ball at all (avoid the foul), softly. Tries a direct hit,
// then a one-cushion mirror escape off each of the four main rails.
function safetyShot(spec, balls, targetIds, cue, level, rand) {
  const r = spec.ballR;
  const tset = new Set(targetIds);
  const targets = balls.filter((b) => b.inPlay && tset.has(b.id));
  targets.sort((a, b) => Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y));
  for (const t of targets) {
    const d = norm(t.x - cue.x, t.y - cue.y);
    const hit = castRay(spec, balls, cue, d);
    if (hit.type === 'ball' && hit.ball.id === t.id) {
      const dist = Math.hypot(t.x - cue.x, t.y - cue.y);
      return { dir: d, speed: Math.min(3.2, 1.1 + dist * 0.8), targetId: t.id };
    }
  }
  // snookered — mirror the nearest target across each rail line and try the bounce
  const t = targets[0];
  if (t) {
    const rails = [
      { mx: t.x, my: 2 * (spec.hy - r) - t.y }, { mx: t.x, my: -2 * (spec.hy - r) - t.y },
      { mx: 2 * (spec.hx - r) - t.x, my: t.y }, { mx: -2 * (spec.hx - r) - t.x, my: t.y },
    ];
    for (const m of rails) {
      const d = norm(m.mx - cue.x, m.my - cue.y);
      const hit = castRay(spec, balls, cue, d);
      if (hit.type !== 'cushion') continue;
      const dot = d.x * hit.nx + d.y * hit.ny;
      const rd = norm(d.x - 2 * dot * hit.nx, d.y - 2 * dot * hit.ny);
      const after = castRay(spec, balls, { x: hit.x, y: hit.y }, rd);
      if (after.type === 'ball' && after.ball.id === t.id) {
        const dist = hit.t + after.t;
        return { dir: d, speed: Math.min(4, 1.4 + dist * 0.8), targetId: t.id };
      }
    }
    return { dir: norm(t.x - cue.x, t.y - cue.y), speed: 2 + rand(), targetId: t.id };
  }
  return { dir: { x: 1, y: 0 }, speed: 1.5, targetId: null };
}

// Ball-in-hand: choose where to drop the cue ball inside `region`.
// 高手/普通 sample straight-line positions behind each target→pocket lane and keep the best
// scoring one; 新手 takes any random free spot.
export function planPlacement(spec, balls, targetIds, level, region, rand = Math.random) {
  const r = spec.ballR;
  const randomSpot = () => {
    for (let i = 0; i < 200; i++) {
      const p = clampToRegion(spec, region,
        (rand() * 2 - 1) * spec.hx, (rand() * 2 - 1) * spec.hy);
      if (spotFree(spec, balls, p.x, p.y, 0)) return p;
    }
    return clampToRegion(spec, region, 0, 0);
  };
  if (level === 0) return randomSpot();

  const tset = new Set(targetIds);
  let best = null, bestScore = -1;
  for (const b of balls) {
    if (!b.inPlay || !tset.has(b.id)) continue;
    for (const p of spec.pockets) {
      const toP = norm(p.x - b.x, p.y - b.y);
      for (const back of [0.22, 0.4, 0.65]) {                    // straight-in from `back` meters behind
        const raw = { x: b.x - toP.x * (r * 2 + back), y: b.y - toP.y * (r * 2 + back) };
        const pos = clampToRegion(spec, region, raw.x, raw.y);
        if (Math.hypot(pos.x - raw.x, pos.y - raw.y) > 0.01) continue;  // region clipped the lane
        if (!spotFree(spec, balls, pos.x, pos.y, 0)) continue;
        const cs = candidates(spec, balls, [b.id], pos);
        for (const c of cs) if (c.pocket === p && c.score > bestScore) { bestScore = c.score; best = pos; }
      }
    }
  }
  return best || randomSpot();
}
