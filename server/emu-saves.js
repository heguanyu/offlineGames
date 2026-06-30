// Optional CLOUD BACKUP of emulator saves, keyed by the browser's persistent uid — the SAME id the
// online games use (localStorage 'mahjong-online-uid'). It's a generic per-uid blob key/value store
// on the persistent /home mount (next to the SQLite DB, so it survives restarts AND redeploys): the
// client bundles ONE game's battery save + quick-state slots into a single opaque blob and PUTs it;
// the server never parses it. Manual upload/download only. There is NO auth beyond the uid acting as
// a bearer token — acceptable for game saves; a 2FA-managed admin UI may layer on later.
//
// Routes (all under /api/emu-save, CORS handled by the caller in index.js):
//   GET    ?uid=U                 → { items:[{key,size,mtime}] }   (manifest of everything for U)
//   GET    ?uid=U&key=K           → raw blob bytes (404 if absent)
//   PUT    ?uid=U&key=K  (body)   → { ok, size }   (atomic write, size-capped)
//   DELETE ?uid=U&key=K           → { ok }
import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE } from './db.js';

// BASE + the path helpers are shared with the admin/recovery handler (server/emu-admin.js).
export const BASE = path.join(path.dirname(DB_FILE), 'emu');
const MAX_BLOB = 24 * 1024 * 1024; // 24 MB per game bundle — NDS quick-states are multi-MB each
export const UID_RE = /^[A-Za-z0-9._-]{1,64}$/; // crypto.randomUUID() or the 'u-…' fallback; never a path

// encodeURIComponent collapses a key (incl. '/') into ONE filesystem-safe ASCII segment, so a key
// like "nds/Pokémon Black" can't escape the uid's directory. uid is separately validated above.
export const safe = (s) => encodeURIComponent(String(s));
export const dirFor = (uid) => path.join(BASE, uid);
export const fileFor = (uid, key) => path.join(dirFor(uid), safe(key) + '.blob');

function sendJson(res, code, obj, cors) {
  res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Handle an /api/emu-save request. `cors` is the (possibly empty) allow-origin header object the
// caller already computed. Returns nothing; always responds.
export function handleEmuSave(req, res, cors) {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') { // CORS preflight for PUT/DELETE from the Pages mirror
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' });
    res.end();
    return;
  }

  const uid = url.searchParams.get('uid') || '';
  if (!UID_RE.test(uid)) { sendJson(res, 400, { error: 'bad uid' }, cors); return; }
  const key = url.searchParams.get('key');

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!key) { // manifest of all blobs for this uid
      const items = [];
      try {
        for (const f of fs.readdirSync(dirFor(uid))) {
          if (!f.endsWith('.blob')) continue;
          const st = fs.statSync(path.join(dirFor(uid), f));
          items.push({ key: decodeURIComponent(f.slice(0, -5)), size: st.size, mtime: st.mtimeMs });
        }
      } catch { /* no directory yet → empty */ }
      sendJson(res, 200, { items }, cors);
      return;
    }
    try {
      const buf = fs.readFileSync(fileFor(uid, key));
      res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-length': buf.length });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch { sendJson(res, 404, { error: 'not found' }, cors); }
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    if (!key) { sendJson(res, 400, { error: 'missing key' }, cors); return; }
    const chunks = []; let size = 0; let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BLOB) { aborted = true; sendJson(res, 413, { error: 'too large' }, cors); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        fs.mkdirSync(dirFor(uid), { recursive: true });
        const dest = fileFor(uid, key); const tmp = dest + '.tmp';
        fs.writeFileSync(tmp, Buffer.concat(chunks)); // atomic: write-temp-then-rename
        fs.renameSync(tmp, dest);
        sendJson(res, 200, { ok: true, size }, cors);
      } catch { sendJson(res, 500, { error: 'write failed' }, cors); }
    });
    req.on('error', () => { aborted = true; try { res.writeHead(400); res.end(); } catch { /* already sent */ } });
    return;
  }

  if (req.method === 'DELETE') {
    if (!key) { sendJson(res, 400, { error: 'missing key' }, cors); return; }
    try { fs.unlinkSync(fileFor(uid, key)); } catch { /* already gone */ }
    sendJson(res, 200, { ok: true }, cors);
    return;
  }

  sendJson(res, 405, { error: 'method' }, cors);
}
