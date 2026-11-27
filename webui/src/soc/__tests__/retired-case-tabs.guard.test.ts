/**
 * Console copy names the case tabs as the case shows them (WP16 review): Brief, Evidence,
 * AI investigation, Response, Activity and Chat. The retired Overview, Timeline, Threat
 * context, Runbook and Collaboration tabs are gone, so no string a viewer reads may send
 * them to one. This test reads the product source (tests and comments aside) and fails
 * on "the <retired> tab" in any string or JSX text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SOC = path.resolve(__dirname, '..');
const RETIRED = /\b(Overview|Timeline|Threat context|Runbook|Collaboration) tab\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The lines a viewer can read: comment lines and trailing comments left out. */
function copyLines(source: string): Array<{ line: number; text: string }> {
  const lines = source.split('\n');
  const out: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  lines.forEach((raw, index) => {
    let text = raw;
    if (inBlock) {
      const end = text.indexOf('*/');
      if (end < 0) return;
      text = text.slice(end + 2);
      inBlock = false;
    }
    // Block comments that open on this line (JSX `{/* ... */}` included).
    for (;;) {
      const start = text.indexOf('/*');
      if (start < 0) break;
      const end = text.indexOf('*/', start + 2);
      if (end < 0) {
        text = text.slice(0, start);
        inBlock = true;
        break;
      }
      text = text.slice(0, start) + text.slice(end + 2);
    }
    const trimmed = text.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    out.push({ line: index + 1, text });
  });
  return out;
}

describe('retired case tab names', () => {
  it('appear in no Console copy', () => {
    const found: string[] = [];
    for (const file of sourceFiles(SOC)) {
      for (const { line, text } of copyLines(readFileSync(file, 'utf8'))) {
        if (RETIRED.test(text)) found.push(`${path.relative(SOC, file)}:${line}: ${text.trim()}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('reads past comments but not past copy', () => {
    const lines = copyLines(
      [
        '/** the Runbook tab of old */',
        "const a = 'Open the Response tab';",
        '{/* the Timeline tab */}',
        "const b = 'the Threat context tab on each case';",
      ].join('\n'),
    ).filter(({ text }) => RETIRED.test(text));
    expect(lines.map((l) => l.line)).toEqual([4]);
  });
});
