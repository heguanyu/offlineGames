// reader/epub.js — minimal zero-dependency EPUB opener.
// An EPUB is a ZIP: we parse the central directory ourselves and inflate deflate
// entries with the browser's native DecompressionStream('deflate-raw') (iOS 16.4+),
// so no zip/epub library is shipped. Exposes the spine, per-chapter HTML with
// archive images rewritten to blob: URLs, the cover image, and a flat TOC.

const td = new TextDecoder();

// ---- ZIP central-directory parser ------------------------------------------------

// buf: ArrayBuffer of the whole archive → Map<name, {method, csize, usize, local}>
export function parseZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // EOCD record: scan backwards for its signature (the trailing comment can pad up to 64KB)
  let eocd = -1;
  const stop = Math.max(0, buf.byteLength - 22 - 65536);
  for (let i = buf.byteLength - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 EPUB（ZIP）文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.byteLength || dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const usize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
    if (!name.endsWith('/')) entries.set(name, { method, csize, usize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Extract one entry's bytes. Reads the LOCAL header's own name/extra lengths —
// they can differ from the central copy — to find where the data starts.
export async function readEntry(buf, entry) {
  const dv = new DataView(buf);
  const nameLen = dv.getUint16(entry.local + 26, true);
  const extraLen = dv.getUint16(entry.local + 28, true);
  const start = entry.local + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buf, start, entry.csize);
  if (entry.method === 0) return raw;                    // stored
  if (entry.method !== 8) throw new Error('不支持的压缩方式: ' + entry.method);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- path helpers (zip paths are '/'-separated, hrefs are relative + %-encoded) --

const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };

function resolvePath(dir, href) {
  let clean;
  try { clean = decodeURIComponent(href.split('#')[0].split('?')[0]); } catch { clean = href; }
  if (!clean) return '';
  if (clean.startsWith('/')) clean = clean.slice(1); else clean = dir + clean;
  const out = [];
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

// ---- EPUB ------------------------------------------------------------------------

export async function openEpub(buf) {
  const zip = parseZip(buf);
  const readXml = async (path, type = 'application/xml') => {
    const e = zip.get(path);
    if (!e) throw new Error('EPUB 缺少文件: ' + path);
    return new DOMParser().parseFromString(td.decode(await readEntry(buf, e)), type);
  };

  const container = await readXml('META-INF/container.xml');
  const opfPath = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.get(opfPath)) throw new Error('EPUB 缺少内容清单（OPF）');
  const opf = await readXml(opfPath);
  const opfDir = dirOf(opfPath);

  const meta1 = (tag) => opf.getElementsByTagNameNS('*', tag)[0]?.textContent.trim() || '';
  const title = meta1('title');
  const author = meta1('creator');

  // manifest: id → {path (zip path), type, props}; also path → media-type for images
  const items = new Map();
  const typeByPath = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) {
    const rec = {
      path: resolvePath(opfDir, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    };
    items.set(it.getAttribute('id'), rec);
    typeByPath.set(rec.path, rec.type);
  }

  // spine: reading order as zip paths
  const spineEl = opf.getElementsByTagNameNS('*', 'spine')[0];
  const spine = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const it = items.get(ref.getAttribute('idref'));
    if (it && zip.get(it.path)) spine.push(it.path);
  }
  if (!spine.length) throw new Error('EPUB 没有可阅读的章节');

  // ---- blob URLs for archive resources (images), revoked on destroy ----
  const blobUrls = new Map();
  async function urlFor(path) {
    if (blobUrls.has(path)) return blobUrls.get(path);
    const e = zip.get(path);
    if (!e) return null;
    const mime = typeByPath.get(path) || EXT_MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([await readEntry(buf, e)], { type: mime }));
    blobUrls.set(path, url);
    return url;
  }

  // Chapter i → sanitized HTML string. Scripts/styles are dropped (the reader
  // applies its own typography/theme); images become blob: URLs; internal links
  // keep their resolved zip path in data-epub-path for the reader to map to a jump.
  async function loadChapter(i) {
    const path = spine[i];
    const doc = new DOMParser().parseFromString(td.decode(await readEntry(buf, zip.get(path))), 'text/html');
    for (const n of [...doc.querySelectorAll('script, style, link')]) n.remove();
    const dir = dirOf(path);
    for (const img of doc.querySelectorAll('img[src], image')) {
      const ref = img.getAttribute('src') || img.getAttribute('xlink:href') || img.getAttribute('href');
      if (!ref || /^(https?|data):/i.test(ref)) continue;
      const url = await urlFor(resolvePath(dir, ref));
      if (!url) { img.remove(); continue; }
      if (img.tagName.toLowerCase() === 'image') img.setAttribute('href', url); // SVG <image>
      else img.setAttribute('src', url);
      img.removeAttribute('xlink:href');
    }
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      a.removeAttribute('href');
      if (!/^([a-z]+:)/i.test(href)) a.setAttribute('data-epub-path', resolvePath(dir, href));
    }
    return doc.body ? doc.body.innerHTML : '';
  }

  // cover: EPUB3 properties="cover-image", else EPUB2 <meta name="cover" content="itemId">
  async function cover() {
    let it = [...items.values()].find((i) => /\bcover-image\b/.test(i.props));
    if (!it) {
      for (const m of opf.getElementsByTagNameNS('*', 'meta')) {
        if (m.getAttribute('name') === 'cover') { it = items.get(m.getAttribute('content')); break; }
      }
    }
    const e = it && zip.get(it.path);
    if (!e) return null;
    return new Blob([await readEntry(buf, e)], { type: typeByPath.get(it.path) || 'image/jpeg' });
  }

  // Flat TOC → [{label, spine}] mapped onto spine indices. EPUB3 nav doc first, NCX fallback.
  async function toc() {
    const raw = [];
    try {
      const nav = [...items.values()].find((i) => /\bnav\b/.test(i.props));
      if (nav && zip.get(nav.path)) {
        const doc = new DOMParser().parseFromString(td.decode(await readEntry(buf, zip.get(nav.path))), 'text/html');
        for (const a of doc.querySelectorAll('nav a[href]')) {
          raw.push({ label: a.textContent.trim(), path: resolvePath(dirOf(nav.path), a.getAttribute('href')) });
        }
      } else {
        const ncx = items.get(spineEl?.getAttribute('toc')) ||
          [...items.values()].find((i) => i.type === 'application/x-dtbncx+xml');
        if (ncx && zip.get(ncx.path)) {
          const doc = await readXml(ncx.path);
          for (const np of doc.getElementsByTagNameNS('*', 'navPoint')) {
            const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent.trim() || '';
            const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src') || '';
            if (label && src) raw.push({ label, path: resolvePath(dirOf(ncx.path), src) });
          }
        }
      }
    } catch { /* a broken TOC never blocks reading */ }
    return raw.map((t) => ({ label: t.label, spine: spine.indexOf(t.path) })).filter((t) => t.spine >= 0);
  }

  const pathToSpine = (path) => spine.indexOf(path);

  function destroy() {
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    blobUrls.clear();
  }

  return { title, author, spine, loadChapter, cover, toc, pathToSpine, destroy };
}
