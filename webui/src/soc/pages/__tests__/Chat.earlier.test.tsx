/**
 * Workspace Chat page — a long conversation (Round 12: chat keeps every message; the
 * transcript opens on the newest messages and pages the older ones in).
 *
 * The real page, workspace, hooks, chat client and transcript over a scripted `fetch`
 * holding one 70-message conversation: the scripted server returns its newest 10 (the
 * real one returns 100; a small window keeps jsdom fast) with `earlier_message_count:
 * 60`, and `GET …/messages?before=&limit=` serves older pages.
 *
 *  - "Show earlier messages · 60 more" loads the previous page above the transcript,
 *    announces it, and marks the start once everything is shown;
 *  - a failed page says so and Retry loads it;
 *  - a link to a message older than the window pages back to it and highlights it;
 *  - Export writes the WHOLE conversation, never only its newest messages;
 *  - nothing on screen claims a message cap.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/auth', () => {
  const auth = () => ({ username: 'analyst', hasPermission: () => true });
  return { useAuth: auth, useOptionalAuth: auth };
});

vi.mock('@/soc/chat/composer/Composer', async () => {
  const React = await import('react');
  type Engine = import('@/soc/chat/useChatEngine').ChatEngine;
  const Composer = React.forwardRef(function ComposerDouble(
    props: { engine: Engine },
    ref: React.Ref<{ focus: () => void; setText: (text: string) => void; savePrompt: (text: string) => void }>,
  ) {
    React.useImperativeHandle(ref, () => ({ focus: () => {}, setText: () => {}, savePrompt: () => {} }));
    return React.createElement('form', { 'data-testid': 'composer' }, React.createElement('textarea', { 'aria-label': 'Message', value: props.engine.draft, readOnly: true }));
  });
  return { Composer };
});
vi.mock('@/soc/chat/empty/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('@/soc/chat/composer/BudgetAlert', () => ({ BudgetAlert: () => null }));
vi.mock('@/soc/chat/shortcuts/ShortcutSheet', () => ({ ShortcutSheet: () => null }));
vi.mock('@/soc/chat/report/ReportPanel', () => ({ default: () => null, ReportPanel: () => null }));

const { exportConversationMock, toastMock } = vi.hoisted(() => ({
  exportConversationMock: vi.fn(),
  toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: toastMock }));
vi.mock('@/soc/chat/report/export/conversation', () => ({ exportConversation: exportConversationMock }));

import type { ChatConversationMessage, ChatConversationSummary, NavOpts } from '@/lib/types';
import { AnnouncerProvider } from '@/soc/components/announcer';
import { ConfirmProvider } from '@/soc/components/ConfirmDialog';
import { TooltipProvider } from '@/ui/tooltip';
import { clearChatContextCache } from '@/soc/chat/useChatContext';
import Chat from '../Chat';

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];
let pageFailures = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
  starters: [],
};

const TOTAL = 70;
const WINDOW = 10;
/** q0 a0 q1 a1 …: 70 messages, every answer with its full text. */
const ALL: ChatConversationMessage[] = Array.from({ length: TOTAL }, (_, i) => {
  const n = Math.floor(i / 2);
  const id = `m-${String(i).padStart(4, '0')}`;
  return i % 2 === 0
    ? { id, role: 'user' as const, content: `Question number ${n}`, created_at: '2026-10-08T10:00:00Z' }
    : {
        id,
        role: 'assistant' as const,
        content: `Answer number ${n}`,
        created_at: '2026-10-08T10:00:05Z',
        response: { answer: `Answer number ${n}`, message_id: id, usage: null, steps: [] },
      };
});

const LONG: ChatConversationSummary = {
  id: 'c-long',
  title: 'Long investigation',
  preview: 'Answer number 34',
  created_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-08T12:00:00Z',
  message_count: TOTAL,
  total_message_count: TOTAL,
  total_tokens: 99000,
  total_cost: 0.4,
};

beforeEach(() => {
  calls = [];
  pageFailures = 0;
  exportConversationMock.mockReset().mockResolvedValue({ ok: true, message: 'Conversation exported as Markdown' });
  toastMock.mockReset();
  toastMock.error.mockReset();
  clearChatContextCache();
  window.localStorage.clear();
  window.location.hash = '#/chat';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const [path, search = ''] = url.split('?');
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/context') return json(CONTEXT);
      if (path === '/api/chat/conversations' && method === 'GET') return json({ conversations: [LONG], total: 1, limit: 60 });
      if (path === '/api/chat/conversations/c-long' && method === 'GET') {
        return json({ ...LONG, messages: ALL.slice(TOTAL - WINDOW), earlier_message_count: TOTAL - WINDOW });
      }
      if (path === '/api/chat/conversations/c-long/messages' && method === 'GET') {
        if (pageFailures > 0) {
          pageFailures -= 1;
          return json({ detail: { code: 'chat_history_unavailable', message: 'Chat history is temporarily unavailable.' } }, 503);
        }
        const params = new URLSearchParams(search);
        const before = params.get('before');
        const limit = Number(params.get('limit') ?? 50);
        const end = before ? ALL.findIndex((m) => m.id === before) : ALL.length;
        const start = Math.max(0, end - limit);
        return json({ conversation_id: 'c-long', messages: ALL.slice(start, end), earlier_message_count: start });
      }
      if (path === '/api/chat/conversations/c-long/read' && method === 'POST') return new Response(null, { status: 204 });
      if (path === '/api/chat/turns/active') return json([]);
      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

const settle = (ms = 60) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

function renderChat(props: { opts?: NavOpts } = {}) {
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

const pageCalls = () => calls.filter((c) => c.url.startsWith('/api/chat/conversations/c-long/messages'));

describe('Workspace Chat — a long conversation', () => {
  it('opens on the newest messages and loads earlier ones above with "Show earlier messages"', async () => {
    const user = userEvent.setup();
    renderChat();
    expect(await screen.findByText('Answer number 34')).toBeInTheDocument();
    expect(screen.getByText('Question number 30')).toBeInTheDocument();
    expect(screen.queryByText('Question number 29')).toBeNull();
    // No cap is claimed: the conversation simply has earlier messages.
    expect(document.body).not.toHaveTextContent(/newest 100|100 messages|were removed|storage limit/);

    await user.click(screen.getByRole('button', { name: 'Show earlier messages · 60 more' }));
    expect(await screen.findByText('Question number 5')).toBeInTheDocument();
    expect(pageCalls()[0].url).toBe('/api/chat/conversations/c-long/messages?before=m-0060&limit=50');
    // The older page is above the window, in order, each answer whole.
    const older = screen.getByText('Question number 5');
    const newer = screen.getByText('Question number 30');
    expect(older.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Answer number 29')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show earlier messages · 10 more' })).toBeInTheDocument();
    await waitFor(() => expect(document.body).toHaveTextContent('Loaded 50 earlier messages'));

    await user.click(screen.getByRole('button', { name: /Show earlier messages/ }));
    expect(await screen.findByText('Question number 0')).toBeInTheDocument();
    expect(pageCalls()[1].url).toBe('/api/chat/conversations/c-long/messages?before=m-0010&limit=50');
    expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull();
    expect(screen.getByText('Start of the conversation')).toBeInTheDocument();
    // Every message once.
    expect(screen.getAllByText(/^Question number \d+$/)).toHaveLength(TOTAL / 2);
  }, 20_000);

  it('says when a page could not be loaded and loads it on Retry', async () => {
    const user = userEvent.setup();
    pageFailures = 1;
    renderChat();
    await screen.findByText('Answer number 34');
    await user.click(screen.getByRole('button', { name: /Show earlier messages/ }));
    expect(await screen.findByText('Earlier messages could not be loaded.')).toHaveAttribute('role', 'alert');
    await user.click(screen.getByRole('button', { name: 'Retry loading earlier messages' }));
    expect(await screen.findByText('Question number 5')).toBeInTheDocument();
    expect(screen.queryByText('Earlier messages could not be loaded.')).toBeNull();
  });

  it('pages back to a linked message older than the window and highlights it', async () => {
    renderChat({ opts: { conversationId: 'c-long', messageId: 'm-0021' } });
    expect(await screen.findByText('Answer number 10')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-message-id="m-0021"][data-highlighted="true"]')).not.toBeNull());
    // Read back in pages of the server maximum until the message is there.
    expect(pageCalls().map((c) => new URLSearchParams(c.url.split('?')[1]).get('limit'))).toEqual(['100']);
  });

  it('exports the whole conversation, not only the messages on screen', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Answer number 34');
    await user.click(screen.getByRole('button', { name: 'Actions for Long investigation' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export' }));
    const markdown = await screen.findByRole('menuitem', { name: 'Markdown (.md)' });
    act(() => markdown.focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(exportConversationMock).toHaveBeenCalledTimes(1));
    const [conversation] = exportConversationMock.mock.calls[0];
    expect(conversation.messages).toHaveLength(TOTAL);
    expect(conversation.messages[0]).toMatchObject({ id: 'm-0000', content: 'Question number 0' });
    expect(conversation).not.toHaveProperty('earlier_message_count');
    await settle(150);
  });
});
