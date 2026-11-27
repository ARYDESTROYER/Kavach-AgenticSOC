/**
 * TimeRangePicker, Round 14 (SPEC §4.9.2, C8): the one page-level time control takes a
 * page's own `presets` and `refreshOptions`; the codec names a page's ranges; the trigger's
 * accessible name starts with the words it shows (WCAG 2.5.3 Label in Name).
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
  timeRangeTriggerName,
  type TimeRange,
} from '../TimeRangePicker';

const ANALYTICS: TimeRange[] = PRESETS.filter((p) => ['now-24h', 'now-7d', 'now-30d'].includes(p.from));
const FOUR_HOURS: TimeRange = { from: 'now-4h', to: 'now', label: 'Last 4 hours' };

describe('TimeRangePicker presets', () => {
  it('offers only the page’s ranges, in order', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={ANALYTICS[0]} onChange={onChange} presets={ANALYTICS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Last 24 hours, time range' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Last 4 hours, time range' }));
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
 * The words a sighted user reads on the trigger: its text, less what CSS hides
 * (display: none) and screen reader text (`.sr-only`).
 */
function visibleText(element: Element): string {
  let text = '';
  element.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
    } else if (
      node instanceof Element &&
      !node.classList.contains('sr-only') &&
      window.getComputedStyle(node).display !== 'none'
    ) {
      text += visibleText(node);
    }
  });
  return text.trim();
}

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
    const trigger = screen.getByRole('button', { name: 'Last 24 hours, time range' });
    expect(trigger).toHaveClass('min-w-0', 'max-w-full');
    const label = trigger.querySelector('span');
    expect(label).toHaveTextContent('Last 24 hours');
    expect(label).toHaveClass('min-w-0', 'truncate');
    // One label, no tooltip and no description: nothing is shortened.
    expect(trigger.querySelectorAll('[data-range-label]')).toHaveLength(0);
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('shows a long range’s short label below sm and the whole range from sm up', () => {
    render(<TimeRangePicker value={LINKED} onChange={vi.fn()} presets={[LINKED, ...PRESETS]} size="sm" chrome="command" />);
    const trigger = screen.getByRole('button', { name: /, time range$/ });
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
      const trigger = screen.getByRole('button', { name: `${LINKED.shortLabel}, time range` });
      expect(visibleText(trigger)).toBe(LINKED.shortLabel);
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
      const trigger = screen.getByRole('button', { name: `${LINKED.label}, time range` });
      expect(visibleText(trigger)).toBe(LINKED.label);
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
      const trigger = screen.getByRole('button', { name: `${LINKED.label}, time range` });
      expect(trigger).not.toHaveAttribute('aria-describedby');
      expect(trigger).not.toHaveAttribute('title');
      cross(true);
      // The name follows the label on screen across the edge, with the whole range as
      // the description and tooltip below it.
      expect(trigger).toHaveAccessibleName(`${LINKED.shortLabel}, time range`);
      expect(trigger).toHaveAccessibleDescription(LINKED.label);
      expect(trigger).toHaveAttribute('title', LINKED.label);
      cross(false);
      expect(trigger).toHaveAccessibleName(`${LINKED.label}, time range`);
      expect(trigger).not.toHaveAttribute('aria-describedby');
      expect(trigger).not.toHaveAttribute('title');
      expect(trigger).toHaveAccessibleDescription('');
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('names the command abbreviation by the words it shows, the whole wording its description and tooltip', () => {
    const { unmount } = render(<TimeRangePicker value={PRESETS[3]} onChange={vi.fn()} />);
    const plain = screen.getByRole('button', { name: 'Last 7 days, time range' });
    expect(plain).toHaveTextContent(/^Last 7 days$/);
    expect(plain).not.toHaveAttribute('aria-describedby');
    expect(plain).not.toHaveAttribute('title');
    unmount();
    // "Last 7d" on the command chrome: a voice user says "click Last 7d", so the name
    // starts with it (it was "Time range: Last 7 days", which does not contain "Last 7d").
    render(<TimeRangePicker value={PRESETS[3]} onChange={vi.fn()} chrome="command" />);
    const command = screen.getByRole('button', { name: 'Last 7d, time range' });
    expect(command).toHaveTextContent(/^Last 7d$/);
    expect(command).toHaveAccessibleDescription('Last 7 days');
    expect(command).toHaveAttribute('title', 'Last 7 days');
  });

  it('ignores a short label that says nothing shorter', () => {
    render(<TimeRangePicker value={{ ...PRESETS[2], shortLabel: PRESETS[2].label }} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Last 24 hours, time range' });
    expect(trigger.querySelectorAll('[data-range-label]')).toHaveLength(0);
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });
});

describe('TimeRangePicker trigger name starts with its visible label (WCAG 2.5.3 Label in Name)', () => {
  // A speech-input user says the words on the trigger ("click Last 24h"), so its
  // accessible name starts with them exactly, then says what they are. Where the trigger
  // shows other words for the range, the whole range stays its description and tooltip.
  const CUSTOM: TimeRange = { from: 'now-3d', to: 'now', label: labelForRange('now-3d', 'now') };
  const LINKED: TimeRange = {
    from: '2026-11-02T00:00:00Z',
    to: '2026-11-04T13:46:55Z',
    label: '2026-11-02 00:00:00 → 2026-11-04 13:46:55 UTC',
    shortLabel: 'Nov 2 00:00 → Nov 4 13:46 UTC',
  };
  // What each chrome shows for every shared preset and a custom range.
  const SHOWN: Record<'default' | 'command', string[]> = {
    default: ['Last 15 minutes', 'Last 1 hour', 'Last 24 hours', 'Last 7 days', 'Last 30 days', 'now-3d → now'],
    command: ['Last 15 minutes', 'Last 1h', 'Last 24h', 'Last 7d', 'Last 30d', 'now-3d → now'],
  };

  function expectLabelInName(range: TimeRange, shown: string) {
    const trigger = screen.getByRole('button', { name: /, time range$/ });
    expect(visibleText(trigger)).toBe(shown);
    expect(trigger).toHaveAccessibleName(timeRangeTriggerName(shown));
    expect(timeRangeTriggerName(shown).startsWith(shown)).toBe(true);
    if (shown === range.label) {
      expect(trigger).toHaveAccessibleDescription('');
      expect(trigger).not.toHaveAttribute('title');
    } else {
      expect(trigger).toHaveAccessibleDescription(range.label);
      expect(trigger).toHaveAttribute('title', range.label);
    }
  }

  for (const chrome of ['default', 'command'] as const) {
    it(`holds for every preset and a custom range on the ${chrome} chrome`, () => {
      [...PRESETS, CUSTOM].forEach((range, index) => {
        const { unmount } = render(<TimeRangePicker value={range} onChange={vi.fn()} chrome={chrome} />);
        expectLabelInName(range, SHOWN[chrome][index]);
        unmount();
      });
    });

    it(`holds for a long range's short and full forms on the ${chrome} chrome`, () => {
      for (const width of ['phone', 'desktop'] as const) {
        const restore = atWidth(width);
        try {
          const { unmount } = render(<TimeRangePicker value={LINKED} onChange={vi.fn()} chrome={chrome} />);
          expectLabelInName(LINKED, width === 'phone' ? LINKED.shortLabel! : LINKED.label);
          unmount();
        } finally {
          restore();
        }
      }
    });
  }

  it('reads "Last 24h, time range" on the command chrome', () => {
    render(<TimeRangePicker value={DEFAULT_RANGE} onChange={vi.fn()} chrome="command" />);
    expect(screen.getByRole('button', { name: 'Last 24h, time range' })).toHaveAccessibleDescription('Last 24 hours');
  });
});
