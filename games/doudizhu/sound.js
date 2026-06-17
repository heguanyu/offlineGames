// Audio for 斗地主: Web Audio SFX (procedural blips) + VOICE.
//
// Voice uses PRE-RENDERED neural-TTS clips (generated once by tools/gen-voice.py, bundled for offline
// play) — one distinct voice per seat. The clips are ATOMS (仨, 五, 带, 俩, 九, 炸弹, 3分, 过, …) that
// speak() concatenates at runtime, so e.g. 仨五带俩九 plays five tiny clips back-to-back. If the clips
// aren't loaded yet (or are missing), speak() falls back to the device's SpeechSynthesis so there's
// always a voice. main.js passes token ARRAYS to speak().
let ctx = null;
let muted = false;
// Qwen3-TTS clips (good Mandarin); SpeechSynthesis remains the fallback if any clip is missing.
const USE_CLIPS = true;
const seatPitch = [1.0, 1.12, 0.92]; // MILD fallback TTS pitch per seat (extreme pitch sounded off)

export function setMuted(m) { muted = !!m; }
export function isMuted() { return muted; }
export function resume() {
  try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch {}
  primeVoices();
  if (!muted) preload();
}

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

// ---- voice clips -----------------------------------------------------------
const VOICE_BASE = new URL('./voice/', import.meta.url).href;
// token text -> filename slug (kept in sync with tools/gen-voice.py)
const SLUG = {
  '三': 'r3', '四': 'r4', '五': 'r5', '六': 'r6', '七': 'r7', '八': 'r8', '九': 'r9', '十': 'r10',
  '勾': 'rJ', '圈': 'rQ', 'K': 'rK', '尖': 'rA', '二': 'r2', '小王': 'jokerS', '大王': 'jokerB',
  '仨': 'sa',                                                    // plain trio still says 仨 + rank
  '俩三': 'dui3', '俩四': 'dui4', '俩五': 'dui5', '俩六': 'dui6', '俩七': 'dui7', '俩八': 'dui8',
  '俩九': 'dui9', '俩十': 'dui10', '俩勾': 'duiJ', '俩圈': 'duiQ', '俩K': 'duiK', '俩尖': 'duiA', '俩二': 'dui2',
  '三带一': 'tri1', '三带二': 'tri2',
  '串': 'chuan', '飞机': 'plane', '炸弹': 'bomb', '王炸': 'rocket', '四带二': 'four2',
  '1分': 'bid1', '2分': 'bid2', '3分': 'bid3', '过': 'guo', '我是地主': 'landlord',
};

const buffers = [{}, {}, {}]; // buffers[seat][slug] = { buf, offset, duration } (silence-trimmed)
let loaded = false, loading = false;
let activeSources = [];

function decode(ab) {
  return new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
}
// Find the speech region of a decoded clip, ignoring leading/trailing silence — INCLUDING the ~25ms
// of MP3 encoder-delay silence that ffmpeg can't remove. This is what makes concatenation gapless.
function speechRegion(buf) {
  const d = buf.getChannelData(0), n = d.length, sr = buf.sampleRate, thr = 0.012; // ~ -38dB
  let s = 0, e = n - 1;
  while (s < n && Math.abs(d[s]) < thr) s++;
  while (e > s && Math.abs(d[e]) < thr) e--;
  const pad = Math.floor(sr * 0.006);
  s = Math.max(0, s - pad); e = Math.min(n - 1, e + pad);
  return { buf, offset: s / sr, duration: Math.max(0.04, (e - s) / sr) };
}
async function preload() {
  if (!USE_CLIPS || loaded || loading || !ctx) return;
  loading = true;
  const slugs = [...new Set(Object.values(SLUG))];
  const jobs = [];
  for (let seat = 0; seat < 3; seat++) for (const slug of slugs) {
    jobs.push(fetch(`${VOICE_BASE}${seat}/${slug}.wav`).then((r) => r.arrayBuffer()).then(decode)
      .then((buf) => { buffers[seat][slug] = speechRegion(buf); }).catch(() => {}));
  }
  await Promise.all(jobs);
  loaded = true; loading = false;
}

function stopVoice() {
  for (const s of activeSources) { try { s.stop(); } catch {} }
  activeSources = [];
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch {}
}

// Speak a sequence of tokens in `seat`'s voice. Plays the bundled clips when ready; else falls back
// to SpeechSynthesis. RETURNS the estimated duration in ms (exact for clips; char-based for the
// fallback; 0 when muted) so callers can wait for the call to finish before the next turn.
export function speak(tokens, seat = 0) {
  if (muted || !tokens || !tokens.length) return 0;
  resume();
  stopVoice();
  const slugs = tokens.map((t) => SLUG[t]);
  const ready = USE_CLIPS && ctx && loaded && slugs.every((s) => s && buffers[seat][s]);
  if (ready) {
    const start = Math.max(ctx.currentTime, 0) + 0.02;
    let t = start, end = start;
    for (const s of slugs) {
      const clip = buffers[seat][s]; // { buf, offset, duration } — precisely the speech, no silence
      const src = ctx.createBufferSource(); src.buffer = clip.buf;
      src.connect(ctx.destination); src.start(t, clip.offset, clip.duration);
      activeSources.push(src);
      end = t + clip.duration;
      t += clip.duration - 0.015; // a hair of overlap so syllables run together with no seam
    }
    return Math.round((end - ctx.currentTime) * 1000);
  }
  sayTTS(tokens.join(''), seat);
  return 200 + [...tokens.join('')].length * 230; // estimate by character count
}

// ---- SpeechSynthesis fallback ----------------------------------------------
let voices = [];
function primeVoices() { try { voices = speechSynthesis.getVoices() || []; } catch {} }
try { if (window.speechSynthesis) { primeVoices(); speechSynthesis.onvoiceschanged = primeVoices; } } catch {}
function zhVoice() { return voices.find((v) => /zh|cmn|Chinese/i.test(v.lang + v.name)) || null; }
function sayTTS(text, seat = 0) {
  if (muted || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; const v = zhVoice(); if (v) u.voice = v;
    u.pitch = seatPitch[seat] ?? 1.0; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch {}
}
