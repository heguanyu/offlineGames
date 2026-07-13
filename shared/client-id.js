// The ONE persistent per-browser identity, shared by every game on the site. The online games use it
// to reclaim a dropped seat on reconnect (keyed on this uid across the lobby + tables).
//
// localStorage is the primary store (historical key 'mahjong-online-uid'), additionally MIRRORED into
// a dedicated IndexedDB. iOS treats localStorage as disposable for home-screen PWAs (storage pressure
// purges it while IndexedDB survives), so without the mirror a purge would silently mint a NEW id —
// losing the online seat history. The mirror lets getClientUid() restore the original id after a purge.

const UID_KEY = 'mahjong-online-uid'; // historical name; the single key shared across all games
const ID_DB = 'client-id';

export const newUid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ID_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv', { keyPath: 'k' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get('uid');
      r.onsuccess = () => resolve(r.result ? r.result.v : null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}
function idbPut(uid) {
  try { idbOpen().then((db) => db.transaction('kv', 'readwrite').objectStore('kv').put({ k: 'uid', v: uid })); } catch { /* best effort */ }
}

// Synchronous get-or-create from localStorage, for callers that need the id at construction time
// (the online lobby + game clients build their backend before any await). Best-effort mirrors the id
// into IndexedDB in the background so a later purge is recoverable via getClientUid().
export function clientUidSync() {
  let uid = localStorage.getItem(UID_KEY);
  if (!uid) { uid = newUid(); localStorage.setItem(UID_KEY, uid); }
  idbPut(uid);
  return uid;
}

// Async durable get-or-create: if localStorage was purged, restore the original id from the IndexedDB
// mirror before minting a new one. Use this wherever you can await.
export async function getClientUid() {
  let uid = localStorage.getItem(UID_KEY);
  if (!uid) {
    uid = await idbGet();
    if (uid) localStorage.setItem(UID_KEY, uid); // restore after a purge
  }
  if (!uid) { uid = newUid(); localStorage.setItem(UID_KEY, uid); }
  idbPut(uid); // keep the mirror current
  return uid;
}
