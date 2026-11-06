/**
 * DataTable row names (Round 14, SPEC §4.9.5): `getRowLabel` names a row the way the
 * screen shows it, so the selection checkbox reads "Select CASE-000048" and the row action
 * "Open CASE-000048", never the internal id. Without it the old names stay unchanged.
 * `selectAllLabel` and `rowNoun` name the header checkbox and its announcements the way
 * the page counts what it selects ("Select all cases on this page", "2 cases selected").
 *
 * The right-edge fade measurement (`useOverflowRight`) lives in its own hook module, so a
 * table that is not a DataTable (the Logs sheet) draws the same cue from the same code
 * without pulling DataTable into its route chunk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AnnouncerProvider } from '../announcer';
import { DataTable, type DataTableColumn } from '../DataTable';
import { useOverflowRight } from '@/soc/hooks/useOverflowRight';

type Row = { id: string; number: string; title: string };

const rows: Row[] = [
  { id: 'demo-tune-7f3a', number: 'CASE-000048', title: 'Brute force on vpn-gw-2' },
  { id: 'demo-tune-91bc', number: '', title: 'Unnumbered case' },
];
const columns: DataTableColumn<Row>[] = [{ id: 'title', header: 'Title', cell: (r) => r.title }];

describe('DataTable getRowLabel', () => {
  it('names the selection checkbox and the row action by the row label', () => {
    const onSelectedChange = vi.fn();
    const onOpen = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows.slice(0, 1)}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.number}
        selectable
        selected={[]}
        onSelectedChange={onSelectedChange}
        onRowClick={onOpen}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Select CASE-000048' });
    fireEvent.click(checkbox);
    // Selection still keys on the row id; only the name changed.
    expect(onSelectedChange).toHaveBeenCalledWith(['demo-tune-7f3a']);
    fireEvent.click(screen.getByRole('button', { name: 'Open CASE-000048' }));
    expect(onOpen).toHaveBeenCalledWith(rows[0], 0);
    expect(screen.queryByRole('checkbox', { name: /demo-tune/ })).toBeNull();
  });

  it('falls back to "row <id>" when a row has no label', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.number}
        selectable
        selected={[]}
        onSelectedChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Select CASE-000048' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select row demo-tune-91bc' })).toBeInTheDocument();
  });

  it('names a row that cannot be selected by its label too', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows.slice(0, 1)}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.number}
        selectable
        selected={[]}
        onSelectedChange={vi.fn()}
        isRowSelectable={() => false}
        getRowSelectionDisabledReason={() => 'Sample data cannot be changed'}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Sample data cannot be changed: CASE-000048' });
    expect(checkbox).toBeDisabled();
  });

  it('names the row once in the default reason', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.number}
        selectable
        selected={[]}
        onSelectedChange={vi.fn()}
        isRowSelectable={() => false}
      />,
    );
    // Never "Selection unavailable for CASE-000048: CASE-000048".
    expect(screen.getByRole('checkbox', { name: 'Selection unavailable for CASE-000048' })).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Selection unavailable for row demo-tune-91bc' }),
    ).toBeDisabled();
    for (const checkbox of screen.getAllByRole('checkbox')) {
      const name = checkbox.getAttribute('aria-label') ?? '';
      expect(name.split(/CASE-000048|demo-tune-91bc/).length).toBeLessThanOrEqual(2);
    }
  });

  it('names the header checkbox and the selection announcements the way the page counts', async () => {
    function Harness() {
      const [selected, setSelected] = React.useState<string[]>([]);
      return (
        <AnnouncerProvider>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            getRowLabel={(r) => r.number}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            selectAllLabel="Select all cases on this page"
            rowNoun={{ one: 'case', other: 'cases' }}
          />
        </AnnouncerProvider>
      );
    }
    render(<Harness />);
    const all = screen.getByRole('checkbox', { name: 'Select all cases on this page' });
    fireEvent.click(all);
    expect(await screen.findByText('2 cases selected')).toBeInTheDocument();
    fireEvent.click(all);
    expect(await screen.findByText('All cases deselected')).toBeInTheDocument();
  });

  it('keeps the old names when no label is given', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows.slice(0, 1)}
        getRowId={(r) => r.id}
        selectable
        selected={[]}
        onSelectedChange={vi.fn()}
        onRowClick={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Select row demo-tune-7f3a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open row demo-tune-7f3a' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toBeInTheDocument();
  });
});

/** A probe for the hook: a scroller whose sizes the test sets. */
function Probe({ deps }: { deps: unknown[] }) {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  const more = useOverflowRight(el, deps);
  return (
    <div>
      <div ref={setEl} data-testid="scroller">
        <div />
      </div>
      <output data-testid="more">{more ? 'more' : 'none'}</output>
    </div>
  );
}

function setSizes(el: HTMLElement, sizes: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: sizes.scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: sizes.clientWidth });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: sizes.scrollLeft });
}

describe('useOverflowRight', () => {
  it('is shared from its hook module, so the Logs sheet does not import DataTable', () => {
    const src = path.resolve(__dirname, '..', '..', '..');
    const sheet = fs.readFileSync(path.join(src, 'soc/components/UnifiedLogsSheet.tsx'), 'utf8');
    expect(sheet).toMatch(/from '@\/soc\/hooks\/useOverflowRight'/);
    expect(sheet).not.toMatch(/from '(@\/soc\/components|\.)\/DataTable'/);
  });

  it('reports more content to the right, and none once scrolled to the end', () => {
    const { rerender } = render(<Probe deps={[1]} />);
    const scroller = screen.getByTestId('scroller');
    setSizes(scroller, { scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
    // A change in `deps` (rows or columns) re-measures.
    rerender(<Probe deps={[2]} />);
    expect(screen.getByTestId('more')).toHaveTextContent('more');

    setSizes(scroller, { scrollWidth: 900, clientWidth: 400, scrollLeft: 500 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(screen.getByTestId('more')).toHaveTextContent('none');
  });

  it('reports nothing when the content fits', () => {
    const { rerender } = render(<Probe deps={[1]} />);
    setSizes(screen.getByTestId('scroller'), { scrollWidth: 400, clientWidth: 400, scrollLeft: 0 });
    rerender(<Probe deps={[2]} />);
    expect(screen.getByTestId('more')).toHaveTextContent('none');
  });
});
