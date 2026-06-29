// 文件共享助手 — minimal STORE-only ZIP writer (zero deps, works offline). Bundles received files
// into ONE archive so they save to Files in a single tap — iOS Safari allows only one download per
// user gesture, so a "download each" loop is blocked after the first. No compression (method 0): the
// payloads are usually already-compressed media, so storing keeps the code tiny and the CPU cost ~0.
// Per-file size is a uint32, so individual files must be < 4 GB (no ZIP64) — fine for phone transfers.

// CRC-32 (IEEE 802.3) — the polynomial table is built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const enc = new TextEncoder();

// De-dupe names within one archive: "photo.jpg" → "photo (1).jpg" → "photo (2).jpg".
function uniqueName(name, used) {
  let n = name || 'file';
  const dot = n.lastIndexOf('.');
  const base = dot > 0 ? n.slice(0, dot) : n;
  const ext = dot > 0 ? n.slice(dot) : '';
  let i = 1;
  while (used.has(n.toLowerCase())) n = `${base} (${i++})${ext}`;
  used.add(n.toLowerCase());
  return n;
}

// Build a Blob (application/zip) from [{ name, blob }], stored uncompressed. Returns a Promise<Blob>.
export async function makeZip(files) {
  const parts = [];     // output byte pieces, in order
  const central = [];   // central-directory records (written after all local entries)
  const used = new Set();
  let offset = 0;       // running byte offset → each entry's local-header position

  for (const { name, blob } of files) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(data);
    const fname = enc.encode(uniqueName(name, used));
    const size = data.length;

    // local file header (signature 0x04034b50), all multi-byte fields little-endian
    const local = new Uint8Array(30 + fname.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);      // version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true);  // general-purpose flag: bit 11 = UTF-8 filename
    lv.setUint16(8, 0, true);       // method 0 = stored
    lv.setUint16(10, 0, true);      // mod time (unset)
    lv.setUint16(12, 0, true);      // mod date (unset)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);   // compressed size (== uncompressed for stored)
    lv.setUint32(22, size, true);   // uncompressed size
    lv.setUint16(26, fname.length, true);
    lv.setUint16(28, 0, true);      // extra-field length
    local.set(fname, 30);
    parts.push(local, data);

    // central-directory record (signature 0x02014b50)
    const cen = new Uint8Array(46 + fname.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);      // version made by
    cv.setUint16(6, 20, true);      // version needed
    cv.setUint16(8, 0x0800, true);  // UTF-8 flag
    cv.setUint16(10, 0, true);      // method
    cv.setUint16(12, 0, true);      // mod time
    cv.setUint16(14, 0, true);      // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);   // compressed size
    cv.setUint32(24, size, true);   // uncompressed size
    cv.setUint16(28, fname.length, true);
    cv.setUint16(30, 0, true);      // extra length
    cv.setUint16(32, 0, true);      // comment length
    cv.setUint16(34, 0, true);      // disk number start
    cv.setUint16(36, 0, true);      // internal attrs
    cv.setUint32(38, 0, true);      // external attrs
    cv.setUint32(42, offset, true); // relative offset of local header
    cen.set(fname, 46);
    central.push(cen);

    offset += local.length + size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }

  // end-of-central-directory record (signature 0x06054b50)
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);  // entries on this disk
  ev.setUint16(10, central.length, true); // total entries
  ev.setUint32(12, cdSize, true);         // central-directory size
  ev.setUint32(16, cdStart, true);        // central-directory offset
  parts.push(end);

  return new Blob(parts, { type: 'application/zip' });
}
