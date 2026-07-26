// Semantic app version — the single source of truth, displayed on the hub.
// Bump it whenever any cached file changes: it triggers a fresh re-download
// of everything in ASSETS on the next online visit.
const CACHE = 'offline-games-1.1.0';

// The heavy MEDIA (voice sprites + artwork + oversized vendor libs) lives HERE instead, versioned by
// content and NOT wiped on a version bump — see the MEDIA list below. One shared bucket across the
// full hub and every sub-hub, so an asset both of them use (mahjong-common's voice) is stored once.
const MEDIA_CACHE = 'offline-games-media';
const MEDIA_MANIFEST = './assets.json';
const MEDIA_VER_KEY = './__media-versions';   // synthetic entry: { [path]: ver } of what the bucket holds

const ASSETS = [
  './',
  './index.html',
  './sw.js', // cached so the hub can read the version offline
  './app-nav.js', // history-replace navigation (kills iOS edge-swipe back/forward) — on every page
  './manifest.webmanifest',
  './icons/icon-180.png',
  // 文件共享助手 — Tools card: WebRTC device-to-device file transfer (PC ↔ iPad). Needs the server
  // to PAIR (signaling) but transfers peer-to-peer; cached so the page shell loads offline (it then
  // shows its "needs network" notice). server-url.js is already cached above (online lobby).
  './fileshare/',
  './fileshare/index.html',
  './fileshare/fileshare.css',
  './fileshare/main.js',
  './fileshare/signaling.js',
  './fileshare/rtc.js',
  './fileshare/relay.js', // server-relay fallback transport (when P2P can't punch through)
  './fileshare/qr.js',
  './fileshare/zip.js', // store-only ZIP writer for the batch (desktop) download
  './fileshare/jsqr.js', // QR decoder for the in-app camera scanner (BarcodeDetector fallback, e.g. iOS)
  './fileshare/recv-store.js', // IndexedDB sink for LARGE received files (streamed to disk via /fileshare/dl/)

  // mahjong-common — shared by every mahjong variant (天津 + 国标): tile model, 3D/2D
  // table renderers, sound, hand ordering, UI utils, board CSS, the three.js lib and
  // the tile/felt/wood art. Tianjin is just one variant on top, not the base.
  './games/mahjong-common/engine-core.js',
  './games/mahjong-common/game-base.js',
  './games/mahjong-common/board.css',
  './games/mahjong-common/remote-backend.js',
  './games/mahjong-common/scene.js',
  './games/mahjong-common/scene2d.js',
  './games/mahjong-common/sound.js',
  './games/mahjong-common/handorder.js',
  './games/mahjong-common/ui-util.js',
  './games/mahjong-common/textures/wood_normal.jpg',
  './games/mahjong-common/textures/wood_rough.jpg',
  // mahjong-tianjin — the 天津 variant's own rules/AI/backend/UI on top of mahjong-common.
  './games/mahjong-tianjin/',
  './games/mahjong-tianjin/index.html',
  './games/mahjong-tianjin/engine.js',
  './games/mahjong-tianjin/ai.js',
  './games/mahjong-tianjin/backend.js',
  './games/mahjong-tianjin/main.js',
  './games/mahjong-common/voice/packed/manifest.json', // voice sprites (tools/pack-voice.js): 4 personas, one decoded buffer each — replaces 168 per-clip wavs
  './games/mahjong-common-online/',
  './games/mahjong-common-online/index.html',
  './games/mahjong-common-online/lobby.css',
  './games/mahjong-common-online/lobby.js',
  './games/mahjong-common-online/server-url.js',
  './games/guobiao/',
  './games/guobiao/index.html',
  './games/guobiao/guobiao.css',
  './games/guobiao/engine.js',
  './games/guobiao/score.js',
  './games/guobiao/ai.js',
  './games/guobiao/backend.js',
  './games/guobiao/main.js',
  './games/guobiao-free/',
  './games/guobiao-free/index.html',
  // poker-common — shared by the card games (斗地主 + 掼蛋): the three.js lib and the
  // CC0 felt/wood table textures. Kept separate from mahjong-common so the card games
  // never reach into a mahjong folder.
  './games/poker-common/textures/wood_normal.jpg',
  './games/poker-common/textures/wood_rough.jpg',
  './games/doudizhu/',
  './games/doudizhu/index.html',
  './games/doudizhu/doudizhu.css',
  './games/doudizhu/engine.js',
  './games/doudizhu/ai.js',
  './games/doudizhu/backend.js',
  './games/doudizhu/scene.js',
  './games/doudizhu/scene2d.js',
  './games/doudizhu/select.js',
  './games/doudizhu/sound.js',
  './games/doudizhu/main.js',
  './games/doudizhu/voice/packed/manifest.json', // voice sprites (tools/pack-voice.js): 3 seats, one decoded buffer each — replaces 123 per-clip wavs
  // 掼蛋 (Guandan) — 4-player / 2-team.
  './games/guandan/',
  './games/guandan/index.html',
  './games/guandan/guandan.css',
  './games/guandan/engine.js',
  './games/guandan/ai.js',
  './games/guandan/backend.js',
  './games/guandan/scene.js',
  './games/guandan/scene2d.js',
  './games/guandan/select.js',
  './games/guandan/sound.js',
  './games/guandan/main.js',
  './games/guandan/voice/packed/manifest.json', // voice sprites (tools/pack-voice.js): 4 personas, one decoded buffer each
  // 台球 (billiards) — 黑八 (pool8) + 斯诺克 (snooker) on the shared pool-common engine.
  // The 3D scene reuses poker-common's three.js + felt/wood textures (cached above).
  './games/pool-common/geometry.js',
  './games/pool-common/physics.js',
  './games/pool-common/ai.js',
  './games/pool-common/sound.js',
  './games/pool-common/app.js',
  './games/pool-common/scene3d.js',
  './games/pool-common/scene2d.js',
  './games/pool-common/pool.css',
  './games/pool8/',
  './games/pool8/index.html',
  './games/pool8/main.js',
  './games/pool8/rules.js',
  './games/snooker/',
  './games/snooker/index.html',
  './games/snooker/main.js',
  './games/snooker/rules.js',
  './shared/theme.css', // repo-wide theme palettes (all pages link this before their own CSS)
  './shared/theme.js', // theme registry + per-module persistence + picker
  './shared/power-mode.js', // 省电模式 (3-tier power mode) — shared by the card games
  './shared/audio-revive.js', // AudioContext keeper: revives audio after iOS kills it in the background (all game sound modules)
  './shared/hub-home.js', // sub-hub home override (返回大厅 lands on /mj/ when entered through it)
  './shared/client-id.js', // one persistent per-browser uid (online seats)
];

// Content-versioned MEDIA — the voice sprites, tile/card artwork and oversized vendor libraries.
//
// Every bit as REQUIRED as the code above (a mahjong table without tile images is not a game), but
// versioned by CONTENT rather than by app version: tools/build-asset-manifest.mjs hashes each of these
// into /assets.json, and the install keeps them in MEDIA_CACHE, which SURVIVES the version bump. So a
// release re-downloads only the ones whose bytes actually changed — normally none. Before this, all
// ~15 MB of it came down again on every deploy, which is what made updates crawl on a weak link.
//
// Keep this list in the same shape as ASSETS; gen-subhub.js filters BOTH by a sub-hub's prefixes, so a
// sub-hub pulls only its own media, out of the one shared bucket.
const MEDIA = [
  // voice — 14 files, 8.51 MB
  './games/doudizhu/voice/packed/0.wav',
  './games/doudizhu/voice/packed/1.wav',
  './games/doudizhu/voice/packed/2.wav',
  './games/guandan/voice/packed/0.wav',
  './games/guandan/voice/packed/1.wav',
  './games/guandan/voice/packed/2.wav',
  './games/guandan/voice/packed/3.wav',
  './games/mahjong-common/sounds/chow.wav',
  './games/mahjong-common/sounds/kong.wav',
  './games/mahjong-common/sounds/pung.wav',
  './games/mahjong-common/voice/packed/0.wav',
  './games/mahjong-common/voice/packed/1.wav',
  './games/mahjong-common/voice/packed/2.wav',
  './games/mahjong-common/voice/packed/3.wav',
  // image — 42 files, 5.53 MB
  './games/mahjong-common/textures/felt_color.jpg',
  './games/mahjong-common/textures/felt_normal.jpg',
  './games/mahjong-common/textures/felt_rough.jpg',
  './games/mahjong-common/textures/wood_color.jpg',
  './games/mahjong-common/tiles/Chun.png',
  './games/mahjong-common/tiles/Haku.png',
  './games/mahjong-common/tiles/Hatsu.png',
  './games/mahjong-common/tiles/Man1.png',
  './games/mahjong-common/tiles/Man2.png',
  './games/mahjong-common/tiles/Man3.png',
  './games/mahjong-common/tiles/Man4.png',
  './games/mahjong-common/tiles/Man5.png',
  './games/mahjong-common/tiles/Man6.png',
  './games/mahjong-common/tiles/Man7.png',
  './games/mahjong-common/tiles/Man8.png',
  './games/mahjong-common/tiles/Man9.png',
  './games/mahjong-common/tiles/Nan.png',
  './games/mahjong-common/tiles/Pei.png',
  './games/mahjong-common/tiles/Pin1.png',
  './games/mahjong-common/tiles/Pin2.png',
  './games/mahjong-common/tiles/Pin3.png',
  './games/mahjong-common/tiles/Pin4.png',
  './games/mahjong-common/tiles/Pin5.png',
  './games/mahjong-common/tiles/Pin6.png',
  './games/mahjong-common/tiles/Pin7.png',
  './games/mahjong-common/tiles/Pin8.png',
  './games/mahjong-common/tiles/Pin9.png',
  './games/mahjong-common/tiles/Shaa.png',
  './games/mahjong-common/tiles/Sou1.png',
  './games/mahjong-common/tiles/Sou2.png',
  './games/mahjong-common/tiles/Sou3.png',
  './games/mahjong-common/tiles/Sou4.png',
  './games/mahjong-common/tiles/Sou5.png',
  './games/mahjong-common/tiles/Sou6.png',
  './games/mahjong-common/tiles/Sou7.png',
  './games/mahjong-common/tiles/Sou8.png',
  './games/mahjong-common/tiles/Sou9.png',
  './games/mahjong-common/tiles/Ton.png',
  './games/poker-common/textures/felt_normal.jpg',
  './games/poker-common/textures/felt_rough.jpg',
  './games/poker-common/textures/wood_color.jpg',
  './icons/icon-512.png',
  // lib — 2 files, 1.28 MB
  './games/mahjong-common/lib/three.module.min.js',
  './games/poker-common/lib/three.module.min.js',
];


// Post a message to every window of this origin — including ones not yet
// controlled by this worker (the hub that triggered the update is controlled by
// the OLD worker while we install), so the progress bar can be driven live.
function broadcast(msg) {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((clients) => clients.forEach((c) => c.postMessage(msg)));
}

// Fetch one asset into a cache, with a single retry — a flaky link deserves one more try before it
// costs the user the whole update. Returns the byte count; THROWS if it could not be stored.
async function cacheAsset(cache, url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400));
    try {
      const res = await fetch(url);
      if (!res.ok) { lastErr = new Error(`install: ${res.status} for ${url}`); continue; }
      let len = Number(res.headers.get('content-length'));
      if (!(len > 0)) { try { len = (await res.clone().blob()).size; } catch {} }
      await cache.put(url, res);
      return len || 0;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('install failed: ' + url);
}

// Which MEDIA this install actually has to fetch: those whose content hash differs from what the
// persistent bucket already holds (or that have gone missing from it). On a normal release that list is
// EMPTY — the artwork and the voice sprites are already here and unchanged, so they cost nothing.
async function mediaPlan(mediaCache) {
  const want = new Set(MEDIA.map((m) => m.replace(/^\.\//, '')));
  const res = await fetch(MEDIA_MANIFEST + '?_=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('asset manifest → HTTP ' + res.status);
  const manifest = await res.json();
  if (!manifest || !Array.isArray(manifest.assets)) throw new Error('malformed asset manifest');
  // A sub-hub precaches a subset, so it only claims the media its own MEDIA list names.
  const mine = manifest.assets.filter((a) => want.has(a.path));
  const stored = await mediaCache.match(MEDIA_VER_KEY);
  const have = stored ? await stored.json().catch(() => ({})) : {};
  const need = [];
  for (const a of mine) {
    const current = have[a.path] === a.ver && (await mediaCache.match('./' + a.path));
    if (!current) need.push(a);
  }
  return { mine, need, have };
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const mediaCache = await caches.open(MEDIA_CACHE);
    const plan = await mediaPlan(mediaCache);
    const total = ASSETS.length + plan.need.length;
    let done = 0, bytes = 0, lastPct = -1;
    // Report progress only when the whole-number percent changes (≤101 messages,
    // not one per asset). Fire-and-forget — progress is best-effort cosmetics.
    // `bytes` = downloaded so far; `totalBytesEst` extrapolates the full download
    // from the average asset size seen — rough early, exact once done === total.
    const tick = () => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        const totalBytesEst = done ? Math.round((bytes / done) * total) : 0;
        broadcast({ type: 'install-progress', done, total, pct, bytes, totalBytesEst });
      }
    };
    tick();
    // Manual fetch + cache.put (instead of cache.add/addAll) so we can count completions AND measure
    // bytes. ALL-OR-NOTHING across BOTH phases: an asset that will not download fails the install, so
    // this worker never activates and never gets to delete the cache the previous one still serves
    // from. The media is required too — a missing tile image fails the update like a missing module.
    await Promise.all(ASSETS.map(async (url) => {
      bytes += await cacheAsset(cache, url);
      done++; tick();
    }));
    // Sequentially: these are hundreds of KB to a MB each, and running them all at once just makes
    // every one of them slow.
    for (const a of plan.need) {
      bytes += await cacheAsset(mediaCache, './' + a.path);
      done++; tick();
    }
    // Record what the bucket now holds — only after every one of them landed, so a partial install
    // retries next time instead of believing it is current.
    const vers = {};
    for (const a of plan.mine) vers[a.path] = a.ver;
    for (const [k, v] of Object.entries(plan.have)) if (!(k in vers)) vers[k] = v;   // another hub's media
    await mediaCache.put(MEDIA_VER_KEY, new Response(JSON.stringify(vers), { headers: { 'content-type': 'application/json' } }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Keep the current version cache AND the content-versioned media bucket — carrying the artwork
      // and voice across the version bump untouched is the entire point of splitting them out.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MEDIA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Report the running version (the cache name carries it) when the hub asks — so the
// page can show the version of the worker that is actually in control, not a stale
// cached copy of sw.js.
self.addEventListener('message', (e) => {
  if (e.data === 'version' && e.ports[0]) e.ports[0].postMessage(CACHE);
  // Let the hub force a worker that's stuck waiting (e.g. one left by an older
  // sw.js without skipWaiting) to activate so the update can finish.
  else if (e.data === 'skipWaiting') self.skipWaiting();
});

// Re-emit a response with the headers that enable cross-origin isolation
// (crossOriginIsolated === true → SharedArrayBuffer works → threaded cores).
// GitHub Pages can't set these, so the service worker adds them. All our
// assets are same-origin, so COEP: require-corp is satisfied.
function crossOriginIsolate(res) {
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ---- File Sharing: stream a large received file straight from IndexedDB to disk ------------------
// A big incoming file (e.g. a 1 GB video) is written to IndexedDB in ~4 MB blocks by the page (see
// fileshare/recv-store.js). The 保存 link points here; we answer with an `attachment` Response whose
// body is a ReadableStream pulled block-by-block from IndexedDB — so the browser writes to disk as it
// streams and the whole file never has to live in memory at once (which is what produced a 0-byte
// save on iOS). Content-Length drives the browser's own download progress.
function fsRecvDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('offlinegames-fileshare');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function fsGet(store, key) {
  return fsRecvDb().then((d) => new Promise((resolve, reject) => {
    let rq;
    try { rq = d.transaction(store, 'readonly').objectStore(store).get(key); }
    catch (e) { resolve(undefined); return; } // store missing (nothing received yet)
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
}
async function streamRecvFile(id) {
  const meta = await fsGet('files', id).catch(() => null);
  if (!meta) return new Response('not found', { status: 404 });
  let seq = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (seq >= meta.blocks) { controller.close(); return; }
      const block = await fsGet('blocks', [id, seq++]);
      if (block) controller.enqueue(new Uint8Array(block));
      if (seq >= meta.blocks) controller.close();
    },
  });
  const fn = encodeURIComponent(meta.name || ('file-' + id)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16));
  return new Response(stream, { headers: {
    'content-type': meta.mime || 'application/octet-stream',
    'content-length': String(meta.size),
    'content-disposition': `attachment; filename*=UTF-8''${fn}`,
    'cache-control': 'no-store',
  } });
}

// Cache-first: guarantees offline play; new versions arrive via the
// version bump above, never silently mid-session.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // File Sharing streamed download — /fileshare/dl/<id> → attachment from IndexedDB (never cached).
  try { const dl = new URL(e.request.url).pathname.match(/\/fileshare\/dl\/(\d+)$/); if (dl) { e.respondWith(streamRecvFile(Number(dl[1]))); return; } } catch {}
  // Any dynamic API path must never be cached or served cache-first — let it hit the network so the
  // page always gets the latest. Offline, the fetch fails and the page falls back.
  // Same for /assets.json — a cached copy would hold the PREVIOUS build's content hashes, so the next
  // install would conclude it already had the new media and skip downloading it.
  try {
    const p = new URL(e.request.url).pathname;
    if (p.startsWith('/api/') || p === '/assets.json') return;
  } catch {}
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return crossOriginIsolate(hit);
      return fetch(e.request).then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, copy));
        }
        return crossOriginIsolate(res);
      });
    })
  );
});
