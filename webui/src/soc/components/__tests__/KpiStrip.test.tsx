/**
 * KpiStrip and the KpiTile chrome (Round 14, SPEC §4.9.2, operator choice C7 option 1).
 *
 * The strip is the Overview's strip as one primitive: strip tiles on a grouped panel,
 * 13px sentence-case labels, ink numerals (red only for a critical tile counting something
 * above zero), no icons, rules that only ever separate two tiles, two columns below 768px.
 * `KpiTile chrome` decides between that page grammar (`strip`, the default) and the
 * bordered tile the chat answer blocks keep (`framed`). jsdom has no layout: structure and
 * classes are pinned here, the measured geometry in the live harness.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AlertTriangle } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { KpiStrip } from '../KpiStrip';
import { KpiTile, KpiTileGrid, kpiStripColumns } from '../KpiTile';
import { MetricHoverTrend } from '../MetricHoverTrend';
import { StatCard } from '../StatCard';

expect.extend(toHaveNoViolations);

function numeral(tile: HTMLElement): HTMLElement {
  const span = tile.querySelector('.items-end > span');
  expect(span).not.toBeNull();
  return span as HTMLElement;
}

function strip(density?: 'comfortable' | 'compact') {
  return render(
    <KpiStrip label="Case summary" density={density} data-testid="strip">
      <KpiTile value="20" label="Open cases" countTo={20} roll={false} context="open now" icon={AlertTriangle} accent="high" />
      <KpiTile value="3" label="Critical" countTo={3} roll={false} accent="critical" />
      <KpiTile value="0" label="Critical resolved" countTo={0} roll={false} accent="critical" />
      <KpiTile label="Auto-closed" value="81%" context="81% of 77" />
    </KpiStrip>,
  );
}

describe('KpiStrip', () => {
  it('is a named group on a full-bleed panel holding a panel-surface tile grid', () => {
    strip();
    const group = screen.getByRole('group', { name: 'Case summary' });
    expect(group).toBe(screen.getByTestId('strip'));
    expect(group).toHaveClass('surface-panel', 'overflow-clip');
    expect(group).toHaveAttribute('data-panel', 'none');
    expect(group).toHaveAttribute('data-kpi-strip', 'comfortable');
    expect(group.querySelector('[data-kpi-grid-frame="panel"]')).not.toBeNull();
    expect(group.querySelector('[data-kpi-grid-count="4"]')).not.toBeNull();
  });

  it('gives every tile the strip grammar: 13px sentence-case label, no icon, no card chrome', () => {
    strip();
    for (const testId of ['kpi-open-cases', 'kpi-critical', 'kpi-auto-closed']) {
      const tile = screen.getByTestId(testId);
      expect(tile.className).not.toMatch(/\b(rounded-lg|bg-card)\b/);
      const label = within(tile).getByText(/Open cases|Critical|Auto-closed/);
      expect(label).toHaveClass('text-sm', 'font-medium');
      expect(label.className).not.toMatch(/uppercase|tracking-/);
    }
    // The icon prop is accepted but draws nothing on a strip.
    expect(screen.getByTestId('kpi-open-cases').querySelector('svg')).toBeNull();
  });

  it('insets every tile by the panel padding, so each row starts on the module edge', () => {
    strip();
    for (const testId of ['kpi-open-cases', 'kpi-critical']) {
      expect(screen.getByTestId(testId)).toHaveClass('px-4', 'xl:px-5', '3xl:px-6');
    }
  });

  it('keeps numerals ink, red only for a critical tile that counts something above zero', () => {
    strip();
    expect(numeral(screen.getByTestId('kpi-open-cases'))).toHaveClass('text-foreground');
    expect(numeral(screen.getByTestId('kpi-critical'))).toHaveClass('text-critical-text');
    expect(numeral(screen.getByTestId('kpi-critical-resolved'))).toHaveClass('text-foreground');
    expect(numeral(screen.getByTestId('kpi-critical-resolved'))).not.toHaveClass('text-critical-text');
  });

  it('comfortable strips grow their numerals with the tile; compact strips use the 24px page step', () => {
    const { unmount } = strip('comfortable');
    expect(numeral(screen.getByTestId('kpi-open-cases')).className).toMatch(/kpi-numeral-fluid/);
    unmount();
    strip('compact');
    expect(screen.getByRole('group', { name: 'Case summary' })).toHaveAttribute('data-kpi-strip', 'compact');
    expect(numeral(screen.getByTestId('kpi-open-cases'))).toHaveClass('text-3xl');
    expect(within(screen.getByTestId('kpi-open-cases')).getByText('Open cases')).toHaveClass('text-sm');
  });

  it('lets an explicit prop win over the strip default', () => {
    render(
      <KpiStrip label="Mixed">
        <KpiTile label="Framed" value="1" chrome="framed" variant="default" />
      </KpiStrip>,
    );
    expect(screen.getByTestId('kpi-framed')).toHaveClass('rounded-lg', 'border', 'bg-card');
  });

  it('a pressed tile is a toggle: aria-pressed plus the selected wash and a 2px base rule', () => {
    const onClick = vi.fn();
    render(
      <KpiStrip label="Filters">
        <KpiTile value="13" label="Needs human" countTo={13} roll={false} pressed onClick={onClick} />
        <KpiTile value="4" label="Investigating" countTo={4} roll={false} pressed={false} onClick={onClick} />
      </KpiStrip>,
    );
    const on = screen.getByRole('button', { name: /Needs human/ });
    const off = screen.getByRole('button', { name: /Investigating/ });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    expect(off).toHaveAttribute('aria-pressed', 'false');
    // The rule is a 2px BORDER (forced colours replace a background rule with Canvas).
    expect(on).toHaveClass('bg-accent', 'after:h-0', 'after:border-b-2', 'after:border-primary');
    expect(on.className).not.toMatch(/after:bg-/);
    expect(off).not.toHaveClass('bg-accent');
    fireEvent.click(off);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The ring is drawn inside the tile (a panel clips an outset ring).
    expect(on).toHaveClass('focus-visible:ring-inset');
  });

  it('a pressed tile carries no muted ink on its wash (muted on the wash is 4.2:1 in light)', () => {
    render(
      <KpiStrip label="Filters">
        <KpiTile value="13" label="Needs human" countTo={13} roll={false} context="verdict, last 7 days" pressed onClick={() => {}} />
        <KpiTile value="4" label="Investigating" countTo={4} roll={false} context="open now" pressed={false} onClick={() => {}} />
      </KpiStrip>,
    );
    const on = screen.getByRole('button', { name: /Needs human/ });
    const off = screen.getByRole('button', { name: /Investigating/ });
    // Every muted text inside the pressed tile (label, context line, secondary, delta
    // words) resolves to the foreground ink; the resting tile keeps its quiet label.
    expect(on).toHaveClass('[--muted-foreground:var(--foreground)]');
    expect(off.className).not.toContain('--muted-foreground');
    expect(within(on).getByText('Needs human')).toHaveClass('text-muted-foreground');
    expect(within(on).getByText('verdict, last 7 days')).toHaveClass('text-muted-foreground');
  });

  it('a pressed tile with help raises the help button on its wash too (the cell root carries the ink)', () => {
    render(
      <KpiStrip label="Filters">
        <KpiTile value="13" label="Needs human" countTo={13} roll={false} help="Cases waiting for an analyst." pressed onClick={() => {}} />
      </KpiStrip>,
    );
    const help = screen.getByRole('button', { name: 'About Needs human' });
    const cell = help.closest('.group\\/kpi') as HTMLElement;
    expect(cell).not.toBeNull();
    expect(cell).toHaveClass('[--muted-foreground:var(--foreground)]');
  });

  it('keeps every numeral on one row when clickable and static tiles, with and without context, share a strip', () => {
    render(
      <KpiStrip label="Mixed tiles">
        <KpiTile value="77" label="Total cases" countTo={77} roll={false} context="all time" />
        <KpiTile value="13" label="Needs human" countTo={13} roll={false} onClick={() => {}} />
        <KpiTile value="62" label="Resolved or closed" countTo={62} roll={false} />
      </KpiStrip>,
    );
    for (const testId of ['kpi-total-cases', 'kpi-needs-human', 'kpi-resolved-or-closed']) {
      const tile = screen.getByTestId(testId);
      // A full-height column whose numeral row is pushed down (`mt-auto`) above the line...
      expect(tile).toHaveClass('flex', 'h-full', 'flex-col');
      expect(tile.querySelector('.mt-auto')).not.toBeNull();
      // ...and every tile has that two-line line, an empty reserved one without context.
      const line = tile.querySelector('[data-kpi-line]');
      expect(line).not.toBeNull();
      expect(line).toHaveClass('min-h-[2lh]');
    }
    const reserved = screen.getByTestId('kpi-needs-human').querySelector('[data-kpi-line]') as HTMLElement;
    expect(reserved).toHaveAttribute('data-kpi-line', 'none');
    expect(reserved).toHaveAttribute('aria-hidden', 'true');
    expect(reserved).toBeEmptyDOMElement();
    expect(screen.getByTestId('kpi-total-cases').querySelector('[data-kpi-line]')).toHaveAttribute('data-kpi-line', 'context');
  });

  it('marks the tile that starts a second split, and the grid draws the strong rule before it', () => {
    render(
      <KpiStrip label="State and severity">
        <KpiTile value="20" label="Open" countTo={20} roll={false} />
        <KpiTile value="57" label="Closed" countTo={57} roll={false} />
        <KpiTile value="3" label="Critical" countTo={3} roll={false} accent="critical" breakBefore />
      </KpiStrip>,
    );
    expect(screen.getByTestId('kpi-critical')).toHaveAttribute('data-kpi-break', '');
    expect(screen.getByTestId('kpi-open')).not.toHaveAttribute('data-kpi-break');
    const grid = screen.getByTestId('kpi-critical').parentElement as HTMLElement;
    expect(grid.className).toContain('[&>[data-kpi-break]]:border-l-border-strong');
  });

  it('draws the strong rule before a wrapped tile too (a hover trend card around the tile)', () => {
    const points = [
      { label: '2026-07-01T05:00:00Z', value: 2 },
      { label: '2026-07-01T06:00:00Z', value: 5 },
    ];
    render(
      <KpiStrip label="State and severity">
        <MetricHoverTrend metric="Open" points={points} windowLabel="last 24 hours">
          <KpiTile value="20" label="Open" countTo={20} roll={false} />
        </MetricHoverTrend>
        <MetricHoverTrend metric="Critical" points={points} windowLabel="last 24 hours">
          <KpiTile value="3" label="Critical" countTo={3} roll={false} accent="critical" breakBefore />
        </MetricHoverTrend>
      </KpiStrip>,
    );
    const [, wrapper] = screen.getAllByTestId('metric-trend-trigger');
    const grid = wrapper.parentElement as HTMLElement;
    // The mark stays on the tile; the grid child is the wrapper, matched with :has().
    expect(wrapper).not.toHaveAttribute('data-kpi-break');
    expect(within(wrapper).getByTestId('kpi-critical')).toHaveAttribute('data-kpi-break', '');
    expect(grid.className).toContain('[&>*:has([data-kpi-break])]:border-l-border-strong');
    expect(grid.className).toContain('[&>*:has([data-kpi-break])]:[border-image:none]');
  });

  it('has no axe violations', async () => {
    const { container } = strip();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('KpiTileGrid surface="panel"', () => {
  it('draws rules above and before each tile, hung outside the clip, with no frame', () => {
    render(
      <KpiTileGrid count={5} surface="panel" data-testid="grid">
        <div>a</div>
        <div>b</div>
        <div>c</div>
        <div>d</div>
        <div>e</div>
      </KpiTileGrid>,
    );
    const grid = screen.getByTestId('grid');
    expect(grid).toHaveClass('-ml-px', '-mt-px', '[&>*]:border-l', '[&>*]:border-t');
    expect(grid.className).not.toMatch(/\[&>\*\]:border-(b|r)\b/);
    expect(grid.parentElement).toHaveAttribute('data-kpi-grid-frame', 'panel');
    expect(grid.parentElement?.className).not.toMatch(/\bborder\b/);
  });

  it('is two columns below 768px and steps up by the tile count on the strip width', () => {
    expect(kpiStripColumns(6).cols).toBe('grid-cols-2 md:@[30rem]:grid-cols-3 md:@[60rem]:grid-cols-6');
    expect(kpiStripColumns(4).cols).toBe('grid-cols-2 md:@[40rem]:grid-cols-4');
    expect(kpiStripColumns(1).cols).toBe('grid-cols-1');
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 12]) {
      expect(kpiStripColumns(n).cols.startsWith('grid-cols-2')).toBe(true);
    }
  });

  it('insets the column rules only at the step where every tile shares one row', () => {
    expect(kpiStripColumns(6).oneRow).toBe('md:@[60rem]:[&>*]:[border-image:var(--panel-inset-rule)_0_0_0_1]');
    expect(kpiStripColumns(9).oneRow).toBe('');
  });

  it('puts seven and eight tiles on one row from 128px a tile (the C7 Cases strip), four columns below', () => {
    expect(kpiStripColumns(7)).toEqual({
      cols: 'grid-cols-2 md:@[40rem]:grid-cols-4 md:@[56rem]:grid-cols-7',
      oneRow: 'md:@[56rem]:[&>*]:[border-image:var(--panel-inset-rule)_0_0_0_1]',
    });
    expect(kpiStripColumns(8)).toEqual({
      cols: 'grid-cols-2 md:@[40rem]:grid-cols-4 md:@[64rem]:grid-cols-8',
      oneRow: 'md:@[64rem]:[&>*]:[border-image:var(--panel-inset-rule)_0_0_0_1]',
    });
  });

  it('leaves the card grid exactly as it was', () => {
    render(
      <KpiTileGrid count={3} data-testid="grid">
        <div>a</div>
      </KpiTileGrid>,
    );
    const grid = screen.getByTestId('grid');
    expect(grid).toHaveClass('-mb-px', '-mr-px', '[&>*]:border-b', '[&>*]:border-r');
    expect(grid.parentElement).toHaveAttribute('data-kpi-grid-frame', 'framed');
  });
});

describe('KpiTile chrome', () => {
  it('defaults to the strip chrome on a page: no border, no icon chip, sentence-case label', () => {
    render(<KpiTile label="Knowledge chunks" value="1,204" icon={AlertTriangle} accent="info" />);
    const tile = screen.getByTestId('kpi-knowledge-chunks');
    expect(tile.className).not.toMatch(/\b(rounded-lg|border|bg-card)\b/);
    expect(tile.querySelector('svg')).toBeNull();
    expect(within(tile).getByText('Knowledge chunks')).toHaveClass('text-sm');
    expect(within(tile).getByText('Knowledge chunks').className).not.toMatch(/uppercase/);
  });

  it('framed is the pre-Round 14 tile: bordered card, icon chip, tracked label', () => {
    render(<KpiTile chrome="framed" label="Knowledge chunks" value="1,204" icon={AlertTriangle} accent="info" />);
    const tile = screen.getByTestId('kpi-knowledge-chunks');
    expect(tile).toHaveClass('rounded-lg', 'border', 'bg-card', 'p-4');
    expect(tile.querySelector('svg')).not.toBeNull();
    expect(within(tile).getByText('Knowledge chunks')).toHaveClass('uppercase');
  });

  it('StatCard keeps the framed tile and its accent bar (its callers render as before)', () => {
    render(<StatCard label="MTTR" value="1h 4m" accent="high" />);
    const tile = screen.getByTestId('kpi-mttr');
    expect(tile).toHaveClass('rounded-lg', 'border', 'bg-card');
    expect(tile.querySelector('span[aria-hidden].bg-high')).not.toBeNull();
  });

  it('a plain numeric value turns red only on a critical tile above zero', () => {
    const { rerender } = render(<KpiTile label="Breached" value={4} accent="critical" />);
    expect(numeral(screen.getByTestId('kpi-breached'))).toHaveClass('text-critical-text');
    rerender(<KpiTile label="Breached" value={0} accent="critical" />);
    expect(numeral(screen.getByTestId('kpi-breached'))).toHaveClass('text-foreground');
    rerender(<KpiTile label="Breached" value="4" accent="critical" />);
    expect(numeral(screen.getByTestId('kpi-breached'))).toHaveClass('text-foreground');
  });
});

describe('chat answer blocks keep the framed chrome (no BLOCKS amendment needed)', () => {
  const renderers = path.resolve(__dirname, '../../chat/blocks/renderers');
  it.each(['ComparisonView.tsx', 'InfographicView.tsx', 'KpiGroupView.tsx'])('%s passes chrome="framed"', (file) => {
    const source = readFileSync(path.join(renderers, file), 'utf8');
    const tiles = (source.match(/<KpiTile\b/g) ?? []).length;
    expect(tiles).toBeGreaterThan(0);
    expect((source.match(/\bchrome="framed"/g) ?? []).length).toBe(tiles);
  });
});
