# offlineGames — repo notes for Claude

PWA hub of offline games for airplane-mode iPad play, plus online multiplayer (麻将 + 斗地主). The same
Node process (`server/index.js`) serves BOTH the static site AND the WebSocket lobby/game
backend, on Azure App Service. **Deployment is LOCAL-ONLY** (2026-07-09): run
`tools/deploy-azure.ps1` (az CLI zip-deploy; Kudu/Oryx builds deps server-side on the Azure Linux
runtime). There is NO CI/CD — both GitHub workflows (Pages mirror + Azure deploy) were
decommissioned and the Pages site disabled; the `github.io` entry stays in the server CORS
allowlist only as a safety net for stragglers on the old origin. A push does NOT deploy —
pushing and deploying are separate, deliberate steps.

## Online server endpoint — single source of truth
The WebSocket backend host is defined in ONE place: `games/mahjong-common-online/server-url.js`
(`ONLINE_SERVER` + `serverUrl()`). Every online client imports `serverUrl()` from it — the lobby
(`mahjong-common-online/lobby.js`) and each game page (`mahjong-tianjin/main.js`,
`guobiao/main.js`, `doudizhu/main.js`). **Do NOT hardcode the backend host (`wss://…azurewebsites.net`) anywhere else.**
To move the backend to a new host/region, change only that constant. The server's matching CORS
allowlist is `ALLOWED` in `server/index.js` (env `ALLOWED_ORIGINS`) — update it there in tandem.

Current backend: `offlinegames.azurewebsites.net` (Azure App Service, West Central US, resource
group `offlineGamesRg`). Deploy: `tools/deploy-azure.ps1` from this machine (needs `az login`).

## Online is multi-game — seat count + table driver are per-game
`server/index.js` hosts one table per game in the `GAMES` registry; each entry declares `kind`,
`seats`, `label`, `page` (mahjong: `ruleset`). The lobby/reconnect/score plumbing is seat-count
agnostic (no hard-coded 4). Two table drivers share the `{ type:'game', ev, view }` protocol:
- **mahjong** (`kind:'mahjong'`, 4 seats) → `server/table.js` + a `server/rulesets/*.js`.
- **斗地主** (`kind:'poker'`, 3 seats) → `server/poker-table.js`, which runs `games/doudizhu/`'s
  engine + AI **directly** (no DOM). A 锅 ends the hand AFTER any player first reaches `DOU_POT_TARGET`
  (default 100) points.

The server pushes ABSOLUTE-seat redacted views; the client rotates so the receiving human is seat 0.
For 斗地主 that lives in `games/doudizhu/backend.js` `RemoteBackend` (`buildView`/`mapEvent`) — its
`buildView` rebuilds a Game-like view exposing `validatePlay`/`roleOf` so `main.js` + the local
auto-select AI render online identically to offline. Same lobby page (`mahjong-common-online`,
`?game=doudizhu`); the 3-seat triangle layout is selected by `SEATING` in `lobby.js`.

## Navigation — ALWAYS `location.replace`, never push a history entry
The hub, lobby, and each game/tool are separate pages. On iPad/iOS the edge-swipe just walks
the browser history, so any pushed entry becomes an accidental "go back/forward" mid-game. The
rule, repo-wide:
- **Every page loads `app-nav.js`** (`<script src="…/app-nav.js"></script>` in `<head>`, path
  relative to the page). It intercepts same-origin `<a>` clicks and converts them to
  `location.replace` (leaving `#` anchors, `target="_blank"`, downloads, and external/`tel:` links
  alone). A new page → add the script tag, or its links push history.
- **Never assign `location.href = …` / `window.location = …` / `location.assign(…)`** for
  in-app jumps. Use `location.replace(url)`. On-screen back buttons use
  `onclick="event.preventDefault(); location.replace('../')"` (see `voicepick`, `tourguide`) so
  they work even before `app-nav.js` runs.
There should be **zero** `location.href=`/`window.location=` assignments in the repo (grep before
adding one). `app-nav.js` itself is the only allowed place that calls `location.replace` on clicks.

## Before every push
Bump the `CACHE` patch version in `sw.js` (it busts the offline asset cache). When adding a new
static file that a cached page imports/loads, also add it to the `ASSETS` list in `sw.js`, or
offline play breaks on a missing module. To ship: push, then run `tools/deploy-azure.ps1`
(pushing alone deploys nothing).

## Sub-hubs — shareable, scoped entries (e.g. /mj/)
A sub-hub exposes a SUBSET of the site to share with someone (e.g. `/mj/` = 天津麻将 only,
offline + 联机 on the same server/tables; not linked from the main hub). Because everything is
plain ES modules, code is already split per game — only the hub page and the SW precache span
the whole site. So a sub-hub is: a committed landing page (`mj/index.html`, plants the
`hub-home` sessionStorage marker so 返回大厅 comes back to it — see `shared/hub-home.js`) + a
GENERATED service worker `sw-<name>.js` (git-ignored; `tools/gen-subhub.js`, run by the deploy
script) — sw.js verbatim with a filtered ASSETS list + its own cache name, version inherited
from sw.js. Profiles in `tools/subhubs.json`: a new partial hub = one profile entry (path
prefixes) + one landing folder. `test/subhub-test.mjs` guards the subset + navigation loop.

## Voice clips — packed "sprites" (generated, not committed)
The raw per-clip voice WAVs (`games/**/voice/<set>/*.wav`, ~291 files) are the **source of
truth** and stay in the repo. `tools/pack-voice.js` concatenates each voice set into one
`games/**/voice/packed/<set>.wav` "audio sprite" + a `packed/manifest.json`
(`slug → {offset, duration}` seconds); the runtime decodes one buffer per set and plays each
clip as a slice. This is what the SW caches (~7 files, not ~291) — the per-file count was what
made a full offline update crawl. The `packed/` output is **git-ignored and regenerated on every
deploy** (`tools/deploy-azure.ps1` runs `node tools/pack-voice.js` before
staging). **Run it locally (`node tools/pack-voice.js`, zero deps) after changing any raw clip**,
or the served/cached sprites go stale. The loaders (`mahjong-tianjin/sound.js`,
`doudizhu/sound.js`) fall back to per-file fetches if `packed/manifest.json` is absent (e.g.
unpacked local dev).
