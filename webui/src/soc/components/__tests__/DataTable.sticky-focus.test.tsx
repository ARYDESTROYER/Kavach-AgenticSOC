/**
 * A sticky first column never hides the focused control (Round 16 bug hunt B74, WP15F;
 * WCAG 2.2 SC 2.4.11, technique C43).
 *
 * With `stickyFirstColumn`, Tab into a later column's sort button scrolled it to the
 * scroller's left edge, under the pinned column. The horizontal scroller now pads its inline
 * start by the pinned cells' right edge, measured from the scroller and kept current with a
 * ResizeObserver, so the browser stops the scroll short of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DataTable, type DataTableColumn } from '../DataTable';

interface Row {
  id: string;
  name: string;
  acked: number;
}

const rows: Row[] = [
  { id: 'a', name: 'jdoe', acked: 3 },
  { id: 'b', name: 'asmith', acked: 9 },
];

const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Person', cell: (r) => r.name, sortable: true },
  { id: 'acked', header: 'Acknowledged', kind: 'number', cell: (r) => r.acked, sortable: true },
];

const realResizeObserver = window.ResizeObserver;
const realRect = HTMLElement.prototype.getBoundingClientRect;
let observed: Element[] = [];

beforeEach(() => {
  observed = [];
  window.ResizeObserver = class {
    observe(el: Element) {
      observed.push(el);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // The scroller starts 16 px in (the phone gutter); the pinned Person header ends at 236 px.
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    if (this.hasAttribute('data-table-scroll')) return DOMRect.fromRect({ x: 16, y: 0, width: 358, height: 200 });
    if (this.hasAttribute('data-sticky-lead')) return DOMRect.fromRect({ x: 56, y: 0, width: 180, height: 36 });
    return realRect.call(this);
  };
});

afterEach(() => {
  window.ResizeObserver = realResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

function scroller(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-table-scroll]');
  if (!el) throw new Error('no scroller');
  return el;
}

describe('DataTable sticky first column (B74)', () => {
  it('pads the scroller by the pinned cells, checkbox column included', () => {
    const { unmount } = render(
      <DataTable<Row>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="People"
        stickyFirstColumn
        selectable
        selected={[]}
        onSelectedChange={() => {}}
        sort={{ id: 'name', dir: 'asc' }}
        onSortChange={() => {}}
      />,
    );
    const el = scroller();
    // 236 (the pinned header's right edge) - 16 (the scroller's left) = 220.
    expect(el.style.getPropertyValue('scroll-padding-inline-start')).toBe('220px');
    const lead = screen.getByRole('columnheader', { name: /person/i });
    expect(lead).toHaveAttribute('data-sticky-lead');
    // Kept current: the pinned cell and the scroller are both observed.
    expect(observed).toContain(lead);
    expect(observed).toContain(el);
    unmount();
    expect(el.style.getPropertyValue('scroll-padding-inline-start')).toBe('');
  });

  it('sets nothing without a sticky column', () => {
    render(<DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="People" />);
    expect(scroller().style.getPropertyValue('scroll-padding-inline-start')).toBe('');
    expect(document.querySelector('[data-sticky-lead]')).toBeNull();
  });

  it('drops the padding when the prop is turned off', () => {
    const { rerender } = render(
      <DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="People" stickyFirstColumn />,
    );
    expect(scroller().style.getPropertyValue('scroll-padding-inline-start')).toBe('220px');
    rerender(<DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="People" />);
    expect(scroller().style.getPropertyValue('scroll-padding-inline-start')).toBe('');
  });

  it('works where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    try {
      render(
        <DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="People" stickyFirstColumn />,
      );
      expect(scroller().style.getPropertyValue('scroll-padding-inline-start')).toBe('220px');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
