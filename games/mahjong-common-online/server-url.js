// SINGLE SOURCE OF TRUTH for the online game server (WebSocket) endpoint.
// Every online client — the lobby AND each game page (天津/国标/国标无定番 main.js) — imports
// serverUrl() from here. Do NOT hardcode the backend host anywhere else.
//
// The Azure App Service serves both this static site AND the WebSocket backend, so a page loaded
// from the app connects back to itself (same origin). The GitHub Pages mirror (*.github.io) can't
// host a socket, so a page served from Pages reaches across to the Azure backend named below.
// localhost uses the local dev server (which also serves the page). ?server=wss://… overrides
// everything (handy for testing a deployed server from a local page).
//
// To move the backend to a new host (e.g. another Azure region), change ONLY this one constant.
export const ONLINE_SERVER = 'offlinegames.azurewebsites.net';

export function serverUrl() {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return override;
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return `ws://${h}:8090`; // dev server (also serves this page)
  if (h.endsWith('github.io')) return `wss://${ONLINE_SERVER}`;        // Pages mirror → Azure backend
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`; // served from the app → same origin
}
