/**
 * Round 12 SYNTHESIS-chat P0-1 acceptance: chat has no answer limits, so the old
 * Continue chip (its phrase is built below as PHRASE), its wording and its token
 * estimate are gone from the console. A `grep -r` for PHRASE in webui/src must find
 * nothing (this file included), and no host
 * computes a continue estimate any more. (`origin: "continue"` stays accepted on the
 * wire for old clients; the client never sends it.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../..');
// Built from parts so this file does not match itself.
const PHRASE = ['Continue where', 'this stopped'].join(' ');
const ESTIMATE = ['continue', 'Estimate'].join('');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx|js|jsx|json|css|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('no Continue chip (P0-1)', () => {
  const files = sourceFiles(SRC);

  it('scans the web sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it(`never mentions "${PHRASE}" anywhere under webui/src`, () => {
    const hits = files.filter((file) => fs.readFileSync(file, 'utf8').includes(PHRASE)).map((file) => path.relative(SRC, file));
    expect(hits).toEqual([]);
  });

  it('computes no continue estimate in any host', () => {
    const hits = files.filter((file) => fs.readFileSync(file, 'utf8').includes(ESTIMATE)).map((file) => path.relative(SRC, file));
    expect(hits).toEqual([]);
  });
});
