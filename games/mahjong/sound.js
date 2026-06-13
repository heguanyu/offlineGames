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
  setMuted(m) {
    this.muted = m;
    localStorage.setItem('mahjong-muted', m ? '1' : '0');
    if (m) this._stopMusicNodes();
    else if (this._musicWanted) this.startMusic();
  }
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

  // --- Immersive background music (looping ambient pad), used while 听牌 ---
  // A slow Am–F–C–G pad with a soft bass drone, synthesized so it stays offline.
  startMusic() {
    this._musicWanted = true;
    if (this.muted || this._musicOn) return;
    const ctx = this.resume();
    if (!ctx) return;
    this._musicOn = true;
    this._musicBus = ctx.createGain();
    this._musicBus.gain.setValueAtTime(0.0001, ctx.currentTime);
    this._musicBus.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 2.0); // gentle fade-in
    this._musicBus.connect(ctx.destination);
    // [chord, bass] frequencies for each bar
    const bars = [
      { chord: [220.0, 261.63, 329.63], bass: 110.0 }, // Am
      { chord: [174.61, 220.0, 261.63], bass: 87.31 },  // F
      { chord: [261.63, 329.63, 392.0], bass: 130.81 }, // C
      { chord: [196.0, 246.94, 293.66], bass: 98.0 },   // G
    ];
    const BAR = 3.4;
    let i = 0;
    const tick = () => {
      if (!this._musicOn) return;
      const b = bars[i % bars.length]; i++;
      const t = this.ctx.currentTime + 0.05;
      // pad chord — soft triangles with long attack/release, overlapping for legato
      for (const f of b.chord) {
        const o = this.ctx.createOscillator();
        o.type = 'triangle'; o.frequency.value = f;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16, t + 1.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + BAR + 0.3);
        o.connect(g).connect(this._musicBus);
        o.start(t); o.stop(t + BAR + 0.4);
      }
      // bass drone
      const bo = this.ctx.createOscillator();
      bo.type = 'sine'; bo.frequency.value = b.bass;
      const bg = this.ctx.createGain();
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.exponentialRampToValueAtTime(0.22, t + 0.6);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + BAR + 0.2);
      bo.connect(bg).connect(this._musicBus);
      bo.start(t); bo.stop(t + BAR + 0.3);
      this._musicTimer = setTimeout(tick, BAR * 1000);
    };
    tick();
  }
  // Stop the audio nodes but keep "wanted" intent (so unmuting can resume).
  _stopMusicNodes() {
    if (!this._musicOn) return;
    this._musicOn = false;
    clearTimeout(this._musicTimer);
    if (this._musicBus && this.ctx) {
      const t = this.ctx.currentTime;
      try {
        this._musicBus.gain.cancelScheduledValues(t);
        this._musicBus.gain.setValueAtTime(Math.max(0.0001, this._musicBus.gain.value), t);
        this._musicBus.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      } catch {}
      const bus = this._musicBus;
      setTimeout(() => { try { bus.disconnect(); } catch {} }, 1000);
    }
    this._musicBus = null;
  }
  // Fully stop (no longer wanted) — call when the 听 hand ends.
  stopMusic() { this._musicWanted = false; this._stopMusicNodes(); }
}
