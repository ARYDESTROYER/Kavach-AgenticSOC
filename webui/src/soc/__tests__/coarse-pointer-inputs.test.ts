/**
 * Phone text fields never trigger Safari's focus zoom (Round 16 bug hunt B81, WP15F).
 *
 * The input, textarea and select primitives use `text-sm` (13 px on a phone), and iOS Safari
 * zooms the page when a field under 16 px takes focus, then leaves the layout scaled. One rule
 * in theme.css's base layer sets text fields to `max(1rem, 16px)` under
 * `(hover: none) and (pointer: coarse)`, so desktop density stays and the raw chat composer
 * textarea is covered too. `!important` because a utility such as `.text-sm` outranks an
 * element selector. Pinch zoom stays enabled: the viewport sets no `maximum-scale` and no
 * `user-scalable=no`. jsdom cannot evaluate the media query, so this reads the source; the
 * device check is the maintainer's (SPEC M6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEBUI = path.resolve(__dirname, '..', '..', '..');
const css = fs.readFileSync(path.join(WEBUI, 'src', 'styles', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(WEBUI, 'index.html'), 'utf8');

/** The body of the block whose opening brace follows `index`, braces matched. */
function blockAt(source: string, index: number): string {
  const open = source.indexOf('{', index);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block at ${index}`);
}

describe('coarse-pointer text fields (B81)', () => {
  const base = blockAt(css, css.indexOf('@layer base'));
  const coarse = [...base.matchAll(/@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)/g)].map((m) =>
    blockAt(base, m.index ?? 0),
  );
  const rule = coarse.find((body) => /font-size\s*:/.test(body)) ?? '';

  it('sets text fields to at least 16 px on touch screens, in the base layer', () => {
    expect(rule, 'a coarse-pointer font-size rule inside @layer base').not.toBe('');
    expect(rule).toMatch(/font-size\s*:\s*max\(1rem,\s*16px\)\s*!important/);
    const selector = rule.slice(0, rule.indexOf('{'));
    for (const element of ['textarea', 'select']) expect(selector).toMatch(new RegExp(`(^|[\\s,])${element}(\\s*,|\\s*$)`));
    expect(selector).toMatch(/(^|[\s,])input/);
  });

  it('leaves controls that hold no typed text alone', () => {
    const selector = rule.slice(0, rule.indexOf('{'));
    for (const type of ['checkbox', 'radio', 'range', 'file']) expect(selector).toContain(`:not([type='${type}'])`);
  });

  it('keeps pinch zoom available', () => {
    const viewport = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(viewport).toContain('width=device-width');
    expect(viewport).not.toMatch(/maximum-scale/);
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/);
  });
});
