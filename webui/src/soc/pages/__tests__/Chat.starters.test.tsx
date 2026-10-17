/**
 * Workspace Chat × Round 13 starters (SPEC-chat §3.9, §3.10, §3.11, §3.1 `thread`): the
 * real page, workspace, start stack and starter client over a scripted `fetch`.
 *
 * - a `send` card sends the server's question byte for byte with `origin: "starter"`,
 *   focuses the composer, and records `viewed` (with the cards shown) then `used`;
 * - an `open_conversation` card selects the analyst's own conversation, sending nothing;
 * - a `use_prompt` card runs the saved prompt through the library's Use (the pick event);
 * - a viewer who switched suggestions off gets no starters request at all;
 * - an open thread whose last answer settled long ago shows the catch-up line above the
 *   composer, and a clause sends in the SAME conversation.
 *
 * The composer is a small double (its own package); everything else is real.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { prefsState } = vi.hoisted(() => ({
  prefsState: { value: null as null | { ready: boolean; prefs: { misc: Record<string, unknown> }; patchMisc: () => void } },
}));
vi.mock('@/soc/prefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/prefs')>()),
  useOptionalPrefs: () => prefsState.value,
}));
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
    const area = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => area.current?.focus(),
      setText: (text: string) => props.engine.setDraft(text),
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
vi.mock('@/soc/chat/composer/BudgetAlert', () => ({ BudgetAlert: () => null }));
vi.mock('@/soc/chat/shortcuts/ShortcutSheet', () => ({ ShortcutSheet: () => null }));

import type { ChatConversation, ChatConversationSummary, ChatStartersInfo } from '@/lib/types';
import { AnnouncerProvider } from '@/soc/components/announcer';
import { ConfirmProvider } from '@/soc/components/ConfirmDialog';
import { TooltipProvider } from '@/ui/tooltip';
import { PICK_LIBRARY_PROMPT_EVENT } from '@/soc/chat/composer/library-events';
import { clearChatContextCache } from '@/soc/chat/useChatContext';
import { clearChatStartersCache } from '@/soc/chat/starters/useChatStarters';
import {
  CASE_HANDOFF,
  CASE_NEEDS_PERSON,
  CATCH_UP,
  CONTINUE,
  HOME_STARTERS,
  NEEDS_HUMAN,
  SAVED_BOOK,
  makeInfo,
} from '@/soc/chat/starters/__tests__/fixtures';
import Chat from '../Chat';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let rows: ChatConversationSummary[] = [];
let details: Record<string, ChatConversation> = {};
let homeInfo: ChatStartersInfo = makeInfo();
let threadInfo: ChatStartersInfo = makeInfo({ surface: 'thread', starters: [], catch_up: CATCH_UP });
const caseInfo: ChatStartersInfo = makeInfo({ surface: 'case', starters: [CASE_NEEDS_PERSON, CASE_HANDOFF] });

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

const OLDER: ChatConversationSummary = {
  id: 'c-older',
  title: 'Brute force review',
  preview: 'answer',
  created_at: '2026-10-07T08:02:00Z',
  updated_at: '2026-10-07T08:02:00Z',
  message_count: 2,
};

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

beforeEach(() => {
  calls = [];
  rows = [];
  details = {};
  homeInfo = makeInfo();
  threadInfo = makeInfo({ surface: 'thread', starters: [], catch_up: CATCH_UP });
  prefsState.value = null;
  clearChatContextCache();
  clearChatStartersCache();
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
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/context') return json(CONTEXT);
      if (path === '/api/chat/turns/active') return json([]);
      if (path === '/api/chat/starters') {
        const surface = params.get('surface');
        return json(surface === 'thread' ? threadInfo : surface === 'case' ? caseInfo : homeInfo);
      }
      if (path === '/api/chat/starters/events') return new Response(null, { status: 204 });
      if (path === '/api/chat/conversations' && method === 'GET') return json({ conversations: rows, total: rows.length, limit: 60 });
      const detail = /^\/api\/chat\/conversations\/([^/]+)$/.exec(path);
      if (detail && method === 'GET') {
        const found = details[decodeURIComponent(detail[1])];
        return found ? json(found) : json({ detail: 'Conversation not found' }, 404);
      }
      if (path === '/api/chat/stream') {
        // An open stream that never answers: enough to see what was sent.
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'application/x-ndjson' } });
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

function renderChat(props: { caseId?: string } = {}) {
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

const starterReads = () => calls.filter((c) => c.url.split('?')[0] === '/api/chat/starters');
const events = () => calls.filter((c) => c.url === '/api/chat/starters/events').map((c) => c.body);
const streams = () => calls.filter((c) => c.url === '/api/chat/stream');

describe('Workspace Chat — starters', () => {
  it('sends a card\'s server question exactly as a starter and records viewed, then used', async () => {
    const user = userEvent.setup();
    renderChat();
    const card = await screen.findByRole('button', { name: NEEDS_HUMAN.prompt });
    expect(new URLSearchParams(starterReads()[0].url.split('?')[1]).get('surface')).toBe('home');
    await user.click(card);
    await settle();
    expect(streams()).toHaveLength(1);
    expect(streams()[0].body).toMatchObject({ message: NEEDS_HUMAN.prompt, origin: 'starter' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    await waitFor(() => expect(events()).toHaveLength(2));
    const [viewed, used] = events();
    expect(viewed).toEqual({ type: 'viewed', surface: 'home', keys: HOME_STARTERS.slice(0, 3).map((s) => s.key) });
    expect(used).toEqual({ type: 'used', surface: 'home', keys: [NEEDS_HUMAN.key] });
  });

  it('opens the analyst\'s conversation from a Continue card, sending nothing', async () => {
    rows = [];
    details = { [OLDER.id]: detailOf(OLDER) };
    homeInfo = makeInfo({ starters: [CONTINUE] });
    const user = userEvent.setup();
    renderChat();
    await user.click(await screen.findByRole('button', { name: CONTINUE.prompt }));
    expect(await screen.findByText('Brute force review answer')).toBeInTheDocument();
    expect(streams()).toHaveLength(0);
    await waitFor(() => expect(events()).toContainEqual({ type: 'used', surface: 'home', keys: [CONTINUE.key] }));
  });

  it('hands focus to the composer when a Continue card is chosen from the keyboard (never <body>)', async () => {
    details = { [OLDER.id]: detailOf(OLDER) };
    homeInfo = makeInfo({ starters: [CONTINUE] });
    const user = userEvent.setup();
    renderChat();
    const card = await screen.findByRole('button', { name: CONTINUE.prompt });
    act(() => card.focus());
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Brute force review answer')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    expect(streams()).toHaveLength(0);
  });

  it('runs a saved prompt card through the library\'s Use (the analyst\'s own words, nothing sent)', async () => {
    homeInfo = makeInfo({ starters: [SAVED_BOOK] });
    const picked = vi.fn();
    window.addEventListener(PICK_LIBRARY_PROMPT_EVENT, picked);
    try {
      const user = userEvent.setup();
      renderChat();
      await user.click(await screen.findByRole('button', { name: SAVED_BOOK.prompt }));
      expect(picked).toHaveBeenCalledTimes(1);
      expect((picked.mock.calls[0][0] as CustomEvent).detail).toEqual({ promptId: 'book-x1' });
      expect(streams()).toHaveLength(0);
    } finally {
      window.removeEventListener(PICK_LIBRARY_PROMPT_EVENT, picked);
    }
  });

  it('reads and sends the case chips on the case-scoped Chat page, with no home read', async () => {
    const user = userEvent.setup();
    renderChat({ caseId: 'case-9' });
    const chip = await screen.findByRole('button', { name: CASE_HANDOFF.prompt });
    expect(starterReads().map((c) => new URLSearchParams(c.url.split('?')[1]).get('surface'))).toEqual(['case']);
    expect(new URLSearchParams(starterReads()[0].url.split('?')[1]).get('case_id')).toBe('case-9');
    await user.click(chip);
    await settle();
    expect(streams()[0].body).toMatchObject({ message: CASE_HANDOFF.prompt, case_id: 'case-9', origin: 'starter' });
    expect(streams()[0].body).not.toHaveProperty('persist_conversation');
    expect(events()).toEqual([]);
  });

  it('makes no starters request when the viewer switched suggestions off', async () => {
    prefsState.value = { ready: true, prefs: { misc: { chat_suggest_start: false } }, patchMisc: vi.fn() };
    renderChat();
    expect(await screen.findByRole('heading', { level: 3, name: /^Good / })).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole('list', { name: 'Suggested questions' })).toBeNull();
    expect(starterReads()).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  it('waits for the viewer\'s preferences before asking', async () => {
    prefsState.value = { ready: false, prefs: { misc: {} }, patchMisc: vi.fn() };
    const view = renderChat();
    await settle();
    expect(starterReads()).toHaveLength(0);
    expect(screen.getByTestId('starter-skeletons')).toBeInTheDocument();
    prefsState.value = { ready: true, prefs: { misc: {} }, patchMisc: vi.fn() };
    view.rerender(
      <AnnouncerProvider>
        <TooltipProvider>
          <ConfirmProvider>
            <Chat />
          </ConfirmProvider>
        </TooltipProvider>
      </AnnouncerProvider>,
    );
    expect(await screen.findByRole('button', { name: NEEDS_HUMAN.prompt })).toBeInTheDocument();
    expect(starterReads()).toHaveLength(1);
  });

  it('shows the catch-up line above the composer in an old thread, and a clause sends in that thread', async () => {
    rows = [OLDER];
    details = { [OLDER.id]: detailOf(OLDER) };
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Brute force review answer');
    const line = await screen.findByTestId('thread-catch-up');
    expect(line).toHaveTextContent('Since 09:12: 5 new cases (2 critical) and Wazuh quiet for 3 hours.');
    const read = starterReads().find((c) => c.url.includes('surface=thread'));
    expect(read?.url).toContain('conversation_id=c-older');
    // It sits directly above the composer.
    const composer = screen.getByRole('textbox', { name: 'Message' });
    expect(line.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(line).getByRole('button', { name: '5 new cases (2 critical)' }));
    await settle();
    expect(streams()[0].body).toMatchObject({ message: CATCH_UP.clauses[0].starter.prompt, origin: 'starter', conversation_id: 'c-older' });
    // A running turn hides it, and it does not come back in this visit.
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
    await waitFor(() => expect(events()).toContainEqual({ type: 'used', surface: 'thread', keys: [CATCH_UP.clauses[0].starter.key] }));
  });

  it('records a visit to an opened thread after 2 visible seconds, with no keys', async () => {
    rows = [OLDER];
    details = { [OLDER.id]: detailOf(OLDER) };
    renderChat();
    await screen.findByText('Brute force review answer');
    await waitFor(() => expect(events()).toContainEqual({ type: 'viewed', surface: 'thread', keys: [] }), { timeout: 3500 });
    expect(events().filter((e) => e?.type === 'viewed')).toHaveLength(1);
  });

  it('moves focus to the composer when the thread line is hidden from the keyboard', async () => {
    rows = [OLDER];
    details = { [OLDER.id]: detailOf(OLDER) };
    const user = userEvent.setup();
    renderChat();
    const line = await screen.findByTestId('thread-catch-up');
    const hide = within(line).getByRole('button', { name: 'Hide this summary' });
    act(() => hide.focus());
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });

  it('hides the thread line as soon as the composer gets text', async () => {
    rows = [OLDER];
    details = { [OLDER.id]: detailOf(OLDER) };
    const user = userEvent.setup();
    renderChat();
    await screen.findByTestId('thread-catch-up');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'x');
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
    await user.clear(screen.getByRole('textbox', { name: 'Message' }));
    await settle();
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
  });
});

void React;
