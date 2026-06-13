// Sound effects synthesized with the Web Audio API — no audio files, so it works
// offline with zero extra assets and no licensing. The tile "clack" is a short
// band-passed noise burst (sounds like a tile hitting the table); calls and the
// win jingle are simple tone blips layered on a clack.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('mahjong-muted') === '1';
  }

  // Lazily create / resume the context — must be kicked off from a user gesture
  // (e.g. the 开始牌局 button) to satisfy browser autoplay policies.
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) try { this.ctx = new AC(); } catch {}
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  setMuted(m) { this.muted = m; localStorage.setItem('mahjong-muted', m ? '1' : '0'); }
  toggleMuted() { this.setMuted(!this.muted); return this.muted; }

  _noise(dur) {
    const ctx = this.ctx;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }
  _clack(t, { gain = 0.5, freq = 2000, dur = 0.06 } = {}) {
    const ctx = this.ctx;
    const src = this._noise(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t); src.stop(t + dur + 0.02);
  }
  _tone(t, freq, dur, gain = 0.25, type = 'triangle') {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  _play(fn) {
    if (this.muted) return;
    const ctx = this.resume();
    if (ctx) fn(ctx.currentTime);
  }

  discard() { this._play((t) => this._clack(t, { gain: 0.55, freq: 1850, dur: 0.075 })); }
  select()  { this._play((t) => this._clack(t, { gain: 0.14, freq: 3200, dur: 0.028 })); }
  pung()    { this._play((t) => { this._clack(t, { gain: 0.6, freq: 1450, dur: 0.08 }); this._tone(t, 330, 0.16, 0.16, 'sine'); }); }
  kong()    { this._play((t) => { this._clack(t, { gain: 0.6, freq: 1250, dur: 0.09 }); this._clack(t + 0.085, { gain: 0.5, freq: 1350, dur: 0.07 }); this._tone(t, 262, 0.22, 0.16, 'sine'); }); }
  win()     { this._play((t) => { this._clack(t, { gain: 0.4, freq: 1700, dur: 0.06 }); [523, 659, 784, 1047].forEach((f, i) => this._tone(t + 0.04 + i * 0.1, f, 0.34, 0.2, 'triangle')); }); }
  drawGame() { this._play((t) => this._tone(t, 300, 0.28, 0.14, 'sine')); }
}
