// Minimal QR-code generator — byte mode, error-correction level M, versions 1–10. Zero deps, fully
// offline. Enough capacity (≈213 bytes at v10) for our pairing URL. Exports qrMatrix(text) → a square
// array of 0/1 (1 = dark module), and drawQR(canvas, text, opts) to render it.
//
// Implements the QR spec the standard way: GF(256) Reed–Solomon ECC, block interleaving, function
// patterns (finders/timing/alignment), the 8 data masks with penalty scoring, and BCH format/version
// info. Restricted to byte mode + level M to stay compact.

// ---- GF(256) tables (primitive polynomial 0x11D) --------------------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// Reed–Solomon ECC codewords for `data` (Uint8Array) given `ecLen` check symbols.
function rsEncode(data, ecLen) {
  // generator polynomial g(x) = ∏ (x - α^i)
  const gen = new Uint8Array(ecLen + 1); gen[0] = 1;
  for (let i = 0; i < ecLen; i++) {
    for (let j = i + 1; j > 0; j--) gen[j] = gen[j - 1] ^ gfMul(gen[j], EXP[i]);
    gen[0] = gfMul(gen[0], EXP[i]);
  }
  const res = new Uint8Array(ecLen);
  for (const d of data) {
    const factor = d ^ res[0];
    res.copyWithin(0, 1); res[ecLen - 1] = 0;
    if (factor !== 0) for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[ecLen - 1 - j], factor);
  }
  return res;
}

// ---- per-version data (error-correction level M only) ---------------------
// version → [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], …]]
const EC_M = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};
// alignment-pattern centre coordinates per version (none for v1)
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const totalDataCw = (v) => EC_M[v][1].reduce((s, [n, d]) => s + n * d, 0);

// ---- BCH for format (15-bit) and version (18-bit) info --------------------
function formatBits(mask) {
  const data = (0b00 << 3) | mask; // EC level M = 0b00
  let d = data << 10;
  for (let i = 4; i >= 0; i--) if ((d >> (10 + i)) & 1) d ^= 0b10100110111 << i;
  return ((data << 10) | (d & 0x3ff)) ^ 0b101010000010010;
}
function versionBits(v) {
  let d = v << 12;
  for (let i = 5; i >= 0; i--) if ((d >> (12 + i)) & 1) d ^= 0b1111100100101 << i;
  return (v << 12) | (d & 0xfff);
}

// ---- bit stream → codewords ----------------------------------------------
function buildCodewords(bytes, version) {
  const cap = totalDataCw(version);
  const cci = version >= 10 ? 16 : 8;            // byte-mode character-count indicator width
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                                // byte mode
  push(bytes.length, cci);
  for (const b of bytes) push(b, 8);
  // terminator (≤4 zero bits) + pad to a byte boundary
  for (let i = 0; i < 4 && bits.length < cap * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
  const PAD = [0xec, 0x11];
  for (let i = 0; cw.length < cap; i++) cw.push(PAD[i % 2]);
  return Uint8Array.from(cw);
}

// Split data codewords into blocks, append each block's RS ECC, then interleave (data first, then
// ECC) as the spec requires.
function interleave(dataCw, version) {
  const [ecLen, groups] = EC_M[version];
  const blocks = [];
  let p = 0;
  for (const [count, dataPer] of groups) {
    for (let b = 0; b < count; b++) {
      const data = dataCw.slice(p, p + dataPer); p += dataPer;
      blocks.push({ data, ec: rsEncode(data, ecLen) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const blk of blocks) if (i < blk.data.length) out.push(blk.data[i]);
  for (let i = 0; i < ecLen; i++) for (const blk of blocks) out.push(blk.ec[i]);
  return out;
}

// ---- matrix construction --------------------------------------------------
function pickVersion(len) {
  for (let v = 1; v <= 10; v++) {
    const cci = v >= 10 ? 16 : 8;
    if (4 + cci + 8 * len <= totalDataCw(v) * 8) return v;
  }
  throw new Error('QR: payload too long for v1–10');
}

function buildMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Int8Array(size).fill(-1)); // -1 = empty
  const fn = Array.from({ length: size }, () => new Uint8Array(size));         // 1 = function module (no mask)

  const setFn = (r, c, v) => { m[r][c] = v; fn[r][c] = 1; };
  // finder pattern + separator at a corner
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const r1 = r0 + r, c1 = c0 + c; if (r1 < 0 || r1 >= size || c1 < 0 || c1 >= size) continue;
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      setFn(r1, c1, on ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  // timing patterns
  for (let i = 8; i < size - 8; i++) { setFn(6, i, i % 2 === 0 ? 1 : 0); setFn(i, 6, i % 2 === 0 ? 1 : 0); }
  // alignment patterns (skip any overlapping a finder)
  const ac = ALIGN[version];
  for (const r of ac) for (const c of ac) {
    if (fn[r][c]) continue; // centre already a function module → overlaps a finder
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
      setFn(r + dr, c + dc, on ? 1 : 0);
    }
  }
  // dark module + reserve format/version areas (filled later)
  setFn(size - 8, 8, 1);
  const reserveFormat = () => {
    for (let i = 0; i < 9; i++) { if (!fn[8][i]) setFn(8, i, 0); if (!fn[i][8]) setFn(i, 8, 0); }
    for (let i = 0; i < 8; i++) { if (!fn[8][size - 1 - i]) setFn(8, size - 1 - i, 0); if (!fn[size - 1 - i][8]) setFn(size - 1 - i, 8, 0); }
  };
  reserveFormat();
  if (version >= 7) {
    for (let i = 0; i < 18; i++) { const r = (i / 3) | 0, c = i % 3; setFn(size - 11 + c, r, 0); setFn(r, size - 11 + c, 0); }
  }

  // place data with the up/down zig-zag
  const cw = interleave(buildCodewords(bytes, version), version);
  const dataBits = [];
  for (const b of cw) for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1);
  let bi = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (fn[row][cc]) continue;
        m[row][cc] = bi < dataBits.length ? dataBits[bi] : 0; bi++;
      }
    }
    up = !up;
  }

  return { m, fn, size, version };
}

const MASK = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (((r / 2) | 0) + ((c / 3) | 0)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// penalty score of a finished matrix (lower = better mask)
function penalty(m, size) {
  let p = 0;
  // rule 1: runs of ≥5 same colour, per row and per column
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1, prev = -1;
      for (let b = 0; b < size; b++) {
        const v = pass ? m[b][a] : m[a][b];
        if (v === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else { run = 1; prev = v; }
      }
    }
  }
  // rule 2: 2×2 blocks of one colour
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }
  // rule 3: finder-like 1:1:3:1:1 pattern (with 4-light run) in rows and columns
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, len) => { for (let i = 0; i + 11 <= len; i++) { let a = true, b = true; for (let k = 0; k < 11; k++) { const v = get(i + k); if (v !== pat1[k]) a = false; if (v !== pat2[k]) b = false; } if (a || b) p += 40; } };
  for (let r = 0; r < size; r++) matches((i) => m[r][i], size);
  for (let c = 0; c < size; c++) matches((i) => m[i][c], size);
  // rule 4: overall dark-module balance
  let dark = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const ratio = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

function applyFormat(m, fn, size, mask) {
  const bits = formatBits(mask);
  const get = (i) => (bits >> i) & 1;
  // copy 1 (around top-left finder)
  for (let i = 0; i <= 5; i++) m[8][i] = get(i);
  m[8][7] = get(6); m[8][8] = get(7); m[7][8] = get(8);
  for (let i = 9; i < 15; i++) m[14 - i][8] = get(i);
  // copy 2 (split across the other two finders)
  for (let i = 0; i < 8; i++) m[size - 1 - i][8] = get(i);
  for (let i = 8; i < 15; i++) m[8][size - 15 + i] = get(i);
  m[size - 8][8] = 1; // dark module (already set, keep explicit)
}

function qrMatrix(text) {
  const { m, fn, size, version } = buildMatrix(text);
  // try all 8 masks, keep the lowest-penalty result
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const t = m.map((row) => Int8Array.from(row));
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && MASK[mask](r, c)) t[r][c] ^= 1;
    applyFormat(t, fn, size, mask);
    if (version >= 7) {
      const vb = versionBits(version);
      for (let i = 0; i < 18; i++) { const bit = (vb >> i) & 1, r = (i / 3) | 0, c = i % 3; t[size - 11 + c][r] = bit; t[r][size - 11 + c] = bit; }
    }
    const score = penalty(t, size);
    if (!best || score < best.score) best = { score, t };
  }
  return best.t.map((row) => Array.from(row, (v) => v & 1));
}

// Render into a canvas. opts: { scale (px per module), margin (modules), dark, light }.
function drawQR(canvas, text, opts = {}) {
  const grid = qrMatrix(text);
  const n = grid.length;
  const margin = opts.margin ?? 4;
  const scale = opts.scale ?? 6;
  const dim = (n + margin * 2) * scale;
  canvas.width = dim; canvas.height = dim;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = opts.light ?? '#ffffff'; ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = opts.dark ?? '#000000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
  return canvas;
}

export { qrMatrix, drawQR };
