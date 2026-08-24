// 文件共享助手 batch-download ZIP writer (fileshare/zip.js) — unit test. Builds a store-only archive
// from a few in-memory blobs, then parses the bytes back (local headers → central directory → EOCD)
// and asserts the framing is valid, names de-dupe, and every file's bytes survive intact.
// Usage: node test/fileshare-zip-test.mjs
import { makeZip, writeZip } from '../fileshare/zip.js';

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

// Streaming variant: sources arrive in small chunks and the ZIP writer must emit each entry without
// ever needing an aggregate Blob. Bit 3 moves CRC/sizes into a post-data descriptor.
const chunks = [];
let maxWrite = 0;
const progress = [];
const writable = new WritableStream({
  write(value) {
    const u = value instanceof Uint8Array ? value : new Uint8Array(value);
    maxWrite = Math.max(maxWrite, u.byteLength);
    chunks.push(u.slice());
  },
});
await writeZip(files.map((f, index) => ({
  name: f.name,
  size: f.bytes.length,
  stream: () => new ReadableStream({
    start(controller) {
      const step = 37 + index * 11;
      for (let p = 0; p < f.bytes.length; p += step) controller.enqueue(f.bytes.subarray(p, p + step));
      controller.close();
    },
  }),
})), writable, { onProgress: (done, total, complete) => progress.push({ done, total, complete }) });

const streamLen = chunks.reduce((n, c) => n + c.length, 0);
const streamBuf = new Uint8Array(streamLen);
for (let p = 0, i = 0; i < chunks.length; i++) { streamBuf.set(chunks[i], p); p += chunks[i].length; }
const streamDv = new DataView(streamBuf.buffer);
let streamOff = 0;
const streamNames = [];
for (const f of files) {
  ok(streamDv.getUint32(streamOff, true) === 0x04034b50, 'stream ZIP local-header signature');
  ok(streamDv.getUint16(streamOff + 6, true) === 0x0808, 'stream ZIP uses UTF-8 + data-descriptor flags');
  const nlen = streamDv.getUint16(streamOff + 26, true);
  streamNames.push(td.decode(streamBuf.slice(streamOff + 30, streamOff + 30 + nlen)));
  const dataStart = streamOff + 30 + nlen;
  const data = streamBuf.slice(dataStart, dataStart + f.bytes.length);
  ok(data.length === f.bytes.length && data.every((b, i) => b === f.bytes[i]), `stream entry ${f.name} bytes intact`);
  const desc = dataStart + f.bytes.length;
  ok(streamDv.getUint32(desc, true) === 0x08074b50, 'stream ZIP data-descriptor signature');
  ok(streamDv.getUint32(desc + 4, true) === crc32(f.bytes), `stream entry ${f.name} crc correct`);
  ok(streamDv.getUint32(desc + 8, true) === f.bytes.length && streamDv.getUint32(desc + 12, true) === f.bytes.length,
    `stream entry ${f.name} descriptor sizes correct`);
  streamOff = desc + 16;
}
ok(streamNames[0] === 'photo.jpg' && streamNames[2] === 'photo (1).jpg', 'stream ZIP de-duplicates names');
ok(streamDv.getUint32(streamOff, true) === 0x02014b50, 'stream ZIP central directory follows entries');
ok(streamDv.getUint32(streamBuf.length - 22, true) === 0x06054b50, 'stream ZIP ends with EOCD');
ok(maxWrite <= Math.max(...files.map((f) => f.bytes.length), 100), `stream writer emits bounded pieces (largest ${maxWrite})`);
const payloadTotal = files.reduce((n, f) => n + f.bytes.length, 0);
ok(progress[0]?.done === 0 && progress[0]?.total === payloadTotal, 'stream ZIP reports progress from zero with the correct total');
ok(progress.every((p, i) => i === 0 || p.done >= progress[i - 1].done), 'stream ZIP progress is monotonic');
ok(progress.at(-1)?.done === payloadTotal && progress.at(-1)?.complete === true, 'stream ZIP reports completion at 100%');

let shortRejected = false, shortAborted = false;
try {
  await writeZip([{ name: 'short.bin', size: 2, stream: () => new Blob([new Uint8Array(1)]).stream() }],
    new WritableStream({ abort() { shortAborted = true; } }));
} catch { shortRejected = true; }
ok(shortRejected && shortAborted, 'stream ZIP rejects a short source and aborts the destination');

let hugeRejected = false, hugeAborted = false;
try {
  await writeZip([{ name: 'zip64.bin', size: 0xFFFFFFFF, stream: () => new Blob([]).stream() }],
    new WritableStream({ abort() { hugeAborted = true; } }));
} catch { hugeRejected = true; }
ok(hugeRejected && hugeAborted, 'stream ZIP rejects ZIP64-sized output before writing and aborts the destination');

if (failed) { console.log(`FILESHARE ZIP TEST FAIL (${failed})`); process.exit(1); }
console.log('FILESHARE ZIP TEST PASS');
