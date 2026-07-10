// Semantic app version — the single source of truth, displayed on the hub.
// Bump it whenever any cached file changes: it triggers a fresh re-download
// of everything in ASSETS on the next online visit.
const CACHE = 'offline-games-0.7.15';

const ASSETS = [
  './',
  './index.html',
  './sw.js', // cached so the hub can read the version offline
  './app-nav.js', // history-replace navigation (kills iOS edge-swipe back/forward) — on every page
  './storage-check.html', // debug tool: inspect emulator IndexedDB + export/import saves across origins
  './save-recovery.html', // debug tool: admin view/recover of server-side cloud saves (needs ADMIN_TOKEN)
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png',
  './voicepick/', // QA tool (hub Tools card): voice-clip play-time audit; fetches the raw per-clip WAVs over the network (not SW-cached — needs connectivity)
  './voicepick/index.html',
  './tourguide/tahoe-itinerary.html', // Tools card: 出游助手 — Tahoe trip itinerary (6/21–6/22)
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
  // 电子书阅读 — Tools card: local EPUB reader. Books + last-read spot live in its own
  // IndexedDB ('epub-reader'), so reading is fully offline once a book is imported.
  './reader/',
  './reader/index.html',
  './reader/reader.css',
  './reader/main.js',
  './reader/epub.js',

  // 方舟资讯 — Tools card: read-only NGA reader for the two 明日方舟 boards. Its data + images come
  // from the server relay (/api/nga/*) over the network, so only the shell is precached (the page
  // shows a "加载失败" state offline); no offline reading.
  './nga/',
  './nga/index.html',
  './nga/nga.css',
  './nga/main.js',

  './games/pad-test/',
  './games/pad-test/index.html',
  './games/gba/',
  './games/gba/index.html',
  './games/nds/',
  './games/nds/index.html',
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
  './games/mahjong-common/lib/three.module.min.js',
  './games/mahjong-common/textures/felt_color.jpg',
  './games/mahjong-common/textures/felt_normal.jpg',
  './games/mahjong-common/textures/felt_rough.jpg',
  './games/mahjong-common/textures/wood_color.jpg',
  './games/mahjong-common/textures/wood_normal.jpg',
  './games/mahjong-common/textures/wood_rough.jpg',
  './games/mahjong-common/sounds/pung.wav',
  './games/mahjong-common/sounds/chow.wav',
  './games/mahjong-common/sounds/kong.wav',
  './games/mahjong-common/tiles/Man1.png',
  './games/mahjong-common/tiles/Man2.png',
  './games/mahjong-common/tiles/Man3.png',
  './games/mahjong-common/tiles/Man4.png',
  './games/mahjong-common/tiles/Man5.png',
  './games/mahjong-common/tiles/Man6.png',
  './games/mahjong-common/tiles/Man7.png',
  './games/mahjong-common/tiles/Man8.png',
  './games/mahjong-common/tiles/Man9.png',
  './games/mahjong-common/tiles/Pin1.png',
  './games/mahjong-common/tiles/Pin2.png',
  './games/mahjong-common/tiles/Pin3.png',
  './games/mahjong-common/tiles/Pin4.png',
  './games/mahjong-common/tiles/Pin5.png',
  './games/mahjong-common/tiles/Pin6.png',
  './games/mahjong-common/tiles/Pin7.png',
  './games/mahjong-common/tiles/Pin8.png',
  './games/mahjong-common/tiles/Pin9.png',
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
  './games/mahjong-common/tiles/Nan.png',
  './games/mahjong-common/tiles/Shaa.png',
  './games/mahjong-common/tiles/Pei.png',
  './games/mahjong-common/tiles/Chun.png',
  './games/mahjong-common/tiles/Hatsu.png',
  './games/mahjong-common/tiles/Haku.png',
  // mahjong-tianjin — the 天津 variant's own rules/AI/backend/UI on top of mahjong-common.
  './games/mahjong-tianjin/',
  './games/mahjong-tianjin/index.html',
  './games/mahjong-tianjin/engine.js',
  './games/mahjong-tianjin/ai.js',
  './games/mahjong-tianjin/backend.js',
  './games/mahjong-tianjin/main.js',
  './games/mahjong-common/voice/packed/manifest.json', // voice sprites (tools/pack-voice.js): 4 personas, one decoded buffer each — replaces 168 per-clip wavs
  './games/mahjong-common/voice/packed/0.wav',
  './games/mahjong-common/voice/packed/1.wav',
  './games/mahjong-common/voice/packed/2.wav',
  './games/mahjong-common/voice/packed/3.wav',
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
  './games/poker-common/lib/three.module.min.js',
  './games/poker-common/textures/felt_normal.jpg',
  './games/poker-common/textures/felt_rough.jpg',
  './games/poker-common/textures/wood_color.jpg',
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
  './games/doudizhu/voice/packed/0.wav',
  './games/doudizhu/voice/packed/1.wav',
  './games/doudizhu/voice/packed/2.wav',
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
  './games/guandan/voice/packed/0.wav',
  './games/guandan/voice/packed/1.wav',
  './games/guandan/voice/packed/2.wav',
  './games/guandan/voice/packed/3.wav',
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
  './shared/emu-persistence.js',
  './shared/power-mode.js', // 省电模式 (3-tier power mode) — shared by the card games
  './shared/audio-revive.js', // AudioContext keeper: revives audio after iOS kills it in the background (all game sound modules)
  './shared/hub-home.js', // sub-hub home override (返回大厅 lands on /mj/ when entered through it)
  './shared/client-id.js', // one persistent per-browser uid (online seats + emulator cloud saves)
  './shared/save-sync.js', // cloud backup of emulator saves (imports client-id.js + server-url.js)
  './emulatorjs/data/emulator.css',
  './emulatorjs/data/loader.js',
  './emulatorjs/data/version.json',
  './emulatorjs/data/compression/extract7z.js',
  './emulatorjs/data/compression/extractzip.js',
  './emulatorjs/data/compression/libunrar.js',
  './emulatorjs/data/compression/libunrar.wasm',
  // GBA runs the WebGL1 (legacy) cores (forced via EJS_forceLegacyCores in gba/index.html);
  // NDS (melonds) runs the WebGL2 cores (thread when cross-origin-isolated, else non-thread).
  // The unused mgba/vbam-wasm (WebGL2) + melonds*-legacy (WebGL1) builds are NOT bundled.
  './emulatorjs/data/cores/mgba-legacy-wasm.data',
  './emulatorjs/data/cores/melonds-wasm.data',
  './emulatorjs/data/cores/melonds-thread-wasm.data',
  './emulatorjs/data/cores/vbam-legacy-wasm.data',
  './emulatorjs/data/cores/reports/mgba.json',
  './emulatorjs/data/cores/reports/melonds.json',
  './emulatorjs/data/cores/reports/vbam.json',
  './emulatorjs/data/localization/af-FR.json',
  './emulatorjs/data/localization/ar-AR.json',
  './emulatorjs/data/localization/ben-BEN.json',
  './emulatorjs/data/localization/de-GER.json',
  './emulatorjs/data/localization/el-GR.json',
  './emulatorjs/data/localization/en-US.json',
  './emulatorjs/data/localization/es-ES.json',
  './emulatorjs/data/localization/fa-AF.json',
  './emulatorjs/data/localization/hi-HI.json',
  './emulatorjs/data/localization/it-IT.json',
  './emulatorjs/data/localization/ja-JA.json',
  './emulatorjs/data/localization/jv-JV.json',
  './emulatorjs/data/localization/ko-KO.json',
  './emulatorjs/data/localization/pt-BR.json',
  './emulatorjs/data/localization/retroarch.json',
  './emulatorjs/data/localization/ro-RO.json',
  './emulatorjs/data/localization/ru-RU.json',
  './emulatorjs/data/localization/tr-TR.json',
  './emulatorjs/data/localization/vi-VN.json',
  './emulatorjs/data/localization/zh-CN.json',
  './emulatorjs/data/src/compression.js',
  './emulatorjs/data/src/emulator.js',
  './emulatorjs/data/src/GameManager.js',
  './emulatorjs/data/src/gamepad.js',
  './emulatorjs/data/src/nipplejs.js',
  './emulatorjs/data/src/shaders.js',
  './emulatorjs/data/src/socket.io.min.js',
  './emulatorjs/data/src/storage.js',
];

// Post a message to every window of this origin — including ones not yet
// controlled by this worker (the hub that triggered the update is controlled by
// the OLD worker while we install), so the progress bar can be driven live.
function broadcast(msg) {
  return self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    .then((clients) => clients.forEach((c) => c.postMessage(msg)));
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const total = ASSETS.length;
    let done = 0, lastPct = -1;
    // Report progress only when the whole-number percent changes (≤101 messages,
    // not one per asset). Fire-and-forget — progress is best-effort cosmetics.
    const tick = () => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct) { lastPct = pct; broadcast({ type: 'install-progress', done, total, pct }); }
    };
    tick();
    // Per-asset cache.add (instead of cache.addAll) so we can count completions.
    // Promise.all still rejects on any failure, so a broken asset fails the whole
    // install exactly like addAll did — the cache never ends up half-populated.
    await Promise.all(ASSETS.map((url) => cache.add(url).then(() => { done++; tick(); })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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

// Cache-first: guarantees offline play; new versions arrive via the
// version bump above, never silently mid-session.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Dynamic API (e.g. /api/weather) must never be cached or served cache-first — let it hit the
  // network so the page always gets the latest. Offline, the fetch fails and the page falls back.
  try { if (new URL(e.request.url).pathname.startsWith('/api/')) return; } catch {}
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
