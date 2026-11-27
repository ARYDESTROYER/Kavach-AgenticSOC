/**
 * The closing accessibility sweep (A11Y): coloured chips on a material clear 4.5:1 with
 * any content beneath.
 *
 * The top bar's Demo chip and release badge are wash badges (`bg-<axis>/10` with
 * `text-<axis>-text`) on the glass top bar, which is `--glass-tint` at `--glass-opacity`
 * (0.97). With a Settings page scrolled under the bar, axe measured their light text at
 * 4.49:1 (`color-contrast`, serious, at 1440 and 390). With black beneath the bar the
 * light warning tint falls to 4.34:1. A material (`.glass-surface`, `.material-surface`)
 * now re-points the seven semantic tints at the grouped panel's stronger inks.
 *
 * The test reads the wash alpha and the ink from the real badge classes, the remap from
 * the material rules in `theme.css`, and the fill and opacity of each material (the glass
 * top bar from its tokens, `materialBar` and `materialThick` from their recipes). It
 * composites the wash over the material over black, white, the canvas and the panel, in
 * both themes.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  THEME_CSS_PATH,
  contrastRatio,
  parseThemeCss,
  resolveToken,
  resolveTokenRgb,
} from '../../../scripts/lib/theme-css.mjs';
import { badgeVariants } from '@/ui/badge';
import { materialBar, materialThick } from '@/lib/material-recipes';

type Rgb = [number, number, number];
type ThemeMap = ReturnType<typeof parseThemeCss>['light'];

const AA_TEXT = 4.5;
const AXES = ['critical', 'high', 'medium', 'low', 'info', 'success', 'warning'] as const;
const CSS = fs.readFileSync(THEME_CSS_PATH, 'utf8');
const { light, dark } = parseThemeCss();
const THEMES = [
  ['light', light],
  ['dark', dark],
] as const;

/** The `--x-text: var(--y)` re-points a top-level rule for exactly this selector declares. */
function remapOn(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of block[2].matchAll(/(--[a-z-]+-text)\s*:\s*var\((--[a-z-]+)\)\s*;/g)) {
      out.set(decl[1], decl[2]);
    }
  }
  return out;
}

/** `bg-background/[0.97]` in a recipe: the fill token and its opacity. */
function recipeFill(recipe: string): { token: string; alpha: number } {
  const m = /\bbg-([a-z-]+)\/\[(0\.\d+)\]/.exec(recipe);
  if (!m) throw new Error(`No translucent fill in "${recipe}".`);
  return { token: `--${m[1]}`, alpha: Number(m[2]) };
}

function rgb(token: string, map: ThemeMap): Rgb {
  const value = resolveTokenRgb(token, map);
  if (!value) throw new Error(`${token} does not resolve.`);
  return value as Rgb;
}

function mix(top: Rgb, under: Rgb, alpha: number): Rgb {
  return top.map((c, i) => c * alpha + under[i] * (1 - alpha)) as Rgb;
}

/** The wash alpha and the ink token of a badge variant, read from its classes. */
function badgePaint(axis: (typeof AXES)[number]): { alpha: number; ink: string } {
  const classes = badgeVariants({ variant: axis }).split(/\s+/);
  const wash = classes.map((c) => new RegExp(`^bg-${axis}/(\\d+)$`).exec(c)).find(Boolean);
  const ink = classes.find((c) => c === `text-${axis}-text`);
  if (!wash || !ink) throw new Error(`The ${axis} badge is not a wash badge.`);
  return { alpha: Number(wash[1]) / 100, ink: `--${axis}-text` };
}

const BENEATH: { name: string; rgb: (map: ThemeMap) => Rgb }[] = [
  { name: 'black', rgb: () => [0, 0, 0] },
  { name: 'white', rgb: () => [1, 1, 1] },
  { name: 'canvas', rgb: (map) => rgb('--canvas', map) },
  { name: 'panel', rgb: (map) => rgb('--panel', map) },
];

const SURFACES = [
  {
    name: 'the glass top bar',
    selector: '.glass-surface',
    fill: (map: ThemeMap) => ({
      token: '--glass-tint',
      alpha: Number(resolveToken('--glass-opacity', map)),
    }),
  },
  { name: 'materialBar', selector: '.material-surface', fill: () => recipeFill(materialBar) },
  { name: 'materialThick', selector: '.material-surface', fill: () => recipeFill(materialThick) },
];

describe('a wash badge on a material clears 4.5:1 with any content beneath', () => {
  it('reads a translucent fill for every material', () => {
    for (const [, map] of THEMES) {
      for (const surface of SURFACES) {
        const { alpha } = surface.fill(map);
        expect(alpha, surface.name).toBeGreaterThan(0.9);
        expect(alpha, surface.name).toBeLessThan(1);
      }
    }
  });

  for (const surface of SURFACES) {
    it(`${surface.name}: every semantic badge tone, both themes`, () => {
      const remap = remapOn(surface.selector);
      for (const axis of AXES) {
        const paint = badgePaint(axis);
        const inkToken = remap.get(paint.ink) ?? paint.ink;
        for (const [theme, map] of THEMES) {
          const fill = surface.fill(map);
          for (const beneath of BENEATH) {
            const material = mix(rgb(fill.token, map), beneath.rgb(map), fill.alpha);
            const ground = mix(rgb(`--${axis}`, map), material, paint.alpha);
            const ratio = contrastRatio(rgb(inkToken, map), ground);
            expect(ratio, `${theme} ${axis} (${inkToken}) on ${surface.name} over ${beneath.name}`).toBeGreaterThanOrEqual(
              AA_TEXT,
            );
          }
        }
      }
    });
  }
});
