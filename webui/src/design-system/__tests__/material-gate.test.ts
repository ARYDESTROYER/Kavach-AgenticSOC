/**
 * Gate: no page-local MATERIAL (ui-standard "Materials", SYNTHESIS-ux §1.4).
 *
 * The Console has ONE translucent material for floating chrome — `materialBar` /
 * `materialThick` in lib/ui-recipes.ts — and theme.css turns it solid under
 * `prefers-reduced-transparency`, the in-app `data-transparency="reduced"` override and
 * `prefers-contrast: more`. A page that spells its own `bg-background/95 backdrop-blur`
 * gets none of those fallbacks, so it stays translucent and blurred for exactly the
 * operators who asked it not to be.
 *
 * Two source patterns are guarded across every `.tsx`/`.ts` under src/ (tests excluded):
 *   - `backdrop-blur` anywhere outside the recipe file;
 *   - a STICKY class string that also carries a near-opaque translucent surface fill
 *     (`bg-background/95`, `bg-surface/80`, … 70–99%).
 *
 * Baselined like the grep gates: the remaining occurrences below are grandfathered and
 * may only go DOWN. Each is a deliberate, non-chrome use (a dim-and-blur loading scrim, a
 * 1px legibility blur under a heat-map label chip) rather than a bar. Remove a line from
 * the baseline when you remove the occurrence; never add one — use `materialBar`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
const RECIPES = path.join('lib', 'ui-recipes.ts');

/** Grandfathered occurrences per file (posix path relative to src/). Ratchet DOWN only. */
const BASELINE: Record<string, number> = {
  // The full-screen "opening case…" scrim: a dimmed blur over the page, not a bar.
  'soc/pages/Cases.tsx': 1,
  // A 1px legibility blur under a technique-count chip inside a heat-map cell.
  'soc/components/MitreHeatmap.tsx': 1,
};

const PATTERNS: RegExp[] = [
  /backdrop-blur/g,
  // 70–99%: a near-opaque surface fill standing in for a material. A light tint
  // (`bg-background/40` on a horizontally-sticky callout) is not chrome.
  /\bsticky\b[^"'`\n]*\bbg-(?:background|surface|card|popover|canvas)\/[7-9]\d\b/g,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'test' || ent.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(tsx|ts)$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function count(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === RECIPES.split(path.sep).join('/')) continue;
    // Code only: a doc comment that NAMES the anti-pattern (GlassSurface explains its own
    // blur) is not an occurrence of it.
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    const n = PATTERNS.reduce((sum, re) => sum + (text.match(re) ?? []).length, 0);
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

describe('material gate: no page-local translucent chrome', () => {
  const current = count();

  it('adds no NEW page-local blur or translucent sticky fill (use materialBar)', () => {
    const violations = Object.entries(current)
      .filter(([file, n]) => n > (BASELINE[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} (baseline ${BASELINE[file] ?? 0})`);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('keeps the baseline honest (a cleared file is removed from it)', () => {
    const stale = Object.keys(BASELINE).filter((file) => (current[file] ?? 0) < BASELINE[file]);
    expect(stale, `ratchet the baseline down for: ${stale.join(', ')}`).toEqual([]);
  });

  it('the recipe itself is the one place the blur is spelled', () => {
    const recipes = fs.readFileSync(path.join(SRC, RECIPES), 'utf8');
    expect(recipes).toMatch(/export const materialBar =[\s\S]*?backdrop-blur-xl/);
    expect(recipes).toMatch(/export const materialThick =[\s\S]*?backdrop-blur-2xl/);
  });
});
