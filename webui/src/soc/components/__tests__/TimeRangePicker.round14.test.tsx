/**
 * TimeRangePicker, Round 14 (SPEC §4.9.2, C8): the one page-level time control takes a
 * page's own `presets` and `refreshOptions`; the codec names a page's ranges.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import {
  DEFAULT_RANGE,
  NARROW_VIEWPORT_QUERY,
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

/**
 * Tailwind's breakpoint rules are not loaded under jsdom, so a test names the width it
 * reads at: below `sm` the `hidden` full label is display: none, from `sm` up the
 * `sm:hidden` short one is, and the picker's own `sm` media query answers to match.
 * Returns the cleanup.
 */
function atWidth(width: 'phone' | 'desktop'): () => void {
  const style = document.createElement('style');
  style.textContent = width === 'phone' ? '.hidden { display: none; }' : '.sm\\:hidden { display: none; }';
  document.head.appendChild(style);
  const matchMedia = window.matchMedia;
  window.matchMedia = (query: string) => {
    const list = matchMedia.call(window, query);
    return query === NARROW_VIEWPORT_QUERY
      ? { ...list, media: query, matches: width === 'phone', addEventListener: () => {}, removeEventListener: () => {} }
      : list;
  };
  return () => {
    style.remove();
    window.matchMedia = matchMedia;
  };
}

describe('TimeRangePicker trigger fits its container (closing QA qa2-02)', () => {
  const LINKED: TimeRange = {
    from: 'linked',
    to: 'now',
    label: '2026-11-02 00:00:00 → 2026-11-04 13:46:55 UTC',
    shortLabel: 'Nov 2 00:00 → Nov 4 13:46 UTC',
  };

  it('shrinks and truncates its label instead of running past a phone gutter', () => {
    render(<TimeRangePicker value={PRESETS[2]} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Time range: Last 24 hours' });
    expect(trigger).toHaveClass('min-w-0', 'max-w-full');
    const label = trigger.querySelector('span:not(.sr-only)');
    expect(label).toHaveTextContent('Last 24 hours');
    expect(label).toHaveClass('min-w-0', 'truncate');
    // One label, no tooltip and no description: nothing is shortened.
    expect(trigger.querySelectorAll('[data-range-label]')).toHaveLength(0);
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('shows a long range’s short label below sm and the whole range from sm up', () => {
    render(<TimeRangePicker value={LINKED} onChange={vi.fn()} presets={[LINKED, ...PRESETS]} size="sm" chrome="command" />);
    const trigger = screen.getByRole('button', { name: /^Time range: / });
    expect(trigger.querySelector('[data-range-label="short"]')).toHaveTextContent(LINKED.shortLabel!);
    expect(trigger.querySelector('[data-range-label="short"]')).toHaveClass('sm:hidden');
    expect(trigger.querySelector('[data-range-label="full"]')).toHaveTextContent(LINKED.label);
    expect(trigger.querySelector('[data-range-label="full"]')).toHaveClass('hidden', 'sm:block');
    // The menu keeps the full wording.
    fireEvent.click(trigger);
    expect(within(screen.getByRole('group', { name: 'Relative time ranges' })).getByRole('button', { name: new RegExp(LINKED.label) })).toBeInTheDocument();
  });

  it('is named from the label it shows, the whole range its description only below sm (WCAG 2.5.3 Label in Name)', () => {
    // Below sm a voice user reads "Nov 2 00:00 → …" and must be able to say it: the name
    // was "Time range: 2026-11-02 00:00:00 → …", which does not contain the shown words.
    const phone = atWidth('phone');
    try {
      const { unmount } = render(<TimeRangePicker value={LINKED} onChange={vi.fn()} size="sm" chrome="command" />);
      const trigger = screen.getByRole('button', { name: `Time range: ${LINKED.shortLabel}` });
      expect(trigger).not.toHaveAttribute('aria-label');
      expect(trigger).toHaveAccessibleDescription(LINKED.label);
      expect(trigger).toHaveAttribute('title', LINKED.label);
      unmount();
    } finally {
      phone();
    }
    const desktop = atWidth('desktop');
    try {
      render(<TimeRangePicker value={LINKED} onChange={vi.fn()} size="sm" chrome="command" />);
      // From sm up the trigger shows and is named from the whole range: a description
      // would say it a second time on every focus, and so would a title (it becomes the
      // description when it is not the name), which would also only repeat the visible
      // text.
      const trigger = screen.getByRole('button', { name: `Time range: ${LINKED.label}` });
      expect(trigger).not.toHaveAttribute('aria-describedby');
      expect(trigger).not.toHaveAttribute('title');
      expect(trigger).toHaveAccessibleDescription('');
    } finally {
      desktop();
    }
  });

  it('adds and drops the description and tooltip as the viewport crosses sm', () => {
    let phone = false;
    const listeners = new Set<() => void>();
    const matchMedia = window.matchMedia;
    window.matchMedia = (query: string) => {
      const list = matchMedia.call(window, query);
      if (query !== NARROW_VIEWPORT_QUERY) return list;
      return {
        ...list,
        media: query,
        get matches() {
          return phone;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      } as MediaQueryList;
    };
    const cross = (next: boolean) => {
      phone = next;
      act(() => listeners.forEach((listener) => listener()));
    };
    try {
      render(<TimeRangePicker value={LINKED} onChange={vi.fn()} size="sm" chrome="command" />);
      const trigger = screen.getByRole('button', { name: /^Time range: / });
      expect(trigger).not.toHaveAttribute('aria-describedby');
      expect(trigger).not.toHaveAttribute('title');
      cross(true);
      expect(trigger).toHaveAccessibleDescription(LINKED.label);
      expect(trigger).toHaveAttribute('title', LINKED.label);
      cross(false);
      expect(trigger).not.toHaveAttribute('aria-describedby');
      expect(trigger).not.toHaveAttribute('title');
      expect(trigger).toHaveAccessibleDescription('');
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('keeps the plain trigger named by its content, and the command abbreviation by its whole wording', () => {
    const { unmount } = render(<TimeRangePicker value={PRESETS[3]} onChange={vi.fn()} />);
    const plain = screen.getByRole('button', { name: 'Time range: Last 7 days' });
    expect(plain).not.toHaveAttribute('aria-label');
    expect(plain.querySelector('.sr-only')).toHaveTextContent('Time range:');
    unmount();
    // "Last 7d" on the command chrome keeps its explicit whole-wording name (a known gap,
    // kept until every masthead's control is renamed together).
    render(<TimeRangePicker value={PRESETS[3]} onChange={vi.fn()} chrome="command" />);
    const command = screen.getByRole('button', { name: 'Time range: Last 7 days' });
    expect(command).toHaveAttribute('aria-label', 'Time range: Last 7 days');
    expect(command).toHaveTextContent('Last 7d');
    expect(command).not.toHaveAttribute('aria-describedby');
  });

  it('ignores a short label that says nothing shorter', () => {
    render(<TimeRangePicker value={{ ...PRESETS[2], shortLabel: PRESETS[2].label }} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Time range: Last 24 hours' });
    expect(trigger.querySelectorAll('[data-range-label]')).toHaveLength(0);
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });
});
