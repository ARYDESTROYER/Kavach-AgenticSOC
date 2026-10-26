/**
 * TimeRangePicker — spec (Dash-B). Pins the load-bearing behavior:
 *   - the in-house ES date-math parser resolves relative ranges (now/now-Nu/rounding);
 *   - a range round-trips through the URL query codec (serialize → parse);
 *   - the component renders the current label and offers the auto-refresh options;
 *   - useAutoRefresh honours `off` and pauses on a hidden tab.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook, within } from '@testing-library/react';

import {
  TimeRangePicker,
  parseDateMath,
  resolveRange,
  serializeRange,
  parseRange,
  labelForRange,
  useAutoRefresh,
  PRESETS,
  DEFAULT_RANGE,
  REFRESH_OPTIONS,
  REFRESH_MS,
  type RefreshValue,
  type TimeRange,
} from '../TimeRangePicker';

// A fixed "now" so the date-math assertions are deterministic:
// 2026-07-01T12:00:00.000Z
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('parseDateMath (ES date-math subset)', () => {
  it('resolves the `now` anchor', () => {
    expect(parseDateMath('now', NOW)).toBe(NOW);
  });

  it('resolves relative minus offsets across units', () => {
    expect(parseDateMath('now-15m', NOW)).toBe(NOW - 15 * 60_000);
    expect(parseDateMath('now-1h', NOW)).toBe(NOW - HOUR);
    expect(parseDateMath('now-24h', NOW)).toBe(NOW - 24 * HOUR);
    expect(parseDateMath('now-7d', NOW)).toBe(NOW - 7 * DAY);
    expect(parseDateMath('now-1w', NOW)).toBe(NOW - 7 * DAY);
  });

  it('resolves a plus offset', () => {
    expect(parseDateMath('now+30m', NOW)).toBe(NOW + 30 * 60_000);
  });

  it('applies a trailing rounding op', () => {
    // now-1d rounded to the start of the day (local): should be <= now-1d and a day boundary.
    const start = parseDateMath('now/d', NOW)!;
    const d = new Date(start);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(start).toBeLessThanOrEqual(NOW);
  });

  it('parses an epoch-ms and an ISO absolute anchor', () => {
    expect(parseDateMath(String(NOW), NOW)).toBe(NOW);
    expect(parseDateMath('2026-07-01T12:00:00.000Z', NOW)).toBe(NOW);
  });

  it('returns null on garbage', () => {
    expect(parseDateMath('', NOW)).toBeNull();
    expect(parseDateMath('nowish', NOW)).toBeNull();
    expect(parseDateMath('now-5x', NOW)).toBeNull();
    expect(parseDateMath('not a date', NOW)).toBeNull();
  });
});

describe('resolveRange', () => {
  it('resolves both bounds of a preset', () => {
    const { fromMs, toMs } = resolveRange({ from: 'now-24h', to: 'now', label: 'x' }, NOW);
    expect(fromMs).toBe(NOW - 24 * HOUR);
    expect(toMs).toBe(NOW);
  });

  it('never yields NaN for an unparseable side (falls back)', () => {
    const { fromMs, toMs } = resolveRange({ from: 'garbage', to: 'alsogarbage', label: 'x' }, NOW);
    expect(Number.isNaN(fromMs)).toBe(false);
    expect(Number.isNaN(toMs)).toBe(false);
  });
});

describe('URL codec (serialize/parse round-trip)', () => {
  it('round-trips every preset through query params', () => {
    for (const p of PRESETS) {
      const params = serializeRange(p);
      const back = parseRange(params);
      expect(back.from).toBe(p.from);
      expect(back.to).toBe(p.to);
      expect(back.label).toBe(p.label);
    }
  });

  it('serializes into a provided URLSearchParams without clobbering siblings', () => {
    const params = new URLSearchParams('s=overview');
    serializeRange({ from: 'now-1h', to: 'now', label: 'Last 1 hour' }, params);
    expect(params.get('s')).toBe('overview');
    expect(params.get('from')).toBe('now-1h');
    expect(params.get('to')).toBe('now');
  });

  it('parses from a raw query string (leading ? tolerated)', () => {
    const r = parseRange('?from=now-7d&to=now');
    expect(r.from).toBe('now-7d');
    expect(r.to).toBe('now');
    expect(r.label).toBe('Last 7 days');
  });

  it('falls back to DEFAULT_RANGE when a bound is missing', () => {
    expect(parseRange('from=now-1h')).toEqual(DEFAULT_RANGE);
    expect(parseRange('')).toEqual(DEFAULT_RANGE);
  });

  it('labels a non-preset (custom) range distinctly', () => {
    expect(labelForRange('now-3h', 'now')).toContain('now-3h');
  });
});

describe('useAutoRefresh', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never fires when off', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('off', tick));
    vi.advanceTimersByTime(REFRESH_MS['5m'] * 2);
    expect(tick).not.toHaveBeenCalled();
  });

  it('fires on the chosen cadence when visible', () => {
    vi.useFakeTimers();
    // visible tab
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('30s', tick));
    vi.advanceTimersByTime(REFRESH_MS['30s']);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_MS['30s']);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('maps 5 seconds to exactly 5000ms and does not tick early', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('5s', tick));

    expect(REFRESH_MS['5s']).toBe(5_000);
    vi.advanceTimersByTime(4_999);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('runs Live as a visibility-aware five-second dashboard cadence', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('live', tick));

    expect(REFRESH_MS.live).toBe(5_000);
    vi.advanceTimersByTime(4_999);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does not start when the tab is hidden', () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const tick = vi.fn();
    renderHook(() => useAutoRefresh('30s', tick));
    vi.advanceTimersByTime(REFRESH_MS['30s'] * 3);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('<TimeRangePicker/> render', () => {
  it('shows the current range label on the trigger', () => {
    const range: TimeRange = PRESETS[2]; // Last 24 hours
    render(<TimeRangePicker value={range} onChange={() => {}} />);
    expect(
      screen.getByRole('button', { name: /Time range: Last 24 hours/i }),
    ).toBeInTheDocument();
  });

  it('emits the picked preset from the popover', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={PRESETS[2]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Time range:/i }));
    // Presets render as a labelled GROUP of plain buttons (NOT a listbox/option
    // composite — see the a11y fix), with the active range marked via aria-current.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: /Relative time ranges/i });
    expect(within(group).getByRole('button', { name: /Last 24 hours/i })).toHaveAttribute(
      'aria-current',
      'true',
    );
    const opt = within(group).getByRole('button', { name: /Last 7 days/i });
    fireEvent.click(opt);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ from: 'now-7d', to: 'now' });
  });

  it('exposes the auto-refresh selector with an accessible name when wired', () => {
    render(
      <TimeRangePicker
        value={PRESETS[2]}
        onChange={() => {}}
        refresh="off"
        onRefreshChange={() => {}}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Auto-refresh interval: Off' });
    expect(trigger).toBeInTheDocument();
    // The cadence stays visible at narrow widths; the separate manual-refresh
    // button owns the only refresh glyph.
    expect(trigger).toHaveClass('w-24');
    expect(trigger).not.toHaveClass('sm:w-36');
    // default option set exists
    expect(REFRESH_OPTIONS.map((o) => o.value)).toContain('off');
  });

  it('offers and emits the accessible 5-second refresh cadence', () => {
    const onRefreshChange = vi.fn();
    render(
      <TimeRangePicker
        value={PRESETS[2]}
        onChange={() => {}}
        refresh="off"
        onRefreshChange={onRefreshChange}
      />,
    );

    fireEvent.click(
      screen.getByRole('combobox', { name: 'Auto-refresh interval: Off' }),
    );
    const fiveSeconds = screen.getByRole('option', { name: '5 seconds' });
    expect(fiveSeconds).toBeInTheDocument();
    fireEvent.click(fiveSeconds);
    expect(onRefreshChange).toHaveBeenCalledWith('5s');
  });

  it.each([
    ['5s', '5 seconds', '5 sec'],
    ['30s', '30 seconds', '30 sec'],
    ['1m', '1 minute', '1 min'],
    ['5m', '5 minutes', '5 min'],
  ] as const)(
    'shows %s as compact trigger copy while retaining the full accessible label',
    (refresh, fullLabel, compactLabel) => {
      render(
        <TimeRangePicker
          value={PRESETS[2]}
          onChange={() => {}}
          refresh={refresh as RefreshValue}
          onRefreshChange={() => {}}
        />,
      );

      const trigger = screen.getByRole('combobox', {
        name: `Auto-refresh interval: ${fullLabel}`,
      });
      expect(trigger).toHaveTextContent(compactLabel);
      expect(trigger).not.toHaveTextContent(fullLabel);
    },
  );

  it('offers Live directly below Off with one pulse and no duplicate refresh glyph', () => {
    const onRefreshChange = vi.fn();
    const { rerender, container } = render(
      <TimeRangePicker
        value={PRESETS[2]}
        onChange={() => {}}
        refresh="off"
        onRefreshChange={onRefreshChange}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Auto-refresh interval: Off' }));
    const live = screen.getByRole('option', { name: 'Live' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Off',
      'Live',
      '5 seconds',
      '30 seconds',
      '1 minute',
      '5 minutes',
    ]);
    fireEvent.click(live);
    expect(onRefreshChange).toHaveBeenCalledWith('live');
    expect(REFRESH_OPTIONS[1]?.value).toBe('live');
    expect(REFRESH_OPTIONS[2]?.value).toBe('5s');

    rerender(
      <TimeRangePicker
        value={PRESETS[2]}
        onChange={() => {}}
        refresh="live"
        onRefreshChange={onRefreshChange}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Auto-refresh interval: Live' });
    expect(trigger).toBeInTheDocument();
    const pulse = trigger.querySelector('.animate-pulse.bg-success');
    expect(pulse).toHaveClass('block', 'size-2');
    expect(pulse?.parentElement).toHaveClass('!inline-flex');
    expect(trigger.querySelectorAll('.animate-pulse.bg-success')).toHaveLength(1);
    expect(trigger.querySelector('.lucide-refresh-cw')).toBeNull();
    expect(container.querySelectorAll('.animate-pulse.bg-success')).toHaveLength(1);
  });
});
