/**
 * DataTable, Round 14 table grammar (SPEC §4.9.2, operator choice C7 option 1):
 * compact by default, sentence-case headers, fixed layout when widths are declared with
 * one-line truncation (a hover title only when cut), `kind` cells on one line with tabular
 * figures, `surface="panel"` (no box, panel inset on the edges), `emptyState` replacing
 * the whole table, a sticky first column, a right-edge fade while more columns scroll, and
 * no pager for one page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DataTable, TruncatedText, richCutSignal, type DataTableColumn } from '../DataTable';
import { EmptyState } from '../EmptyState';

interface Row {
  id: string;
  title: string;
  count: number;
  when: string;
  ip: string;
}

const rows: Row[] = [
  { id: 'CASE-000001', title: 'Impossible travel for jdoe', count: 1234, when: '09:41', ip: '198.51.100.23' },
  { id: 'CASE-000002', title: 'Phishing link clicked', count: 7, when: '10:02', ip: '203.0.113.9' },
];

const columns: DataTableColumn<Row>[] = [
  { id: 'id', header: 'Case ID', kind: 'id', width: '7.5rem', cell: (r) => r.id },
  { id: 'title', header: 'Title', minWidth: 280, cell: (r) => r.title },
  { id: 'count', header: 'Events', kind: 'number', width: 96, cell: (r) => r.count },
  { id: 'when', header: 'Time (UTC)', kind: 'time', width: '6rem', cell: (r) => r.when },
  { id: 'ip', header: 'Source IP', kind: 'ip', width: '9rem', cell: (r) => r.ip },
];

const autoColumns: DataTableColumn<Row>[] = [
  { id: 'title', header: 'Title', sortable: true, cell: (r) => r.title },
  { id: 'count', header: 'Events', kind: 'number', cell: (r) => r.count },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataTable, Round 14 grammar', () => {
  it('is compact by default with 12px medium sentence-case headers', () => {
    const { container } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        sort={{ id: 'title', dir: 'asc' }}
        onSortChange={() => {}}
        ariaLabel="Cases"
      />,
    );
    const th = container.querySelectorAll('thead th');
    for (const head of Array.from(th)) {
      expect(head).toHaveClass('h-9', 'text-xs', 'font-medium');
      expect(head.className).not.toMatch(/\buppercase\b|tracking-wide/);
    }
    const sortButton = screen.getByRole('button', { name: /Title/ });
    expect(sortButton.className).not.toMatch(/\buppercase\b|tracking-wide|font-semibold/);
    expect(sortButton).toHaveClass('font-medium');
    // Compact rows: 8px vertical cell padding.
    expect(screen.getByText('Phishing link clicked').closest('td')).toHaveClass('py-2');
  });

  it('keeps the roomier rows when asked for normal density', () => {
    render(
      <DataTable<Row> columns={autoColumns} rows={rows} getRowId={(r) => r.id} density="normal" ariaLabel="Cases" />,
    );
    expect(screen.getByText('Phishing link clicked').closest('td')).toHaveClass('py-3');
  });

  it('switches to a fixed layout when a column declares a width, never squeezing a flexible column below its minimum', () => {
    const { container } = render(
      <DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />,
    );
    const table = container.querySelector('table')!;
    expect(table).toHaveClass('table-fixed');
    // 7.5rem + 96px + 6rem + 9rem + 280px: the widths plus the flexible column's minimum.
    expect(table.style.minWidth).toBe('calc(7.5rem + 96px + 6rem + 9rem + 280px)');
    expect(container.querySelector('thead th')).toHaveStyle({ width: '7.5rem' });
  });

  it('plans for every flexible column at the largest minimum, since a fixed layout splits the spare width equally', () => {
    const flexible: DataTableColumn<Row>[] = [
      { id: 'id', header: 'Case ID', kind: 'id', width: 120, cell: (r) => r.id },
      { id: 'title', header: 'Title', minWidth: 280, cell: (r) => r.title },
      { id: 'owner', header: 'Owner', cell: () => 'jdoe' },
    ];
    const { container, rerender } = render(
      <DataTable<Row> columns={flexible} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />,
    );
    // Two flexible columns each get half the spare width: both need at least 280px.
    expect(container.querySelector('table')!.style.minWidth).toBe('calc(120px + 2 * max(280px, 8rem))');
    rerender(
      <DataTable<Row>
        columns={[flexible[0], { ...flexible[1], minWidth: undefined }, flexible[2]]}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
      />,
    );
    expect(container.querySelector('table')!.style.minWidth).toBe('calc(120px + 2 * 8rem)');
  });

  it('sizes columns to content (auto layout) when no width is declared', () => {
    const { container } = render(
      <DataTable<Row> columns={autoColumns} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />,
    );
    const table = container.querySelector('table')!;
    expect(table).not.toHaveClass('table-fixed');
    expect(table.style.minWidth).toBe('');
    // Text cells of an auto-layout table wrap as before: no truncation wrapper.
    expect(container.querySelector('[data-truncated-text]')).toBeNull();
  });

  it('truncates plain text cells of a fixed-layout table to one line, with the full value as a title only when cut', () => {
    render(<DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />);
    const cut = screen.getByText('Impossible travel for jdoe');
    const whole = screen.getByText('Phishing link clicked');
    expect(cut).toHaveAttribute('data-truncated-text');
    expect(cut).toHaveClass('truncate');
    // jsdom has no layout: model one cut cell and one that fits.
    Object.defineProperty(cut, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(cut, 'clientWidth', { configurable: true, value: 120 });
    Object.defineProperty(whole, 'scrollWidth', { configurable: true, value: 100 });
    Object.defineProperty(whole, 'clientWidth', { configurable: true, value: 120 });
    fireEvent.pointerEnter(cut);
    fireEvent.pointerEnter(whole);
    expect(cut).toHaveAttribute('title', 'Impossible travel for jdoe');
    expect(whole).not.toHaveAttribute('title');
  });

  it('lets a column opt out of truncation with wrap', () => {
    render(
      <DataTable<Row>
        columns={[{ ...columns[1], wrap: true }, columns[0]]}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
      />,
    );
    expect(screen.getByText('Impossible travel for jdoe')).not.toHaveAttribute('data-truncated-text');
  });

  it('keeps rich cells of a fixed-layout table on one line, clipped sideways only, never cut over the next column', () => {
    const rich: DataTableColumn<Row>[] = [
      {
        id: 'outcome',
        header: 'Outcome',
        width: '6rem',
        cell: (r) => <span className="inline-flex">{`Auto-closed as false positive ${r.id}`}</span>,
        text: (r) => `Auto-closed as false positive (${r.id})`,
      },
      { id: 'badge', header: 'Severity', width: '5rem', cell: () => <span className="inline-flex">High</span> },
      ...columns.slice(1, 2),
    ];
    const { rerender } = render(<DataTable<Row> columns={rich} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />);
    const badge = screen.getByText('Auto-closed as false positive CASE-000001');
    const wrapper = badge.closest('[data-truncated-text]') as HTMLElement;
    expect(wrapper).toHaveAttribute('data-truncated-text', 'rich');
    expect(wrapper.tagName).toBe('DIV');
    // Clipped sideways only (focus rings above and below still show), with the ellipsis.
    expect(wrapper).toHaveClass('overflow-x-clip', 'text-ellipsis', 'whitespace-nowrap');
    expect(wrapper).not.toHaveClass('overflow-hidden');
    // The clip box reaches 4px into the cell padding on every side and gives it back as
    // padding, so a control's focus ring (2px ring, 2px offset) is drawn on all four sides.
    expect(wrapper).toHaveClass('-mx-1', 'px-1', '-my-1', 'py-1');
    // The hover title is the column's plain value while the cell is cut.
    Object.defineProperty(wrapper, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: 80 });
    fireEvent.pointerEnter(wrapper);
    expect(wrapper).toHaveAttribute('title', 'Auto-closed as false positive (CASE-000001)');
    // Without a `text`, the cell's text content is the title.
    const severity = screen.getAllByText('High')[0].closest('[data-truncated-text]') as HTMLElement;
    Object.defineProperty(severity, 'scrollWidth', { configurable: true, value: 90 });
    Object.defineProperty(severity, 'clientWidth', { configurable: true, value: 40 });
    fireEvent.pointerEnter(severity);
    expect(severity).toHaveAttribute('title', 'High');
    // A plain text cell truncates itself in a span.
    expect(screen.getByText('Phishing link clicked')).toHaveAttribute('data-truncated-text', '');
    // An auto-layout table sizes columns to their content and clips nothing.
    rerender(
      <DataTable<Row>
        columns={rich.map(({ width: _width, ...c }) => c)}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
      />,
    );
    expect(screen.getByText('Auto-closed as false positive CASE-000001').closest('[data-truncated-text]')).toBeNull();
  });

  it('signals a cut atomic badge with a trailing fade, measured after render and on hover', async () => {
    const rich: DataTableColumn<Row>[] = [
      {
        id: 'outcome',
        header: 'Outcome',
        width: '6rem',
        cell: (r) => <span style={{ display: 'inline-flex' }}>{`Auto-closed as false positive ${r.id}`}</span>,
        text: (r) => `Auto-closed as false positive (${r.id})`,
      },
      ...columns.slice(1, 2),
    ];
    render(<DataTable<Row> columns={rich} rows={rows.slice(0, 1)} getRowId={(r) => r.id} ariaLabel="Cases" />);
    const badge = screen.getByText('Auto-closed as false positive CASE-000001');
    const wrapper = badge.closest('[data-truncated-text]') as HTMLElement;
    // The fade is a mask on the cut wrapper only.
    expect(wrapper.className).toContain('data-[cut=fade]:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]');
    // jsdom has no layout: model a 240px badge in an 80px content box.
    Object.defineProperty(wrapper, 'scrollWidth', { configurable: true, value: 248 });
    Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: 88 });
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 88, 20));
    vi.spyOn(badge, 'getBoundingClientRect').mockReturnValue(new DOMRect(4, 0, 240, 20));
    // Measured in the batched pass that follows the render, never re-rendering the table.
    await waitFor(() => expect(wrapper).toHaveAttribute('data-cut', 'fade'));
    // The column widens: the badge fits and the signal goes; hover re-measures at once.
    Object.defineProperty(wrapper, 'scrollWidth', { configurable: true, value: 248 });
    Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: 248 });
    fireEvent.pointerEnter(wrapper);
    expect(wrapper).not.toHaveAttribute('data-cut');
    expect(wrapper).not.toHaveAttribute('title');
  });

  it('keeps ids, times, IPs and numbers on one line with tabular figures; numbers align right', () => {
    render(<DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />);
    for (const value of ['CASE-000001', '09:41', '198.51.100.23']) {
      const td = screen.getByText(value).closest('td')!;
      expect(td).toHaveClass('whitespace-nowrap', 'tabular-nums');
      expect(td).not.toHaveClass('text-right');
    }
    const count = screen.getByText('1234').closest('td')!;
    expect(count).toHaveClass('whitespace-nowrap', 'tabular-nums', 'text-right');
    expect(screen.getByRole('columnheader', { name: 'Events' })).toHaveClass('text-right');
    // Words stay proportional.
    expect(screen.getByText('Phishing link clicked').closest('td')).not.toHaveClass('tabular-nums');
    // Ids are set in the identifier face, so "CASE-000001" fits a 120px column whole; the
    // other kinds keep the text face.
    expect(screen.getByText('CASE-000001').closest('td')).toHaveClass('font-mono', 'text-xs');
    expect(screen.getByText('09:41').closest('td')).not.toHaveClass('font-mono');
    expect(screen.getByText('198.51.100.23').closest('td')).not.toHaveClass('font-mono');
  });

  it('on a panel drops its own box and puts the first and last columns on the panel inset', () => {
    const { container } = render(
      <DataTable<Row> columns={autoColumns} rows={rows} getRowId={(r) => r.id} surface="panel" ariaLabel="Cases" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('data-surface', 'panel');
    expect(root.className).not.toMatch(/\bborder\b|rounded-md|bg-card/);
    const firstCell = screen.getByText('Phishing link clicked').closest('td')!;
    const lastCell = screen.getByText('7').closest('td')!;
    expect(firstCell).toHaveClass('pl-4', 'xl:pl-5', '3xl:pl-6');
    expect(lastCell).toHaveClass('pr-4', 'xl:pr-5', '3xl:pr-6');
    const [firstHead] = Array.from(container.querySelectorAll('thead th'));
    expect(firstHead).toHaveClass('xl:pl-5');
  });

  it('keeps the bounded hairline box on the canvas by default', () => {
    const { container } = render(
      <DataTable<Row> columns={autoColumns} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />,
    );
    expect(container.firstElementChild).toHaveClass('rounded-md', 'border', 'bg-card');
  });

  it('replaces the whole table, header row included, with emptyState when there is nothing to list', () => {
    const { container } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={[]}
        getRowId={(r) => r.id}
        ariaLabel="Reports"
        emptyState={<EmptyState state="first-use" title="No reports yet" />}
      />,
    );
    expect(container.querySelector('thead')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText('No reports yet')).toBeInTheDocument();
  });

  it('never says "nothing at all" for an emptied later page: the header, the empty row and the pager stay', () => {
    const { container } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={[]}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
        page={3}
        pageSize={25}
        total={50}
        onPageChange={() => {}}
        empty={<EmptyState state="no-results" title="Nothing on this page" compact />}
        emptyState={<EmptyState state="first-use" title="No cases yet" />}
      />,
    );
    expect(screen.queryByText('No cases yet')).toBeNull();
    expect(container.querySelector('thead')).not.toBeNull();
    expect(screen.getByText('Nothing on this page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
  });

  it('keeps the header with the filtered-empty row (empty), and never shows emptyState while loading', () => {
    const { container, rerender } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={[]}
        getRowId={(r) => r.id}
        ariaLabel="Reports"
        empty={<EmptyState state="no-results" title="No reports match" compact />}
      />,
    );
    expect(container.querySelector('thead')).not.toBeNull();
    expect(screen.getByText('No reports match')).toBeInTheDocument();
    rerender(
      <DataTable<Row>
        columns={autoColumns}
        rows={[]}
        getRowId={(r) => r.id}
        ariaLabel="Reports"
        loading
        emptyState={<EmptyState state="first-use" title="No reports yet" />}
      />,
    );
    expect(screen.queryByText('No reports yet')).toBeNull();
    expect(screen.getByTestId('data-table-initial-loading')).toBeInTheDocument();
  });

  it('pins the first column, after the selection checkbox, with an opaque fill that keeps the row tint', () => {
    render(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
        stickyFirstColumn
        selectable
        selected={[]}
        onSelectedChange={() => {}}
      />,
    );
    const firstCell = screen.getByText('Phishing link clicked').closest('td')!;
    expect(firstCell).toHaveClass('sticky', 'left-10', 'bg-card');
    expect(firstCell.className).toContain('[tr:hover>&]:shadow-');
    const checkboxCell = screen.getByRole('checkbox', { name: 'Select row CASE-000002' }).closest('td')!;
    expect(checkboxCell).toHaveClass('sticky', 'left-0');
    // The other cells scroll.
    expect(screen.getByText('7').closest('td')).not.toHaveClass('sticky');
    // Sticky header cells keep the opaque fill but never take a row hover or selected wash
    // (the header row has neither).
    for (const th of [
      screen.getByRole('columnheader', { name: 'Title' }),
      screen.getByRole('checkbox', { name: 'Select all rows' }).closest('th')!,
    ]) {
      expect(th).toHaveClass('sticky', 'bg-card');
      expect(th.className).not.toContain('tr:hover');
      expect(th.className).not.toContain('data-state=selected');
    }
  });

  it('moves a row accent band onto the sticky first cell, composed with its hover and selected tint', () => {
    const { rerender } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
        stickyFirstColumn
        rowAccent={() => 'critical'}
      />,
    );
    const firstCell = screen.getByText('Phishing link clicked').closest('td')!;
    // A colour the cell's shadow classes compose, never an inline box-shadow (which would
    // beat the hover and selected classes and leave the pinned cell untinted).
    expect(firstCell.style.boxShadow).toBe('');
    expect(firstCell.style.getPropertyValue('--row-accent')).not.toBe('');
    expect(firstCell.className).toContain('shadow-[inset_3px_0_0_0_var(--row-accent,transparent)]');
    expect(firstCell.className).toContain(
      '[tr:hover>&]:shadow-[inset_3px_0_0_0_var(--row-accent,transparent),inset_0_0_0_100vmax_hsl(var(--muted)/0.4)]',
    );
    expect(firstCell.className).toContain(
      '[tr[data-state=selected]>&]:shadow-[inset_3px_0_0_0_var(--row-accent,transparent),inset_0_0_0_100vmax_hsl(var(--accent)/0.6)]',
    );
    expect(firstCell.closest('tr')!.getAttribute('style') ?? '').not.toMatch(/box-shadow/);
    // With a selection column the band moves to the leading (checkbox) cell.
    rerender(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
        stickyFirstColumn
        selectable
        selected={['CASE-000001']}
        onSelectedChange={() => {}}
        rowAccent={() => 'critical'}
      />,
    );
    const checkboxCell = screen.getByRole('checkbox', { name: 'Select row CASE-000001' }).closest('td')!;
    expect(checkboxCell.style.getPropertyValue('--row-accent')).not.toBe('');
    expect(checkboxCell.style.boxShadow).toBe('');
    expect(screen.getByText('Impossible travel for jdoe').closest('td')!.style.getPropertyValue('--row-accent')).toBe('');
  });

  it('shows the right-edge fade only while more columns are scrollable to the right', () => {
    const { container } = render(
      <DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" />,
    );
    const scroller = container.querySelector<HTMLElement>('[data-table-scroll]')!;
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 1200 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(scroller, 'scrollLeft', { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(scroller);
    const fade = screen.getByTestId('data-table-fade-right');
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    expect(fade).toHaveClass('pointer-events-none');
    scroller.scrollLeft = 400;
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId('data-table-fade-right')).toBeNull();
  });

  it('keeps the fade live after the table comes back from its emptyState', () => {
    const empty = <EmptyState state="first-use" title="No cases yet" />;
    const { container, rerender } = render(
      <DataTable<Row> columns={columns} rows={[]} getRowId={(r) => r.id} ariaLabel="Cases" emptyState={empty} />,
    );
    expect(container.querySelector('[data-table-scroll]')).toBeNull();
    rerender(<DataTable<Row> columns={columns} rows={rows} getRowId={(r) => r.id} ariaLabel="Cases" emptyState={empty} />);
    const scroller = container.querySelector<HTMLElement>('[data-table-scroll]')!;
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 1200 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(scroller, 'scrollLeft', { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('data-table-fade-right')).toBeInTheDocument();
    scroller.scrollLeft = 400;
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId('data-table-fade-right')).toBeNull();
  });

  it('hides the pager when everything fits on one page and no page size would change that', () => {
    const { container, rerender } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Sources"
        page={1}
        pageSize={25}
        total={2}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
    expect(container.textContent).not.toMatch(/Page 1 of 1/);

    rerender(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Sources"
        page={1}
        pageSize={2}
        total={40}
        onPageChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
    expect(screen.getByText('Page 1 of 20')).toBeInTheDocument();
  });

  it('keeps the page-size choice when more rows exist than the smallest page size', () => {
    render(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Sources"
        page={1}
        pageSize={100}
        total={30}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Rows per page' })).toBeInTheDocument();
  });

  it('still shows the selection count on a single page', () => {
    const { container } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Sources"
        page={1}
        pageSize={25}
        total={2}
        onPageChange={() => {}}
        selectable
        selected={['CASE-000001']}
        onSelectedChange={() => {}}
      />,
    );
    expect(within(container).getByText('1 selected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('never adds an em dash to Console-authored table copy', () => {
    const { container } = render(
      <DataTable<Row>
        columns={autoColumns}
        rows={rows}
        getRowId={(r) => r.id}
        ariaLabel="Cases"
        page={1}
        pageSize={1}
        total={2}
        onPageChange={() => {}}
        onPageSizeChange={() => {}}
        onRowClick={() => {}}
      />,
    );
    expect(container.textContent).not.toMatch(/[—–]/);
  });
});

describe('richCutSignal', () => {
  /** A rich wrapper with a 4px padding, an 80px content box, and the given children. */
  const wrapperWith = (children: HTMLElement[], scrollWidth: number) => {
    const el = document.createElement('div');
    el.style.paddingRight = '4px';
    children.forEach((child) => el.appendChild(child));
    document.body.appendChild(el);
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 88 });
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 88, 20));
    return el;
  };
  const box = (tag: string, display: string, right: number, text = 'x') => {
    const el = document.createElement(tag);
    el.style.display = display;
    el.textContent = text;
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(4, 0, right - 4, 20));
    return el;
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is null when the content fits', () => {
    expect(richCutSignal(wrapperWith([box('span', 'inline-flex', 60)], 88))).toBeNull();
  });

  it('leaves inline text to the native ellipsis', () => {
    const link = box('a', 'inline', 300, 'demo-hitl-00000539-0001');
    expect(richCutSignal(wrapperWith([link], 300))).toBe('ellipsis');
  });

  it('fades an atomic badge or icon that runs past the content edge, even inside an inline link', () => {
    expect(richCutSignal(wrapperWith([box('span', 'inline-flex', 240)], 248))).toBe('fade');
    const link = box('a', 'inline', 300, '');
    link.appendChild(box('span', 'inline-block', 120));
    expect(richCutSignal(wrapperWith([link], 128))).toBe('fade');
  });

  it('fades a block child whose own content overflows, unless it ellipsises itself', () => {
    const row = box('div', 'flex', 84);
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 200 });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 80 });
    expect(richCutSignal(wrapperWith([row], 208))).toBe('fade');
    const own = box('div', 'block', 84);
    own.style.overflowX = 'hidden';
    own.style.textOverflow = 'ellipsis';
    Object.defineProperty(own, 'scrollWidth', { configurable: true, value: 200 });
    Object.defineProperty(own, 'clientWidth', { configurable: true, value: 80 });
    expect(richCutSignal(wrapperWith([own], 208))).toBe('ellipsis');
  });

  it('skips hidden children', () => {
    expect(richCutSignal(wrapperWith([box('span', 'none', 400), box('a', 'inline', 300)], 300))).toBe('ellipsis');
  });
});

describe('TruncatedText', () => {
  it('uses an explicit full value for a node child and drops the title once the text fits', () => {
    render(
      <TruncatedText fullText="Okta production tenant">
        <span>Okta production tenant</span>
      </TruncatedText>,
    );
    const el = document.querySelector<HTMLElement>('[data-truncated-text]')!;
    Object.defineProperty(el, 'scrollWidth', { configurable: true, writable: true, value: 300 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, writable: true, value: 100 });
    fireEvent.pointerEnter(el);
    expect(el).toHaveAttribute('title', 'Okta production tenant');
    Object.defineProperty(el, 'clientWidth', { configurable: true, writable: true, value: 400 });
    fireEvent.pointerEnter(el);
    expect(el).not.toHaveAttribute('title');
  });
});
