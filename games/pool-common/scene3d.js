// 3D billiards table (iPad / desktop) on the locally-vendored three.js — same stack as the
// card games (poker-common lib + CC0 felt/wood PBR maps, canvas-drawn ball textures, zero
// binary art). The physics stays 2D; this maps (x, y) → world (x, ·, z) and adds rolling-ball
// rotation, a tapered wooden cue, dotted aim-assist line, and pocket-sink animations.
// On-demand render loop (the doudizhu _kick pattern): idle table = zero frames.
import * as THREE from '../poker-common/lib/three.module.min.js';
import { is3DLite, apply3DProfile } from '../../shared/power-mode.js';
import { railPlans } from './geometry.js';

const RAIL_W = 0.055, RAIL_H = 0.040;     // cushion body width/height above the felt
const FRAME_W = 0.11;                     // outer wood frame width

const TEX = (file, srgb, rep) => {
  const t = new THREE.TextureLoader().load(new URL(`../poker-common/textures/${file}`, import.meta.url).href);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
};

// Felt top texture: base cloth color + the game's markings (head string / baulk line + D +
// colour spots) painted straight into the map, so lines never z-fight the cloth.
function feltTexture(spec) {
  const PX = 512;                                           // px per meter — canvas maps 1:1 onto the felt plane
  const w = Math.round((spec.L + RAIL_W * 2 + 0.02) * PX), h = Math.round((spec.W + RAIL_W * 2 + 0.02) * PX);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = spec.feltColor; x.fillRect(0, 0, w, h);
  // soft cloth mottling
  for (let i = 0; i < 40; i++) {
    const cx = Math.random() * w, cy = Math.random() * h, r = 60 + Math.random() * 280;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, Math.random() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.045)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }
  const X = (mx) => w / 2 + mx * PX, Y = (my) => h / 2 + my * PX;
  x.strokeStyle = x.fillStyle = spec.clothLine || 'rgba(255,255,255,0.75)';
  x.lineWidth = 2.2;
  const spot = (sx, sy) => { x.beginPath(); x.arc(X(sx), Y(sy), 4, 0, Math.PI * 2); x.fill(); };
  if (spec.markings?.kitchen) {                             // 黑八: head string + foot spot
    x.beginPath(); x.moveTo(X(spec.kitchenX), Y(-spec.hy)); x.lineTo(X(spec.kitchenX), Y(spec.hy)); x.stroke();
    spot(spec.markings.footSpot, 0);
  }
  if (spec.markings?.baulk) {                               // 斯诺克: baulk line + D + spots
    x.beginPath(); x.moveTo(X(spec.baulkX), Y(-spec.hy)); x.lineTo(X(spec.baulkX), Y(spec.hy)); x.stroke();
    x.beginPath(); x.arc(X(spec.baulkX), Y(0), spec.dR * PX, Math.PI / 2, Math.PI * 1.5); x.stroke();
    for (const s of spec.markings.spots) spot(s.x, s.y);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// Equirect ball texture. Solids: colored with a numbered white disc; stripes: white with a
// colored band and the number on the band; snooker balls: plain color (no number).
function ballTexture(ball) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  if (ball.stripe) {
    x.fillStyle = '#f6f3ec'; x.fillRect(0, 0, 256, 128);
    x.fillStyle = ball.color; x.fillRect(0, 34, 256, 60);
  } else {
    x.fillStyle = ball.color; x.fillRect(0, 0, 256, 128);
  }
  if (ball.number != null) {
    for (const u of [64, 192]) {                            // two discs, off the wrap seam
      x.fillStyle = '#f6f3ec'; x.beginPath(); x.arc(u, 64, 21, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#181818'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = '700 26px Arial, sans-serif'; x.fillText(String(ball.number), u, 66);
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function cueTexture() {                                     // maple shaft → dark rosewood butt
  const c = document.createElement('canvas'); c.width = 64; c.height = 512;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 512);           // v=0 tip … v=1 butt
  g.addColorStop(0, '#e8cfa0'); g.addColorStop(0.45, '#d9b27c');
  g.addColorStop(0.62, '#8a5a2e'); g.addColorStop(1, '#3c2414');
  x.fillStyle = g; x.fillRect(0, 0, 64, 512);
  x.globalAlpha = 0.14;                                     // faint grain lines
  for (let i = 0; i < 22; i++) {
    x.strokeStyle = i % 2 ? '#7a5a33' : '#f3e2bf';
    x.beginPath(); x.moveTo(Math.random() * 64, 0);
    x.bezierCurveTo(Math.random() * 64, 170, Math.random() * 64, 340, Math.random() * 64, 512);
    x.stroke();
  }
  x.globalAlpha = 1;
  x.fillStyle = '#20150c';                                  // butt rings + wrap
  x.fillRect(0, 300, 64, 7); x.fillRect(0, 318, 64, 4); x.fillRect(0, 400, 64, 10);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PoolScene3D {
  constructor(canvas, spec, balls) {
    this.canvas = canvas; this.spec = spec; this.balls = balls;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !is3DLite() });
    const lite = apply3DProfile(this.renderer);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#101418');
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 30);
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -spec.ballR);
    this._running = false; this._fx = [];

    // lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xfff4e0, 1.5);
    key.position.set(1.2, 3.2, 0.8);
    if (!lite) {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      const s = Math.max(spec.hx, spec.hy) * 1.5;
      Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.5, far: 8 });
      key.shadow.camera.updateProjectionMatrix();
    }
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
    fill.position.set(-1.5, 2.2, -1.2);
    this.scene.add(fill);

    this._buildTable(lite);
    this._buildBalls(lite);
    this._buildAim();
    this._buildCue();

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    this.kick();
  }

  _buildTable(lite) {
    const { spec } = this;
    const felt = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.L + RAIL_W * 2 + 0.02, spec.W + RAIL_W * 2 + 0.02),
      new THREE.MeshStandardMaterial({
        map: feltTexture(spec), normalMap: TEX('felt_normal.jpg', false, 6),
        roughnessMap: TEX('felt_rough.jpg', false, 6), roughness: 1, metalness: 0,
        normalScale: new THREE.Vector2(0.45, 0.45),
      }));
    felt.rotation.x = -Math.PI / 2; felt.receiveShadow = !lite;
    this.scene.add(felt);

    // cushion bodies — six prisms whose END FACES are cut along the physics jaw lines, so
    // pocket mouths look like a real table (angled rail ends, no free-standing jaw blocks)
    const cushMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(spec.feltColor).multiplyScalar(0.75), roughness: 0.9 });
    for (const poly of railPlans(spec, RAIL_W)) {
      const sh = new THREE.Shape();
      sh.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) sh.lineTo(poly[i][0], poly[i][1]);
      sh.closePath();
      const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: RAIL_H, bevelEnabled: false }), cushMat);
      m.rotation.x = Math.PI / 2;                          // shape plane (x, physY) → world (x, ·, z)
      m.position.y = RAIL_H;
      m.castShadow = m.receiveShadow = !lite;
      this.scene.add(m);
    }
    // wooden frame
    const wood = new THREE.MeshStandardMaterial({
      map: TEX('wood_color.jpg', true, 2), normalMap: TEX('wood_normal.jpg', false, 2),
      roughnessMap: TEX('wood_rough.jpg', false, 2), color: 0xcdb190, roughness: 0.8,
      normalScale: new THREE.Vector2(0.5, 0.5),
    });
    const ox = spec.hx + RAIL_W, oy = spec.hy + RAIL_W;
    const mk = (w, d, px, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, RAIL_H + 0.02, d), wood);
      m.position.set(px, (RAIL_H + 0.02) / 2 - 0.005, pz);
      m.castShadow = m.receiveShadow = !lite;
      this.scene.add(m);
    };
    mk((ox + FRAME_W) * 2, FRAME_W, 0, oy + FRAME_W / 2);
    mk((ox + FRAME_W) * 2, FRAME_W, 0, -oy - FRAME_W / 2);
    mk(FRAME_W, oy * 2, ox + FRAME_W / 2, 0);
    mk(FRAME_W, oy * 2, -ox - FRAME_W / 2, 0);

    // pockets: dark well + rim
    const potMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.6 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x241a10, roughness: 0.5, metalness: 0.15 });
    for (const p of spec.pockets) {
      const well = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.8, 0.05, 24), potMat);
      well.position.set(p.x, -0.024, p.y);
      this.scene.add(well);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r * 1.02, 0.011, 8, 24), rimMat);
      rim.rotation.x = Math.PI / 2; rim.position.set(p.x, RAIL_H * 0.55, p.y);
      this.scene.add(rim);
    }
  }

  _buildBalls(lite) {
    const r = this.spec.ballR;
    const geo = new THREE.SphereGeometry(r, 24, 16);
    this.ballMeshes = new Map();
    for (const b of this.balls) {
      const mat = lite
        ? new THREE.MeshStandardMaterial({ map: ballTexture(b), roughness: 0.22, metalness: 0 })
        : new THREE.MeshPhysicalMaterial({ map: ballTexture(b), roughness: 0.16, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25 });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = !lite;
      m.position.set(b.x, r, b.y);
      m.quaternion.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      this.scene.add(m);
      this.ballMeshes.set(b.id, { mesh: m, px: b.x, py: b.y, sinking: 0, shown: true });
    }
  }

  _buildAim() {
    const dotGeo = new THREE.CircleGeometry(0.0085, 10);
    const mkDots = (color, op, n) => {
      const im = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false }), n);
      im.count = 0; im.frustumCulled = false; im.renderOrder = 5;
      this.scene.add(im); return im;
    };
    this.aimDots = mkDots(0xffffff, 0.9, 90);               // cue-ball path
    this.dirDots = mkDots(0xffe27a, 0.9, 24);               // object-ball direction
    this.ghostRing = new THREE.Mesh(
      new THREE.RingGeometry(this.spec.ballR * 0.82, this.spec.ballR, 28),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, depthWrite: false, side: THREE.DoubleSide }));
    this.ghostRing.rotation.x = -Math.PI / 2; this.ghostRing.visible = false; this.ghostRing.renderOrder = 5;
    this.scene.add(this.ghostRing);
    // ball-in-hand ghost ball
    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(this.spec.ballR, 18, 12),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    this.ghostBall.visible = false;
    this.scene.add(this.ghostBall);
    // placement region tint (kitchen / D)
    this.regionMesh = null;
  }

  _buildCue() {
    const LEN = 1.45;
    this.cueLen = LEN;
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0055, 0.0145, LEN, 14),
      new THREE.MeshStandardMaterial({ map: cueTexture(), roughness: 0.45 }));
    shaft.rotation.z = -Math.PI / 2;                         // thin top (+Y tip) → +X: tip at the group origin, butt trailing −X
    shaft.position.x = -LEN / 2;
    const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0053, 0.0055, 0.014, 12),
      new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.5 }));
    ferrule.rotation.z = Math.PI / 2; ferrule.position.x = -0.007;
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.0053, 0.006, 12),
      new THREE.MeshStandardMaterial({ color: 0x2c5f8a, roughness: 0.9 }));
    tip.rotation.z = Math.PI / 2; tip.position.x = -0.0005;
    g.add(shaft, ferrule, tip);
    g.visible = false;
    this.cue = g;
    this.scene.add(g);
    this._cueAnim = null;
  }

  // ---- public API -----------------------------------------------------------
  // Rematch: adopt a fresh balls array (same ids — the ruleset doesn't change mid-page).
  reset(balls) {
    this.balls = balls;
    const r = this.spec.ballR;
    for (const b of balls) {
      const rec = this.ballMeshes.get(b.id);
      if (!rec) continue;
      rec.shown = b.inPlay; rec.mesh.visible = b.inPlay;
      rec.mesh.position.set(b.x, r, b.y);
      rec.px = b.x; rec.py = b.y;
    }
    this.kick();
  }

  worldFromEvent(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.aimPlane, p)) return null;
    return { x: p.x, y: p.z };
  }

  // `dt` (optional, seconds since last sync): when given, balls visually rotate by their SPIN
  // (b.wx/b.wy — so backspin shows) instead of by displacement.
  syncBalls(dt) {
    const r = this.spec.ballR;
    for (const b of this.balls) {
      const rec = this.ballMeshes.get(b.id);
      if (!rec) continue;
      if (!b.inPlay) {
        if (rec.shown) {                                     // start the sink animation
          rec.shown = false;
          const p = this.spec.pockets[b.pocket ?? 0];
          const m = rec.mesh, t0 = performance.now();
          this._fx.push((now) => {
            const k = Math.min(1, (now - t0) / 220);
            m.position.set(p.x + (m.position.x - p.x) * (1 - k) * 0.4, r - (r * 2.4) * k, p.y + (m.position.z - p.y) * (1 - k) * 0.4);
            if (k >= 1) { m.visible = false; return false; }
            return true;
          });
        }
        continue;
      }
      if (!rec.shown) { rec.shown = true; rec.mesh.visible = true; rec.mesh.position.y = r; rec.px = b.x; rec.py = b.y; }
      let dx = b.x - rec.px, dy = b.y - rec.py;
      rec.mesh.position.set(b.x, r, b.y);
      if (dt != null && (b.wx || b.wy)) { dx = b.wx * dt; dy = b.wy * dt; }  // true spin, incl. backspin
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) {                                     // roll: axis = up × v
        const axis = new THREE.Vector3(dy / dist, 0, -dx / dist);
        const q = new THREE.Quaternion().setFromAxisAngle(axis, dist / r);
        rec.mesh.quaternion.premultiply(q);
      }
      rec.px = b.x; rec.py = b.y;
    }
    this.kick();
  }

  // aim = null | { from, dir, power, predict } (see physics.predictShot)
  setAim(aim) {
    this._aim = aim;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1);
    Q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));     // dots lie flat
    const lay = (im, ax, ay, bx, by, gap, skip = 0) => {
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.min(im.instanceMatrix.count ?? 90, Math.floor((len - skip) / gap));
      let c = 0;
      for (let i = 0; i < n; i++) {
        const t = (skip + i * gap) / len;
        M.compose(new THREE.Vector3(ax + (bx - ax) * t, 0.004, ay + (by - ay) * t), Q, S);
        im.setMatrixAt(c++, M);
      }
      im.count = c; im.instanceMatrix.needsUpdate = true;
    };
    if (!aim) {
      this.aimDots.count = 0; this.dirDots.count = 0;
      this.ghostRing.visible = false;
      if (!this._cueAnim) this.cue.visible = false;
      this.kick();
      return;
    }
    const { from, predict } = aim;
    lay(this.aimDots, from.x, from.y, predict.contact.x, predict.contact.y, 0.05, this.spec.ballR * 1.6);
    if (predict.type === 'ball') {
      const e = 0.30;                                        // object-ball direction hint length
      lay(this.dirDots, predict.ballFrom.x, predict.ballFrom.y,
        predict.ballFrom.x + predict.ballDir.x * e, predict.ballFrom.y + predict.ballDir.y * e, 0.045, this.spec.ballR);
      this.ghostRing.position.set(predict.contact.x, 0.004, predict.contact.y);
      this.ghostRing.visible = true;
    } else {
      this.dirDots.count = 0;
      this.ghostRing.visible = false;
    }
    this._poseCue(aim, 0.055 + aim.power * 0.24);
    this.cue.visible = true;
    this.kick();
  }

  _poseCue(aim, pull) {
    const r = this.spec.ballR;
    const yaw = -Math.atan2(aim.dir.y, aim.dir.x);
    this.cue.position.set(aim.from.x - aim.dir.x * (r + pull), r * 1.15, aim.from.y - aim.dir.y * (r + pull));
    this.cue.quaternion.setFromEuler(new THREE.Euler(0, yaw, -0.075));  // butt slightly raised
  }

  // Fast forward stroke; fires `onImpact` at the moment the tip reaches the ball.
  strike(aim, onImpact) {
    this.cue.visible = true;                                 // setAim(null) may have hidden it
    const start = 0.055 + aim.power * 0.24;
    const t0 = performance.now(), DUR = 95;
    this._cueAnim = true;
    let fired = false;
    this._fx.push((now) => {
      const k = Math.min(1, (now - t0) / DUR);
      this._poseCue(aim, start * (1 - k * k));
      if (k >= 1 && !fired) {
        fired = true;
        onImpact();
        const f0 = now;                                      // brief follow-through, then hide
        this._fx.push((n2) => {
          const k2 = Math.min(1, (n2 - f0) / 240);
          this.cue.position.y = this.spec.ballR * 1.15 + k2 * 0.05;
          if (k2 >= 1) { this.cue.visible = false; this._cueAnim = null; return false; }
          return true;
        });
        return false;
      }
      return !fired;
    });
    this.kick();
  }

  setGhost(g) {
    if (!g) { this.ghostBall.visible = false; this.kick(); return; }
    this.ghostBall.visible = true;
    this.ghostBall.position.set(g.x, this.spec.ballR, g.y);
    this.ghostBall.material.color.set(g.ok ? 0xffffff : 0xff5a5a);
    this.kick();
  }

  setRegion(region) {
    if (this.regionMesh) { this.scene.remove(this.regionMesh); this.regionMesh.geometry.dispose(); this.regionMesh = null; }
    if (!region || region === 'anywhere') { this.kick(); return; }
    const s = this.spec;
    let geo;
    if (region === 'kitchen') geo = new THREE.PlaneGeometry(s.kitchenX + s.hx, s.W);
    else {                                                   // 'D'
      geo = new THREE.CircleGeometry(s.dR, 24, Math.PI / 2, Math.PI);
    }
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    if (region === 'kitchen') m.position.set((-s.hx + s.kitchenX) / 2, 0.002, 0);
    else m.position.set(s.baulkX, 0.002, 0);
    this.regionMesh = m;
    this.scene.add(m);
    this.kick();
  }

  _resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // fit the whole table: needed distance from both the vertical and horizontal FOV
    const vf = (this.camera.fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    const needW = (this.spec.hx + FRAME_W + 0.12) / Math.tan(hf / 2);
    const needH = (this.spec.hy + FRAME_W + 0.30) / Math.tan(vf / 2);
    const d = Math.max(needW, needH) * 1.02;
    const elev = 0.98;                                       // rad above horizon (~56°)
    this.camera.position.set(0, d * Math.sin(elev), d * Math.cos(elev));
    this.camera.lookAt(0, -0.06, 0);
    this.camera.updateProjectionMatrix();
    this.kick();
  }

  kick() {
    if (this._running) return;
    this._running = true;
    requestAnimationFrame(() => this._anim());
  }
  _anim() {
    const now = performance.now();
    let active = false;
    if (this._fx.length) { this._fx = this._fx.filter((fx) => fx(now)); active = this._fx.length > 0; }
    this.renderer.render(this.scene, this.camera);
    if (active) requestAnimationFrame(() => this._anim());
    else this._running = false;
  }

  destroy() { window.removeEventListener('resize', this._resize); this.renderer.dispose(); }
}
