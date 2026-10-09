/**
 * useChatEngine — the turn state machine over a mocked fetch whose `/api/chat/stream`
 * responses are NDJSON streams the test drives line by line: steps, usage, text
 * deltas and reset, turn.done as the truth, turn.error, Stop (server cancel and a
 * forced local stop), connection lost → one replay with the same key, the /chat
 * fallback, Retry same request vs Ask again, Continue, origins, case mode, saved
 * conversation hydration, stale guards and the live-mode preference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { ChatConversation, ChatRequest } from '@/lib/types';
import {
  CHAT_HISTORY_EXCHANGES,
  CONTINUE_PROMPT,
  STREAM_MODE_STORAGE_KEY,
  boundHistory,
  isUnsavedTurn,
  recoveryDelayMs,
  retriesWithSameKey,
  recoveryWindowMs,
  replayHistorySize,
  useChatEngine,
  type ChatAssistantItem,
  type ChatEngine,
  type UseChatEngineOptions,
} from '../useChatEngine';

const encoder = new TextEncoder();

interface StreamHandle {
  body: ChatRequest;
  push: (event: unknown) => void;
  close: () => void;
  fail: () => void;
}

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let recorded: Recorded[] = [];
let streams: StreamHandle[] = [];
/** Override a route; return undefined to fall through to the defaults. */
let override: ((call: Recorded) => Response | undefined) | null = null;
let userPrefs: Record<string, unknown> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function openStream(body: ChatRequest): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  streams.push({
    body,
    push: (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
    close: () => controller.close(),
    fail: () => controller.error(new TypeError('network down')),
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

beforeEach(() => {
  recorded = [];
  streams = [];
  override = null;
  userPrefs = {};
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Recorded = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      recorded.push(call);
      const custom = override?.(call);
      if (custom) return custom;
      if (call.url === '/api/prefs/user' && call.method === 'GET') return json(userPrefs);
      if (call.url === '/api/prefs/user' && call.method === 'PUT') return json({ ...userPrefs, ...call.body });
      if (call.url === '/api/chat/stream') return openStream(call.body as unknown as ChatRequest);
      if (/^\/api\/chat\/turns\/[^/]+\/cancel$/.test(call.url)) return json({ ok: true });
      throw new Error(`Unhandled request: ${call.method} ${call.url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Let promises, the stream reader and one animation frame settle inside act. */
const settle = (ms = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function mountEngine(options: UseChatEngineOptions = {}) {
  const hook = renderHook((props: UseChatEngineOptions) => useChatEngine(props), { initialProps: options });
  await settle();
  return hook;
}

async function push(stream: StreamHandle, ...events: unknown[]) {
  await act(async () => {
    for (const event of events) stream.push(event);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

const start = (turnId = 'turn-1', extra: Record<string, unknown> = {}) => ({
  type: 'turn.start',
  turn_id: turnId,
  conversation_id: null,
  model: 'demo-model',
  stream_mode: 'steps',
  replayed: false,
  estimate: { prompt_tokens: 900 },
  ...extra,
});
const done = (response: Record<string, unknown>) => ({ type: 'turn.done', response: { answer: 'Answer', ...response } });
const assistant = (engine: ChatEngine, index = -1): ChatAssistantItem => {
  const items = engine.items.filter((item): item is ChatAssistantItem => item.kind === 'assistant');
  return items[index < 0 ? items.length + index : index];
};
const streamCalls = () => recorded.filter((call) => call.url === '/api/chat/stream');

describe('useChatEngine — streaming a turn', () => {
  it('shows live steps and running usage, then renders turn.done as the truth', async () => {
    const persisted = vi.fn();
    const settled = vi.fn();
    const { result } = await mountEngine({ onConversationPersisted: persisted, onTurnSettled: settled });

    act(() => {
      expect(result.current.send('Any brute force today?')).toBe(true);
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.items.map((item) => item.kind)).toEqual(['user', 'assistant']);
    await settle();
    const stream = streams[0];
    expect(stream.body).toMatchObject({
      message: 'Any brute force today?',
      history: [],
      persist_conversation: true,
      stream_mode: 'steps',
    });
    expect(stream.body.idempotency_key).toMatch(/^chat-[A-Za-z0-9._:-]{8,}$/);
    expect(stream.body).not.toHaveProperty('origin');

    await push(
      stream,
      start(),
      { type: 'step.start', step: { index: 1, ordinal: 1, kind: 'tool', tool: 'log_stats', label: 'Counted events', params: { from: 'now-24h' } } },
      { type: 'usage', totals: { calls: 1, total_tokens: 1200, cost: 0.002 } },
    );
    let live = assistant(result.current).live;
    expect(live?.turnId).toBe('turn-1');
    expect(live?.estimatePromptTokens).toBe(900);
    expect(live?.steps).toMatchObject([{ index: 1, tool: 'log_stats', status: 'running', params: { from: 'now-24h' } }]);
    expect(live?.usage?.total_tokens).toBe(1200);
    expect(result.current.canStop).toBe(true);

    await push(stream, {
      type: 'step.end',
      step: { index: 1, ordinal: 1, kind: 'tool', tool: 'log_stats', label: 'Counted events', params: {}, status: 'ok', duration_ms: 420, summary: '1,284 events', rows: 1284 },
    });
    live = assistant(result.current).live;
    expect(live?.steps[0]).toMatchObject({ status: 'ok', result: { summary: '1,284 events', rows: 1284 } });

    await push(
      stream,
      done({
        answer: 'Yes: 1,284 failed logins.',
        conversation_id: 'conv-1',
        conversation_title: 'Brute force review',
        message_id: 'msg-2',
        usage: { calls: 2, total_tokens: 2400, cost: 0.004 },
        steps: [{ index: 1, label: 'Counted events', status: 'ok' }],
      }),
    );
    const item = assistant(result.current);
    expect(item).toMatchObject({ status: 'done', live: null, messageId: 'msg-2' });
    expect(item.response?.answer).toBe('Yes: 1,284 failed logins.');
    expect(item.response?.usage?.total_tokens).toBe(2400);
    expect(result.current.busy).toBe(false);
    expect(result.current.conversationId).toBe('conv-1');
    expect(persisted).toHaveBeenCalledWith('conv-1', 'Brute force review');
    expect(settled).toHaveBeenCalledOnce();

    // The next request carries the exchange as history and the saved conversation id.
    act(() => {
      result.current.send('And yesterday?');
    });
    await settle();
    expect(streams[1].body).toMatchObject({
      conversation_id: 'conv-1',
      history: [
        { role: 'user', content: 'Any brute force today?' },
        { role: 'assistant', content: 'Yes: 1,284 failed logins.' },
      ],
    });
  });

  it('streams text deltas in Live text mode and honours text.reset', async () => {
    userPrefs = { misc: { chat_stream_mode: 'text' } };
    const { result } = await mountEngine();
    expect(result.current.streamMode).toBe('text');
    expect(result.current.effectiveStreamMode).toBe('text');

    act(() => {
      result.current.send('Summarise');
    });
    await settle();
    expect(streams[0].body.stream_mode).toBe('text');
    await push(streams[0], start('turn-1', { stream_mode: 'text' }), { type: 'text.delta', text: 'Draft ' }, { type: 'text.delta', text: 'one' });
    expect(assistant(result.current).live?.text).toBe('Draft one');
    await push(streams[0], { type: 'text.reset' });
    expect(assistant(result.current).live?.text).toBe('');
    await push(streams[0], { type: 'text.delta', text: 'Final' }, done({ answer: 'Final answer' }));
    expect(assistant(result.current).response?.answer).toBe('Final answer');
  });

  it('keeps a turn.error visible with Retry same request (same key, failed pair replaced)', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Posture now');
    });
    await settle();
    const key = streams[0].body.idempotency_key;
    await push(streams[0], start(), { type: 'turn.error', code: 'provider_unavailable', message: 'Model not configured', retryable: true });
    const failed = assistant(result.current);
    expect(failed).toMatchObject({ status: 'error', failure: { kind: 'turn_error', code: 'provider_unavailable', retryable: true } });
    expect(result.current.items[0]).toMatchObject({ kind: 'user', failed: true });

    act(() => {
      expect(result.current.retry(failed.key)).toBe(true);
    });
    await settle();
    expect(streams[1].body.idempotency_key).toBe(key);
    expect(streams[1].body.history).toEqual([]);
    expect(result.current.items).toHaveLength(2);
    await push(streams[1], start('turn-2'), done({ answer: 'Recovered', message_id: 'm2', conversation_id: 'c1' }));
    expect(assistant(result.current).response?.answer).toBe('Recovered');
  });

  it('surfaces a pre-stream HTTP failure with its friendly message', async () => {
    override = (call) =>
      call.url === '/api/chat/stream'
        ? json({ detail: { code: 'chat_busy', message: 'Two answers are still running.' } }, 429)
        : undefined;
    const { result } = await mountEngine();
    act(() => {
      result.current.send('x');
    });
    await settle();
    expect(assistant(result.current)).toMatchObject({
      status: 'error',
      failure: { kind: 'http', status: 429, code: 'chat_busy', message: 'Two answers are still running.', retryable: true },
    });
    expect(result.current.busy).toBe(false);
  });
});

describe('useChatEngine — Stop and connection loss', () => {
  it('stops server-side: cancel by turn id, keep reading until turn.done (cancelled)', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Long hunt');
    });
    await settle();
    await push(streams[0], start('turn-7'));
    await act(async () => {
      result.current.stop();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(recorded.some((call) => call.url === '/api/chat/turns/turn-7/cancel' && call.method === 'POST')).toBe(true);
    expect(assistant(result.current).live?.stopping).toBe(true);
    expect(result.current.busy).toBe(true);
    await push(streams[0], done({ answer: '', notice: { kind: 'cancelled', message: 'Stopped', retryable: false }, message_id: 'm1' }));
    expect(assistant(result.current)).toMatchObject({ status: 'done', response: { notice: { kind: 'cancelled' } } });
  });

  it('defers the cancel until turn.start names the turn', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Quick');
    });
    await settle();
    act(() => result.current.stop());
    expect(recorded.some((call) => call.url.includes('/cancel'))).toBe(false);
    await push(streams[0], start('turn-late'));
    expect(recorded.some((call) => call.url === '/api/chat/turns/turn-late/cancel')).toBe(true);
  });

  it('a second Stop abandons the stream locally and keeps what arrived', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Stuck');
    });
    await settle();
    await push(
      streams[0],
      start('turn-s'),
      { type: 'step.end', step: { index: 1, label: 'Searched logs', status: 'ok', summary: '3 rows' } },
      { type: 'usage', totals: { calls: 1, total_tokens: 500, cost: 0.001 } },
    );
    act(() => result.current.stop());
    await settle();
    act(() => result.current.stop());
    await settle();
    const item = assistant(result.current);
    expect(item.status).toBe('done');
    expect(item.response?.notice?.kind).toBe('cancelled');
    expect(item.response?.steps).toHaveLength(1);
    expect(item.response?.usage?.total_tokens).toBe(500);
    expect(result.current.busy).toBe(false);
  });

  it('replays ONCE with the same key when the stream ends without turn.done', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Will drop');
    });
    await settle();
    const key = streams[0].body.idempotency_key;
    await push(streams[0], start('turn-d'));
    await act(async () => {
      streams[0].close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(streamCalls()).toHaveLength(2);
    expect(streams[1].body.idempotency_key).toBe(key);
    expect(assistant(result.current).live?.connection).toBe('recovering');
    await push(streams[1], start('turn-d', { replayed: true }), done({ answer: 'Saved answer', message_id: 'm9', conversation_id: 'c9' }));
    expect(assistant(result.current)).toMatchObject({ status: 'done', response: { answer: 'Saved answer' } });
  });

  it('gives up after the one replay also drops', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Flaky');
    });
    await settle();
    await act(async () => {
      streams[0].fail();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      streams[1].close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(streamCalls()).toHaveLength(2);
    expect(assistant(result.current)).toMatchObject({ status: 'error', failure: { kind: 'connection_lost', retryable: true } });
  });

  it('does not auto-replay a case-scoped turn (it is not idempotent server-side)', async () => {
    const { result } = await mountEngine({ caseId: 'case-42' });
    act(() => {
      result.current.send('Summarise this case');
    });
    await settle();
    expect(streams[0].body).toMatchObject({ case_id: 'case-42' });
    expect(streams[0].body).not.toHaveProperty('persist_conversation');
    expect(streams[0].body).not.toHaveProperty('conversation_id');
    await act(async () => {
      streams[0].close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(streamCalls()).toHaveLength(1);
    expect(assistant(result.current).failure?.kind).toBe('connection_lost');
  });

  it('waits out a 409 in-progress while recovering, then gets the saved answer', async () => {
    let attempt = 0;
    override = (call) => {
      if (call.url !== '/api/chat/stream') return undefined;
      attempt += 1;
      if (attempt === 2) return json({ detail: { code: 'chat_request_in_progress', message: 'Still running' } }, 409);
      return undefined;
    };
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Slow');
    });
    await settle();
    await act(async () => {
      streams[0].close();
      await new Promise((resolve) => setTimeout(resolve, 1700));
    });
    expect(attempt).toBe(3);
    await push(streams[1], start('t', { replayed: true }), done({ answer: 'Finally', message_id: 'm', conversation_id: 'c' }));
    expect(assistant(result.current).response?.answer).toBe('Finally');
  });
});

describe('useChatEngine — transports, retries and origins', () => {
  it('falls back to blocking /api/chat when the stream route is missing, for the session', async () => {
    override = (call) => {
      if (call.url === '/api/chat/stream') return json({ detail: 'Not Found' }, 404);
      if (call.url === '/api/chat') return json({ answer: `Blocking: ${String(call.body?.message)}`, conversation_id: 'c1' });
      return undefined;
    };
    const { result } = await mountEngine();
    act(() => {
      result.current.send('First');
    });
    await settle();
    expect(assistant(result.current).response?.answer).toBe('Blocking: First');
    const blocking = recorded.find((call) => call.url === '/api/chat');
    expect(blocking?.body).not.toHaveProperty('stream_mode');
    act(() => {
      result.current.send('Second');
    });
    await settle();
    expect(streamCalls()).toHaveLength(1);
    expect(recorded.filter((call) => call.url === '/api/chat')).toHaveLength(2);
    expect(result.current.canStop).toBe(false);
  });

  it('Ask again sends the preceding question with a NEW key and appends', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Top hosts?', { origin: 'starter' });
    });
    await settle();
    await push(streams[0], start(), done({ answer: 'web-01', message_id: 'm1', conversation_id: 'c1' }));
    act(() => {
      expect(result.current.askAgain(assistant(result.current).key)).toBe(true);
    });
    await settle();
    expect(streams[1].body.message).toBe('Top hosts?');
    expect(streams[1].body.origin).toBe('starter');
    expect(streams[1].body.idempotency_key).not.toBe(streams[0].body.idempotency_key);
    expect(result.current.items).toHaveLength(4);
    // Retry on a SAVED answer is Ask again (a new key), never a replay of the same key.
    await push(streams[1], start('t2'), done({ answer: 'web-01 again', message_id: 'm2', conversation_id: 'c1' }));
    act(() => {
      result.current.retry(assistant(result.current).key);
    });
    await settle();
    expect(new Set(streams.map((s) => s.body.idempotency_key)).size).toBe(3);
  });

  it('D1: an unsaved first-call failure never enters history; Retry reuses its key', async () => {
    const persisted = vi.fn();
    const { result } = await mountEngine({ onConversationPersisted: persisted });
    act(() => {
      result.current.send('Hi');
    });
    await settle();
    await push(
      streams[0],
      start(),
      done({ answer: 'Model not configured', notice: { kind: 'provider', message: 'Model not configured', retryable: true }, usage: null, conversation_id: null }),
    );
    const failed = assistant(result.current);
    expect(isUnsavedTurn(failed.response!)).toBe(true);
    expect(result.current.items[0]).toMatchObject({ failed: true });
    expect(persisted).not.toHaveBeenCalled();
    act(() => {
      result.current.retry(failed.key);
    });
    await settle();
    expect(streams[1].body.idempotency_key).toBe(streams[0].body.idempotency_key);
    expect(streams[1].body.history).toEqual([]);
  });

  it('a case answer whose save failed retryably is retried with the SAME key (thread append deduplicated)', async () => {
    const { result } = await mountEngine({ caseId: 'case-7' });
    act(() => {
      result.current.send('Summarise this case');
    });
    await settle();
    await push(
      streams[0],
      start(),
      done({
        answer: 'Two hosts touched.',
        message_id: null,
        usage: { calls: 1, total_tokens: 900, cost: 0.002 },
        notice: { kind: 'not_saved', message: 'The answer could not be saved to the case.', retryable: true },
      }),
    );
    const unsaved = assistant(result.current);
    expect(retriesWithSameKey(unsaved)).toBe(true);
    act(() => {
      expect(result.current.retry(unsaved.key)).toBe(true);
    });
    await settle();
    expect(streams[1].body.idempotency_key).toBe(streams[0].body.idempotency_key);
    expect(streams[1].body).toMatchObject({ case_id: 'case-7', message: 'Summarise this case' });
    // The pair is replaced, not appended.
    expect(result.current.items).toHaveLength(2);
  });

  it('a retryable case_save_notice keeps the same key even under another top notice', () => {
    const base = {
      status: 'done' as const,
      request: { message: 'Summarise this case', case_id: 'case-7', idempotency_key: 'k-1' } as never,
    };
    const resp = (extra: Record<string, unknown>) =>
      ({ answer: 'Two hosts touched.', message_id: null, usage: { calls: 1, total_tokens: 900, cost: 0.002 }, ...extra }) as never;
    expect(
      retriesWithSameKey({
        ...base,
        response: resp({
          notice: { kind: 'denied', message: 'Denied.', retryable: false },
          case_save_notice: { kind: 'not_saved', message: 'The answer was not added to the case thread.', retryable: true },
        }),
      }),
    ).toBe(true);
    expect(
      retriesWithSameKey({
        ...base,
        response: resp({
          notice: { kind: 'denied', message: 'Denied.', retryable: false },
          case_save_notice: { kind: 'not_saved', message: 'The answer was not added to the case thread.', retryable: false },
        }),
      }),
    ).toBe(false);
  });

  it('a non-retryable not_saved answer is asked again with a NEW key', async () => {
    const { result } = await mountEngine({ caseId: 'case-7' });
    act(() => {
      result.current.send('Summarise this case');
    });
    await settle();
    await push(
      streams[0],
      start(),
      done({
        answer: 'Two hosts touched.',
        message_id: null,
        usage: { calls: 1, total_tokens: 900, cost: 0.002 },
        notice: { kind: 'not_saved', message: 'Not saved.', retryable: false },
      }),
    );
    expect(retriesWithSameKey(assistant(result.current))).toBe(false);
    act(() => {
      result.current.retry(assistant(result.current).key);
    });
    await settle();
    expect(streams[1].body.idempotency_key).not.toBe(streams[0].body.idempotency_key);
  });

  it('never adopts the turn.start conversation of an answer delivered as not saved', async () => {
    const persisted = vi.fn();
    const { result } = await mountEngine({ onConversationPersisted: persisted });
    act(() => {
      result.current.send('First question');
    });
    await settle();
    await push(
      streams[0],
      start('t1', { conversation_id: 'c-never-created' }),
      done({
        answer: 'A billed answer that could not be saved.',
        message_id: null,
        conversation_id: null,
        usage: { calls: 1, total_tokens: 900, cost: 0.002 },
        notice: { kind: 'not_saved', message: 'Not saved.', retryable: false },
      }),
    );
    expect(assistant(result.current).response?.answer).toBe('A billed answer that could not be saved.');
    expect(result.current.conversationId).toBeNull();
    expect(persisted).not.toHaveBeenCalled();
    // The next turn starts its own thread instead of naming the one that never existed.
    act(() => {
      result.current.send('Second question');
    });
    await settle();
    expect(streams[1].body).not.toHaveProperty('conversation_id');
  });

  it('sends an "Ask about this" topic id with its question, and drops one the server would refuse', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('What does MTTD measure here?', { origin: 'starter', topic: 'kpi:mttd' });
    });
    await settle();
    expect(streams[0].body).toMatchObject({ message: 'What does MTTD measure here?', origin: 'starter', topic: 'kpi:mttd' });
    await push(streams[0], start(), done({ answer: 'Time to detect.', message_id: 'm1', conversation_id: 'c1' }));
    act(() => {
      result.current.send('Another', { topic: `Bad Topic ${'x'.repeat(70)}` });
    });
    await settle();
    expect(streams[1].body).not.toHaveProperty('topic');
    // A plain send never carries a topic.
    await push(streams[1], start('t2'), done({ answer: 'ok', message_id: 'm2', conversation_id: 'c1' }));
    act(() => {
      result.current.send('Plain');
    });
    await settle();
    expect(streams[2].body).not.toHaveProperty('topic');
  });

  it('sends the longest topic the server accepts (121 chars) and drops a 122-char one', async () => {
    // The longest console-link id: 40 + ':' + 80 = 121 (CHAT_TOPIC_MAX_CHARS).
    const longest = `${'k'.repeat(40)}:${'x'.repeat(80)}`;
    expect(longest).toHaveLength(121);
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Long topic', { origin: 'starter', topic: longest });
    });
    await settle();
    expect(streams[0].body).toMatchObject({ topic: longest });
    await push(streams[0], start(), done({ answer: 'ok', message_id: 'm1', conversation_id: 'c1' }));
    act(() => {
      result.current.send('Too long', { origin: 'starter', topic: `${longest}x` });
    });
    await settle();
    expect(streams[1].body).not.toHaveProperty('topic');
  });

  it('Continue sends origin continue with continue_of', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Long report');
    });
    await settle();
    await push(streams[0], start(), done({ answer: 'Part 1', notice: { kind: 'cap', message: 'Lookup cap reached', retryable: false }, message_id: 'msg-9', conversation_id: 'c' }));
    act(() => {
      expect(result.current.continueAnswer(assistant(result.current).key)).toBe(true);
    });
    await settle();
    expect(streams[1].body).toMatchObject({ message: CONTINUE_PROMPT, origin: 'continue', continue_of: 'msg-9' });
  });

  it('sends follow-up chips with their origin without wiping a typed draft', async () => {
    const { result } = await mountEngine();
    act(() => result.current.setDraft('half-typed'));
    act(() => {
      result.current.send('Show the hosts', { origin: 'follow_up' });
    });
    await settle();
    expect(streams[0].body.origin).toBe('follow_up');
    expect(result.current.draft).toBe('half-typed');
  });

  it('sends the draft, clears it, and refuses empty, busy or blocked sends', async () => {
    const { result, rerender } = await mountEngine();
    act(() => result.current.setDraft('  '));
    act(() => {
      expect(result.current.send()).toBe(false);
    });
    act(() => result.current.setDraft('  real question  '));
    act(() => {
      expect(result.current.send()).toBe(true);
    });
    expect(result.current.draft).toBe('');
    act(() => {
      expect(result.current.send('while busy')).toBe(false);
    });
    await settle();
    expect(streams[0].body.message).toBe('real question');
    await push(streams[0], start(), done({ message_id: 'm', conversation_id: 'c' }));
    rerender({ blocked: true });
    act(() => {
      expect(result.current.send('blocked')).toBe(false);
    });
  });

  it('carries model, source, scopes and the time window on the request', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.setModel('gpt-x');
      result.current.setSourceId('wazuh-prod');
      result.current.setScopes(['logs', 'cases', 'logs', 'bogus' as never]);
      result.current.setTimeRange({ from: 'now-7d', to: 'now' });
    });
    act(() => {
      result.current.send('Scoped');
    });
    await settle();
    expect(streams[0].body).toMatchObject({
      model: 'gpt-x',
      source_id: 'wazuh-prod',
      scopes: ['logs', 'cases'],
      time_range: { from: 'now-7d', to: 'now' },
    });
  });
});

describe('useChatEngine — hydration, guards and preferences', () => {
  const saved: ChatConversation = {
    id: 'conv-7',
    title: 'Saved',
    created_at: '2026-10-08T09:00:00Z',
    updated_at: '2026-10-08T09:05:00Z',
    message_count: 2,
    model: 'gpt-y',
    source_id: 'elastic-prod',
    time_range: { from: 'now-24h', to: 'now' },
    messages: [
      { id: 'm1', role: 'user', content: 'Earlier question', created_at: '2026-10-08T09:00:00Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Earlier answer',
        created_at: '2026-10-08T09:01:00Z',
        model: 'gpt-y',
        source_name: 'Elastic production',
        response: { answer: 'Earlier answer', effective_model: 'gpt-y' },
      },
    ],
  };

  it('hydrates a saved conversation and resumes it with its time window', async () => {
    const { result } = await mountEngine({ conversation: saved });
    expect(result.current.items).toMatchObject([
      { kind: 'user', key: 'm1', messageId: 'm1', content: 'Earlier question' },
      { kind: 'assistant', key: 'm2', restored: true, status: 'done', model: 'gpt-y', source: 'Elastic production' },
    ]);
    expect(result.current.conversationId).toBe('conv-7');
    expect(result.current.timeRange).toEqual({ from: 'now-24h', to: 'now' });
    act(() => {
      result.current.send('Follow on');
    });
    await settle();
    expect(streams[0].body).toMatchObject({
      conversation_id: 'conv-7',
      time_range: { from: 'now-24h', to: 'now' },
      history: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
    });
  });

  it('never adopts the stored (server-resolved) model or source as the analyst\'s selection', async () => {
    // The server stores the EFFECTIVE model (normally the default) and the primary
    // source it resolved even when the analyst chose none (D2 regression).
    const { result } = await mountEngine({ conversation: saved });
    expect(result.current.model).toBeNull();
    expect(result.current.sourceId).toBeNull();
    act(() => {
      result.current.send('Follow on');
    });
    await settle();
    expect(streams[0].body).not.toHaveProperty('model');
    expect(streams[0].body).not.toHaveProperty('source_id');
    // The restored answer still names what it used.
    expect(result.current.items[1]).toMatchObject({ model: 'gpt-y', source: 'Elastic production' });
  });

  it('a null conversation is a fresh draft; resetKey resets even when it stays null', async () => {
    const { result, rerender } = await mountEngine({ conversation: saved, resetKey: 0 });
    rerender({ conversation: null, resetKey: 0 });
    expect(result.current.items).toEqual([]);
    expect(result.current.conversationId).toBeNull();
    act(() => {
      result.current.send('Draft turn');
    });
    await settle();
    await push(streams[0], start(), done({ conversation_id: 'conv-new', message_id: 'm', conversation_title: 'Draft turn' }));
    expect(result.current.items).toHaveLength(2);
    rerender({ conversation: null, resetKey: 1 });
    expect(result.current.items).toEqual([]);
    expect(result.current.conversationId).toBeNull();
  });

  it('ignores a reply that lands after New chat', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Old question');
    });
    await settle();
    act(() => result.current.reset());
    expect(result.current.busy).toBe(false);
    expect(result.current.items).toEqual([]);
    act(() => {
      expect(result.current.send('New question')).toBe(true);
    });
    await settle();
    expect(result.current.items.map((item) => item.kind === 'user' && item.content)).toContain('New question');
  });

  it('drops a blocking reply that resolves after New chat (generation guard)', async () => {
    let resolveChat!: (response: Response) => void;
    override = (call) =>
      call.url === '/api/chat'
        ? (new Promise<Response>((resolve) => {
            resolveChat = resolve;
          }) as unknown as Response)
        : undefined;
    const { result } = await mountEngine({ transport: 'blocking' });
    act(() => {
      result.current.send('Slow blocking question');
    });
    await settle();
    expect(result.current.canStop).toBe(false);
    act(() => result.current.reset());
    await act(async () => {
      resolveChat(json({ answer: 'Too late', conversation_id: 'c-late' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.conversationId).toBeNull();
    expect(streamCalls()).toHaveLength(0);
  });

  it('bounds client history to the last 12 exchanges', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: String(i) }));
    const bounded = boundHistory(many);
    expect(bounded).toHaveLength(CHAT_HISTORY_EXCHANGES * 2);
    expect(bounded[0].content).toBe('16');
  });

  it('persists the live mode to localStorage and the server preference', async () => {
    const { result } = await mountEngine();
    expect(result.current.streamMode).toBe('steps');
    await act(async () => {
      result.current.setStreamMode('text');
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(window.localStorage.getItem(STREAM_MODE_STORAGE_KEY)).toBe('text');
    expect(recorded.find((call) => call.method === 'PUT' && call.url === '/api/prefs/user')?.body).toEqual({
      misc: { chat_stream_mode: 'text' },
    });
    expect(result.current.streamMode).toBe('text');
  });

  it('paints the stored mode first, follows the org default, and forces steps when text is unavailable', async () => {
    window.localStorage.setItem(STREAM_MODE_STORAGE_KEY, 'text');
    userPrefs = { misc: {} };
    const first = renderHook(() => useChatEngine());
    expect(first.result.current.streamMode).toBe('text');
    await settle();
    // The server has no explicit choice: the mirror is cleared, the default applies.
    expect(first.result.current.streamMode).toBe('steps');
    expect(window.localStorage.getItem(STREAM_MODE_STORAGE_KEY)).toBeNull();
    first.unmount();

    const { result } = await mountEngine({ orgDefaultStreamMode: 'text', textStreamingAvailable: false });
    expect(result.current.streamMode).toBe('text');
    expect(result.current.effectiveStreamMode).toBe('steps');
  });

  it('survives storage that throws', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const { result } = await mountEngine();
      await act(async () => {
        result.current.setStreamMode('text');
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(result.current.streamMode).toBe('text');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('reports busy changes to the host and releases them on unmount', async () => {
    const onBusyChange = vi.fn();
    const { result, unmount } = await mountEngine({ onBusyChange });
    act(() => {
      result.current.send('x');
    });
    await settle();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('useChatEngine — conversation adoption, stop and recovery edges', () => {
  it('a forced stop on a draft joins the thread named by turn.start, outside model history', async () => {
    const persisted = vi.fn();
    const { result } = await mountEngine({ onConversationPersisted: persisted });
    act(() => {
      result.current.send('First draft question');
    });
    await settle();
    await push(streams[0], start('turn-a', { conversation_id: 'conv-x' }), { type: 'step.start', step: { index: 1, kind: 'tool', label: 'Searching logs', params: {} } });
    act(() => result.current.stop());
    await settle();
    act(() => result.current.stop());
    await settle();
    expect(persisted).toHaveBeenCalledWith('conv-x', 'First draft question');
    expect(result.current.conversationId).toBe('conv-x');
    expect(assistant(result.current)).toMatchObject({ status: 'done', messageId: null, response: { notice: { kind: 'cancelled' } } });
    // The local "Stopped" view is not the server's record: the prompt is excluded.
    expect(result.current.items[0]).toMatchObject({ kind: 'user', failed: true });

    act(() => {
      result.current.send('Next question');
    });
    await settle();
    expect(streams[1].body).toMatchObject({ conversation_id: 'conv-x', history: [] });
  });

  it('a forced stop in an existing thread keeps its title (no prompt passed)', async () => {
    const persisted = vi.fn();
    const conversation: ChatConversation = {
      id: 'conv-old',
      title: 'Saved thread',
      created_at: '2026-10-08T09:00:00Z',
      updated_at: '2026-10-08T09:05:00Z',
      message_count: 0,
      messages: [],
    };
    const { result } = await mountEngine({ conversation, onConversationPersisted: persisted });
    act(() => {
      result.current.send('Later question');
    });
    await settle();
    await push(streams[0], start('turn-o', { conversation_id: 'conv-old' }));
    act(() => result.current.stop({ force: true }));
    await settle();
    expect(persisted).toHaveBeenCalledWith('conv-old', '');
  });

  it('a case-scoped forced stop never enters the client history it sends', async () => {
    const { result } = await mountEngine({ caseId: 'case-9' });
    act(() => {
      result.current.send('Summarise');
    });
    await settle();
    act(() => result.current.stop({ force: true }));
    await settle();
    expect(assistant(result.current).response?.notice?.kind).toBe('cancelled');
    act(() => {
      result.current.send('Again');
    });
    await settle();
    expect(streams[1].body).toMatchObject({ case_id: 'case-9', history: [] });
  });

  it('adopts the started conversation when the connection is lost for good, not after turn.error', async () => {
    const persisted = vi.fn();
    const { result } = await mountEngine({ onConversationPersisted: persisted });
    act(() => {
      result.current.send('Errors out');
    });
    await settle();
    await push(streams[0], start('turn-e', { conversation_id: 'conv-e' }), { type: 'turn.error', code: 'turn_failed', message: 'Failed', retryable: true });
    expect(persisted).not.toHaveBeenCalled();
    expect(result.current.conversationId).toBeNull();

    act(() => {
      result.current.send('Drops twice');
    });
    await settle();
    await push(streams[1], start('turn-d', { conversation_id: 'conv-d' }));
    await act(async () => {
      streams[1].close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      streams[2].fail();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(assistant(result.current).failure?.kind).toBe('connection_lost');
    expect(persisted).toHaveBeenCalledWith('conv-d', 'Drops twice');
    expect(result.current.conversationId).toBe('conv-d');
  });

  it('a replay starts a fresh projection: the dropped attempt\'s steps never linger', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Replay me');
    });
    await settle();
    const step = { index: 1, kind: 'tool', label: 'Searching logs', params: {} };
    await push(streams[0], start('turn-r'), { type: 'step.start', step }, { type: 'usage', totals: { calls: 1, total_tokens: 10, cost: 0 } });
    expect(assistant(result.current).live?.steps).toHaveLength(1);
    await act(async () => {
      streams[0].close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await push(streams[1], start('turn-r2'), { type: 'step.start', step });
    const live = assistant(result.current).live;
    expect(live?.steps).toHaveLength(1);
    expect(live?.usage).toBeNull();
    await push(streams[1], { type: 'step.end', step: { index: 1, label: 'Searched logs', status: 'ok', summary: '2 rows' } });
    expect(assistant(result.current).live?.steps[0]).toMatchObject({ status: 'ok' });
  });

  it('re-sends a pending Stop to the turn a recovery replay names', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Stop me');
    });
    await settle();
    await push(streams[0], start('turn-1'));
    await act(async () => {
      result.current.stop();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      streams[0].close();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await push(streams[1], start('turn-2'));
    expect(recorded.filter((call) => call.url.endsWith('/cancel')).map((call) => call.url)).toEqual([
      '/api/chat/turns/turn-1/cancel',
      '/api/chat/turns/turn-2/cancel',
    ]);
  });

  it('keeps checking past four 409s, at the server\'s retry_after hint', async () => {
    let attempt = 0;
    override = (call) => {
      if (call.url !== '/api/chat/stream') return undefined;
      attempt += 1;
      if (attempt >= 2 && attempt <= 7) {
        return json({ detail: { code: 'chat_request_in_progress', message: 'Still running', retry_after: 0.25 } }, 409);
      }
      return undefined;
    };
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Long turn');
    });
    await settle();
    await act(async () => {
      streams[0].close();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    });
    expect(attempt).toBe(8);
    expect(assistant(result.current).live?.connection).toBe('recovering');
    await push(streams[1], start('t', { replayed: true }), done({ answer: 'Saved late', message_id: 'm', conversation_id: 'c' }));
    expect(assistant(result.current).response?.answer).toBe('Saved late');
  });

  it('stops waiting once the turn\'s own limits have passed', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      let attempt = 0;
      override = (call) => {
        if (call.url !== '/api/chat/stream') return undefined;
        attempt += 1;
        if (attempt >= 2) return json({ detail: { code: 'chat_request_in_progress', message: 'Still running' } }, 409);
        return undefined;
      };
      const { result } = await mountEngine({ turnBounds: { turn_timeout_s: 10, model_step_timeout_s: 5 } });
      act(() => {
        result.current.send('Very long turn');
      });
      await settle();
      offset = recoveryWindowMs({ turn_timeout_s: 10, model_step_timeout_s: 5 }) + 1_000;
      await act(async () => {
        streams[0].close();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(attempt).toBe(2);
      expect(assistant(result.current)).toMatchObject({
        status: 'error',
        failure: { kind: 'connection_lost', code: 'chat_request_in_progress', retryable: true },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('bounds recovery by the turn limits and the delay by the hint', () => {
    expect(recoveryWindowMs({ turn_timeout_s: 90, model_step_timeout_s: 30 })).toBe(125_000);
    expect(recoveryWindowMs(null)).toBe(125_000);
    expect(recoveryWindowMs({ turn_timeout_s: -1, model_step_timeout_s: Number.NaN })).toBe(125_000);
    expect(recoveryWindowMs({ turn_timeout_s: 300, model_step_timeout_s: 60 })).toBe(365_000);
    expect(recoveryDelayMs(0, null)).toBe(1_500);
    expect(recoveryDelayMs(9, null)).toBe(8_000);
    expect(recoveryDelayMs(0, 2)).toBe(2_000);
    expect(recoveryDelayMs(0, 0)).toBe(250);
    expect(recoveryDelayMs(0, 3_600)).toBe(15_000);
  });

  it('marks an idempotency conflict as not retryable with the same key', async () => {
    override = (call) =>
      call.url === '/api/chat/stream'
        ? json({ detail: { code: 'chat_idempotency_conflict', message: 'Send it as a new message.' } }, 409)
        : undefined;
    const { result } = await mountEngine();
    act(() => {
      result.current.send('Conflicted');
    });
    await settle();
    expect(assistant(result.current).failure).toMatchObject({ kind: 'http', status: 409, code: 'chat_idempotency_conflict', retryable: false });
  });

  it('a different case resets the transcript and drops the running turn', async () => {
    const { result, rerender } = await mountEngine({ caseId: 'case-a' });
    act(() => {
      result.current.send('About case A');
    });
    await settle();
    await push(streams[0], start('turn-a'), done({ answer: 'A answer' }));
    act(() => {
      result.current.send('Still A');
    });
    await settle();
    rerender({ caseId: 'case-b' });
    expect(result.current.items).toEqual([]);
    expect(result.current.busy).toBe(false);
    await settle();
    // Case A's stream was abandoned (its reader cancelled), so nothing can land here.
    expect(() => streams[1].push(done({ answer: 'Late A answer' }))).toThrow();
    expect(result.current.items).toEqual([]);
    act(() => {
      result.current.send('About case B');
    });
    await settle();
    expect(streams[2].body).toMatchObject({ case_id: 'case-b', history: [] });
  });

  it('Stop is a no-op on a blocking turn', async () => {
    let resolveChat!: (response: Response) => void;
    override = (call) =>
      call.url === '/api/chat'
        ? (new Promise<Response>((resolve) => {
            resolveChat = resolve;
          }) as unknown as Response)
        : undefined;
    const { result } = await mountEngine({ transport: 'blocking' });
    act(() => {
      result.current.send('Blocking');
    });
    await settle();
    act(() => result.current.stop({ force: true }));
    await act(async () => {
      resolveChat(json({ answer: 'Arrived', message_id: 'm1', conversation_id: 'c1' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(assistant(result.current)).toMatchObject({ status: 'done', response: { answer: 'Arrived' } });
  });

  it('shows the prompt as display text but resends the exact prompt', async () => {
    const { result } = await mountEngine();
    const prompt = 'Is adm\u200Bin the same as admin? \u202Egnp.exe';
    act(() => {
      result.current.send(prompt);
    });
    await settle();
    expect(streams[0].body.message).toBe(prompt);
    const user = result.current.items[0];
    expect(user).toMatchObject({ kind: 'user', content: 'Is admin the same as admin? gnp.exe', prompt });
    expect(result.current.lastUserPrompt).toBe(prompt);
    await push(streams[0], start(), done({ answer: 'No.', message_id: 'm1', conversation_id: 'c1' }));
    act(() => {
      result.current.askAgain(assistant(result.current).key);
    });
    await settle();
    expect(streams[1].body.message).toBe(prompt);
  });
});

describe('useChatEngine — final-review regressions', () => {
  const followUpThread: ChatConversation = {
    id: 'conv-f',
    title: 'Hunt',
    created_at: '2026-10-08T09:00:00Z',
    updated_at: '2026-10-08T09:05:00Z',
    message_count: 4,
    messages: [
      { id: 'u1', role: 'user', content: 'Hunt the source IP', created_at: '2026-10-08T09:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'Found it.', created_at: '2026-10-08T09:01:00Z', response: { answer: 'Found it.' } },
      {
        id: 'u2',
        role: 'user',
        content: 'Look up 203.0.113.7 in threat intel',
        created_at: '2026-10-08T09:02:00Z',
        origin: 'follow_up',
      },
      { id: 'a2', role: 'assistant', content: 'Not looked up.', created_at: '2026-10-08T09:03:00Z', response: { answer: 'Not looked up.' } },
    ],
  };

  it('a reopened follow-up keeps its origin: Ask again resends it as follow_up and ↑ recall skips it', async () => {
    const { result } = await mountEngine({ conversation: followUpThread });
    expect(result.current.items[2]).toMatchObject({ kind: 'user', origin: 'follow_up' });
    // ↑ recall is the analyst's own last prompt, never the model-authored chip text.
    expect(result.current.lastUserPrompt).toBe('Hunt the source IP');
    act(() => {
      expect(result.current.askAgain('a2')).toBe(true);
    });
    await settle();
    expect(streams[0].body).toMatchObject({ message: 'Look up 203.0.113.7 in threat intel', origin: 'follow_up' });
    // Replayed history says who wrote each prompt (SPEC §4.8.2).
    expect(streams[0].body.history).toEqual([
      { role: 'user', content: 'Hunt the source IP', origin: 'user' },
      { role: 'assistant', content: 'Found it.' },
      { role: 'user', content: 'Look up 203.0.113.7 in threat intel', origin: 'follow_up' },
      { role: 'assistant', content: 'Not looked up.' },
    ]);
  });

  it('client history carries each live prompt\'s origin', async () => {
    const { result } = await mountEngine({ caseId: 'case-3' });
    act(() => {
      result.current.send('Show the hosts', { origin: 'follow_up' });
    });
    await settle();
    await push(streams[0], start(), done({ answer: 'Two hosts.', message_id: 'm1' }));
    act(() => {
      result.current.send('Mine');
    });
    await settle();
    expect(streams[1].body.history).toEqual([
      { role: 'user', content: 'Show the hosts', origin: 'follow_up' },
      { role: 'assistant', content: 'Two hosts.' },
    ]);
  });

  it('"Run again to save" replaces the exchange in model history instead of sending it twice', async () => {
    const { result } = await mountEngine({ caseId: 'case-7' });
    act(() => {
      result.current.send('Summarise this case');
    });
    await settle();
    await push(
      streams[0],
      start(),
      done({
        answer: 'Two hosts touched.',
        message_id: null,
        usage: { calls: 1, total_tokens: 900, cost: 0.002 },
        notice: { kind: 'not_saved', message: 'The answer could not be saved to the case.', retryable: true },
      }),
    );
    expect(result.current.historySize.exchanges).toBe(1);
    act(() => {
      expect(result.current.retry(assistant(result.current).key)).toBe(true);
    });
    await settle();
    // The retry resends the original body (its own history excluded the pair).
    expect(streams[1].body.history).toEqual([]);
    await push(streams[1], start('turn-2'), done({ answer: 'Two hosts touched (again).', message_id: 'm-saved' }));
    expect(result.current.historySize.exchanges).toBe(1);
    act(() => {
      result.current.send('Next question');
    });
    await settle();
    expect(streams[2].body.history).toEqual([
      { role: 'user', content: 'Summarise this case', origin: 'user' },
      { role: 'assistant', content: 'Two hosts touched (again).' },
    ]);
  });

  it('New chat after a draft saved this session starts the composer on the defaults', async () => {
    const { result, rerender } = await mountEngine({ conversation: null, resetKey: 0 });
    act(() => {
      result.current.setModel('gpt-pricey');
      result.current.setSourceId('wazuh');
      result.current.setScopes(['logs']);
      result.current.setTimeRange({ from: 'now-7d', to: 'now' });
    });
    act(() => {
      result.current.send('Draft turn');
    });
    await settle();
    await push(streams[0], start(), done({ conversation_id: 'conv-new', message_id: 'm', conversation_title: 'Draft turn' }));
    // The host's conversation stays null for a just-saved draft: only resetKey moves.
    rerender({ conversation: null, resetKey: 1 });
    expect(result.current.items).toEqual([]);
    expect(result.current.model).toBeNull();
    expect(result.current.sourceId).toBeNull();
    expect(result.current.scopes).toEqual([]);
    expect(result.current.timeRange).toBeNull();
    expect(result.current.historySize).toEqual({ exchanges: 0, chars: 0 });
  });

  it('Ask again keeps an "Ask about this" topic and a Continue turn\'s anchor (new key only)', async () => {
    const { result } = await mountEngine();
    act(() => {
      result.current.send('What is MTTR?', { origin: 'starter', topic: 'kpi:mttr' });
    });
    await settle();
    await push(streams[0], start(), done({ answer: 'MTTR is…', message_id: 'msg-1', conversation_id: 'c1' }));
    act(() => {
      expect(result.current.askAgain(assistant(result.current).key)).toBe(true);
    });
    await settle();
    expect(streams[1].body).toMatchObject({ message: 'What is MTTR?', origin: 'starter', topic: 'kpi:mttr' });
    expect(streams[1].body.idempotency_key).not.toBe(streams[0].body.idempotency_key);
    await push(streams[1], start('turn-2'), done({ answer: 'Part 1', message_id: 'msg-2', conversation_id: 'c1' }));
    act(() => {
      result.current.continueAnswer(assistant(result.current).key);
    });
    await settle();
    await push(streams[2], start('turn-3'), done({ answer: 'Part 2', message_id: 'msg-3', conversation_id: 'c1' }));
    act(() => {
      result.current.askAgain(assistant(result.current).key);
    });
    await settle();
    expect(streams[3].body).toMatchObject({ message: CONTINUE_PROMPT, origin: 'continue', continue_of: 'msg-2' });
  });

  it('Ask again on a reopened Continue turn re-anchors to the answer it continued', async () => {
    const thread: ChatConversation = {
      ...followUpThread,
      messages: [
        followUpThread.messages![0],
        followUpThread.messages![1],
        { id: 'u3', role: 'user', content: CONTINUE_PROMPT, created_at: '2026-10-08T09:02:00Z', origin: 'continue' },
        { id: 'a3', role: 'assistant', content: 'More.', created_at: '2026-10-08T09:03:00Z', response: { answer: 'More.' } },
      ],
    };
    const { result } = await mountEngine({ conversation: thread });
    act(() => {
      result.current.askAgain('a3');
    });
    await settle();
    expect(streams[0].body).toMatchObject({ origin: 'continue', continue_of: 'a1' });
  });

  it('reports the size of the history the next case turn replays', async () => {
    const { result } = await mountEngine({ caseId: 'case-9' });
    act(() => {
      result.current.send('q'.repeat(100));
    });
    await settle();
    await push(streams[0], start(), done({ answer: 'a'.repeat(300), message_id: 'm1' }));
    expect(result.current.historySize).toEqual({ exchanges: 1, chars: 400 });
  });
});

describe('replayHistorySize', () => {
  it('keeps the newest 12 exchanges that fit in 24,000 characters', () => {
    const turns = (n: number, size: number) =>
      Array.from({ length: n * 2 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: 'x'.repeat(size) }));
    expect(replayHistorySize([])).toEqual({ exchanges: 0, chars: 0 });
    expect(replayHistorySize(turns(20, 10))).toEqual({ exchanges: 12, chars: 240 });
    // 5 exchanges of 10,000 chars: only two fit in 24,000.
    expect(replayHistorySize(turns(5, 5_000))).toEqual({ exchanges: 2, chars: 20_000 });
  });
});
