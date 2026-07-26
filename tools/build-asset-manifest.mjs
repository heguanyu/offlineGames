// Media/heavy asset manifest — content hashes for the big REQUIRED files, grouped into modules.
//
// The problem: sw.js precaches into a cache named for the app VERSION, so every deploy re-downloads
// everything in it. Of the 16.6 MB in that list, ~14 MB is voice sprites and tile/card images — files
// that change only when the artwork or the recordings change, which is almost never. So a one-line fix
// to a game cost every user sixteen megabytes, and on a weak link the update never finished.
//
// These assets are REQUIRED (a mahjong table with no tile images is not a game), so they are not made
// optional or lazy. They are versioned by CONTENT instead of by app version and kept in a cache bucket
// that SURVIVES the version bump, so a release re-downloads only what actually changed.
//
// MODULES exist because the two kinds age differently and are worth reasoning about separately:
//   voice  — packed audio sprites (tools/pack-voice.js output). Regenerated on every deploy but
//            byte-identical unless a clip changed, so they hash the same and never re-transfer.
//   image  — tile faces, card faces, table textures, icons.
//   lib    — third-party runtime too big to re-ship every release (three.js).
// One bucket holds them all, keyed by path, so assets shared between the full hub and a sub-hub
// (mahjong-common voice is in BOTH sw.js and sw-mj.js today) are stored and fetched exactly once.
//
//   node tools/build-asset-manifest.mjs        (run AFTER tools/pack-voice.js — it hashes its output)
//
// Output — assets.json at the repo root: { built, assets: [ { path, ver, bytes, module } ] }

import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'assets.json';

// Only files at or above this size are worth the round trip of a separate manifest entry; below it,
// leaving them in the version-keyed precache costs less than tracking them.
const MIN_BYTES = 24 * 1024;

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const AUDIO = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.opus']);

/** Which module a path belongs to, or null if it stays in the version-keyed precache. */
export function moduleOf(path, bytes) {
  const ext = extname(path).toLowerCase();
  if (AUDIO.has(ext)) return 'voice';                       // every clip, regardless of size
  if (bytes < MIN_BYTES) return null;
  if (IMAGE.has(ext)) return 'image';
  if (/\/(lib|vendor)\//.test(path) && ext === '.js') return 'lib';
  return null;
}

// The MEDIA list in sw.js is the single source of truth for what belongs in this manifest — the worker
// and the manifest must agree exactly, or the install would either skip a required file or ask for one
// that has no hash. test/asset-manifest-test.mjs enforces that agreement.
export async function mediaPaths() {
  const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const arr = /const MEDIA = \[([\s\S]*?)\n\];/.exec(sw);
  if (!arr) throw new Error('could not locate the MEDIA array in sw.js');
  return [...arr[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)]
    .map((m) => m[1].replace(/^\.\//, ''))
    .filter(Boolean);
}

export async function buildAssetManifest() {
  const assets = [];
  for (const path of await mediaPaths()) {
    const st = await stat(join(ROOT, path));   // a MEDIA entry that isn't there is a build error
    const bytes = await readFile(join(ROOT, path));
    assets.push({
      path,
      ver: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      bytes: bytes.length,
      module: moduleOf(path, st.size) || 'other',
    });
  }
  assets.sort((a, b) => a.path.localeCompare(b.path));
  return { built: new Date().toISOString().slice(0, 10), assets };
}

export async function writeAssetManifest() {
  const m = await buildAssetManifest();
  await writeFile(join(ROOT, OUT), JSON.stringify(m));
  return m;
}

async function main() {
  const m = await writeAssetManifest();
  const byModule = {};
  for (const a of m.assets) {
    const s = (byModule[a.module] ||= { n: 0, b: 0 });
    s.n++; s.b += a.bytes;
  }
  const total = m.assets.reduce((n, a) => n + a.bytes, 0);
  console.log(`[assets] ${m.assets.length} files, ${(total / 1048576).toFixed(2)} MB — content-versioned, no longer re-downloaded on a version bump`);
  for (const [k, v] of Object.entries(byModule).sort((a, b) => b[1].b - a[1].b)) {
    console.log(`  ${k.padEnd(6)} ${String(v.n).padStart(4)} files  ${(v.b / 1048576).toFixed(2)} MB`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
}
