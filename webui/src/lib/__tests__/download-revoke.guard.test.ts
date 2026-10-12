/**
 * Every console download goes through `downloadBlob` (`lib/download-blob.ts`, re-exported by
 * `lib/download.ts`; Round 12 WP-REP R4): it keeps the
 * object URL alive for `REVOKE_DELAY_MS` after the click, because revoking it at once (or
 * after 0 ms) can cancel the download in Safari and older Firefox. This source guard keeps
 * a hand-rolled anchor download, with its own early revoke, from coming back elsewhere.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['__tests__', 'test', '__fixtures__'].includes(entry.name)) continue;
      sources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('object URLs for downloads are made and revoked only by lib/download-blob.ts', () => {
  it('no other module creates or revokes a download object URL', () => {
    const offenders = sources(SRC)
      .filter((file) => path.relative(SRC, file) !== path.join('lib', 'download-blob.ts'))
      // A call (`URL.createObjectURL(…)`, `URL.revokeObjectURL?.(…)`), not a mention in a comment.
      .filter((file) => /\bURL\.(?:createObjectURL|revokeObjectURL)\s*(?:\?\.)?\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
