/**
 * FilterBar, the one filter layout (Round 14, SPEC §4.9.2): a labelled group (never a
 * toolbar), the search, at most three primary filters, "More filters" with the active
 * count, removable chips with focus kept on the page, "Clear all", and below 768px one
 * "Filters (n)" button that opens a bottom sheet with every filter labelled.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { FilterBar, type FilterBarFilter, type FilterChip } from '../FilterBar';

const PHONE = '(max-width: 767.98px)';

/** matchMedia that reports `matches` for the phone query. */
function mockViewport(phone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === PHONE,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function select(name: string) {
  return function Control({ placement }: { placement: 'bar' | 'menu' }) {
    return (
      <button type="button" aria-label={`Filter by ${name.toLowerCase()}`} data-placement={placement}>
        {`All ${name.toLowerCase()}`}
      </button>
    );
  };
}

const FILTERS: FilterBarFilter[] = [
  { id: 'status', label: 'Status', control: (ctx) => React.createElement(select('Status'), ctx), active: true },
  { id: 'severity', label: 'Severity', control: (ctx) => React.createElement(select('Severity'), ctx) },
  { id: 'assignee', label: 'Assignee', control: (ctx) => React.createElement(select('Assignee'), ctx) },
  { id: 'disposition', label: 'Disposition', control: (ctx) => React.createElement(select('Disposition'), ctx), active: true },
  { id: 'time', label: 'Time', control: (ctx) => React.createElement(select('Time'), ctx) },
];

function Harness({
  initialChips = ['Status: Active', 'Disposition: True positive', 'Tag: vpn'],
  onClearAll,
}: {
  initialChips?: string[];
  onClearAll?: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [chips, setChips] = React.useState(initialChips);
  const chipList: FilterChip[] = chips.map((label) => ({
    id: label,
    label,
    onRemove: () => setChips((all) => all.filter((c) => c !== label)),
  }));
  return (
    <FilterBar
      aria-label="Case filters"
      search={{
        value: query,
        onChange: setQuery,
        label: 'Search cases',
        placeholder: 'Search by ID, title, entity, rule or tag',
      }}
      // A filter is active while its chip is shown (the page derives both from one state).
      filters={FILTERS.map((f) => ({ ...f, active: chips.some((c) => c.startsWith(`${f.label}:`)) }))}
      chips={chipList}
      onClearAll={() => {
        setChips([]);
        onClearAll?.();
      }}
      meta={<span>{`${chips.length} active`}</span>}
      end={<button type="button">Columns</button>}
    />
  );
}

describe('FilterBar', () => {
  it('is a labelled group, never a toolbar', () => {
    mockViewport(false);
    render(<Harness />);
    expect(screen.getByRole('group', { name: 'Case filters' })).toHaveAttribute('data-filter-bar', 'plain');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('puts the search, the first three filters and More filters in the bar', () => {
    mockViewport(false);
    render(<Harness />);
    const search = screen.getByRole('searchbox', { name: 'Search cases' });
    expect(search).toHaveAttribute('placeholder', 'Search by ID, title, entity, rule or tag');
    fireEvent.change(search, { target: { value: 'vpn' } });
    expect(search).toHaveValue('vpn');

    for (const name of ['status', 'severity', 'assignee']) {
      expect(screen.getByRole('button', { name: `Filter by ${name}` })).toHaveAttribute('data-placement', 'bar');
    }
    expect(screen.queryByRole('button', { name: 'Filter by disposition' })).toBeNull();
    // One of the two filters behind More filters is active.
    const more = screen.getByRole('button', { name: 'More filters 1 active' });
    expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(more);
    // The popup the button opens is named.
    expect(screen.getByRole('dialog', { name: 'More filters' })).toBeInTheDocument();
    const disposition = screen.getByRole('group', { name: 'Disposition' });
    expect(within(disposition).getByRole('button', { name: 'Filter by disposition' })).toHaveAttribute(
      'data-placement',
      'menu',
    );
    expect(screen.getByRole('group', { name: 'Time' })).toBeInTheDocument();
  });

  it('never puts more than three filters in the bar', () => {
    mockViewport(false);
    render(<FilterBar aria-label="Filters" filters={FILTERS} primaryCount={5} />);
    expect(screen.queryByRole('button', { name: 'Filter by disposition' })).toBeNull();
    expect(screen.getByRole('button', { name: /More filters/ })).toBeInTheDocument();
  });

  it('removes a chip and moves focus to the next chip, then the search when none is left', () => {
    mockViewport(false);
    render(<Harness />);
    const list = screen.getByRole('list', { name: 'Active filters' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Disposition: True positive' }));
    expect(screen.queryByRole('button', { name: 'Remove filter: Disposition: True positive' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove filter: Tag: vpn' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Tag: vpn' }));
    expect(screen.getByRole('button', { name: 'Remove filter: Status: Active' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Status: Active' }));
    expect(screen.getByRole('searchbox', { name: 'Search cases' })).toHaveFocus();
  });

  it('clears every filter with Clear all and keeps focus on the search', () => {
    mockViewport(false);
    const onClearAll = vi.fn();
    render(<Harness onClearAll={onClearAll} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('list', { name: 'Active filters' })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search cases' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('keeps the trailing note and controls', () => {
    mockViewport(false);
    render(<Harness />);
    expect(screen.getByText('3 active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
  });

  it('on a phone shows the search and one Filters button that opens every filter in a sheet', () => {
    mockViewport(true);
    render(<Harness />);
    expect(screen.getByRole('searchbox', { name: 'Search cases' })).toHaveAttribute('placeholder', 'Search cases');
    expect(screen.queryByRole('button', { name: 'Filter by status' })).toBeNull();
    expect(screen.queryByRole('button', { name: /More filters/ })).toBeNull();

    // Three chips are active.
    const trigger = screen.getByRole('button', { name: 'Filters 3 active' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    for (const label of ['Status', 'Severity', 'Assignee', 'Disposition', 'Time']) {
      expect(within(sheet).getByRole('group', { name: label })).toBeInTheDocument();
    }
    expect(within(sheet).getByRole('button', { name: 'Filter by status' })).toHaveAttribute('data-placement', 'menu');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
  });

  it('on a phone clears from the sheet and keeps focus inside it, on Done', () => {
    mockViewport(true);
    const onClearAll = vi.fn();
    render(<Harness onClearAll={onClearAll} />);
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    act(() => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Clear all' }));
    });
    expect(onClearAll).toHaveBeenCalledTimes(1);
    // Never the search behind the modal sheet, which assistive technology cannot reach.
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it('without a search, removing the last chip moves focus to the first control in the bar', () => {
    mockViewport(false);
    function NoSearch() {
      const [chips, setChips] = React.useState(['Status: Active']);
      return (
        <FilterBar
          aria-label="Case filters"
          filters={FILTERS.slice(0, 2)}
          chips={chips.map((label) => ({ id: label, label, onRemove: () => setChips([]) }))}
        />
      );
    }
    render(<NoSearch />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Status: Active' }));
    expect(screen.getByRole('button', { name: 'Filter by status' })).toHaveFocus();
  });

  it('with nothing else to take it, Clear all leaves focus on the bar itself, never the page body', () => {
    mockViewport(false);
    function Bare() {
      const [active, setActive] = React.useState(true);
      return <FilterBar aria-label="Log filters" activeCount={active ? 2 : 0} onClearAll={() => setActive(false)} />;
    }
    render(<Bare />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    const bar = screen.getByRole('group', { name: 'Log filters' });
    expect(bar).toHaveFocus();
    expect(bar).toHaveAttribute('tabindex', '-1');
  });

  it('on a bar that counts active filters without chips, Clear all hands focus on once the page clears them', () => {
    mockViewport(false);
    function FiltersOnly() {
      const [active, setActive] = React.useState(true);
      return (
        <FilterBar
          aria-label="Case filters"
          search={{ value: '', onChange: () => {}, label: 'Search cases' }}
          filters={FILTERS.slice(0, 2).map((f, i) => ({ ...f, active: active && i === 0 }))}
          onClearAll={() => setActive(false)}
        />
      );
    }
    render(<FiltersOnly />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('searchbox', { name: 'Search cases' })).toHaveFocus();
  });

  it('never steals focus later when the page has not cleared anything', () => {
    mockViewport(false);
    function Stubborn() {
      const [tick, setTick] = React.useState(0);
      return (
        <>
          <FilterBar
            aria-label="Case filters"
            search={{ value: '', onChange: () => {}, label: 'Search cases' }}
            activeCount={1}
            onClearAll={() => {}}
          />
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            {`Elsewhere ${tick}`}
          </button>
        </>
      );
    }
    render(<Stubborn />);
    const clear = screen.getByRole('button', { name: 'Clear all' });
    clear.focus();
    fireEvent.click(clear);
    // Nothing changed: focus stays where the reader left it.
    expect(clear).toHaveFocus();
    const elsewhere = screen.getByRole('button', { name: /Elsewhere/ });
    elsewhere.focus();
    fireEvent.click(elsewhere);
    expect(screen.getByRole('button', { name: 'Elsewhere 1' })).toHaveFocus();
  });

  it('draws the canvas band only when asked, and the material when sticky', () => {
    mockViewport(false);
    const { rerender } = render(<FilterBar aria-label="Filters" variant="band" />);
    const bar = screen.getByRole('group', { name: 'Filters' });
    expect(bar).toHaveClass('border-y', 'py-2');
    rerender(<FilterBar aria-label="Filters" sticky />);
    expect(screen.getByRole('group', { name: 'Filters' })).toHaveClass('sticky', 'material-surface', 'border-y-0');
  });

  it('still lays out free-form controls passed as children', () => {
    mockViewport(false);
    render(
      <FilterBar aria-label="Log source filters">
        <button type="button">Filter</button>
      </FilterBar>,
    );
    expect(
      within(screen.getByRole('group', { name: 'Log source filters' })).getByRole('button', { name: 'Filter' }),
    ).toBeInTheDocument();
  });

  it('never shows an em dash in its own copy', () => {
    mockViewport(false);
    const { container } = render(<Harness />);
    expect(container.textContent).not.toMatch(/[—–]/);
  });
});
