/**
 * ThreadToolbar — the 44 px band (SPEC §10.1a): History + New chat only when the rail
 * is a Sheet (so exactly one New chat is visible), the title as the `<h2>` with inline
 * rename (focus returns to the title after Enter / Escape, and ⋯ → Rename keeps focus in
 * the field), the conversation total inline from 560 px (else in ⋯), Report as a
 * toggle with the added-item count only when there is one (Round 12: never "· 0"),
 * shortcut hints, the ⋯ menu (Rename, Pin conversation, Export conversation ▸, Delete)
 * only for a saved thread, and the viewer's Width submenu (Round 12 SPEC D12) on drafts
 * too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatConversationSummary } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { ThreadToolbar, conversationTotal, reportButtonHint, reportButtonLabel, type ThreadToolbarProps } from '../ThreadToolbar';
import { onReportChanged } from '../../report/report-sync';

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastSpy }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/soc/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/router')>();
  return { ...actual, useNavigateOptional: () => navigate };
});

expect.extend(toHaveNoViolations);

/** A stub `fetch` answering `POST /api/reports/from-conversation` with `replies` in order. */
function stubSave(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      const reply = replies.shift() ?? { status: 500, body: { detail: 'no reply' } };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

const SAVED_REPORT = {
  id: 'rpt-1',
  title: 'Failed sign-in review',
  template: 'custom',
  conversation_id: null,
  items: [],
  summary: null,
  created_at: '2026-10-08T09:06:00Z',
  updated_at: '2026-10-08T09:06:00Z',
  version: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  toastSpy.success.mockReset();
  toastSpy.error.mockReset();
  navigate.mockReset();
});

const SUMMARY: ChatConversationSummary = {
  id: 'c-1',
  title: 'Failed sign-in review',
  created_at: '2026-10-08T09:00:00Z',
  updated_at: '2026-10-08T09:05:00Z',
  message_count: 4,
  total_tokens: 12_400,
  total_cost: 0.031,
};

function renderToolbar(overrides: Partial<ThreadToolbarProps> = {}) {
  const props: ThreadToolbarProps = {
    title: SUMMARY.title,
    summary: SUMMARY,
    railInSheet: false,
    onOpenHistory: vi.fn(),
    onNewChat: vi.fn(),
    wide: true,
    report: { count: 2, open: false, onToggle: vi.fn() },
    busy: false,
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  const view = render(
    <TooltipProvider>
      <ThreadToolbar {...props} />
    </TooltipProvider>,
  );
  return { ...view, props };
}

describe('ThreadToolbar', () => {
  it('formats the conversation total, with a dash for legacy threads', () => {
    expect(conversationTotal(SUMMARY)).toBe('12.4k tokens · $0.03');
    expect(conversationTotal({ ...SUMMARY, total_tokens: null })).toBe('Usage —');
    expect(conversationTotal(null)).toBeNull();
  });

  it('shows the title as the h2, the total inline and the report toggle', () => {
    const { props } = renderToolbar();
    expect(screen.getByRole('heading', { level: 2, name: 'Failed sign-in review' })).toBeInTheDocument();
    expect(screen.getByTestId('conversation-total')).toHaveTextContent('12.4k tokens · $0.03');
    const toggle = screen.getByRole('button', { name: 'Report, 2 items added' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('chat-report-count')).toHaveTextContent('2');
    expect(toggle).not.toHaveTextContent('·');
    fireEvent.click(toggle);
    expect(props.report?.onToggle).toHaveBeenCalledTimes(1);
    // The rail is docked: neither History nor a second New chat here.
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
  });

  it('names the report count only when something was added, and says what it counts', async () => {
    expect(reportButtonLabel(0)).toBe('Report');
    expect(reportButtonLabel(1)).toBe('Report, 1 item added');
    expect(reportButtonLabel(Number.NaN)).toBe('Report');
    expect(reportButtonHint(0)).toBe('Collect answers and blocks from this chat into a report');
    expect(reportButtonHint(3)).toBe('3 items you added from this chat');
    renderToolbar({ report: { count: 0, open: false, onToggle: vi.fn() } });
    const toggle = screen.getByRole('button', { name: 'Report' });
    expect(toggle).toHaveTextContent(/^Report$/);
    expect(screen.queryByTestId('chat-report-count')).toBeNull();
    act(() => toggle.focus());
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('Collect answers and blocks from this chat into a report'),
    );
  });

  it('keeps the count as a badge when the toolbar is narrow', () => {
    renderToolbar({ narrow: true, report: { count: 4, open: true, onToggle: vi.fn() } });
    const toggle = screen.getByRole('button', { name: 'Report, 4 items added' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent(/^4$/);
  });

  it('offers the conversation width in ⋯, on a draft too, and reports the choice', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderToolbar({ summary: null, title: 'New chat', laneWidth: { value: 'wide', onChange } });
    // A draft has no thread actions, so the menu is named for what it offers.
    await user.click(screen.getByRole('button', { name: 'Conversation options' }));
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    const width = await screen.findByRole('menuitem', { name: 'Width, currently Wide' });
    await user.click(width);
    const wide = await screen.findByRole('menuitemradio', { name: /^Wide/ });
    expect(wide).toHaveAttribute('aria-checked', 'true');
    const full = screen.getByRole('menuitemradio', { name: /^Full width/ });
    expect(full).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: /^Comfortable/ })).toHaveAccessibleName(/Up to about 1,000 px$/);
    // The default is named, so a viewer who chose another width can find their way back.
    expect(full).toHaveAccessibleName(/^Full width ?, Fills the space \(default\)$/);
    act(() => full.focus());
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('full');
  });

  it('offers History and New chat when the rail is a Sheet', () => {
    const { props } = renderToolbar({ railInSheet: true });
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(props.onOpenHistory).toHaveBeenCalledTimes(1);
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
  });

  it('renames inline from the title (Enter commits, Escape cancels) and returns focus to it', () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Failed sign-in review' }));
    const input = screen.getByRole('textbox', { name: 'Conversation title' });
    fireEvent.change(input, { target: { value: 'Sign-in review, final' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(props.onRename).toHaveBeenCalledWith('Sign-in review, final');
    expect(screen.getByRole('button', { name: 'Failed sign-in review' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Failed sign-in review' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Conversation title' }), { key: 'Escape' });
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Failed sign-in review' })).toHaveFocus();
  });

  it('keeps focus in the title field when renaming from the ⋯ menu', async () => {
    const user = userEvent.setup();
    const { props } = renderToolbar();
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Conversation title' });
    // The closing menu must not pull focus back to ⋯ (that blur would commit at once).
    await waitFor(() => expect(input).toHaveFocus());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(input).toHaveFocus();
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it('adds the keyboard shortcut to the History tooltip', async () => {
    renderToolbar({ railInSheet: true, shortcuts: { history: 'Control+Shift+S Meta+Shift+S' } });
    const history = screen.getByRole('button', { name: 'History' });
    expect(history).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+S Meta+Shift+S');
    act(() => history.focus());
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(/^History \((Ctrl|⌘).*S\)$/));
  });

  it('moves the total into ⋯ on a narrow toolbar and runs the thread actions', async () => {
    const user = userEvent.setup();
    const { props } = renderToolbar({ wide: false });
    expect(screen.queryByTestId('conversation-total')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(await screen.findByText('This conversation: 12.4k tokens · $0.03')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Pin conversation' }));
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    const exportTrigger = await screen.findByRole('menuitem', { name: 'Export conversation' });
    // Sized and muted like the other menu icons (a sub-trigger does not do it for us).
    expect(exportTrigger.querySelector('svg')).toHaveClass('size-4', 'text-muted-foreground');
    await user.click(exportTrigger);
    // Radix sub-menu items are driven by keyboard here (jsdom has no pointer geometry).
    const html = await screen.findByRole('menuitem', { name: 'HTML (.html)' });
    act(() => html.focus());
    await user.keyboard('{Enter}');
    expect(props.onExport).toHaveBeenCalledWith('html');
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('offers no thread actions for an unsaved draft and hides the report for case scope', async () => {
    const user = userEvent.setup();
    const { unmount } = renderToolbar({ summary: null, title: 'New chat' });
    expect(screen.getByRole('heading', { level: 2, name: 'New chat' })).toBeInTheDocument();
    // A draft has nothing to rename, pin, export or delete: no menu of disabled items
    // (and without a width control there is nothing else to offer).
    expect(screen.queryByRole('button', { name: 'Conversation actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conversation options' })).toBeNull();
    unmount();
    const busyView = renderToolbar({ busy: true });
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');
    busyView.unmount();
    renderToolbar({ caseScoped: true, summary: null, title: 'Case case-9', report: null });
    expect(screen.queryByRole('button', { name: /Report/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conversation actions' })).toBeNull();
  });

  it('saves the whole conversation as a new report and links to it (Round 12 D11)', async () => {
    const user = userEvent.setup();
    const calls = stubSave([{ status: 200, body: { report: SAVED_REPORT, items: 3, skipped: 1, created: true } }]);
    const changed = vi.fn();
    const off = onReportChanged(changed);
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save conversation as report' }));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/reports/from-conversation');
    // Only the id and a key: the server resolves every item from the saved conversation.
    expect(Object.keys(calls[0].body).sort()).toEqual(['conversation_id', 'idempotency_key']);
    expect(calls[0].body.conversation_id).toBe('c-1');
    const [title, options] = toastSpy.success.mock.calls[0];
    expect(title).toBe('Saved to Reports');
    expect(options.description).toBe('Failed sign-in review · 3 sections · 1 more part did not fit');
    expect(options.action.label).toBe('Open report');
    options.action.onClick();
    expect(navigate).toHaveBeenCalledWith('reports', { reportId: 'rpt-1' });
    // A standalone report: the conversation's own draft is never replaced by it.
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ reportId: 'rpt-1', conversationId: null }));
    off();
  });

  it('says a running answer is not included, and that a replay was already saved', async () => {
    const user = userEvent.setup();
    stubSave([{ status: 200, body: { report: SAVED_REPORT, items: 1, skipped: 0, created: false } }]);
    renderToolbar({ busy: true });
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save conversation as report' }));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledTimes(1));
    const [title, options] = toastSpy.success.mock.calls[0];
    expect(title).toBe('Already saved to Reports');
    expect(options.description).toBe('Failed sign-in review · 1 section. The answer still being written is not included.');
  });

  it('retries a failed save with the SAME key, and explains a conversation with no answers', async () => {
    const user = userEvent.setup();
    const calls = stubSave([
      { status: 503, body: { detail: { code: 'chat_history_unavailable', message: 'Chat history is temporarily unavailable.' } } },
      { status: 200, body: { report: SAVED_REPORT, items: 2, skipped: 0, created: true } },
    ]);
    renderToolbar();
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save conversation as report' }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledTimes(1));
    const [message, options] = toastSpy.error.mock.calls[0];
    expect(message).toBe('Chat history is temporarily unavailable. Try again in a moment.');
    expect(options.action.label).toBe('Try again');
    await act(async () => {
      options.action.onClick();
    });
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(2);
    expect(calls[1].body.idempotency_key).toBe(calls[0].body.idempotency_key);

    // A deliberate second save is a new report: a new key.
    stubSave([{ status: 409, body: { detail: { code: 'report_empty', message: 'This conversation has no answers to save.' } } }]);
    await user.click(screen.getByRole('button', { name: 'Conversation actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save conversation as report' }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledTimes(2));
    const [emptyMessage, emptyOptions] = toastSpy.error.mock.calls[1];
    expect(emptyMessage).toBe('This conversation has no answers to save yet.');
    expect(emptyOptions.action).toBeUndefined();
  });

  it('never offers the save on a draft or in case chat', async () => {
    const user = userEvent.setup();
    renderToolbar({ summary: null, title: 'New chat', laneWidth: { value: 'wide', onChange: vi.fn() } });
    await user.click(screen.getByRole('button', { name: 'Conversation options' }));
    await screen.findByRole('menuitem', { name: 'Width, currently Wide' });
    expect(screen.queryByRole('menuitem', { name: 'Save conversation as report' })).toBeNull();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = renderToolbar({ railInSheet: true });
    expect(await axe(container)).toHaveNoViolations();
  });
});
