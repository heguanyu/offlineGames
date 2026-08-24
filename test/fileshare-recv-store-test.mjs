// 文件共享助手 LARGE-file path — fileshare/recv-store.js (FileSink → IndexedDB) feeding the service
// worker's /fileshare/dl/<id> attachment stream. The transfer test covers only small files, which ride
// in memory; everything above INLINE_MAX takes this path instead, and a break here shows up as a
// "transfer succeeded" row whose 保存 then fails with an empty download.
// Usage: node test/fileshare-recv-store-test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); failed++; } else console.log('  ok:', m); };

// ---- a minimal, faithful-enough IndexedDB ---------------------------------------------------------
const kkey = (k) => JSON.stringify(k);
function makeIDB() {
  const dbs = new Map(); // name → { version, stores: Map<name, {keyPath, data:Map}> }
  return {
    _dbs: dbs,
    open(name, version) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let rec = dbs.get(name);
        const fresh = !rec;
        if (fresh) { rec = { version: version || 1, stores: new Map() }; dbs.set(name, rec); }
        const db = {
          get objectStoreNames() { const n = [...rec.stores.keys()]; return { contains: (s) => n.includes(s) }; },
          createObjectStore(s, opts) { rec.stores.set(s, { keyPath: opts && opts.keyPath, data: new Map() }); },
          transaction(names, mode) {
            const list = Array.isArray(names) ? names : [names];
            for (const s of list) if (!rec.stores.has(s)) { const e = new Error('store missing'); e.name = 'NotFoundError'; throw e; }
            const t = { oncomplete: null, onerror: null, onabort: null };
            t.objectStore = (s) => {
              const st = rec.stores.get(s);
              const wrap = (fn) => { const rq = { result: undefined, error: null, onsuccess: null, onerror: null };
                queueMicrotask(() => { rq.result = fn(); if (rq.onsuccess) rq.onsuccess(); }); return rq; };
              return {
                put: (v, k) => wrap(() => { st.data.set(kkey(st.keyPath ? v[st.keyPath] : k), v); }),
                get: (k) => wrap(() => st.data.get(kkey(k))),
                getAll: () => wrap(() => [...st.data.values()]),
                delete: (k) => wrap(() => { st.data.delete(kkey(k)); }),
              };
            };
            queueMicrotask(() => queueMicrotask(() => { if (t.oncomplete) t.oncomplete(); }));
            return t;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

globalThis.indexedDB = makeIDB();
const { FileSink, INLINE_MAX } = await import('../fileshare/recv-store.js');

// ---- receive a file just over INLINE_MAX, exactly as rtc.js does -----------------------------------
const SIZE = INLINE_MAX + 6 * 1024 * 1024;   // 70 MB → 18 blocks of 4 MB
const CHUNK = 256 * 1024;
const meta = { id: 1, name: '大文件.bin', size: SIZE, mime: 'application/octet-stream' };
const sink = new FileSink(meta);
let written = 0, roll = 0;
while (written < SIZE) {
  const n = Math.min(CHUNK, SIZE - written);
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (roll++) & 0xff;
  sink.push(u); written += n;
}
let finishErr = null;
try { await sink.finish(); } catch (e) { finishErr = e; }
ok(!finishErr, 'sink.finish() resolved (the UI would show 已接收)' + (finishErr ? ' — ' + finishErr.message : ''));

// ---- now ask the service worker for it, the way the 保存 link does ---------------------------------
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const listeners = {};
const self = { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, skipWaiting() {}, clients: { claim() {} }, registration: {} };
new Function('self', 'caches', 'fetch', 'location', 'Response', 'indexedDB', swSrc)(
  self,
  { open: async () => ({ match: async () => undefined, put: async () => {}, addAll: async () => {} }), keys: async () => [], match: async () => undefined },
  async () => { throw new Error('no network in this test'); },
  new URL('https://example.test/sw.js'),
  Response,
  globalThis.indexedDB,
);
ok((listeners.fetch || []).length > 0, 'sw.js registered a fetch handler');

let response = null;
const ev = {
  request: { method: 'GET', url: 'https://example.test/fileshare/dl/1', headers: new Headers() },
  respondWith: (r) => { response = r; },
  waitUntil: () => {},
};
for (const f of listeners.fetch) f(ev);
ok(!!response, 'the /fileshare/dl/<id> route was matched and answered');

const res = await response;
ok(res.status === 200, `status is 200 (got ${res.status}${res.status === 404 ? ' — "not found": the SW could not read the file back' : ''})`);
if (res.status === 200) {
  ok(res.headers.get('content-length') === String(SIZE), `content-length is the real size (${res.headers.get('content-length')} vs ${SIZE})`);
  const body = new Uint8Array(await res.arrayBuffer());
  ok(body.byteLength === SIZE, `streamed every byte (${body.byteLength} of ${SIZE})`);
  let intact = body.byteLength === SIZE;
  for (let i = 0; intact && i < SIZE; i++) if (body[i] !== (i & 0xff)) { intact = false; console.log('  first bad byte at', i); }
  ok(intact, 'bytes arrive intact');
}

console.log(failed ? `\nFAILED (${failed})` : '\nPASS');
process.exit(failed ? 1 : 0);
