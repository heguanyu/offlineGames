// 文件共享助手 — received-file sink for LARGE transfers. A big incoming file (e.g. a 1 GB video)
// can't be held in JS memory as an array of chunks + a Blob copy — on iOS Safari the tab's memory
// ceiling is blown and the resulting Blob comes back empty, so the download saved a 0-byte file.
// Instead, large files are streamed to IndexedDB in ~4 MB blocks as they arrive (bounded memory),
// and the service worker later streams those blocks straight to disk as a real attachment response
// (see sw.js → /fileshare/dl/<id>). Small files still travel fully in memory (see INLINE_MAX) so the
// existing "保存到相册 / 打包 .zip" batch actions keep working within the tap gesture.

// Files at or below this go fully in memory (fast, keeps share-sheet/zip synchronous); above it they
// stream to IndexedDB and are saved via the SW attachment stream. 64 MB is comfortably under iOS's
// per-tab memory pressure even with a couple of them buffered at once.
export const INLINE_MAX = 64 * 1024 * 1024;

const DB_NAME = 'offlinegames-fileshare';
const BLOCK = 4 * 1024 * 1024; // one IndexedDB record per ~4 MB → ~250 records for a 1 GB file

let _db;
function db() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blocks')) d.createObjectStore('blocks'); // key = [id, seq]
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return _db;
}

// Run `fn(store)` in a transaction; resolves with the (optional) request's result on commit.
function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => resolve(rq ? rq.result : undefined);
    t.onerror = () => reject(t.error || (rq && rq.error));
    t.onabort = () => reject(t.error);
  }));
}

function concat(parts, len) {
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

// Streams one incoming file into IndexedDB, coalescing the many small transport chunks into a few
// large blocks. push() is sync (called from the transport's onmessage); finish() awaits the flush.
export class FileSink {
  constructor(meta) {
    this.meta = meta;            // { id, name, size, mime }
    this.buf = []; this.len = 0; // pending bytes not yet flushed
    this.seq = 0;                // next block index
    this.chain = Promise.resolve();
    this.failed = false;
  }
  push(chunk) {
    const u = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.buf.push(u); this.len += u.byteLength;
    if (this.len >= BLOCK) this._flush();
  }
  _flush() {
    if (!this.len) return;
    const block = concat(this.buf, this.len).buffer;
    const seq = this.seq++; const id = this.meta.id;
    this.buf = []; this.len = 0;
    this.chain = this.chain.then(() => tx('blocks', 'readwrite', (s) => s.put(block, [id, seq])))
      .catch((e) => { this.failed = true; throw e; });
  }
  async finish() {
    this._flush();
    await this.chain; // all block writes committed
    await tx('files', 'readwrite', (s) => s.put({
      id: this.meta.id, name: this.meta.name, size: this.meta.size,
      mime: this.meta.mime, blocks: this.seq, ts: Date.now(),
    }));
  }
}

export function getMeta(id) { return tx('files', 'readonly', (s) => s.get(id)); }

// Drop a stored file and all its blocks (called once it's been saved / the session is replaced).
export async function deleteFile(id) {
  let meta; try { meta = await getMeta(id); } catch { return; }
  if (!meta) return;
  await tx('blocks', 'readwrite', (s) => { for (let i = 0; i < meta.blocks; i++) s.delete([id, i]); });
  await tx('files', 'readwrite', (s) => s.delete(id));
}

// Reclaim space left by files a crashed/closed session never cleaned up.
export async function pruneOld(maxAge = 24 * 3600 * 1000) {
  let metas; try { metas = await tx('files', 'readonly', (s) => s.getAll()); } catch { return; }
  const now = Date.now();
  for (const m of (metas || [])) if (!m.ts || now - m.ts > maxAge) await deleteFile(m.id).catch(() => {});
}
