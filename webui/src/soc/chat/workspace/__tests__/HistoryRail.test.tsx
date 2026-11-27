/**
 * HistoryRail — ported from the pre-revamp `ChatHistoryRail` suite and extended for the
 * revamp (SPEC §10.2): grouping (Pinned, Today, Yesterday, Previous 7 / 30 days,
 * month) labelled as groups rather than headings, one-line rows with the full
 * accessible name, `aria-current` and an exact-date tooltip, roving arrow-key focus
 * (only from rows, with a tab stop that survives a shorter list), inline rename
 * (IME-safe, focus returns to the row), the row menu (Pin, Open report only with a
 * report, Export, Delete locked for a running thread), live row statuses (Round 12:
 * a ring while answering, dots for unread / needs input / failed; rows never locked by
 * a running turn), shortcut hints, server search with snippets, the retention footer,
 * honest loading / retryable error / empty states, and axe.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatConversationSearchHit, ChatConversationSummary } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { clearChatActivity, putChatActivity, viewChatActivity } from '@/soc/chat-activity/activity';
import {
  HistoryRail,
  HistoryStrip,
  distinctSnippet,
  groupConversations,
  plainSnippet,
  shortAge,
  snippetSegments,
  type HistoryRailProps,
} from '../HistoryRail';
import { pendingThreadRow } from '../../useChatConversations';

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
    const active = screen.getByRole('button', { name: /^Investigate sign-ins, .* · 2 messages$/ });
    expect(active).toHaveAttribute('aria-current', 'page');
    const other = screen.getByRole('button', { name: /^Review endpoint alert, .* · 4 messages$/ });
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
    expect(screen.getByRole('button', { name: /^Investigate sign-ins, / })).toHaveFocus();
    // Focus handed back by code: the row's full-title tooltip stays shut.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Escape cancels and also returns focus to the row.
    await user.click(screen.getByRole('button', { name: 'Actions for Review endpoint alert' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Review endpoint alert' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: /^Review endpoint alert, / })).toHaveFocus();
  });

  it('shows the full title and exact date in a row tooltip, and shortcut hints on the header', async () => {
    renderRail({ onCollapse: vi.fn(), shortcuts: { toggle: 'Control+Shift+S Meta+Shift+S' } });
    const row = screen.getByRole('button', { name: /^Review endpoint alert, / });
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

  it('hides a row time only in the states that show its ⋯ trigger, never on click focus alone', () => {
    renderRail();
    const row = screen.getByRole('button', { name: /^Review endpoint alert, / });
    const time = row.querySelector('span[aria-hidden]') as HTMLElement;
    const trigger = screen.getByRole('button', { name: 'Actions for Review endpoint alert' });
    const timeClasses = time.className.split(/\s+/);
    const triggerClasses = trigger.className.split(/\s+/);
    // A row focused by a click keeps focus but not :focus-visible, and the trigger stays
    // hidden then: plain focus-within must not hide the time (the empty-slot bug).
    expect(timeClasses.some((c) => c.startsWith('group-focus-within'))).toBe(false);
    expect(triggerClasses.some((c) => c.startsWith('group-focus-within'))).toBe(false);
    const hiding = timeClasses.filter((c) => c.endsWith(':invisible')).map((c) => c.slice(0, -':invisible'.length));
    const showing = triggerClasses.filter((c) => c.startsWith('group-') && c.endsWith(':opacity-100')).map((c) => c.slice(0, -':opacity-100'.length));
    expect(hiding.sort()).toEqual(['group-has-[:focus-visible]/row', 'group-has-[[data-state=open]]/row', 'group-hover/row']);
    // The same three states, so the time and the trigger are never hidden together.
    expect(showing.sort()).toEqual(hiding.sort());
    expect(triggerClasses).toContain('opacity-0');
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

  it('keeps every row and New chat open while a turn runs, and locks only the running thread’s Delete', async () => {
    const user = userEvent.setup();
    renderRail({ busy: true });
    expect(screen.getByRole('button', { name: /^Review endpoint alert/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Actions for Investigate sign-ins' }));
    expect(await screen.findByRole('menuitem', { name: /Delete \(answer in progress\)/ })).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');
    // Another thread's report opens: selecting it no longer stops anything.
    await user.click(screen.getByRole('button', { name: 'Actions for Phishing wave' }));
    expect(await screen.findByRole('menuitem', { name: 'Open report' })).not.toHaveAttribute('data-disabled');
  });

  it('shows each row’s live state in place of (or before) its time, and names it', async () => {
    const user = userEvent.setup();
    const rows = [
      summary('a', 'Answering thread', daysAgo(0), { status: 'running' }),
      summary('b', 'Unread thread', daysAgo(0), { unread: true }),
      summary('c', 'Waiting thread', daysAgo(0), { status: 'needs_input' }),
      summary('d', 'Failed thread', daysAgo(0), { status: 'failed' }),
      summary('e', 'Quiet thread', daysAgo(0)),
    ];
    const { container } = renderRail({ conversations: rows, activeId: 'e' });
    expect(screen.getByRole('button', { name: /^Answering thread, answering, / })).toHaveAttribute('data-status', 'running');
    expect(screen.getByRole('button', { name: /^Unread thread, new answer, / })).toHaveAttribute('data-status', 'unread');
    expect(screen.getByRole('button', { name: /^Waiting thread, needs your input, / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Failed thread, answer failed, / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Quiet thread, / })).not.toHaveAttribute('data-status');
    const answering = screen.getByRole('button', { name: /^Answering thread/ });
    expect(answering.querySelector('[data-activity="running"]')).not.toBeNull();
    // The ring replaces the time; a dot sits before it.
    expect(answering.textContent).toBe('Answering thread');
    expect(screen.getByRole('button', { name: /^Unread thread/ }).querySelector('[data-activity="unread"]')).not.toBeNull();
    expect(container.querySelector('[data-activity="needs_input"]')).not.toBeNull();
    expect(container.querySelector('[data-activity="failed"]')).not.toBeNull();
    // A running row cannot be deleted even when it is not the open one.
    await user.click(screen.getByRole('button', { name: 'Actions for Answering thread' }));
    expect(await screen.findByRole('menuitem', { name: /Delete \(answer in progress\)/ })).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('marks “Show history” on the strip while a thread off screen is working', () => {
    clearChatActivity();
    const strip = { onNewChat: vi.fn(), onSearch: vi.fn(), onExpand: vi.fn() };
    const view = render(
      <TooltipProvider>
        <HistoryStrip {...strip} />
      </TooltipProvider>,
    );
    const show = () => screen.getByRole('button', { name: 'Show history' });
    expect(show().querySelector('[data-activity]')).toBeNull();
    const release = viewChatActivity('conv:on-screen');
    act(() =>
      putChatActivity({
        scope: 'conv:on-screen', kind: 'workspace', conversationId: 'on-screen', caseId: null, turnId: null, requestKey: null,
        title: 'Shown', label: null, lookups: 0, status: 'running', startedAt: 1, source: 'local',
      }),
    );
    view.rerender(
      <TooltipProvider>
        <HistoryStrip {...strip} />
      </TooltipProvider>,
    );
    // The one on screen does not count.
    expect(show().querySelector('[data-activity]')).toBeNull();
    act(() =>
      putChatActivity({
        scope: 'conv:elsewhere', kind: 'workspace', conversationId: 'elsewhere', caseId: null, turnId: null, requestKey: null,
        title: 'Elsewhere', label: null, lookups: 0, status: 'running', startedAt: 2, source: 'local',
      }),
    );
    expect(show().querySelector('[data-activity="running"]')).not.toBeNull();
    expect(show()).toHaveAttribute('aria-description', 'An answer is being written in another chat');
    expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled();
    // The strip is still mounted: clearing the store re-renders it.
    act(() => {
      release();
      clearChatActivity();
    });
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
    // T27: the snippet under the title, the matching word in font-medium.
    const snippet = screen.getByTestId('hit-snippet');
    expect(snippet).toHaveTextContent('brute force from 10.0.0.5');
    expect(snippet).toHaveClass('text-xs', 'text-muted-foreground', 'line-clamp-2');
    // `block` would override line-clamp's box and let a third line show.
    expect(snippet).not.toHaveClass('block');
    const match = within(snippet).getByText('brute');
    expect(match).toHaveClass('font-medium');
    expect(match).toHaveAttribute('data-match');
    fireEvent.click(screen.getByRole('button', { name: /^Review endpoint alert: brute force/ }));
    expect(openHit).toHaveBeenCalledWith(hit);
    rerender(
      <TooltipProvider>
        <HistoryRail {...props} search={{ query: 'zzz', setQuery, results: [], searching: false, error: null, openHit }} />
      </TooltipProvider>,
    );
    expect(screen.getByText('No matching conversations')).toBeInTheDocument();
  });

  it('shows every hit\'s snippet, even one that repeats the title (T27)', () => {
    const title = 'Hunt the source IP behind the newest SQL injection case: check its reputation,…';
    const hit: ChatConversationSearchHit = { ...ROWS[1], title, match: { message_id: null, snippet: title } };
    renderRail({ search: { query: 'sql injection', setQuery: vi.fn(), results: [hit], searching: false, error: null, openHit: vi.fn() } });
    const snippet = screen.getByTestId('hit-snippet');
    expect(snippet).toHaveTextContent(title);
    expect(within(snippet).getByText('SQL injection')).toHaveAttribute('data-match');
    // Shown twice is the price of every snippet showing; spoken twice it is noise: the
    // hit's name says it once.
    expect(screen.queryByRole('button', { name: `${title}: ${title}` })).toBeNull();
    expect(screen.getByRole('button', { name: title })).toBeInTheDocument();
    // The helper stays for callers that want to avoid a repeat.
    expect(distinctSnippet('Posture check', 'Posture check')).toBe('');
    expect(distinctSnippet('Posture check', '…failed logins from 10.0.0.5…')).toBe('…failed logins from 10.0.0.5…');
  });

  it('marks the whole query, else each word, case-insensitively and as text (T27)', () => {
    expect(snippetSegments('Failed logins from 10.0.0.5', 'LOGINS from')).toEqual([
      { text: 'Failed ', match: false },
      { text: 'logins from', match: true },
      { text: ' 10.0.0.5', match: false },
    ]);
    expect(snippetSegments('brute force on vpn, then brute again', 'brute vpn')).toEqual([
      { text: 'brute', match: true },
      { text: ' force on ', match: false },
      { text: 'vpn', match: true },
      { text: ', then ', match: false },
      { text: 'brute', match: true },
      { text: ' again', match: false },
    ]);
    expect(snippetSegments('nothing here', 'zzz')).toEqual([{ text: 'nothing here', match: false }]);
    // Single letters alone never light up a snippet.
    expect(snippetSegments('one a two', 'x a')).toEqual([{ text: 'one a two', match: false }]);
    // Markup in a snippet stays text.
    const hit: ChatConversationSearchHit = { ...ROWS[1], match: { message_id: null, snippet: '<img src=x onerror=alert(1)> brute' } };
    const { container } = renderRail({ search: { query: 'brute', setQuery: vi.fn(), results: [hit], searching: false, error: null, openHit: vi.fn() } });
    expect(container.querySelector('nav img')).toBeNull();
    expect(screen.getByTestId('hit-snippet')).toHaveTextContent('<img src=x onerror=alert(1)> brute');
  });

  it('shows and names a snippet cut from a Markdown answer as plain text (T27)', () => {
    const snippet = '**SOC performance report, last 7 days** (since 11 Oct 2026): **65 cases** opened, see [the queue](https://soc/cases) and `*.exe` hits. **4…';
    const hit: ChatConversationSearchHit = { ...ROWS[1], title: 'Case volume', match: { message_id: 'm-1', snippet } };
    renderRail({ search: { query: '65 cases', setQuery: vi.fn(), results: [hit], searching: false, error: null, openHit: vi.fn() } });
    const shown = screen.getByTestId('hit-snippet');
    const plain = 'SOC performance report, last 7 days (since 11 Oct 2026): 65 cases opened, see the queue and *.exe hits. 4…';
    expect(shown).toHaveTextContent(plain);
    expect(shown.textContent).not.toContain('**');
    expect(within(shown).getByText('65 cases')).toHaveAttribute('data-match');
    const button = screen.getByRole('button', { name: `Case volume: ${plain}` });
    expect(button.getAttribute('aria-label')).not.toMatch(/\*\*|\]\(|`/);
  });

  it('strips Markdown markers from a snippet but keeps code, arithmetic and identifiers (T27)', () => {
    expect(plainSnippet('**65 cases**')).toBe('65 cases');
    expect(plainSnippet('__Bold__ and *italic* and _also_ ~~gone~~')).toBe('Bold and italic and also gone');
    expect(plainSnippet('…summary. ## Next steps - Isolate the host')).toBe('…summary. Next steps - Isolate the host');
    expect(plainSnippet('> Quoted advice')).toBe('Quoted advice');
    expect(plainSnippet('…* Reset the account')).toBe('…Reset the account');
    expect(plainSnippet('See [case 12](#/cases/case-12) and ![chart](x.png).')).toBe('See case 12 and chart.');
    expect(plainSnippet('Open [the full report](https://soc/rep…')).toBe('Open the full report');
    // Code spans keep their text exactly; markers outside them are not emphasis.
    expect(plainSnippet('Run `Get-Item *.ps1` then check `_source`')).toBe('Run Get-Item *.ps1 then check _source');
    expect(plainSnippet('Files *.exe and *.dll, field _source and case_id')).toBe('Files *.exe and *.dll, field _source and case_id');
    expect(plainSnippet('risk > 70 and 3 * 4 = 12, ticket #4')).toBe('risk > 70 and 3 * 4 = 12, ticket #4');
    expect(plainSnippet('escaped \\*star\\* and case\\_id')).toBe('escaped *star* and case_id');
    expect(plainSnippet('  ')).toBe('');
    expect(plainSnippet(null)).toBe('');
  });

  it('lists a New chat\'s first turn as the current row at the top of Today, with no actions (T21)', () => {
    const pending = pendingThreadRow({
      scope: 'conv:c-new',
      kind: 'workspace',
      conversationId: 'c-new',
      caseId: null,
      turnId: 't-1',
      requestKey: 'k-1',
      title: 'Which hosts talked to 10.0.0.5 in the last hour?',
      label: null,
      lookups: 0,
      status: 'running',
      startedAt: Date.now(),
      source: 'local',
    });
    const { props } = renderRail({ activeId: null, conversations: [pending, ...ROWS] });
    const today = screen.getByRole('group', { name: 'Today' });
    const rows = within(today).getAllByRole('button').filter((el) => el.hasAttribute('data-rail-row'));
    expect(rows[0]).toHaveAttribute('data-pending');
    expect(rows[0]).toHaveAttribute('aria-current', 'page');
    expect(rows[0]).toHaveAttribute('data-status', 'running');
    // 48 characters fit whole.
    expect(rows[0]).toHaveAccessibleName(/^Which hosts talked to 10\.0\.0\.5 in the last hour\?, answering, /);
    // The question is on screen but nothing is saved yet: no "0 messages".
    expect(rows[0].getAttribute('aria-label')).not.toMatch(/messages?$/);
    expect(rows[0].querySelector('[data-activity="running"]')).not.toBeNull();
    // Not saved yet: no actions. Activating it reaches the host (which closes the phone's
    // history sheet); the selection itself ignores the temporary row.
    expect(screen.queryByRole('button', { name: /^Actions for Which hosts/ })).toBeNull();
    fireEvent.click(rows[0]);
    expect(props.onSelect).toHaveBeenCalledWith(pending);
    // Only one row is current.
    expect(screen.getAllByRole('button').filter((el) => el.getAttribute('aria-current') === 'page')).toHaveLength(1);
  });

  it('renders a model-written title as text, in the row and in a search hit (T6)', () => {
    const title = '<img src=x onerror=alert(1)> **bold** [link](https://evil.test)';
    const row = { ...ROWS[0], title };
    const { container, unmount } = renderRail({ conversations: [row] });
    expect(container.querySelector('nav img, nav a, nav strong')).toBeNull();
    expect(screen.getByRole('button', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, `) })).toHaveTextContent(title);
    unmount();
    const hit: ChatConversationSearchHit = { ...ROWS[1], title, match: { message_id: null, snippet: 'brute force' } };
    const view = renderRail({ search: { query: 'brute', setQuery: vi.fn(), results: [hit], searching: false, error: null, openHit: vi.fn() } });
    expect(view.container.querySelector('nav img, nav a, nav strong')).toBeNull();
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it('keeps row times clear of the title (T33)', () => {
    renderRail();
    const row = screen.getAllByRole('button').find((el) => el.hasAttribute('data-rail-row')) as HTMLElement;
    const time = row.querySelector('span[aria-hidden]') as HTMLElement;
    expect(time).toHaveClass('shrink-0', 'pl-3', 'tabular-nums');
  });

  it('marks the search field to take focus when the rail opens as a sheet (T27)', () => {
    const { unmount } = renderRail({ inSheet: true });
    expect(screen.getByRole('searchbox', { name: 'Search chats' })).toHaveAttribute('data-autofocus');
    unmount();
    renderRail();
    expect(screen.getByRole('searchbox', { name: 'Search chats' })).not.toHaveAttribute('data-autofocus');
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
