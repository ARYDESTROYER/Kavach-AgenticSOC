/**
 * QRCode — a SELF-CONTAINED, dependency-free QR Code encoder rendered as inline SVG.
 *
 * Wave 2 / F3 needs a "scan into your authenticator app" affordance for the
 * `otpauth://` enrollment URI, but the webui forbids new npm deps. This is a compact
 * port of the public-domain QR algorithm (byte mode, ECC level M, auto version 1–10):
 *
 *   text → UTF-8 bytes → data codewords (mode + length + payload + padding)
 *        → Reed–Solomon error-correction codewords → interleaved bitstream
 *        → module matrix (finder/timing/alignment/format/version) → masked → inline <svg>.
 *
 * Only versions 1–10 are supported (ample for an otpauth URI, typically ~120 bytes);
 * if the content does not fit, the component renders nothing and signals via
 * `onError` so the caller falls back to the always-shown secret + URI text.
 *
 * Security: the encoded string is operator/agent influenceable, but QR encoding is a
 * pure transform to vector rectangles — there is no markup/script surface here.
 */
import * as React from 'react';

// --------------------------------------------------------------------------- //
// Galois field GF(256) for Reed–Solomon (generator 0x11d, primitive element 2).
// --------------------------------------------------------------------------- //
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Build the Reed–Solomon generator polynomial of `degree`. */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * Reed–Solomon EC codewords for `data` given `ecLen` EC codewords — synthetic
 * division of data·x^ecLen by the monic generator. `gen[0]` is the leading 1, so
 * the division applies `gen[1..ecLen]` at positions 0..ecLen-1.
 * (Previously OFF BY ONE: it applied `gen[j]` at position j — including a phantom
 *  write past the array end — producing EC bytes that were NOT a valid RS codeword,
 *  so every block failed a conformant reader's syndrome check. Matches Nayuki
 *  qrcodegen reedSolomonComputeRemainder(); pinned by the zero-syndrome test.)
 */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift();
    res.push(0);
    for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
  }
  return res;
}

// --------------------------------------------------------------------------- //
// Version capacity tables (ECC level M only). Index = version - 1, versions 1–10.
// --------------------------------------------------------------------------- //
// Total data codewords per version at ECC-M.
const DATA_CODEWORDS_M = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
// EC codewords per block, and the block layout (group1Blocks, group1Words,
// group2Blocks, group2Words) per version at ECC-M.
const EC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M: Array<[number, number, number, number]> = [
  [1, 16, 0, 0], // v1
  [1, 28, 0, 0], // v2
  [1, 44, 0, 0], // v3
  [2, 32, 0, 0], // v4
  [2, 43, 0, 0], // v5
  [4, 27, 0, 0], // v6
  [4, 31, 0, 0], // v7
  [2, 38, 2, 39], // v8
  [3, 36, 2, 37], // v9
  [4, 43, 1, 44], // v10
];
// Alignment-pattern centre coordinates per version (versions 2–10; v1 has none).
const ALIGN_POS: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50],
];

const MODE_BYTE = 0b0100;

// --------------------------------------------------------------------------- //
// Bit buffer helper.
// --------------------------------------------------------------------------- //
class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

/** Encode `bytes` into data codewords for a chosen version (byte mode, ECC-M). */
function encodeData(bytes: number[], version: number): number[] | null {
  const totalData = DATA_CODEWORDS_M[version - 1];
  const buf = new BitBuffer();
  buf.put(MODE_BYTE, 4);
  // Character-count indicator: 8 bits for v1–9, 16 bits for v10+.
  const ccBits = version <= 9 ? 8 : 16;
  buf.put(bytes.length, ccBits);
  for (const b of bytes) buf.put(b, 8);
  const capacityBits = totalData * 8;
  if (buf.length > capacityBits) return null;
  // Terminator (up to 4 zero bits).
  const term = Math.min(4, capacityBits - buf.length);
  buf.put(0, term);
  // Pad to a byte boundary.
  while (buf.length % 8 !== 0) buf.bits.push(0);
  // Pad bytes 0xEC, 0x11 alternating.
  const codewords: number[] = [];
  for (let i = 0; i < buf.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    codewords.push(v);
  }
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (codewords.length < totalData) codewords.push(padBytes[pi++ % 2]);
  return codewords;
}

/** Interleave data + EC blocks into the final codeword stream. */
function buildFinalCodewords(dataCodewords: number[], version: number): number[] {
  const [g1Blocks, g1Words, g2Blocks, g2Words] = BLOCKS_M[version - 1];
  const ecLen = EC_PER_BLOCK_M[version - 1];
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let pos = 0;
  for (let b = 0; b < g1Blocks; b++) {
    const data = dataCodewords.slice(pos, pos + g1Words);
    pos += g1Words;
    blocks.push(data);
    ecBlocks.push(rsEncode(data, ecLen));
  }
  for (let b = 0; b < g2Blocks; b++) {
    const data = dataCodewords.slice(pos, pos + g2Words);
    pos += g2Words;
    blocks.push(data);
    ecBlocks.push(rsEncode(data, ecLen));
  }
  const maxData = Math.max(g1Words, g2Words);
  const out: number[] = [];
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) if (i < blk.length) out.push(blk[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const ecb of ecBlocks) out.push(ecb[i]);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Matrix construction.
// --------------------------------------------------------------------------- //
type Cell = 0 | 1 | null;

function placeFinder(m: Cell[][], reserved: boolean[][], r: number, c: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      reserved[rr][cc] = true;
      const inRing =
        dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
        (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = inRing ? 1 : 0;
    }
  }
}

function placeAlignment(m: Cell[][], reserved: boolean[][], version: number): void {
  const pos = ALIGN_POS[version - 1];
  for (const r of pos) {
    for (const c of pos) {
      // Skip the three positions overlapping the finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) ||
          (r === pos[pos.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          reserved[rr][cc] = true;
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[rr][cc] = ring === 1 ? 0 : 1;
        }
      }
    }
  }
}

const FORMAT_INFO_M = [
  // mask 0..7 → 15-bit format string (ECC level M = 00). Precomputed.
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

function reserveFormatAreas(reserved: boolean[][], size: number): void {
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[size - 1 - i][8] = true;
    reserved[8][size - 1 - i] = true;
  }
}

function placeFormatInfo(m: Cell[][], size: number, mask: number): void {
  const fmt = FORMAT_INFO_M[mask];
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >> i) & 1) as 0 | 1;
    // First copy around the top-left finder (ISO/IEC 18004 §8.9, bit i LSB-first):
    //   bits 0..5 DOWN column 8 (rows 0..5, skipping timing row 6), bit 6 → (7,8),
    //   bit 7 → (8,8), bit 8 → (8,7), bits 9..14 along row 8 leftwards (cols 5..0,
    //   skipping timing column 6; bit 14 lands at (8,0)).
    // (Previously TRANSPOSED — bits 0..5 ran along ROW 8 and bits 9..14 up COLUMN 8 —
    //  so a reader walking the standard order saw the 15-bit string bit-reversed and
    //  only decoders that fell back to the intact second copy could recover.)
    if (i < 6) m[i][8] = bit;
    else if (i === 6) m[7][8] = bit;
    else if (i === 7) m[8][8] = bit;
    else if (i === 8) m[8][7] = bit;
    else m[8][14 - i] = bit;
    // Second copy split near the other two finders (ISO/IEC 18004 §8.9):
    //   bits 0..7  → HORIZONTAL top-right strip, columns size-1 .. size-8 on row 8;
    //   bits 8..14 → VERTICAL bottom-left strip, rows size-7 .. size-1 on column 8.
    // (Previously inverted: it wrote bits 0..7 down the vertical bottom-left and bits
    //  8..14 across only 7 horizontal columns, leaving column size-8 of row 8 a
    //  permanent null module and making the two 15-bit copies disagree → unscannable.)
    if (i < 8) m[8][size - 1 - i] = bit;
    else m[size - 15 + i][8] = bit;
  }
  m[size - 8][8] = 1; // dark module
}

/**
 * 18-bit version information for versions >= 7 (ISO/IEC 18004 §8.10): the 6-bit
 * version number followed by its 12-bit BCH(18,6) remainder, generator polynomial
 * 0x1f25. Spec Table D.1 values for the versions this encoder reaches:
 * v7 0x07c94 · v8 0x085bc · v9 0x09a99 · v10 0x0a4d3 (asserted in tests).
 */
export function versionInfoBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  return (version << 12) | rem;
}

/**
 * Reserve AND write both 18-module version-information blocks (versions >= 7 only,
 * ISO/IEC 18004 §8.10). Bit i (LSB-first) goes to the 6×3 top-right block at
 * m[⌊i/3⌋][size-11 + i%3] (rows 0..5 × cols size-11..size-9) and to its 3×6
 * bottom-left mirror at m[size-11 + i%3][⌊i/3⌋] — Nayuki qrcodegen drawVersion()
 * with its (x, y) arguments transposed into this file's m[row][col] convention.
 * MUST run BEFORE data placement: without the reservation the zig-zag walk writes
 * data codeword bits into these modules, misaligning every subsequent bit — the
 * historical bug that made every v7+ (i.e. every real otpauth://) symbol unscannable.
 */
function placeVersionInfo(m: Cell[][], reserved: boolean[][], size: number, version: number): void {
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) as 0 | 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m[b][a] = bit; // top-right block
    reserved[b][a] = true;
    m[a][b] = bit; // bottom-left mirror
    reserved[a][b] = true;
  }
}

function maskFn(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/** Build the full module matrix for `codewords` at `version`, masked with `mask`. */
function buildMatrix(codewords: number[], version: number, mask: number): Cell[][] {
  const size = version * 4 + 17;
  const m: Cell[][] = Array.from({ length: size }, () => new Array<Cell>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  placeFinder(m, reserved, 0, 0);
  placeFinder(m, reserved, 0, size - 7);
  placeFinder(m, reserved, size - 7, 0);
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) { m[6][i] = (i % 2 === 0 ? 1 : 0); reserved[6][i] = true; }
    if (!reserved[i][6]) { m[i][6] = (i % 2 === 0 ? 1 : 0); reserved[i][6] = true; }
  }
  if (version >= 2) placeAlignment(m, reserved, version);
  reserveFormatAreas(reserved, size);
  if (version >= 7) placeVersionInfo(m, reserved, size, version);

  // Place data bits in the zig-zag pattern, applying the mask as we go.
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let bit = bitIdx < bits.length ? bits[bitIdx] : 0;
        bitIdx++;
        if (maskFn(mask, row, c)) bit ^= 1;
        m[row][c] = bit as 0 | 1;
      }
    }
    upward = !upward;
  }
  placeFormatInfo(m, size, mask);
  return m;
}

/**
 * Penalty score for a masked matrix — ISO/IEC 18004 rule 1 ONLY (runs of 5+ same-colour
 * modules in rows and columns). Rules 2–4 are intentionally not implemented: any mask
 * 0–7 yields a legal symbol, and rule 1 alone is enough to pick a reasonable one.
 */
function penalty(m: Cell[][]): number {
  const size = m.length;
  let score = 0;
  // Rule 1: runs of 5+ same-colour modules in rows + columns.
  for (let r = 0; r < size; r++) {
    let runColor = m[r][0];
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c] === runColor) { run++; } else { if (run >= 5) score += 3 + (run - 5); runColor = m[r][c]; run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = m[0][c];
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r][c] === runColor) { run++; } else { if (run >= 5) score += 3 + (run - 5); runColor = m[r][c]; run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  return score;
}

/** Result of the raw encode: the full (nullable) cell matrix + chosen version/mask. */
export interface EncodeResult {
  matrix: Cell[][];
  version: number;
  mask: number;
}

/**
 * Encode `text` into the raw QR module matrix (cells are 0 | 1 | null) plus the
 * chosen version + mask. Exposed primarily for tests (the public {@link encodeQR}
 * coerces to booleans); a well-formed symbol has ZERO null cells.
 */
export function encodeMatrix(text: string): EncodeResult | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const dc = encodeData(bytes, v);
    if (dc) { version = v; break; }
  }
  if (!version) return null;
  const dataCodewords = encodeData(bytes, version);
  if (!dataCodewords) return null;
  const finalCodewords = buildFinalCodewords(dataCodewords, version);

  let best: Cell[][] | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(finalCodewords, version, mask);
    const p = penalty(m);
    if (p < bestScore) { bestScore = p; best = m; bestMask = mask; }
  }
  if (!best) return null;
  return { matrix: best, version, mask: bestMask };
}

/** The precomputed 15-bit format strings (ECC level M) — exported for tests. */
export { FORMAT_INFO_M };

/**
 * Encode `text` into a QR module matrix (booleans; true = dark). Returns null when
 * the content does not fit versions 1–10.
 */
export function encodeQR(text: string): boolean[][] | null {
  const res = encodeMatrix(text);
  if (!res) return null;
  return res.matrix.map((row) => row.map((cell) => cell === 1));
}

export interface QRCodeProps {
  /** The string to encode (e.g. an `otpauth://` URI). */
  value: string;
  /** Rendered SVG size in pixels (square). Default 200. */
  size?: number;
  /** Quiet-zone modules around the symbol (spec minimum 4). Default 4. */
  margin?: number;
  /** Called once if the content cannot be encoded (caller shows the text fallback). */
  onError?: () => void;
  className?: string;
}

/**
 * Render `value` as an inline SVG QR code. Falls back to nothing (and calls
 * `onError`) when the content is too large for versions 1–10 — the enrollment screen
 * always also shows the secret + URI as copyable text, so scanning is never the only
 * path.
 */
export function QRCode({ value, size = 200, margin = 4, onError, className }: QRCodeProps) {
  const matrix = React.useMemo(() => {
    try {
      return encodeQR(value);
    } catch {
      return null;
    }
  }, [value]);

  React.useEffect(() => {
    if (!matrix && onError) onError();
  }, [matrix, onError]);

  if (!matrix) return null;

  const count = matrix.length;
  const total = count + margin * 2;
  // One <rect> per dark module; light is the background rect.
  const rects: React.ReactNode[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (matrix[r][c]) {
        rects.push(
          <rect key={`${r}-${c}`} x={c + margin} y={r + margin} width={1.02} height={1.02} fill="#000000" />,
        );
      }
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for authenticator enrollment"
      className={className}
    >
      <rect x={0} y={0} width={total} height={total} fill="#ffffff" />
      {rects}
    </svg>
  );
}

export default QRCode;
