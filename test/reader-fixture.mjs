// test/reader-fixture.mjs — builds a small but real EPUB (ZIP with deflated + stored
// entries, OPF + NCX + cover + an in-chapter image) for the 电子书阅读 tests.
import zlib from 'node:zlib';

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data: Buffer|string, store?: true }] → Buffer of a valid ZIP
export function makeZip(files) {
  const chunks = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name);
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = f.store ? data : zlib.deflateRawSync(data);
    const method = f.store ? 0 : 8;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, nameB]));
    chunks.push(lh, nameB, comp);
    off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

// 1×1 red PNG
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;

export function makeEpub() {
  const para = (i) => `<p>第${i}段。春江潮水连海平，海上明月共潮生。滟滟随波千万里，何处春江无月明。江流宛转绕芳甸，月照花林皆似霰。空里流霜不觉飞，汀上白沙看不见。</p>`;
  let ch1Body = '<h2>第一章 · 长文</h2>';
  for (let i = 1; i <= 60; i++) ch1Body += para(i);
  const ch2Body = '<h2>第二章 · 图与链接</h2><p>这一章有一张图：</p><img src="img/pic.png" alt="示例图"/><p>还有一个跳到<a href="ch3.xhtml">第三章</a>的链接。</p>';
  const ch3Body = '<h2>第三章 · 结尾</h2><p>全书完。</p>';

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:identifier id="uid">reader-test-book-1</dc:identifier>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="cover.png" media-type="image/png"/>
    <item id="pic" href="img/pic.png" media-type="image/png"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>第一章 · 长文</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>第二章 · 图与链接</text></navLabel><content src="ch2.xhtml"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>第三章 · 结尾</text></navLabel><content src="ch3.xhtml"/></navPoint>
  </navMap>
</ncx>`;

  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/cover.png', data: PNG, store: true },
    { name: 'OEBPS/img/pic.png', data: PNG },
    { name: 'OEBPS/ch1.xhtml', data: xhtml('第一章', ch1Body) },
    { name: 'OEBPS/ch2.xhtml', data: xhtml('第二章', ch2Body) },
    { name: 'OEBPS/ch3.xhtml', data: xhtml('第三章', ch3Body) },
  ]);
}
