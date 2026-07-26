// Content-versioned media test: the MEDIA split, the manifest that versions it, and the service
// worker's two-phase install. Usage: node test/asset-manifest-test.mjs   (no browser needed)
//
// What this guards is the reason the split exists: sw.js precaches into a cache named for the app
// VERSION, so a release used to re-download all 16.6 MB of it — ~15 MB of which is voice sprites and
// artwork that had not changed in months. Those files are REQUIRED (a mahjong table with no tile
// images is not a game), so they are still guaranteed by the install; they are just versioned by
// content in a bucket that survives the version bump. The failure modes worth pinning:
//   - a stale manifest (the worker would skip media that really did change)
//   - MEDIA and the manifest drifting apart
//   - a file left in both tiers (downloads twice, defeats the point)
//   - activate deleting the media bucket (every release pays full price again)
//   - the install re-fetching media whose hash is unchanged
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } };

execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-asset-manifest.mjs')], { stdio: 'inherit' });

const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets.json'), 'utf8'));
const listOf = (src, name) => [...src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`))[1]
  .replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''));
const ASSETS = listOf(sw, 'ASSETS');
const MEDIA = listOf(sw, 'MEDIA');

// ---- the manifest describes exactly the MEDIA list, accurately ----------------------------------
console.log('manifest');
ok(MEDIA.length > 40, `MEDIA holds the bulk of the weight (${MEDIA.length} files)`);
ok(JSON.stringify(manifest.assets.map((a) => a.path).sort()) === JSON.stringify([...MEDIA].sort()),
  'assets.json lists exactly the MEDIA entries');

const wrong = [];
for (const a of manifest.assets) {
  const buf = fs.readFileSync(path.join(ROOT, a.path));
  const ver = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  if (ver !== a.ver) wrong.push(`${a.path}: manifest ${a.ver} vs actual ${ver}`);
  if (buf.length !== a.bytes) wrong.push(`${a.path}: bytes ${a.bytes} vs actual ${buf.length}`);
}
ok(wrong.length === 0, `every hash matches the file on disk (${wrong.join('; ')})`);

const dupes = MEDIA.filter((m) => ASSETS.includes(m));
ok(dupes.length === 0, `nothing is in both tiers (${dupes.join(', ')})`);

const mods = new Set(manifest.assets.map((a) => a.module));
ok(mods.has('voice') && mods.has('image'), `voice and image are their own modules (${[...mods].join(', ')})`);
const bytesOf = (m) => manifest.assets.filter((a) => a.module === m).reduce((n, a) => n + a.bytes, 0);
ok(bytesOf('voice') > 4 * 1048576, `the voice module is worth splitting (${(bytesOf('voice') / 1048576).toFixed(1)} MB)`);
ok(bytesOf('image') > 3 * 1048576, `the image module is worth splitting (${(bytesOf('image') / 1048576).toFixed(1)} MB)`);

const precacheBytes = ASSETS.map((a) => {
  const p = a === '' || a.endsWith('/') ? a + 'index.html' : a;
  try { return fs.statSync(path.join(ROOT, p)).size; } catch { return 0; }
}).reduce((n, b) => n + b, 0);
ok(precacheBytes < 3 * 1048576, `the per-release precache is small (${(precacheBytes / 1048576).toFixed(2)} MB)`);

// ---- the packed voice output is byte-stable, or hashing it would be pointless --------------------
console.log('voice packing');
const voiceFiles = MEDIA.filter((m) => m.endsWith('.wav'));
const before = voiceFiles.map((f) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'));
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'pack-voice.js')], { stdio: 'pipe' });
const after = voiceFiles.map((f) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'));
ok(JSON.stringify(before) === JSON.stringify(after),
  're-packing the voice sprites is deterministic — otherwise every deploy would re-ship 8.5 MB');

// ---- sw.js wiring --------------------------------------------------------------------------------
console.log('service worker');
ok(/k !== CACHE && k !== MEDIA_CACHE/.test(sw), 'activate keeps the media bucket across a version bump');
ok(/p === '\/assets\.json'/.test(sw), 'the manifest itself is never served from cache');
ok(/const MEDIA_CACHE = 'offline-games-media'/.test(sw), 'the media bucket has a version-independent name');

// ---- the two-phase install, run in a fake worker scope --------------------------------------------
function bootWorker(net) {
  const listeners = new Map();
  const state = { skipWaitingCalls: 0 };
  const buckets = new Map();
  const bucket = (name) => {
    if (!buckets.has(name)) {
      const entries = new Map();
      buckets.set(name, {
        entries,
        async put(req, res) { entries.set(String(req.url || req), res); },
        async match(req) { return entries.get(String(req.url || req)); },
        async keys() { return [...entries.keys()]; },
        async delete(req) { return entries.delete(String(req.url || req)); },
      });
    }
    return buckets.get(name);
  };
  const cachesShim = {
    buckets,
    async open(n) { return bucket(n); },
    async keys() { return [...buckets.keys()]; },
    async delete(n) { return buckets.delete(n); },
    async match(r) { for (const b of buckets.values()) { const h = await b.match(r); if (h) return h; } },
  };
  const selfShim = {
    addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) || []), fn]),
    skipWaiting: async () => { state.skipWaitingCalls++; },
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  new Function('self', 'caches', 'fetch', 'location', 'Response', 'indexedDB', sw)(
    selfShim, cachesShim, net, { origin: 'http://localhost' }, Response, undefined);
  return {
    caches: cachesShim, state,
    dispatch: (type) => { let w = Promise.resolve(); const ev = { waitUntil: (p) => { w = p; } };
      for (const fn of listeners.get(type) || []) fn(ev); return w; },
  };
}
const resBody = (text) => ({
  ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? String(text.length) : null) },
  clone() { return this; }, async blob() { return { size: text.length }; },
  async text() { return text; }, async json() { return JSON.parse(text); },
});
const netFor = (requests) => (url) => {
  const p = new URL(url, 'http://localhost').pathname;
  requests.push(p);
  if (p === '/assets.json') return resBody(JSON.stringify(manifest));
  return resBody('x'.repeat(8));
};
const isMedia = (p) => MEDIA.includes(p.replace(/^\//, ''));

const r1 = [];
const w1 = bootWorker(netFor(r1));
await w1.dispatch('install');
ok(w1.state.skipWaitingCalls === 1, 'a first install completes');
ok(r1.filter(isMedia).length === MEDIA.length, `it fetches all ${MEDIA.length} media files`);
const mediaBucket = await w1.caches.open('offline-games-media');
ok((await mediaBucket.match('./__media-versions')) !== undefined, 'it records what the bucket holds');

// A second worker (i.e. the next release) inherits the bucket — nothing unchanged may move again.
const r2 = [];
const w2 = bootWorker(netFor(r2));
w2.caches.buckets.set('offline-games-media', mediaBucket);
await w2.dispatch('install');
ok(r2.filter(isMedia).length === 0,
  `a version bump with unchanged media re-downloads NONE of it (fetched ${r2.filter(isMedia).length})`);
ok(r2.includes('/assets.json'), 'it still checks the manifest — it just finds nothing to do');
ok(w2.state.skipWaitingCalls === 1, 'and it still activates');

// Change one hash: exactly that one file comes down again.
const changed = manifest.assets.find((a) => a.module === 'image');
const bumped = { ...manifest, assets: manifest.assets.map((a) => (a.path === changed.path ? { ...a, ver: 'CHANGED0000' } : a)) };
const r3 = [];
const w3 = bootWorker((url) => {
  const p = new URL(url, 'http://localhost').pathname;
  r3.push(p);
  if (p === '/assets.json') return resBody(JSON.stringify(bumped));
  return resBody('x'.repeat(8));
});
w3.caches.buckets.set('offline-games-media', mediaBucket);
await w3.dispatch('install');
ok(JSON.stringify(r3.filter(isMedia)) === JSON.stringify(['/' + changed.path]),
  `only the changed file is re-fetched (got ${r3.filter(isMedia).join(', ')})`);

// A media file that will not download must fail the whole install — it is required.
const r4 = [];
const w4 = bootWorker((url) => {
  const p = new URL(url, 'http://localhost').pathname;
  r4.push(p);
  if (p === '/assets.json') return resBody(JSON.stringify(manifest));
  if (isMedia(p)) throw new TypeError('Failed to fetch');
  return resBody('x');
});
let threw = false;
await w4.dispatch('install').catch(() => { threw = true; });
ok(threw, 'a media file that will not download fails the install');
ok(w4.state.skipWaitingCalls === 0, 'a game with no artwork must not be presented as updated');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
