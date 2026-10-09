/**
 * HistoryRail — ported from the pre-revamp `ChatHistoryRail` suite and extended for the
 * revamp (SPEC §10.2): grouping (Pinned, Today, Yesterday, Previous 7 / 30 days,
 * month) labelled as groups rather than headings, one-line rows with the full
 * accessible name, `aria-current` and an exact-date tooltip, roving arrow-key focus
 * (only from rows, with a tab stop that survives a shorter list), inline rename
 * (IME-safe, focus returns to the row), the row menu (Pin, Open report only with a
 * report and not while another thread runs, Export, Delete locked for the running
 * thread), shortcut hints, server search with snippets, the retention footer, honest
 * loading / retryable error / empty states, and axe.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatConversationSearchHit, ChatConversationSummary } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import {
  HistoryRail,
  HistoryStrip,
  distinctSnippet,
  groupConversations,
  shortAge,
  type HistoryRailProps,
} from '../HistoryRail';

expect.extend(toHaveNoViolations);

function summary(id: string, title: string, updatedAt: string, extra: Partial<ChatConversationSummary> = {}): ChatConversationSummary {
  return { id, title, preview: `${title} preview`, created_at: updatedAt, updated_at: updatedAt, message_count: 2, ...extra };
}

function daysAgo(days: number, hour = 12): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

const ROWS = [
  summary('today', 'Investigate sign-ins', daysAgo(0)),
  summary('yesterday', 'Review endpoint alert', daysAgo(1), { message_count: 4 }),
  summary('week', 'Weekly hunt', daysAgo(4)),
  summary('month', 'Phishing wave', daysAgo(20), { report_id: 'r-1' }),
  summary('pinned', 'Ransomware playbook', daysAgo(90), { pinned: true }),
];

function renderRail(overrides: Partial<HistoryRailProps> = {}) {
  const props: HistoryRailProps = {
    conversations: ROWS,
    activeId: 'today',
    busy: false,
    loading: false,
    error: null,
    retention: { limit: 50, truncated: false, total: ROWS.length, showNote: false },
    search: { query: '', setQuery: vi.fn(), results: null, searching: false, error: null, openHit: vi.fn() },
    onRetry: vi.fn(),
    onNewChat: vi.fn(),
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onOpenReport: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  const view = render(
    <TooltipProvider>
      <HistoryRail {...props} />
    </TooltipProvider>,
  );
  return { ...view, props };
}

describe('groupConversations / shortAge', () => {
  it('groups pinned first, then recency buckets, then months', () => {
    const now = new Date();
    const groups = groupConversations(
      [
        ...ROWS,
        summary('old', 'Old review', new Date(now.getFullYear() - 1, 2, 10).toISOString()),
        summary('bad', 'No date', 'not-a-date'),
      ],
      now,
    );
    const labels = groups.map((g) => g.label);
    expect(labels.slice(0, 5)).toEqual(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days']);
    expect(labels).toContain(new Date(now.getFullYear() - 1, 2, 10).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    expect(labels[labels.length - 1]).toBe('Older');
  });

  it('prints a quiet relative time', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(shortAge('2026-10-08T11:59:30Z', now)).toBe('now');
    expect(shortAge('2026-10-08T11:15:00Z', now)).toBe('45m');
    expect(shortAge('not a date', now)).toBe('');
  });
});

describe('HistoryRail', () => {
  it('exposes grouped rows with the full accessible name and the current thread', () => {
    const { props } = renderRail();
    const nav = screen.getByRole('navigation', { name: 'Chat history' });
    for (const label of ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days']) {
      expect(within(nav).getByRole('group', { name: label })).toBeInTheDocument();
    }
    // Group labels are not headings: the outline is h1 Chat → h2 thread → h3 turns.
    expect(within(nav).queryAllByRole('heading')).toHaveLength(0);
    const active = screen.getByRole('button', { name: /^Investigate sign-ins — .* · 2 messages$/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    const other = screen.getByRole('button', { name: /^Review endpoint alert — .* · 4 messages$/ });
    expect(other).not.toHaveAttribute('aria-current');
    fireEvent.click(other);
    expect(props.onSelect).toHaveBeenCalledWith(ROWS[1]);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
  });

  it('moves focus between rows with the arrow keys through one tab stop', () => {
    renderRail();
    const rows = screen.getAllByRole('button', { name: / messages$/ });
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    const active = screen.getByRole('button', { name: /^Investigate sign-ins/ });
    act(() => active.focus());
    fireEvent.keyDown(active, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAccessibleName(/^Review endpoint alert/);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toHaveAccessibleName(/^Ransomware playbook/);
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toHaveAccessibleName(/^Phishing wave/);
  });

  it('keeps a tab stop on an existing row when the focused row disappears', () => {
    const { rerender, props } = renderRail({ activeId: null });
    const last = screen.getByRole('button', { name: /^Phishing wave/ });
    act(() => last.focus());
    // The focused (last) row is deleted and nothing is active.
    rerender(
      <TooltipProvider>
        <HistoryRail {...props} activeId={null} conversations={ROWS.slice(0, 2)} />
      </TooltipProvider>,
    );
    const rows = screen.getAllByRole('button', { name: / messages$/ });
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  it('renames inline from the row menu (Enter commits, IME Enter does not) and returns focus to the row', async () => {
    const user = userEvent.setup();
    const { props } = renderRail();
    await user.click(screen.getByRole('button', { name: 'Actions for Investigate sign-ins' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename Investigate sign-ins' });
    // The menu closing does not take focus back from the field.
    await waitFor(() => expect(input).toHaveFocus());
    // Arrow keys inside the field edit the text; they do not rove the rows.
    fireEvent.keyDown(input, { key: 'Home' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '正在调查' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(props.onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    expect(props.onRename).toHaveBeenCalledWith(ROWS[0], '正在调查');
    expect(screen.getByRole('button', { name: /^Investigate sign-ins — / })).toHaveFocus();

    // Escape cancels and also returns focus to the row.
    await user.click(screen.getByRole('button', { name: 'Actions for Review endpoint alert' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Review endpoint alert' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: /^Review endpoint alert — / })).toHaveFocus();
  });

  it('shows the full title and exact date in a row tooltip, and shortcut hints on the header', async () => {
    renderRail({ onCollapse: vi.fn(), shortcuts: { toggle: 'Control+Shift+S Meta+Shift+S' } });
    const row = screen.getByRole('button', { name: /^Review endpoint alert — / });
    act(() => row.focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Review endpoint alert');
    expect(tip).toHaveTextContent(/\d/);
    act(() => row.blur());
    const collapse = screen.getByRole('button', { name: 'Collapse history' });
    expect(collapse).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+S Meta+Shift+S');
    act(() => collapse.focus());
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(/^Collapse history \((Ctrl|⌘).*S\)$/));
  });

  it('pins, opens a report only when one exists, exports and deletes', async () => {
    const user = userEvent.setup();
    const { props } = renderRail();
    await user.click(screen.getByRole('button', { name: 'Actions for Investigate sign-ins' }));
    expect(screen.queryByRole('menuitem', { name: 'Open report' })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Pin' }));
    expect(props.onTogglePin).toHaveBeenCalledWith(ROWS[0]);

    await user.click(screen.getByRole('button', { name: 'Actions for Phishing wave' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Open report' }));
    expect(props.onOpenReport).toHaveBeenCalledWith(ROWS[3]);

    await user.click(screen.getByRole('button', { name: 'Actions for Phishing wave' }));
    const exportTrigger = await screen.findByRole('menuitem', { name: 'Export' });
    expect(exportTrigger.querySelector('svg')).toHaveClass('size-4', 'text-muted-foreground');
    await user.click(exportTrigger);
    // Radix sub-menu items are driven by keyboard here (jsdom has no pointer geometry).
    const markdown = await screen.findByRole('menuitem', { name: 'Markdown (.md)' });
    act(() => markdown.focus());
    await user.keyboard('{Enter}');
    expect(props.onExport).toHaveBeenCalledWith(ROWS[3], 'markdown');

    await user.click(screen.getByRole('button', { name: 'Actions for Phishing wave' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledWith(ROWS[3]);
  });

  it('locks selection and the running thread’s Delete while a turn runs', async () => {
    const user = userEvent.setup();
    renderRail({ busy: true });
    expect(screen.getByRole('button', { name: /^Review endpoint alert/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Actions for Investigate sign-ins' }));
    expect(await screen.findByRole('menuitem', { name: /Delete \(answer in progress\)/ })).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');
    // Another thread's report cannot open while selection is refused: said, not ignored.
    await user.click(screen.getByRole('button', { name: 'Actions for Phishing wave' }));
    expect(await screen.findByRole('menuitem', { name: 'Open report (answer in progress)' })).toHaveAttribute('data-disabled');
  });

  it('searches server-side and opens a hit with its snippet', () => {
    const hit: ChatConversationSearchHit = { ...ROWS[1], match: { message_id: 'm-7', snippet: 'brute force from 10.0.0.5' } };
    const setQuery = vi.fn();
    const openHit = vi.fn();
    const { rerender, props } = renderRail({ search: { query: '', setQuery, results: null, searching: false, error: null, openHit } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'brute' } });
    expect(setQuery).toHaveBeenCalledWith('brute');
    rerender(
      <TooltipProvider>
        <HistoryRail {...props} search={{ query: 'brute', setQuery, results: [hit], searching: false, error: null, openHit }} />
      </TooltipProvider>,
    );
    expect(screen.getByText('brute force from 10.0.0.5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Review endpoint alert — brute force/ }));
    expect(openHit).toHaveBeenCalledWith(hit);
    rerender(
      <TooltipProvider>
        <HistoryRail {...props} search={{ query: 'zzz', setQuery, results: [], searching: false, error: null, openHit }} />
      </TooltipProvider>,
    );
    expect(screen.getByText('No matching conversations')).toBeInTheDocument();
  });

  it('never repeats a hit\'s title as its snippet (on screen or in its name)', () => {
    const title = 'Hunt the source IP behind the newest SQL injection case: check its reputation,…';
    const hit: ChatConversationSearchHit = { ...ROWS[1], title, match: { message_id: null, snippet: title } };
    renderRail({ search: { query: 'sql injection', setQuery: vi.fn(), results: [hit], searching: false, error: null, openHit: vi.fn() } });
    expect(screen.getAllByText(title)).toHaveLength(1);
    expect(screen.getByRole('button', { name: title })).toBeInTheDocument();
    expect(distinctSnippet('Posture check', 'Posture check')).toBe('');
    // A first question the title was cut from is still a repeat.
    expect(distinctSnippet('How is our posture right n…', 'How is our posture right now? Include the trend')).toBe('');
    expect(distinctSnippet('Posture check', '…failed logins from 10.0.0.5…')).toBe('…failed logins from 10.0.0.5…');
  });

  it('discloses bounded retention without implying infinite history', () => {
    const { rerender, props } = renderRail({ retention: { limit: 50, truncated: false, total: 47, showNote: true } });
    expect(screen.getByRole('note')).toHaveTextContent('Chat keeps your latest 50 conversations');
    rerender(
      <TooltipProvider>
        <HistoryRail {...props} retention={{ limit: 50, truncated: true, total: 64, showNote: true }} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('note')).toHaveTextContent(`Showing the latest ${ROWS.length} of 64 conversations`);
  });

  it('renders honest loading, retryable error and empty states', () => {
    const { rerender, props } = renderRail({ conversations: [], loading: true });
    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeInTheDocument();
    rerender(
      <TooltipProvider>
        <HistoryRail {...props} loading={false} error="Conversation history is unavailable" />
      </TooltipProvider>,
    );
    expect(screen.getByText('Conversation history is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No previous conversations')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <TooltipProvider>
        <HistoryRail {...props} loading={false} error={null} />
      </TooltipProvider>,
    );
    expect(screen.getByText('No previous conversations')).toBeInTheDocument();
  });

  it('collapses the docked rail and offers the strip actions', () => {
    const onCollapse = vi.fn();
    renderRail({ onCollapse });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse history' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);

    const strip = { onNewChat: vi.fn(), onSearch: vi.fn(), onExpand: vi.fn() };
    render(
      <TooltipProvider>
        <HistoryStrip busy={false} {...strip} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' }).at(-1) as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(strip.onNewChat).toHaveBeenCalledTimes(1);
    expect(strip.onSearch).toHaveBeenCalledTimes(1);
    expect(strip.onExpand).toHaveBeenCalledTimes(1);
  });

  it('has no detectable accessibility violations with saved conversations', async () => {
    const { container } = renderRail({ retention: { limit: 50, truncated: true, total: 60, showNote: true } });
    expect(await axe(container)).toHaveNoViolations();
  });
});
