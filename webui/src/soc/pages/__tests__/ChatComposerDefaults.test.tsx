/**
 * Workspace Chat with the REAL composer, engine and context hooks (browser-QA D2): the
 * composer must never present a selection the analyst did not make.
 *
 *  - A fresh workspace shows "All sources · 24h" and no model chip.
 *  - Reopening a saved thread whose stored `model` / `source_id` are what the server
 *    RESOLVED (the default model, the primary source) keeps "All sources · 24h", shows
 *    no model chip, and sends neither on the next turn.
 *  - Choosing a non-default model still shows the removable chip and sends it; picking
 *    the default by name is the same as "Default model".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'analyst', hasPermission: () => true }),
}));
vi.mock('@/soc/chat/report/ReportPanel', () => ({ default: () => null, ReportPanel: () => null }));
vi.mock('@/soc/chat/shortcuts/ShortcutSheet', () => ({ ShortcutSheet: () => null }));

import type { ChatConversation, ChatConversationSummary } from '@/lib/types';
import { AnnouncerProvider } from '@/soc/components/announcer';
import { ConfirmProvider } from '@/soc/components/ConfirmDialog';
import { TooltipProvider } from '@/ui/tooltip';
import { makeContext } from '@/soc/chat/composer/__tests__/fixtures';
import { clearChatContextCache } from '@/soc/chat/useChatContext';
import Chat from '../Chat';

const DEFAULT_MODEL = 'gpt-default';
const OTHER_MODEL = 'gpt-other';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];

const SOURCES = [
  { id: 'demo-splunk', display_name: 'Splunk Enterprise Security — HEC', source_type: 'splunk', enabled: true, can_browse: true },
  { id: 'demo-wazuh', display_name: 'Wazuh Manager', source_type: 'wazuh', enabled: true, can_browse: true },
];

const ROW: ChatConversationSummary = {
  id: 'c-1',
  title: 'Earlier review',
  preview: 'Earlier answer',
  created_at: '2026-10-08T09:00:00Z',
  updated_at: '2026-10-08T09:01:00Z',
  message_count: 2,
};

/** What the server stores: the EFFECTIVE model and the primary source it resolved. */
const DETAIL: ChatConversation = {
  ...ROW,
  model: DEFAULT_MODEL,
  source_id: 'demo-splunk',
  messages: [
    { id: 'm1', role: 'user', content: 'Earlier question', created_at: ROW.created_at },
    {
      id: 'm2',
      role: 'assistant',
      content: 'Earlier answer',
      created_at: ROW.updated_at,
      model: DEFAULT_MODEL,
      source_name: 'Splunk Enterprise Security — HEC',
      response: { answer: 'Earlier answer', message_id: 'm2', effective_model: DEFAULT_MODEL, steps: [] },
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stream that never ends: the test only inspects the request body. */
function openStream(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

beforeEach(() => {
  calls = [];
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
      if (path === '/api/sources') return json({ sources: SOURCES });
      if (path === '/api/models') {
        return json({
          providers: { openai: [DEFAULT_MODEL, OTHER_MODEL] },
          capabilities: { [DEFAULT_MODEL]: ['chat'], [OTHER_MODEL]: ['chat'] },
        });
      }
      if (path === '/api/chat/context') {
        // Like the server: a context read for an override reports THAT model.
        const requested = new URLSearchParams(url.split('?')[1] ?? '').get('model');
        return json(makeContext({ model: requested || DEFAULT_MODEL, history_tokens: 0 }));
      }
      if (path === '/api/chat/conversations' && method === 'GET') {
        return json({ conversations: [ROW], total: 1, limit: 50 });
      }
      if (path === `/api/chat/conversations/${ROW.id}` && method === 'GET') return json(DETAIL);
      if (path === '/api/chat/stream') return openStream();
      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

function renderChat() {
  return render(
    <AnnouncerProvider>
      <TooltipProvider>
        <ConfirmProvider>
          <Chat />
        </ConfirmProvider>
      </TooltipProvider>
    </AnnouncerProvider>,
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

const scopeChip = () => screen.findByRole('button', { name: /^Scope: / });
const modelChip = () => screen.queryByRole('button', { name: /^Use the default model instead of/ });
const streamBodies = () => calls.filter((c) => c.url.split('?')[0] === '/api/chat/stream').map((c) => c.body ?? {});

describe('Workspace Chat composer defaults (D2)', () => {
  it('a fresh workspace shows "All sources · 24h" and no model chip', async () => {
    renderChat();
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/sources'))).toBe(true));
    await settle();
    expect(await scopeChip()).toHaveTextContent('All sources · 24h');
    expect(modelChip()).toBeNull();
  });

  it('reopening a thread never adopts the stored model or source', async () => {
    const user = userEvent.setup();
    renderChat();
    const rail = await screen.findByRole('navigation', { name: 'Chat history' });
    await user.click(await within(rail).findByText('Earlier review'));
    await screen.findByText('Earlier answer', { selector: 'p, p *' });
    await settle();

    expect(await scopeChip()).toHaveTextContent('All sources · 24h');
    expect(modelChip()).toBeNull();

    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' });
    await user.type(textarea, 'Follow on{Enter}');
    await waitFor(() => expect(streamBodies()).toHaveLength(1));
    const body = streamBodies()[0];
    expect(body).toMatchObject({ message: 'Follow on', conversation_id: ROW.id });
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('source_id');
  });

  it('a chosen non-default model shows the removable chip; the default by name does not', async () => {
    const user = userEvent.setup();
    renderChat();
    await settle();
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: /Model/ }));
    const defaultRow = await screen.findByRole('menuitemradio', { name: /Default model/ });
    expect(defaultRow).toHaveTextContent(DEFAULT_MODEL);
    // The default is listed once, as "Default model", never again by name.
    expect(screen.queryByRole('menuitemradio', { name: DEFAULT_MODEL })).toBeNull();
    // Radix items select on click (fireEvent: user-event's pointer model skips them in jsdom).
    fireEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp(OTHER_MODEL) }));
    await waitFor(() => expect(modelChip()).not.toBeNull());

    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' });
    await user.type(textarea, 'Use the other model{Enter}');
    await waitFor(() => expect(streamBodies()).toHaveLength(1));
    expect(streamBodies()[0]).toMatchObject({ model: OTHER_MODEL });
    expect(streamBodies()[0]).not.toHaveProperty('source_id');
  });
});
