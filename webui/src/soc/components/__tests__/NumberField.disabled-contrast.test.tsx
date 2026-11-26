/**
 * The closing accessibility sweep (A11Y): a disabled NumberField's unit ("min", "%")
 * measured 2.18:1 in light and 2.77:1 in dark on Settings, Detection (axe
 * `color-contrast`, serious). The unit sits outside the input, so the disabled input's
 * own exemption does not cover it, and the whole box was faded with `opacity-50`. No
 * ink clears 4.5:1 at half opacity on the light ground, so the disabled box now draws
 * from tokens: the muted fill and the muted ink.
 *
 * The test reads what the unit really paints from the rendered classes: its ink token,
 * the fill token of the box under it, and any opacity utility between them. It then
 * composites them over each ground the field sits on (card, canvas, and a grouped panel,
 * where `--muted` re-points to `--panel-muted`) from `theme.css`, in both themes.
 */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { contrastRatio, parseThemeCss, resolveTokenRgb } from '../../../../scripts/lib/theme-css.mjs';
import { NumberField } from '../NumberField';

type Rgb = [number, number, number];
type ThemeMap = ReturnType<typeof parseThemeCss>['light'];

const AA_TEXT = 4.5;
const { light, dark } = parseThemeCss();
const THEMES = [
  ['light', light],
  ['dark', dark],
] as const;

/** Each ground a field sits on, with the panel scope's re-pointed fill tokens. */
const GROUNDS: { ground: string; remap: Record<string, string> }[] = [
  { ground: '--card', remap: {} },
  { ground: '--canvas', remap: {} },
  { ground: '--panel', remap: { '--card': '--panel', '--muted': '--panel-muted', '--secondary': '--panel-muted' } },
];

/** A colour utility with the given prefix whose token is a theme colour, else null. */
function colourToken(cls: string, prefix: 'text-' | 'bg-'): string | null {
  if (!cls.startsWith(prefix)) return null;
  const token = `--${cls.slice(prefix.length)}`;
  return resolveTokenRgb(token, light) ? token : null;
}

/** `opacity-50` reads 0.5; any other class reads null. */
function opacityOf(cls: string): number | null {
  const m = /^opacity-(\d+)$/.exec(cls);
  return m ? Number(m[1]) / 100 : null;
}

/** What the unit paints: its ink, the fill under it inside the box, and the box's opacity. */
function unitPaint(unit: HTMLElement): { ink: string; fill: string | null; alpha: number } {
  const box = unit.closest<HTMLElement>('[data-number-field]');
  if (!box) throw new Error('The unit is not inside the field box.');
  let ink: string | null = null;
  let fill: string | null = null;
  let alpha = 1;
  for (let node: HTMLElement | null = unit; node; node = node.parentElement) {
    for (const cls of Array.from(node.classList)) {
      ink ??= colourToken(cls, 'text-');
      if (node !== unit) fill ??= colourToken(cls, 'bg-');
      const o = opacityOf(cls);
      if (o != null) alpha *= o;
    }
    if (node === box) break;
  }
  if (!ink) throw new Error('The unit paints no theme colour.');
  return { ink, fill, alpha };
}

function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb;
}

function rgb(token: string, map: ThemeMap): Rgb {
  const value = resolveTokenRgb(token, map);
  if (!value) throw new Error(`${token} does not resolve.`);
  return value as Rgb;
}

/** The ratio of the unit's painted ink to the fill painted under it, over one ground. */
function paintedRatio(paint: ReturnType<typeof unitPaint>, ground: (typeof GROUNDS)[number], map: ThemeMap): number {
  const under = rgb(ground.ground, map);
  const fill = paint.fill ? rgb(ground.remap[paint.fill] ?? paint.fill, map) : under;
  const ink = rgb(ground.remap[paint.ink] ?? paint.ink, map);
  // The box is one group: its fill and the text on it are faded together over the ground.
  return contrastRatio(blend(ink, under, paint.alpha), blend(fill, under, paint.alpha));
}

function renderField(disabled: boolean, unit: string) {
  render(
    <NumberField
      label="Objection window"
      value={30}
      onChange={() => undefined}
      min={0}
      unit={unit}
      size="sm"
      disabled={disabled}
    />,
  );
  const field = screen.getByRole('spinbutton', { name: 'Objection window' });
  const unitEl = field.parentElement?.querySelector<HTMLElement>('[data-number-unit]');
  if (!unitEl) throw new Error('No unit in the field.');
  return { field, unitEl };
}

describe('a NumberField unit clears 4.5:1 on every ground', () => {
  it('keeps the unit of a disabled field readable: no fade, the muted fill and ink', () => {
    const { field, unitEl } = renderField(true, 'min');
    expect(field).toBeDisabled();
    expect(unitEl).toHaveTextContent('min');
    const paint = unitPaint(unitEl);
    for (const [theme, map] of THEMES) {
      for (const ground of GROUNDS) {
        const ratio = paintedRatio(paint, ground, map);
        expect(ratio, `${theme} disabled unit on ${ground.ground}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('keeps the unit of an enabled field readable on the field fill', () => {
    const { field, unitEl } = renderField(false, '%');
    expect(field).not.toBeDisabled();
    const paint = unitPaint(unitEl);
    expect(paint.alpha).toBe(1);
    for (const [theme, map] of THEMES) {
      for (const ground of GROUNDS) {
        const ratio = paintedRatio(paint, ground, map);
        expect(ratio, `${theme} unit on ${ground.ground}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });
});
