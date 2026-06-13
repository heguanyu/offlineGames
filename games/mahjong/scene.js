// 3D table rendering for the mahjong game on a locally-vendored three.js
// (offline — no runtime CDN). Tiles are chunky boxes whose faces are drawn to a
// canvas and used as textures, so there are zero binary art assets.
//
// Meshes are persistent and keyed by a stable id, so sync() only diffs the
// desired layout against what's on the table; an animation loop then eases each
// tile toward its target transform. That gives smooth selection lifts, hand
// reflow when a tile leaves, and discards dropping into the pool — for free.
import * as THREE from './lib/three.module.min.js';
import { suitOf, rankOf } from './engine.js';

const TW = 1.0, TH = 1.35, TD = 0.62; // tile width / height / depth
const FELT = 16;
const GAP = 1.06;
// Seats sit on a ring; the player's row is pushed forward (toward the camera)
// and each row's half-length is capped so neighbouring rows never collide at
// the corners. Rows longer than their cap shrink uniformly to fit.
const R_OPP = 6.0, R_HAND = 7.3;
const OPP_HALF = 4.5, HAND_HALF = 6.1;

const SUIT_CHAR = { m: '万', p: '筒', s: '条' };
const SUIT_COLOR = { m: '#15407e', p: '#0e7a48', s: '#b23218' };
const WINDS = ['东', '南', '西', '北'];
const DRAGONS = ['中', '發', '白'];
const DRAGON_COLOR = ['#c0392b', '#15803d', '#2563eb'];

// ---- tile faces ------------------------------------------------------------
// Authentic faces come from the FluffyStuff riichi tile set (CC0, vendored in
// ./tiles). Each SVG is design-only on a transparent 300x400 canvas, so we
// composite it onto an ivory tile face. Until a design loads (or if it fails)
// we fall back to a drawn number+suit so a tile is never blank.
const KIND_FILE = [
  'Man1', 'Man2', 'Man3', 'Man4', 'Man5', 'Man6', 'Man7', 'Man8', 'Man9',
  'Pin1', 'Pin2', 'Pin3', 'Pin4', 'Pin5', 'Pin6', 'Pin7', 'Pin8', 'Pin9',
  'Sou1', 'Sou2', 'Sou3', 'Sou4', 'Sou5', 'Sou6', 'Sou7', 'Sou8', 'Sou9',
  'Ton', 'Nan', 'Shaa', 'Pei', 'Chun', 'Hatsu', 'Haku',
];
const designs = new Map(); // kind -> { img, loaded }
let onDesignLoad = null;    // set by the active scene; called with kind on load
function preloadDesigns() {
  KIND_FILE.forEach((name, k) => {
    const img = new Image();
    const rec = { img, loaded: false };
    img.onload = () => { rec.loaded = true; onDesignLoad && onDesignLoad(k); };
    img.src = new URL(`./tiles/${name}.svg`, import.meta.url).href;
    designs.set(k, rec);
  });
}
// URL of a tile's face SVG — reused by the HTML 混儿 overlay so it shows the real
// tile art rather than a drawn number+suit.
export function tileFaceUrl(kind) {
  return new URL(`./tiles/${KIND_FILE[kind]}.svg`, import.meta.url).href;
}
function rr(x, X, Y, W, H, r) {
  x.beginPath(); x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath();
}
// Soft radial glow for the selection highlight (additive sprite).
function makeGlowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,247,214,0.95)');
  g.addColorStop(0.30, 'rgba(255,223,150,0.6)');
  g.addColorStop(0.65, 'rgba(255,206,120,0.18)');
  g.addColorStop(1, 'rgba(255,206,120,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function drawTextFallback(x, kind, W, H) {
  x.textAlign = 'center'; x.textBaseline = 'middle';
  if (kind < 27) {
    const s = suitOf(kind);
    x.fillStyle = SUIT_COLOR[s];
    x.font = `900 ${W * 0.66}px -apple-system,"PingFang SC",sans-serif`;
    x.fillText(String(rankOf(kind)), W / 2, H * 0.40);
    x.font = `800 ${W * 0.39}px -apple-system,"PingFang SC",sans-serif`;
    x.fillText(SUIT_CHAR[s], W / 2, H * 0.74);
  } else {
    x.fillStyle = kind < 31 ? '#2b3a4a' : DRAGON_COLOR[kind - 31];
    x.font = `900 ${W * 0.7}px -apple-system,"PingFang SC",sans-serif`;
    x.fillText(kind < 31 ? WINDS[kind - 27] : DRAGONS[kind - 31], W / 2, H * 0.52);
  }
}
// Render a complete tile face onto canvas `cv`.
function drawFace(cv, kind, wild) {
  const x = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, wild ? '#fff8e4' : '#fcf7ea');
  g.addColorStop(1, wild ? '#f1dfaa' : '#ece2c8');
  x.fillStyle = g; rr(x, 0, 0, W, H, W * 0.1); x.fill();
  x.strokeStyle = wild ? '#d8a93a' : '#d9cfb2'; x.lineWidth = W * 0.025;
  rr(x, W * 0.035, H * 0.027, W * 0.93, H * 0.946, W * 0.07); x.stroke();
  const rec = designs.get(kind);
  if (rec && rec.loaded) {
    const mx = W * 0.13, my = H * 0.09;
    x.drawImage(rec.img, mx, my, W - 2 * mx, H - 2 * my);
  } else {
    drawTextFallback(x, kind, W, H);
  }
  if (wild) {
    x.fillStyle = '#d99e21'; x.beginPath(); x.arc(W * 0.84, H * 0.12, W * 0.12, 0, 7); x.fill();
    x.fillStyle = '#4a3500'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `900 ${W * 0.15}px sans-serif`; x.fillText('混', W * 0.84, H * 0.13);
  }
}

export class MahjongScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x09221a);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camBase = new THREE.Vector3(0, 11.2, 15.8);
    this.camLook = new THREE.Vector3(0, -1.2, 0.9);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.camLook);

    this._lights(); this._table();

    this.geo = new THREE.BoxGeometry(TW, TH, TD);
    this.ivory = new THREE.MeshStandardMaterial({ color: 0xece2c8, roughness: 0.6, metalness: 0.02 });
    this.green = new THREE.MeshStandardMaterial({ color: 0x1c855f, roughness: 0.5, metalness: 0.03 });
    this.faceMat = new Map();   // faceKey -> material
    this.faceRecords = [];      // { canvas, tex, kind, wild } for async redraw on load
    onDesignLoad = (k) => this._redrawKind(k);
    if (!designs.size) preloadDesigns();

    this.tiles = new Map();   // key -> { mesh, tp:Vector3, trx, try_, ts }
    this.pickables = [];
    this.scene.add(this.tilesGroup = new THREE.Group());

    // selection glow — an additive sprite that softly lights the lifted tile
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(), color: 0xffd27a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    this.glow.scale.setScalar(0.001);
    this.scene.add(this.glow);
    this.glowTarget = { on: false, pos: new THREE.Vector3(), size: 1 };

    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._loop();
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xbfe6d8, 0x223026, 1.0));
    const key = new THREE.DirectionalLight(0xfff4d6, 2.7);
    key.position.set(-6, 15, 8); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 12; Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 42 });
    key.shadow.bias = -0.0004; this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xa9c7ff, 0.55); fill.position.set(8, 9, -6); this.scene.add(fill);
  }

  _table() {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(FELT + 2.4, 0.7, FELT + 2.4),
      new THREE.MeshStandardMaterial({ color: 0x6e4626, roughness: 0.72 }));
    rim.position.y = -0.45; rim.receiveShadow = true; this.scene.add(rim);
    const felt = new THREE.Mesh(new THREE.BoxGeometry(FELT, 0.5, FELT),
      new THREE.MeshStandardMaterial({ map: this._feltTexture(), color: 0x178a63, roughness: 0.96 }));
    felt.position.y = -0.26; felt.receiveShadow = true; this.scene.add(felt);
  }
  _feltTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'); x.fillStyle = '#157a57'; x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) { x.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`; x.fillRect(Math.random() * 256, Math.random() * 256, 1, 1); }
    x.strokeStyle = 'rgba(255,255,255,0.06)'; x.lineWidth = 3; x.beginPath(); x.arc(128, 128, 78, 0, 7); x.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  _material(kind, wild, emissive) {
    if (kind == null) return this.green; // back face
    const key = kind + (wild ? 'w' : '') + (emissive ? 'e' : '');
    let m = this.faceMat.get(key);
    if (!m) {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 346;
      drawFace(cv, kind, wild);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.48 });
      if (emissive) m.emissive = new THREE.Color(0x6a4a12);
      this.faceMat.set(key, m);
      this.faceRecords.push({ canvas: cv, tex, kind, wild });
    }
    return m;
  }
  // Re-render any faces of `kind` once its SVG design finishes loading.
  _redrawKind(kind) {
    for (const r of this.faceRecords) {
      if (r.kind === kind) { drawFace(r.canvas, r.kind, r.wild); r.tex.needsUpdate = true; }
    }
  }
  _mats(kind, wild, emissive) {
    const f = this._material(kind, wild, emissive);
    return [this.ivory, this.ivory, this.ivory, this.ivory, kind == null ? this.green : f, this.green];
  }

  // Ensure a mesh exists for `key` with the given face, and set its target
  // transform. `spec`: { kind|null, wild, x, y, z, rx, ry, pick, drop }
  _place(key, spec, seen) {
    seen.add(key);
    let rec = this.tiles.get(key);
    const faceKey = (spec.kind == null ? 'B' : spec.kind + (spec.wild ? 'w' : '') + (spec.emissive ? 'e' : ''));
    if (!rec) {
      const mesh = new THREE.Mesh(this.geo, this._mats(spec.kind, spec.wild, spec.emissive));
      mesh.castShadow = mesh.receiveShadow = true;
      if (spec.from) {            // slide in from a player's hand (discard / 碰 / 杠)
        mesh.position.copy(spec.from);
        mesh.scale.setScalar(spec.scale ?? 1);
      } else {
        mesh.position.set(spec.x, spec.y + (spec.drop ? 6 : 0), spec.z);
        mesh.scale.setScalar(0.001); // grow in
      }
      mesh.rotation.set(spec.rx, spec.ry, spec.rz || 0);
      this.tilesGroup.add(mesh);
      rec = { mesh, faceKey };
      this.tiles.set(key, rec);
    } else if (rec.faceKey !== faceKey) {
      rec.mesh.material = this._mats(spec.kind, spec.wild, spec.emissive);
      rec.faceKey = faceKey;
    }
    rec.tp = new THREE.Vector3(spec.x, spec.y, spec.z);
    rec.trx = spec.rx; rec.try_ = spec.ry; rec.trz = spec.rz || 0; rec.ts = spec.scale ?? 1;
    if (spec.pick != null) { rec.mesh.userData.pick = spec.pick; this.pickables.push(rec.mesh); }
    else delete rec.mesh.userData.pick;
  }

  sync(game, ui) {
    this.pickables = [];
    this.glowTarget.on = false;
    this.claimable = !!ui.claimable; // only enlarge the pending tile if YOU can claim
    const seen = new Set();
    const HUMAN = 0;

    // Player hand (upright, pickable).
    const hand = ui.renderedHand;
    const handItems = hand.map((id, i) => ({
      key: 'h' + i, kind: id, wild: game.isWild(id), pick: i,
      selected: ui.myTurn && i === ui.selRendered,
    }));
    this._placeRow(handItems, { cx: 0, cz: R_HAND, dx: 1, dz: 0, rx: -0.34, ry: 0, pull: -0.35 }, HAND_HALF, seen);

    // Opponents: walls of backs.
    const oppCfg = {
      1: { cx: R_OPP, cz: 0, dx: 0, dz: 1, rx: 0, ry: -Math.PI / 2, pull: 0 },
      2: { cx: 0, cz: -R_OPP, dx: 1, dz: 0, rx: 0, ry: Math.PI, pull: 0 },
      3: { cx: -R_OPP, cz: 0, dx: 0, dz: 1, rx: 0, ry: Math.PI / 2, pull: 0 },
    };
    for (const p of [1, 2, 3]) {
      const backs = [];
      for (let i = 0; i < game.hands[p].length; i++) backs.push({ key: `o${p}_${i}`, kind: null });
      this._placeRow(backs, oppCfg[p], OPP_HALF, seen);
    }

    // Exposed 吃/碰/杠 melds: laid flat and face-up on the table, in a spot pulled
    // toward the center so the angled camera reads the faces (the front edge is
    // too grazing). Each seat's group sits to that player's side.
    this._meldsFlat(game, seen);

    // central discard pool (faces, lying flat)
    this._pool(game, seen);

    // remove anything no longer present
    for (const [k, rec] of this.tiles) {
      if (!seen.has(k)) { this.tilesGroup.remove(rec.mesh); this.tiles.delete(k); }
    }
  }

  // Approx world position of a seat's hand/wall — where discards and claimed
  // tiles animate from.
  _seatCenter(p) {
    if (p === 0) return new THREE.Vector3(0, TH / 2, R_HAND);
    if (p === 1) return new THREE.Vector3(R_OPP, TH / 2, 0);
    if (p === 2) return new THREE.Vector3(0, TH / 2, -R_OPP);
    return new THREE.Vector3(-R_OPP, TH / 2, 0);
  }

  _meldsFlat(game, seen) {
    // Each seat's exposed melds, laid flat and face-up in a row BESIDE that
    // seat's tiles (parallel to their wall, pulled in toward the center so the
    // camera reads the faces). `spin` rotates the tile in the table plane (the
    // 3rd Euler angle, applied after rx=-90° — it keeps the face pointing up,
    // which a y-rotation would not).
    // On the brown wooden rim (the felt ends at ±8, the rim runs 8→9.2) so melds
    // sit off the play area, clear of the central discard pool. The player's are
    // pushed right so they don't hide behind the bottom-center action bar.
    const E = 8.5;                       // radius onto the brown rim
    const cfg = {
      0: { cx: 4.8, cz: E - 0.1, dx: 1, dz: 0, spin: 0 },       // you: front rim, just below the hand, right of the action bar
      1: { cx: E, cz: 0, dx: 0, dz: 1, spin: Math.PI / 2 },     // 下家 right rim
      2: { cx: 0, cz: -E, dx: 1, dz: 0, spin: 0 },              // 对家 top rim
      3: { cx: -E, cz: 0, dx: 0, dz: 1, spin: Math.PI / 2 },    // 上家 left rim
    };
    const MS = 0.72, step = 0.95 * MS, meldGap = 0.5 * MS;
    const RIM_Y = (TD / 2) * MS - 0.1;   // rest on the rim (slightly below the felt)
    for (let p = 0; p < 4; p++) {
      const melds = game.melds[p];
      if (!melds.length) continue;
      const c = cfg[p];
      const tiles = [];
      melds.forEach((m) => (m.tiles || []).forEach((k, j) => tiles.push({ kind: k, first: j === 0 })));
      const pos = []; let cur = 0;
      tiles.forEach((t, i) => { cur += (i === 0 ? 0 : step) + (t.first && i ? meldGap : 0); pos.push(cur); });
      const span = cur;
      tiles.forEach((t, i) => {
        const off = pos[i] - span / 2;
        this._place(`m${p}_${i}`, {
          kind: t.kind, scale: MS, from: this._seatCenter(p),
          x: c.cx + c.dx * off, y: RIM_Y, z: c.cz + c.dz * off, rx: -Math.PI / 2, ry: 0, rz: c.spin,
        }, seen);
      });
    }
  }

  // Lay items in a line along cfg's edge, centered, scaled uniformly so the row
  // fits within ±maxHalf (so it never reaches a neighbouring seat's row).
  _placeRow(items, cfg, maxHalf, seen) {
    const pos = [];
    let cursor = 0;
    items.forEach((it, i) => { cursor += (i === 0 ? 0 : GAP) + (it.gapBefore || 0); pos.push(cursor); });
    const span = cursor;
    const s = Math.min(1, (2 * maxHalf) / Math.max(span, 0.001));
    items.forEach((it, i) => {
      const off = (pos[i] - span / 2) * s;
      const x = cfg.cx + cfg.dx * off, baseY = (TH / 2) * s;
      const lift = it.selected ? 0.55 * s : 0;
      const z = cfg.cz + cfg.dz * off + (it.selected ? cfg.pull : 0);
      this._place(it.key, {
        kind: it.kind, wild: it.wild, pick: it.pick, emissive: it.emissive, scale: s,
        x, y: baseY + lift, z, rx: cfg.rx + (it.selected ? 0.16 : 0), ry: cfg.ry,
      }, seen);
      if (it.selected) {
        this.glowTarget.on = true;
        this.glowTarget.pos.set(x, baseY + lift, z);
        this.glowTarget.size = s;
      }
    });
    return s;
  }

  // Project a world point to CSS pixel coords (viewport-relative). The pending
  // claim tile sits at PENDING_AT, so HUD can be pinned under it.
  worldToScreen(x, y, z) {
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
  }

  _pool(game, seen) {
    const log = game.discardLog;
    const POOL = 0.82;                 // discards are smaller than hands
    const perRow = 9, sx = 0.74, sz = 0.98; // keep the pool compact in the middle
    const rows = Math.max(1, Math.ceil(log.length / perRow));
    log.forEach((d, i) => {
      const r = Math.floor(i / perRow), col = i % perRow;
      const inRow = Math.min(perRow, log.length - r * perRow);
      // The just-discarded tile that YOU can claim (碰/杠/胡): show it big and
      // upright (facing the camera), front-center, so the choice is obvious.
      const pending = i === log.length - 1 && this.claimable;
      if (pending) {
        this._place('pool' + i, {
          kind: d.kind, wild: game.isWild(d.kind), emissive: true, scale: 1.5, from: this._seatCenter(d.player),
          x: 0, y: TH * 0.78, z: 2.6, rx: -0.18, ry: 0, rz: 0,
        }, seen);
        return;
      }
      this._place('pool' + i, {
        kind: d.kind, wild: game.isWild(d.kind), emissive: false, scale: POOL, from: this._seatCenter(d.player),
        x: (col - (inRow - 1) / 2) * sx, y: (TD / 2) * POOL, z: (r - (rows - 1) / 2) * sz - 0.2,
        rx: -Math.PI / 2, ry: 0,
      }, seen);
    });
  }

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    return hits.length ? hits[0].object.userData.pick : null;
  }

  _resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Dolly the camera straight back when the viewport is narrower than landscape
    // (portrait iPad) so the full table width stays in frame instead of being
    // cropped on the left and right.
    const BASE_ASPECT = 1.45;
    const k = Math.min(aspect < BASE_ASPECT ? BASE_ASPECT / aspect : 1, 2.2);
    this.camera.position.copy(this.camLook).addScaledVector(
      this.camBase.clone().sub(this.camLook), k);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    const tick = () => {
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const a = 1 - Math.exp(-13 * dt);
      for (const rec of this.tiles.values()) {
        const m = rec.mesh;
        const ts = rec.ts ?? 1;
        m.scale.setScalar(m.scale.x + (ts - m.scale.x) * a); // grow in + match target scale
        m.position.lerp(rec.tp, a);
        m.rotation.x += (rec.trx - m.rotation.x) * a;
        m.rotation.y += (rec.try_ - m.rotation.y) * a;
        m.rotation.z += ((rec.trz || 0) - m.rotation.z) * a;
      }
      // selection glow follow + fade
      const gt = this.glowTarget, gs = this.glow;
      gs.material.opacity += ((gt.on ? 1 : 0) - gs.material.opacity) * a;
      if (gs.material.opacity > 0.01) {
        gs.position.lerp(gt.pos, Math.min(1, a * 1.6));
        const pulse = (gt.size ?? 1) * 3.3 * (1 + Math.sin(performance.now() / 300) * 0.07);
        gs.scale.setScalar(pulse);
      }
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
