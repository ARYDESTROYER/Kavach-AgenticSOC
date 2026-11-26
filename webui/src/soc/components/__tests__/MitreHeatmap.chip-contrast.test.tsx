/**
 * The closing accessibility sweep (A11Y review): the MITRE heatmap on Metrics, Posture
 * prints each technique id and its count on a chip over the cell's viridis fill. A browser
 * that supports backdrop-filter painted the chip at 70% of `--background`, so 30% of the
 * fill showed through and the count's muted ink fell under 4.5:1: 3.1:1 over the brightest
 * bucket in dark (axe `color-contrast`, serious, at 390) and 3.5:1 over the darkest in
 * light.
 *
 * The test reads what each chip really paints from the rendered markup: the cell's own
 * fill, every `bg-background/NN` the chip can take (the lowest one wins, as a supporting
 * browser applies the `supports-[...]` variant), and the ink of the id and of the count.
 * It composites the chip over each of the five buckets and measures both inks against it
 * in both themes.
 */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { contrastRatio, parseThemeCss, resolveTokenRgb } from '../../../../scripts/lib/theme-css.mjs';
import { MitreHeatmap, type MitreTacticColumn } from '../MitreHeatmap';

type Rgb = [number, number, number];

const AA_TEXT = 4.5;
const { light, dark } = parseThemeCss();
const THEMES = [
  ['light', light],
  ['dark', dark],
] as const;

// Counts that land in each of the five buckets (max 10: 0.1, 0.3, 0.5, 0.8, 1).
const COLUMNS: MitreTacticColumn[] = [
  {
    tactic: 'TA0001',
    label: 'Initial Access',
    cells: [1, 3, 5, 8, 10].map((value, i) => ({ technique: `T119${i}`, value })),
  },
];

function parseRgb(css: string): Rgb {
  const m = css.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) throw new Error(`Not an rgb colour: "${css}".`);
  return [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255];
}

/** Every `bg-background/NN` alpha on the element, plain or behind a variant. */
function chipAlphas(el: HTMLElement): number[] {
  return Array.from(el.classList)
    .map((cls) => /(?:^|:)bg-background\/(\d+)$/.exec(cls))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => Number(m[1]) / 100);
}

/** The colour token of the nearest `text-<token>` utility at or above `el`. */
function inkToken(el: HTMLElement, stop: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    for (const cls of Array.from(node.classList)) {
      if (!cls.startsWith('text-')) continue;
      const token = `--${cls.slice('text-'.length)}`;
      if (resolveTokenRgb(token, light)) return token;
    }
    if (node === stop) break;
  }
  throw new Error('No ink token on the chip text.');
}

describe('the MITRE heatmap chip', () => {
  it('keeps the technique id and its count at 4.5:1 over every bucket, in both themes', () => {
    const { container } = render(<MitreHeatmap columns={COLUMNS} ariaLabel="Techniques seen in cases" />);
    const chips = Array.from(container.querySelectorAll<HTMLElement>('[data-mitre-chip]'));
    expect(chips).toHaveLength(5);
    const fills = new Set<string>();
    for (const chip of chips) {
      const cell = chip.parentElement as HTMLElement;
      fills.add(cell.style.backgroundColor);
      const alphas = chipAlphas(chip);
      expect(alphas.length).toBeGreaterThan(0);
      const alpha = Math.min(...alphas);
      const ramp = parseRgb(cell.style.backgroundColor);
      const [id, count] = Array.from(chip.children) as HTMLElement[];
      for (const [theme, map] of THEMES) {
        const bg = resolveTokenRgb('--background', map) as Rgb;
        const ground = bg.map((c, i) => c * alpha + ramp[i] * (1 - alpha)) as Rgb;
        for (const [what, el] of [
          ['id', id],
          ['count', count],
        ] as const) {
          const ink = resolveTokenRgb(inkToken(el, chip), map) as Rgb;
          const ratio = contrastRatio(ink, ground);
          expect(ratio, `${theme} ${what} on ${cell.style.backgroundColor} under a ${alpha} chip`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    }
    // The five counts really cover the five buckets of the ramp.
    expect(fills.size).toBe(5);
  });
});
