# offlineGames — repo notes for Claude

PWA hub of offline games for airplane-mode iPad play, plus an online 麻将 mode. The same
Node process (`server/index.js`) serves BOTH the static site AND the WebSocket lobby/game
backend; GitHub Pages (`deploy.yml`) is a static-only mirror.

## Online server endpoint — single source of truth
The WebSocket backend host is defined in ONE place: `games/mahjong-common-online/server-url.js`
(`ONLINE_SERVER` + `serverUrl()`). Every online client imports `serverUrl()` from it — the lobby
(`mahjong-common-online/lobby.js`) and each game page (`mahjong-tianjin/main.js`,
`guobiao/main.js`). **Do NOT hardcode the backend host (`wss://…azurewebsites.net`) anywhere else.**
To move the backend to a new host/region, change only that constant. The server's matching CORS
allowlist is `ALLOWED` in `server/index.js` (env `ALLOWED_ORIGINS`) — update it there in tandem.

Current backend: `offlinegames.azurewebsites.net` (Azure App Service, West Central US). Deploy
workflow: `.github/workflows/main_offlinegames.yml`.

## Before every push
Bump the `CACHE` patch version in `sw.js` (it busts the offline asset cache). When adding a new
static file that a cached page imports/loads, also add it to the `ASSETS` list in `sw.js`, or
offline play breaks on a missing module.
