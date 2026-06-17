// Web Audio SFX (no files) + offline TTS for 斗地主, same approach as the mahjong sound layer.
// Voices use the device's built-in Chinese SpeechSynthesis (works offline on iOS): one profile
// per seat so the three players sound distinct. Muting is a single toggle.
let ctx = null;
let muted = false;
const seatPitch = [1.0, 1.85, 0.6]; // 玩家 / 下家(higher) / 上家(lower)

export function setMuted(m) { muted = !!m; }
export function isMuted() { return muted; }
export function resume() { try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch {} primeVoices(); }

function blip(freq, dur, type = 'sine', gain = 0.18) {
  if (muted) return;
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
  } catch {}
}

export const sfx = {
  play() { blip(420, 0.09, 'triangle', 0.14); blip(660, 0.07, 'triangle', 0.08); },
  pass() { blip(240, 0.12, 'sine', 0.10); },
  bomb() { blip(140, 0.5, 'sawtooth', 0.26); setTimeout(() => blip(90, 0.4, 'sawtooth', 0.2), 60); },
  rocket() { blip(180, 0.6, 'square', 0.24); setTimeout(() => blip(300, 0.5, 'square', 0.18), 80); },
  win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.22, 'triangle', 0.16), i * 110)); },
  lose() { [392, 330, 262].forEach((f, i) => setTimeout(() => blip(f, 0.26, 'sine', 0.14), i * 130)); },
  deal() { blip(520, 0.05, 'triangle', 0.08); },
};

// ---- TTS ----
let voices = [];
function primeVoices() { try { voices = speechSynthesis.getVoices() || []; } catch {} }
try { if (window.speechSynthesis) { primeVoices(); speechSynthesis.onvoiceschanged = primeVoices; } } catch {}
function zhVoice() { return voices.find((v) => /zh|cmn|Chinese/i.test(v.lang + v.name)) || null; }

export function say(text, seat = 0) {
  if (muted || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; const v = zhVoice(); if (v) u.voice = v;
    u.pitch = seatPitch[seat] ?? 1.0; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch {}
}
