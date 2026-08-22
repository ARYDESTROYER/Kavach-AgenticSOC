/**
 * QRCode regression tests — the MFA QR must be SCANNABLE by real phone readers.
 *
 * Historical bugs pinned here (ISO/IEC 18004 conformance):
 *   BUG-2a — the second format-info copy was placed inverted (bits 0..7 down the
 *   vertical bottom-left, bits 8..14 across only 7 columns), leaving a permanent
 *   null module and making the two 15-bit copies disagree.
 *   BUG-2b — the FIRST format-info copy was TRANSPOSED vs the spec order (bits 0..5
 *   along row 8 instead of down column 8, bits 9..14 up column 8 instead of along
 *   row 8), so a reader walking the standard order saw the string bit-reversed.
 *   BUG-2c — the two 18-bit version-information blocks required for version >= 7
 *   were never reserved OR written, so every real otpauth:// symbol (always v7+)
 *   carried data bits in the version areas: conformant readers rejected the version
 *   info outright, and size-inferring readers mis-walked every data bit after it.
 *
 * These tests pin the fixes three ways: (1) direct placement reads in the spec
 * order, (2) BCH-checked version-information blocks against Table D.1, and (3) a
 * fully independent structural DECODER (format BCH(15,5) from both copies,
 * function-map rebuild, un-masking, zig-zag walk, block de-interleave, Reed–Solomon
 * zero-syndrome verification, byte-mode payload parse) that round-trips short
 * (v<7), real otpauth (v7), and long (v10) payloads back to the exact input.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  QRCode,
  encodeMatrix,
  encodeQR,
  FORMAT_INFO_M,
  versionInfoBits,
} from '../QRCode';

type Matrix = Array<Array<0 | 1 | null>>;

/** Realistic enrollment URI (107 bytes) → version 7 at ECC-M, exactly like production. */
const OTPAUTH =
  'otpauth://totp/AgenticSOC:admin?secret=JBSWY3DPEHPK3PXP&issuer=AgenticSOC&algorithm=SHA1&digits=6&period=30';

/** Short URI (40 bytes) → version 3: exercises the v<7 path (no version info). */
const OTPAUTH_SHORT = 'otpauth://totp/T?secret=JBSWY3DPEHPK3PXP';

/** Long URI (204 bytes) → version 10: 16-bit char count + two-group interleaving. */
const OTPAUTH_LONG =
  'otpauth://totp/Agentic%20SOC%3Asecurity-operations-admin%40example-corporation.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Agentic%20Security%20Operations%20Center&algorithm=SHA1&digits=6&period=30';

/**
 * Read the first (top-left) 15-bit format copy in the ISO/IEC 18004 §8.9 order
 * (matching Nayuki qrcodegen drawFormatBits): bits 0..5 DOWN column 8 (rows 0..5,
 * skipping timing row 6), bit 6 at (7,8), bit 7 at (8,8), bit 8 at (8,7), bits
 * 9..14 along row 8 leftwards (cols 5..0, skipping timing column 6).
 */
function readFormatCopy1(m: Matrix): number {
  let v = 0;
  for (let i = 0; i < 15; i++) {
    let cell: 0 | 1 | null;
    if (i < 6) cell = m[i][8];
    else if (i === 6) cell = m[7][8];
    else if (i === 7) cell = m[8][8];
    else if (i === 8) cell = m[8][7];
    else cell = m[8][14 - i];
    v |= (cell ? 1 : 0) << i;
  }
  return v;
}

/**
 * Read the second (split) 15-bit format copy: bits 0..7 along the HORIZONTAL
 * top-right strip (row 8, cols size-1..size-8), bits 8..14 down the VERTICAL
 * bottom-left strip (col 8, rows size-7..size-1).
 */
function readFormatCopy2(m: Matrix): number {
  const size = m.length;
  let v = 0;
  for (let i = 0; i < 15; i++) {
    const cell = i < 8 ? m[8][size - 1 - i] : m[size - 15 + i][8];
    v |= (cell ? 1 : 0) << i;
  }
  return v;
}

/** Read the 18-bit version block from the 6×3 TOP-RIGHT area (bit i LSB-first). */
function readVersionTopRight(m: Matrix): number {
  const size = m.length;
  let v = 0;
  for (let i = 0; i < 18; i++) v |= (m[Math.floor(i / 3)][size - 11 + (i % 3)] ? 1 : 0) << i;
  return v;
}

/** Read the 18-bit version block from the 3×6 BOTTOM-LEFT mirror area. */
function readVersionBottomLeft(m: Matrix): number {
  const size = m.length;
  let v = 0;
  for (let i = 0; i < 18; i++) v |= (m[size - 11 + (i % 3)][Math.floor(i / 3)] ? 1 : 0) << i;
  return v;
}

// --------------------------------------------------------------------------- //
// Independent structural decoder (pure TS, test-only, no deps). Everything below
// is re-derived from ISO/IEC 18004 — structure tables transcribed from the
// standard, NOT imported from the component — so it cross-checks the encoder.
// --------------------------------------------------------------------------- //

/** ECC-M total data codewords, per version 1..10 (spec Table 7). */
const DEC_DATA_CW: Record<number, number> = {
  1: 16, 2: 28, 3: 44, 4: 64, 5: 86, 6: 108, 7: 124, 8: 154, 9: 182, 10: 216,
};
/** ECC-M error-correction codewords per block, per version 1..10 (spec Table 9). */
const DEC_EC_PER_BLOCK: Record<number, number> = {
  1: 10, 2: 16, 3: 26, 4: 18, 5: 24, 6: 16, 7: 18, 8: 22, 9: 22, 10: 26,
};
/** ECC-M block layout [g1Blocks, g1DataWords, g2Blocks, g2DataWords] (spec Table 9). */
const DEC_BLOCKS: Record<number, [number, number, number, number]> = {
  1: [1, 16, 0, 0], 2: [1, 28, 0, 0], 3: [1, 44, 0, 0], 4: [2, 32, 0, 0],
  5: [2, 43, 0, 0], 6: [4, 27, 0, 0], 7: [4, 31, 0, 0], 8: [2, 38, 2, 39],
  9: [3, 36, 2, 37], 10: [4, 43, 1, 44],
};
/** Alignment-pattern centre coordinates per version 1..10 (spec Table E.1). */
const DEC_ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/** BCH(15,5) validity: the top-5 data bits must regenerate the 10-bit remainder (gen 0x537). */
function bchFormat15Valid(code: number): boolean {
  const data = code >> 10;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  return ((data << 10) | rem) === code;
}

/** BCH(18,6) validity: the top-6 version bits must regenerate the 12-bit remainder (gen 0x1f25). */
function bchVersion18Valid(code: number): boolean {
  const ver = code >> 12;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  return ((ver << 12) | rem) === code;
}

// GF(256) tables for the Reed–Solomon syndrome check (primitive polynomial 0x11d).
const DEXP = new Uint8Array(512);
const DLOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    DEXP[i] = x;
    DLOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) DEXP[i] = DEXP[i - 255];
}
function dMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : DEXP[DLOG[a] + DLOG[b]];
}

/** The 8 mask predicates, re-derived from the spec (true = flip the module). */
function maskPredicate(mask: number, r: number, c: number): boolean {
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

/**
 * Rebuild the function-module reservation map for a version, per spec: finders +
 * separators, timing, alignment (from the version's coordinate table), format
 * areas + dark module, and version areas for v >= 7. Data occupies everything else.
 */
function functionModuleMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const f: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r: number, c: number): void => {
    if (r >= 0 && c >= 0 && r < size && c < size) f[r][c] = true;
  };
  // Finder patterns + separators (8×8 corners incl. the separator ring).
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(fr + dr, fc + dc);
  }
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    f[6][i] = true;
    f[i][6] = true;
  }
  // Alignment patterns (skip the three overlapping the finders).
  const pos = DEC_ALIGN[version];
  const last = pos[pos.length - 1];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  // Format areas + dark module.
  for (let i = 0; i <= 8; i++) {
    f[8][i] = true;
    f[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    f[size - 1 - i][8] = true; // vertical bottom-left strip + dark module at size-8
    f[8][size - 1 - i] = true; // horizontal top-right strip
  }
  // Version-information areas (v >= 7).
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      f[Math.floor(i / 3)][size - 11 + (i % 3)] = true;
      f[size - 11 + (i % 3)][Math.floor(i / 3)] = true;
    }
  }
  return f;
}

interface StructuralDecode {
  version: number;
  /** 2-bit EC-level indicator from the format info (M = 0b00). */
  ecLevel: number;
  mask: number;
  payload: string;
}

/**
 * Decode a produced matrix EXACTLY the way a conformant reader would (minus optical
 * sampling): format info from BOTH copies (unmask 0x5412, BCH(15,5)), version info
 * for v >= 7 (BCH(18,6)), un-mask, zig-zag data walk over the rebuilt function map,
 * codeword reassembly, block de-interleave, Reed–Solomon all-zero-syndrome check,
 * and byte-mode payload parse. Throws on ANY structural violation.
 */
function decodeStructurally(matrix: Matrix): StructuralDecode {
  const size = matrix.length;
  if ((size - 17) % 4 !== 0) throw new Error(`invalid symbol size ${size}`);
  const version = (size - 17) / 4;
  if (version < 1 || version > 10) throw new Error(`unsupported version ${version}`);

  // (a) Format information — both copies must be BCH-valid and agree.
  const raw1 = readFormatCopy1(matrix);
  const raw2 = readFormatCopy2(matrix);
  if (raw1 !== raw2) throw new Error(`format-info copies disagree (${raw1} vs ${raw2})`);
  const code = raw1 ^ 0x5412;
  if (!bchFormat15Valid(code)) throw new Error('format info fails BCH(15,5)');
  const data5 = code >> 10;
  const ecLevel = (data5 >> 3) & 3;
  const mask = data5 & 7;

  // (b) Version information — both blocks must be BCH-valid and name this version.
  if (version >= 7) {
    for (const read of [readVersionTopRight, readVersionBottomLeft]) {
      const code18 = read(matrix);
      if (!bchVersion18Valid(code18)) throw new Error('version info fails BCH(18,6)');
      if (code18 >> 12 !== version) {
        throw new Error(`version info decodes to ${code18 >> 12}, symbol size says ${version}`);
      }
    }
  }

  // (c) Un-mask + zig-zag data extraction over the rebuilt function-module map.
  const fmap = functionModuleMap(version);
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (fmap[row][c]) continue;
        const cell = matrix[row][c];
        if (cell !== 0 && cell !== 1) throw new Error(`null data module at (${row},${c})`);
        bits.push(cell ^ (maskPredicate(mask, row, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }

  const [g1B, g1W, g2B, g2W] = DEC_BLOCKS[version];
  const ecLen = DEC_EC_PER_BLOCK[version];
  const totalCw = DEC_DATA_CW[version] + (g1B + g2B) * ecLen;
  if (bits.length < totalCw * 8) {
    throw new Error(`only ${bits.length} data modules for ${totalCw} codewords`);
  }
  // Remainder bits must be 0 after un-masking (spec §8.7.3).
  for (let i = totalCw * 8; i < bits.length; i++) {
    if (bits[i] !== 0) throw new Error('nonzero remainder bit');
  }
  const cws: number[] = [];
  for (let i = 0; i < totalCw; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    cws.push(v);
  }

  // (d) De-interleave into blocks and verify every RS block (all-zero syndromes).
  const dataLens = [...new Array<number>(g1B).fill(g1W), ...new Array<number>(g2B).fill(g2W)];
  const nBlocks = dataLens.length;
  const dataBlocks: number[][] = dataLens.map(() => []);
  const ecBlocks: number[][] = dataLens.map(() => []);
  let idx = 0;
  const maxW = Math.max(g1W, g2W);
  for (let i = 0; i < maxW; i++) {
    for (let b = 0; b < nBlocks; b++) if (i < dataLens[b]) dataBlocks[b].push(cws[idx++]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < nBlocks; b++) ecBlocks[b].push(cws[idx++]);
  }
  if (idx !== totalCw) throw new Error('codeword de-interleave mismatch');
  for (let b = 0; b < nBlocks; b++) {
    const cwPoly = [...dataBlocks[b], ...ecBlocks[b]];
    for (let j = 0; j < ecLen; j++) {
      // Evaluate the codeword polynomial at alpha^j (Horner) — must be 0.
      let y = 0;
      for (const cwByte of cwPoly) y = dMul(y, DEXP[j]) ^ cwByte;
      if (y !== 0) throw new Error(`block ${b}: nonzero RS syndrome at alpha^${j}`);
    }
  }

  // (e) Byte-mode payload parse from the de-interleaved data codewords.
  const dataStream: number[] = dataBlocks.flat();
  const dbits: number[] = [];
  for (const cw of dataStream) for (let j = 7; j >= 0; j--) dbits.push((cw >> j) & 1);
  let p = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | dbits[p++];
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode 0b0100, got ${mode}`);
  const count = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = take(8);
  return { version, ecLevel, mask, payload: new TextDecoder().decode(out) };
}

// --------------------------------------------------------------------------- //
// Tests.
// --------------------------------------------------------------------------- //

describe('QRCode encodeMatrix (otpauth enrollment URI)', () => {
  const res = encodeMatrix(OTPAUTH);

  it('encodes the URI (does not overflow versions 1–10)', () => {
    expect(res).not.toBeNull();
  });

  it('produces a square matrix with the expected version dimensions', () => {
    if (!res) throw new Error('expected a matrix');
    const size = res.version * 4 + 17;
    expect(res.matrix.length).toBe(size);
    for (const row of res.matrix) expect(row.length).toBe(size);
    // This payload is 107 bytes → version 7 (45×45) at ECC-M.
    expect(res.version).toBe(7);
    expect(res.matrix.length).toBe(45);
  });

  it('has ZERO null/undefined modules anywhere (no permanent null cell)', () => {
    if (!res) throw new Error('expected a matrix');
    for (let r = 0; r < res.matrix.length; r++) {
      for (let c = 0; c < res.matrix.length; c++) {
        const cell = res.matrix[r][c];
        expect(cell === 0 || cell === 1).toBe(true);
      }
    }
  });

  it('places both 15-bit format copies equal to each other AND to FORMAT_INFO_M[mask]', () => {
    if (!res) throw new Error('expected a matrix');
    const expected = FORMAT_INFO_M[res.mask];
    const copy1 = readFormatCopy1(res.matrix);
    const copy2 = readFormatCopy2(res.matrix);
    expect(copy1).toBe(expected);
    expect(copy2).toBe(expected);
    expect(copy1).toBe(copy2);
  });

  it('writes a BCH(15,5)-valid format string readable in the spec order', () => {
    if (!res) throw new Error('expected a matrix');
    const code = readFormatCopy1(res.matrix) ^ 0x5412;
    expect(bchFormat15Valid(code)).toBe(true);
    const data5 = code >> 10;
    expect((data5 >> 3) & 3).toBe(0b00); // EC level M indicator
    expect(data5 & 7).toBe(res.mask);
  });

  it('keeps the fixed dark module at m[size-8][8]', () => {
    if (!res) throw new Error('expected a matrix');
    const size = res.matrix.length;
    expect(res.matrix[size - 8][8]).toBe(1);
  });
});

describe('QRCode version information (versions >= 7)', () => {
  it('versionInfoBits matches ISO/IEC 18004 Table D.1 for every reachable version', () => {
    const KNOWN: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
    for (const [v, bits] of Object.entries(KNOWN)) {
      expect(versionInfoBits(Number(v))).toBe(bits);
      expect(bchVersion18Valid(bits)).toBe(true);
    }
  });

  it('writes BOTH 18-bit version blocks, BCH(18,6)-valid and decoding to the chosen version', () => {
    const res = encodeMatrix(OTPAUTH);
    if (!res) throw new Error('expected a matrix');
    expect(res.version).toBeGreaterThanOrEqual(7);
    const topRight = readVersionTopRight(res.matrix);
    const bottomLeft = readVersionBottomLeft(res.matrix);
    expect(bchVersion18Valid(topRight)).toBe(true);
    expect(bchVersion18Valid(bottomLeft)).toBe(true);
    expect(topRight >> 12).toBe(res.version);
    expect(bottomLeft).toBe(topRight);
    expect(topRight).toBe(versionInfoBits(res.version));
  });

  it('places no version blocks below version 7 (they are not part of the symbol)', () => {
    const res = encodeMatrix(OTPAUTH_SHORT);
    if (!res) throw new Error('expected a matrix');
    expect(res.version).toBeLessThan(7);
    // Nothing to assert positionally — v<7 symbols simply have data there; the
    // structural round-trip below proves the layout is fully consistent.
  });
});

describe('QRCode structural decode (independent spec decoder, full round-trip)', () => {
  function roundTrip(text: string): StructuralDecode {
    const res = encodeMatrix(text);
    expect(res).not.toBeNull();
    if (!res) throw new Error('expected a matrix');
    const dec = decodeStructurally(res.matrix);
    expect(dec.version).toBe(res.version);
    expect(dec.ecLevel).toBe(0b00); // ECC level M
    expect(dec.mask).toBe(res.mask);
    expect(dec.payload).toBe(text);
    return dec;
  }

  it('fully decodes a short v<7 symbol (format, zig-zag, RS syndromes, payload)', () => {
    const dec = roundTrip(OTPAUTH_SHORT);
    expect(dec.version).toBe(3);
  });

  it('fully decodes the realistic v7 otpauth enrollment symbol', () => {
    const dec = roundTrip(OTPAUTH);
    expect(dec.version).toBe(7);
  });

  it('fully decodes a v10 symbol (16-bit char count + two-group block interleave)', () => {
    const dec = roundTrip(OTPAUTH_LONG);
    expect(dec.version).toBe(10);
  });
});

describe('QRCode encodeQR (boolean coercion)', () => {
  it('returns an all-boolean square matrix', () => {
    const m = encodeQR(OTPAUTH);
    expect(m).not.toBeNull();
    if (!m) return;
    for (const row of m) for (const cell of row) expect(typeof cell).toBe('boolean');
  });
});

describe('QRCode SVG render (quiet zone)', () => {
  it('renders an SVG whose viewBox embeds a quiet zone (margin) of >= 4 modules', () => {
    const { container } = render(<QRCode value={OTPAUTH} size={180} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    const res = encodeMatrix(OTPAUTH);
    if (!res || !svg) throw new Error('expected matrix + svg');
    const count = res.matrix.length;
    const viewBox = svg.getAttribute('viewBox') ?? '';
    const parts = viewBox.split(/\s+/).map(Number);
    // viewBox = "0 0 total total" where total = count + 2*margin.
    const total = parts[2];
    expect(total).toBe(parts[3]);
    const margin = (total - count) / 2;
    expect(Number.isInteger(margin)).toBe(true);
    expect(margin).toBeGreaterThanOrEqual(4);
    // Render size is comfortably scannable.
    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(160);
  });
});
