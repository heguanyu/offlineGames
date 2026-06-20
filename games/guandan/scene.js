// 3D poker table for 掼蛋, on the same locally-vendored three.js as the mahjong/斗地主 games
// (offline, no CDN). Cards are thin rounded boxes whose faces are drawn to a canvas and used as
// textures, so there are zero binary art assets. Meshes are persistent + keyed by a stable id;
// sync() diffs the desired layout and an animation loop eases each card toward its target, so
// selection lifts, hand reflow, and cards sliding to the centre come for free.
//
// FOUR seats (vs 斗地主's three): 0 bottom (you), 1 right, 2 top (your partner), 3 left.
// Turn order 0→1→2→3 clockwise. The ♥-level wildcards glow purple so you can spot 逢人配 at a glance.
import * as THREE from '../mahjong-tianjin/lib/three.module.min.js';
import { rankLabel, isWild } from './engine.js';

const CW = 1.0, CH = 1.45, CD = 0.014;
const FELT = 16;
const HAND_Y = 0.62;
const OPP_Y = 1.4;
const SUIT_CHAR = ['♠︎', '♥︎', '♣︎', '♦︎'];
const SUIT_RED = [false, true, false, true];

// Seat anchors (world). 0 bottom, 1 right, 2 top, 3 left.
const SEAT_ANCHOR = [
  new THREE.Vector3(0, 0, 7.6), new THREE.Vector3(9.0, 0, 0),
  new THREE.Vector3(0, 0, -7.0), new THREE.Vector3(-9.0, 0, 0),
];
const PLAY_SPOT = [
  new THREE.Vector3(0, 0, 3.0), new THREE.Vector3(3.7, 0, 0.2),
  new THREE.Vector3(0, 0, -2.7), new THREE.Vector3(-3.7, 0, 0.2),
];

// ---- card faces ------------------------------------------------------------
const faceCache = new Map();
let backTex = null;
const keyOf = (card, wild) => (card.rank >= 16 ? 'J' + card.rank : card.rank + '_' + card.suit) + (wild ? 'W' : '');

function rr(x, X, Y, W, H, r) {
  x.beginPath(); x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath();
}
function drawCardFace(c, card, wild) {
  const x = c.getContext('2d'); const W = c.width, H = c.height;
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  const RED = '#d11414', BLACK = '#101014';
  if (card.rank >= 16) {
    const red = card.rank === 17;
    x.fillStyle = red ? RED : BLACK;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '900 72px sans-serif'; x.fillText('★', W / 2, H * 0.28);
    x.font = '900 58px -apple-system,"PingFang SC",sans-serif';
    x.fillText(red ? '大' : '小', W / 2, H * 0.52);
    x.fillText('王', W / 2, H * 0.67);
    x.font = '800 32px sans-serif'; x.fillText('JOKER', W / 2, H * 0.85);
  } else {
    const lbl = rankLabel(card.rank), suit = SUIT_CHAR[card.suit], red = SUIT_RED[card.suit];
    x.fillStyle = red ? RED : BLACK;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const mx = 52, my = 54;
    const drawIndex = () => {
      x.font = '900 62px Arial, system-ui, sans-serif'; x.fillText(lbl, mx, my);
      x.font = '900 42px sans-serif'; x.fillText(suit, mx, my + 46);
    };
    drawIndex();
    x.font = '900 168px sans-serif'; x.fillText(suit, W / 2, H * 0.55);
    x.save(); x.translate(W, H); x.rotate(Math.PI); drawIndex(); x.restore();
  }
  if (wild) {                                    // 逢人配 — a purple banner so the wildcard stands out
    x.fillStyle = 'rgba(150,70,210,0.92)';
    rr(x, W / 2 - 64, H - 70, 128, 46, 16); x.fill();
    x.fillStyle = '#fff'; x.font = '800 30px -apple-system,"PingFang SC",sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('百搭', W / 2, H - 46);
  }
}
function cardTexture(card, wild) {
  const key = keyOf(card, wild);
  if (faceCache.has(key)) return faceCache.get(key);
  const c = document.createElement('canvas'); c.width = 256; c.height = 360;
  drawCardFace(c, card, wild);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  faceCache.set(key, t); return t;
}
function backTexture() {
  if (backTex) return backTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 360;
  const x = c.getContext('2d'); const W = c.width, H = c.height;
  x.fillStyle = '#fbfaf5'; rr(x, 2, 2, W - 4, H - 4, 26); x.fill();
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1f5fae'); g.addColorStop(1, '#0d2f63');
  x.save(); rr(x, 14, 14, W - 28, H - 28, 18); x.clip();
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(255,255,255,0.18)'; x.lineWidth = 3;
  for (let i = -H; i < W; i += 18) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + H, H); x.stroke(); }
  x.restore();
  x.fillStyle = '#f3d785'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '900 64px -apple-system,"PingFang SC",sans-serif'; x.fillText('掼', W / 2, H / 2);
  backTex = new THREE.CanvasTexture(c); backTex.colorSpace = THREE.SRGBColorSpace; backTex.anisotropy = 4;
  return backTex;
}
const TEX = (file, srgb, rep) => {
  const t = new THREE.TextureLoader().load(new URL(`../mahjong-tianjin/textures/${file}`, import.meta.url).href);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
};
function feltColorTexture() {
  const N = 1024, c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d');
  x.fillStyle = '#247c57'; x.fillRect(0, 0, N, N);
  for (let i = 0; i < 60; i++) {
    const cx = Math.random() * N, cy = Math.random() * N, r = 140 + Math.random() * 320;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, Math.random() < 0.5 ? 'rgba(90,180,135,0.09)' : 'rgba(18,72,50,0.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, N, N);
  }
  const im = x.getImageData(0, 0, N, N), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() + Math.random() + Math.random() - 1.5) * 13; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function feltMaterial() {
  return new THREE.MeshStandardMaterial({ map: feltColorTexture(), normalMap: TEX('felt_normal.jpg', false, 4),
    roughnessMap: TEX('felt_rough.jpg', false, 4), color: 0xffffff, roughness: 1.0, metalness: 0.0, normalScale: new THREE.Vector2(0.5, 0.5) });
}
function woodMaterial() {
  return new THREE.MeshStandardMaterial({ map: TEX('wood_color.jpg', true, 3), normalMap: TEX('wood_normal.jpg', false, 3),
    roughnessMap: TEX('wood_rough.jpg', false, 3), color: 0xddc7ad, roughness: 0.82, metalness: 0.0, normalScale: new THREE.Vector2(0.6, 0.6) });
}
function roundedCardGeo() {
  const w = CW, h = CH, r = Math.min(w, h) * 0.095;
  const x0 = -w / 2, y0 = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const geo = new THREE.ExtrudeGeometry(s, { depth: CD, bevelEnabled: false, steps: 1, curveSegments: 6 });
  geo.center();
  const pos = geo.attributes.position, nrm = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nrm.getZ(i)) > 0.5) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  }
  uv.needsUpdate = true;
  geo.clearGroups();
  const triN = pos.count / 3;
  const triMat = (t) => { const nz = nrm.getZ(t * 3); return nz > 0.5 ? 0 : nz < -0.5 ? 1 : 2; };
  let runStart = 0, runMat = triMat(0);
  for (let t = 1; t <= triN; t++) {
    const m = t < triN ? triMat(t) : -1;
    if (m !== runMat) { geo.addGroup(runStart * 3, (t - runStart) * 3, runMat); runStart = t; runMat = m; }
  }
  return geo;
}

export class GuandanScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1f17);
    this.camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
    this.camBase = new THREE.Vector3(0, 13.6, 14.8);
    this.camLook = new THREE.Vector3(0, -1.0, 0.3);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.camLook);
    this.faceCamRx = -Math.atan2(this.camBase.y - HAND_Y, this.camBase.z - 7.1);

    this.level = 2;
    this._lights(); this._table(); this._turnRing();
    this.geo = roundedCardGeo();
    this.sideMat = new THREE.MeshStandardMaterial({ color: 0xece9df, roughness: 0.85 });

    this.cards = new Map();
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.rotated = false;
    this._fx = [];
    this._shake = null;
    this._camPos = this.camBase.clone();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._loop();
    this._warmFaces();
  }

  setRotated(r) { this.rotated = !!r; }
  setLevel(l) { this.level = l; }
  resize() { this._resize(); }

  // Pre-rasterise + GPU-upload every card face up front, so the first deal doesn't hitch lazily
  // generating ~27 face canvases on a slow CPU (the 1–2s "card image loading" stall). Spread over
  // ticks so startup stays responsive; by the time 开始 is tapped the cache + GPU are warm.
  _warmFaces() {
    const jobs = [];
    for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) jobs.push([{ rank: r, suit: s }, false]);
    for (let r = 2; r <= 14; r++) jobs.push([{ rank: r, suit: 1 }, true]); // ♥-level 百搭 wild faces (any level)
    jobs.push([{ rank: 16, suit: -1 }, false], [{ rank: 17, suit: -1 }, false]);
    this._uploadTex(backTexture());
    let i = 0;
    const tick = () => {
      for (let n = 0; i < jobs.length && n < 6; i++, n++) this._uploadTex(cardTexture(jobs[i][0], jobs[i][1]));
      if (i < jobs.length) setTimeout(tick, 16);
    };
    tick();
  }
  _uploadTex(t) { try { this.renderer.initTexture(t); } catch {} } // initTexture may be absent in old three — canvas is still pre-drawn

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xcfe9df, 0x223026, 1.0));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.1);
    key.position.set(0, 17, 4); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 13; Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 46 });
    key.shadow.bias = -0.0004; this.scene.add(key);
  }
  // One glowing 90° arc on the felt, rotated to point at whichever seat's turn it is, pulsing.
  _turnRing() {
    const R = 4.7;
    const geo = new THREE.RingGeometry(R - 0.22, R + 0.22, 48, 1, -Math.PI / 4, Math.PI / 2); // 90° centered on +X
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    this.turnRing = new THREE.Mesh(geo, mat);
    this.turnRing.rotation.set(-Math.PI / 2, 0, 0);
    this.turnRing.position.set(0, 0.03, 0);
    this.turnRing.visible = false;
    this.scene.add(this.turnRing);
    this._turnSpin = SEAT_ANCHOR.map((a) => Math.atan2(-a.z, a.x));
    this._turnRingActive = -1;
  }
  _table() {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(FELT / 2 + 1.1, FELT / 2 + 1.1, 0.7, 64), woodMaterial());
    rim.position.y = -0.45; rim.receiveShadow = true; this.scene.add(rim);
    const felt = new THREE.Mesh(new THREE.CylinderGeometry(FELT / 2, FELT / 2, 0.5, 64), feltMaterial());
    felt.position.y = -0.26; felt.receiveShadow = true; this.scene.add(felt);
  }

  _makeMesh(faceCard, wild) {
    const front = faceCard ? new THREE.MeshStandardMaterial({ map: cardTexture(faceCard, wild), roughness: 0.55, emissive: 0x3a3a3a, emissiveMap: cardTexture(faceCard, wild), emissiveIntensity: 0.6 })
      : new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.6 });
    const back = new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.6 });
    const mats = [front, back, this.sideMat];
    const mesh = new THREE.Mesh(this.geo, mats);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  // Compose the desired layout from a plain view and ease meshes toward it. view:
  //   { hand:[card], selected:Set, hint:Set, counts:[4], turn, leadSeat, phase,
  //     table:[{seat, cards:[card]}], discard:[card], revealHands:{seat:[card]}|null }
  sync(view) {
    const want = new Map();
    const flatUp = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const lv = this.level;

    // human hand — overlapping row along the bottom edge, tilted up to face the camera
    const hand = view.hand || [];
    const n = hand.length;
    const step = Math.min(0.52, n > 1 ? 12.4 / (n - 1) : 0);
    const x0 = -step * (n - 1) / 2;
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.faceCamRx, 0, 0));
    const cardUp = new THREE.Vector3(0, 1, 0).applyQuaternion(tilt);
    hand.forEach((card, i) => {
      const sel = view.selected && view.selected.has(card.id);
      const hint = view.hint && view.hint.has(card.id);
      const wild = isWild(card, lv);
      const z = 7.1 + i * 0.004;
      const pos = new THREE.Vector3(x0 + i * step, HAND_Y, z);
      if (sel) pos.addScaledVector(cardUp, 1.1);
      want.set('c' + card.id, { faceCard: card, wild, pos, quat: tilt, scale: 1.06, pick: true, id: card.id, hint, sel });
    });

    const flatDown = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));

    if (this.turnRing) {
      const ts = (view.turn != null && view.phase === 'play') ? view.turn : -1;
      this._turnRingActive = ts;
      this.turnRing.visible = ts >= 0;
    }

    // current plays on the felt, one cluster per seat. The lead-owning play is scaled up.
    for (const t of (view.table || [])) {
      const spot = PLAY_SPOT[t.seat]; const m = t.cards.length;
      const isCurrent = t.seat === view.leadSeat;
      const sc = isCurrent ? 1.5 : 1.05;
      const horizontal = t.seat === 0 || t.seat === 2;
      const cs = Math.min(0.46 * sc, m > 1 ? 2.5 * sc / (m - 1) : 0);
      const span = cs * (m - 1);
      const from = SEAT_ANCHOR[t.seat].clone().setY(1.1);
      t.cards.forEach((card, i) => {
        const off = -span / 2 + i * cs;
        const pos = horizontal ? new THREE.Vector3(spot.x + off, 0.06 + i * 0.004, spot.z)
          : new THREE.Vector3(spot.x, 0.06 + i * 0.004, spot.z + off);
        want.set('c' + card.id, { faceCard: card, wild: isWild(card, lv), pos, quat: flatUp, scale: sc, from });
      });
    }

    // opponents' hands — face-down cards near each seat (backs to us). The TOP seat (2) fans
    // HORIZONTALLY; the SIDE seats (1 right, 3 left) stack VERTICALLY along the table depth so they
    // hug the edge and don't block the play area (like mahjong's 上下家 rows). The numeric "N 张"
    // nameplate keeps the count explicit. Game over flips them to their real faces.
    for (const seat of [1, 2, 3]) {
      const reveal = view.revealHands && view.revealHands[seat];
      const cnt = reveal ? reveal.length : (view.counts || [0, 0, 0, 0])[seat];
      const a = SEAT_ANCHOR[seat];
      const side = seat !== 2;
      for (let i = 0; i < cnt; i++) {
        const t = cnt > 1 ? (i / (cnt - 1) - 0.5) : 0;
        let pos, quat;
        if (side) {
          const dir = seat === 1 ? 1 : -1;                 // right / left
          const cs = Math.min(0.24, cnt > 1 ? 6.0 / (cnt - 1) : 0);
          const z = -cs * (cnt - 1) / 2 + i * cs;          // run front→back along the table depth
          quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, -dir * 0.5, 0)); // upright, turned toward centre
          pos = new THREE.Vector3(a.x * 0.82, OPP_Y + i * 0.004, z);
        } else {
          const cs = Math.min(0.26, cnt > 1 ? 5.6 / (cnt - 1) : 0);
          quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0, -t * 0.32)); // horizontal fan
          pos = new THREE.Vector3(-cs * (cnt - 1) / 2 + i * cs, OPP_Y + i * 0.004, a.z * 0.66 + 0.5);
        }
        const face = reveal ? reveal[i] : null;
        const key = reveal ? 'c' + reveal[i].id : `b${seat}_${i}`;
        want.set(key, { faceCard: face, wild: face ? isWild(face, lv) : false, pos, quat, scale: side ? 1.1 : 1.2 });
      }
    }

    // discard pile — cards from completed tricks lie FACE-DOWN, scattered in the middle.
    if (view.discard) {
      view.discard.forEach((card, i) => {
        const jx = (((card.id * 37) % 100) / 100 - 0.5) * 2.0;
        const jz = (((card.id * 61) % 100) / 100 - 0.5) * 1.4;
        const rot = (((card.id * 53) % 100) / 100 - 0.5) * 0.9;
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot).multiply(flatDown);
        want.set('c' + card.id, { faceCard: card, wild: false, pos: new THREE.Vector3(jx, 0.04 + i * 0.002, -0.6 + jz), quat, scale: 0.6 });
      });
    }

    // diff
    for (const key of [...this.cards.keys()]) if (!want.has(key)) { const r = this.cards.get(key); this.group.remove(r.mesh); this.cards.delete(key); }
    for (const [key, d] of want) {
      let r = this.cards.get(key);
      if (!r) {
        const atDeck = this._deal && this._deal.active && this._deal.serveAt.has(key);
        r = { mesh: this._makeMesh(d.faceCard, d.wild), id: d.id, pick: d.pick, key };
        r.mesh.position.copy(atDeck ? this._deal.deck : (d.from || d.pos)); r.mesh.quaternion.copy(atDeck ? this._deal.quat : d.quat);
        this.cards.set(key, r);
      }
      r.target = d; r.id = d.id; r.pick = d.pick;
      if (r.mesh.material[0] && r.mesh.material[0].emissiveMap) {
        r.mesh.material[0].emissive.setHex(d.sel ? 0x6a5616 : d.hint ? 0x2a5d3a : d.wild ? 0x4a2168 : 0x3a3a3a);
      }
    }
  }

  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  }
  seatScreen(seat, y = 1.2) { return this.worldToScreen(SEAT_ANCHOR[seat].clone().setY(y)); }

  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    let px = clientX - r.left, py = clientY - r.top;
    if (this.rotated) { const t = px; px = py; py = r.width - t; }
    const nx = (px / r.width) * 2 - 1, ny = -(py / r.height) * 2 + 1;
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const meshes = [...this.cards.values()].filter((c) => c.pick).map((c) => c.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    for (const c of this.cards.values()) if (c.mesh === hit.object) return c.id;
    return null;
  }

  _resize() {
    const el = this.canvas.parentElement; const w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    const k = Math.max(1, (h / w) / 0.62);
    this._camPos = this.camBase.clone().multiplyScalar(k > 1 ? 1 + (k - 1) * 0.5 : 1);
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
  }
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(0.05, this.clock.getDelta());
    const a = 1 - Math.pow(0.0015, dt);
    const now = performance.now();
    const dealing = this._deal && this._deal.active;
    for (const r of this.cards.values()) {
      if (!r.target) continue;
      if (dealing && r.key && this._deal.serveAt.has(r.key) && now < this._deal.serveAt.get(r.key)) {
        const s = Math.min((this._deal.idx.get(r.key) || 0), 60) * 0.004;
        r.mesh.position.set(this._deal.deck.x, this._deal.deck.y + s, this._deal.deck.z);
        r.mesh.quaternion.copy(this._deal.quat);
        continue;
      }
      r.mesh.position.lerp(r.target.pos, a);
      r.mesh.quaternion.slerp(r.target.quat, a);
      const s = r.target.scale; r.mesh.scale.lerp(new THREE.Vector3(s, s, s), a);
    }
    if (this._turnRingActive >= 0 && this.turnRing) {
      const target = this._turnSpin[this._turnRingActive];
      let d = target - this.turnRing.rotation.z;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.turnRing.rotation.z += d * a;
      this.turnRing.material.opacity = 0.55 + 0.35 * Math.sin(now / 320);
    }
    if (this._fx.length) this._fx = this._fx.filter((fx) => fx(now, dt));
    if (this._shake) {
      const left = this._shake.until - now;
      if (left <= 0) { this._shake = null; this.camera.position.copy(this._camPos); }
      else { const m = this._shake.mag * (left / this._shake.dur); this.camera.position.set(this._camPos.x + (Math.random() * 2 - 1) * m, this._camPos.y + (Math.random() * 2 - 1) * m, this._camPos.z + (Math.random() * 2 - 1) * m); }
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ---- combo effects ------------------------------------------------------
  // A shimmering ✦ sweep for a 同花顺 (straight flush) / sequence.
  flushFx() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'); x.fillStyle = '#bfe9ff'; x.font = '104px serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('✦', 64, 70);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(3, 3, 1); sp.renderOrder = 999; this.scene.add(sp);
    const t0 = performance.now(), dur = 1200;
    this._fx.push((now) => {
      const t = (now - t0) / dur;
      if (t >= 1) { this.scene.remove(sp); sp.material.map.dispose(); sp.material.dispose(); return false; }
      sp.position.set(-12 + t * 24, 5.0 - Math.sin(t * Math.PI) * 1.0, 4);
      sp.material.opacity = Math.sin(t * Math.PI);
      return true;
    });
  }
  // An orange burst + camera shake when a 炸弹 / 天王炸 is played.
  bombFx() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'); const g = x.createRadialGradient(128, 128, 4, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,250,210,0.95)'); g.addColorStop(0.4, 'rgba(255,170,40,0.85)'); g.addColorStop(0.75, 'rgba(220,60,20,0.5)'); g.addColorStop(1, 'rgba(180,40,10,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthTest: false }));
    sp.position.set(0, 1.5, 0); sp.renderOrder = 999; this.scene.add(sp);
    const t0 = performance.now(), dur = 520;
    this._shake = { until: t0 + 460, dur: 460, mag: 0.6 };
    this._fx.push((now) => {
      const t = (now - t0) / dur;
      if (t >= 1) { this.scene.remove(sp); sp.material.map.dispose(); sp.material.dispose(); return false; }
      const s = 2 + t * 9; sp.scale.set(s, s, 1); sp.material.opacity = 1 - t;
      return true;
    });
  }

  // Deal animation: every card starts stacked at a centre "deck" and is served one at a time,
  // round-robin to the four players. Returns a Promise that resolves when the deal has settled.
  beginDeal({ hand, counts, fast = false }) {
    const order = [];
    const maxN = Math.max(hand.length, ...(counts || [27, 27, 27, 27]));
    for (let i = 0; i < maxN; i++) {
      if (i < hand.length) order.push('c' + hand[i].id);
      for (const seat of [1, 2, 3]) if (i < (counts ? counts[seat] : 27)) order.push(`b${seat}_${i}`);
    }
    const SERVE = fast ? 5 : 11, FLIGHT = fast ? 140 : 240;
    const t0 = performance.now();
    const serveAt = new Map(), idx = new Map();
    order.forEach((k, i) => { serveAt.set(k, t0 + i * SERVE); idx.set(k, order.length - i); });
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    this._deal = { active: true, serveAt, idx, deck: new THREE.Vector3(0, 0.07, 0), quat };
    return new Promise((res) => setTimeout(() => { if (this._deal) this._deal.active = false; res(); }, order.length * SERVE + FLIGHT + 120));
  }
}
