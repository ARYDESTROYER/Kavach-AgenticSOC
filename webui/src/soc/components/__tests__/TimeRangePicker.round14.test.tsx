/**
 * TimeRangePicker, Round 14 (SPEC §4.9.2, C8): the one page-level time control takes a
 * page's own `presets` and `refreshOptions`; the codec names a page's ranges.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import {
  DEFAULT_RANGE,
  PRESETS,
  TimeRangePicker,
  labelForRange,
  parseRange,
  type TimeRange,
} from '../TimeRangePicker';

const ANALYTICS: TimeRange[] = PRESETS.filter((p) => ['now-24h', 'now-7d', 'now-30d'].includes(p.from));
const FOUR_HOURS: TimeRange = { from: 'now-4h', to: 'now', label: 'Last 4 hours' };

describe('TimeRangePicker presets', () => {
  it('offers only the page’s ranges, in order', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={ANALYTICS[0]} onChange={onChange} presets={ANALYTICS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Time range: Last 24 hours' }));
    const group = screen.getByRole('group', { name: 'Relative time ranges' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Last 24 hoursnow-24h',
      'Last 7 daysnow-7d',
      'Last 30 daysnow-30d',
    ]);
    fireEvent.click(within(group).getByRole('button', { name: /Last 30 days/ }));
    expect(onChange).toHaveBeenCalledWith({ from: 'now-30d', to: 'now', label: 'Last 30 days' });
  });

  it('accepts a range that is not in the shared list', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={FOUR_HOURS} onChange={onChange} presets={[PRESETS[1], FOUR_HOURS, PRESETS[2]]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Time range: Last 4 hours' }));
    const current = within(screen.getByRole('group', { name: 'Relative time ranges' })).getByRole('button', {
      name: /Last 4 hours/,
    });
    expect(current).toHaveAttribute('aria-current', 'true');
  });
});

describe('TimeRangePicker refreshOptions', () => {
  it('offers only the page’s cadences, in the shared order', () => {
    render(
      <TimeRangePicker
        value={DEFAULT_RANGE}
        onChange={() => {}}
        refresh="off"
        onRefreshChange={() => {}}
        refreshOptions={['live', 'off']}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Auto-refresh interval: Off' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Off', 'Live']);
  });

  it('keeps the current cadence selectable even when the page does not offer it', () => {
    render(
      <TimeRangePicker
        value={DEFAULT_RANGE}
        onChange={() => {}}
        refresh="1m"
        onRefreshChange={() => {}}
        refreshOptions={['off', 'live']}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Auto-refresh interval: 1 minute' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Off', 'Live', '1 minute']);
  });
});

describe('range codec with a page’s presets', () => {
  it('names a page range and falls back to the shared list, then the raw pair', () => {
    expect(labelForRange('now-4h', 'now', [FOUR_HOURS])).toBe('Last 4 hours');
    expect(labelForRange('now-7d', 'now', [FOUR_HOURS])).toBe('Last 7 days');
    expect(labelForRange('now-3d', 'now', [FOUR_HOURS])).toBe('now-3d → now');
  });

  it('parses with the page’s presets and its own fallback', () => {
    expect(parseRange('?from=now-4h&to=now', [FOUR_HOURS])).toEqual(FOUR_HOURS);
    expect(parseRange('', ANALYTICS, ANALYTICS[1])).toEqual(ANALYTICS[1]);
    // The default arguments keep the pre-Round-14 behaviour.
    expect(parseRange('')).toEqual(DEFAULT_RANGE);
  });
});
