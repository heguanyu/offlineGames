// 文件共享助手 batch-download ZIP writer (fileshare/zip.js) — unit test. Builds a store-only archive
// from a few in-memory blobs, then parses the bytes back (local headers → central directory → EOCD)
// and asserts the framing is valid, names de-dupe, and every file's bytes survive intact.
// Usage: node test/fileshare-zip-test.mjs
import { makeZip } from '../fileshare/zip.js';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { console.log('  FAIL:', msg); failed++; } };

// independent CRC-32 to confirm the writer's checksums (don't reuse zip.js's table)
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const mk = (n, seed) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * seed + 11) & 0xff; return a; };
const files = [
  { name: 'photo.jpg', bytes: mk(40000, 7) },   // > one chunk worth of bytes
  { name: 'note.txt', bytes: new TextEncoder().encode('hello 文件共享 — batch zip') },
  { name: 'photo.jpg', bytes: mk(1234, 13) },    // duplicate name → must be renamed in the archive
  { name: 'empty.bin', bytes: new Uint8Array(0) }, // zero-length edge case
];

const zip = await makeZip(files.map((f) => ({ name: f.name, blob: new Blob([f.bytes]) })));
ok(zip.type === 'application/zip', 'blob type is application/zip');
const buf = new Uint8Array(await zip.arrayBuffer());
const dv = new DataView(buf.buffer);
const td = new TextDecoder();

// walk the local file entries
const entries = [];
let off = 0;
while (off + 4 <= buf.length && dv.getUint32(off, true) === 0x04034b50) {
  const method = dv.getUint16(off + 8, true);
  const crc = dv.getUint32(off + 14, true);
  const csize = dv.getUint32(off + 18, true);
  const usize = dv.getUint32(off + 22, true);
  const nlen = dv.getUint16(off + 26, true);
  const elen = dv.getUint16(off + 28, true);
  const name = td.decode(buf.slice(off + 30, off + 30 + nlen));
  const dataStart = off + 30 + nlen + elen;
  const data = buf.slice(dataStart, dataStart + csize);
  entries.push({ name, method, crc, csize, usize, data });
  off = dataStart + csize;
}

ok(entries.length === files.length, `parsed ${entries.length} local entries (want ${files.length})`);
ok(entries.every((e) => e.method === 0), 'all entries are stored (method 0)');
ok(entries.every((e) => e.csize === e.usize), 'stored: compressed size == uncompressed size');

// bytes + CRC intact, in order
for (let i = 0; i < files.length; i++) {
  const e = entries[i], want = files[i].bytes;
  ok(e && e.data.length === want.length, `entry ${i} length ${e && e.data.length} == ${want.length}`);
  let same = e && e.data.length === want.length;
  for (let j = 0; same && j < want.length; j++) if (e.data[j] !== want[j]) same = false;
  ok(same, `entry ${i} (${e && e.name}) bytes intact`);
  ok(e && e.crc === crc32(want), `entry ${i} crc correct`);
}

// duplicate "photo.jpg" must have been disambiguated
ok(entries[0].name === 'photo.jpg' && entries[2].name === 'photo (1).jpg', 'duplicate name renamed to "photo (1).jpg"');

// central directory + end-of-central-directory
ok(off + 4 <= buf.length && dv.getUint32(off, true) === 0x02014b50, 'central directory follows the local entries');
const eocd = buf.length - 22;
ok(dv.getUint32(eocd, true) === 0x06054b50, 'end-of-central-directory record present');
ok(dv.getUint16(eocd + 10, true) === files.length, 'EOCD total-entries count matches');
ok(dv.getUint32(eocd + 16, true) === off, 'EOCD central-directory offset points at the central dir');

if (failed) { console.log(`FILESHARE ZIP TEST FAIL (${failed})`); process.exit(1); }
console.log('FILESHARE ZIP TEST PASS');
