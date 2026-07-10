// NGA 论坛只读中转 (read-only relay) — 明日方舟 + 明日方舟：终末地 两个版块.
//
// The native NGA app crashes on some iPhones, so this proxies NGA's *mobile app* JSON API
// (app_api.php) — the one surface that still serves board/thread reads to a guest with NO cookies
// (the classic web `thread.php?__output=11` puts guests through a JS cookie challenge and then still
// refuses with "访客不能直接访问"). The `nga/` client renders the result.
//
// Scope is deliberately tiny and READ-ONLY:
//   GET /api/nga/board?fid=<whitelisted>&page=N  → a board's thread list
//   GET /api/nga/thread?tid=T&page=N             → one thread's posts (only if its fid is whitelisted)
//   GET /api/nga/img?u=<nga image url>           → image proxy (NGA image hosts 403 without a Referer,
//                                                  and COEP:require-corp on our pages blocks the raw
//                                                  cross-origin load — proxying same-origin fixes both)
// The fid whitelist keeps this from becoming an open proxy for all of NGA; the img host whitelist
// keeps /img from fetching arbitrary URLs. Everything is guest — we never send an account cookie.
//
// A short in-memory cache spares NGA (and us) from re-fetching on every tap; casual browsing of two
// boards never hammers the upstream.

const APP_API = 'https://ngabbs.com/app_api.php';
// NGA's iOS app UA — app_api serves guests cleanly under it.
const NGA_UA = 'NGA_skull/7.3.4(iPhone13,4;iOS 17.5.1)';
// NGA image hosts serve attachments only with an NGA Referer; also the only hosts /img will fetch.
const IMG_REFERER = 'https://bbs.nga.cn/';
const IMG_HOST_OK = /(^|\.)(nga\.178\.com|nga\.cn|ngabbs\.com)$/i;

// The ONLY boards this relay will serve. fid → display label. 明日方舟 = -34587507, 终末地 = 846.
const BOARDS = {
  '-34587507': '明日方舟',
  '846': '明日方舟：终末地',
};
const ALLOWED_FIDS = new Set(Object.keys(BOARDS));

const FETCH_TIMEOUT_MS = 12_000;
const LIST_TTL_MS = 60_000;   // thread lists move fast but not per-second
const THREAD_TTL_MS = 45_000; // a thread page: replies trickle in
const IMG_TTL_MS = 24 * 60 * 60 * 1000; // attachments are immutable (content-addressed paths)

// url → { at, status, type, body(string|Buffer) }
const cache = new Map();
const CACHE_MAX = 400;
function cacheGet(key, ttl) {
  const e = cache.get(key);
  if (e && Date.now() - e.at < ttl) return e;
  return null;
}
function cacheSet(key, val) {
  cache.set(key, { at: Date.now(), ...val });
  if (cache.size > CACHE_MAX) { // evict oldest-ish (Map preserves insertion order)
    const cutoff = cache.size - CACHE_MAX;
    let i = 0; for (const k of cache.keys()) { if (i++ >= cutoff) break; cache.delete(k); }
  }
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

// POST a form to app_api.php as the NGA app; return the parsed JSON (or throw).
async function appApi(lib, act, form) {
  const url = `${APP_API}?__lib=${encodeURIComponent(lib)}&__act=${encodeURIComponent(act)}`;
  const to = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': NGA_UA, 'X-User-Agent': NGA_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: to.signal,
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { throw new Error('nga: non-json reply'); }
    return json;
  } finally { to.done(); }
}

// app_api's list/post data can arrive as an array OR as an object keyed by numeric strings (+ stray
// meta keys like __ROWS). Normalize to an array of records that actually look like rows.
function rowsOf(data, hasKey) {
  if (!data) return [];
  const arr = Array.isArray(data) ? data : Object.keys(data).filter((k) => /^\d+$/.test(k)).map((k) => data[k]);
  return arr.filter((x) => x && typeof x === 'object' && x[hasKey] != null);
}

const numFid = (fid) => String(fid);

// A "collection" board (明日方舟 -34587507) aggregates many SUB-FORUMS; its threads carry the
// sub-forum's fid (734, 635, 805, …), NOT the board's. So thread reads can't be limited to just the
// two board fids — that 403s every sub-forum thread. Instead we LEARN the allowed thread fids from
// each board we serve: its own fid, its listed threads' fids, and its declared subForum ids. The
// reader always loads a board before its threads are clickable, so a clicked thread's fid is already
// known. Seeded with the two boards themselves; board *listing* stays locked to ALLOWED_FIDS.
const allowedThreadFids = new Set(ALLOWED_FIDS);
function learnBoardFids(fid, result) {
  allowedThreadFids.add(String(fid));
  for (const t of rowsOf(result && result.data, 'tid')) if (t.fid != null) allowedThreadFids.add(String(t.fid));
  const sf = result && result.subForum;
  if (Array.isArray(sf)) for (const s of sf) {
    const id = s && (s.id != null ? s.id : s['0']);
    if (id != null) allowedThreadFids.add(String(id));
  }
}
const isThreadFidAllowed = (fid) => allowedThreadFids.has(String(fid));

// ---- board thread list ----------------------------------------------------
async function getBoard(fid, page) {
  const key = `board:${fid}:${page}`;
  const hit = cacheGet(key, LIST_TTL_MS);
  if (hit) return hit.body;
  const j = await appApi('subject', 'list', { fid, page });
  if (j.code !== 0 || !j.result) throw new Error('nga board: ' + (j.msg || 'error ' + j.code));
  learnBoardFids(fid, j.result); // remember this board's sub-forum fids so its threads can be read
  const threads = rowsOf(j.result.data, 'tid').map((t) => ({
    tid: t.tid,
    fid: numFid(t.fid),         // which sub-forum this thread lives in (client-side filtering)
    subject: String(t.subject || ''),
    author: String(t.author || ''),
    replies: t.replies | 0,
    postdate: t.postdate | 0,   // unix seconds
    lastpost: t.lastpost | 0,   // unix seconds
    lastposter: String(t.lastposter || ''),
  }));
  // The collection board's linked sub-forums (id + name), so the client can offer "uncheck to hide"
  // filters like the native app.
  const subForums = Array.isArray(j.result.subForum)
    ? j.result.subForum.filter((s) => s && s.id != null).map((s) => ({ id: numFid(s.id), name: String(s.name || ('版块' + s.id)) }))
    : [];
  const body = JSON.stringify({ ok: true, fid: numFid(fid), label: BOARDS[numFid(fid)] || '', page: page | 0, subForums, threads });
  cacheSet(key, { body });
  return body;
}

// ---- one thread's posts ---------------------------------------------------
async function getThread(tid, page) {
  const key = `thread:${tid}:${page}`;
  const hit = cacheGet(key, THREAD_TTL_MS);
  if (hit) return hit.body;
  const j = await appApi('post', 'list', { tid, page });
  if (j.code !== 0) throw new Error('nga thread: ' + (j.msg || 'error ' + j.code));
  const fid = numFid(j.fid);
  // Whitelist enforcement on READS too, but against the LEARNED set (the two boards + their
  // sub-forums), so a hand-crafted tid to an unrelated board is refused while real sub-forum threads
  // of our boards read fine.
  if (!isThreadFidAllowed(fid)) { const e = new Error('forbidden board'); e.status = 403; throw e; }
  const prefix = String(j.attachPrefix || 'https://img.nga.178.com/attachments/');
  const posts = rowsOf(j.result, 'lou').map((p) => ({
    pid: p.pid,
    lou: p.lou | 0,
    author: (p.author && String(p.author.username || '')) || '',
    uid: (p.author && (p.author.uid | 0)) || 0,
    date: String(p.postdate || ''),
    good: p.vote_good | 0,   // 赞 (likes)
    bad: p.vote_bad | 0,     // 踩
    content: String(p.content || ''),
  }));
  const body = JSON.stringify({
    ok: true, tid: String(tid), fid, label: BOARDS[fid] || '',
    subject: String(j.tsubject || ''), author: String(j.tauthor || ''),
    page: j.currentPage | 0, totalPage: j.totalPage | 0, perPage: j.perPage | 0,
    attachPrefix: prefix, posts,
  });
  cacheSet(key, { body });
  return body;
}

// ---- image / media proxy --------------------------------------------------
// `u` is an absolute NGA media URL — an image, an emote, or an inline video (NGA's short `.gif.mp4`
// clips + `.thumb.jpg` posters, all on img.nga.178.com). The client resolves relative attach paths
// against attachPrefix before calling us. Validate the host, add the Referer NGA demands, hand the
// bytes back same-origin (with a cross-origin CORP so our COEP:require-corp pages can embed it).
async function getImage(u) {
  let parsed;
  try { parsed = new URL(u); } catch { const e = new Error('bad url'); e.status = 400; throw e; }
  if (parsed.protocol !== 'https:' || !IMG_HOST_OK.test(parsed.hostname)) { const e = new Error('bad host'); e.status = 400; throw e; }
  const key = `img:${parsed.href}`;
  const hit = cacheGet(key, IMG_TTL_MS);
  if (hit) return hit;
  const to = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(parsed.href, { headers: { 'User-Agent': NGA_UA, 'Referer': IMG_REFERER }, signal: to.signal });
    if (!r.ok) { const e = new Error('upstream ' + r.status); e.status = 502; throw e; }
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (!/^(image|video|audio)\//i.test(type)) { const e = new Error('unexpected media type'); e.status = 502; throw e; }
    const body = Buffer.from(await r.arrayBuffer());
    const val = { type, body };
    cacheSet(key, val);
    return val;
  } finally { to.done(); }
}

// ---- HTTP entry (mounted in server/index.js) ------------------------------
// Handles any /api/nga/* GET. `cors` carries the pre-computed Access-Control headers (same pattern as
// /api/weather). Returns after writing the response.
async function handleNga(req, res, cors) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = url.searchParams;
  const json = (status, obj) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(obj));
  };
  try {
    if (p === '/api/nga/board') {
      const fid = numFid(q.get('fid'));
      if (!ALLOWED_FIDS.has(fid)) return json(400, { ok: false, error: 'unknown board' });
      const page = Math.max(1, Math.min(9999, parseInt(q.get('page'), 10) || 1));
      const body = await getBoard(fid, page);
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (p === '/api/nga/thread') {
      const tid = String(q.get('tid') || '').replace(/[^\d]/g, '');
      if (!tid) return json(400, { ok: false, error: 'bad tid' });
      const page = Math.max(1, Math.min(9999, parseInt(q.get('page'), 10) || 1));
      const body = await getThread(tid, page);
      res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (p === '/api/nga/img') {
      const u = q.get('u') || '';
      const img = await getImage(u);
      res.writeHead(200, {
        ...cors,
        'content-type': img.type,
        'cache-control': 'public, max-age=86400',
        'cross-origin-resource-policy': 'cross-origin', // let COEP:require-corp pages embed it
        'content-length': img.body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : img.body);
      return;
    }
    return json(404, { ok: false, error: 'not found' });
  } catch (e) {
    const status = e && e.status ? e.status : 502;
    json(status, { ok: false, error: (e && e.message) || 'relay error' });
  }
}

export { handleNga, BOARDS, ALLOWED_FIDS, rowsOf, learnBoardFids, isThreadFidAllowed };
