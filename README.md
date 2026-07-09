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
- `games/mahjong/` — 天津麻将 (Tianjin mahjong), a native game vs. 3 AI bots
- `games/guobiao/` — 国标麻将 (Chinese Official / MCR), reuses the mahjong render layer
- `games/guobiao-free/` — 国标（无定番）, the MCR game with the 8-fan minimum
  removed; just a page + `window.MJ_CONFIG` that reuses `../guobiao/main.js`
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
  which needs cross-origin isolation (COOP/COEP headers). Static hosts can't
  always set those, so `sw.js` injects them on every response, and the NDS page
  registers the service worker + reloads once to pick them up. If isolation
  can't be achieved, EmulatorJS falls back to the single-threaded core
  automatically. All assets are same-origin, so COEP `require-corp` is
  satisfied. (This same mechanism would later enable the PSP/DOSBox cores.)

## Mahjong (天津麻将)

A self-contained native game (no emulator) under `games/mahjong/`, rendered as a
real 3D table with three.js. Split so the rules are unit-testable in Node:

- `engine.js` — pure rules engine: 34-kind tile model, 混儿 (wild) determination,
  the joker-aware win solver, fan scoring, and the turn/claim state machine. No
  DOM; imported by both the page and the tests.
- `ai.js` — three bot strengths (新手 / 普通 / 高手) sharing one shanten-style hand
  evaluator; they differ in claim aggression and whether they steer toward
  high-fan shapes (本混龙 / 捉五).
- `scene.js` — the three.js table: felt + wooden rim, tiles as chunky boxes,
  lighting + shadows, a persistent keyed-mesh manager that eases each tile toward
  its target (so selection lifts, hand reflow, and discards dropping into the
  pool animate for free), and raycast picking. Each seat's row is scaled to fit
  its edge so rows never collide at the corners; the player's row is pushed
  toward the camera with its 碰/杠 melds laid flat beside it. The selected tile
  gets an additive glow sprite. `_resize` dollies the camera back in portrait so
  the table is never cropped on the sides.
- `handorder.js` — pure helper (`buildOrder`) for the hand display order: 混儿
  grouped on the left, the rest sorted with the freshly drawn tile on the right.
  Unit-tested in Node.
- `sound.js` — Web Audio sound effects (tile clack, 碰/杠 calls, win jingle),
  synthesized at runtime so there are no audio files; mute toggle (🔊) in the
  header, persisted to `localStorage`.
- `main.js` — HTML HUD (scoreboard, nameplates, floating 混儿 panel, action
  buttons), input (touch raycast + keyboard + Xbox controller), and the
  orchestration that paces AI turns. `?fast=1` shortens the AI delay for tests.

Assets (all vendored for offline use):
- `lib/three.module.min.js` — three.js r160 (MIT).
- `tiles/*.svg` — tile faces from the [FluffyStuff riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles)
  set (CC0 / public domain). Loaded as images and composited onto an ivory tile
  face; a drawn number+suit is used as a fallback until they load. Tile backs and
  the felt are generated procedurally (canvas), so there are no other binaries.

Rules implemented (the in-game 规则 panel has the player-facing version): 136
tiles, **no chow — only 碰/杠**, and **win by self-draw only** (自摸, including
杠开 and 海底; no 点炮). After the deal an indicator is flipped and its kind plus
the next kind in cycle both become 混儿 wilds, which substitute for any tile when
winning but can't be used to 碰/杠 and can't be discarded. Fans: 提溜 (base) ·
混吊/双混吊 · 素 · 捉五 · 龙 · 本混龙 · 杠开 · 海底 · 天和/地和; 捉五 and 龙 add to
form the base term, other fans multiply, dealer pays/collects double. Tune the
fan values in one place: the `FAN` table in `engine.js`.

Controls (select, then confirm): tap a tile to lift + highlight it, then tap
**打出** (or press **A**) to discard; ←/→ or the stick move the cursor. 混儿 group
on the left automatically. When a 碰/杠 is offered: **X** = 碰, **Y** = 杠,
**B** = 过. **Menu** opens the menu. Difficulty + running score persist in
`localStorage`.

Tests:
- `node test/mahjong-engine-test.mjs` — wild wrap-around, win detection,
  scoring of each fan, and 200 random self-play games (terminate + zero-sum).
- `node test/mahjong-handorder-test.mjs` — 混儿-left default + sorted rest.
- `node test/mahjong-ai-check.mjs` — bots reach a self-draw win far more often
  than random play; reports per-level win rate and timing.
- `node test/mahjong-e2e.mjs` — headless Edge (WebGL via SwiftShader) loads the
  page, auto-plays the human seat through full hands, checks the menu's 重开
  resets scores, and fails on any console error.
- `node test/mahjong-screenshot.mjs` — writes mid-game 3D screenshots
  (`test/mahjong-3d.png`, `-portrait.png`) for visual checks.

## 国标麻将 (Chinese Official / MCR)

A second mahjong game under `games/guobiao/` that **reuses** the mahjong 3D
renderer (`../mahjong/scene.js`), audio (`sound.js`), hand-order (`handorder.js`)
and tile assets, but brings its own rules:

- `engine.js` — MCR rules: **吃 (chow), 碰, 杠**, win by **self-draw or off a
  discard (点炮)**, no wilds, and an **8-fan minimum** (起和8番). A claim queue
  resolves priority (胡 > 碰/杠 > 吃). Reuses the shared tile model +
  decomposition from `../mahjong/engine.js`.
- `score.js` — fan scoring: a substantial, commonly-occurring subset of the
  official 81 fans (清/混一色, 碰碰和, 字一色, 清/混幺九, 大小三元/四喜, 四/三/双暗刻,
  三色三同顺, 花龙, 一色三步高, 平和, 门前清/不求人, 五门齐, 箭/风/幺九刻, 单钓/边/坎张,
  七对, 十三幺, …), with the major non-repeat exclusions. Pure + Node-tested.
- `ai.js` — bots that 吃/碰/杠, take any ≥8-fan win, and steer toward high-fan
  shapes (one-suit flush, honor pungs, all-pungs) so hands clear the 8-fan bar.
- `main.js` — claim-queue orchestration, a 听 (ready) indicator with a discard
  hint, and the MCR payment (winner gets fan+8; self-draw → all pay it, discard
  → the 点炮者 pays it and the other two pay the 8 base).

The 8-fan minimum is a per-`Game` option (`minFan`, default 8). **国标（无定番）**
(`games/guobiao-free/`) is the same game with `minFan: 0` (any valid hand wins) —
it's just a page whose inline `window.MJ_CONFIG = { minFan: 0, sessionKey: ... }`
reuses `../guobiao/main.js`, `engine.js`, `score.js`, `ai.js` unchanged.

Scope note: 136 tiles (no flowers), a fan **subset** (not all 81), and no
robbing-kong — documented simplifications for a playable, reasonably authentic
v1. Tests: `node test/guobiao-engine-test.mjs` (scoring + random self-play:
terminate, zero-sum, wins ≥ 8 fan for standard, sub-8-fan wins for 无定番),
`node test/guobiao-e2e.mjs` and `node test/guobiao-free-e2e.mjs` (headless WebGL,
play full hands, fail on any console error).

## Test locally (desktop)

```
python -m http.server 8000
```

Open http://localhost:8000 — `localhost` counts as a secure context, so the
service worker registers. Plug in or Bluetooth-pair a controller and open
Controller Test; press any button to make the pad appear (browsers hide
gamepads until first input, as a fingerprinting protection).

## Deploy + install on iPad

Service workers require HTTPS. Production deploys to Azure App Service from
the local machine — one Node process serves the static site + the WebSocket
backend (there is no CI/CD):

1. Bump the sw.js CACHE version, push to main, then run
   `tools/deploy-azure.ps1` (needs `az login`) — it stages the site + server
   and zip-deploys to `offlinegames.azurewebsites.net` with a server-side
   dependency build.
2. On the iPad, open the URL in Safari **once while online** — this
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
