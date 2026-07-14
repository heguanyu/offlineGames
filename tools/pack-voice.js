#!/usr/bin/env node
// Pack the per-clip voice WAVs into ONE "audio sprite" file per voice set, plus a
// manifest of slug -> { offset, duration } (seconds). The runtime decodes one buffer
// per set and plays each clip as a slice (AudioBufferSourceNode.start(when, offset,
// duration)), so the service worker fetches ~7 files instead of ~291 — the big
// per-file request count was what made a full offline update crawl.
//
// The raw per-clip WAVs stay in the repo (source of truth, and the loaders' per-file
// fallback). The packed output is GENERATED — it is
// git-ignored and produced by the CD pipeline (and can be run locally: `node
// tools/pack-voice.js`). Re-run whenever the raw clips change.
//
// All clips are PCM mono 24 kHz 16-bit (asserted below); packing just concatenates
// their PCM under one canonical WAV header — bit-identical audio, no re-encoding.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// trim: drop leading/trailing near-silence per clip so concatenated playback is
// gapless. 斗地主 speaks token sequences back-to-back (仨五带俩九) so it needs trimming;
// 天津/国标 play single whole clips, so they are packed untrimmed (behaviour-preserving).
const TARGETS = [
  { base: 'games/mahjong-common/voice', trim: false },
  { base: 'games/doudizhu/voice', trim: true },
  { base: 'games/guandan/voice', trim: true },   // 掼蛋 — skipped until its clips are generated
];

const SR = 24000, CH = 1, BITS = 16; // expected format of every clip

// Parse a canonical/extended WAV: walk the RIFF chunks to find `fmt ` + `data`.
function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a WAVE file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
              sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    p = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  return { fmt, pcm: data };
}

// Speech region (in samples) ignoring leading/trailing near-silence, mirroring the
// runtime speechRegion() in doudizhu/sound.js (thr ~ -38 dB, 6 ms pad).
function speechRegion(pcm, sr) {
  const n = pcm.length >> 1;             // 16-bit samples
  const thr = 0.012 * 32768;             // ~393
  let s = 0, e = n - 1;
  while (s < n && Math.abs(pcm.readInt16LE(s << 1)) < thr) s++;
  while (e > s && Math.abs(pcm.readInt16LE(e << 1)) < thr) e--;
  const pad = Math.floor(sr * 0.006);
  s = Math.max(0, s - pad); e = Math.min(n - 1, e + pad);
  return { start: s, len: Math.max(Math.floor(sr * 0.04), e - s) };
}

function writeWavHeader(dataLen) {
  const byteRate = SR * CH * BITS / 8, blockAlign = CH * BITS / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(CH, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(BITS, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

const round = (x) => Math.round(x * 1e6) / 1e6;

function packTarget({ base, trim }) {
  const dir = join(ROOT, base);
  // Skip gracefully if a game's clips aren't generated yet (so the CD pipeline + local runs don't break).
  if (!existsSync(dir)) { console.log(`${base}: no voice dir — skipped (clips not generated yet)`); return; }
  // Voice sets are the numeric subdirectories (0,1,2,3 = personas/seats).
  const sets = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => d.name).sort((a, b) => a - b);
  if (!sets.length) { console.log(`${base}: no voice sets — skipped`); return; }
  const outDir = join(dir, 'packed');
  mkdirSync(outDir, { recursive: true });

  const manifest = {};
  let totalIn = 0, totalOut = 0, clipCount = 0;
  for (const set of sets) {
    const setDir = join(dir, set);
    const slugs = readdirSync(setDir).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)).sort();
    const chunks = [];
    let cum = 0; // samples appended so far
    manifest[set] = {};
    for (const slug of slugs) {
      const { fmt, pcm } = readWav(readFileSync(join(setDir, slug + '.wav')));
      if (fmt.sampleRate !== SR || fmt.channels !== CH || fmt.bits !== BITS || fmt.audioFormat !== 1)
        throw new Error(`${base}/${set}/${slug}.wav: unexpected format ${JSON.stringify(fmt)}`);
      const clipSamples = pcm.length >> 1;
      const r = trim ? speechRegion(pcm, SR) : { start: 0, len: clipSamples };
      manifest[set][slug] = { offset: round((cum + r.start) / SR), duration: round(r.len / SR) };
      chunks.push(pcm);
      cum += clipSamples;
      clipCount++;
    }
    const data = Buffer.concat(chunks);
    const wav = Buffer.concat([writeWavHeader(data.length), data]);
    writeFileSync(join(outDir, `${set}.wav`), wav);
    totalIn += slugs.length; totalOut += wav.length;
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest));
  console.log(`${base}: ${clipCount} clips -> ${sets.length} sprites + manifest ` +
    `(${(totalOut / 1024 / 1024).toFixed(1)} MB, was ${totalIn} files)`);
}

for (const t of TARGETS) packTarget(t);
