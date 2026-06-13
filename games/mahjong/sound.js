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
  // Resolves the 听牌 tension: a low boom (echoing the drone) and tile slap, an
  // ascending pentatonic run, then a bright major bloom with a gong-like shimmer.
  win() {
    this._play((t) => {
      this._tone(t, 64, 0.45, 0.3, 'sine');                       // deep boom
      this._clack(t, { gain: 0.42, freq: 1550, dur: 0.06 });      // tile slap
      const run = [523.25, 587.33, 659.25, 783.99, 880.0];        // C D E G A
      run.forEach((f, i) => this._tone(t + 0.05 + i * 0.07, f, 0.26, 0.16, 'triangle'));
      const t2 = t + 0.05 + run.length * 0.07;                    // resolution lands here
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => this._tone(t2, f, 1.3, 0.17, 'triangle')); // C E G C
      [1318.5, 1567.98, 2093.0].forEach((f, i) => this._tone(t2 + 0.09 + i * 0.06, f, 1.1, 0.07, 'sine')); // shimmer
    });
  }
  // Someone else won (you lost / 点炮): a descending minor cadence landing on a
  // low minor chord + a dull thud — clearly the opposite of the win bloom.
  lose() {
    this._play((t) => {
      this._clack(t, { gain: 0.28, freq: 1050, dur: 0.05 });          // soft tile slap
      const run = [392.0, 349.23, 311.13, 261.63];                    // G F Eb C — descending
      run.forEach((f, i) => this._tone(t + 0.05 + i * 0.14, f, 0.34, 0.16, 'triangle'));
      const t2 = t + 0.05 + run.length * 0.14;
      [130.81, 155.56, 196.0].forEach((f) => this._tone(t2, f, 1.1, 0.15, 'sine')); // low C-minor chord
      this._tone(t2, 65, 0.55, 0.2, 'sine');                         // dull low thud
    });
  }
  drawGame() { this._play((t) => this._tone(t, 300, 0.28, 0.14, 'sine')); }

  // --- Immersive 紧张感 (tension) music, looped while 听牌 ---
  // A held tone on the music bus (used for drones / swells / risers).
  _busNote(t, freq, peak, dur, { type = 'sine', attack = 0.04, dest } = {}) {
    const ctx = this.ctx;
    const out = dest || this._musicBus || ctx.destination;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  // A "lub-dub" heartbeat: a low sine punch plus a short low-mid noise body so
  // it's still audible on small (iPad) speakers that roll off deep bass.
  _heartbeat(t) {
    const ctx = this.ctx, out = this._musicBus || ctx.destination;
    const beat = (tt, peak) => {
      this._busNote(tt, 58, peak, 0.18, { type: 'sine', attack: 0.004 });
      const n = this._noise(0.12);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 140; bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(peak * 0.55, tt + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.12);
      n.connect(bp).connect(g).connect(out);
      n.start(tt); n.stop(tt + 0.14);
    };
    beat(t, 0.5);          // lub
    beat(t + 0.17, 0.32);  // dub
  }
  startMusic() {
    this._musicWanted = true;
    if (this.muted || this._musicOn) return;
    const ctx = this.resume();
    if (!ctx) return;
    this._musicOn = true;
    this._musicPhase = 0;
    this._musicBus = ctx.createGain();
    this._musicBus.gain.setValueAtTime(0.0001, ctx.currentTime);
    this._musicBus.gain.exponentialRampToValueAtTime(0.45, ctx.currentTime + 2.2); // fade-in
    this._musicBus.connect(ctx.destination);
    // Descending lament bass (A–G–F–E): a classic dread/tension figure.
    const roots = [55.0, 49.0, 43.65, 41.2];
    const BEAT = 0.6, BAR = 4 * BEAT; // ~2.4s, anxious heartbeat tempo
    const tick = () => {
      if (!this._musicOn) return;
      const ph = this._musicPhase++;
      const root = roots[ph % roots.length];
      const t = ctx.currentTime + 0.06;
      // heartbeat on beats 1 and 3
      this._heartbeat(t);
      this._heartbeat(t + 2 * BEAT);
      // low drone: root + fifth, sustained across the bar
      this._busNote(t, root, 0.13, BAR + 0.3, { type: 'triangle', attack: 0.5 });
      this._busNote(t, root * 1.5, 0.08, BAR + 0.3, { type: 'triangle', attack: 0.6 });
      // tritone swell two octaves up (the "diabolus" — unease), peaks mid-bar
      this._busNote(t, root * 4 * Math.pow(2, 6 / 12), 0.05, BAR, { type: 'sawtooth', attack: BAR * 0.5 });
      // every 4 bars: a slow low-passed riser that builds, then resets — suspense
      if (ph % 4 === 0) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(110, t);
        o.frequency.linearRampToValueAtTime(165, t + 4 * BAR);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.035, t + 4 * BAR * 0.85);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 4 * BAR);
        o.connect(lp).connect(g).connect(this._musicBus);
        o.start(t); o.stop(t + 4 * BAR + 0.1);
      }
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
