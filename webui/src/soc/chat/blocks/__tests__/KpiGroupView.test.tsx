/**
 * KpiGroupView (Round 12, diagnosis/layout.md (c), the operator's screenshot 4): the
 * columns follow the item count (three figures, three columns: no empty tracks), the
 * grid draws no second frame inside the block card, a lower bound keeps its whole
 * numeral and its caption wraps on its own line ("≥253" over "in the returned page…",
 * never "≥…" beside "in the returned …"), and print/static mode puts each delta chip on
 * its own line and never renders a tile as a button.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { kpiGridColumns } from '@/soc/components/KpiTile';
import { BlocksContext } from '../context';
import { KpiGroupView } from '../renderers/KpiGroupView';
import type { KpiItem } from '../schema';

const SHOT4: KpiItem[] = [
  { key: 'matching', label: 'Matching cases', unit: 'count', value: 253 } as KpiItem,
  { key: 'still_open', label: 'Still open', unit: 'count', value: 253, bound: 'lower', context: 'in the returned page of 100 cases' } as KpiItem,
  { key: 'avg_risk', label: 'Average risk', unit: 'score', value: 13 } as KpiItem,
];

function show(items: KpiItem[], props: { staticMode?: boolean; framed?: boolean; navigate?: () => void } = {}) {
  return render(
    <BlocksContext.Provider value={{ navigate: props.navigate ?? vi.fn(), compact: false, domId: 'm' }}>
      <KpiGroupView items={items} idPrefix="t" staticMode={props.staticMode} framed={props.framed} />
    </BlocksContext.Provider>,
  );
}

const list = () => within(screen.getByTestId('block-kpis')).getByRole('list');

describe('KpiGroupView', () => {
  it('gives three figures three columns (never three tiles in a six-track row)', () => {
    show(SHOT4);
    const grid = list();
    expect(within(grid).getAllByRole('listitem')).toHaveLength(3);
    for (const cls of kpiGridColumns(3).split(' ')) expect(grid).toHaveClass(cls);
    expect(grid.className).not.toContain('grid-cols-6');
    expect(screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-count]')).toHaveAttribute('data-kpi-grid-count', '3');
  });

  it.each([1, 2, 4, 5, 6, 7])('follows the item count with %i figures', (n) => {
    const items = Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `Figure ${i}`, unit: 'count', value: i } as KpiItem));
    show(items);
    expect(list().className).toContain(kpiGridColumns(n));
  });

  it('draws no frame of its own inside the block card (no double frame)', () => {
    show(SHOT4);
    const frame = screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-frame]') as HTMLElement;
    expect(frame).toHaveAttribute('data-kpi-grid-frame', 'bare');
    expect(frame).not.toHaveClass('border');
  });

  it('can still draw a closed frame when a host asks for one', () => {
    show(SHOT4, { framed: true });
    const frame = screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-frame]') as HTMLElement;
    expect(frame).toHaveAttribute('data-kpi-grid-frame', 'framed');
    expect(frame).toHaveClass('border', 'rounded-md');
  });

  it('keeps a lower bound whole and puts its caption on its own wrapping line (screenshot 4)', () => {
    show(SHOT4);
    const tile = screen.getByTestId('kpi-t-1');
    expect(tile).toHaveTextContent('≥253');
    expect(tile).toHaveTextContent('at least');
    const caption = screen.getByText('in the returned page of 100 cases');
    // The caption's line is its own block under the numeral and wraps: no ellipsis.
    const line = caption.closest('[data-kpi-secondary]') as HTMLElement;
    expect(line).toHaveClass('block', 'break-words');
    expect(line).not.toHaveClass('truncate');
    expect(caption).not.toHaveAttribute('title');
    // Nothing in the group is cut with an ellipsis.
    for (const el of Array.from(screen.getByTestId('block-kpis').querySelectorAll('span'))) {
      expect(el.className).not.toMatch(/\btruncate\b/);
    }
  });

  it('wraps a gauge tile label and caption instead of truncating them', () => {
    show([{ key: 'ari', label: 'Active Risk Index', unit: 'score', value: 47.6, display: 'gauge', context: '20 active cases now' } as KpiItem]);
    const tile = screen.getByTestId('kpi-t-0');
    expect(within(tile).getByText('Active Risk Index')).toHaveClass('break-words');
    expect(within(tile).getByText('20 active cases now')).toHaveClass('break-words');
    expect(tile.innerHTML).not.toContain('truncate');
  });

  it('in static/print mode puts each delta chip on its own line and renders no buttons', () => {
    const navigate = vi.fn();
    const items: KpiItem[] = [
      {
        key: 'opened',
        label: 'Cases opened',
        unit: 'count',
        value: 1284,
        delta: { value: 212, period_label: 'vs last week', good_direction: 'down' },
        ref: { page: 'cases', opts: { status: 'open' } },
      } as KpiItem,
    ];
    show(items, { staticMode: true, navigate });
    expect(screen.getByTestId('block-kpis')).toHaveAttribute('data-static', 'true');
    expect(screen.queryByRole('button')).toBeNull();
    const tile = screen.getByTestId('kpi-t-0');
    // The row that holds the chip becomes a column (selected by what it contains).
    expect(tile.className).toContain('[&_div:has(>[role=img])]:flex-col');
    const chip = within(tile).getByRole('img', { name: /changed up by \+212 vs last week/ });
    expect(chip.parentElement).toContainElement(chip);
  });

  it('keeps tiles with a ref as navigation buttons on screen', () => {
    const navigate = vi.fn();
    show([{ key: 'o', label: 'Open cases', unit: 'count', value: 3, ref: { page: 'cases', opts: { status: 'open' } } } as KpiItem], { navigate });
    screen.getByRole('button', { name: /Open cases/ }).click();
    expect(navigate).toHaveBeenCalledWith({ page: 'cases', opts: { status: 'open' } });
    expect(screen.getByTestId('kpi-t-0').className).not.toContain('flex-col');
  });
});
