/**
 * Older messages of a long conversation (Round 12: chat keeps every message, nothing is
 * removed). `GET /api/chat/conversations/{id}` returns the newest window with
 * `earlier_message_count`; older pages come from `GET …/messages?before=&limit=`.
 *
 *  - the client: the count survives normalisation, the page read is owner-scoped by URL
 *    and bounded to the server maximum, and the whole-conversation reads (export, report
 *    methodology) page back to the start or to the answers they need, never looping on
 *    a page that brings nothing new;
 *  - `useEarlierMessages`: the cursor from the window, one page per load handed to the
 *    engine, a question kept with its answer at a page edge, an error with retry, a
 *    stale page dropped after the thread changed, and `loadUntil` for an older message;
 *  - the engine's `prependRestored`: older items go above, restored, without duplicates,
 *    and never into another conversation's transcript.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { ChatConversation, ChatConversationMessage } from '@/lib/types';
import { clearChatActivity } from '../../chat-activity/activity';
import {
  EARLIER_PAGE_SIZE,
  MAX_MESSAGE_PAGE,
  getConversationCovering,
  getConversationMessages,
  getFullConversation,
  normaliseConversation,
} from '../chat-api';
import { normaliseChatResponse } from '../stream-events';
import { resetTurnRunnerForTests } from '../turn-runner';
import { useChatEngine } from '../useChatEngine';
import { EARLIER_LOAD_ERROR, EARLIER_MISSING_ERROR, type EarlierSeekOutcome, useEarlierMessages } from '../useEarlierMessages';

/* -------------------------------------------------------------------------- */
/* A scripted server holding one long conversation.                            */
/* -------------------------------------------------------------------------- */

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];
let failNext = 0;
let pageDelay: Promise<void> | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `n` messages, a question then its answer, oldest first: q0 a0 q1 a1 … */
function transcript(n: number, prefix = 'm'): ChatConversationMessage[] {
  return Array.from({ length: n }, (_, i) => {
    const exchange = Math.floor(i / 2);
    const user = i % 2 === 0;
    const id = `${prefix}-${String(i).padStart(4, '0')}`;
    return user
      ? { id, role: 'user' as const, content: `question ${exchange}`, created_at: '2026-10-08T10:00:00Z' }
      : {
          id,
          role: 'assistant' as const,
          content: `answer ${exchange} ${'full text '.repeat(3)}`,
          created_at: '2026-10-08T10:00:05Z',
          response: { answer: `answer ${exchange} ${'full text '.repeat(3)}`, message_id: id, steps: [] },
        };
  });
}

let all: ChatConversationMessage[] = [];
const WINDOW = 100;

function windowOf(id = 'c-long'): ChatConversation {
  const start = Math.max(0, all.length - WINDOW);
  return {
    id,
    title: 'Long thread',
    preview: '',
    created_at: '2026-10-08T10:00:00Z',
    updated_at: '2026-10-08T12:00:00Z',
    message_count: all.length,
    total_message_count: all.length,
    messages: all.slice(start),
    earlier_message_count: start,
  };
}

beforeEach(() => {
  resetTurnRunnerForTests();
  clearChatActivity();
  vi.stubGlobal('BroadcastChannel', undefined);
  calls = [];
  failNext = 0;
  pageDelay = null;
  all = transcript(230);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const [path, search = ''] = url.split('?');
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/conversations/c-long' && method === 'GET') return json(windowOf());
      if (path === '/api/chat/conversations/c-long/messages' && method === 'GET') {
        if (pageDelay) await pageDelay;
        if (failNext > 0) {
          failNext -= 1;
          return json({ detail: { code: 'chat_history_unavailable', message: 'Chat history is temporarily unavailable.' } }, 503);
        }
        const params = new URLSearchParams(search);
        const before = params.get('before');
        const limit = Number(params.get('limit') ?? 50);
        const end = before ? all.findIndex((m) => m.id === before) : all.length;
        if (end < 0) return json({ detail: { code: 'message_not_found', message: 'That message is not in this conversation.' } }, 404);
        const start = Math.max(0, end - limit);
        return json({ conversation_id: 'c-long', messages: all.slice(start, end), earlier_message_count: start });
      }
      if (/^\/api\/chat\/conversations\/[^/]+(\/messages)?$/.test(path)) return json({ detail: 'conversation not found' }, 404);
      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ids = (from: number, to: number) => all.slice(from, to).map((m) => m.id);
const pageCalls = () => calls.filter((c) => c.url.startsWith('/api/chat/conversations/c-long/messages'));

/* -------------------------------------------------------------------------- */
/* The client.                                                                 */
/* -------------------------------------------------------------------------- */

describe('chat-api — older messages', () => {
  it('keeps earlier_message_count on the conversation read, and leaves it out when there is none', () => {
    const raw = { ...windowOf(), messages: all.slice(-2) };
    expect(normaliseConversation(raw)?.earlier_message_count).toBe(130);
    expect(normaliseConversation({ ...raw, earlier_message_count: 0 })).not.toHaveProperty('earlier_message_count');
    // A drifted value is dropped, never trusted.
    expect(normaliseConversation({ ...raw, earlier_message_count: -3 })).not.toHaveProperty('earlier_message_count');
    expect(normaliseConversation({ ...raw, earlier_message_count: '7' })).not.toHaveProperty('earlier_message_count');
  });

  it('reads one page before a message, oldest first, bounded to the server maximum', async () => {
    const page = await getConversationMessages('c-long', { before: all[130].id, limit: 4 });
    expect(pageCalls()[0].url).toBe(`/api/chat/conversations/c-long/messages?before=${all[130].id}&limit=4`);
    expect(page.messages.map((m) => m.id)).toEqual(all.slice(126, 130).map((m) => m.id));
    expect(page.earlier_message_count).toBe(126);
    // The full text of an answer is what the server restored.
    expect(page.messages[1].content).toBe(all[127].content);
    await getConversationMessages('c-long', { limit: 5_000 });
    expect(pageCalls()[1].url).toBe(`/api/chat/conversations/c-long/messages?limit=${MAX_MESSAGE_PAGE}`);
    // An unsafe cursor is never sent.
    await getConversationMessages('c-long', { before: '../x', limit: 0 });
    expect(pageCalls()[2].url).toBe('/api/chat/conversations/c-long/messages?limit=1');
    expect(EARLIER_PAGE_SIZE).toBe(50);
  });

  it('reads a whole conversation for an export: the window, then every older page', async () => {
    const whole = await getFullConversation('c-long');
    expect(whole.messages.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(whole).not.toHaveProperty('earlier_message_count');
    // 130 older messages in pages of the server maximum: two page reads.
    expect(pageCalls()).toHaveLength(2);
  });

  it('reads back only as far as a report needs', async () => {
    const covering = await getConversationCovering('c-long', new Set([all[95].id]));
    expect(covering.messages[0].id).toBe(all[30].id);
    expect(covering.messages.some((m) => m.id === all[95].id)).toBe(true);
    expect(covering.earlier_message_count).toBe(30);
    expect(pageCalls()).toHaveLength(1);
    // Nothing needed beyond the window: no page read.
    calls = [];
    await getConversationCovering('c-long', new Set([all[229].id]));
    expect(pageCalls()).toHaveLength(0);
  });

  it('stops instead of looping when a page brings nothing new', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push({ url, method: 'GET' });
        if (url.startsWith('/api/chat/conversations/c-long/messages')) {
          return json({ conversation_id: 'c-long', messages: all.slice(-2), earlier_message_count: 128 });
        }
        return json(windowOf());
      }),
    );
    const whole = await getFullConversation('c-long');
    expect(pageCalls()).toHaveLength(1);
    expect(whole.messages).toHaveLength(WINDOW);
  });
});

/* -------------------------------------------------------------------------- */
/* useEarlierMessages.                                                         */
/* -------------------------------------------------------------------------- */

function fakeEngine() {
  const shown: ChatConversationMessage[][] = [];
  return {
    shown,
    prependRestored: vi.fn((_id: string, messages: readonly ChatConversationMessage[]) => {
      shown.push([...messages]);
      return messages.length;
    }),
  };
}

describe('useEarlierMessages', () => {
  it('pages older messages in, a page per load, from the oldest message on screen', async () => {
    const engine = fakeEngine();
    const onLoaded = vi.fn();
    const conversation = windowOf();
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine, onLoaded }));
    expect(result.current).toMatchObject({ remaining: 130, loading: false, error: null, loadedAny: false });

    act(() => result.current.load());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(pageCalls()[0].url).toBe(`/api/chat/conversations/c-long/messages?before=${all[130].id}&limit=50`);
    expect(engine.prependRestored).toHaveBeenCalledTimes(1);
    expect(engine.prependRestored.mock.calls[0][0]).toBe('c-long');
    expect(engine.shown[0].map((m) => m.id)).toEqual(ids(80, 130));
    // Restored to the full text the server sent.
    expect(engine.shown[0][1].content).toBe(all[81].content);
    expect(result.current).toMatchObject({ remaining: 80, loadedAny: true, error: null });
    expect(onLoaded).toHaveBeenLastCalledWith(50, 80);

    // The next page ends just before the oldest message now on screen.
    act(() => result.current.load());
    await waitFor(() => expect(result.current.remaining).toBe(30));
    expect(pageCalls()[1].url).toContain(`before=${all[80].id}`);
    act(() => result.current.load());
    await waitFor(() => expect(result.current.remaining).toBe(0));
    expect(engine.shown[2].map((m) => m.id)).toEqual(ids(0, 30));
    // Nothing older: a load is a no-op.
    act(() => result.current.load());
    expect(pageCalls()).toHaveLength(3);
  });

  it('keeps a question with its answer when a page would start between them', async () => {
    const engine = fakeEngine();
    const conversation = windowOf();
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine, pageSize: 5 }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.loading).toBe(false));
    // 5 before #130 starts at #125, an answer: its question #124 is read too.
    expect(pageCalls()[1].url).toContain(`before=${all[125].id}&limit=1`);
    expect(engine.shown[0].map((m) => m.id)).toEqual(all.slice(124, 130).map((m) => m.id));
    expect(engine.shown[0][0].role).toBe('user');
    expect(result.current.remaining).toBe(124);
  });

  it('says when a page could not be loaded and loads it on retry', async () => {
    failNext = 1;
    const engine = fakeEngine();
    const conversation = windowOf();
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.error).toBe(EARLIER_LOAD_ERROR));
    expect(result.current).toMatchObject({ loading: false, remaining: 130 });
    expect(engine.prependRestored).not.toHaveBeenCalled();
    act(() => result.current.load());
    await waitFor(() => expect(result.current.remaining).toBe(80));
    expect(result.current.error).toBeNull();
  });

  it('drops a page that arrives after another conversation was opened', async () => {
    let release!: () => void;
    pageDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = fakeEngine();
    const first = windowOf();
    const { result, rerender } = renderHook(({ conversation }) => useEarlierMessages({ conversation, engine }), {
      initialProps: { conversation: first as ChatConversation | null },
    });
    act(() => result.current.load());
    rerender({ conversation: null });
    expect(result.current).toMatchObject({ remaining: 0, loading: false });
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(engine.prependRestored).not.toHaveBeenCalled();
    expect(result.current.remaining).toBe(0);
  });

  it('reads back to an older message (a search hit) in pages of the server maximum', async () => {
    const engine = fakeEngine();
    const conversation = windowOf();
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
    let found: EarlierSeekOutcome | null = null;
    await act(async () => {
      found = await result.current.loadUntil(all[12].id);
    });
    expect(found).toBe('found');
    expect(pageCalls().map((c) => new URLSearchParams(c.url.split('?')[1]).get('limit'))).toEqual(['100', '100']);
    // One prepend with everything read, so the transcript changes once.
    expect(engine.prependRestored).toHaveBeenCalledTimes(1);
    expect(engine.shown[0].map((m) => m.id)).toEqual(all.slice(0, 130).map((m) => m.id));
    expect(result.current.remaining).toBe(0);

    // A message that is not in the conversation: read to the start, not found.
    const engine2 = fakeEngine();
    const fresh = windowOf();
    const again = renderHook(() => useEarlierMessages({ conversation: fresh, engine: engine2 }));
    let missing: EarlierSeekOutcome | null = null;
    await act(async () => {
      missing = await again.result.current.loadUntil('m-nope');
    });
    expect(missing).toBe('not_found');
    expect(again.result.current.remaining).toBe(0);
    expect(again.result.current.failedSeek).toBeNull();
  });

  it('waits for a "Show earlier messages" load still running, then reads on from its cursor', async () => {
    let release!: () => void;
    pageDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = fakeEngine();
    const conversation = windowOf();
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
    act(() => result.current.load());
    expect(result.current.loading).toBe(true);
    // A search hit arrives while the page is in flight: never dropped.
    let outcome: Promise<EarlierSeekOutcome> | null = null;
    act(() => {
      outcome = result.current.loadUntil(all[12].id);
    });
    await act(async () => {
      release();
      pageDelay = null;
      await outcome;
    });
    expect(await outcome).toBe('found');
    // The manual page first (50 before #130), then the read-back from #80.
    expect(pageCalls().map((c) => new URLSearchParams(c.url.split('?')[1]).get('before'))).toEqual([
      all[130].id,
      all[80].id,
    ]);
    expect(engine.shown.map((page) => page[0].id)).toEqual([all[80].id, all[0].id]);
    expect(result.current).toMatchObject({ remaining: 0, loading: false, error: null, failedSeek: null });
  });

  it('a read-back to a message the manual load brought in ends at once, without another read', async () => {
    const engine = fakeEngine();
    const conversation = windowOf();
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
    act(() => result.current.load());
    let outcome: EarlierSeekOutcome | null = null;
    await act(async () => {
      outcome = await result.current.loadUntil(all[100].id);
    });
    expect(outcome).toBe('found');
    expect(pageCalls()).toHaveLength(1);
  });

  it('keeps what a failed read-back read, names the message, and resumes the read-back on Retry', async () => {
    const engine = fakeEngine();
    const conversation = windowOf();
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
    // The first page (100 before #130) works, the second fails.
    let served = 0;
    const scripted = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/messages?') && ++served === 2) {
          calls.push({ url: String(input), method: 'GET' });
          return json({ detail: { code: 'chat_history_unavailable', message: 'unavailable' } }, 503);
        }
        return scripted(input, init);
      }),
    );
    let outcome: EarlierSeekOutcome | null = null;
    await act(async () => {
      outcome = await result.current.loadUntil(all[12].id);
    });
    expect(outcome).toBe('failed');
    expect(result.current).toMatchObject({
      error: EARLIER_LOAD_ERROR,
      errorKind: 'failed',
      failedSeek: all[12].id,
      remaining: 30,
      loading: false,
    });
    expect(engine.shown[0].map((m) => m.id)).toEqual(ids(30, 130));

    // Retry (the control's load) resumes the read-back from where it stopped: one read
    // of the server maximum before #30, never a 50-message page.
    act(() => result.current.load());
    await waitFor(() => expect(result.current.failedSeek).toBeNull());
    const last = pageCalls().at(-1)!.url;
    expect(new URLSearchParams(last.split('?')[1]).get('before')).toBe(all[30].id);
    expect(new URLSearchParams(last.split('?')[1]).get('limit')).toBe(String(MAX_MESSAGE_PAGE));
    expect(result.current).toMatchObject({ error: null, errorKind: null, remaining: 0 });
    expect(engine.shown.at(-1)!.some((m) => m.id === all[12].id)).toBe(true);
  });

  it('marks a 404 as missing (the messages are gone), never as a read to retry', async () => {
    const engine = fakeEngine();
    // A window whose oldest message the server no longer knows (deleted elsewhere).
    const conversation = { ...windowOf(), messages: [{ ...windowOf().messages[0], id: 'm-gone' }, ...windowOf().messages.slice(1)] };
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
    act(() => result.current.load());
    await waitFor(() => expect(result.current.error).toBe(EARLIER_MISSING_ERROR));
    expect(result.current.errorKind).toBe('missing');
    expect(result.current.failedSeek).toBeNull();
    // A fresh read of the conversation (Reopen) starts over without the error.
    const { result: reopened } = renderHook(() => useEarlierMessages({ conversation: windowOf(), engine }));
    expect(reopened.current).toMatchObject({ error: null, errorKind: null, remaining: 130 });
  });

  it("resolves a read-back that hits a 404 as 'missing', with the kind already set", async () => {
    const engine = fakeEngine();
    const conversation = { ...windowOf(), messages: [{ ...windowOf().messages[0], id: 'm-gone' }, ...windowOf().messages.slice(1)] };
    const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
    let outcome: EarlierSeekOutcome | null = null;
    await act(async () => {
      outcome = await result.current.loadUntil(all[12].id);
    });
    // The caller learns the kind from the outcome (its last render still had no error).
    expect(outcome).toBe('missing');
    expect(result.current).toMatchObject({ error: EARLIER_MISSING_ERROR, errorKind: 'missing', failedSeek: all[12].id, loading: false });
    expect(engine.prependRestored).not.toHaveBeenCalled();
  });

  it('has nothing to page for a draft, case chat or a short conversation', () => {
    const engine = fakeEngine();
    const short = { ...windowOf(), messages: all.slice(-4), earlier_message_count: undefined };
    for (const conversation of [null, undefined, short]) {
      const { result } = renderHook(() => useEarlierMessages({ conversation, engine }));
      expect(result.current.remaining).toBe(0);
      act(() => result.current.load());
    }
    expect(pageCalls()).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The engine.                                                                 */
/* -------------------------------------------------------------------------- */

describe('useChatEngine — prependRestored', () => {
  it('puts older saved messages above the transcript, restored, once, and only in their own conversation', async () => {
    const conversation = windowOf();
    const { result } = renderHook(() => useChatEngine({ conversation }));
    await waitFor(() => expect(result.current.items).toHaveLength(WINDOW));
    expect(result.current.items[0].key).toBe(all[130].id);

    let added = 0;
    act(() => {
      added = result.current.prependRestored('c-long', all.slice(126, 132));
    });
    // #130 and #131 are already shown: only the four older ones go in.
    expect(added).toBe(4);
    expect(result.current.items.slice(0, 5).map((item) => item.key)).toEqual(all.slice(126, 131).map((m) => m.id));
    const answer = result.current.items[1];
    expect(answer).toMatchObject({ kind: 'assistant', restored: true, status: 'done' });
    expect(answer.kind === 'assistant' && answer.response?.answer).toBe(all[127].content);

    // Another conversation's messages never land here.
    act(() => {
      added = result.current.prependRestored('c-other', all.slice(0, 4));
    });
    expect(added).toBe(0);
    expect(result.current.items).toHaveLength(WINDOW + 4);
  });
});

describe('the saved question id on a live answer (user_message_id)', () => {
  it('survives normalisation, and anything but an id reads as none', () => {
    const live = normaliseChatResponse({ answer: 'x', message_id: 'a-1', user_message_id: 'q-1' });
    expect(live).toMatchObject({ message_id: 'a-1', user_message_id: 'q-1' });
    expect(normaliseChatResponse({ answer: 'x', user_message_id: 7 })?.user_message_id).toBeNull();
    expect(normaliseChatResponse({ answer: 'x' })?.user_message_id).toBeNull();
  });
});
