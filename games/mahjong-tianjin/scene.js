// 3D table rendering for the mahjong game on a locally-vendored three.js
// (offline — no runtime CDN). Tiles are chunky boxes whose faces are drawn to a
// canvas and used as textures, so there are zero binary art assets.
//
// Meshes are persistent and keyed by a stable id, so sync() only diffs the
// desired layout against what's on the table; an animation loop then eases each
// tile toward its target transform. That gives smooth selection lifts, hand
// reflow when a tile leaves, and discards dropping into the pool — for free.
import * as THREE from './lib/three.module.min.js';
import { suitOf, rankOf, shuffle } from './engine.js';
import { ringColor } from '../mahjong-common/timer-ring.js';

const TW = 1.0, TH = 1.35, TD = 0.62; // tile width / height / depth
const FELT = 16;
const GAP = 1.06;
const DRAW_MARGIN = 0.4;  // half-gap flanking the freshly-drawn tile on each side
const CLAIM_DEMO_MS = 2000; // a bot's 吃/碰/杠 is held up facing the camera this long
// Center "show-off" pose (per claiming seat) where a bot's just-claimed 吃/碰/杠 — and
// now also its discard — halts facing the camera before settling. Reused by both the
// claim-meld lift (_meldsFlat) and the discard fly (_pool).
const DEMO_POS = { 0: { x: 0, y: 2.7, z: 1.2 }, 1: { x: 3.8, y: 2.6, z: 1.8 }, 2: { x: 0, y: 2.95, z: -2.2 }, 3: { x: -3.8, y: 2.6, z: 1.8 } };
const DEMO_SCALE = 1.3;
const DISCARD_DROP_MS = 180; // a discard's fall from the center halt into the pool
// Initial deal: one tile launches from the wall every DEAL_SERVE_MS, round-robin
// from the dealer; each flies ~DEAL_LAND_MS (the loop's lerp) so several are in
// transit at once. The onLand callback fires DEAL_LAND_MS after a human tile is
// served — when it has settled into the hand row — for a per-tile clack.
// DEAL_SETTLE_MS lets the final tile land before play begins.
const DEAL_SERVE_MS = 50;
const DEAL_LAND_MS = 200;
const DEAL_SETTLE_MS = 300;
// Seats sit on a ring; the player's row is pushed forward (toward the camera)
// and each row's half-length is capped so neighbouring rows never collide at
// the corners. Rows longer than their cap shrink uniformly to fit.
const R_OPP = 7.1, R_HAND = 7.3;
const OPP_HALF = 4.5, HAND_HALF = 6.1;
const R_WALL = 5.8;  // the face-down deck wall sits in a ring at this radius, around the pool

const SUIT_CHAR = { m: '万', p: '筒', s: '条' };
const SUIT_COLOR = { m: '#15407e', p: '#0e7a48', s: '#b23218' };
const WINDS = ['东', '南', '西', '北'];
const DRAGONS = ['中', '發', '白'];
const DRAGON_COLOR = ['#c0392b', '#15803d', '#2563eb'];

// ---- tile faces ------------------------------------------------------------
// Authentic faces are photographed real tiles (see tiles/CREDITS.md), cropped to
// rounded-corner PNGs in ./tiles. Each PNG is a full tile face that drawFace
// stretches to fill the cap (over a tile-white ground, so the transparent rounded
// corners don't darken). Until one loads (or if it fails) we fall back to a drawn
// number+suit so a tile is never blank.
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
    img.src = new URL(`./tiles/${name}.png`, import.meta.url).href;
    designs.set(k, rec);
  });
}
// URL of a tile's face SVG — reused by the HTML 混儿 overlay so it shows the real
// tile art rather than a drawn number+suit.
export function tileFaceUrl(kind) {
  return new URL(`./tiles/${KIND_FILE[kind]}.png`, import.meta.url).href;
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
// A small canvas-textured label (明杠 / 暗杠 / 金杠) for a kong boundary's corner.
function makeKongLabel(text, color) {
  const c = document.createElement('canvas'); c.width = 192; c.height = 96;
  const x = c.getContext('2d');
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '800 60px -apple-system,"PingFang SC",sans-serif';
  x.lineWidth = 9; x.strokeStyle = 'rgba(0,0,0,0.7)'; x.strokeText(text, 96, 52);
  x.fillStyle = color; x.fillText(text, 96, 52);
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
// A rounded-corner tile body: a rounded-rectangle extruded by the full depth, so
// the tile is exactly TW×TH×TD (no added bulk) — only the four vertical corners
// are rounded, to match the rounded card face. Two material groups: group 0 =
// the flat front/back caps (the face), group 1 = the sides. Fewer groups than a
// 6-sided box, so this also lowers draw calls per tile.
function roundedTileGeo() {
  const w = TW, h = TH, r = Math.min(w, h) * 0.12;   // corner radius
  const x0 = -w / 2, y0 = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const geo = new THREE.ExtrudeGeometry(s, { depth: TD, bevelEnabled: false, steps: 1, curveSegments: 6 });
  geo.center();
  // Remap the cap UVs to 0..1 over the full TW×TH so the face texture maps cleanly
  // (ExtrudeGeometry's default cap UVs are in model space).
  const pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nrm.getZ(i)) > 0.5) {
      uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
    }
  }
  uv.needsUpdate = true;
  return geo;
}
// Render a complete tile face onto canvas `cv`. The vendored designs are full
// Chinese tile faces (white ground + border + art), so we draw one to fill the
// whole cap. Wild (混儿) tiles get a translucent golden wash + a 混 badge so they
// read as jokers. Until the SVG loads (or if it fails) we draw a number+suit
// fallback on an ivory ground so a tile is never blank.
function drawFace(cv, kind, wild) {
  const x = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H);
  const rec = designs.get(kind);
  if (rec && rec.loaded) {
    x.fillStyle = '#eae9e3'; x.fillRect(0, 0, W, H); // tile-white behind the PNG's transparent rounded corners
    x.drawImage(rec.img, 0, 0, W, H);
  } else {
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#fcf7ea'); g.addColorStop(1, '#ece2c8');
    x.fillStyle = g; rr(x, 0, 0, W, H, W * 0.1); x.fill();
    drawTextFallback(x, kind, W, H);
  }
  if (wild) {
    x.save(); rr(x, 0, 0, W, H, W * 0.075); x.clip();
    x.fillStyle = 'rgba(228,170,40,0.28)'; x.fillRect(0, 0, W, H); x.restore();
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
    // rx that tilts a flat-facing tile back so its face squarely faces the camera
    // (i.e. perpendicular to the camera's down-pitched view axis).
    this.faceCamRx = -Math.atan2(this.camBase.y - this.camLook.y, this.camBase.z - this.camLook.z);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.camLook);

    this._lights(); this._table();

    this.geo = roundedTileGeo();
    // Side edges: a faux frosted-glass rim — translucent (90% opaque) and very rough so
    // it reads matte/glassy without the cost of real transmission. The design face
    // (group 0) stays opaque, so the art stays crisp and the boundary reads clearly.
    this.ivory = new THREE.MeshStandardMaterial({
      color: 0xc6c0b1, roughness: 0.92, metalness: 0.0, transparent: true, opacity: 0.8,
    });
    this.green = new THREE.MeshStandardMaterial({ color: 0x1c855f, roughness: 0.5, metalness: 0.03 });
    this.faceMat = new Map();   // faceKey -> material
    this.faceRecords = [];      // { canvas, tex, kind, wild } for async redraw on load
    onDesignLoad = (k) => this._redrawKind(k);
    if (!designs.size) preloadDesigns();

    this.tiles = new Map();   // key -> { mesh, tp:Vector3, trx, try_, ts }
    this.claimDemo = null;    // { player, t0 } — a bot's just-claimed meld being shown off
    this.discardDemo = null;  // { player, idx, t0, ms } — a bot's discard flying via the center halt
    this.deal = null;         // initial-deal animation state (see beginDeal)
    this.pickables = [];
    this.scene.add(this.tilesGroup = new THREE.Group());

    // selection outline — a glowing gold shell tracing the selected tile: a crisp rim
    // (enlarged back-face hull) plus a soft additive halo. It rides the selected tile's
    // animated transform each frame (updated in the render loop).
    const rim = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color: 0xffd23a, side: THREE.BackSide }));
    rim.scale.setScalar(1.06);
    this.outlineHalo = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
      color: 0xffd773, side: THREE.BackSide, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    this.outlineHalo.scale.setScalar(1.2);
    this.outline = new THREE.Group();
    this.outline.add(rim, this.outlineHalo);
    this.outline.visible = false;
    this.scene.add(this.outline);
    this.selKey = null;

    this.kongBoxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.kongBounds = new Map(); // `${seat}_${meldIdx}` -> { box, label } for 杠 groups

    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.rotated = false; // true when the page is force-rotated 90° (portrait iPad)
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._loop();
  }

  // The page may be CSS-rotated 90° to force landscape on a portrait device; the
  // canvas still renders landscape, but pointer events arrive in viewport space,
  // so pick() must un-rotate them. (worldToScreen needs no change — the HUD is in
  // the same rotated frame as the canvas.)
  setRotated(r) { this.rotated = !!r; }
  resize() { this._resize(); }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xbfe6d8, 0x223026, 1.2)); // ambient fill (+20%)
    const key = new THREE.DirectionalLight(0xfff4d6, 2.7);
    key.position.set(-6, 15, 8); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 12; Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 42 });
    key.shadow.bias = -0.0004; this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xa9c7ff, 0.55); fill.position.set(8, 9, -6); this.scene.add(fill);
  }

  _table() {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(FELT + 2.4, 0.7, FELT + 2.4), this._woodMaterial());
    rim.position.y = -0.45; rim.receiveShadow = true; this.scene.add(rim);
    const felt = new THREE.Mesh(new THREE.BoxGeometry(FELT, 0.5, FELT), this._feltMaterial());
    felt.position.y = -0.26; felt.receiveShadow = true; this.scene.add(felt);
    this._turnRing();
    this._turnTimer();
  }

  // Online turn countdown as a 3D panel floating over the table centre, billboarded to the camera.
  // A canvas texture draws a depleting ring + the seconds; setTurnTimer() updates it. Hidden offline.
  _turnTimer() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    this._tt = { canvas: c, ctx: c.getContext('2d'), tex: new THREE.CanvasTexture(c) };
    this._tt.tex.anisotropy = 4;
    // painted on the felt at the TABLE-TOP layer: depth-tested so tiles in front occlude it, but no
    // depth write (like the turn ring), so it sits flush on the surface rather than floating above.
    const mat = new THREE.MeshBasicMaterial({ map: this._tt.tex, transparent: true, depthWrite: false });
    this.timerMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 3.0), mat);
    this.timerMesh.rotation.x = -Math.PI / 2; // lie flat on the felt, facing up (reads upright from the player)
    this.timerMesh.position.set(0, 0.03, 0);   // on the felt surface, table centre (same layer as the table top)
    this.timerMesh.visible = false;
    this.scene.add(this.timerMesh);
  }
  // o: { show, secs, frac (1→0), low }
  setTurnTimer(o) {
    if (!this.timerMesh) return;
    if (!o || !o.show) { this.timerMesh.visible = false; return; }
    const x = this._tt.ctx, S = 256, R = 92;
    // colour sweeps green→yellow→red with progress (shared with the DOM ring); shake the final seconds.
    const col = ringColor(o.frac);
    const j = o.low ? 6 : 0, cx = 128 + (j ? (Math.random() * 2 - 1) * j : 0), cy = 128 + (j ? (Math.random() * 2 - 1) * j : 0);
    x.clearRect(0, 0, S, S);
    x.beginPath(); x.arc(cx, cy, R + 22, 0, Math.PI * 2); x.fillStyle = 'rgba(6,26,18,0.9)'; x.fill();
    x.lineWidth = 18; x.lineCap = 'round';
    x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.strokeStyle = 'rgba(0,0,0,0.45)'; x.stroke();
    x.beginPath(); x.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, o.frac))); x.strokeStyle = col; x.stroke();
    x.fillStyle = '#eaf6f0'; x.font = '900 122px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String(o.secs), cx, cy + 6);
    this._tt.tex.needsUpdate = true;
    this.timerMesh.visible = true;
  }
  // A single glowing quarter-ring laid on the felt's drawn circle, centered at the table
  // origin. It rotates (in-plane) to face whichever seat's turn it is and pulses; hidden
  // when no seat is active. See _setTurnRing (sets the target seat) + the render loop.
  _turnRing() {
    const R = 4.875;                                   // matches the felt-texture ring
    const geo = new THREE.RingGeometry(R - 0.18, R + 0.18, 40, 1, -Math.PI / 4, Math.PI / 2); // quarter centered on +X
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    this.turnRing = new THREE.Mesh(geo, mat);
    this.turnRing.rotation.set(-Math.PI / 2, 0, 0); // lie flat; rotation.z (3rd Euler) spins it in-plane
    this.turnRing.position.y = 0.03;
    this.turnRing.visible = false;
    this.scene.add(this.turnRing);
    // in-plane spin centering the quarter on each seat (+X 下家, -Z 对家, -X 上家, +Z 玩家)
    this._turnSpin = { 0: -Math.PI / 2, 1: 0, 2: Math.PI / 2, 3: Math.PI };
    this._turnRingActive = -1;
  }
  // Aim the ring at seat `p` (p < 0 → hide it, e.g. game over).
  _setTurnRing(p) {
    this._turnRingActive = p;
    if (this.turnRing) this.turnRing.visible = p >= 0;
  }
  // Green-baize felt. The COLOR is a single non-tiling canvas (green + soft macro blotches + fine
  // Gaussian grain) so there's NO visible repeat across the table; the weave detail comes from a CC0
  // wool-felt photo (ambientCG Fabric034, 512px) as the tiled normal + roughness maps — so the key
  // light catches the cloth. ~155 KB bundled (offline). (three r160 applies each map's own uv repeat.)
  _feltMaterial() {
    const loader = new THREE.TextureLoader();
    const tex = (file) => {
      const t = loader.load(new URL(`./textures/${file}`, import.meta.url).href);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); t.anisotropy = 8;
      t.colorSpace = THREE.NoColorSpace;
      return t;
    };
    return new THREE.MeshStandardMaterial({
      map: this._feltColorTexture(),
      normalMap: tex('felt_normal.jpg'),
      roughnessMap: tex('felt_rough.jpg'),
      color: 0xffffff, roughness: 1.0, metalness: 0.0,
      normalScale: new THREE.Vector2(0.5, 0.5),
    });
  }
  // One big (non-tiling) felt-green canvas: base + low-frequency blotches (kill the tile repeat) +
  // per-pixel Gaussian grain (sum of 3 uniforms ≈ normal distribution).
  _feltColorTexture() {
    const N = 1024, c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d');
    x.fillStyle = '#1b6f4b'; x.fillRect(0, 0, N, N);
    for (let i = 0; i < 60; i++) {
      const cx = Math.random() * N, cy = Math.random() * N, r = 140 + Math.random() * 320;
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, Math.random() < 0.5 ? 'rgba(74,170,124,0.10)' : 'rgba(0,46,28,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(0, 0, N, N);
    }
    const im = x.getImageData(0, 0, N, N), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() + Math.random() + Math.random() - 1.5) * 22;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    x.putImageData(im, 0, 0);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  }
  // Wood rim — CC0 plank photo (ambientCG Wood066, 512px) tiled, so the table edge isn't a flat colour.
  _woodMaterial() {
    const loader = new THREE.TextureLoader();
    const tex = (file, srgb) => {
      const t = loader.load(new URL(`./textures/${file}`, import.meta.url).href);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); t.anisotropy = 8;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return t;
    };
    return new THREE.MeshStandardMaterial({
      map: tex('wood_color.jpg', true),
      normalMap: tex('wood_normal.jpg', false),
      roughnessMap: tex('wood_rough.jpg', false),
      color: 0xa9794a, roughness: 0.8, metalness: 0.0,
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
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
    // rounded geometry has 2 groups: [0] flat caps (the face), [1] rounded sides.
    return [this._material(kind, wild, emissive), this.ivory];
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
        mesh.scale.setScalar(spec.fromScale ?? spec.scale ?? 1); // grow from wall size when dealing
      } else {
        mesh.position.set(spec.x, spec.y + (spec.drop ? 6 : 0), spec.z);
        mesh.scale.setScalar(0.001); // grow in
      }
      mesh.rotation.set(spec.rx, spec.ry, spec.rz || 0);
      this.tilesGroup.add(mesh);
      rec = { mesh, faceKey };
      this.tiles.set(key, rec);
      // The human's freshly-drawn tile gets a reveal: deck → big in the centre,
      // facing the camera → its slot in the hand. (Handled in the animation loop.)
      // `gate` tiles also block input until the reveal settles (see _animateDraw).
      if (spec.draw && spec.from) {
        rec.drawSeq = { t0: performance.now(), deck: spec.from.clone() };
        if (spec.gate) { rec.gate = true; this.handDrawRevealing = true; }
      }
      // 吃/碰/杠 demo: fly up from the seat, hold facing the camera, then settle flat.
      if (spec.claim) {
        rec.claimSeq = { t0: spec.claim.t0, ms: spec.claim.ms, demo: spec.claim.demo,
          from: spec.from ? spec.from.clone() : new THREE.Vector3(spec.x, spec.y, spec.z),
          rx0: spec.rx, rz0: spec.rz || 0 };
      }
      // Bot-discard demo: fly from the seat up to the same center halt, hold, then
      // release to lerp down into the pool slot (rec.tp). Same rise/hold/release shape.
      if (spec.discard) {
        rec.discardSeq = { t0: spec.discard.t0, ms: spec.discard.ms, demo: spec.discard.demo, drop: DISCARD_DROP_MS,
          from: spec.from ? spec.from.clone() : new THREE.Vector3(spec.x, spec.y, spec.z),
          rx0: spec.rx, rz0: spec.rz || 0 };
      }
    } else if (rec.faceKey !== faceKey) {
      rec.mesh.material = this._mats(spec.kind, spec.wild, spec.emissive);
      rec.faceKey = faceKey;
    }
    rec.tp = new THREE.Vector3(spec.x, spec.y, spec.z);
    rec.trx = spec.rx; rec.try_ = spec.ry; rec.trz = spec.rz || 0; rec.ts = spec.scale ?? 1;
    if (spec.pick != null) { rec.mesh.userData.pick = spec.pick; this.pickables.push(rec.mesh); }
    else delete rec.mesh.userData.pick;
  }

  // Layout config for the human's hand row (also reused by the deal animation).
  // refSpan keeps the tile size fixed for a full 14-tile hand (13 gaps + the drawn
  // tile's two half-gaps) so tiles never resize as the count changes.
  _handRowCfg(flat) {
    return { cx: 0, cz: R_HAND, dx: 1, dz: 0, rx: flat ? -Math.PI / 2 : -0.34, ry: 0,
      pull: -0.35, flat, refSpan: 13 * GAP + 2 * DRAW_MARGIN };
  }
  // Layout config for the three opponents' back rows (also reused by the deal).
  _oppRowCfgs() {
    const oppRef = 13 * GAP;
    return {
      1: { cx: R_OPP, cz: 0, dx: 0, dz: 1, rx: 0, ry: -Math.PI / 2, pull: 0, refSpan: oppRef },
      2: { cx: 0, cz: -R_OPP, dx: 1, dz: 0, rx: 0, ry: Math.PI, pull: 0, refSpan: oppRef },
      3: { cx: -R_OPP, cz: 0, dx: 0, dz: 1, rx: 0, ry: Math.PI / 2, pull: 0, refSpan: oppRef },
    };
  }

  sync(game, ui) {
    if (this.deal) return; // the initial-deal animation owns the table until it hands off
    this.pickables = [];
    this.selKey = null;
    this._setTurnRing(ui.reveal ? -1 : game.turn); // glow the current seat's quarter of the ring
    this.claimable = !!ui.claimable; // only enlarge the pending tile if YOU can claim
    const seen = new Set();
    const HUMAN = 0;

    // Deck wall first, so it sets this.deckPos (where draws fly from).
    this._wall(game, seen);

    // Player hand (upright, pickable). The freshly-drawn tile sorts into its
    // natural place but gets a half-gap on each side (and a deck→center→slot
    // reveal) to set it apart. It carries a stable 'hdraw' key — separate from
    // the positional h0..hN of the settled tiles — so (a) the reveal re-fires
    // each draw (its key is recreated), and (b) the settled tiles keep their
    // keys and just slide to open the slot, rather than swapping faces as the
    // row reflows around the inserted tile.
    const hand = ui.renderedHand;
    const drawnIdx = ui.drawnTile != null ? hand.lastIndexOf(ui.drawnTile) : -1;
    const ownBacks = !!ui.ownBacks; // blind 拉庄: your own hand is dealt but shown face-down until you decide
    const hideWilds = !!ui.hideWilds; // 拉庄 in progress: the 混儿 isn't decided yet → don't mark wild tiles
    let settled = 0;
    const handItems = hand.map((id, i) => {
      const isDrawn = i === drawnIdx;
      return {
        key: isDrawn ? 'hdraw' : 'h' + settled++, kind: ownBacks ? null : id, wild: !ownBacks && !hideWilds && game.isWild(id), pick: i,
        selected: !ownBacks && i === ui.selRendered, // selRendered is gated by render() (on-turn offline; also while waiting online)
        // flank the drawn tile: a half-gap before it and before its right neighbour
        gapBefore: drawnIdx >= 0 && (i === drawnIdx || i === drawnIdx + 1) ? DRAW_MARGIN : 0,
        from: isDrawn ? this.deckPos : null,  // the drawn tile flies from the deck
        draw: isDrawn,                        // ...with the deck→center→slot reveal
        gate: isDrawn,                        // ...and input is gated until it settles
      };
    });
    // refSpan = a full 14-tile hand (13 gaps + the drawn tile's two half-gaps) so
    // the tile size is fixed regardless of how many tiles are currently held.
    // 听牌 (lockedTing) and game-over reveal both lay the hand flat on the table,
    // the same rotation as 碰/杠 melds (faces up).
    const flat = !!ui.tingFlat || !!ui.reveal;
    this._placeRow(handItems, this._handRowCfg(flat), HAND_HALF, seen);

    // Opponents: walls of backs. refSpan = a full 14-tile hand so the back row is
    // a fixed size, not rescaling each time a bot draws/discards (13 ↔ 14 tiles).
    const oppCfg = this._oppRowCfgs();
    for (const p of [1, 2, 3]) {
      const c = oppCfg[p];
      if (ui.reveal) {
        // game over: flip each opponent's wall down to a flat, face-up row (faces
        // shown). rz spins each row so it reads from that seat (like the melds).
        const spin = p === 2 ? 0 : Math.PI / 2;
        const items = game.hands[p].map((kind, i) => ({ key: `o${p}_${i}`, kind, rz: spin }));
        this._placeRow(items, { ...c, rx: -Math.PI / 2, ry: 0, flat: true }, OPP_HALF, seen);
      } else {
        const backs = [];
        // from: the deck → a newly-drawn back tile flies in from the deck wall.
        for (let i = 0; i < game.hands[p].length; i++) backs.push({ key: `o${p}_${i}`, kind: null, from: this.deckPos });
        this._placeRow(backs, c, OPP_HALF, seen);
      }
    }

    // Exposed 吃/碰/杠 melds: laid flat and face-up on the table, in a spot pulled
    // toward the center so the angled camera reads the faces (the front edge is
    // too grazing). Each seat's group sits to that player's side.
    this._meldsFlat(game, seen);

    // central discard pool (faces, lying flat). In 听牌, the human's tsumogiri tile
    // reveals deck→center→pool (so it's seen) — _pool gives that one the reveal.
    this._pool(game, seen, ui.tingRevealDiscardIdx ?? -1);

    // remove anything no longer present
    for (const [k, rec] of this.tiles) {
      if (!seen.has(k)) { this.tilesGroup.remove(rec.mesh); this.tiles.delete(k); }
    }
  }

  // ---- initial deal animation ----------------------------------------------
  // Replay the deal as a flourish: tiles fly one at a time from the wall to each
  // seat, round-robin from the dealer (one per DEAL_SERVE_MS). The human's tiles
  // slot into their sorted hand position — others slide aside to admit each new
  // one. Opponents get face-down backs. The engine has already dealt the final
  // hands; this is purely cosmetic, then hands the meshes off to sync() unchanged.
  // `done` fires once every tile has landed. Skipped under ?fast=1 (see main.js).
  beginDeal(game, done, onLand) {
    const HUMAN = 0;
    // The 13 tiles each seat is dealt. The dealer's 14th (drawn) tile is excluded
    // here — sync()'s normal draw reveal handles it right after the deal.
    const humanFull = game.hands[HUMAN].slice();
    if (game.dealer === HUMAN && game.drawnTile != null) {
      const i = humanFull.indexOf(game.drawnTile);
      if (i >= 0) humanFull.splice(i, 1);
    }
    // Serve the human's tiles out of sorted order so each visibly inserts into its
    // slot. Layout is always buildOrder, so the final row matches sync()'s exactly.
    this.deal = {
      game, done, onLand, t0: performance.now(), dealer: game.dealer,
      order: shuffle(humanFull, Math.random), // tiles in serve order
      humanTiles: [], humanIdx: 0,            // { k, kind, from } served so far
      oppOrigins: { 1: [], 2: [], 3: [] },    // each back's wall lift-off point
      landings: [],                           // times a human tile settles in the hand (→ clack)
      servedCount: [0, 0, 0, 0], served: 0, total: 52, // 13 × 4 seats
    };
    this.deal.reserve = this._buildDealReserve(this.deal.total); // the wall tiles dealt out
    this._clearKongBounds(); // wipe the previous hand's 杠 boxes/labels NOW, not after the deal finishes
    this._dealFrame(); // initial frame: full wall, empty hands; clears the old hand
  }

  // The human's served tiles in canonical (buildOrder) order: wilds left, rest
  // ascending. `k` (serve index) breaks ties so a tile keeps its identity/mesh.
  _dealHandOrder() {
    const g = this.deal.game;
    return this.deal.humanTiles.slice().sort((a, b) => {
      const aw = g.isWild(a.kind), bw = g.isWild(b.kind);
      if (aw !== bw) return aw ? -1 : 1;
      return a.kind - b.kind || a.k - b.k;
    });
  }

  // Advance the deal by however many tiles are due by now, then re-lay the table.
  _dealTick() {
    const d = this.deal, now = performance.now(), elapsed = now - d.t0;
    const want = Math.min(d.total, Math.floor(elapsed / DEAL_SERVE_MS));
    if (want > d.served) {
      while (d.served < want) {
        const s = d.served;
        const p = (d.dealer + (s % 4)) % 4; // round-robin from the dealer
        const r = d.reserve[s];             // the wall tile this serve takes
        const from = new THREE.Vector3(r.x, r.y, r.z);
        d.servedCount[p]++;
        if (p === 0) { // a tile for the human → clack when it settles in the hand
          d.humanTiles.push({ k: d.humanIdx, kind: d.order[d.humanIdx++], from });
          d.landings.push(d.t0 + s * DEAL_SERVE_MS + DEAL_LAND_MS);
        } else d.oppOrigins[p].push(from);
        d.served++;
      }
      this._dealFrame();
    }
    while (d.landings.length && d.landings[0] <= now) { d.landings.shift(); d.onLand && d.onLand(); }
    if (d.served >= d.total && elapsed >= d.total * DEAL_SERVE_MS + DEAL_SETTLE_MS) this._finishDeal();
  }

  _dealFrame() {
    const d = this.deal, game = d.game;
    const seen = new Set();
    const { WW } = this._wallSlotGeometry();
    // The permanent left+right wall (the tiles left after the deal) — the same one
    // sync() renders, so the hand-off is seamless. Plus the depleting reserve that
    // the dealt tiles physically come from.
    this._wall(game, seen, game.wall.length);
    this._dealReserve(seen);
    // Dealt tiles start at the reserve tile's exact spot and grow from wall size to
    // hand size as they fly in (fromScale), so each leaves the wall seamlessly.
    const items = this._dealHandOrder().map((t) =>
      ({ key: 'dh' + t.k, kind: t.kind, wild: game.isWild(t.kind), from: t.from, fromScale: WW }));
    this._placeRow(items, this._handRowCfg(false), HAND_HALF, seen);
    // opponents: face-down backs, each leaving the reserve too
    const oppCfg = this._oppRowCfgs();
    for (const p of [1, 2, 3]) {
      const backs = [];
      for (let i = 0; i < d.servedCount[p]; i++) backs.push({ key: `o${p}_${i}`, kind: null, from: d.oppOrigins[p][i], fromScale: WW });
      this._placeRow(backs, oppCfg[p], OPP_HALF, seen);
    }
    for (const [k, rec] of this.tiles) {
      if (!seen.has(k)) { this.tilesGroup.remove(rec.mesh); this.tiles.delete(k); }
    }
  }

  // Hand the deal meshes to sync(): re-key the human's tiles (dhK) to the
  // positional h0..hN sync() expects, in buildOrder, so it reuses them with no pop.
  _finishDeal() {
    const d = this.deal;
    while (d.landings.length) { d.landings.shift(); d.onLand && d.onLand(); } // any last clacks
    const order = this._dealHandOrder(); // while this.deal is still set
    this.deal = null;                    // let sync() take over
    order.forEach((t, idx) => {
      const rec = this.tiles.get('dh' + t.k);
      if (rec) { this.tiles.delete('dh' + t.k); this.tiles.set('h' + idx, rec); }
    });
    if (d.done) d.done();
  }

  // Approx world position of a seat's hand/wall — where discards and claimed
  // tiles animate from.
  _seatCenter(p) {
    if (p === 0) return new THREE.Vector3(0, TH / 2, R_HAND);
    if (p === 1) return new THREE.Vector3(R_OPP, TH / 2, 0);
    if (p === 2) return new THREE.Vector3(0, TH / 2, -R_OPP);
    return new THREE.Vector3(-R_OPP, TH / 2, 0);
  }

  // Mark a bot's just-claimed meld so the next render lifts it up facing the camera
  // for `ms` before it settles into the flat meld row. Call right after the claim is
  // applied (before the sync that first renders the new meld).
  beginClaimDemo(player, ms = CLAIM_DEMO_MS) { this.claimDemo = { player, t0: performance.now(), ms }; }
  // Mark a bot's discard (discardLog index `idx`) to fly from its seat up to the
  // center halt, hold, then drop into the pool. Call right after game.discard, before
  // the sync that first places the new pool tile.
  beginDiscardDemo(player, idx, ms = CLAIM_DEMO_MS) { this.discardDemo = { player, idx, t0: performance.now(), ms }; }

  _meldsFlat(game, seen) {
    // Each seat's exposed melds, laid flat and face-up in a row BESIDE that
    // seat's tiles (parallel to their wall, pulled in toward the center so the
    // camera reads the faces). `spin` rotates the tile in the table plane (the
    // 3rd Euler angle, applied after rx=-90° — it keeps the face pointing up,
    // which a y-rotation would not).
    // On the brown wooden rim (the felt ends at ±8, the rim runs 8→9.2) so melds
    // sit off the play area, clear of the central discard pool. The player's are
    // pushed right so they don't hide behind the bottom-center action bar. 对家's
    // sit further in, where the (now-removed) top wall stood, so the camera reads
    // their faces clearly instead of at the grazing far rim.
    const E = 8.5;                       // radius onto the brown rim
    const cfg = {
      0: { cx: 0, cz: E - 0.1, dx: 1, dz: 0, spin: 0 },         // you: front rim, centered just below the hand
      1: { cx: E, cz: 0, dx: 0, dz: 1, spin: Math.PI / 2 },     // 下家 right rim
      2: { cx: 0, cz: -R_WALL, dx: 1, dz: 0, spin: 0 },         // 对家: where the top wall was (on the felt), facing the camera
      3: { cx: -E, cz: 0, dx: 0, dz: 1, spin: Math.PI / 2 },    // 上家 left rim
    };
    const MS = 0.72, step = 0.95 * MS, meldGap = 0.5 * MS;
    const RIM_Y = (TD / 2) * MS - 0.1;   // rest on the rim (slightly below the felt)
    const kongSeen = new Set();
    // 吃/碰/杠 demo pose: the just-claimed meld lifts to a camera-facing row above
    // the claiming seat for CLAIM_DEMO_MS, then settles into the flat row.
    const demoActive = this.claimDemo && (performance.now() - this.claimDemo.t0 < this.claimDemo.ms);
    const DEMO_STEP = TW * DEMO_SCALE * 1.05;
    for (let p = 0; p < 4; p++) {
      const melds = game.melds[p];
      if (!melds.length) continue;
      const c = cfg[p];
      const tiles = [], ranges = [];
      melds.forEach((m, mi) => {
        const start = tiles.length;
        (m.tiles || []).forEach((k, j) => tiles.push({ kind: k, first: j === 0 }));
        ranges.push({ m, mi, start, end: tiles.length - 1 });
      });
      const pos = []; let cur = 0;
      tiles.forEach((t, i) => { cur += (i === 0 ? 0 : step) + (t.first && i ? meldGap : 0); pos.push(cur); });
      const span = cur;
      const lastMi = ranges.length - 1;
      const demoOn = demoActive && this.claimDemo.player === p;
      const meldOf = []; // flat tile index → which meld it belongs to + its position in it
      ranges.forEach((r) => { const n = r.end - r.start + 1; for (let j = 0; j < n; j++) meldOf[r.start + j] = { mi: r.mi, j, n }; });
      tiles.forEach((t, i) => {
        const off = pos[i] - span / 2;
        const mo = meldOf[i];
        let claim = null;
        if (demoOn && mo.mi === lastMi) {
          const dc = DEMO_POS[p] || DEMO_POS[2];
          claim = { t0: this.claimDemo.t0, ms: this.claimDemo.ms, demo: { x: dc.x + (mo.j - (mo.n - 1) / 2) * DEMO_STEP, y: dc.y, z: dc.z, s: DEMO_SCALE, rx: this.faceCamRx } };
        }
        this._place(`m${p}_${i}`, {
          kind: t.kind, scale: MS, from: this._seatCenter(p),
          x: c.cx + c.dx * off, y: RIM_Y, z: c.cz + c.dz * off, rx: -Math.PI / 2, ry: 0, rz: c.spin,
          claim,
        }, seen);
      });
      for (const r of ranges) if (r.m.type === 'kong' && !(demoOn && r.mi === lastMi)) this._kongBound(game, c, r, pos, span, MS, RIM_Y, kongSeen, p);
    }
    for (const [key, kb] of this.kongBounds) {
      if (!kongSeen.has(key)) { this.scene.remove(kb.box, kb.label); this.kongBounds.delete(key); }
    }
  }

  // A coloured wireframe box + corner label (明杠 yellow / 暗杠 red / 金杠 gold)
  // enclosing a 杠's four flat tiles. The row runs along the seat's c.dx / c.dz axis, so
  // the box is axis-aligned — no rotation needed.
  _kongBound(game, c, r, pos, span, MS, RIM_Y, kongSeen, p) {
    const key = `${p}_${r.mi}`;
    kongSeen.add(key);
    const o0 = pos[r.start] - span / 2, o1 = pos[r.end] - span / 2;
    const centerOff = (o0 + o1) / 2;
    const rowLen = (o1 - o0) + TW * MS + 0.1;
    const perp = TH * MS + 0.07, up = TD * MS + 0.07;
    const cx = c.cx + c.dx * centerOff, cz = c.cz + c.dz * centerOff;
    let kb = this.kongBounds.get(key);
    if (!kb) {
      const gold = game.isWild(r.m.kind), concealed = !!r.m.concealed;
      const kind = gold ? '金杠' : concealed ? '暗杠' : '明杠';
      // 金杠 gold · 暗杠 red · 明杠 yellow — the same hue tints both the wireframe border box and its label.
      const col = gold ? 0xffce4d : concealed ? 0xe23b1f : 0xffe23f;
      const txt = gold ? '#ffe08a' : concealed ? '#ff9a8a' : '#fff36b';
      const box = new THREE.LineSegments(this.kongBoxGeo, new THREE.LineBasicMaterial({ color: col }));
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeKongLabel(kind, txt), transparent: true }));
      label.scale.set(0.6, 0.3, 1);
      this.scene.add(box, label);
      kb = { box, label };
      this.kongBounds.set(key, kb);
    }
    kb.box.position.set(cx, RIM_Y, cz);
    kb.box.scale.set(c.dx ? rowLen : perp, up, c.dz ? rowLen : perp);
    kb.label.position.set(cx - c.dx * rowLen / 2, RIM_Y + up / 2 + 0.22, cz - c.dz * rowLen / 2);
  }

  // Remove every 杠 box + label from the scene (e.g. at the start of a new deal, so last
  // hand's 杠 indicators don't hang on the table while the new hand is being dealt).
  _clearKongBounds() {
    for (const [, kb] of this.kongBounds) this.scene.remove(kb.box, kb.label);
    this.kongBounds.clear();
  }

  // Lay items in a line along cfg's edge, centered, scaled uniformly so the row
  // fits within ±maxHalf (so it never reaches a neighbouring seat's row).
  _placeRow(items, cfg, maxHalf, seen) {
    const pos = [];
    let cursor = 0;
    items.forEach((it, i) => { cursor += (i === 0 ? 0 : GAP) + (it.gapBefore || 0); pos.push(cursor); });
    const span = cursor;
    // Scale to a fixed reference width when given (the hand), so tile size stays
    // constant as the count/gap changes (e.g. drawing the 14th tile) — only the
    // row's total width changes, not the tiles. Falls back to fit-to-span.
    const ref = cfg.refSpan ? Math.max(cfg.refSpan, span) : span;
    const s = Math.min(1, (2 * maxHalf) / Math.max(ref, 0.001));
    items.forEach((it, i) => {
      const off = (pos[i] - span / 2) * s;
      // flat rows (听牌 hand, laid like melds) rest on their thickness, not their height
      const x = cfg.cx + cfg.dx * off, baseY = (cfg.flat ? TD / 2 : TH / 2) * s;
      const lift = it.selected ? 0.55 * s : 0;
      const z = cfg.cz + cfg.dz * off + (it.selected ? cfg.pull : 0);
      this._place(it.key, {
        kind: it.kind, wild: it.wild, pick: it.pick, emissive: it.emissive, scale: s,
        x, y: baseY + lift, z, rx: it.selected && !cfg.flat ? this.faceCamRx : cfg.rx, ry: cfg.ry, rz: it.rz || 0,
        from: it.from, fromScale: it.fromScale, draw: it.draw, gate: it.gate,
      }, seen);
      if (it.selected) this.selKey = it.key;
    });
    return s;
  }

  // Project a world point to canvas-local CSS pixels. The claim HUD lives in the
  // same box as the canvas (and is moved by the page's force-landscape transform
  // along with it), so local coords are correct in both orientations — and this
  // also drops a stale header-height offset the old viewport-based math carried.
  worldToScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-v.y * 0.5 + 0.5) * this.canvas.clientHeight };
  }

  // The face-down deck wall: a 2-layer ring of backs around the pool that depletes
  // as the live wall is drawn down. Sets this.deckPos = the current draw point (in
  // front, where new draws fly from). Rendered before the hands so they read it.
  // Geometry of the two side walls (left + right). The front (player) side AND the
  // top (对家) side are kept clear — the top so 对家's called melds show there in the
  // camera's view (see _meldsFlat). Slot 0 is front-left; the live draw end is the
  // last slot (front-right). Shared by _wall and the deal's draw-point walk.
  _wallSlotGeometry() {
    const WW = 0.54, h = R_WALL;
    const perSide = Math.max(2, Math.floor((2 * h) / WW));
    const cell = (2 * h) / perSide;
    const at = (i) => -h + (i + 0.5) * cell;          // centre of slot i along a side
    const slots = [];
    for (let i = 0; i < perSide; i++) slots.push({ x: -h, z: -at(i), spin: Math.PI / 2 });  // left: front → back
    for (let i = 0; i < perSide; i++) slots.push({ x: h, z: at(i), spin: Math.PI / 2 });     // right: back → front
    const yBot = (TD / 2) * WW - 0.05, yTop = yBot + TD * WW;
    return { slots, WW, yBot, yTop };
  }

  _wall(game, seen, wallCount = game.wall.length) {
    const { slots, WW, yBot, yTop } = this._wallSlotGeometry();
    const nStacks = Math.min(slots.length, Math.ceil(wallCount / 2));
    for (let s = 0; s < nStacks; s++) {
      const c = slots[s];
      this._place('wb' + s, { kind: null, scale: WW, x: c.x, y: yBot, z: c.z, rx: -Math.PI / 2, ry: 0, rz: c.spin }, seen);
      if (wallCount - s * 2 >= 2) // odd remainder → last stack has no top tile
        this._place('wt' + s, { kind: null, scale: WW, x: c.x, y: yTop, z: c.z, rx: -Math.PI / 2, ry: 0, rz: c.spin }, seen);
    }
    const live = slots[Math.max(0, nStacks - 1)];
    this.deckPos = new THREE.Vector3(live.x, yTop + 0.25, live.z);
  }

  // The deal's "reserve": the front (player) and top (对家) edges of the wall,
  // which sync() keeps clear. These hold exactly the tiles to be dealt — each
  // served tile is a real reserve tile that leaves the wall (the reserve depletes
  // in consume order, two tiles per stack). The permanent left+right wall (the
  // tiles that remain after the deal) is the same one sync() renders, so the
  // hand-off needs no wall transition. Positions are listed in consume order.
  _buildDealReserve(total) {
    const { WW, yBot, yTop } = this._wallSlotGeometry();
    const h = R_WALL;
    const perSide = Math.max(2, Math.floor((2 * h) / WW));
    const cell = (2 * h) / perSide;
    const at = (i) => -h + (i + 0.5) * cell;
    const R = [];
    const stack = (x, z) => { R.push({ x, y: yTop, z, spin: 0 }); R.push({ x, y: yBot, z, spin: 0 }); };
    for (let i = perSide - 1; i >= 0; i--) stack(at(i), h);   // front edge, right → left
    for (let i = 0; i < perSide; i++) stack(at(i), -h);       // top edge, left → right
    return R.slice(0, total);
  }
  // Render the not-yet-dealt reserve tiles (face-down backs). Consumed ones fall
  // out of `seen` and are removed, so the reserve visibly shrinks as it's dealt.
  _dealReserve(seen) {
    const d = this.deal, { WW } = this._wallSlotGeometry();
    for (let i = d.served; i < d.reserve.length; i++) {
      const c = d.reserve[i];
      this._place('dr' + i, { kind: null, scale: WW, x: c.x, y: c.y, z: c.z, rx: -Math.PI / 2, ry: 0, rz: c.spin }, seen);
    }
  }

  _pool(game, seen, revealIdx = -1) {
    const log = game.discardLog;
    const POOL = 0.55;                      // discards are smaller than hands (30% bigger than before)
    const subGap = 0.58, typeGap = 0.2;     // within-type subcolumn / between-type spacing
    const rowGap = 0.8;                     // rows pile from the player side toward the opposite
    const zFront = 4.0;                     // first (bottom) row sits near the player; rows grow toward -z
    // Each suit is a type-column (万 筒 条 字, left→right). Within a type, every row
    // holds 4 subcolumns; tiles are ordered by card id (rank), filling left→right
    // then front (player) → back (opposite). Mesh keys stay tied to the discard's
    // log index, so a tile slotting into sorted order just animates over.
    const typeWidth = 4 * subGap;
    const totalWidth = 4 * typeWidth + 3 * typeGap;
    const colOf = (kind) => {
      const s = suitOf(kind);
      return s === 'm' ? 0 : s === 'p' ? 1 : s === 's' ? 2 : 3;
    };
    // A bot's discard flying via the center halt (beginDiscardDemo) — it animates to
    // its pool slot, so it's NOT pulled out as a pending tile while the demo runs.
    const dd = this.discardDemo;
    const demoIdx = (dd && performance.now() - dd.t0 < dd.ms) ? dd.idx : -1;
    // The just-discarded tile that YOU can claim (碰/杠/胡) is pulled out of the grid
    // and shown big/upright, front-center, so the choice is obvious.
    const pendingIdx = this.claimable && log.length ? log.length - 1 : -1;
    if (pendingIdx >= 0) {
      const d = log[pendingIdx];
      const pos = { x: 0, y: TH * 0.9, z: 2.6 }, scale = 1.5;
      this._place('pool' + pendingIdx, {
        kind: d.kind, wild: game.isWild(d.kind), emissive: true, scale, from: this._seatCenter(d.player),
        x: pos.x, y: pos.y, z: pos.z, rx: this.faceCamRx, ry: 0, rz: 0, // face squarely toward the camera
      }, seen);
      this.pendingClaim = { player: d.player, pos, scale }; // for the "where from" arrow overlay
    } else {
      this.pendingClaim = null;
    }
    // Bucket the remaining discards by suit, then order each column by card id.
    const byType = [[], [], [], []];
    log.forEach((d, i) => { if (i !== pendingIdx) byType[colOf(d.kind)].push({ i, kind: d.kind, player: d.player }); });
    for (const list of byType) list.sort((a, b) => a.kind - b.kind || a.i - b.i);
    for (let tc = 0; tc < 4; tc++) {
      byType[tc].forEach((t, k) => {
        const sub = k % 4, row = Math.floor(k / 4);
        const x = -totalWidth / 2 + tc * (typeWidth + typeGap) + (sub + 0.5) * subGap;
        const z = zFront - row * rowGap;
        // The 听牌 tsumogiri tile gets the full draw reveal: deck → big in the centre
        // (facing camera) → its pool slot, so you see what was drawn before it lands.
        // Other discards rise up into the pool from their player's side of the table.
        const reveal = t.i === revealIdx;
        const isDemo = t.i === demoIdx;
        const from = reveal ? this.deckPos
          : isDemo ? this._seatCenter(t.player)
          : t.player === 0 ? new THREE.Vector3(x, TH * 0.35, R_HAND + 0.4)
          : this._seatCenter(t.player);
        const dc = isDemo ? (DEMO_POS[t.player] || DEMO_POS[2]) : null;
        this._place('pool' + t.i, {
          kind: t.kind, wild: game.isWild(t.kind), emissive: false, scale: POOL, from, draw: reveal && !isDemo,
          discard: isDemo ? { t0: dd.t0, ms: dd.ms, demo: { x: dc.x, y: dc.y, z: dc.z, s: DEMO_SCALE, rx: this.faceCamRx } } : null,
          x, y: (TD / 2) * POOL, z, rx: -Math.PI / 2, ry: 0,
        }, seen);
      });
    }
  }

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const rx = clientX - rect.left, ry = clientY - rect.top;
    // When the page is rotated 90° CW (force-landscape on portrait), the canvas's
    // bbox is the rotated rectangle, so map viewport→NDC through the rotation.
    const v = this.rotated
      ? new THREE.Vector2((ry / rect.height) * 2 - 1, (rx / rect.width) * 2 - 1)
      : new THREE.Vector2((rx / rect.width) * 2 - 1, -((ry / rect.height) * 2 - 1));
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

  // The human draw reveal: deck (flat) → big in the centre facing the camera (hold)
  // → the tile's slot in the hand. Drives the mesh directly; returns false (and
  // clears the sequence) once finished, so normal lerp takes over. tp/ts/trx are
  // read live, so the slot stays correct even as the hand reflows.
  _animateDraw(rec, m) {
    const d = rec.drawSeq, t = (performance.now() - d.t0) / 1000;
    // keyframes: [time, x, y, z, scale, rx]; at the centre the face squarely faces
    // the camera (faceCamRx), not just standing upright.
    const C = [0, TH * 1.35, 3.0, 1.7, this.faceCamRx];
    const kf = [
      [0.00, d.deck.x, d.deck.y, d.deck.z, rec.ts, -Math.PI / 2],
      [0.42, C[0], C[1], C[2], C[3], C[4]],
      [0.95, C[0], C[1], C[2], C[3], C[4]],
      [1.45, rec.tp.x, rec.tp.y, rec.tp.z, rec.ts, rec.trx],
    ];
    if (t >= kf[kf.length - 1][0]) {
      delete rec.drawSeq;
      // gated (hand) reveal finished → unblock input and tell the caller it settled
      if (rec.gate) { rec.gate = false; this.handDrawRevealing = false; this.onHandDrawSettled && this.onHandDrawSettled(); }
      return false;
    }
    let i = 0; while (i < kf.length - 1 && t > kf[i + 1][0]) i++;
    const A = kf[i], B = kf[i + 1];
    let u = (t - A[0]) / (B[0] - A[0]); u = u * u * (3 - 2 * u); // smoothstep
    const lp = (j) => A[j] + (B[j] - A[j]) * u;
    m.position.set(lp(1), lp(2), lp(3));
    m.scale.setScalar(lp(4));
    m.rotation.set(lp(5), 0, 0);
    return true;
  }

  // A bot's claimed meld (吃/碰/杠) OR a discard: rise from the seat to a camera-facing
  // center pose, hold, then either release to the normal lerp (claim → meld settles into
  // the flat row) or, when `seq.drop` is set (discards), run an explicit DROP phase from
  // the center pose down into the pool slot (rec.tp) over that fixed duration.
  // `seq` = { t0, ms, demo:{x,y,z,s,rx}, from, rx0, rz0, drop? }.
  _animateDemoSeq(seq, rec, m) {
    const t = (performance.now() - seq.t0) / 1000;
    const RISE = 0.4, HOLD_END = (seq.ms ?? CLAIM_DEMO_MS) / 1000;
    const DROP = seq.drop ? seq.drop / 1000 : 0;
    if (t >= HOLD_END + DROP) return false;
    const dm = seq.demo;
    if (t < RISE) {
      let u = t / RISE; u = u * u * (3 - 2 * u); // smoothstep
      m.position.set(seq.from.x + (dm.x - seq.from.x) * u, seq.from.y + (dm.y - seq.from.y) * u, seq.from.z + (dm.z - seq.from.z) * u);
      m.scale.setScalar((rec.ts ?? 1) + (dm.s - (rec.ts ?? 1)) * u);
      m.rotation.set(seq.rx0 + (dm.rx - seq.rx0) * u, 0, seq.rz0 * (1 - u));
    } else if (t < HOLD_END || DROP === 0) {
      m.position.set(dm.x, dm.y, dm.z);
      m.scale.setScalar(dm.s);
      m.rotation.set(dm.rx, 0, 0);
    } else { // DROP: center pose → pool slot (fast, half the old settle)
      let u = (t - HOLD_END) / DROP; u = u * u * (3 - 2 * u);
      const ts = rec.ts ?? 1;
      m.position.set(dm.x + (rec.tp.x - dm.x) * u, dm.y + (rec.tp.y - dm.y) * u, dm.z + (rec.tp.z - dm.z) * u);
      m.scale.setScalar(dm.s + (ts - dm.s) * u);
      m.rotation.set(dm.rx + (rec.trx - dm.rx) * u, 0, 0);
    }
    return true;
  }

  _loop() {
    const tick = () => {
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const a = 1 - Math.exp(-13 * dt);
      if (this.deal) this._dealTick(); // advance the initial-deal flourish
      for (const rec of this.tiles.values()) {
        const m = rec.mesh;
        const ts = rec.ts ?? 1;
        if (rec.drawSeq && this._animateDraw(rec, m)) continue; // reveal in progress
        if (rec.claimSeq) { if (this._animateDemoSeq(rec.claimSeq, rec, m)) continue; delete rec.claimSeq; } // 吃/碰/杠 demo
        if (rec.discardSeq) { if (this._animateDemoSeq(rec.discardSeq, rec, m)) continue; delete rec.discardSeq; } // discard fly
        m.scale.setScalar(m.scale.x + (ts - m.scale.x) * a); // grow in + match target scale
        m.position.lerp(rec.tp, a);
        m.rotation.x += (rec.trx - m.rotation.x) * a;
        m.rotation.y += (rec.try_ - m.rotation.y) * a;
        m.rotation.z += ((rec.trz || 0) - m.rotation.z) * a;
      }
      // selection outline rides the selected tile's (animated) transform
      const selRec = this.selKey && this.tiles.get(this.selKey);
      this.outline.visible = !!selRec;
      if (selRec) {
        this.outline.position.copy(selRec.mesh.position);
        this.outline.quaternion.copy(selRec.mesh.quaternion);
        this.outline.scale.copy(selRec.mesh.scale);
        this.outlineHalo.material.opacity = 0.34 + 0.16 * Math.sin(performance.now() / 360); // gentle glow
      }
      // the turn-ring rotates (shortest path) to the active seat and pulses
      if (this._turnRingActive >= 0 && this.turnRing) {
        const target = this._turnSpin[this._turnRingActive];
        let d = target - this.turnRing.rotation.z;
        d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest signed delta
        this.turnRing.rotation.z += d * a;
        this.turnRing.material.opacity = 0.55 + 0.35 * Math.sin(performance.now() / 320);
      }
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
