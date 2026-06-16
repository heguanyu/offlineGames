// Semantic app version — the single source of truth, displayed on the hub.
// Bump it whenever any cached file changes: it triggers a fresh re-download
// of everything in ASSETS on the next online visit.
const CACHE = 'offline-games-0.4.83';

const ASSETS = [
  './',
  './index.html',
  './sw.js', // cached so the hub can read the version offline
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png',
  './games/pad-test/',
  './games/pad-test/index.html',
  './games/gba/',
  './games/gba/index.html',
  './games/nds/',
  './games/nds/index.html',
  './games/mahjong-tianjin/',
  './games/mahjong-tianjin/index.html',
  './games/mahjong-tianjin/board.css',
  './games/mahjong-tianjin/engine.js',
  './games/mahjong-tianjin/ai.js',
  './games/mahjong-tianjin/backend.js',
  './games/mahjong-common/remote-backend.js',
  './games/mahjong-tianjin/main.js',
  './games/mahjong-tianjin/scene.js',
  './games/mahjong-tianjin/scene2d.js',
  './games/mahjong-tianjin/sound.js',
  './games/mahjong-tianjin/handorder.js',
  './games/mahjong-tianjin/ui-util.js',
  './games/mahjong-tianjin/lib/three.module.min.js',
  './games/mahjong-tianjin/sounds/pung.wav',
  './games/mahjong-tianjin/sounds/chow.wav',
  './games/mahjong-tianjin/sounds/kong.wav',
  './games/mahjong-tianjin/tiles/Man1.png',
  './games/mahjong-tianjin/tiles/Man2.png',
  './games/mahjong-tianjin/tiles/Man3.png',
  './games/mahjong-tianjin/tiles/Man4.png',
  './games/mahjong-tianjin/tiles/Man5.png',
  './games/mahjong-tianjin/tiles/Man6.png',
  './games/mahjong-tianjin/tiles/Man7.png',
  './games/mahjong-tianjin/tiles/Man8.png',
  './games/mahjong-tianjin/tiles/Man9.png',
  './games/mahjong-tianjin/tiles/Pin1.png',
  './games/mahjong-tianjin/tiles/Pin2.png',
  './games/mahjong-tianjin/tiles/Pin3.png',
  './games/mahjong-tianjin/tiles/Pin4.png',
  './games/mahjong-tianjin/tiles/Pin5.png',
  './games/mahjong-tianjin/tiles/Pin6.png',
  './games/mahjong-tianjin/tiles/Pin7.png',
  './games/mahjong-tianjin/tiles/Pin8.png',
  './games/mahjong-tianjin/tiles/Pin9.png',
  './games/mahjong-tianjin/tiles/Sou1.png',
  './games/mahjong-tianjin/tiles/Sou2.png',
  './games/mahjong-tianjin/tiles/Sou3.png',
  './games/mahjong-tianjin/tiles/Sou4.png',
  './games/mahjong-tianjin/tiles/Sou5.png',
  './games/mahjong-tianjin/tiles/Sou6.png',
  './games/mahjong-tianjin/tiles/Sou7.png',
  './games/mahjong-tianjin/tiles/Sou8.png',
  './games/mahjong-tianjin/tiles/Sou9.png',
  './games/mahjong-tianjin/tiles/Ton.png',
  './games/mahjong-tianjin/tiles/Nan.png',
  './games/mahjong-tianjin/tiles/Shaa.png',
  './games/mahjong-tianjin/tiles/Pei.png',
  './games/mahjong-tianjin/tiles/Chun.png',
  './games/mahjong-tianjin/tiles/Hatsu.png',
  './games/mahjong-tianjin/tiles/Haku.png',
  './games/mahjong-tianjin-online/',
  './games/mahjong-tianjin-online/index.html',
  './games/mahjong-tianjin-online/lobby.css',
  './games/mahjong-tianjin-online/lobby.js',
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
  './shared/emu-persistence.js',
  './emulatorjs/data/emulator.css',
  './emulatorjs/data/loader.js',
  './emulatorjs/data/version.json',
  './emulatorjs/data/compression/extract7z.js',
  './emulatorjs/data/compression/extractzip.js',
  './emulatorjs/data/compression/libunrar.js',
  './emulatorjs/data/compression/libunrar.wasm',
  './emulatorjs/data/cores/mgba-legacy-wasm.data',
  './emulatorjs/data/cores/mgba-wasm.data',
  './emulatorjs/data/cores/melonds-legacy-wasm.data',
  './emulatorjs/data/cores/melonds-wasm.data',
  './emulatorjs/data/cores/melonds-thread-legacy-wasm.data',
  './emulatorjs/data/cores/melonds-thread-wasm.data',
  './emulatorjs/data/cores/vbam-wasm.data',
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

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
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
