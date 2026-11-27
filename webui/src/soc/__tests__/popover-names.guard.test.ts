/**
 * Popover names (Round 16 SPEC §3.6, bug hunt B75, WP15F).
 *
 * Radix renders a popover's content as `role="dialog"`. A dialog with no accessible name is
 * read as just "dialog" (axe aria-dialog-name, serious), so a screen-reader user cannot tell
 * which panel opened. Every `<PopoverContent>` in the Console carries `aria-labelledby` (its
 * visible heading) or `aria-label` (the trigger's name). This test reads the source and fails
 * on any opening tag without one. `ui/popover.tsx` sets no default name on purpose: a generic
 * name would hide a missing one rather than fix it. Nothing outside it renders the Radix
 * popover content directly, so the scan sees every popover dialog.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const POPOVER_PRIMITIVE = 'ui/popover.tsx';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.(tsx|ts)$/.test(name) && !/\.test\.(tsx|ts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** The opening `<PopoverContent ...>` tags of a source text: braces and strings are skipped. */
function popoverOpeningTags(text: string): { line: number; tag: string }[] {
  const tags: { line: number; tag: string }[] = [];
  const re = /<PopoverContent\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    let i = match.index + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push({ line: text.slice(0, match.index).split('\n').length, tag: text.slice(match.index, i + 1) });
  }
  return tags;
}

const NAMED = /\saria-label(?:ledby)?=/;

describe('every popover dialog has an accessible name (B75)', () => {
  const files = sourceFiles(SRC);

  it('names each <PopoverContent> with aria-labelledby or aria-label', () => {
    const unnamed: string[] = [];
    let seen = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { line, tag } of popoverOpeningTags(text)) {
        seen += 1;
        if (!NAMED.test(tag)) unnamed.push(`${path.relative(SRC, file)}:${line}`);
      }
    }
    // The scan really found the Console's popovers (about thirty at the time of writing).
    expect(seen).toBeGreaterThan(20);
    expect(unnamed, 'name these popovers: aria-labelledby their heading, else aria-label').toEqual([]);
  });

  it('renders the Radix popover content only through ui/popover', () => {
    const direct = files
      .filter((file) => path.relative(SRC, file).split(path.sep).join('/') !== POPOVER_PRIMITIVE)
      .filter((file) => /@radix-ui\/react-popover/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(direct).toEqual([]);
  });

  it('reads a multi-line tag with arrow functions and nested braces', () => {
    const text = [
      '<PopoverContent',
      '  align="end"',
      '  onOpenAutoFocus={(e) => { if (x > 1) e.preventDefault(); }}',
      "  aria-label={`Range ${'>'}`}",
      '>',
      '<PopoverContent className="w-72">',
    ].join('\n');
    const tags = popoverOpeningTags(text);
    expect(tags).toHaveLength(2);
    expect(NAMED.test(tags[0].tag)).toBe(true);
    expect(tags[1]).toEqual({ line: 6, tag: '<PopoverContent className="w-72">' });
    expect(NAMED.test(tags[1].tag)).toBe(false);
  });
});
