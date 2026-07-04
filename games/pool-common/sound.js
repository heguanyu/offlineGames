// Procedural billiards SFX — pure Web Audio, no clip assets (same approach as the card games'
// oscillator blips, but shaped for billiards: ball-ball clicks, cushion thuds, pocket drops).
// Volumes scale with impact speed; rapid collisions are rate-limited so a break doesn't stack
// forty clicks into clipping.

let ctx = null;
let muted = false;
const KEY = 'pool-mute';
try { muted = localStorage.getItem(KEY) === '1'; } catch {}

function ac() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
  if (ctx && ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function unlock() { ac(); }         // call on first user gesture (iOS)
export function isMuted() { return muted; }
export function setMuted(m) { muted = m; try { localStorage.setItem(KEY, m ? '1' : '0'); } catch {} }

let noiseBuf = null;
function noise(c) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 0.1, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource(); s.buffer = noiseBuf; return s;
}

// A band-passed noise burst — the building block for clicks and thuds.
function burst(freq, q, dur, vol, delay = 0) {
  const c = ac(); if (!c || muted || vol <= 0.01) return;
  const t = c.currentTime + delay;
  const src = noise(c);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(bp); bp.connect(g); g.connect(c.destination);
  src.start(t); src.stop(t + dur + 0.02);
}
function tone(freq, dur, vol, type = 'sine', delay = 0) {
  const c = ac(); if (!c || muted || vol <= 0.01) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

// rate limiter: at most one hit/rail sound per 35 ms
let lastHit = 0, lastRail = 0;
const vol = (v, k) => Math.min(1, v / k);

export const sfx = {
  hit(v) {                                  // ball–ball: bright phenolic click
    const now = performance.now(); if (now - lastHit < 35) return; lastHit = now;
    const a = vol(v, 5);
    burst(3400, 2.5, 0.035, 0.5 * a);
    burst(6800, 3, 0.02, 0.25 * a);
  },
  rail(v) {                                 // cushion: dull rubbery thud
    const now = performance.now(); if (now - lastRail < 50) return; lastRail = now;
    const a = vol(v, 4);
    burst(240, 1.2, 0.07, 0.4 * a);
    burst(900, 2, 0.03, 0.12 * a);
  },
  pot() {                                   // pocket: knock + leather drop
    burst(1800, 2, 0.03, 0.35);
    burst(300, 1.5, 0.09, 0.5, 0.03);
    tone(130, 0.14, 0.35, 'sine', 0.05);
  },
  cue(v) {                                  // cue tip strike
    burst(2200, 2, 0.03, 0.45 * vol(v, 6));
    burst(500, 1.5, 0.04, 0.2 * vol(v, 6));
  },
  place() { burst(1200, 3, 0.03, 0.2); }    // ball-in-hand set-down
  ,
  foul() { tone(220, 0.18, 0.25, 'square'); tone(165, 0.22, 0.25, 'square', 0.16); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 0.3, 'triangle', i * 0.13)); },
  lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.26, 0.28, 'triangle', i * 0.16)); },
};
