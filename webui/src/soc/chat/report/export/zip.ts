/**
 * A store-only ZIP writer (PKWARE APPNOTE 6.3.x, method 0) for the client-side Office
 * exports (Round 12 SPEC WP-REP; SYNTHESIS-chat P1-7). No dependency: DOCX and XLSX are
 * ZIP packages of small XML parts, and "stored" (uncompressed) entries are valid in both
 * — Word, Excel and LibreOffice open them. The files are a few hundred kB at most, so
 * deflate would buy nothing worth a dependency.
 *
 *   - one local file header + data per entry, then the central directory and the end
 *     record; sizes are known up front, so no data descriptors and no ZIP64;
 *   - names are UTF-8 (general-purpose bit 11), forward-slash paths, never absolute and
 *     never containing `..` (a writer bug, not data: every name here is a constant);
 *   - CRC-32 (IEEE 802.3, reflected 0xEDB88320) over each entry's bytes;
 *   - the DOS timestamp is the export instant (UTC fields), so the same inputs and the
 *     same instant give byte-identical archives.
 *
 * Reached only through the lazy export chunk (`export/run` → `export/docx` | `xlsx`).
 */

export interface ZipEntry {
  /** Path inside the archive, e.g. `word/document.xml`. */
  name: string;
  /** Contents: a string is written as UTF-8. */
  data: string | Uint8Array;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `bytes` (the ZIP / PNG / gzip polynomial). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time words for `at` (2-second resolution, 1980..2107). */
export function dosDateTime(at: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, at.getUTCFullYear()));
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  return { date: date & 0xffff, time: time & 0xffff };
}

const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,240}$/;

/** Build a store-only ZIP archive of `entries`, in order. */
export function zipStore(entries: readonly ZipEntry[], at: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { date, time } = dosDateTime(at);
  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    if (!SAFE_NAME.test(entry.name)) throw new Error(`Invalid ZIP entry name: ${entry.name}`);
    if (seen.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}`);
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    return { name, data, crc: crc32(data) };
  });

  const localSize = prepared.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = prepared.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(p, v >>> 0, true);
    p += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, p);
    p += b.length;
  };

  const offsets: number[] = [];
  for (const e of prepared) {
    offsets.push(p);
    u32(0x04034b50); // local file header signature
    u16(20); // version needed to extract (2.0)
    u16(0x0800); // general purpose flags: UTF-8 names
    u16(0); // method: stored
    u16(time);
    u16(date);
    u32(e.crc);
    u32(e.data.length); // compressed size
    u32(e.data.length); // uncompressed size
    u16(e.name.length);
    u16(0); // extra field length
    bytes(e.name);
    bytes(e.data);
  }

  const centralStart = p;
  prepared.forEach((e, i) => {
    u32(0x02014b50); // central directory header signature
    u16(20); // version made by (2.0, MS-DOS attribute compatibility)
    u16(20); // version needed to extract
    u16(0x0800);
    u16(0);
    u16(time);
    u16(date);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra field length
    u16(0); // comment length
    u16(0); // disk number start
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]);
    bytes(e.name);
  });

  const centralLength = p - centralStart;
  u32(0x06054b50); // end of central directory signature
  u16(0); // this disk
  u16(0); // disk with the central directory
  u16(prepared.length);
  u16(prepared.length);
  u32(centralLength);
  u32(centralStart);
  u16(0); // comment length
  return out;
}
