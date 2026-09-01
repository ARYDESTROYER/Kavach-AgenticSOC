/**
 * KpiTile — the `secondary` SCALE-CONTEXT slot and the `breakdown` PARTITION slot.
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
import { describe, it, expect, vi } from 'vitest';
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
    render(<KpiTile label="Total Critical" value="7" secondary="—" variant="strip" />);
    const tile = screen.getByTestId('kpi-total-critical');
    expect(within(tile).getByText('—')).toBeInTheDocument();
    expect(within(tile).queryByText(/0%/)).toBeNull();
  });

  it('omits the slot entirely for undefined / null / empty context', () => {
    for (const secondary of [undefined, null, ''] as const) {
      const { container, unmount } = render(
        <KpiTile label="Open Cases" value="3" secondary={secondary} variant="strip" />,
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
        label="Resolved / Closed"
        value="42"
        secondary="60% of 70"
        delta={{ value: 12, label: '+12%' }}
        goodDirection="up"
      />,
    );
    const tile = screen.getByTestId('kpi-resolved-closed');
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
    // The landing strip relies on this in BOTH directions: a pinned testId survives a
    // reworded label (so an anchor is never renamed by accident) — and, because it
    // does, a deliberate rename MUST re-key the testId in the same edit or the anchor
    // is left naming the metric that moved away.
    render(<KpiTile label="Critical" testId="critical-high" value="4" secondary="9% of 44" />);
    expect(screen.getByTestId('kpi-critical-high')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-critical')).toBeNull();
  });
});

describe('KpiTile — breakdown partition rows', () => {
  it('renders the partition as a real <dl>, in order, with no role or judgement colour', () => {
    render(
      <KpiTile
        label="Resolved / Closed"
        testId="resolved-closed"
        value="9"
        secondary="25% of 36"
        sub="Reached a terminal state"
        variant="strip"
        breakdown={[
          { label: 'AI agent', value: '5', title: 'Closed by the agent' },
          { label: 'Human', value: '3', title: 'Closed by an analyst' },
          { label: 'System', value: '0', title: 'System routing or no recorded decider' },
        ]}
      />,
    );
    const tile = screen.getByTestId('kpi-resolved-closed');
    const terms = Array.from(tile.querySelectorAll('dl > dt'));
    const defs = Array.from(tile.querySelectorAll('dl > dd'));
    expect(terms.map((n) => n.textContent)).toEqual(['AI agent', 'Human', 'System']);
    // A zero band stays visible: folding it away leaves a partition that reads as
    // complete while one of its members has silently vanished.
    expect(defs.map((n) => n.textContent)).toEqual(['5', '3', '0']);
    expect(terms[0]).toHaveAttribute('title', 'Closed by the agent');
    // Plain text only — the landing strip pins "no role=img inside any KPI tile".
    expect(within(tile).queryByRole('img')).toBeNull();
    expect(tile.querySelector('dl')?.className).not.toMatch(/text-(critical|success)/);
  });

  it('renders no <dl> at all when the partition is absent or empty', () => {
    const { rerender } = render(<KpiTile label="Resolved / Closed" testId="rc" value="9" />);
    expect(screen.getByTestId('kpi-rc').querySelector('dl')).toBeNull();
    rerender(<KpiTile label="Resolved / Closed" testId="rc" value="9" breakdown={[]} />);
    expect(screen.getByTestId('kpi-rc').querySelector('dl')).toBeNull();
  });

  it('keeps the partition OUT of a clickable tile\u2019s accessible name', () => {
    // The landing strip's tiles are disclosure TRIGGERS. ARIA gives `role=button`
    // "children presentational", so a <dl> rendered inside one is stripped of its
    // dt/dd relationships (and of each dt's `title`) and flattened into the trigger's
    // name — a 13-word run-on that also changes every time a band's count changes.
    // The partition therefore renders as a SIBLING of the button.
    render(
      <KpiTile
        label="Resolved / Closed"
        testId="resolved-closed"
        value="9"
        secondary="25% of 36"
        sub="Reached a terminal state"
        variant="strip"
        onClick={vi.fn()}
        ariaExpanded={false}
        breakdown={[
          { label: 'AI agent', value: '5', title: 'Closed by the agent' },
          { label: 'Human', value: '3', title: 'Closed by an analyst' },
          { label: 'System', value: '1', title: 'System routing or no recorded decider' },
        ]}
      />,
    );
    const trigger = screen.getByTestId('kpi-resolved-closed');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.querySelector('dl')).toBeNull();

    // The button carries no `aria-label`, so its accessible name is computed from
    // contents — i.e. exactly its flattened text. Asserting on that text needs no
    // extra dependency and is the same string an AT would announce.
    expect(trigger).not.toHaveAttribute('aria-label');
    const name = trigger.textContent ?? '';
    expect(name).toContain('Resolved / Closed');
    for (const band of ['AI agent', 'Human', 'System']) {
      expect(name).not.toContain(band);
    }

    // …and it is still a real, ordered definition list on the page, reachable by AT.
    const partition = screen.getByTestId('kpi-resolved-closed-breakdown');
    expect(trigger.contains(partition)).toBe(false);
    expect(
      Array.from(partition.querySelectorAll('dl > dt')).map((n) => n.textContent),
    ).toEqual(['AI agent', 'Human', 'System']);
    expect(
      Array.from(partition.querySelectorAll('dl > dd')).map((n) => n.textContent),
    ).toEqual(['5', '3', '1']);
  });
});
