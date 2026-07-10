// reader/epub.js ZIP layer — unit test (Node ≥18: DecompressionStream is global).
// Builds a real archive with deflated + stored entries via reader-fixture.mjs's
// independent writer, then asserts the central-directory walk and extraction.
// Usage: node test/reader-zip-test.mjs
import { parseZip, readEntry } from '../reader/epub.js';
import { makeZip, makeEpub, PNG } from './reader-fixture.mjs';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { console.log('  FAIL:', msg); failed++; } };
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const td = new TextDecoder();

// ---- hand-built archive: stored + deflated + binary + utf-8 name + comment padding ----
const text = '春江潮水连海平，海上明月共潮生。'.repeat(200);
const bin = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7 + 3) & 0xff));
const zipBuf = toAB(makeZip([
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: '文件夹/长文.txt', data: text },
  { name: 'img/pic.bin', data: bin },
  { name: 'empty.txt', data: '' },
]));

const entries = parseZip(zipBuf);
ok(entries.size === 4, `4 entries parsed (got ${entries.size})`);
ok(entries.has('mimetype') && entries.has('文件夹/长文.txt'), 'names decoded (incl. utf-8)');
ok(entries.get('mimetype').method === 0, 'mimetype is stored');
ok(entries.get('img/pic.bin').method === 8, 'binary entry is deflated');
ok(entries.get('文件夹/长文.txt').usize === Buffer.byteLength(text), 'uncompressed size recorded');

ok(td.decode(await readEntry(zipBuf, entries.get('mimetype'))) === 'application/epub+zip', 'stored entry roundtrips');
ok(td.decode(await readEntry(zipBuf, entries.get('文件夹/长文.txt'))) === text, 'deflated text roundtrips');
const binOut = await readEntry(zipBuf, entries.get('img/pic.bin'));
ok(binOut.length === bin.length && Buffer.from(binOut).equals(bin), 'deflated binary roundtrips');
ok((await readEntry(zipBuf, entries.get('empty.txt'))).length === 0, 'empty entry ok');

// ---- garbage input rejects cleanly ----
let threw = false;
try { parseZip(toAB(Buffer.from('this is not a zip at all'))); } catch { threw = true; }
ok(threw, 'non-zip input throws');

// ---- the full EPUB fixture parses and its core files extract ----
const epubBuf = toAB(makeEpub());
const ez = parseZip(epubBuf);
for (const name of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/ch1.xhtml', 'OEBPS/cover.png']) {
  ok(ez.has(name), `epub fixture has ${name}`);
}
ok(td.decode(await readEntry(epubBuf, ez.get('OEBPS/content.opf'))).includes('测试之书'), 'opf extracts with utf-8 intact');
const png = await readEntry(epubBuf, ez.get('OEBPS/cover.png'));
ok(Buffer.from(png).equals(PNG), 'stored cover png byte-identical');

console.log(failed ? `reader-zip-test: ${failed} FAILURE(S)` : 'reader-zip-test: all ok');
process.exit(failed ? 1 : 0);
