# Offline Games

A set of offline-playable PWA games for iPad, with Xbox controller support.

## Structure

- `index.html` — hub menu listing all games
- `sw.js` — service worker; precaches everything so the app works in airplane mode
- `manifest.webmanifest` — PWA manifest (standalone display, icons)
- `games/<name>/` — one folder per game
- `games/pad-test/` — gamepad diagnostic screen (button/stick/trigger visualizer)
- `games/gba/` — GBA emulator (mGBA core)
- `games/nds/` — Nintendo DS emulator (melonDS core) — gen 4/5 Pokémon etc.
- `emulatorjs/data/` — shared [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS)
  v4.2.3 frontend + wasm cores, used by all emulator pages

## Emulators

- Frontend: EmulatorJS source files (loaded unminified via `EJS_DEBUG_XX`);
  cores (`mgba-wasm.data`, `melonds-wasm.data`, ~1MB each) from the
  EmulatorJS CDN. Everything is self-hosted and precached — no CDN
  dependency at runtime. To add a system: copy a game page, change
  `EJS_core` + accepted extensions, download the core into
  `emulatorjs/data/cores/`, add files to `sw.js`.
- ROMs: added via file picker, stored in IndexedDB (one db per system), so
  they survive restarts and work offline. Use ROMs you legally own.
- NDS touch input: tap/click directly on the lower screen. Screen layout
  options are in the gear menu.
- E2E test: `node test/emu-e2e.mjs [system] [rom-in-roms-dir]`, e.g.
  `node test/emu-e2e.mjs nds GodMode9i.nds` — boots the ROM in headless
  Edge, exercises quick save/load, writes screenshots to `test/`.
- **Quick save / quick load (SL):** RT = quick save, LT = quick load by
  default (GBA doesn't use the triggers). Keyboard: `1` save, `2` load,
  `3` change slot, 9 slots. States are stored in the browser
  (`save-state-location: browser` is preset). Rebind anything via the in-game
  gear menu → Control Settings; rebinds apply to every ROM of that system
  (one shared controls profile) and are mirrored to IndexedDB (see
  Persistence below).
- **Fast forward:** hold R3 (right stick click) or `Space`. Ratio is 3× by
  default; change it (1.5×–10× or unlimited), or enable slow motion/rewind,
  under gear menu → Speed Options.
- Battery saves (in-game save files) also persist in browser storage.
- Persistence (`shared/emu-persistence.js`): EmulatorJS quick saves only live
  in the emulator's in-memory FS, so we copy each quick state into the
  system's IndexedDB and restore it at game start — quick load works across
  page reloads/app restarts. Battery saves are flushed to persistent storage
  every 30s, on every quick save, and when the page is hidden or closed
  (refresh, tab switch, swiping the PWA away). Covered by the e2e test's
  reload step. EmulatorJS settings (control bindings, core options, volume)
  live in localStorage, which iOS purges far more readily than IndexedDB
  (lazy disk flush, storage pressure) — so every settings write is mirrored
  into IndexedDB and localStorage is re-seeded from the mirror before the
  emulator boots. Control bindings are kept as one shared profile per
  system: EmulatorJS scopes settings per game, so without this a rebind
  would only affect the ROM it was made in. Covered by
  `node test/settings-persist-test.mjs`.
- GBA (mGBA) runs full speed single-threaded, so it uses the plain core.
- **NDS uses the multi-threaded melonDS core** — single-threaded melonDS is
  too slow (lag, and no fast-forward headroom). Threads need SharedArrayBuffer,
  which needs cross-origin isolation (COOP/COEP headers). GitHub Pages can't
  set those, so `sw.js` injects them on every response, and the NDS page
  registers the service worker + reloads once to pick them up. If isolation
  can't be achieved, EmulatorJS falls back to the single-threaded core
  automatically. All assets are same-origin, so COEP `require-corp` is
  satisfied. (This same mechanism would later enable the PSP/DOSBox cores.)

## Test locally (desktop)

```
python -m http.server 8000
```

Open http://localhost:8000 — `localhost` counts as a secure context, so the
service worker registers. Plug in or Bluetooth-pair a controller and open
Controller Test; press any button to make the pad appear (browsers hide
gamepads until first input, as a fingerprinting protection).

## Deploy + install on iPad

Service workers require HTTPS, so host the folder anywhere static + HTTPS
(GitHub Pages is the zero-cost option):

1. Push this folder to a GitHub repo, enable Pages (Settings → Pages →
   deploy from branch).
2. On the iPad, open the Pages URL in Safari **once while online** — this
   lets the service worker download and cache everything.
3. Share button → **Add to Home Screen**.
4. Launch from the home-screen icon (important: home-screen PWAs are exempt
   from Safari's 7-day cache eviction; Safari tabs are not).
5. Test: enable airplane mode, relaunch from the icon — it should load fully.

## Pair an Xbox controller with the iPad

1. Hold the Xbox button to turn the pad on, then hold the small **pair**
   button (top edge) until the Xbox logo flashes fast.
2. iPad: Settings → Bluetooth → tap the controller when it appears.
3. In the app, press any button — the pad shows up via the Gamepad API.

Known iOS quirks:
- No rumble: Safari doesn't expose `vibrationActuator` for gamepads.
- The Gamepad API is poll-based — read `navigator.getGamepads()` every
  frame; there is no per-button event.
- If the pad works in Safari but not from the home-screen icon, update
  iPadOS (old versions had broken gamepad support in standalone mode).

## Shipping an update

Bump the semantic version in `sw.js`'s `CACHE` constant (e.g.
`offline-games-0.0.6`) — it is the single source of truth: the hub parses
and displays it, and changing it triggers clients to re-download everything
in `ASSETS` on their next online visit (the fetch strategy is cache-first,
so nothing updates without the bump). Patch = fixes, minor = new
game/system, major = breaking rework. Add any new files to the `ASSETS`
precache list or they won't be available offline. Clients see the new
version after loading the page twice (first load installs it in the
background).
