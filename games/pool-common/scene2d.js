// Flat 2D billiards renderer (phones / 省电 eco tier) — one <canvas> 2D context, no WebGL,
// repaint-on-demand only. Same public interface as PoolScene3D so main/app code doesn't care.
// The whole frame is drawn in PHYSICS coordinates (meters, origin at table center) under a
// fit-to-viewport transform; on portrait screens the table rotates 90° to use the height.

export class PoolScene2D {
  constructor(canvas, spec, balls) {
    this.canvas = canvas; this.spec = spec; this.balls = balls;
    this.ctx = canvas.getContext('2d');
    this._aim = null; this._ghost = null; this._region = null;
    this._cueAnim = null; this._sink = new Map();            // id → sink progress
    this._shown = new Map(balls.map((b) => [b.id, b.inPlay]));
    this._running = false;
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  _resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = Math.max(1, el.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.dpr = dpr; this.cssW = w; this.cssH = h;
    this.rot = h > w;                                        // portrait → rotate the table 90°
    const M = 0.19;                                          // world margin (wood frame + breathing room)
    const tw = this.spec.L + M * 2, th = this.spec.W + M * 2;
    const fitW = this.rot ? th : tw, fitH = this.rot ? tw : th;
    this.scale = Math.min(w / fitW, h / fitH);
    this.kick();
  }

  _setT() {                                                  // canvas transform: world meters → px
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.translate(this.cssW / 2, this.cssH / 2);
    c.scale(this.scale, this.scale);
    if (this.rot) c.rotate(Math.PI / 2);
  }

  worldFromEvent(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    let px = (clientX - r.left - this.cssW / 2) / this.scale;
    let py = (clientY - r.top - this.cssH / 2) / this.scale;
    return this.rot ? { x: py, y: -px } : { x: px, y: py };
  }

  reset(balls) {
    this.balls = balls;
    this._shown = new Map(balls.map((b) => [b.id, b.inPlay]));
    this._sink.clear();
    this.kick();
  }

  syncBalls() {
    for (const b of this.balls) {
      const was = this._shown.get(b.id);
      if (was && !b.inPlay) this._sink.set(b.id, { t0: performance.now(), pocket: b.pocket ?? 0, x: b.x, y: b.y });
      this._shown.set(b.id, b.inPlay);
    }
    this.kick();
  }
  setAim(aim) { this._aim = aim; this.kick(); }
  setGhost(g) { this._ghost = g; this.kick(); }
  setRegion(r) { this._region = r; this.kick(); }

  strike(aim, onImpact) {
    this._cueAnim = { aim, t0: performance.now(), fired: false, onImpact };
    this.kick();
  }

  kick() {
    if (this._running) return;
    this._running = true;
    requestAnimationFrame(() => this._anim());
  }
  _anim() {
    const active = this._draw(performance.now());
    if (active) requestAnimationFrame(() => this._anim());
    else this._running = false;
  }

  _draw(now) {
    const c = this.ctx, s = this.spec, r = s.ballR;
    let active = false;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#101418';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this._setT();

    // wood frame
    const RW = 0.055, FW = 0.10;
    c.fillStyle = s.railColor;
    this._rr(-s.hx - RW - FW, -s.hy - RW - FW, (s.hx + RW + FW) * 2, (s.hy + RW + FW) * 2, 0.09);
    c.fill();
    // felt (incl. under the cushions)
    c.fillStyle = s.feltColor;
    c.fillRect(-s.hx - RW, -s.hy - RW, (s.hx + RW) * 2, (s.hy + RW) * 2);

    // markings
    c.strokeStyle = c.fillStyle = s.clothLine || 'rgba(255,255,255,0.7)';
    c.lineWidth = 0.004;
    const spot = (x, y) => { c.beginPath(); c.arc(x, y, 0.007, 0, Math.PI * 2); c.fill(); };
    if (s.markings?.kitchen) {
      c.beginPath(); c.moveTo(s.kitchenX, -s.hy); c.lineTo(s.kitchenX, s.hy); c.stroke();
      spot(s.markings.footSpot, 0);
    }
    if (s.markings?.baulk) {
      c.beginPath(); c.moveTo(s.baulkX, -s.hy); c.lineTo(s.baulkX, s.hy); c.stroke();
      c.beginPath(); c.arc(s.baulkX, 0, s.dR, Math.PI / 2, Math.PI * 1.5); c.stroke();
      for (const p of s.markings.spots) spot(p.x, p.y);
    }
    // placement region tint
    if (this._region && this._region !== 'anywhere') {
      c.fillStyle = 'rgba(255,255,255,0.08)';
      if (this._region === 'kitchen') c.fillRect(-s.hx, -s.hy, s.kitchenX + s.hx, s.W);
      else { c.beginPath(); c.arc(s.baulkX, 0, s.dR, Math.PI / 2, Math.PI * 1.5); c.closePath(); c.fill(); }
    }

    // cushions (the physics segments, drawn as fat dark-felt lines)
    c.strokeStyle = this._shade(s.feltColor, 0.72);
    c.lineWidth = RW * 1.6; c.lineCap = 'butt';
    for (const seg of s.cushions) {
      // offset the stroke along the segment's outward normal so its inner edge hugs the nose line
      const ox = seg.nx * RW * 0.8, oy = seg.ny * RW * 0.8;
      c.beginPath(); c.moveTo(seg.ax + ox, seg.ay + oy); c.lineTo(seg.bx + ox, seg.by + oy); c.stroke();
    }

    // pockets
    for (const p of s.pockets) {
      const g = c.createRadialGradient(p.x, p.y, p.r * 0.2, p.x, p.y, p.r * 1.1);
      g.addColorStop(0, '#000'); g.addColorStop(1, '#1c130b');
      c.fillStyle = g;
      c.beginPath(); c.arc(p.x, p.y, p.r * 1.05, 0, Math.PI * 2); c.fill();
    }

    // aim assist (under the balls)
    if (this._aim) {
      const { from, predict } = this._aim;
      c.save();
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = 0.012; c.lineCap = 'round';
      c.setLineDash([0.001, 0.045]);
      c.beginPath(); c.moveTo(from.x, from.y); c.lineTo(predict.contact.x, predict.contact.y); c.stroke();
      if (predict.type === 'ball') {
        c.strokeStyle = 'rgba(255,226,122,0.95)';
        c.beginPath(); c.moveTo(predict.ballFrom.x, predict.ballFrom.y);
        c.lineTo(predict.ballFrom.x + predict.ballDir.x * 0.3, predict.ballFrom.y + predict.ballDir.y * 0.3); c.stroke();
        c.setLineDash([]);
        c.lineWidth = 0.006;
        c.strokeStyle = 'rgba(255,255,255,0.7)';
        c.beginPath(); c.arc(predict.contact.x, predict.contact.y, r, 0, Math.PI * 2); c.stroke();
      }
      c.restore();
    }

    // balls
    for (const b of this.balls) {
      if (!b.inPlay) {
        const sk = this._sink.get(b.id);
        if (sk) {
          const k = Math.min(1, (now - sk.t0) / 220);
          const p = s.pockets[sk.pocket];
          this._ball(c, sk.x + (p.x - sk.x) * k, sk.y + (p.y - sk.y) * k, r * (1 - k * 0.8), b);
          if (k >= 1) this._sink.delete(b.id); else active = true;
        }
        continue;
      }
      this._ball(c, b.x, b.y, r, b);
    }

    // ball-in-hand ghost
    if (this._ghost) {
      c.globalAlpha = 0.55;
      this._ball(c, this._ghost.x, this._ghost.y, r, { color: this._ghost.ok ? '#ffffff' : '#ff5a5a', number: null, stripe: false });
      c.globalAlpha = 1;
    }

    // cue stick
    let cueAim = this._aim, pull = cueAim ? 0.05 + cueAim.power * 0.2 : 0;
    if (this._cueAnim) {
      const a = this._cueAnim, k = Math.min(1, (now - a.t0) / 95);
      cueAim = a.aim; pull = (0.05 + a.aim.power * 0.2) * (1 - k * k);
      if (k >= 1 && !a.fired) { a.fired = true; a.onImpact(); this._cueAnim = null; cueAim = null; }
      else active = true;
    }
    if (cueAim) this._cue(c, cueAim, pull);

    return active;
  }

  _cue(c, aim, pull) {
    const r = this.spec.ballR, LEN = Math.max(1.0, this.spec.L * 0.5);
    const d = aim.dir;
    const bx = aim.from.x - d.x * (r * 1.6 + pull), by = aim.from.y - d.y * (r * 1.6 + pull);
    const ex = bx - d.x * LEN, ey = by - d.y * LEN;
    const px = -d.y, py = d.x;
    const tw = 0.006, bw = 0.015;                            // tip / butt half-widths
    const g = c.createLinearGradient(bx, by, ex, ey);
    g.addColorStop(0, '#e8cfa0'); g.addColorStop(0.5, '#c89a5e'); g.addColorStop(0.75, '#7a4a24'); g.addColorStop(1, '#33200f');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(bx + px * tw, by + py * tw); c.lineTo(ex + px * bw, ey + py * bw);
    c.lineTo(ex - px * bw, ey - py * bw); c.lineTo(bx - px * tw, by - py * tw);
    c.closePath(); c.fill();
    c.fillStyle = '#2c5f8a';                                 // tip
    c.beginPath(); c.arc(bx, by, tw * 1.15, 0, Math.PI * 2); c.fill();
  }

  _ball(c, x, y, r, b) {
    if (b.stripe) {
      c.fillStyle = '#f6f3ec';
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.save();
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.clip();
      c.fillStyle = b.color;
      c.fillRect(x - r, y - r * 0.55, r * 2, r * 1.1);
      c.restore();
    } else {
      c.fillStyle = b.color;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
    if (b.number != null) {
      c.fillStyle = '#f6f3ec';
      c.beginPath(); c.arc(x, y, r * 0.52, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#181818';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `700 ${r * 0.78}px Arial, sans-serif`;
      c.save(); c.translate(x, y); if (this.rot) c.rotate(-Math.PI / 2);
      c.fillText(String(b.number), 0, r * 0.05); c.restore();
    }
    // glossy highlight
    const g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.35, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }

  _rr(x, y, w, h, rad) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + rad, y);
    c.arcTo(x + w, y, x + w, y + h, rad); c.arcTo(x + w, y + h, x, y + h, rad);
    c.arcTo(x, y + h, x, y, rad); c.arcTo(x, y, x + w, y, rad);
    c.closePath();
  }
  _shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.round(Math.max(0, Math.min(255, v * k)));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  destroy() { window.removeEventListener('resize', this._resize); }
}
