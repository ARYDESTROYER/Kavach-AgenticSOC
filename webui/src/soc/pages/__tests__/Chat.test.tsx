/**
 * Workspace Chat page — the real page, workspace shell, hooks, chat client and NDJSON
 * reader over a scripted `fetch` (chat revamp SPEC §10). Ports the pre-revamp page and
 * transport suites (frame contract, history selection and restore, first-turn
 * promotion, retry with one key, confirmed delete, case scope) and adds the revamp
 * flows: the live run log, "Ask about this" topics, deep-link highlight and hash
 * clearing, the unavailable notice, Add to report opening the split panel with an
 * announcement, a failed `/chat/context` reaching the empty state and composer as a
 * retryable error, focus kept in the composer after a starter, conversation export
 * from the rail, and jest-axe in the empty, running, completed, error and panel-open
 * states.
 *
 * The composer, empty state, budget alert and shortcut sheet belong to the composer
 * package and the report panel to the reports package; they are replaced by small
 * doubles here so this suite pins the shell's contract with them, not their insides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { authState, savePromptMock } = vi.hoisted(() => ({
  authState: { denied: new Set<string>() },
  savePromptMock: vi.fn(),
}));
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'analyst',
    hasPermission: (resource: string, action: string) => !authState.denied.has(`${resource}:${action}`),
  }),
}));

vi.mock('@/soc/chat/composer/Composer', async () => {
  const React = await import('react');
  type Engine = import('@/soc/chat/useChatEngine').ChatEngine;
  const Composer = React.forwardRef(function ComposerDouble(
    props: { engine: Engine; variant?: string; disabledReason?: string | null; contextError?: string | null; canChooseModel?: boolean },
    ref: React.Ref<{ focus: () => void; setText: (text: string) => void; savePrompt: (text: string) => void }>,
  ) {
    const area = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => area.current?.focus(),
      setText: (text: string) => {
        props.engine.setDraft(text);
        area.current?.focus();
      },
      savePrompt: (text: string) => savePromptMock(text),
    }));
    return React.createElement(
      'form',
      {
        'data-testid': 'composer',
        'data-variant': props.variant,
        'data-can-choose-model': String(props.canChooseModel),
        'data-disabled-reason': props.disabledReason ?? '',
        'data-context-error': props.contextError ?? '',
        onSubmit: (event: React.FormEvent) => {
          event.preventDefault();
          props.engine.send();
        },
      },
      React.createElement('textarea', {
        ref: area,
        'aria-label': 'Message',
        value: props.engine.draft,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.engine.setDraft(event.target.value),
      }),
      props.engine.canStop
        ? React.createElement('button', { type: 'button', onClick: () => props.engine.stop() }, 'Stop')
        : React.createElement('button', { type: 'submit', disabled: !!props.disabledReason }, 'Send'),
    );
  });
  return { Composer };
});

vi.mock('@/soc/chat/empty/EmptyState', async () => {
  const React = await import('react');
  return {
    EmptyState: (props: {
      context: import('@/lib/types').ChatContextInfo | null;
      onStarter: (s: import('@/lib/types').ChatStarter) => void;
      error?: string | null;
      onRetry?: () => void;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'empty-state' },
        React.createElement('p', null, 'Ask about your data, build a quick report, or learn how this console works. Read-only.'),
        props.error && !props.context
          ? React.createElement(
              'p',
              { 'data-testid': 'empty-context-error' },
              props.error,
              props.onRetry ? React.createElement('button', { type: 'button', onClick: props.onRetry }, 'Retry context') : null,
            )
          : null,
        ...(props.context?.starters ?? []).map((starter) =>
          React.createElement('button', { key: starter.id, type: 'button', onClick: () => props.onStarter(starter) }, starter.label),
        ),
      ),
  };
});

vi.mock('@/soc/chat/composer/BudgetAlert', () => ({ BudgetAlert: () => null }));
vi.mock('@/soc/chat/shortcuts/ShortcutSheet', () => ({ ShortcutSheet: () => null }));

const { exportConversationMock, toastMock } = vi.hoisted(() => ({
  exportConversationMock: vi.fn(),
  toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: toastMock }));
vi.mock('@/soc/chat/report/export/conversation', () => ({ exportConversation: exportConversationMock }));

vi.mock('@/soc/chat/report/ReportPanel', async () => {
  const React = await import('react');
  const ReportPanel = (props: { mode: string; reportId: string | null; conversationId: string | null; onClose: () => void }) =>
    React.createElement(
      'section',
      { 'data-testid': 'report-panel', 'data-mode': props.mode, 'data-report-id': props.reportId ?? '', 'aria-label': 'Report panel' },
      React.createElement('h2', null, 'Report'),
      React.createElement('button', { type: 'button', onClick: props.onClose }, 'Close report'),
    );
  return { default: ReportPanel, ReportPanel };
});

import type { ChatConversation, ChatConversationSummary, NavOpts } from '@/lib/types';
import { AnnouncerProvider } from '@/soc/components/announcer';
import { ConfirmProvider } from '@/soc/components/ConfirmDialog';
import { TooltipProvider } from '@/ui/tooltip';
import { clearChatContextCache } from '@/soc/chat/useChatContext';
import Chat from '../Chat';

/* -------------------------------------------------------------------------- */
/* Scripted fetch.                                                             */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

interface StreamHandle {
  body: Record<string, unknown>;
  push: (...events: unknown[]) => Promise<void>;
}

let calls: Call[] = [];
let streams: StreamHandle[] = [];
let rows: ChatConversationSummary[] = [];
let details: Record<string, ChatConversation> = {};
let streamFailures = 0;
let contextFailures = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function openStream(body: Record<string, unknown>): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  streams.push({
    body,
    push: async (...events) => {
      await act(async () => {
        for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

const CONTEXT = {
  model: 'gpt-test',
  context_window: 128000,
  max_output_tokens: 4096,
  chars_per_token: 4,
  static_prompt_tokens: 900,
  history_tokens: 0,
  tools: [],
  text_streaming: { available: true },
  bounds: { max_tool_calls: 10, turn_timeout_s: 60, model_step_timeout_s: 30, default_stream_mode: 'steps' },
  starters: [{ id: 'posture', label: 'Posture now', description: 'Current posture', prompt: 'How are we doing right now?', tools: [] }],
};

function summary(id: string, title: string, updatedAt: string, extra: Partial<ChatConversationSummary> = {}): ChatConversationSummary {
  return { id, title, preview: `${title} answer`, created_at: updatedAt, updated_at: updatedAt, message_count: 2, total_tokens: 2100, total_cost: 0.004, ...extra };
}

function detailOf(row: ChatConversationSummary): ChatConversation {
  return {
    ...row,
    messages: [
      { id: `${row.id}-u`, role: 'user', content: `${row.title} question`, created_at: row.created_at },
      {
        id: `${row.id}-a`,
        role: 'assistant',
        content: `${row.title} answer`,
        created_at: row.updated_at,
        response: { answer: `${row.title} answer`, message_id: `${row.id}-a`, usage: null, steps: [] },
      },
    ],
  };
}

const OLDER = summary('c-older', 'Older endpoint review', '2026-10-07T08:02:00Z');
const NEWEST = summary('c-newest', 'Newest sign-in review', '2026-10-08T09:03:00Z');

beforeEach(() => {
  calls = [];
  streams = [];
  streamFailures = 0;
  contextFailures = 0;
  exportConversationMock.mockReset().mockResolvedValue({ ok: true, message: 'Conversation exported as Markdown' });
  savePromptMock.mockReset();
  authState.denied = new Set();
  toastMock.mockReset();
  toastMock.error.mockReset();
  rows = [OLDER, NEWEST];
  details = { [OLDER.id]: detailOf(OLDER), [NEWEST.id]: detailOf(NEWEST) };
  clearChatContextCache();
  window.localStorage.clear();
  window.location.hash = '#/chat';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const path = url.split('?')[0];
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/context') {
        if (contextFailures > 0) {
          contextFailures -= 1;
          return json({ detail: 'Chat context is temporarily unavailable.' }, 503);
        }
        return json(CONTEXT);
      }
      if (path === '/api/chat/conversations' && method === 'GET') {
        const q = new URLSearchParams(url.split('?')[1] ?? '').get('q');
        const hits = q ? rows.filter((row) => row.title.toLowerCase().includes(q.toLowerCase())) : rows;
        return json({ conversations: hits, total: hits.length, limit: 50 });
      }
      const detail = /^\/api\/chat\/conversations\/([^/]+)$/.exec(path);
      if (detail && method === 'GET') {
        const found = details[decodeURIComponent(detail[1])];
        return found ? json(found) : json({ detail: 'Conversation not found' }, 404);
      }
      if (detail && method === 'DELETE') return json({ ok: true });
      if (path === '/api/chat/stream') {
        if (streamFailures > 0) {
          streamFailures -= 1;
          return json({ detail: { code: 'chat_history_unavailable', message: 'Conversation storage is temporarily unavailable.' } }, 503);
        }
        return openStream(body ?? {});
      }
      const topic = /^\/api\/chat\/topics\/(.+)$/.exec(path);
      if (topic) return json({ topic: decodeURIComponent(topic[1]), question: 'What does MTTD measure here?' });
      if (path === '/api/reports/add') {
        return json({
          report: {
            id: 'r-1',
            owner: 'analyst',
            title: 'Newest sign-in review',
            template: 'custom',
            conversation_id: body?.conversation_id,
            items: [
              {
                id: 'i-1',
                kind: 'section',
                block: { title: 'q', blocks: [] },
                source: { conversation_id: body?.conversation_id, message_id: body?.message_id, block_id: null },
                scope: {},
                added_at: '2026-10-08T10:00:00Z',
              },
            ],
            created_at: '2026-10-08T10:00:00Z',
            updated_at: '2026-10-08T10:00:00Z',
            version: 1,
          },
          item_id: 'i-1',
        });
      }
      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

/** Give the chat frame a measured width (jsdom has no layout). */
function frameWidth(width: number) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'workspace-chat-page') return DOMRect.fromRect({ width, height: 800 });
    return original.call(this);
  });
}

const shortcut = (key: string) => fireEvent.keyDown(window, { key, ctrlKey: true, shiftKey: true });

function renderChat(props: { caseId?: string; opts?: NavOpts } = {}) {
  return render(
    <AnnouncerProvider>
      <TooltipProvider>
        <ConfirmProvider>
          <Chat {...props} />
        </ConfirmProvider>
      </TooltipProvider>
    </AnnouncerProvider>,
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

/**
 * axe inside act: the shell announcer writes its live region on a timer and the rail
 * refreshes in the background; both may land while axe walks the DOM.
 */
async function axeClean(container: HTMLElement) {
  let results: Awaited<ReturnType<typeof axe>> | undefined;
  await act(async () => {
    results = await axe(container);
  });
  expect(results).toHaveNoViolations();
}

const streamCalls = () => calls.filter((call) => call.url === '/api/chat/stream');

async function send(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await settle();
}

const start = (conversationId: string | null = null) => ({
  type: 'turn.start',
  turn_id: 'turn-1',
  conversation_id: conversationId,
  model: 'gpt-test',
  stream_mode: 'steps',
  replayed: false,
  estimate: { prompt_tokens: 900 },
});

/* -------------------------------------------------------------------------- */

describe('Workspace Chat page', () => {
  it('owns a full-height frame that bleeds the shell inset, with one h1 and one visible New chat', async () => {
    renderChat();
    const frame = screen.getByTestId('workspace-chat-page');
    expect(frame).toHaveClass('-my-6', 'h-[calc(100dvh-3.5rem)]', 'min-h-0', 'overflow-hidden');
    expect(frame).toHaveAttribute('data-rail', 'docked');
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent('Chat');
    expect(h1[0]).toHaveClass('sr-only');
    await screen.findByText('Newest sign-in review answer');
    expect(screen.getAllByRole('button', { name: 'New chat' })).toHaveLength(1);
  });

  it('restores the newest thread, marks it current, and switches threads', async () => {
    renderChat();
    expect(await screen.findByText('Newest sign-in review answer')).toBeInTheDocument();
    const newest = screen.getByRole('button', { name: /^Newest sign-in review — .* · 2 messages$/ });
    expect(newest).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 2, name: 'Newest sign-in review' })).toBeInTheDocument();
    expect(screen.getByTestId('conversation-total')).toHaveTextContent('2.1k tokens · $0.004');

    fireEvent.click(screen.getByRole('button', { name: /^Older endpoint review — / }));
    expect(await screen.findByText('Older endpoint review answer')).toBeInTheDocument();
    expect(screen.queryByText('Newest sign-in review answer')).toBeNull();
    expect(calls.some((call) => call.url === '/api/chat/conversations/c-older')).toBe(true);
  });

  it('streams a first turn with a live run log, then promotes the saved thread into the rail', async () => {
    rows = [];
    details = {};
    renderChat();
    expect(await screen.findByTestId('empty-state')).toBeInTheDocument();
    await send('Any brute force today?');
    const stream = streams[0];
    expect(stream.body).toMatchObject({ message: 'Any brute force today?', persist_conversation: true, history: [] });

    await stream.push(
      start('c-new'),
      { type: 'step.start', step: { index: 1, ordinal: 1, kind: 'tool', tool: 'log_stats', label: 'Counted events', params: { window: 'last 24h' } } },
      { type: 'usage', totals: { calls: 1, total_tokens: 1200, cost: 0.002 } },
    );
    expect(screen.getByTestId('run-log-header')).toHaveTextContent('Working · 1 lookup · 1.2k tokens · $0.002');
    expect(screen.getByText('Counted events')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

    const saved = summary('c-new', 'Brute force review', '2026-10-08T10:00:00Z');
    rows = [saved];
    details = { 'c-new': detailOf(saved) };
    await stream.push(
      { type: 'step.end', step: { index: 1, ordinal: 1, kind: 'tool', tool: 'log_stats', label: 'Counted events', params: {}, status: 'ok', duration_ms: 420, summary: '1,284 events' } },
      {
        type: 'turn.done',
        response: {
          answer: 'Yes: 1,284 failed logins.',
          conversation_id: 'c-new',
          conversation_title: 'Brute force review',
          message_id: 'c-new-a',
          usage: { calls: 2, total_tokens: 2400, cost: 0.004 },
          steps: [{ index: 1, kind: 'tool', label: 'Counted events', status: 'ok', duration_ms: 420, summary: '1,284 events' }],
        },
      },
    );
    expect(await screen.findByText('Yes: 1,284 failed logins.')).toBeInTheDocument();
    expect(screen.getByTestId('meta-row')).toHaveTextContent('1 lookup · 420 ms');
    const row = await screen.findByRole('button', { name: /^Brute force review — / });
    expect(row).toHaveAttribute('aria-current', 'page');
    // The live transcript stays: the promoted thread is not re-fetched.
    expect(calls.some((call) => call.url === '/api/chat/conversations/c-new')).toBe(false);
  });

  it('retries a failed turn with the same idempotency key', async () => {
    rows = [];
    details = {};
    streamFailures = 1;
    renderChat();
    await screen.findByTestId('empty-state');
    await send('Review failed sign-ins');
    expect(await screen.findByText('Conversation storage is temporarily unavailable.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    await settle();
    const [first, second] = streamCalls();
    expect(first.body?.idempotency_key).toMatch(/^chat-/);
    expect(second.body?.idempotency_key).toBe(first.body?.idempotency_key);
    expect(second.body?.history).toEqual([]);
  });

  it('asks the templated question of an "Ask about this" topic in a new chat', async () => {
    renderChat({ opts: { topic: 'kpi:mttd' } });
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    expect(calls.some((call) => call.url === '/api/chat/topics/kpi%3Amttd')).toBe(true);
    expect(streamCalls()[0].body).toMatchObject({ message: 'What does MTTD measure here?', origin: 'starter', topic: 'kpi:mttd' });
    expect(streamCalls()[0].body).not.toHaveProperty('conversation_id');
  });

  it("prefills the palette's Ask AI text into a new chat's composer and focuses it, without sending", async () => {
    renderChat({ opts: { newChat: true, ask: 'Which hosts failed logins most today?' } });
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(box).toHaveValue('Which hosts failed logins most today?'));
    expect(document.activeElement).toBe(box);
    await settle();
    expect(streamCalls()).toHaveLength(0);
    expect(calls.some((call) => call.url.startsWith('/api/chat/topics/'))).toBe(false);
    // Sending is the analyst's own act, so the turn is origin user.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    expect(streamCalls()[0].body).toMatchObject({ message: 'Which hosts failed logins most today?' });
    expect(streamCalls()[0].body).not.toHaveProperty('origin');
  });

  it('offers the model picker only with models:read and saves the exact prompt of a turn', async () => {
    authState.denied = new Set(['models:read']);
    const lookalike = 'Logins for ad\u200bmin';
    details[NEWEST.id] = {
      ...detailOf(NEWEST),
      messages: [{ id: 'u-1', role: 'user', content: lookalike, created_at: NEWEST.created_at }, ...detailOf(NEWEST).messages.slice(1)],
    };
    renderChat();
    await screen.findByText('Newest sign-in review answer');
    expect(screen.getByTestId('composer')).toHaveAttribute('data-can-choose-model', 'false');
    fireEvent.click(screen.getAllByRole('button', { name: 'Save prompt' })[0]);
    expect(savePromptMock).toHaveBeenCalledWith(lookalike);
  });

  it('keeps a thread that was only shortened in place quiet, and names the cause of removed turns', async () => {
    rows = [summary('c-big', 'Large answer', '2026-10-08T09:30:00Z', { history_truncated: true, message_count: 2, total_message_count: 2 })];
    details = { 'c-big': detailOf(rows[0]) };
    const { unmount } = renderChat();
    await screen.findByText('Large answer answer');
    expect(screen.getByTestId('thread-trimmed-hint')).toHaveTextContent('trimmed to fit storage');
    expect(screen.queryByText(/Older turns were removed/)).toBeNull();
    unmount();

    rows = [summary('c-long', 'Long thread', '2026-10-08T09:30:00Z', { history_truncated: true, message_count: 40, total_message_count: 64 })];
    details = { 'c-long': detailOf(rows[0]) };
    renderChat();
    await screen.findByText('Long thread answer');
    expect(screen.getByText('Showing the latest 40 of 64 messages. Older turns were removed to stay within the storage limit.')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-trimmed-hint')).toBeNull();
  });

  it('highlights a deep-linked message and clears the link once the selection moves on', async () => {
    window.location.hash = '#/chat?conversationId=c-older&messageId=c-older-a';
    renderChat({ opts: { conversationId: 'c-older', messageId: 'c-older-a' } });
    expect(await screen.findByText('Older endpoint review answer')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-highlighted="true"]')).not.toBeNull());
    expect(window.location.hash).toContain('conversationId=c-older');
    fireEvent.click(screen.getByRole('button', { name: /^Newest sign-in review — / }));
    await screen.findByText('Newest sign-in review answer');
    expect(window.location.hash).toBe('#/chat');
  });

  it('says a requested conversation is gone instead of opening another one silently', async () => {
    renderChat({ opts: { conversationId: 'c-gone' } });
    expect(await screen.findByText(/This conversation is no longer available/)).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('adds an answer to the report, opens the split panel without moving focus, and announces it', async () => {
    renderChat();
    await screen.findByText('Newest sign-in review answer');
    // Focus sits in the composer; the split panel must not take it.
    const composer = screen.getByRole('textbox', { name: 'Message' });
    composer.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Add answer to report' }));
    await settle();
    const addCall = calls.find((call) => call.url === '/api/reports/add');
    expect(addCall?.body).toEqual({ conversation_id: 'c-newest', message_id: 'c-newest-a' });
    const panel = await screen.findByTestId('report-panel');
    expect(panel).toHaveAttribute('data-mode', 'split');
    expect(panel).toHaveAttribute('data-report-id', 'r-1');
    expect(screen.getByRole('separator', { name: 'Resize report panel' })).toHaveAttribute('aria-valuenow', '360');
    expect(document.activeElement).toBe(composer);
    expect(screen.getByRole('button', { name: 'Add answer to report' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Report · 1/ })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(document.body).toHaveTextContent('Added to report (1 item)');
    fireEvent.click(screen.getByRole('button', { name: 'Close report' }));
    expect(screen.queryByTestId('report-panel')).toBeNull();
  });

  it('never auto-opens the panel as an overlay: a toast offers it instead', async () => {
    // 900 px frame: strip rail, and the panel (360 + 9) would leave < 640 px.
    frameWidth(900);
    renderChat();
    await screen.findByText('Newest sign-in review answer');
    expect(screen.getByTestId('workspace-chat-page')).toHaveAttribute('data-rail', 'strip');
    fireEvent.click(screen.getByRole('button', { name: 'Add answer to report' }));
    await settle();
    expect(screen.queryByTestId('report-panel')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith('Added to report', expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) }));
    // The toast's Open shows the overlay.
    act(() => toastMock.mock.calls[0][1].action.onClick());
    expect(await screen.findByTestId('report-panel')).toHaveAttribute('data-mode', 'overlay');
    expect(screen.getByTestId('workspace-chat-page')).toHaveAttribute('data-panel', 'overlay');
  });

  it('toggles history with Ctrl/Cmd+Shift+S: docked ↔ strip, and the Sheet when the rail cannot dock', async () => {
    renderChat();
    await screen.findByText('Newest sign-in review answer');
    const frame = screen.getByTestId('workspace-chat-page');
    expect(frame).toHaveAttribute('data-rail', 'docked');
    shortcut('S');
    expect(frame).toHaveAttribute('data-rail', 'strip');
    shortcut('S');
    expect(frame).toHaveAttribute('data-rail', 'docked');
  });

  it('opens the history Sheet from the shortcut on a narrow frame', async () => {
    frameWidth(600);
    renderChat();
    await screen.findByText('Newest sign-in review answer');
    expect(screen.getByTestId('workspace-chat-page')).toHaveAttribute('data-rail', 'sheet');
    expect(screen.queryByRole('dialog', { name: 'Conversations' })).toBeNull();
    shortcut('S');
    expect(await screen.findByRole('dialog', { name: 'Conversations' })).toBeInTheDocument();
  });

  it('confirms a delete and keeps the report', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Newest sign-in review answer');
    await user.click(screen.getByRole('button', { name: 'Actions for Older endpoint review' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Its report stays in Reports');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/chat/conversations/c-older')).toBe(true),
    );
    expect(screen.queryByRole('button', { name: /^Older endpoint review — / })).toBeNull();
  });

  it('shows a failed /chat/context as a retryable error in the empty state and the composer', async () => {
    rows = [];
    details = {};
    contextFailures = 1;
    renderChat();
    const error = await screen.findByTestId('empty-context-error');
    expect(error).toHaveTextContent(/unavailable/i);
    expect(screen.getByTestId('composer').getAttribute('data-context-error')).toMatch(/unavailable/i);
    fireEvent.click(within(error).getByRole('button', { name: 'Retry context' }));
    // The retry reads the context again; the starters replace the error.
    expect(await screen.findByRole('button', { name: 'Posture now' })).toBeInTheDocument();
    expect(screen.queryByTestId('empty-context-error')).toBeNull();
    expect(calls.filter((call) => call.url.startsWith('/api/chat/context'))).toHaveLength(2);
  });

  it('keeps focus in the composer after a starter sends (the card is replaced)', async () => {
    rows = [];
    details = {};
    renderChat();
    fireEvent.click(await screen.findByRole('button', { name: 'Posture now' }));
    await settle();
    expect(streamCalls()[0].body).toMatchObject({ message: 'How are we doing right now?', origin: 'starter' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });

  it('exports a conversation from the rail and says how it went', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Newest sign-in review answer');
    await user.click(screen.getByRole('button', { name: 'Actions for Older endpoint review' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export' }));
    const markdown = await screen.findByRole('menuitem', { name: 'Markdown (.md)' });
    act(() => markdown.focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(exportConversationMock).toHaveBeenCalledTimes(1));
    const [conversation, format, options] = exportConversationMock.mock.calls[0];
    expect(conversation).toMatchObject({ id: 'c-older', title: 'Older endpoint review' });
    expect(format).toBe('markdown');
    expect(options).toEqual({ author: 'analyst' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(document.body).toHaveTextContent('Conversation exported as Markdown');
  });

  it('runs case-scoped without history, report or persistence', async () => {
    renderChat({ caseId: 'case-9' });
    expect(screen.getByTestId('workspace-chat-page')).toHaveAttribute('data-rail', 'none');
    expect(screen.getByRole('heading', { level: 2, name: 'Case case-9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Report ·/ })).toBeNull();
    expect(screen.getByTestId('composer')).toHaveAttribute('data-variant', 'case');
    await send('Summarize this case');
    expect(streamCalls()[0].body).toMatchObject({ case_id: 'case-9', message: 'Summarize this case' });
    expect(streamCalls()[0].body).not.toHaveProperty('persist_conversation');
    expect(calls.some((call) => call.url.startsWith('/api/chat/conversations'))).toBe(false);
  });
});

// axe walks the whole frame several times per spec: allow for a loaded CI runner.
describe('Workspace Chat page — accessibility', () => {
  it('is axe-clean empty, running, completed and with the report panel open', async () => {
    rows = [];
    details = {};
    const { container } = renderChat();
    await screen.findByTestId('empty-state');
    await axeClean(container);

    await send('Any brute force today?');
    await streams[0].push(start('c-new'), {
      type: 'step.start',
      step: { index: 1, ordinal: 1, kind: 'tool', tool: 'log_stats', label: 'Counted events', params: {} },
    });
    await axeClean(container);

    const saved = summary('c-new', 'Brute force review', '2026-10-08T10:00:00Z');
    rows = [saved];
    details = { 'c-new': detailOf(saved) };
    await streams[0].push({
      type: 'turn.done',
      response: {
        answer: 'Yes: 1,284 failed logins.',
        conversation_id: 'c-new',
        message_id: 'c-new-a',
        usage: { calls: 1, total_tokens: 900, cost: 0.001 },
        follow_ups: ['Which hosts?'],
      },
    });
    await screen.findByText('Yes: 1,284 failed logins.');
    await axeClean(container);

    fireEvent.click(screen.getByRole('button', { name: /Report · 0/ }));
    expect(await screen.findByTestId('report-panel')).toBeInTheDocument();
    await axeClean(container);
  }, 60_000);

  it('is axe-clean with a failed turn', async () => {
    rows = [];
    details = {};
    streamFailures = 1;
    const { container } = renderChat();
    await screen.findByTestId('empty-state');
    await send('Review failed sign-ins');
    await screen.findByRole('button', { name: 'Retry same request' });
    await axeClean(container);
  }, 30_000);
});
