// 3D poker table for 斗地主, on the same locally-vendored three.js as the mahjong games
// (offline, no CDN). Cards are thin boxes whose faces are drawn to a canvas and used as
// textures, so there are zero binary art assets — the same approach as the mahjong tiles.
//
// Meshes are persistent and keyed by a stable id; sync() diffs the desired layout against
// what's on the table and an animation loop eases each card toward its target transform, so
// selection lifts, hand reflow, and cards sliding to the centre come for free.
import * as THREE from '../poker-common/lib/three.module.min.js';
import { rankLabel } from './engine.js';

const CW = 1.0, CH = 1.45, CD = 0.014;  // card width / height / depth (very thin cards)
const FELT = 15;
const HAND_Y = 0.62;   // human hand sits ABOVE the felt (was clipping into the table)
const OPP_Y = 1.45;    // opponents' upright fans stand on the table (raised so the 2× cards clear the felt)
const SUIT_CHAR = ['♠︎', '♥︎', '♣︎', '♦︎'];
const SUIT_RED = [false, true, false, true];

// Seat anchors (world space). Seat 0 is the human at the bottom; 1 is the 下家 (upper right),
// 2 the 上家 (upper left) — turn order 0→1→2 runs clockwise from the player's left.
const SEAT_ANCHOR = [new THREE.Vector3(0, 0, 7.4), new THREE.Vector3(8.2, 0, -2.6), new THREE.Vector3(-8.2, 0, -2.6)];
// Where each seat's current play sits on the felt.
const PLAY_SPOT = [new THREE.Vector3(0, 0, 2.6), new THREE.Vector3(3.7, 0, -0.4), new THREE.Vector3(-3.7, 0, -0.4)];
const BOTTOM_SPOT = new THREE.Vector3(0, 0, -5.4);

// ---- card faces ------------------------------------------------------------
const faceCache = new Map();   // key -> THREE.CanvasTexture
let backTex = null;
const keyOf = (card) => (card.rank >= 16 ? 'J' + card.rank : card.rank + '_' + card.suit);

function rr(x, X, Y, W, H, r) {
  x.beginPath(); x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath();
}
// Draw a card face onto a canvas with high contrast — pure-white ground, near-black/vivid-red
// glyphs, bold corner indices — so it reads clearly even small and under the 3D lighting.
function drawCardFace(c, card) {
  const x = c.getContext('2d'); const W = c.width, H = c.height;
  // fill the WHOLE canvas white — the rounded geometry does the corner shaping, so there are no
  // transparent texture corners showing through as black.
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  const RED = '#d11414', BLACK = '#101014';
  if (card.rank >= 16) {            // jokers
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
    // corner index drawn at a fixed safe margin; the bottom-right copy is the WHOLE thing rotated
    // 180° about the canvas centre, so both indices are symmetric and always inside the bounds.
    const mx = 52, my = 54;
    const drawIndex = () => {
      x.font = '900 62px Arial, system-ui, sans-serif'; x.fillText(lbl, mx, my);
      x.font = '900 42px sans-serif'; x.fillText(suit, mx, my + 46);
    };
    drawIndex();
    x.font = '900 168px sans-serif'; x.fillText(suit, W / 2, H * 0.55);                 // big centre pip
    x.save(); x.translate(W, H); x.rotate(Math.PI); drawIndex(); x.restore();
  }
}
// A standalone face canvas — reused by the HTML 底牌展示 panel.
export function cardFaceCanvas(card) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 360; drawCardFace(c, card); return c;
}
function cardTexture(card) {
  const key = keyOf(card);
  if (faceCache.has(key)) return faceCache.get(key);
  const c = document.createElement('canvas'); c.width = 256; c.height = 360;
  drawCardFace(c, card);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  faceCache.set(key, t); return t;
}
function backTexture() {
  if (backTex) return backTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 360;
  const x = c.getContext('2d'); const W = c.width, H = c.height;
  x.fillStyle = '#fbfaf5'; rr(x, 2, 2, W - 4, H - 4, 26); x.fill();
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#9a1b2e'); g.addColorStop(1, '#5e0f1d');
  x.save(); rr(x, 14, 14, W - 28, H - 28, 18); x.clip();
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(255,255,255,0.18)'; x.lineWidth = 3;
  for (let i = -H; i < W; i += 18) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + H, H); x.stroke(); }
  x.restore();
  x.fillStyle = '#f3d785'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '900 70px -apple-system,"PingFang SC",sans-serif'; x.fillText('斗', W / 2, H / 2);
  backTex = new THREE.CanvasTexture(c); backTex.colorSpace = THREE.SRGBColorSpace; backTex.anisotropy = 4;
  return backTex;
}
// Table materials — shared CC0 table textures in ../poker-common/textures:
// felt = non-tiling green canvas (blotches + Gaussian grain, no visible repeat) + tiled Fabric034
// normal/roughness; rim = Wood066 antique-chestnut. The normal maps need a directional light to read.
const TEX = (file, srgb, rep) => {
  const t = new THREE.TextureLoader().load(new URL(`../poker-common/textures/${file}`, import.meta.url).href);
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

// A rounded-corner card body: a rounded rectangle extruded by the card depth, so the face is a
// true rounded rectangle (not a sharp box). Cap UVs are remapped to 0..1 over the full CW×CH so the
// face texture maps cleanly and centred (no crop). Three contiguous material groups by face normal:
// 0 = front cap (the face), 1 = back cap (the back), 2 = the sides.
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
  const triMat = (t) => { const nz = nrm.getZ(t * 3); return nz > 0.5 ? 0 : nz < -0.5 ? 1 : 2; }; // front/back/side
  let runStart = 0, runMat = triMat(0);
  for (let t = 1; t <= triN; t++) {
    const m = t < triN ? triMat(t) : -1;
    if (m !== runMat) { geo.addGroup(runStart * 3, (t - runStart) * 3, runMat); runStart = t; runMat = m; }
  }
  return geo;
}

export class DouScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;             // a centered key light + soft shadows (like the mahjong table)
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1f17);
    this.camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
    this.camBase = new THREE.Vector3(0, 12.6, 14.2);
    this.camLook = new THREE.Vector3(0, -1.0, 0.4);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.camLook);
    // tilt that stands a hand card up so its face points straight at the camera (computed from the
    // hand's actual position, not the look point, so the cards face the camera directly)
    this.faceCamRx = -Math.atan2(this.camBase.y - HAND_Y, this.camBase.z - 6.9);

    this._lights(); this._table(); this._turnRing();
    this.geo = roundedCardGeo();
    this.sideMat = new THREE.MeshStandardMaterial({ color: 0xece9df, roughness: 0.85 });

    this.cards = new Map();      // key -> { mesh, pos:Vector3, quat:Quaternion, scale, pick, id }
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.rotated = false;
    this._fx = [];               // active visual effects (plane fly-by, bomb burst) updated each frame
    this._shake = null;          // { until, mag } camera shake
    this._camPos = this.camBase.clone(); // base camera position (shake offsets from here)
    this._running = false;       // on-demand render loop: runs only while something animates (battery)
    this._resize();
    new ResizeObserver(() => { this._resize(); this._kick(); }).observe(canvas.parentElement);
    this._kick();                // initial paint; the loop self-stops once everything settles
    this._warmFaces();
  }

  setRotated(r) { this.rotated = !!r; this._kick(); }

  // Pre-rasterise + GPU-upload every card face up front so the first deal doesn't lazily generate ~17
  // face canvases on a slow CPU. Spread over ticks to keep startup responsive.
  _warmFaces() {
    const jobs = [];
    for (let r = 3; r <= 15; r++) for (let s = 0; s < 4; s++) jobs.push({ rank: r, suit: s });
    jobs.push({ rank: 16, suit: -1 }, { rank: 17, suit: -1 });
    this._uploadTex(backTexture());
    let i = 0;
    const tick = () => {
      for (let n = 0; i < jobs.length && n < 6; i++, n++) this._uploadTex(cardTexture(jobs[i]));
      if (i < jobs.length) setTimeout(tick, 16);
    };
    tick();
  }
  _uploadTex(t) { try { this.renderer.initTexture(t); } catch {} } // initTexture absent in old three → canvas still pre-drawn
  resize() { this._resize(); this._kick(); }

  // A CENTERED (x=0) key light + ambient fill. Centered means it's symmetric left↔right, so the hand
  // row has no left-to-right brightness gradient (the old side light did), while still catching the
  // felt/wood normal maps and casting soft card shadows — matching the mahjong table's look.
  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xcfe9df, 0x223026, 1.0));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xfff4e0, 2.1);
    key.position.set(0, 16, 5); key.castShadow = true;   // x=0 → symmetric, no left/right hand gradient
    key.shadow.mapSize.set(2048, 2048);
    const s = 12; Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 44 });
    key.shadow.bias = -0.0004; this.scene.add(key);
  }
  // A single glowing ONE-THIRD ring (120°) laid flat on the felt, centered at the table origin. It
  // rotates in-plane (rotation.z) to point at whichever seat's turn it is, and pulses. (Same idea as
  // the mahjong quarter-ring, with three 120° seats instead of four 90° ones.)
  _turnRing() {
    const R = 4.5;
    const geo = new THREE.RingGeometry(R - 0.22, R + 0.22, 48, 1, -Math.PI / 3, 2 * Math.PI / 3); // 120° centered on +X
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    this.turnRing = new THREE.Mesh(geo, mat);
    this.turnRing.rotation.set(-Math.PI / 2, 0, 0); // lie flat; rotation.z (3rd Euler) spins it in-plane
    this.turnRing.position.set(0, 0.03, 0);
    this.turnRing.visible = false;
    this.scene.add(this.turnRing);
    // rotation.z that centers the arc on each seat's world direction (atan2(-z, x))
    this._turnSpin = SEAT_ANCHOR.map((a) => Math.atan2(-a.z, a.x));
    this._turnRingActive = -1;
  }
  _table() {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(FELT / 2 + 1.1, FELT / 2 + 1.1, 0.7, 64), woodMaterial());
    rim.position.y = -0.45; rim.receiveShadow = true; this.scene.add(rim);
    const felt = new THREE.Mesh(new THREE.CylinderGeometry(FELT / 2, FELT / 2, 0.5, 64), feltMaterial());
    felt.position.y = -0.26; felt.receiveShadow = true; this.scene.add(felt);
  }

  // Build a card mesh. faceCard set → real face on the +z cap; else a back on both caps.
  // The face is given an emissiveMap of itself so it's partly self-lit — keeps the white ground
  // bright and the glyphs crisp under the table lighting (readability).
  _makeMesh(faceCard) {
    const front = faceCard ? new THREE.MeshStandardMaterial({ map: cardTexture(faceCard), roughness: 0.55, emissive: 0x3a3a3a, emissiveMap: cardTexture(faceCard), emissiveIntensity: 0.6 })
      : new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.6 });
    const back = new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.6 });
    // rounded card geo groups: 0 = front cap (face), 1 = back cap, 2 = sides.
    const mats = [front, back, this.sideMat];
    const mesh = new THREE.Mesh(this.geo, mats);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  // Compose the desired layout from a plain view and ease meshes toward it. view:
  //   { hand:[card], selected:Set, hint:Set, counts:[n,n,n], landlord, turn,
  //     bottom:[card]|null, table:[{seat, cards:[card]}] }
  sync(view) {
    const want = new Map(); // key -> { faceCard, pos, quat, scale, pick, id }
    const flatUp = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)); // lie flat, face up

    // human hand — an overlapping row along the bottom edge, tilted up to face the camera
    const hand = view.hand || [];
    const n = hand.length;
    const step = Math.min(0.64, n > 1 ? 11 / (n - 1) : 0);
    const x0 = -step * (n - 1) / 2;
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.faceCamRx, 0, 0));
    // A selected card slides along its OWN long edge — the card's local +Y axis (in a frame where its
    // local +Z is the camera-facing normal). So it slides up/down across its own face, staying in its
    // plane: no tilt, no motion toward/away from the camera.
    const cardUp = new THREE.Vector3(0, 1, 0).applyQuaternion(tilt);
    hand.forEach((card, i) => {
      const sel = view.selected && view.selected.has(card.id);
      const hint = view.hint && view.hint.has(card.id);
      // Flat, even row (no vertical slope), all cards at the same tilt facing the camera. A TINY
      // per-card depth step lets overlapping neighbours layer cleanly without a visible slant.
      const z = 6.9 + i * 0.005;
      const pos = new THREE.Vector3(x0 + i * step, HAND_Y, z);
      if (sel) pos.addScaledVector(cardUp, 1.1);
      want.set('c' + card.id, { faceCard: card, pos, quat: tilt, scale: 1.1, pick: true, id: card.id, hint, sel });
    });

    const flatDown = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)); // back up (used by the discard pile)

    // on-turn ring — aim at the active seat (bid OR play); the loop rotates it there + pulses
    if (this.turnRing) {
      const ts = (view.turn != null && (view.phase === 'bid' || view.phase === 'play')) ? view.turn : -1;
      this._turnRingActive = ts;
      this.turnRing.visible = ts >= 0;
    }

    // current plays on the felt, one cluster per seat. The CURRENT play (the lead to beat) is
    // scaled up 1.5× so it stands out; earlier plays in the trick stay normal size. New play
    // meshes spawn at the playing seat (`from`) so they fly in from the hand to the table.
    for (const t of (view.table || [])) {
      const spot = PLAY_SPOT[t.seat]; const m = t.cards.length;
      const isCurrent = t.seat === view.leadSeat;
      const sc = isCurrent ? 1.8 : 1.2;   // played cards ~20% bigger (current lead larger still)
      const cs = Math.min(0.5 * sc, m > 1 ? 2.6 * sc / (m - 1) : 0); const cx0 = -cs * (m - 1) / 2;
      const from = SEAT_ANCHOR[t.seat].clone().setY(1.1);
      t.cards.forEach((card, i) => {
        want.set('c' + card.id, { faceCard: card, pos: new THREE.Vector3(spot.x + cx0 + i * cs, 0.06 + i * 0.004, spot.z), quat: flatUp, scale: sc, from });
      });
    }

    // opponents' hands — face-down cards standing UPRIGHT (backs to us) in a slight fan, sized to
    // their remaining count. At game over `revealHands` flips them to their real faces.
    for (const seat of [1, 2]) {
      const reveal = view.revealHands && view.revealHands[seat];
      const cnt = reveal ? reveal.length : (view.counts || [0, 0, 0])[seat];
      const cx = SEAT_ANCHOR[seat].x * 0.72, cz = -2.5;       // pulled in a touch — the cards are 2× bigger now
      const cs = Math.min(0.34, cnt > 1 ? 3.6 / (cnt - 1) : 0); const cx0 = -cs * (cnt - 1) / 2;
      const fan = 0.42;
      for (let i = 0; i < cnt; i++) {
        const t = cnt > 1 ? (i / (cnt - 1) - 0.5) : 0;          // -0.5..0.5 across the fan
        const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, 0, -t * fan)); // near-vertical, fanned
        const face = reveal ? reveal[i] : null;
        const key = reveal ? 'c' + reveal[i].id : `b${seat}_${i}`;
        want.set(key, { faceCard: face, pos: new THREE.Vector3(cx + cx0 + i * cs, OPP_Y + i * 0.004, cz), quat, scale: 1.6 });
      }
    }

    // discard pile — cards from completed tricks lie FACE-DOWN, loosely scattered in the middle.
    // They keep their SAME 'c'+id mesh from the table, with a face-down target here, so each one
    // flies over and FLIPS from its play spot into the pile (stable per-card jitter from the id).
    if (view.discard) {
      view.discard.forEach((card, i) => {
        const jx = (((card.id * 37) % 100) / 100 - 0.5) * 1.7;
        const jz = (((card.id * 61) % 100) / 100 - 0.5) * 1.2;
        const rot = (((card.id * 53) % 100) / 100 - 0.5) * 0.9;
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot).multiply(flatDown);
        want.set('c' + card.id, { faceCard: card, pos: new THREE.Vector3(jx, 0.04 + i * 0.003, -1.0 + jz), quat, scale: 0.73 });
      });
    }

    // diff: remove vanished, create new, update targets
    for (const key of [...this.cards.keys()]) if (!want.has(key)) { const r = this.cards.get(key); this.group.remove(r.mesh); this.cards.delete(key); }
    for (const [key, d] of want) {
      let r = this.cards.get(key);
      // a NEW mesh spawns at the deck (during a deal) or at its `from` (a played card flying in).
      if (!r) {
        const atDeck = this._deal && this._deal.active && this._deal.serveAt.has(key);
        r = { mesh: this._makeMesh(d.faceCard), id: d.id, pick: d.pick, key };
        r.mesh.position.copy(atDeck ? this._deal.deck : (d.from || d.pos)); r.mesh.quaternion.copy(atDeck ? this._deal.quat : d.quat);
        this.cards.set(key, r);
      }
      r.target = d; r.id = d.id; r.pick = d.pick;
      // selection glow (warm). Default keeps the face's self-lit grey so the contrast brightening stays.
      if (r.mesh.material[0] && r.mesh.material[0].emissiveMap) r.mesh.material[0].emissive.setHex(d.sel ? 0x6a5616 : d.hint ? 0x2a5d3a : 0x3a3a3a);
    }
    this._kick(); // re-targeted cards / turn-ring → wake the render loop to animate them in
  }

  // Screen position of a world point, for HTML overlays (badges/bubbles).
  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  }
  seatScreen(seat, y = 1.2) { return this.worldToScreen(SEAT_ANCHOR[seat].clone().setY(y)); }

  // 底牌 box — carved INTO the 3D table: a bordered rectangle lying on the felt, a title, and the 3
  // 底牌 under it. Shown FACE-DOWN during bidding and flipped FACE-UP (展示) once the landlord is set.
  showBottomReveal(cards, { faceDown = false, title = '底 牌 展 示' } = {}) {
    this.hideBottomReveal();
    const g = new THREE.Group();
    // the border + title, drawn to a canvas and laid flat on the felt (reads upright from the player)
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 820; // taller → room for the cards
    const x = cv.getContext('2d'); const W = cv.width, H = cv.height;
    rr(x, 12, 12, W - 24, H - 24, 44); x.lineWidth = 12; x.strokeStyle = '#e8c466'; x.stroke(); // gold frame, TRANSPARENT inside
    rr(x, 30, 30, W - 60, H - 60, 32); x.lineWidth = 3; x.strokeStyle = 'rgba(232,196,102,0.45)'; x.stroke(); // inner bevel line
    x.fillStyle = '#f0d886'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '800 88px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    x.fillText(title, W / 2, 96);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const pw = 7.4, pd = pw * H / W;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, pd), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    panel.rotation.x = -Math.PI / 2; panel.position.set(0, 0.03, -0.4);
    g.add(panel); this._revealPanel = panel;
    // face-down (back up) while bidding, else face-up. For face-down, spin the card 180° about its own
    // normal so the back's 斗 reads UPRIGHT (a plain X-flip leaves it upside-down). The back cap is seen
    // from behind, so its 斗 is also laterally mirrored — a reflection no rotation can undo; negate the
    // mesh's X scale to flip it back (the renderer corrects the winding for the negative determinant).
    const lie = new THREE.Quaternion().setFromEuler(new THREE.Euler(faceDown ? Math.PI / 2 : -Math.PI / 2, 0, 0));
    if (faceDown) lie.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI)));
    cards.forEach((card, i) => {
      const m = this._makeMesh(card);                       // _makeMesh adds to this.group; re-parent below
      m.scale.set(faceDown ? -1.5 : 1.5, 1.5, 1.5); m.quaternion.copy(lie);
      m.position.set((i - 1) * 1.9, 0.08, 0.35);            // a row UNDER the title, with a gap to the bottom border
      g.add(m);
    });
    this.scene.add(g); this._reveal = g; this._kick();
  }
  hideBottomReveal() {
    if (!this._reveal) return;
    // dispose only the panel's unique canvas texture/geometry; card faces use the shared cache.
    if (this._revealPanel) { this._revealPanel.geometry.dispose(); this._revealPanel.material.map.dispose(); this._revealPanel.material.dispose(); }
    this.scene.remove(this._reveal); this._reveal = null; this._revealPanel = null; this._kick();
  }

  // Hit-test the human hand; returns a card id or null.
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    let px = clientX - r.left, py = clientY - r.top;
    if (this.rotated) { const t = px; px = py; py = r.width - t; } // un-rotate forced-landscape input
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
    // pull the camera back on tall/narrow viewports so the table fits
    const k = Math.max(1, (h / w) / 0.62);
    this._camPos = this.camBase.clone().multiplyScalar(k > 1 ? 1 + (k - 1) * 0.5 : 1);
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
  }
  // On-demand render loop. _kick() starts it; the loop renders each frame while ANYTHING is still
  // animating, then stops itself once the table has settled — so an idle game (waiting for a turn, bots
  // thinking) draws zero frames and lets the GPU sleep. Every state change (sync/select/deal/fx/shake/
  // turn-ring/drag/resize) calls _kick() to wake it. Cosmetic pulses (turn-ring/outline glow) freeze
  // when idle, which is the deliberate trade for not pinning the GPU at 60 fps.
  _kick() { if (!this._running) { this._running = true; this.clock.getDelta(); requestAnimationFrame(() => this._anim()); } }
  _anim() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const a = 1 - Math.pow(0.0015, dt); // smooth critically-ish damped lerp
    const now = performance.now();
    const dealing = this._deal && this._deal.active;
    let active = false; // does anything still need another frame?
    for (const r of this.cards.values()) {
      if (!r.target) continue;
      // during the deal, a card waits in the deck (served-soon on top) until its turn — lying FLAT and
      // FACE-DOWN, parallel to the table, stacked on the felt.
      if (dealing && r.key && this._deal.serveAt.has(r.key) && now < this._deal.serveAt.get(r.key)) {
        const s = Math.min((this._deal.idx.get(r.key) || 0), 40) * 0.005;
        r.mesh.position.set(this._deal.deck.x, this._deal.deck.y + s, this._deal.deck.z);
        r.mesh.quaternion.copy(this._deal.quat);
        active = true;
        continue;
      }
      const sv = r.target.scale;
      // settled? snap exactly + skip lerp so sub-epsilon drift can't keep the loop alive forever.
      if (r.mesh.position.distanceToSquared(r.target.pos) < 1e-6 &&
          Math.abs(Math.abs(r.mesh.quaternion.dot(r.target.quat)) - 1) < 1e-6 &&
          Math.abs(r.mesh.scale.x - sv) < 1e-3) {
        r.mesh.position.copy(r.target.pos); r.mesh.quaternion.copy(r.target.quat); r.mesh.scale.setScalar(sv);
        continue;
      }
      r.mesh.position.lerp(r.target.pos, a);
      r.mesh.quaternion.slerp(r.target.quat, a);
      r.mesh.scale.lerp(new THREE.Vector3(sv, sv, sv), a);
      active = true;
    }
    if (this._turnRingActive >= 0 && this.turnRing) {        // on-turn ring rotates (shortest path) to the active seat + pulses
      const target = this._turnSpin[this._turnRingActive];
      let d = target - this.turnRing.rotation.z;
      d = Math.atan2(Math.sin(d), Math.cos(d));              // shortest signed delta
      if (Math.abs(d) > 1e-4) { this.turnRing.rotation.z += d * a; active = true; }
      else this.turnRing.rotation.z = target;
      this.turnRing.material.opacity = 0.55 + 0.35 * Math.sin(now / 320);
    }
    if (this._fx.length) { this._fx = this._fx.filter((fx) => fx(now, dt)); if (this._fx.length) active = true; } // run active effects
    // camera shake (bomb): jitter the camera off its base, decaying to zero
    if (this._shake) {
      const left = this._shake.until - now;
      if (left <= 0) { this._shake = null; this.camera.position.copy(this._camPos); }
      else { const m = this._shake.mag * (left / this._shake.dur); this.camera.position.set(this._camPos.x + (Math.random() * 2 - 1) * m, this._camPos.y + (Math.random() * 2 - 1) * m, this._camPos.z + (Math.random() * 2 - 1) * m); active = true; }
    }
    this.renderer.render(this.scene, this.camera);
    if (active) requestAnimationFrame(() => this._anim());
    else this._running = false; // settled — stop drawing until the next _kick()
  }

  // ---- combo effects ------------------------------------------------------
  // ✈ flies across the table when a 飞机 (plane) is played.
  planeFx() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'); x.fillStyle = '#eef4ff'; x.font = '104px serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('✈', 64, 70);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(3, 3, 1); sp.renderOrder = 999; this.scene.add(sp);
    const t0 = performance.now(), dur = 1300;
    this._fx.push((now) => {
      const t = (now - t0) / dur;
      if (t >= 1) { this.scene.remove(sp); sp.material.map.dispose(); sp.material.dispose(); return false; }
      sp.position.set(-12 + t * 24, 5.5 - Math.sin(t * Math.PI) * 1.2, 4); // fly left→right with a gentle arc
      sp.material.opacity = Math.sin(t * Math.PI);
      return true;
    });
    this._kick();
  }
  // An orange burst at table centre + a camera shake when a 炸弹 / 王炸 is played.
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
    this._kick();
  }

  // Deal animation: every card starts stacked at a centre "deck" and is served one at a time,
  // round-robin to the three players, flying to its final slot via the lerp loop. Returns a Promise
  // that resolves when the deal has settled. The 3 底牌 stay in the deck and show in the 底牌 box.
  beginDeal({ hand, fast = false }) {
    const order = [];
    for (let r = 0; r < hand.length; r++) { order.push('c' + hand[r].id); order.push('b1_' + r); order.push('b2_' + r); }
    const SERVE = fast ? 9 : 20, FLIGHT = fast ? 140 : 240;
    const t0 = performance.now();
    const serveAt = new Map(), idx = new Map();
    order.forEach((k, i) => { serveAt.set(k, t0 + i * SERVE); idx.set(k, order.length - i); }); // served-soon = on top
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)); // flat, face-DOWN (back up)
    this._deal = { active: true, serveAt, idx, deck: new THREE.Vector3(0, 0.07, -0.4), quat };
    this._kick();
    return new Promise((res) => setTimeout(() => { if (this._deal) this._deal.active = false; this._kick(); res(); }, order.length * SERVE + FLIGHT + 120));
  }
}
