/**
 * Workspace Chat page × "Ask AI" chips (Round 12 WP-ASK; SPEC §4 WP-ASK, A7): a chip's
 * TYPED reference (`NavOpts.entity`) is resolved by the server
 * (`POST /api/chat/entity-question`, the value in the body, never the URL) and the
 * server's question is sent with `origin: "starter"` in a new chat, exactly once (also
 * under StrictMode). Nothing is prefilled, so a held Enter in the composer can never
 * send words the analyst did not choose; a value the server refuses (422) says so and
 * sends nothing; a malformed reference never reaches the server.
 *
 * The real page, workspace shell, hooks, chat client and NDJSON reader run over a
 * scripted `fetch`; the composer, empty state and report panel are small doubles (the
 * same doubles as `Chat.test.tsx`), so this suite pins the page's hand-off only.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/soc/auth', () => {
  const auth = { username: 'analyst', hasPermission: () => true };
  return { useAuth: () => auth, useOptionalAuth: () => auth };
});

vi.mock('@/soc/chat/composer/Composer', async () => {
  const React = await import('react');
  type Engine = import('@/soc/chat/useChatEngine').ChatEngine;
  const Composer = React.forwardRef(function ComposerDouble(
    props: { engine: Engine },
    ref: React.Ref<{ focus: () => void; setText: (text: string) => void; savePrompt: (text: string) => void }>,
  ) {
    const area = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => area.current?.focus(),
      setText: (text: string) => {
        props.engine.setDraft(text);
        area.current?.focus();
      },
      savePrompt: () => undefined,
    }));
    return React.createElement('textarea', {
      ref: area,
      'aria-label': 'Message',
      value: props.engine.draft,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.engine.setDraft(event.target.value),
    });
  });
  return { Composer };
});
vi.mock('@/soc/chat/empty/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('@/soc/chat/composer/BudgetAlert', () => ({ BudgetAlert: () => null }));
vi.mock('@/soc/chat/shortcuts/ShortcutSheet', () => ({ ShortcutSheet: () => null }));
vi.mock('@/soc/chat/report/ReportPanel', () => ({ default: () => null, ReportPanel: () => null }));

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: toastMock }));

import type { NavOpts } from '@/lib/types';
import { AnnouncerProvider } from '@/soc/components/announcer';
import { ConfirmProvider } from '@/soc/components/ConfirmDialog';
import { TooltipProvider } from '@/ui/tooltip';
import { clearChatContextCache } from '@/soc/chat/useChatContext';
import Chat from '../Chat';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

const QUESTION =
  'Investigate everything about IP 203.0.113.77: related cases, log activity over the last 7 days, and the hosts and users seen with it.';
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

let calls: Call[] = [];
let entityReply: { status: number; body: unknown } = { status: 200, body: {} };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  entityReply = { status: 200, body: { kind: 'ip', value: '203.0.113.77', question: QUESTION } };
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
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      const path = url.split('?')[0];
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/context') return json(CONTEXT);
      if (path === '/api/chat/conversations' && method === 'GET') return json({ conversations: [], total: 0, limit: 50 });
      if (path === '/api/chat/entity-question' && method === 'POST') return json(entityReply.body, entityReply.status);
      if (path === '/api/chat/stream') {
        // A turn that stays open: enough to see what was sent.
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'Content-Type': 'application/x-ndjson' },
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

function shell(opts: NavOpts) {
  return (
    <AnnouncerProvider>
      <TooltipProvider>
        <ConfirmProvider>
          <Chat opts={opts} />
        </ConfirmProvider>
      </TooltipProvider>
    </AnnouncerProvider>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

const entityCalls = () => calls.filter((call) => call.url === '/api/chat/entity-question');
const streamCalls = () => calls.filter((call) => call.url === '/api/chat/stream');

describe('Workspace Chat page — Ask AI chips', () => {
  it("sends the server's question as a starter, with the reference in the body, never the URL", async () => {
    render(shell({ newChat: true, entity: { kind: 'ip', value: '203.0.113.77' } }));
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    expect(entityCalls()).toHaveLength(1);
    expect(entityCalls()[0]).toMatchObject({ method: 'POST', body: { kind: 'ip', value: '203.0.113.77' } });
    expect(entityCalls()[0].url).not.toContain('203.0.113.77');
    // The server's words, not the analyst's: the taint rule keeps the value un-authored.
    expect(streamCalls()[0].body).toMatchObject({ message: QUESTION, origin: 'starter' });
    expect(streamCalls()[0].body).not.toHaveProperty('topic');
  });

  it('prefills nothing, so a held Enter in the composer cannot send anything', async () => {
    render(shell({ newChat: true, entity: { kind: 'ip', value: '203.0.113.77' } }));
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toHaveValue('');
    fireEvent.keyDown(box, { key: 'Enter', repeat: true });
    fireEvent.keyDown(box, { key: 'Enter', repeat: true });
    await settle();
    expect(streamCalls()).toHaveLength(1);
  });

  it('asks exactly once under StrictMode (the app root)', async () => {
    render(<React.StrictMode>{shell({ newChat: true, entity: { kind: 'host', value: 'dc01' } })}</React.StrictMode>);
    await waitFor(() => expect(streamCalls()).toHaveLength(1));
    await settle();
    expect(entityCalls()).toHaveLength(1);
    expect(streamCalls()).toHaveLength(1);
  });

  it('says so and sends nothing when the server has no question for the value', async () => {
    entityReply = { status: 422, body: { detail: 'There is no question to ask about that value.' } };
    render(shell({ newChat: true, entity: { kind: 'user', value: 'pnair' } }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('There is no question to ask about that value.'));
    await settle();
    expect(streamCalls()).toHaveLength(0);
  });

  it('refuses a reply that is not a question it can send whole', async () => {
    entityReply = { status: 200, body: { kind: 'ip', value: '203.0.113.77', question: '' } };
    render(shell({ newChat: true, entity: { kind: 'ip', value: '203.0.113.77' } }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Could not start that question. Try again.'));
    expect(streamCalls()).toHaveLength(0);
  });

  it('never asks the server about a malformed reference', async () => {
    for (const entity of [
      { kind: 'process', value: 'cmd.exe' },
      { kind: 'ip', value: '' },
      { kind: 'user', value: 'two words' },
      { kind: 'ip', value: 'x'.repeat(600) },
    ]) {
      const view = render(shell({ newChat: true, entity }));
      await settle();
      view.unmount();
    }
    expect(entityCalls()).toHaveLength(0);
    expect(streamCalls()).toHaveLength(0);
  });
});
