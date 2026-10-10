/**
 * Gate: no page-local MATERIAL (ui-standard "Materials", SYNTHESIS-ux §1.4).
 *
 * The Console has ONE translucent material for floating chrome — `materialBar` /
 * `materialThick` in lib/material-recipes.ts (re-exported by lib/ui-recipes.ts) — and
 * theme.css turns it solid under
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
/** The recipe files: the only places a blur may be spelled. */
const RECIPE_FILES = new Set(['lib/ui-recipes.ts', 'lib/material-recipes.ts']);
const MATERIAL_RECIPES = path.join('lib', 'material-recipes.ts');

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
    if (RECIPE_FILES.has(rel)) continue;
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
    const recipes = fs.readFileSync(path.join(SRC, MATERIAL_RECIPES), 'utf8');
    expect(recipes).toMatch(/export const materialBar =[\s\S]*?backdrop-blur-xl/);
    expect(recipes).toMatch(/export const materialThick =[\s\S]*?backdrop-blur-2xl/);
    // One import path for every recipe: ui-recipes re-exports the material.
    const uiRecipes = fs.readFileSync(path.join(SRC, 'lib', 'ui-recipes.ts'), 'utf8');
    expect(uiRecipes).toMatch(/export \{ materialBar, materialThick \} from '\.\/material-recipes';/);
    expect(uiRecipes).not.toMatch(/export const material(?:Bar|Thick)\b/);
  });
});

/*
 * Geometry: a sticky MATERIAL pins flush under the top bar.
 *
 * The material spans its column and content scrolls beneath it, so an offset such as
 * `top-[calc(var(--header-h)+0.5rem)]` leaves an unpainted slit between the top bar and
 * the bar through which scrolled fields show (the Settings section strip did, once the
 * shell's `overflow-x-clip` made sticky positioning work). Every class composition that
 * wears `materialBar` / `materialThick` / `<MaterialBar>` must pin at
 * `top-[var(--header-h)]` (or a container-relative `top-0`). A `calc()` offset is for a
 * sticky ASIDE in its own column, which never carries the material.
 */

/** Every balanced `cn(…)` argument list in `text`. */
function cnCalls(text: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf('cn('); at !== -1; at = text.indexOf('cn(', at + 3)) {
    if (/[\w$.]/.test(text[at - 1] ?? '')) continue; // `foo.cn(` / `xcn(` are not the helper
    let depth = 0;
    for (let i = at + 2; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) {
        out.push(text.slice(at + 3, i));
        break;
      }
    }
  }
  return out;
}

/** A sticky offset BELOW the top bar: `top-[calc(var(--header-h) + …)]`, any variant prefix. */
const OFFSET_BELOW_HEADER = /(?:^|[\s'"`:])top-\[calc\(var\(--header-h\)\s*\+/;

/** An overflow on the material itself: it would clip (or scroll into view) the fade below it. */
const SELF_OVERFLOW = /(?:^|[\s'"`:])overflow-(?:x-|y-)?(?:auto|hidden|scroll|clip)\b/;

function selfOverflowMaterials(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const call of cnCalls(text)) {
      if (/\bmaterial(?:Bar|Thick)\b/.test(call) && SELF_OVERFLOW.test(call)) {
        found.push(`${rel}: cn(${call.replace(/\s+/g, ' ').slice(0, 140)}…)`);
      }
    }
  }
  return found;
}

function offsetMaterials(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const call of cnCalls(text)) {
      if (/\bmaterial(?:Bar|Thick)\b/.test(call) && OFFSET_BELOW_HEADER.test(call)) {
        found.push(`${rel}: cn(${call.replace(/\s+/g, ' ').slice(0, 140)}…)`);
      }
    }
    for (const m of text.matchAll(/<MaterialBar\b[^>]*>/g)) {
      if (OFFSET_BELOW_HEADER.test(m[0])) found.push(`${rel}: ${m[0].slice(0, 140)}`);
    }
  }
  return found;
}

describe('material gate: sticky materials pin flush under the top bar', () => {
  it('no material composition carries a top offset below --header-h', () => {
    const found = offsetMaterials();
    expect(found, found.join('\n')).toEqual([]);
  });

  it('no material sets its own overflow (the scroll-edge fade hangs below it)', () => {
    const found = selfOverflowMaterials();
    expect(found, found.join('\n')).toEqual([]);
    expect(SELF_OVERFLOW.test("'sticky z-10 overflow-x-auto border-y'")).toBe(true);
    expect(SELF_OVERFLOW.test("'sticky z-10 border-y'")).toBe(false);
  });

  it('detects the slit pattern it guards (self-test on a synthetic composition)', () => {
    const sample = "cn('sticky top-[calc(var(--header-h)+0.5rem)] z-10 border-y', materialBar)";
    const calls = cnCalls(sample);
    expect(calls).toHaveLength(1);
    expect(OFFSET_BELOW_HEADER.test(calls[0])).toBe(true);
    // A column aside's offset (no material) and a flush material are both fine.
    expect(OFFSET_BELOW_HEADER.test("'sticky top-[var(--header-h)] z-20'")).toBe(false);
    expect(OFFSET_BELOW_HEADER.test("'md:sticky md:top-[calc(var(--header-h)+1rem)]'")).toBe(true);
    expect(/\bmaterial(?:Bar|Thick)\b/.test("'md:sticky md:top-[calc(var(--header-h)+1rem)]'")).toBe(false);
  });
});
