/**
 * KpiTile — Round 12 foundations (SPEC D16, SYNTHESIS-ux §1.5 / §2.3, diagnosis/layout (c)).
 *
 *  - A numeral NEVER truncates: no ellipsis, no clip; nothing shares its line.
 *  - The scale context wraps on its own line under the numeral; a delta chip may wrap.
 *  - `size="fluid"`: the hero numeral clamp(1.875rem, 0.9rem + 1.4vw, 2.75rem) + its ladder.
 *  - `density="comfortable"`: the page-heading strip rhythm (13px label/context).
 *  - `roll={false}`: a LIVE refresh shows the new value without a count-up.
 *  - `KpiTileGrid` / `kpiGridColumns`: the column count follows the tile count, so a grid
 *    never draws an empty track.
 *  - The ladder counts the `≥` floor mark; a FIT guard steps the size down (then
 *    abbreviates) whenever the numeral does not fit the row it is actually in.
 *  - A hero tile's corner icons sit in the label row's corner, which reserves them, so
 *    they can never cover the numeral.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { KpiTile, KpiTileGrid, kpiGridColumns, numeralSize } from '../KpiTile';

function numeral(tile: HTMLElement): HTMLElement {
  const span = tile.querySelector('.items-end > span');
  expect(span).not.toBeNull();
  return span as HTMLElement;
}

const NO_CUT = /(^|\s)(truncate|text-ellipsis|whitespace-nowrap|line-clamp-\d)(\s|$)/;

describe('KpiTile — a numeral never truncates', () => {
  it('keeps a lower-bound numeral whole on a compact chat tile with a long caption', () => {
    // The chat `kpi_group` reproduction (diagnosis/layout (c)): a compact strip tile, a
    // lower bound, and a prose caption. The numeral read "≥…" and the caption
    // "in the returned p…" because both shared one flex row.
    render(
      <KpiTile
        label="Still open"
        testId="still-open"
        value={
          <>
            <span aria-hidden>≥</span>40
          </>
        }
        secondary="in the returned page of 200 cases"
        variant="strip"
        density="compact"
      />,
    );
    const tile = screen.getByTestId('kpi-still-open');
    const span = numeral(tile);
    expect(span.className).not.toMatch(NO_CUT);
    expect(span).toHaveTextContent('≥40');
    const caption = within(tile).getByText('in the returned page of 200 cases');
    // The caption is NOT in the numeral's row, and is never cut either.
    expect(span.parentElement?.contains(caption)).toBe(false);
    expect(caption.className).not.toMatch(NO_CUT);
  });

  it('lets the delta chip wrap under the numeral rather than squeeze it', () => {
    render(
      <KpiTile
        label="Open cases"
        value="1,204"
        delta={{ value: 3, label: '+3 vs the previous seven days' }}
        variant="strip"
        density="compact"
      />,
    );
    const tile = screen.getByTestId('kpi-open-cases');
    const row = numeral(tile).parentElement as HTMLElement;
    expect(row).toHaveClass('flex', 'flex-wrap', 'items-end');
    const chip = within(tile).getByRole('img');
    expect(chip).toHaveClass('max-w-full');
    expect(chip.className).not.toMatch(NO_CUT);
    const label = chip.querySelector('span[aria-hidden]') as HTMLElement;
    expect(label).toHaveClass('break-words');
    expect(numeral(tile).className).not.toMatch(NO_CUT);
  });

  it('takes its tracking from the size step, never a tracking-* override', () => {
    render(<KpiTile label="Total" value="12" variant="strip" />);
    expect(numeral(screen.getByTestId('kpi-total')).className).not.toMatch(/(^|\s)tracking-/);
  });
});

describe('KpiTile — the ladder counts the floor mark', () => {
  const fmt = (n: number) => n.toLocaleString('en-US');

  it('measures "≥77,777" as seven characters, not six', () => {
    // The reviewer's reproduction: a six-character value plus a bound used to take the
    // full 30px step and split onto two lines at 1280px.
    const { rerender } = render(
      <KpiTile label="Open cases" value="—" countTo={77_777} format={fmt} roll={false}
        bound="At least this many: partial read" variant="strip" density="compact" numeral="hero" />,
    );
    expect(numeral(screen.getByTestId('kpi-open-cases'))).toHaveClass('text-3xl');
    // The same value with no bound in force keeps the full step.
    rerender(
      <KpiTile label="Open cases" value="—" countTo={77_777} format={fmt} roll={false}
        variant="strip" density="compact" numeral="hero" />,
    );
    expect(numeral(screen.getByTestId('kpi-open-cases'))).toHaveClass('text-4xl');
  });

  it('counts it on the fluid scale too', () => {
    render(
      <KpiTile label="Open cases" value="—" countTo={77_777} format={fmt} roll={false}
        bound="At least this many: partial read" variant="strip" density="comfortable"
        numeral="hero" size="fluid" />,
    );
    expect(numeral(screen.getByTestId('kpi-open-cases'))).toHaveClass('kpi-numeral-fluid-md');
  });
});

describe('KpiTile — the fit guard (a numeral that does not fit steps down, never splits)', () => {
  // jsdom has no layout. Model a narrow tile: the numeral's content is wider than its box
  // at any size in `tooBig`, and fits below that.
  const proto = HTMLElement.prototype;
  const original = {
    scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
  };
  function narrowTile(tooBig: string[]) {
    const isNumeral = (el: HTMLElement) => el.parentElement?.classList.contains('items-end') ?? false;
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return isNumeral(this) ? 100 : 0;
      },
    });
    Object.defineProperty(proto, 'scrollWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (!isNumeral(this)) return 0;
        return tooBig.some((c) => this.classList.contains(c)) ? 140 : 90;
      },
    });
  }
  afterEach(() => {
    for (const [key, desc] of Object.entries(original)) {
      if (desc) Object.defineProperty(proto, key, desc);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  });
  const fmt = (n: number) => n.toLocaleString('en-US');

  it('steps a hero numeral down the ladder until it fits its row', () => {
    narrowTile(['text-4xl', 'text-3xl']);
    render(
      <KpiTile label="Open cases" value="—" countTo={12_345} format={fmt} roll={false}
        variant="strip" density="compact" numeral="hero" />,
    );
    const span = numeral(screen.getByTestId('kpi-open-cases'));
    expect(span).toHaveClass('text-2xl');
    // Smaller, never cut and never split: the whole value is still there.
    expect(span).toHaveTextContent('12,345');
    expect(span).toHaveClass('break-normal');
  });

  it('abbreviates through formatCompact once even the smallest size does not fit', () => {
    narrowTile(['text-4xl', 'text-3xl', 'text-2xl', 'text-xl']);
    render(
      <KpiTile label="Events" value="—" countTo={123_456} format={fmt} formatCompact={() => '123k'}
        roll={false} variant="strip" density="compact" numeral="hero" />,
    );
    const tile = screen.getByTestId('kpi-events');
    // The short form takes the size its own length earns, and the exact value stays on
    // the tile for assistive tech and the pointer.
    expect(within(tile).getByText('123k').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(tile).getByText('123,456')).toHaveClass('sr-only');
    expect(numeral(tile)).toHaveAttribute('title', '123,456');
  });

  it('fits a non-hero numeral too (its own size steps)', () => {
    narrowTile(['text-2xl']);
    render(<KpiTile label="Total" value="1,234,567" variant="strip" density="compact" />);
    expect(numeral(screen.getByTestId('kpi-total'))).toHaveClass('text-xl');
  });

  it('leaves a numeral that fits at the size the ladder chose', () => {
    narrowTile([]);
    render(
      <KpiTile label="Open cases" value="—" countTo={42} roll={false}
        variant="strip" density="compact" numeral="hero" />,
    );
    expect(numeral(screen.getByTestId('kpi-open-cases'))).toHaveClass('text-4xl');
  });
});

describe('KpiTile — the hero corner icons never cover the numeral', () => {
  it('puts the (?) and ↗ in the label row corner, which reserves their width', () => {
    render(
      <KpiTile label="Open cases" value="—" countTo={77_777} roll={false}
        bound="At least this many: partial read" help="Cases not yet closed."
        onClick={() => {}} ariaHasPopup="dialog" variant="strip" density="compact" numeral="hero" />,
    );
    const tile = screen.getByTestId('kpi-open-cases');
    const cell = tile.parentElement as HTMLElement;
    const cluster = cell.querySelector('.pointer-events-none.absolute') as HTMLElement;
    expect(cluster).not.toBeNull();
    // Top-anchored on the label's first line, never on the numeral row.
    expect(cluster).toHaveClass('top-1', 'right-2');
    expect(cluster.className).not.toMatch(/(^|\s)(2xl:)?bottom-\d+/);
    // The label row reserves the cluster (24px help + 12px mark); the numeral row does not.
    const labelRow = within(tile).getByText('Open cases').parentElement as HTMLElement;
    expect(labelRow).toHaveClass('pr-10');
    expect(numeral(tile).parentElement).not.toHaveClass('pr-10');
  });

  it('reserves only what is there, at every density', () => {
    const { rerender } = render(
      <KpiTile label="Rate" value="7%" help="About." onClick={() => {}}
        variant="strip" density="comfortable" numeral="hero" />,
    );
    let tile = screen.getByTestId('kpi-rate');
    expect(within(tile).getByText('Rate').parentElement).toHaveClass('pr-6');
    expect(tile.parentElement!.querySelector('.pointer-events-none.absolute')).toHaveClass('top-2', '2xl:top-3');

    rerender(
      <KpiTile label="Rate" value="7%" onClick={() => {}} ariaHasPopup="dialog"
        variant="strip" density="compact" numeral="hero" />,
    );
    tile = screen.getByTestId('kpi-rate');
    expect(within(tile).getByText('Rate').parentElement).toHaveClass('pr-4');
  });
});

describe('KpiTile — strip captions are content text (12px)', () => {
  it('renders a strip `sub` caption at 12px sans, never 11px mono', () => {
    const { rerender } = render(
      <KpiTile label="Pricing" value="12" sub="exact rates" variant="strip" density="compact" />,
    );
    let caption = within(screen.getByTestId('kpi-pricing')).getByText('exact rates');
    expect(caption).toHaveClass('text-xs', 'line-clamp-2');
    expect(caption).not.toHaveClass('text-2xs');
    expect(caption).not.toHaveClass('font-mono');

    rerender(<KpiTile label="Pricing" value="12" sub="exact rates" variant="strip" />);
    caption = within(screen.getByTestId('kpi-pricing')).getByText('exact rates');
    expect(caption).toHaveClass('text-xs', 'truncate');
    expect(caption).not.toHaveClass('font-mono');
  });

  it('renders the breakdown partition at 12px with tabular values', () => {
    render(
      <KpiTile label="Closed" value="9" variant="strip"
        breakdown={[{ label: 'By policy', value: '6' }, { label: 'By analyst', value: '3' }]} />,
    );
    const tile = screen.getByTestId('kpi-closed');
    expect(tile.querySelector('dl')).toHaveClass('text-xs');
    expect(within(tile).getByText('6')).toHaveClass('tabular-nums');
    expect(within(tile).getByText('6')).not.toHaveClass('font-mono');
  });
});

describe('KpiTile — the fluid hero numeral (`size="fluid"`)', () => {
  it('maps the ladder onto the fluid rungs at the same cut points', () => {
    expect(numeralSize('12,345', 'fluid')).toBe('kpi-numeral-fluid');
    expect(numeralSize('123,456', 'fluid')).toBe('kpi-numeral-fluid-md');
    expect(numeralSize('1,234,56', 'fluid')).toBe('kpi-numeral-fluid-md');
    expect(numeralSize('1,234,567', 'fluid')).toBe('kpi-numeral-fluid-sm');
    // The default scale is unchanged.
    expect(numeralSize('12,345')).toBe('text-4xl');
  });

  it('applies the fluid class instead of a fixed step', () => {
    render(
      <KpiTile
        label="Total cases"
        value="43"
        countTo={43}
        variant="strip"
        density="comfortable"
        numeral="hero"
        size="fluid"
      />,
    );
    const span = numeral(screen.getByTestId('kpi-total-cases'));
    expect(span).toHaveClass('kpi-numeral-fluid');
    expect(span.className).not.toMatch(/(^|\s)text-(2xl|3xl|4xl)(\s|$)/);
    // Its row is the size container its `cqi` clamp resolves against: the numeral is
    // sized from the width it has to fit, never from the viewport.
    expect(span.parentElement).toHaveClass('@container');
  });

  it('keeps the container off fixed-size tiles (a size container takes no width from content)', () => {
    render(<KpiTile label="Total cases" value="43" variant="strip" density="compact" numeral="hero" />);
    expect(numeral(screen.getByTestId('kpi-total-cases')).parentElement).not.toHaveClass('@container');
  });

  it('steps down the fluid ladder for a long value instead of cutting it', () => {
    render(
      <KpiTile label="Events" value="1,234,567" variant="strip" numeral="hero" size="fluid" />,
    );
    expect(numeral(screen.getByTestId('kpi-events'))).toHaveClass('kpi-numeral-fluid-sm');
  });
});

describe('KpiTile — the comfortable strip density', () => {
  it('sits between compact and default, with 13px hero label and context lines', () => {
    render(
      <KpiTile
        label="False positive rate"
        value="74%"
        context="32 of 43 verdicted"
        variant="strip"
        density="comfortable"
        numeral="hero"
        size="fluid"
      />,
    );
    const tile = screen.getByTestId('kpi-false-positive-rate');
    expect(tile).toHaveClass('px-3', 'py-3', 'xl:px-4', '2xl:px-5', '2xl:py-4');
    expect(within(tile).getByText('False positive rate')).toHaveClass('text-sm', 'font-medium');
    expect(within(tile).getByText('32 of 43 verdicted')).toHaveClass('text-sm');
  });

  it('leaves the compact hero strip exactly as it was (12px label and context)', () => {
    render(
      <KpiTile
        label="Open cases"
        value="20"
        context="any arrival date"
        variant="strip"
        density="compact"
        numeral="hero"
      />,
    );
    const tile = screen.getByTestId('kpi-open-cases');
    expect(tile).toHaveClass('px-3', 'py-2');
    expect(within(tile).getByText('Open cases')).toHaveClass('text-xs');
    expect(within(tile).getByText('any arrival date')).toHaveClass('text-xs');
  });
});

describe('KpiTile — `roll={false}` for a LIVE refresh', () => {
  it('shows the formatted value as plain text with no count-up', () => {
    render(
      <KpiTile
        label="Total cases"
        value="—"
        countTo={1234}
        format={(n) => n.toLocaleString('en-US')}
        roll={false}
        variant="strip"
      />,
    );
    const tile = screen.getByTestId('kpi-total-cases');
    expect(within(tile).queryByTestId('count-up')).toBeNull();
    expect(numeral(tile)).toHaveTextContent('1,234');
  });
});

describe('kpiGridColumns / KpiTileGrid — no empty tracks', () => {
  const maxCols = (cls: string) =>
    Math.max(...Array.from(cls.matchAll(/grid-cols-(\d+)/g), (m) => Number(m[1])));

  it('never offers more columns than there are tiles', () => {
    for (let n = 1; n <= 12; n++) {
      expect(maxCols(kpiGridColumns(n))).toBeLessThanOrEqual(n);
      expect(maxCols(kpiGridColumns(n))).toBeLessThanOrEqual(6);
    }
  });

  it('gives a small set one equal column per tile at full width', () => {
    expect(maxCols(kpiGridColumns(3))).toBe(3);
    expect(maxCols(kpiGridColumns(4))).toBe(4);
    expect(maxCols(kpiGridColumns(6))).toBe(6);
  });

  it('steps down to balanced rows (six tiles never wrap 5 + 1)', () => {
    expect(kpiGridColumns(6)).not.toMatch(/grid-cols-(4|5)/);
    expect(kpiGridColumns(4)).not.toMatch(/grid-cols-3/);
  });

  it('is robust to a non-finite or zero count', () => {
    expect(kpiGridColumns(0)).toBe('grid-cols-1');
    expect(kpiGridColumns(Number.NaN)).toBe('grid-cols-1');
  });

  it('renders a framed container-query grid, or a bare one inside a card', () => {
    const { container, rerender } = render(
      <KpiTileGrid count={3} role="list" aria-label="Figures">
        <div role="listitem">a</div>
        <div role="listitem">b</div>
        <div role="listitem">c</div>
      </KpiTileGrid>,
    );
    const list = screen.getByRole('list', { name: 'Figures' });
    expect(list).toHaveClass('grid', 'items-stretch', 'grid-cols-1', '@[30rem]:grid-cols-3');
    expect(list.closest('.\\@container')).not.toBeNull();
    const framed = container.querySelector('[data-kpi-grid-frame="framed"]');
    expect(framed).toHaveClass('overflow-hidden', 'rounded-md', 'border');
    expect(container.querySelector('[data-kpi-grid-count="3"]')).not.toBeNull();
    // No `kpi-*` test id of its own: strip specs count those to pin the cell count.
    expect(container.querySelectorAll('[data-testid^="kpi-"]')).toHaveLength(0);

    rerender(
      <KpiTileGrid count={3} framed={false} role="list" aria-label="Figures">
        <div role="listitem">a</div>
      </KpiTileGrid>,
    );
    const frame = container.querySelector('[data-kpi-grid-frame="bare"]');
    expect(frame).toHaveClass('overflow-hidden');
    expect(frame).not.toHaveClass('border');
  });
});
