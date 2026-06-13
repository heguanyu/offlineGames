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
const DRAW_MARGIN = 0.4;  // half-gap flanking the freshly-drawn tile on each side
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
    // rx that tilts a flat-facing tile back so its face squarely faces the camera
    // (i.e. perpendicular to the camera's down-pitched view axis).
    this.faceCamRx = -Math.atan2(this.camBase.y - this.camLook.y, this.camBase.z - this.camLook.z);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.camLook);

    this._lights(); this._table();

    this.geo = roundedTileGeo();
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
        mesh.scale.setScalar(spec.scale ?? 1);
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
    let settled = 0;
    const handItems = hand.map((id, i) => {
      const isDrawn = i === drawnIdx;
      return {
        key: isDrawn ? 'hdraw' : 'h' + settled++, kind: id, wild: game.isWild(id), pick: i,
        selected: ui.myTurn && i === ui.selRendered,
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
    this._placeRow(handItems, { cx: 0, cz: R_HAND, dx: 1, dz: 0, rx: flat ? -Math.PI / 2 : -0.34, ry: 0, pull: -0.35, flat, refSpan: 13 * GAP + 2 * DRAW_MARGIN }, HAND_HALF, seen);

    // Opponents: walls of backs. refSpan = a full 14-tile hand so the back row is
    // a fixed size, not rescaling each time a bot draws/discards (13 ↔ 14 tiles).
    const oppRef = 13 * GAP;
    const oppCfg = {
      1: { cx: R_OPP, cz: 0, dx: 0, dz: 1, rx: 0, ry: -Math.PI / 2, pull: 0, refSpan: oppRef },
      2: { cx: 0, cz: -R_OPP, dx: 1, dz: 0, rx: 0, ry: Math.PI, pull: 0, refSpan: oppRef },
      3: { cx: -R_OPP, cz: 0, dx: 0, dz: 1, rx: 0, ry: Math.PI / 2, pull: 0, refSpan: oppRef },
    };
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
        x, y: baseY + lift, z, rx: cfg.rx + (it.selected ? 0.16 : 0), ry: cfg.ry, rz: it.rz || 0,
        from: it.from, draw: it.draw, gate: it.gate,
      }, seen);
      if (it.selected) {
        this.glowTarget.on = true;
        this.glowTarget.pos.set(x, baseY + lift, z);
        this.glowTarget.size = s;
      }
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
  _wall(game, seen) {
    const WW = 0.54, h = R_WALL;
    const perSide = Math.max(2, Math.floor((2 * h) / WW));
    const cell = (2 * h) / perSide;
    const at = (i) => -h + (i + 0.5) * cell;          // centre of slot i along a side
    // The deck is just two side walls (left + right). The front (player) side AND the
    // top (对家) side are kept clear — the top so 对家's called melds show there in the
    // camera's view (see _meldsFlat). Slot 0 is front-left; the live draw end is the
    // last slot (front-right).
    const slots = [];
    for (let i = 0; i < perSide; i++) slots.push({ x: -h, z: -at(i), spin: Math.PI / 2 });  // left: front → back
    for (let i = 0; i < perSide; i++) slots.push({ x: h, z: at(i), spin: Math.PI / 2 });     // right: back → front
    const nStacks = Math.min(slots.length, Math.ceil(game.wall.length / 2));
    const yBot = (TD / 2) * WW - 0.05, yTop = yBot + TD * WW;
    for (let s = 0; s < nStacks; s++) {
      const c = slots[s];
      this._place('wb' + s, { kind: null, scale: WW, x: c.x, y: yBot, z: c.z, rx: -Math.PI / 2, ry: 0, rz: c.spin }, seen);
      if (game.wall.length - s * 2 >= 2) // odd remainder → last stack has no top tile
        this._place('wt' + s, { kind: null, scale: WW, x: c.x, y: yTop, z: c.z, rx: -Math.PI / 2, ry: 0, rz: c.spin }, seen);
    }
    const live = slots[Math.max(0, nStacks - 1)];
    this.deckPos = new THREE.Vector3(live.x, yTop + 0.25, live.z);
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
    // The just-discarded tile that YOU can claim (碰/杠/胡) is pulled out of the grid
    // and shown big/upright, front-center, so the choice is obvious.
    const pendingIdx = this.claimable && log.length ? log.length - 1 : -1;
    if (pendingIdx >= 0) {
      const d = log[pendingIdx];
      this._place('pool' + pendingIdx, {
        kind: d.kind, wild: game.isWild(d.kind), emissive: true, scale: 1.5, from: this._seatCenter(d.player),
        x: 0, y: TH * 0.9, z: 2.6, rx: this.faceCamRx, ry: 0, rz: 0, // face squarely toward the camera
      }, seen);
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
        const from = reveal ? this.deckPos
          : t.player === 0 ? new THREE.Vector3(x, TH * 0.35, R_HAND + 0.4)
          : this._seatCenter(t.player);
        this._place('pool' + t.i, {
          kind: t.kind, wild: game.isWild(t.kind), emissive: false, scale: POOL, from, draw: reveal,
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

  _loop() {
    const tick = () => {
      const dt = Math.min(this.clock.getDelta(), 0.05);
      const a = 1 - Math.exp(-13 * dt);
      for (const rec of this.tiles.values()) {
        const m = rec.mesh;
        const ts = rec.ts ?? 1;
        if (rec.drawSeq && this._animateDraw(rec, m)) continue; // reveal in progress
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
