/**
 * A strict test-only reader for the store-only ZIP writer: it walks the END record, the
 * central directory and every local header, checks that both agree (name, sizes, CRC,
 * offset), recomputes each CRC-32, and returns the entries in order. Anything a real
 * unzipper would reject (bad signature, method ≠ 0, size or CRC mismatch, a trailing
 * gap) throws, so a test that reads a package proves it is a valid archive.
 */
import { crc32 } from '../export/zip';

export interface ReadEntry {
  name: string;
  bytes: Uint8Array;
  text: string;
}

export function readZip(zip: Uint8Array): ReadEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const content = new TextDecoder('utf-8');
  const eocd = zip.length - 22;
  if (eocd < 0 || view.getUint32(eocd, true) !== 0x06054b50) throw new Error('no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralStart = view.getUint32(eocd + 16, true);
  if (centralStart + centralSize !== eocd) throw new Error('central directory does not end at the end record');
  const entries: ReadEntry[] = [];
  let p = centralStart;
  let expectedLocal = 0;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central header ${i}`);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error(`${name}: not stored`);
    if ((flags & 0x0800) === 0) throw new Error(`${name}: UTF-8 flag missing`);
    if (csize !== usize) throw new Error(`${name}: stored sizes differ`);
    if (offset !== expectedLocal) throw new Error(`${name}: local header not contiguous`);
    // Local header must agree.
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const lNameLen = view.getUint16(offset + 26, true);
    const lExtra = view.getUint16(offset + 28, true);
    if (view.getUint32(offset + 14, true) !== crc || view.getUint32(offset + 18, true) !== csize) throw new Error(`${name}: local/central mismatch`);
    const lName = decoder.decode(zip.subarray(offset + 30, offset + 30 + lNameLen));
    if (lName !== name) throw new Error(`${name}: local name ${lName}`);
    const dataStart = offset + 30 + lNameLen + lExtra;
    const bytes = zip.subarray(dataStart, dataStart + csize);
    if (crc32(bytes) !== crc) throw new Error(`${name}: CRC mismatch`);
    expectedLocal = dataStart + csize;
    entries.push({ name, bytes, text: content.decode(bytes) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (expectedLocal !== centralStart) throw new Error('gap between the entries and the central directory');
  return entries;
}

/** Parse XML strictly; throws on a parser error (not well-formed). */
export function parseXml(text: string, name = 'part'): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`${name} is not well-formed XML: ${error.textContent ?? ''}`);
  return doc;
}

/** The entries as a name → entry map. */
export function zipMap(zip: Uint8Array): Map<string, ReadEntry> {
  return new Map(readZip(zip).map((e) => [e.name, e]));
}
