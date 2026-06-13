// Semantic app version — the single source of truth, displayed on the hub.
// Bump it whenever any cached file changes: it triggers a fresh re-download
// of everything in ASSETS on the next online visit.
const CACHE = 'offline-games-0.4.16';

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
  './games/mahjong/',
  './games/mahjong/index.html',
  './games/mahjong/engine.js',
  './games/mahjong/ai.js',
  './games/mahjong/main.js',
  './games/mahjong/scene.js',
  './games/mahjong/sound.js',
  './games/mahjong/handorder.js',
  './games/mahjong/ui-util.js',
  './games/mahjong/lib/three.module.min.js',
  './games/mahjong/tiles/Man1.svg',
  './games/mahjong/tiles/Man2.svg',
  './games/mahjong/tiles/Man3.svg',
  './games/mahjong/tiles/Man4.svg',
  './games/mahjong/tiles/Man5.svg',
  './games/mahjong/tiles/Man6.svg',
  './games/mahjong/tiles/Man7.svg',
  './games/mahjong/tiles/Man8.svg',
  './games/mahjong/tiles/Man9.svg',
  './games/mahjong/tiles/Pin1.svg',
  './games/mahjong/tiles/Pin2.svg',
  './games/mahjong/tiles/Pin3.svg',
  './games/mahjong/tiles/Pin4.svg',
  './games/mahjong/tiles/Pin5.svg',
  './games/mahjong/tiles/Pin6.svg',
  './games/mahjong/tiles/Pin7.svg',
  './games/mahjong/tiles/Pin8.svg',
  './games/mahjong/tiles/Pin9.svg',
  './games/mahjong/tiles/Sou1.svg',
  './games/mahjong/tiles/Sou2.svg',
  './games/mahjong/tiles/Sou3.svg',
  './games/mahjong/tiles/Sou4.svg',
  './games/mahjong/tiles/Sou5.svg',
  './games/mahjong/tiles/Sou6.svg',
  './games/mahjong/tiles/Sou7.svg',
  './games/mahjong/tiles/Sou8.svg',
  './games/mahjong/tiles/Sou9.svg',
  './games/mahjong/tiles/Ton.svg',
  './games/mahjong/tiles/Nan.svg',
  './games/mahjong/tiles/Shaa.svg',
  './games/mahjong/tiles/Pei.svg',
  './games/mahjong/tiles/Chun.svg',
  './games/mahjong/tiles/Hatsu.svg',
  './games/mahjong/tiles/Haku.svg',
  './games/guobiao/',
  './games/guobiao/index.html',
  './games/guobiao/engine.js',
  './games/guobiao/score.js',
  './games/guobiao/ai.js',
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
