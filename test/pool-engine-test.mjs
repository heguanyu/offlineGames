// Unit + integration tests for the billiards stack (pool-common physics/AI + 黑八/斯诺克 rules).
// Pure logic, no browser. Usage: node test/pool-engine-test.mjs
import { buildTable, spotFree, clampToRegion } from '../games/pool-common/geometry.js';
import { Simulation, castRay, predictShot } from '../games/pool-common/physics.js';
import { planShot, planPlacement } from '../games/pool-common/ai.js';
import { rules as pool8 } from '../games/pool8/rules.js';
import { rules as snooker } from '../games/snooker/rules.js';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b}±${tol})`);

// deterministic PRNG so every run takes the same code path
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mkBall = (id, x, y) => ({ id, x, y, vx: 0, vy: 0, inPlay: true });
function settle(sim, cap = 60) {
  let t = 0;
  while (sim.step(0.05) && t < cap) t += 0.05;
  ok(t < cap, 'simulation settles');
  return sim.events;
}

// ---- geometry ----------------------------------------------------------------
console.log('geometry:');
const spec = pool8.spec;
eq(spec.pockets.length, 6, '6 pockets');
eq(spec.cushions.length, 18, '18 cushion segments (6 rails + 12 jaws)');
ok(spec.hx === spec.L / 2 && spec.hy === spec.W / 2, 'half extents');
ok(snooker.spec.L > spec.L && snooker.spec.ballR < spec.ballR, 'snooker table bigger, balls smaller');
const clamped = clampToRegion(spec, 'kitchen', 1, 0.2);
ok(clamped.x <= spec.kitchenX, 'kitchen clamp pulls x behind the head string');
const dPos = clampToRegion(snooker.spec, 'D', 0.5, 0.5);
ok(Math.hypot(dPos.x - snooker.spec.baulkX, dPos.y) <= snooker.spec.dR + 1e-9 && dPos.x <= snooker.spec.baulkX, 'D clamp lands inside the D');

// ---- physics -----------------------------------------------------------------
console.log('physics:');
{ // straight hit: cue drives ball 1 forward, records firstHit, both stop
  const balls = [mkBall(0, -0.5, 0), mkBall(1, 0, 0)];
  const sim = new Simulation(spec, balls, {});
  sim.shoot({ x: 1, y: 0 }, 2);
  const ev = settle(sim);
  eq(ev.firstHit, 1, 'first contact recorded');
  ok(balls[1].x > 0.1, 'object ball driven forward');
  ok(!sim.moving(), 'all stopped');
}
{ // cushion bounce reverses direction and flags railAfter only after a contact
  const balls = [mkBall(0, 0, 0), mkBall(1, 0.3, 0)];
  const sim = new Simulation(spec, balls, {});
  sim.shoot({ x: 1, y: 0 }, 3);
  const ev = settle(sim);
  ok(ev.railAfter, 'rail-after-contact seen (object ball reached the cushion)');
}
{ // whiff: no contact at all
  const balls = [mkBall(0, 0, 0)];
  const sim = new Simulation(spec, balls, {});
  sim.shoot({ x: 1, y: 0 }, 1);
  const ev = settle(sim);
  eq(ev.firstHit, null, 'whiff → firstHit null');
  ok(!ev.railAfter, 'rail before any contact does not count');
}
{ // corner pot: ball just in front of the pocket, shot straight in
  const p = spec.pockets[3];                        // (+x, +y) corner
  const balls = [mkBall(0, p.x - 0.5, p.y - 0.5), mkBall(1, p.x - 0.12, p.y - 0.12)];
  const sim = new Simulation(spec, balls, {});
  sim.shoot({ x: Math.SQRT1_2, y: Math.SQRT1_2 }, 2.5);
  const ev = settle(sim);
  ok(ev.potted.includes(1), 'object ball potted in the corner');
  eq(balls[1].inPlay, false, 'potted ball off the table');
}
{ // scratch
  const p = spec.pockets[4];                        // bottom side pocket
  const balls = [mkBall(0, 0, 0)];
  const sim = new Simulation(spec, balls, {});
  sim.shoot({ x: 0, y: p.y < 0 ? -1 : 1 }, 2.5);
  const ev = settle(sim);
  ok(ev.cuePotted, 'cue ball scratches into the side pocket');
}
{ // containment: a hard diagonal break never loses a ball off-world
  const g = pool8.newGame(mulberry32(7));
  const sim = new Simulation(spec, g.balls, {});
  sim.shoot({ x: 0.94, y: 0.34 }, 8);
  settle(sim);
  for (const b of g.balls) {
    ok(!b.inPlay || (Math.abs(b.x) <= spec.hx + spec.ballR && Math.abs(b.y) <= spec.hy + spec.ballR),
      `ball ${b.id} stays on the table`);
  }
}
{ // castRay + predictShot: object-ball direction points at the contact normal
  const balls = [mkBall(0, -0.4, 0), mkBall(1, 0, 0)];
  const hit = castRay(spec, balls, { x: -0.4, y: 0 }, { x: 1, y: 0 });
  eq(hit.type, 'ball', 'ray hits the ball');
  near(hit.x, -2 * spec.ballR, 1e-6, 'contact center at two radii');
  const pr = predictShot(spec, balls, { x: -0.4, y: 0 }, { x: 1, y: 0 });
  near(pr.ballDir.x, 1, 1e-6, 'full hit sends the ball straight on');
  ok(pr.cueDir === null, 'full hit → no cue deflection line');
}

// ---- AI ------------------------------------------------------------------------
console.log('ai:');
{ // hard AI pots a straight ball into the corner
  const p = spec.pockets[3];
  const balls = [mkBall(0, p.x - 0.8, p.y - 0.8), { ...mkBall(1, p.x - 0.35, p.y - 0.35), number: 1 }];
  const plan = planShot(spec, balls, [1], 2, mulberry32(1));
  eq(plan.targetId, 1, 'hard AI picks the only target');
  const sim = new Simulation(spec, balls, {});
  sim.shoot(plan.dir, plan.speed);
  const ev = settle(sim);
  ok(ev.potted.includes(1), 'hard AI pots the straight corner ball');
}
{ // placement respects the region and lands on a free spot
  const g = pool8.newGame(mulberry32(2));
  const pos = planPlacement(spec, g.balls, [1, 2, 3, 4, 5, 6, 7], 2, 'kitchen', mulberry32(3));
  ok(pos.x <= spec.kitchenX, 'AI break placement stays behind the head string');
  ok(spotFree(spec, g.balls, pos.x, pos.y, 0), 'placement spot is free');
}

// ---- 黑八 rules ------------------------------------------------------------------
console.log('pool8 rules:');
{
  const g = pool8.newGame(mulberry32(4));
  eq(g.balls.length, 16, '16 balls');
  const eight = g.balls.find((b) => b.id === 8);
  near(eight.y, 0, 1e-9, '8 on the center line');
  near(eight.x, spec.L / 4 + 2 * (spec.ballR * 2 * 1.004) * Math.sqrt(3) / 2, 1e-9, '8 in the middle of row 3');
  eq(g.state.inHand, 'kitchen', 'break starts in hand behind the line');
  const on = pool8.ballOn(g.state, g.balls);
  eq(on.ids.length, 14, 'open table: everything but the 8 is on');
}
{ // wrong first contact → ball-in-hand for the opponent
  const g = pool8.newGame(mulberry32(5));
  g.state.breakShot = false;
  g.state.groups = { 0: 'solid', 1: 'stripe' };
  const on = pool8.ballOn(g.state, g.balls);
  const out = pool8.applyShot(g.state, g.balls, { firstHit: 9, potted: [], cuePotted: false, railAfter: true }, on);
  ok(out.foul, 'wrong first contact is a foul');
  eq(out.ballInHand, 'anywhere', 'foul → free placement anywhere');
  eq(g.state.turn, 1, 'turn passes');
}
{ // legal pot keeps the turn + assigns groups
  const g = pool8.newGame(mulberry32(6));
  g.state.breakShot = false;
  const on = pool8.ballOn(g.state, g.balls);
  g.balls.find((b) => b.id === 3).inPlay = false;
  const out = pool8.applyShot(g.state, g.balls, { firstHit: 3, potted: [3], cuePotted: false, railAfter: true }, on);
  ok(!out.foul, 'legal pot');
  eq(g.state.groups[0], 'solid', 'first pot assigns solids to the shooter');
  eq(g.state.turn, 0, 'shooter keeps the turn');
}
{ // early 8 → loss; legal 8 → win; 8 + scratch → loss
  const g = pool8.newGame(mulberry32(7));
  g.state.breakShot = false;
  g.state.groups = { 0: 'solid', 1: 'stripe' };
  const on = pool8.ballOn(g.state, g.balls);
  g.balls.find((b) => b.id === 8).inPlay = false;
  const out = pool8.applyShot(g.state, g.balls, { firstHit: 1, potted: [8], cuePotted: false, railAfter: true }, on);
  ok(out.gameOver && out.gameOver.winner === 1, 'early 8 loses the game');

  const g2 = pool8.newGame(mulberry32(8));
  g2.state.breakShot = false;
  g2.state.groups = { 0: 'solid', 1: 'stripe' };
  for (const b of g2.balls) if (b.number >= 1 && b.number <= 7) b.inPlay = false;
  const on2 = pool8.ballOn(g2.state, g2.balls);
  eq(on2.ids[0], 8, 'group cleared → on the 8');
  g2.balls.find((b) => b.id === 8).inPlay = false;
  const out2 = pool8.applyShot(g2.state, g2.balls, { firstHit: 8, potted: [8], cuePotted: false, railAfter: true }, on2);
  ok(out2.gameOver && out2.gameOver.winner === 0, 'legal 8 wins');

  const g3 = pool8.newGame(mulberry32(9));
  g3.state.breakShot = false;
  g3.state.groups = { 0: 'solid', 1: 'stripe' };
  for (const b of g3.balls) if (b.number >= 1 && b.number <= 7) b.inPlay = false;
  const on3 = pool8.ballOn(g3.state, g3.balls);
  g3.balls.find((b) => b.id === 8).inPlay = false;
  const out3 = pool8.applyShot(g3.state, g3.balls, { firstHit: 8, potted: [8, 0], cuePotted: true, railAfter: true }, on3);
  ok(out3.gameOver && out3.gameOver.winner === 1, '8 with a scratch loses');
}

// ---- 斯诺克 rules ------------------------------------------------------------------
console.log('snooker rules:');
{
  const g = snooker.newGame(mulberry32(10));
  eq(g.balls.length, 22, '22 balls (cue + 15 reds + 6 colours)');
  eq(g.state.inHand, 'D', 'starts in hand in the D');
  const on = snooker.ballOn(g.state, g.balls);
  eq(on.ids.length, 15, 'reds on first');

  // pot a red legally
  g.balls.find((b) => b.id === 1).inPlay = false;
  let out = snooker.applyShot(g.state, g.balls, { firstHit: 1, potted: [1], cuePotted: false, railAfter: true }, on);
  eq(g.state.scores[0], 1, 'red = 1 point');
  ok(!out.switchTurn, 'keeps the turn');
  ok(g.state.mustColour, 'a colour is now on');

  // pot the black as the colour → +7, respotted
  const on2 = snooker.ballOn(g.state, g.balls);
  ok(on2.ids.includes(21), 'all colours on after a red');
  g.balls.find((b) => b.id === 21).inPlay = false;
  out = snooker.applyShot(g.state, g.balls, { firstHit: 21, potted: [21], cuePotted: false, railAfter: true }, on2);
  eq(g.state.scores[0], 8, 'black adds 7');
  ok(out.respot.includes(21), 'black respots while reds remain');
  ok(!g.state.mustColour, 'back on reds');

  // foul: hitting a colour first while on red gives its value (min 4)
  const on3 = snooker.ballOn(g.state, g.balls);
  out = snooker.applyShot(g.state, g.balls, { firstHit: 19, potted: [], cuePotted: false, railAfter: true }, on3);
  ok(out.foul, 'wrong first contact fouls');
  eq(g.state.scores[1], 5, 'blue foul = 5 to the opponent');
  eq(g.state.turn, 1, 'turn passes');

  // scratch → in hand in the D
  const on4 = snooker.ballOn(g.state, g.balls);
  out = snooker.applyShot(g.state, g.balls, { firstHit: 2, potted: [0], cuePotted: true, railAfter: true }, on4);
  eq(out.ballInHand, 'D', 'scratch → in hand in the D');
}
{ // colours-in-order endgame + frame end
  const g = snooker.newGame(mulberry32(11));
  for (const b of g.balls) if (b.id >= 1 && b.id <= 15) b.inPlay = false;
  g.state.phase = 'colours'; g.state.colourIdx = 21;
  g.state.scores = [30, 20];
  const on = snooker.ballOn(g.state, g.balls);
  eq(on.ids[0], 21, 'black on');
  g.balls.find((b) => b.id === 21).inPlay = false;
  const out = snooker.applyShot(g.state, g.balls, { firstHit: 21, potted: [21], cuePotted: false, railAfter: true }, on);
  ok(out.gameOver && out.gameOver.winner === 0, 'frame ends after the black');
}

// ---- integration: full AI-vs-AI 黑八 game, headless --------------------------------
console.log('integration (AI vs AI 黑八):');
{
  const rand = mulberry32(42);
  const g = pool8.newGame(rand);
  let shots = 0, over = null;
  while (!over && shots < 250) {
    shots++;
    const st = g.state;
    if (st.inHand) {
      const on = pool8.ballOn(st, g.balls);
      const p = planPlacement(spec, g.balls, on.ids, 2, st.inHand, rand);
      const c = g.balls.find((b) => b.id === 0);
      c.x = p.x; c.y = p.y; c.vx = c.vy = 0; c.inPlay = true;
      st.inHand = null;
    }
    const on = pool8.ballOn(st, g.balls);
    const c = g.balls.find((b) => b.id === 0);
    let plan;
    if (st.breakShot) {
      let mx = 0, my = 0, n = 0;
      for (const b of g.balls) if (b.inPlay && on.ids.includes(b.id)) { mx += b.x; my += b.y; n++; }
      const d = Math.hypot(mx / n - c.x, my / n - c.y);
      plan = { dir: { x: (mx / n - c.x) / d, y: (my / n - c.y) / d }, speed: pool8.maxSpeed * 0.92 };
    } else {
      plan = planShot(spec, g.balls, on.ids, 2, rand);
    }
    const sim = new Simulation(spec, g.balls, {});
    sim.shoot(plan.dir, plan.speed);
    let t = 0;
    while (sim.step(0.05) && t < 60) t += 0.05;
    const out = pool8.applyShot(st, g.balls, sim.events, on);
    for (const id of out.respot || []) {
      const b = g.balls.find((x) => x.id === id);
      const base = pool8.respotPos(spec, g.balls, id);
      let x = base.x, k = 0;
      while (!spotFree(spec, g.balls, x, base.y, id) && k < 100) { k++; x = base.x + spec.ballR * 1.05 * Math.ceil(k / 2) * (k % 2 ? 1 : -1); }
      b.x = x; b.y = base.y; b.vx = b.vy = 0; b.inPlay = true;
    }
    over = out.gameOver;
  }
  ok(over, `game reaches a verdict (${shots} shots)`);
  console.log(`  → winner P${over ? over.winner : '?'} in ${shots} shots`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
