// CLOUD BACKUP of emulator saves, keyed by the browser's persistent uid — the SAME id the online
// games use (see shared/client-id.js, which owns the get-or-create + IndexedDB mirror). Manual
// upload/download only. The server (server/emu-saves.js) is a dumb per-uid blob store; THIS module
// owns the bundle format — one game's battery save + quick-state slots packed into a single JSON blob
// (base64 payloads). The host is resolved via apiBase() so a page on the Pages mirror reaches across
// to the Azure backend, identically to the WebSocket lobby.
import { apiBase } from '../games/mahjong-common-online/server-url.js';
import { getClientUid } from './client-id.js';

// Chunked to stay under the apply() arg limit on multi-MB states.
function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToU8(b64) {
  const s = atob(b64); const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

const keyFor = (system, game) => system + '/' + game;
const urlFor = (uid, system, game) =>
  apiBase() + '/api/emu-save?uid=' + encodeURIComponent(uid) + '&key=' + encodeURIComponent(keyFor(system, game));

// Upload one game's saves. bundle = { battery: Uint8Array|null, states: [{slot, variant, data:Uint8Array}] }
export async function uploadGameSaves(system, game, bundle) {
  const uid = await getClientUid();
  const payload = {
    v: 1, ts: Date.now(),
    battery: bundle.battery ? u8ToB64(bundle.battery) : null,
    states: (bundle.states || []).map((s) => ({ slot: s.slot, variant: s.variant ?? null, data: u8ToB64(s.data) })),
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const res = await fetch(urlFor(uid, system, game), {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body,
  });
  if (!res.ok) throw new Error('upload failed (' + res.status + ')');
  return res.json();
}

// Fetch one game's saves, or null if none stored. Returns the same bundle shape (Uint8Arrays).
export async function fetchGameSaves(system, game) {
  const uid = await getClientUid();
  const res = await fetch(urlFor(uid, system, game));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('download failed (' + res.status + ')');
  const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer())));
  return {
    ts: payload.ts,
    battery: payload.battery ? b64ToU8(payload.battery) : null,
    states: (payload.states || []).map((s) => ({ slot: s.slot, variant: s.variant ?? null, data: b64ToU8(s.data) })),
  };
}
