// Shared billiards app shell — everything above the rules: renderer choice (3D on iPad/PC,
// flat 2D on phones, via shared/power-mode.js like the card games), turn flow, aiming input
// (drag + fine buttons + gamepad), the dotted prediction line, power slider, ball-in-hand
// free placement, AI turns, scoreboard, overlays. Each game page just calls startPool(rules).
import { Simulation, predictShot } from './physics.js';
import { norm, clampToRegion, spotFree } from './geometry.js';
import { planShot, planPlacement } from './ai.js';
import { sfx, unlock, isMuted, setMuted } from './sound.js';
import { useFlatRenderer, mountPowerControl } from '../../shared/power-mode.js';

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const NAMES = ['你', 'AI'];

export async function startPool(rules) {
  const FLAT = (() => {
    const p = new URLSearchParams(location.search);
    if (p.has('d3')) return false;
    if (p.has('flat')) return true;
    return useFlatRenderer();
  })();

  const spec = rules.spec;
  const LS_LEVEL = rules.id + '-level';
  let level = 1;
  try { level = Math.min(2, Math.max(0, +localStorage.getItem(LS_LEVEL) || 1)); } catch {}

  const G = {
    balls: null, state: null, sim: null, scene: null,
    phase: 'start',              // start | place | aim | sim | ai | over
    aimDir: { x: 1, y: 0 }, power: 0.5, tip: { x: 0, y: 0 },
    lastOn: null, breaker: 0, match: [0, 0],
  };
  const cue = () => G.balls.find((b) => b.id === 0);
  const isHuman = () => G.state.turn === 0;

  // ---- scene ---------------------------------------------------------------
  const SceneMod = await import(FLAT ? './scene2d.js' : './scene3d.js');
  const SceneCls = FLAT ? SceneMod.PoolScene2D : SceneMod.PoolScene3D;

  function newGame() {
    const g = rules.newGame();
    G.balls = g.balls; G.state = g.state;
    G.state.turn = G.breaker;
    G.sim = new Simulation(spec, G.balls, {
      onHit: (v) => sfx.hit(v), onRail: (v) => sfx.rail(v), onPot: () => sfx.pot(),
    });
    if (!G.scene) G.scene = new SceneCls($('scene'), spec, G.balls);
    else G.scene.reset(G.balls);
    $('result-overlay').hidden = true;
    beginTurn();
  }

  // ---- UI helpers ------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, ms = 2400) {
    if (!msg) return;
    const el = $('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function refreshHud() {
    const on = G.state.winner == null ? rules.ballOn(G.state, G.balls) : null;
    $('round-info').textContent = on
      ? `${NAMES[G.state.turn]}${G.state.turn === 0 ? '的回合' : ' 回合'} · 目标：${on.label}`
      : rules.title;
    $('scores').innerHTML = rules.scoreboard(G.state, G.balls, NAMES)
      .map((s, i) => `<div class="sc${G.state.turn === i ? ' on' : ''}"><b>${s.name}</b> ${s.info}</div>`)
      .join('');
  }
  function setControls(mode) {                 // 'aim' | 'place' | none
    $('controls').hidden = mode !== 'aim';
    $('place-done').hidden = mode !== 'place';
  }

  // ---- turn flow -------------------------------------------------------------
  function beginTurn() {
    refreshHud();
    G.scene.setAim(null); G.scene.setGhost(null); G.scene.setRegion(null);
    if (G.state.winner != null) return;
    if (!isHuman()) { setControls(null); aiTurn(); return; }
    if (G.state.inHand) startPlacement(G.state.inHand);
    else startAim();
  }

  function startPlacement(region) {
    G.phase = 'place';
    setControls('place');
    G.scene.setRegion(region);
    const c = cue();
    let p = { x: c.x, y: c.y };
    if (!c.inPlay || !spotFree(spec, G.balls, p.x, p.y, 0) || region !== 'anywhere') {
      p = clampToRegion(spec, region, region === 'D' ? spec.baulkX - 0.05 : (region === 'kitchen' ? spec.kitchenX - 0.2 : 0), 0);
    }
    for (let k = 0; k < 60 && !spotFree(spec, G.balls, p.x, p.y, 0); k++) p.y += spec.ballR * 2.2 * (k % 2 ? -1 : 1) * (k + 1);
    c.inPlay = false;                          // hidden while the ghost is being placed
    G.placePos = p;
    G.scene.syncBalls();
    G.scene.setGhost({ ...p, ok: true });
    toast(region === 'D' ? '自由球：拖动白球在 D 区内放置' : region === 'kitchen' ? '开球：可在开球线后拖动白球' : '自由球：拖动白球到任意位置');
  }
  function tryPlace(w) {
    const p = clampToRegion(spec, G.state.inHand, w.x, w.y);
    const ok = spotFree(spec, G.balls, p.x, p.y, 0);
    if (ok) G.placePos = p;
    G.scene.setGhost({ ...p, ok });
  }
  function commitPlacement() {
    const c = cue();
    c.x = G.placePos.x; c.y = G.placePos.y; c.vx = c.vy = c.wx = c.wy = 0; c.ez = 0; c.inPlay = true;
    G.state.inHand = null;
    sfx.place();
    G.scene.setGhost(null); G.scene.setRegion(null); G.scene.syncBalls();
    startAim();
  }

  function startAim() {
    G.phase = 'aim';
    setControls('aim');
    // default: point at the nearest legal target
    const on = rules.ballOn(G.state, G.balls);
    const c = cue();
    let best = null, bd = Infinity;
    for (const b of G.balls) {
      if (!b.inPlay || !on.ids.includes(b.id)) continue;
      const d = Math.hypot(b.x - c.x, b.y - c.y);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) G.aimDir = norm(best.x - c.x, best.y - c.y);
    refreshHud();
    showAim();
  }
  function showAim() {
    if (G.phase !== 'aim') return;
    const c = cue();
    const from = { x: c.x, y: c.y };
    G.scene.setAim({ from, dir: G.aimDir, power: G.power, predict: predictShot(spec, G.balls, from, G.aimDir) });
  }

  function shoot(dir, powerFrac, tip = G.tip) {
    if (G.phase === 'sim') return;
    G.phase = 'sim';
    setControls(null);
    G.lastOn = rules.ballOn(G.state, G.balls);
    const c = cue();
    const from = { x: c.x, y: c.y };
    const speed = (0.12 + powerFrac * 0.88) * rules.maxSpeed;
    const aim = { from, dir, power: powerFrac, predict: predictShot(spec, G.balls, from, dir) };
    G.scene.setAim(null);
    G.scene.strike(aim, () => {
      sfx.cue(speed);
      G.sim.shoot(dir, speed, tip);
      setTip(0, 0);                            // 杆法 resets to center after every shot
      runSim();
    });
  }

  function runSim() {
    let last = performance.now();
    const t0 = last;
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const moving = G.sim.step(dt);
      G.scene.syncBalls(dt);
      if (moving && now - t0 < 30000) requestAnimationFrame(tick);
      else settle();
    };
    requestAnimationFrame(tick);
  }

  async function settle() {
    const out = rules.applyShot(G.state, G.balls, G.sim.events, G.lastOn);
    for (const id of out.respot || []) respot(id);
    G.scene.syncBalls();
    if (out.foul) sfx.foul();
    toast(out.msg);
    refreshHud();
    if (out.gameOver) { endGame(out.gameOver); return; }
    await delay(out.msg ? 900 : 350);
    beginTurn();
  }

  function respot(id) {
    const b = G.balls.find((x) => x.id === id);
    const base = rules.respotPos(spec, G.balls, id);
    let x = base.x, y = base.y, k = 0;
    while (!spotFree(spec, G.balls, x, y, id) && k < 200) {   // spot blocked → nudge ±1r, ∓1r, ±2r… along x
      k++;
      const off = spec.ballR * 1.05 * Math.ceil(k / 2) * (k % 2 ? 1 : -1);
      x = Math.max(-spec.hx + spec.ballR, Math.min(spec.hx - spec.ballR, base.x + off));
    }
    b.x = x; b.y = y; b.vx = b.vy = b.wx = b.wy = 0; b.ez = 0; b.inPlay = true; b.pocket = undefined;
  }

  function endGame(over) {
    G.phase = 'over';
    setControls(null);
    G.match[over.winner]++;
    G.breaker = 1 - G.breaker;                 // alternate the break
    const win = over.winner === 0;
    (win ? sfx.win : sfx.lose)();
    $('result-title').textContent = win ? '🎉 你赢了！' : 'AI 获胜';
    $('result-detail').textContent = over.msg || '';
    $('result-score').textContent = `总比分 ${G.match[0]} : ${G.match[1]}`;
    $('result-overlay').hidden = false;
  }

  // ---- AI turn ---------------------------------------------------------------
  async function aiTurn() {
    G.phase = 'ai';
    refreshHud();
    await delay(650);
    if (G.phase !== 'ai') return;              // restarted mid-think
    if (G.state.inHand) {
      const on = rules.ballOn(G.state, G.balls);
      const p = planPlacement(spec, G.balls, on.ids, level, G.state.inHand);
      const c = cue();
      c.x = p.x; c.y = p.y; c.vx = c.vy = c.wx = c.wy = 0; c.ez = 0; c.inPlay = true;
      G.state.inHand = null;
      sfx.place();
      G.scene.syncBalls();
      await delay(450);
      if (G.phase !== 'ai') return;
    }
    const on = rules.ballOn(G.state, G.balls);
    const c = cue();
    let plan;
    if (G.state.breakShot) {                   // break: smash the middle of the pack
      let mx = 0, my = 0, n = 0;
      for (const b of G.balls) if (b.inPlay && on.ids.includes(b.id)) { mx += b.x; my += b.y; n++; }
      plan = { dir: norm(mx / n - c.x, (my / n - c.y) + (Math.random() - 0.5) * 0.02), speed: rules.maxSpeed * 0.92 };
    } else {
      plan = planShot(spec, G.balls, on.ids, level, Math.random, rules.aiWeight(G.state));
    }
    // show the AI's aim briefly so the shot is readable
    const from = { x: c.x, y: c.y };
    const powerFrac = Math.max(0.05, Math.min(1, (plan.speed / rules.maxSpeed - 0.12) / 0.88));
    G.scene.setAim({ from, dir: plan.dir, power: powerFrac, predict: predictShot(spec, G.balls, from, plan.dir) });
    await delay(750);
    if (G.phase !== 'ai') return;
    shoot(plan.dir, powerFrac, { x: 0, y: 0 });   // AI plays center-ball
  }

  // ---- pointer input -----------------------------------------------------------
  const canvas = $('scene');
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    unlock();
    if (G.phase !== 'aim' && G.phase !== 'place') return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    onDrag(e);
  });
  canvas.addEventListener('pointermove', (e) => { if (dragging) onDrag(e); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  function onDrag(e) {
    const w = G.scene.worldFromEvent(e.clientX, e.clientY);
    if (!w) return;
    if (G.phase === 'place') { tryPlace(w); return; }
    const c = cue();
    const dx = w.x - c.x, dy = w.y - c.y;
    if (Math.hypot(dx, dy) < spec.ballR * 1.5) return;       // too close — direction unstable
    G.aimDir = norm(dx, dy);
    showAim();
  }

  // fine aim buttons (hold to repeat)
  function rotateAim(a) {
    const d = G.aimDir;
    G.aimDir = { x: d.x * Math.cos(a) - d.y * Math.sin(a), y: d.x * Math.sin(a) + d.y * Math.cos(a) };
    showAim();
  }
  for (const [id, sign] of [['fine-left', -1], ['fine-right', 1]]) {
    const btn = $(id);
    let rep = null, held = 0;
    const start = (e) => {
      e.preventDefault(); unlock();
      if (G.phase !== 'aim') return;
      held = 0;
      rotateAim(sign * 0.0035);
      rep = setInterval(() => { held++; rotateAim(sign * (held > 12 ? 0.012 : 0.0035)); }, 55);
    };
    const stop = () => { clearInterval(rep); rep = null; };
    btn.addEventListener('pointerdown', start);
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, stop);
  }

  // 杆法 widget: drag the dot on the little cue ball — y = 高杆/低杆 (follow/draw), x = 侧塞
  const spinEl = $('spin-ctl'), spinDot = $('spin-dot');
  function setTip(x, y) {
    const m = Math.hypot(x, y), MAXR = 0.75;
    if (m > MAXR) { x *= MAXR / m; y *= MAXR / m; }
    G.tip = { x, y };
    spinDot.style.left = 50 + x * 46 + '%';
    spinDot.style.top = 50 - y * 46 + '%';
  }
  let spinDrag = false;
  const spinMove = (e) => {
    const r = spinEl.getBoundingClientRect();
    setTip((e.clientX - r.left - r.width / 2) / (r.width / 2), -(e.clientY - r.top - r.height / 2) / (r.height / 2));
  };
  spinEl.addEventListener('pointerdown', (e) => { e.preventDefault(); spinDrag = true; spinEl.setPointerCapture(e.pointerId); spinMove(e); });
  spinEl.addEventListener('pointermove', (e) => { if (spinDrag) spinMove(e); });
  for (const ev of ['pointerup', 'pointercancel']) spinEl.addEventListener(ev, () => { spinDrag = false; });
  spinEl.addEventListener('dblclick', () => setTip(0, 0));

  $('power').addEventListener('input', (e) => { G.power = +e.target.value / 100; showAim(); });
  $('shoot-btn').addEventListener('click', () => {
    unlock();
    if (G.phase !== 'aim') return;
    shoot(G.aimDir, Math.max(0.04, G.power));
  });
  $('place-done').addEventListener('click', () => { if (G.phase === 'place') commitPlacement(); });

  // ---- gamepad (Xbox) — LS aim/move, D-pad fine, RB/LB power, A shoot/confirm ----
  let padLoop = false;
  window.addEventListener('gamepadconnected', () => { if (!padLoop) { padLoop = true; requestAnimationFrame(pollPad); } });
  let prevBtn = [];
  function pollPad() {
    const pad = (navigator.getGamepads ? [...navigator.getGamepads()] : []).find((p) => p && p.connected);
    if (!pad) { padLoop = false; prevBtn = []; return; }
    const down = (i) => pad.buttons[i] && pad.buttons[i].pressed;
    const edge = (i) => down(i) && !prevBtn[i];
    const ax = Math.abs(pad.axes[0]) > 0.18 ? pad.axes[0] : 0;
    const ay = Math.abs(pad.axes[1]) > 0.18 ? pad.axes[1] : 0;
    if (G.phase === 'aim') {
      if (ax) rotateAim(ax * Math.abs(ax) * 0.045);
      if (edge(14)) rotateAim(-0.0035);
      if (edge(15)) rotateAim(0.0035);
      if (edge(4)) { G.power = Math.max(0, G.power - 0.07); $('power').value = G.power * 100; showAim(); }
      if (edge(5)) { G.power = Math.min(1, G.power + 0.07); $('power').value = G.power * 100; showAim(); }
      if (edge(0)) { unlock(); shoot(G.aimDir, Math.max(0.04, G.power)); }
    } else if (G.phase === 'place') {
      if (ax || ay) tryPlace({ x: G.placePos.x + ax * 0.012, y: G.placePos.y + ay * 0.012 });
      if (edge(0)) commitPlacement();
    } else if (G.phase === 'over' && edge(0)) {
      $('next-btn').click();
    }
    prevBtn = pad.buttons.map((b) => b.pressed);
    requestAnimationFrame(pollPad);
  }

  // ---- chrome: mute / menu / overlays ------------------------------------------
  const muteBtn = $('mute-btn');
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => { setMuted(!isMuted()); muteBtn.textContent = isMuted() ? '🔇' : '🔊'; });
  $('menu-btn').addEventListener('click', () => { $('menu-overlay').hidden = false; });
  $('menu-continue').addEventListener('click', () => { $('menu-overlay').hidden = true; });
  $('menu-restart').addEventListener('click', () => {
    $('menu-overlay').hidden = true;
    G.match = [0, 0]; G.breaker = 0;
    G.phase = 'start';
    newGame();
  });
  $('menu-home').addEventListener('click', () => location.replace('../../'));
  $('result-home').addEventListener('click', () => location.replace('../../'));
  $('next-btn').addEventListener('click', () => { G.phase = 'start'; newGame(); });
  mountPowerControl($('menu-overlay').querySelector('.panel'), $('menu-home'));

  // start overlay: difficulty pick
  const diffRow = $('diff-row');
  diffRow.querySelectorAll('.diff-btn').forEach((b) => {
    b.classList.toggle('sel', +b.dataset.level === level);
    b.addEventListener('click', () => {
      level = +b.dataset.level;
      try { localStorage.setItem(LS_LEVEL, String(level)); } catch {}
      diffRow.querySelectorAll('.diff-btn').forEach((x) => x.classList.toggle('sel', x === b));
    });
  });
  $('start-btn').addEventListener('click', () => {
    unlock();
    $('start-overlay').hidden = true;
    newGame();
  });

  document.title = rules.title;
  $('start-title').textContent = rules.title;
  $('start-sub').textContent = rules.subtitle;
}
