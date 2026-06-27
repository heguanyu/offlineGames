// 文件共享助手 QR generator (fileshare/qr.js) — round-trip test. Generates QR matrices for several
// pairing-URL-shaped payloads (versions 1–4) and decodes them with the vendored jsQR (fileshare/
// jsqr.js, the same decoder the in-app scanner uses), asserting the decode equals the input. This
// guards the full encode pipeline end-to-end — the earlier component checks (Reed–Solomon, format
// bits) passed individually while a format-placement bug still made the code unscannable.
// Usage: node test/fileshare-qr-test.mjs
import { qrMatrix } from '../fileshare/qr.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jsQR = require('../fileshare/jsqr.js'); // UMD → the jsQR function under Node

let failed = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL:', m); failed++; } };

// render a 0/1 matrix to an RGBA bitmap (with the mandatory 4-module quiet zone) for the decoder
function toImage(g, scale = 8, margin = 4) {
  const n = g.length, dim = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) {
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const p = (((r + margin) * scale + y) * dim + ((c + margin) * scale + x)) * 4;
      data[p] = data[p + 1] = data[p + 2] = 0;
    }
  }
  return { data, dim };
}

const payloads = [
  'http://a/#xYz9',                                                       // v1
  'http://localhost:8090/fileshare/#r=ZZ99QQ11X',                         // v3
  'https://offlinegames.azurewebsites.net/fileshare/#r=AB37KP9QZ',        // v4 (real Azure URL)
  'https://heguanyu.github.io/offlineGames/fileshare/#r=QW3RTY7UP',       // v4 (real Pages URL)
];

for (const text of payloads) {
  const g = qrMatrix(text);
  const ver = (g.length - 17) / 4;
  const { data, dim } = toImage(g);
  const res = jsQR(data, dim, dim);
  ok(res && res.data === text, `v${ver} (${text.length} chars) decodes back to its input`);
}

if (failed) { console.log(`FILESHARE QR TEST FAIL (${failed})`); process.exit(1); }
console.log('FILESHARE QR TEST PASS');
