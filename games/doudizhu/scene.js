// 3D poker table for 斗地主, on the same locally-vendored three.js as the mahjong games
// (offline, no CDN). Cards are thin boxes whose faces are drawn to a canvas and used as
// textures, so there are zero binary art assets — the same approach as the mahjong tiles.
//
// Meshes are persistent and keyed by a stable id; sync() diffs the desired layout against
// what's on the table and an animation loop eases each card toward its target transform, so
// selection lifts, hand reflow, and cards sliding to the centre come for free.
import * as THREE from '../mahjong-tianjin/lib/three.module.min.js';
import { rankLabel } from './engine.js';

const CW = 1.0, CH = 1.45, CD = 0.02;   // card width / height / depth (thin cards)
const FELT = 15;
const HAND_Y = 0.62;   // human hand sits ABOVE the felt (was clipping into the table)
const OPP_Y = 1.45;    // opponents' upright fans stand on the table (raised so the 2× cards clear the felt)
const SUIT_CHAR = ['♠', '♥', '♣', '♦'];
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
    this.renderer.shadowMap.enabled = true;
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

    this._lights(); this._table();
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
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._loop();
  }

  setRotated(r) { this.rotated = !!r; }
  resize() { this._resize(); }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xbfe6d8, 0x223026, 1.2));
    const key = new THREE.DirectionalLight(0xfff4d6, 2.6);
    key.position.set(-5, 15, 7); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 12; Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 42 });
    key.shadow.bias = -0.0004; this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xa9c7ff, 0.5); fill.position.set(7, 9, -6); this.scene.add(fill);
  }
  _table() {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(FELT / 2 + 1.1, FELT / 2 + 1.1, 0.7, 64),
      new THREE.MeshStandardMaterial({ color: 0x6e4626, roughness: 0.72 }));
    rim.position.y = -0.45; rim.receiveShadow = true; this.scene.add(rim);
    const felt = new THREE.Mesh(new THREE.CylinderGeometry(FELT / 2, FELT / 2, 0.5, 64),
      new THREE.MeshStandardMaterial({ color: 0x178a63, roughness: 0.96 }));
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
    // The camera's up axis = "straight up" on screen. Lifting a selected card along it is perpendicular
    // to the view direction, so the card's distance to the camera is unchanged — it slides purely up,
    // with NO movement toward the camera (it doesn't grow or pop out at the viewer).
    this.camera.updateMatrixWorld();
    const screenUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    hand.forEach((card, i) => {
      const sel = view.selected && view.selected.has(card.id);
      const hint = view.hint && view.hint.has(card.id);
      // Flat, even row (no vertical slope), all cards at the same tilt facing the camera. A TINY
      // per-card depth step lets overlapping neighbours layer cleanly without a visible slant.
      const z = 6.9 + i * 0.005;
      const pos = new THREE.Vector3(x0 + i * step, HAND_Y, z);
      if (sel) pos.addScaledVector(screenUp, 1.15);
      want.set('c' + card.id, { faceCard: card, pos, quat: tilt, scale: 1.1, pick: true, id: card.id, hint, sel });
    });

    // 底牌 — three face-up cards at top centre until the landlord takes them
    if (view.bottom) view.bottom.forEach((card, i) => {
      want.set('c' + card.id, { faceCard: card, pos: new THREE.Vector3(BOTTOM_SPOT.x + (i - 1) * 1.15, 0.06, BOTTOM_SPOT.z), quat: flatUp, scale: 0.9 });
    });

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
      const flatDown = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)); // back up
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
  }

  // Screen position of a world point, for HTML overlays (badges/bubbles).
  worldToScreen(v) {
    const p = v.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  }
  seatScreen(seat, y = 1.2) { return this.worldToScreen(SEAT_ANCHOR[seat].clone().setY(y)); }

  // 底牌展示 — carved INTO the 3D table: a bordered rectangle lying on the felt, the title text
  // inside it, and the 3 landlord cards (double-sized, face-up) under the text.
  showBottomReveal(cards) {
    this.hideBottomReveal();
    const g = new THREE.Group();
    // the border + title, drawn to a canvas and laid flat on the felt (reads upright from the player)
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 820; // taller → room for the cards
    const x = cv.getContext('2d'); const W = cv.width, H = cv.height;
    rr(x, 12, 12, W - 24, H - 24, 44); x.fillStyle = 'rgba(6,26,18,0.82)'; x.fill();
    x.lineWidth = 12; x.strokeStyle = '#e8c466'; x.stroke();                                  // outer gold frame
    rr(x, 30, 30, W - 60, H - 60, 32); x.lineWidth = 3; x.strokeStyle = 'rgba(232,196,102,0.45)'; x.stroke(); // inner bevel line
    x.fillStyle = '#f0d886'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '800 88px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    x.fillText('底 牌 展 示', W / 2, 96);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const pw = 7.4, pd = pw * H / W;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, pd), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    panel.rotation.x = -Math.PI / 2; panel.position.set(0, 0.03, -0.4);
    g.add(panel); this._revealPanel = panel;
    const flatUp = new THREE.Euler(-Math.PI / 2, 0, 0);
    cards.forEach((card, i) => {
      const m = this._makeMesh(card);                       // _makeMesh adds to this.group; re-parent below
      m.scale.setScalar(1.5); m.quaternion.setFromEuler(flatUp);
      m.position.set((i - 1) * 1.9, 0.08, 0.35);            // a row UNDER the title, with a gap to the bottom border
      g.add(m);
    });
    this.scene.add(g); this._reveal = g;
  }
  hideBottomReveal() {
    if (!this._reveal) return;
    // dispose only the panel's unique canvas texture/geometry; card faces use the shared cache.
    if (this._revealPanel) { this._revealPanel.geometry.dispose(); this._revealPanel.material.map.dispose(); this._revealPanel.material.dispose(); }
    this.scene.remove(this._reveal); this._reveal = null; this._revealPanel = null;
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
  _loop() {
    requestAnimationFrame(() => this._loop());
    const dt = Math.min(0.05, this.clock.getDelta());
    const a = 1 - Math.pow(0.0015, dt); // smooth critically-ish damped lerp
    const now = performance.now();
    const dealing = this._deal && this._deal.active;
    for (const r of this.cards.values()) {
      if (!r.target) continue;
      // during the deal, a card waits in the deck (served-soon on top) until its turn — lying FLAT and
      // FACE-DOWN, parallel to the table, stacked on the felt.
      if (dealing && r.key && this._deal.serveAt.has(r.key) && now < this._deal.serveAt.get(r.key)) {
        const s = Math.min((this._deal.idx.get(r.key) || 0), 40) * 0.005;
        r.mesh.position.set(this._deal.deck.x, this._deal.deck.y + s, this._deal.deck.z);
        r.mesh.quaternion.copy(this._deal.quat);
        continue;
      }
      r.mesh.position.lerp(r.target.pos, a);
      r.mesh.quaternion.slerp(r.target.quat, a);
      const s = r.target.scale; r.mesh.scale.lerp(new THREE.Vector3(s, s, s), a);
    }
    if (this._fx.length) this._fx = this._fx.filter((fx) => fx(now, dt));   // run active effects
    // camera shake (bomb): jitter the camera off its base, decaying to zero
    if (this._shake) {
      const left = this._shake.until - now;
      if (left <= 0) { this._shake = null; this.camera.position.copy(this._camPos); }
      else { const m = this._shake.mag * (left / this._shake.dur); this.camera.position.set(this._camPos.x + (Math.random() * 2 - 1) * m, this._camPos.y + (Math.random() * 2 - 1) * m, this._camPos.z + (Math.random() * 2 - 1) * m); }
    }
    this.renderer.render(this.scene, this.camera);
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
  }

  // Deal animation: every card starts stacked at a centre "deck" and is served one at a time,
  // round-robin to the three players, flying to its final slot via the lerp loop. Returns a Promise
  // that resolves when the deal has settled. (The 3 底牌 are not part of this — they reveal later.)
  beginDeal({ hand, fast = false }) {
    const order = [];
    for (let r = 0; r < hand.length; r++) { order.push('c' + hand[r].id); order.push('b1_' + r); order.push('b2_' + r); }
    const SERVE = fast ? 9 : 20, FLIGHT = fast ? 140 : 240;
    const t0 = performance.now();
    const serveAt = new Map(), idx = new Map();
    order.forEach((k, i) => { serveAt.set(k, t0 + i * SERVE); idx.set(k, order.length - i); }); // served-soon = on top
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)); // flat, face-DOWN (back up)
    this._deal = { active: true, serveAt, idx, deck: new THREE.Vector3(0, 0.07, -0.4), quat };
    return new Promise((res) => setTimeout(() => { if (this._deal) this._deal.active = false; res(); }, order.length * SERVE + FLIGHT + 120));
  }
}
