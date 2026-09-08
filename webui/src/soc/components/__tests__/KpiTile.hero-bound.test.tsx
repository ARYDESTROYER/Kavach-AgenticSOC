/**
 * KpiTile — the HERO numeral ladder (`numeral` / `formatCompact` / `numeralSize`) and the
 * BOUND marker (`bound`).
 *
 * Both exist because the landing strip gave its caption row back to the number:
 *
 *   - the ladder is what a 30px numeral needs in order to be safe. A grouped integer has
 *     no min-content break (UAX #14), so at 30px a long value is not wrapped by the tile's
 *     `overflow-hidden`, it is CLIPPED — and a clipped "543,210" reads as "543,21", a
 *     plausible WRONG number rather than an obvious failure. The ladder shrinks once, then
 *     abbreviates, and the exact value moves to `title`.
 *   - the bound marker is what stayed ON the numeral once the caption under it was gone. A
 *     descriptive caption may be relocated to a help surface; a conditional bound may not,
 *     because it is visible exactly when it is true and a reader who never opens the help
 *     would otherwise read a floor as a fact.
 *
 * The OUTAGE arm of the marker — the one that proves it never fires on structural zeros —
 * is a page-level fact and is pinned in `soc/__tests__/overview.render.test.tsx`, against
 * the same server-outage fixture the rest of that arm uses.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { KpiTile, numeralSize } from '../KpiTile';

/** The big numeral's own span — the element the ladder sizes and the marker annotates. */
function numeral(tile: HTMLElement): HTMLElement {
  const span = tile.querySelector('.items-end > span');
  expect(span).not.toBeNull();
  return span as HTMLElement;
}

describe('numeralSize — the hero ladder cut points', () => {
  // Keyed on the FINAL formatted string's LENGTH, never on the metric's meaning, so the
  // ladder stays portable across deployments and locales. The two cuts are ≤6 → 7-8 → ≥9;
  // every case below sits ON a boundary, because a cut point that is only tested in the
  // middle of its band cannot fail when it moves by one.
  it('keeps ≤6 characters at the full 30px step', () => {
    expect(numeralSize('')).toBe('text-4xl');
    expect(numeralSize('7')).toBe('text-4xl');
    expect(numeralSize('12,345')).toBe('text-4xl'); // exactly 6
  });

  it('steps DOWN one size at 7 and holds it through 8', () => {
    expect(numeralSize('123,456')).toBe('text-3xl'); // exactly 7
    expect(numeralSize('1,234,56')).toBe('text-3xl'); // exactly 8
  });

  it('steps down again at 9, where no further step is legible', () => {
    expect(numeralSize('1,234,567')).toBe('text-2xl'); // exactly 9
    expect(numeralSize('543,210,987')).toBe('text-2xl');
  });
});

describe('KpiTile — the hero numeral', () => {
  it('gives a compact strip tile the 30px numeral ONLY when it opts into `hero`', () => {
    // `density="compact"` is a shared console rhythm passed at nine other call sites across
    // six other pages. Enlarging its numeral wholesale would change all of them, so the
    // step is opt-in — and this pair is the guard: the same tile, one prop apart.
    const { rerender } = render(
      <KpiTile
        label="Total Cases"
        value="4"
        countTo={4}
        variant="strip"
        density="compact"
        numeral="hero"
      />,
    );
    expect(numeral(screen.getByTestId('kpi-total-cases'))).toHaveClass('text-4xl');

    rerender(
      <KpiTile label="Total Cases" value="4" countTo={4} variant="strip" density="compact" />,
    );
    const plain = numeral(screen.getByTestId('kpi-total-cases'));
    expect(plain).toHaveClass('text-2xl');
    expect(plain).not.toHaveClass('text-4xl');
    // …and a non-hero compact caller keeps compact's fixed 4px label→numeral gap. `cn` is
    // `twMerge`, so `hero`'s `mt-auto` REPLACES this class rather than joining it — which
    // is why the nine other compact call sites need their own guard for it here, now that
    // the landing strip's copy of it is gone.
    expect(plain.parentElement).toHaveClass('mt-1');
    expect(plain.parentElement).not.toHaveClass('mt-auto');
  });

  it('bottom-aligns the hero numeral so a wrapped label cannot stagger the row', () => {
    // MEASURED in a browser: six cells at 1280px put the labels on one, two and three
    // lines, which staggered the six numerals by 28px across a row the eye reads as one
    // instrument. Growing the labels upward from a shared numeral baseline is
    // length-independent — and it is two classes, both of which are load-bearing.
    render(
      <KpiTile
        label="False Positive Rate"
        value="50%"
        variant="strip"
        density="compact"
        numeral="hero"
        onClick={() => {}}
      />,
    );
    const tile = screen.getByTestId('kpi-false-positive-rate');
    expect(tile).toHaveClass('flex', 'h-full', 'flex-col');
    expect(numeral(tile).parentElement).toHaveClass('mt-auto');
  });

  it('always shrink-wraps the numeral, so a long value ellipsizes instead of clipping', () => {
    // `min-w-0` and `truncate` TOGETHER, never either alone: without `min-w-0` a flex item
    // refuses to shrink below its content and the tile's `overflow-hidden` clips it with no
    // ellipsis; without `truncate` the shrunk box paints over its own row-mates.
    render(<KpiTile label="Total Cases" value="543,210" variant="strip" />);
    expect(numeral(screen.getByTestId('kpi-total-cases'))).toHaveClass('min-w-0', 'truncate');
  });

  it('abbreviates a value too long for any step, keeping the exact value on the tile', () => {
    render(
      <KpiTile
        label="Total Cases"
        value="—"
        countTo={543_210_987}
        format={(n) => n.toLocaleString('en-US')}
        formatCompact={() => '543M'}
        variant="strip"
        density="compact"
        numeral="hero"
      />,
    );
    const tile = screen.getByTestId('kpi-total-cases');
    const span = numeral(tile);
    // The face shows the compact form …
    const shown = within(tile).getByText('543M');
    expect(shown).toBeInTheDocument();
    // … and nothing is LOST. Abbreviating is a DISPLAY decision, so the shortened numeral
    // is hidden from assistive tech and the exact value is announced instead, as real
    // `sr-only` text. `title` is the pointer affordance beside it, never the only carrier.
    expect(shown.closest('[aria-hidden="true"]')).not.toBeNull();
    const exact = within(tile).getByText('543,210,987');
    expect(exact).toHaveClass('sr-only');
    expect(span.contains(exact)).toBe(false);
    expect(span).toHaveAttribute('title', '543,210,987');
    // Abbreviating is what buys the size back — the whole point of stepping down to a
    // shorter string rather than shrinking to fit an 11-character one.
    expect(span).toHaveClass('text-4xl');
  });

  it('leaves a fully formatted value alone when no `formatCompact` is offered', () => {
    // The abbreviating formatter is a PROP, not a hardcoded helper: `fmtTokens` is shared
    // with money and percentages and rounds above 10,000, which is a caller's decision
    // about its own metric. With none supplied the ladder must still not invent one — it
    // takes the smallest step and shows the number in full.
    render(
      <KpiTile
        label="Total Cases"
        value="—"
        countTo={543_210_987}
        format={(n) => n.toLocaleString('en-US')}
        variant="strip"
        density="compact"
        numeral="hero"
      />,
    );
    const tile = screen.getByTestId('kpi-total-cases');
    expect(within(tile).getByText('543,210,987')).toBeInTheDocument();
    expect(numeral(tile)).toHaveClass('text-2xl');
  });
});

describe('KpiTile — the bound marker', () => {
  const BOUND = 'Partial window · lower bound';

  it('FLOOR: marks the numeral with ≥ and announces the sentence as real text', () => {
    render(
      <KpiTile
        label="Total Cases"
        value="4"
        countTo={4}
        bound={BOUND}
        variant="strip"
        density="compact"
        numeral="hero"
      />,
    );
    const tile = screen.getByTestId('kpi-total-cases');
    const span = numeral(tile);

    expect(span).toHaveAttribute('data-bound', 'floor');
    // The glyph sits INSIDE the numeral span, immediately before the value, so it inherits
    // the numeral's already-gated accent and can never become a second colour signal.
    const mark = within(tile).getByTestId('kpi-total-cases-bound');
    expect(span.contains(mark)).toBe(true);
    expect(mark).toHaveTextContent('≥');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    // The sentence is REAL TEXT in an `sr-only` sibling — never an `aria-label` on a bare
    // span (prohibited on the generic role) and never a `title` alone (mouse-only).
    const sentence = within(tile).getByText(BOUND);
    expect(sentence).toHaveClass('sr-only');
    expect(span.contains(sentence)).toBe(false);
    expect(span).not.toHaveAttribute('title');
  });

  it('WITHHELD: no ≥ on a value that is not a number, and the dash carries the mark', () => {
    // There is no numeral to qualify, so a floor glyph would be a lie. The em dash itself
    // becomes the mark — which is what explains a bare dash once its caption is gone.
    render(
      <KpiTile
        label="False Positive Rate"
        value="—"
        bound="Bounded sample · share unavailable"
        variant="strip"
        density="compact"
        numeral="hero"
      />,
    );
    const tile = screen.getByTestId('kpi-false-positive-rate');
    const span = numeral(tile);

    expect(span).toHaveAttribute('data-bound', 'withheld');
    expect(span).toHaveAttribute('title', 'Bounded sample · share unavailable');
    expect(within(tile).queryByTestId('kpi-false-positive-rate-bound')).toBeNull();
    expect(span).not.toHaveTextContent('≥');
    // `title` is the mouse affordance, never the only carrier: the sentence is still text.
    const sentence = within(tile).getByText('Bounded sample · share unavailable');
    expect(sentence).toHaveClass('sr-only');
  });

  it('UNBOUNDED: no marker of any kind when no bound is in force', () => {
    render(
      <KpiTile
        label="Total Cases"
        value="4"
        countTo={4}
        variant="strip"
        density="compact"
        numeral="hero"
      />,
    );
    const tile = screen.getByTestId('kpi-total-cases');
    expect(within(tile).queryByTestId('kpi-total-cases-bound')).toBeNull();
    expect(tile.querySelector('[data-bound]')).toBeNull();
    expect(tile).not.toHaveTextContent('≥');
  });

  it('keeps the marker on a non-hero tile: the grammar belongs to the bound, not the size', () => {
    render(<KpiTile label="Open Cases" value="12" countTo={12} bound={BOUND} />);
    const tile = screen.getByTestId('kpi-open-cases');
    expect(numeral(tile)).toHaveAttribute('data-bound', 'floor');
    expect(within(tile).getByTestId('kpi-open-cases-bound')).toHaveTextContent('≥');
  });
});
