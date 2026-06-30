// ADMIN view/recovery over the emulator cloud-save store (server/emu-saves.js writes the blobs;
// this only reads them). The per-uid store has no real auth — the uid acts as a bearer token — so
// once you lose the uid (e.g. the browser container that held it was deleted) you can't find your
// own blobs again. This handler lets an operator enumerate EVERY uid and download any blob to
// recover saves whose uid was lost. Because that exposes all users' saves, it is gated by a shared
// ADMIN_TOKEN (env). If ADMIN_TOKEN is unset the whole endpoint is disabled (503) — it never
// defaults to open.
//
// Routes (all GET, under /api/emu-admin; token via `x-admin-token` header or `?token=`):
//   GET /api/emu-admin                 → { uids:[{uid, items, bytes, mtime}] }   (everything on disk)
//   GET /api/emu-admin?uid=U           → { uid, items:[{key, size, mtime}] }      (one uid's blobs)
//   GET /api/emu-admin?uid=U&key=K     → raw blob bytes (the save bundle, 404 if absent)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BASE, UID_RE, dirFor, fileFor } from './emu-saves.js';

function sendJson(res, code, obj, cors) {
  res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Constant-time compare that also resists length leaks. Returns false unless ADMIN_TOKEN is set
// AND equals the supplied token — so a missing/empty env can never authorize.
function tokenOk(supplied) {
  const want = process.env.ADMIN_TOKEN || '';
  if (!want) return false;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Summarise one uid's directory: blob count, total bytes, newest mtime.
function summariseUid(uid) {
  let items = 0; let bytes = 0; let mtime = 0;
  try {
    for (const f of fs.readdirSync(dirFor(uid))) {
      if (!f.endsWith('.blob')) continue;
      const st = fs.statSync(path.join(dirFor(uid), f));
      items++; bytes += st.size; if (st.mtimeMs > mtime) mtime = st.mtimeMs;
    }
  } catch { /* vanished mid-scan → treat as empty */ }
  return { uid, items, bytes, mtime };
}

export function handleEmuAdmin(req, res, cors) {
  if (req.method === 'OPTIONS') { // preflight: the viewer sends the x-admin-token header
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'x-admin-token, content-type', 'Access-Control-Max-Age': '600' });
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method' }, cors); return; }

  if (!process.env.ADMIN_TOKEN) { sendJson(res, 503, { error: 'admin disabled: ADMIN_TOKEN not set' }, cors); return; }

  const url = new URL(req.url, 'http://x');
  const supplied = req.headers['x-admin-token'] || url.searchParams.get('token');
  if (!tokenOk(supplied)) { sendJson(res, 401, { error: 'bad or missing admin token' }, cors); return; }

  const uid = url.searchParams.get('uid');
  const key = url.searchParams.get('key');

  if (!uid) { // list every uid on disk
    let uids = [];
    try {
      uids = fs.readdirSync(BASE, { withFileTypes: true })
        .filter((d) => d.isDirectory() && UID_RE.test(d.name))
        .map((d) => summariseUid(d.name))
        .sort((a, b) => b.mtime - a.mtime); // most recently written first
    } catch { /* BASE not created yet → no saves anywhere */ }
    sendJson(res, 200, { uids }, cors);
    return;
  }

  if (!UID_RE.test(uid)) { sendJson(res, 400, { error: 'bad uid' }, cors); return; }

  if (!key) { // one uid's blob manifest
    const items = [];
    try {
      for (const f of fs.readdirSync(dirFor(uid))) {
        if (!f.endsWith('.blob')) continue;
        const st = fs.statSync(path.join(dirFor(uid), f));
        items.push({ key: decodeURIComponent(f.slice(0, -5)), size: st.size, mtime: st.mtimeMs });
      }
    } catch { /* unknown uid → empty */ }
    sendJson(res, 200, { uid, items }, cors);
    return;
  }

  try { // serve one blob for download / recovery
    const buf = fs.readFileSync(fileFor(uid, key));
    res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch { sendJson(res, 404, { error: 'not found' }, cors); }
}
