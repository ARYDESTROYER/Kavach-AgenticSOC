/**
 * KpiTile — the `secondary` SCALE-CONTEXT slot.
 *
 * A bare count answers "how many" but never "out of what". `secondary` supplies the
 * denominator beside the numeral ("13% of 154", "1 of 2 verdicted", or an em dash when
 * the honest denominator is missing).
 *
 * It is deliberately NOT the `delta` slot. A delta carries `role="img"` plus a
 * judgement colour (improved/worse); scale context is neither a comparison nor a
 * judgement, and the landing strip pins "no role=img inside any KPI tile"
 * (overview.render). These cases keep the two slots from being conflated.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { KpiTile } from '../KpiTile';

describe('KpiTile — secondary scale context', () => {
  it('renders the context beside the value with NO role, name, or judgement colour', () => {
    render(
      <KpiTile
        label="Open Cases"
        value="20"
        secondary="13% of 154"
        sub="Every active lifecycle state"
        variant="strip"
      />,
    );
    const tile = screen.getByTestId('kpi-open-cases');
    const context = within(tile).getByText('13% of 154');
    expect(context).toBeInTheDocument();
    // Not a delta: no role="img", so it never becomes a second accessible name and
    // never trips the strip's "no delta chip on any tile" contract.
    expect(within(tile).queryByRole('img')).toBeNull();
    expect(context).toHaveClass('text-muted-foreground', 'tabular-nums');
    expect(context.className).not.toMatch(/text-(success|critical)-text/);
    // It sits in the VALUE row (baseline-aligned with the numeral), not in the sub.
    expect(context.parentElement).toHaveClass('flex', 'items-end');
    expect(within(context.parentElement as HTMLElement).getByText('20')).toBeInTheDocument();
  });

  it('renders an em dash verbatim when the caller has no honest denominator', () => {
    render(<KpiTile label="Critical" value="7" secondary="—" variant="strip" />);
    const tile = screen.getByTestId('kpi-critical');
    expect(within(tile).getByText('—')).toBeInTheDocument();
    expect(within(tile).queryByText(/0%/)).toBeNull();
  });

  it('omits the slot entirely for undefined / null / empty context', () => {
    for (const secondary of [undefined, null, ''] as const) {
      const { container, unmount } = render(
        <KpiTile label="Escalated" value="3" secondary={secondary} variant="strip" />,
      );
      const valueRow = container.querySelector('.items-end') as HTMLElement;
      // Only the numeral — no empty muted span padding the row.
      expect(valueRow.children).toHaveLength(1);
      unmount();
    }
  });

  it('coexists with a delta without either slot absorbing the other', () => {
    render(
      <KpiTile
        label="Auto-Resolved"
        value="42"
        secondary="60% of 70"
        delta={{ value: 12, label: '+12%' }}
        goodDirection="up"
      />,
    );
    const tile = screen.getByTestId('kpi-auto-resolved');
    expect(within(tile).getByText('60% of 70')).toBeInTheDocument();
    // The delta keeps its own announced role; the context stays silent text.
    expect(within(tile).getByRole('img')).toHaveAccessibleName(/changed up by \+12%, improved/i);
  });

  it('shrinks with an ellipsis instead of clipping mid-word in a narrow tile', () => {
    // Regression: the strip's 5-column breakpoint leaves ~163px inside a tile, and the
    // secondary used to be a bare `whitespace-nowrap` span in a flex row with no
    // `min-w-0`. Inside the tile's `overflow-hidden` that hard-clipped a long context
    // ("12,345 of 48,901 verdicted") mid-word with no ellipsis. It must now be
    // shrinkable + truncating, and carry its full text in `title`.
    render(
      <KpiTile
        label="False Positive Rate"
        value="13%"
        secondary="12,345 of 48,901 verdicted"
        variant="strip"
      />,
    );
    const tile = screen.getByTestId('kpi-false-positive-rate');
    const context = within(tile).getByText('12,345 of 48,901 verdicted');
    // `truncate` = overflow-hidden + text-ellipsis + whitespace-nowrap.
    expect(context).toHaveClass('min-w-0', 'truncate');
    expect(context.className).not.toMatch(/(^|\s)whitespace-nowrap(\s|$)/);
    expect(context).toHaveAttribute('title', '12,345 of 48,901 verdicted');
    // A flex child only shrinks when the ROW can shrink below its content width.
    expect(context.parentElement).toHaveClass('min-w-0');
  });

  it('keeps the pinned testid when a label is reworded but testId is passed', () => {
    // The Overview Critical tile relies on this: narrowing "Critical / High" to
    // "Critical" must not silently rename `kpi-critical-high` -> `kpi-critical`
    // unless that rename is deliberate.
    render(<KpiTile label="Critical" testId="critical-high" value="4" secondary="9% of 44" />);
    expect(screen.getByTestId('kpi-critical-high')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-critical')).toBeNull();
  });
});
