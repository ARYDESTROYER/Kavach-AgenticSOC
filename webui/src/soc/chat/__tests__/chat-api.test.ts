/**
 * The lazy chat/reports client: every call rides `lib/api.ts`'s `requestResponse`
 * (cookies, coded errors, the step-up re-auth retry, AbortSignal), responses are
 * normalised leniently and display-sanitised, and requests are shaped per SPEC §9.2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, setReauthHandler, setUnauthorizedHandler } from '@/lib/api';
import {
  DEFAULT_CHAT_BOUNDS,
  addToReport,
  apiErrorCode,
  apiRetryAfterSeconds,
  cancelChatTurn,
  createReport,
  deleteConversation,
  deleteReport,
  estimateReportSummary,
  generateReportSummary,
  getChatContext,
  getConversation,
  getReport,
  isStreamUnsupportedError,
  listConversations,
  listReports,
  patchReport,
  postChat,
  streamChat,
  updateConversation,
} from '../chat-api';
import type { ChatStreamEvent } from '../stream-events';

interface Call {
  url: string;
  method: string;
  body: unknown;
  init: RequestInit | undefined;
}

let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      init,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const REPORT = {
  id: 'rep-1',
  owner: 'analyst',
  title: 'Shift ‮brief',
  template: 'shift',
  conversation_id: 'conv-1',
  items: [
    {
      id: 'item-1',
      kind: 'block',
      block: { id: 'b1', type: 'markdown', text: 'x' },
      note: 'check​ this',
      source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'b1' },
      scope: { window: 'last 24h', sources: ['wazuh-prod'], generated_by: 'demo-model', app_version: '0.1.13', demo: true },
      added_at: '2026-10-08T10:00:00Z',
    },
    { id: 'bad id!', kind: 'block', block: {}, source: {}, scope: {} },
    { id: 'item-2', kind: 'mystery', block: {}, source: {}, scope: {} },
  ],
  summary: null,
  created_at: '2026-10-08T09:00:00Z',
  updated_at: '2026-10-08T10:00:00Z',
  version: 3,
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  setReauthHandler(null);
  setUnauthorizedHandler(null);
});

describe('chat turns', () => {
  it('streams /api/chat/stream with the same auth/cookie contract and delivers events', async () => {
    stubFetch(() =>
      ndjson([
        { type: 'turn.start', turn_id: 'turn-9', model: 'm', stream_mode: 'steps', replayed: false, estimate: { prompt_tokens: 5 } },
        { type: 'turn.done', response: { answer: 'ok' } },
      ]),
    );
    const events: ChatStreamEvent[] = [];
    const outcome = await streamChat(
      { message: 'hi', idempotency_key: 'chat-key-0001', stream_mode: 'text' },
      { onEvent: (event) => events.push(event) },
    );
    expect(outcome.status).toBe('done');
    expect(events.map((e) => e.type)).toEqual(['turn.start', 'turn.done']);
    expect(calls[0]).toMatchObject({ url: '/api/chat/stream', method: 'POST' });
    expect(calls[0].init?.credentials).toBe('include');
    expect(calls[0].init?.cache).toBe('no-store');
    expect(calls[0].body).toEqual({ message: 'hi', idempotency_key: 'chat-key-0001', stream_mode: 'text' });
  });

  it('runs the step-up re-auth gate and retries the stream exactly once', async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      if (attempts === 1) return json({ detail: { code: 'reauth_required' } }, 401);
      return ndjson([{ type: 'turn.done', response: { answer: 'after reauth' } }]);
    });
    const gate = vi.fn(async () => true);
    setReauthHandler(gate);
    const outcome = await streamChat({ message: 'sensitive' });
    expect(gate).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
    expect(outcome.status).toBe('done');
  });

  it('surfaces a pre-stream failure as the usual ApiError (and a lapsed session)', async () => {
    stubFetch(() => json({ detail: { code: 'chat_busy', message: 'Too many chats' } }, 429));
    await expect(streamChat({ message: 'x' })).rejects.toMatchObject({ status: 429, message: 'Too many chats' });
    const lapsed = vi.fn();
    setUnauthorizedHandler(lapsed);
    stubFetch(() => json({ detail: 'Not authenticated' }, 401));
    await expect(streamChat({ message: 'x' })).rejects.toBeInstanceOf(ApiError);
    expect(lapsed).toHaveBeenCalledOnce();
  });

  it('normalises a blocking /api/chat response like turn.done', async () => {
    stubFetch(() => json({ answer: 'Hello‮', usage: { calls: 1, total_tokens: 10, cost: 0.002 }, follow_ups: ['a', 7] }));
    const response = await postChat({ message: 'hi' });
    expect(response.answer).toBe('Hello');
    expect(response.cost).toBe(0.002);
    expect(response.follow_ups).toEqual(['a']);
    stubFetch(() => json({ no: 'answer' }));
    await expect(postChat({ message: 'hi' })).rejects.toMatchObject({ status: 502 });
  });

  it('recognises an old backend without the streaming route', () => {
    expect(isStreamUnsupportedError(new ApiError(404, 'Not Found', { detail: 'Not Found' }))).toBe(true);
    expect(isStreamUnsupportedError(new ApiError(405, 'Method Not Allowed', { detail: 'Method Not Allowed' }))).toBe(true);
    // A missing CONVERSATION is a real 404, not a missing route.
    expect(isStreamUnsupportedError(new ApiError(404, 'conversation not found', { detail: 'conversation not found' }))).toBe(false);
    expect(isStreamUnsupportedError(new Error('x'))).toBe(false);
    expect(apiErrorCode(new ApiError(409, 'x', { detail: { code: 'chat_pin_limit' } }))).toBe('chat_pin_limit');
    expect(apiErrorCode(new ApiError(409, 'x', { code: 'flat_code' }))).toBe('flat_code');
    expect(apiErrorCode('nope')).toBeNull();
  });

  it('reads the server re-check hint from a coded 409 body', () => {
    const inProgress = (body: unknown) => new ApiError(409, 'Still running', body);
    expect(apiRetryAfterSeconds(inProgress({ detail: { code: 'chat_request_in_progress', retry_after: 2 } }))).toBe(2);
    expect(apiRetryAfterSeconds(inProgress({ detail: { code: 'x' }, retry_after: '1.5' }))).toBe(1.5);
    expect(apiRetryAfterSeconds(inProgress({ detail: { code: 'x', retry_after: -1 } }))).toBeNull();
    expect(apiRetryAfterSeconds(inProgress({ detail: { code: 'x', retry_after: 'soon' } }))).toBeNull();
    expect(apiRetryAfterSeconds(inProgress({ detail: 'Still running' }))).toBeNull();
    expect(apiRetryAfterSeconds(new Error('x'))).toBeNull();
  });

  it('cancels a turn by id and never throws for a refusal', async () => {
    stubFetch(() => json({ ok: true }));
    await expect(cancelChatTurn('turn-1')).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ url: '/api/chat/turns/turn-1/cancel', method: 'POST' });
    stubFetch(() => json({ detail: 'turn not found' }, 404));
    await expect(cancelChatTurn('turn-1')).resolves.toBe(false);
    calls = [];
    await expect(cancelChatTurn('../../etc')).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('GET /api/chat/context', () => {
  it('sends only valid query parameters and normalises leniently (fail closed)', async () => {
    stubFetch(() =>
      json({
        model: 'gpt-x',
        context_window: 128000,
        static_prompt_tokens: 1800,
        history_tokens: 300,
        tools: [
          { name: 'search_logs', label: 'Search logs', scope: 'logs', requires: ['sources:read'], allowed: true },
          { name: 'cost_usage', label: 'Cost', scope: 'platform', requires: ['cost:view'], allowed: 'yes', missing: ['cost:view'] },
          { name: 'Bad Tool', label: 'x', scope: 'logs', allowed: true },
          { name: 'odd', label: 'x', scope: 'nowhere', allowed: true },
        ],
        text_streaming: { available: true, reason: 'bogus' },
        bounds: { max_model_calls: 7, turn_token_ceiling: -1 },
        budget: { enabled: true, daily_limit: 10, soft_warn_pct: 80, on_exceed: 'warn' },
        calibration: 1.2,
      }),
    );
    const context = await getChatContext({ conversationId: 'conv-1', model: 'gpt-x', caseId: 'case-7' });
    expect(calls[0].url).toBe('/api/chat/context?conversation_id=conv-1&model=gpt-x&case_id=case-7');
    expect(context.tools.map((t) => [t.name, t.allowed])).toEqual([
      ['search_logs', true],
      ['cost_usage', false],
    ]);
    expect(context.text_streaming).toEqual({ available: true, reason: null });
    expect(context.bounds.max_model_calls).toBe(7);
    expect(context.bounds.turn_token_ceiling).toBe(DEFAULT_CHAT_BOUNDS.turn_token_ceiling);
    // A percent-looking value is not trusted as a 0..1 fraction.
    expect(context.budget).toEqual({ enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'warn' });
    expect(context.rates).toBeNull();
    expect(context.spent_today).toBeNull();
    expect(context.calibration).toBe(1.2);

    calls = [];
    stubFetch(() =>
      json({
        tools: [
          { name: 'lookup_indicator', label: 'Lookup', scope: 'intel', requires: ['enrichment:read'], allowed: true, available: false },
          { name: 'mitre_lookup', label: 'ATT&CK', scope: 'intel', requires: [], allowed: true, available: 'no' },
          { name: 'app_help', label: 'Help', scope: 'docs', requires: [], allowed: true, available: true },
        ],
      }),
    );
    // Only an explicit `false` marks a tool switched off (SPEC A30); absent = on.
    const switched = await getChatContext({});
    expect(switched.tools.map((t) => [t.name, t.allowed, t.available])).toEqual([
      ['lookup_indicator', true, false],
      ['mitre_lookup', true, undefined],
      ['app_help', true, undefined],
    ]);

    calls = [];
    stubFetch(() => json(null));
    const empty = await getChatContext({ conversationId: 'bad id!' });
    expect(calls[0].url).toBe('/api/chat/context');
    expect(empty.bounds).toEqual(DEFAULT_CHAT_BOUNDS);
    expect(empty.tools).toEqual([]);
  });
});

describe('conversations', () => {
  it('lists with a bounded server-side search and sanitised rows', async () => {
    stubFetch(() =>
      json({
        conversations: [
          {
            id: 'conv-1',
            title: 'Brute‮ force',
            preview: 'p',
            created_at: '2026-10-08T09:00:00Z',
            updated_at: '2026-10-08T09:30:00Z',
            message_count: 4,
            pinned: true,
            report_id: 'rep-1',
            time_range: { from: 'now-7d', to: 'now' },
            total_tokens: 1200,
            total_cost: 0.01,
            match: { message_id: 'msg-2', snippet: 'found ​it' },
          },
          { id: 'conv-2', title: '', created_at: 'x', updated_at: 'y', message_count: 2, report_id: '../x' },
          { id: 'bad id!', title: 'dropped' },
          { title: 'no id' },
        ],
        total_conversation_count: 64,
        history_truncated: true,
        limit: 50,
      }),
    );
    const list = await listConversations({ q: `  ${'a'.repeat(250)}  ` });
    const url = new URL(calls[0].url, 'http://x');
    expect(url.pathname).toBe('/api/chat/conversations');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('q')).toHaveLength(200);
    expect(list.conversations.map((c) => c.id)).toEqual(['conv-1', 'conv-2']);
    expect(list.conversations[0]).toMatchObject({
      title: 'Brute force',
      pinned: true,
      report_id: 'rep-1',
      time_range: { from: 'now-7d', to: 'now' },
      total_tokens: 1200,
      match: { message_id: 'msg-2', snippet: 'found it' },
    });
    expect(list.conversations[1]).toMatchObject({ title: 'Untitled conversation', report_id: null, total_tokens: null, pinned: false });
    expect(list).toMatchObject({ total_conversation_count: 64, history_truncated: true, limit: 50 });
  });

  it('omits an empty search and restores a conversation with normalised responses', async () => {
    stubFetch((call) =>
      call.url.startsWith('/api/chat/conversations?')
        ? json({ conversations: [] })
        : json({
            id: 'conv-1',
            title: 'T',
            created_at: '2026-10-08T09:00:00Z',
            updated_at: '2026-10-08T09:30:00Z',
            message_count: 3,
            messages: [
              { id: 'msg-1', role: 'user', content: 'Question', created_at: '2026-10-08T09:00:00Z' },
              { id: 'msg-2', role: 'assistant', content: 'Legacy answer', created_at: '2026-10-08T09:01:00Z', response: null },
              {
                id: 'msg-3',
                role: 'assistant',
                content: 'Rich',
                created_at: '2026-10-08T09:02:00Z',
                response: { answer: 'Rich', usage: { calls: 2, total_tokens: 99, cost: 0.1 }, steps: [{ index: 1, label: 'Searched logs' }] },
              },
              { id: 'msg-4', role: 'system', content: 'dropped', created_at: 'x' },
            ],
          }),
    );
    await listConversations({ q: '   ' });
    expect(calls[0].url).toBe('/api/chat/conversations?limit=50');
    const conversation = await getConversation('conv-1');
    expect(conversation.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(conversation.messages[0].response).toBeNull();
    expect(conversation.messages[1].response).toMatchObject({ answer: 'Legacy answer', message_id: 'msg-2', usage: null });
    expect(conversation.messages[2].response?.usage?.total_tokens).toBe(99);
    expect(conversation.messages[2].response?.steps).toHaveLength(1);
  });

  it('patches title and/or pin only, and deletes', async () => {
    stubFetch((call) => (call.method === 'DELETE' ? json({ ok: true, id: 'conv-1' }) : json({ id: 'conv-1', title: 'New', pinned: true, created_at: 'a', updated_at: 'b', message_count: 2 })));
    const updated = await updateConversation('conv-1', { pinned: true, extra: 'no' } as never);
    expect(calls[0]).toMatchObject({ url: '/api/chat/conversations/conv-1', method: 'PATCH', body: { pinned: true } });
    expect(updated).toMatchObject({ id: 'conv-1', pinned: true });
    expect('match' in updated).toBe(false);
    await deleteConversation('conv 1/x');
    expect(calls[1]).toMatchObject({ url: '/api/chat/conversations/conv%201%2Fx', method: 'DELETE' });
  });
});

describe('reports (SPEC §9.2)', () => {
  it('lists from a bare array or a {reports} envelope', async () => {
    stubFetch(() => json([{ id: 'rep-1', title: 't', template: 'weird', item_count: 2, updated_at: 'u', version: 1 }, { id: '' }]));
    expect(await listReports()).toEqual([
      expect.objectContaining({ id: 'rep-1', template: 'custom', item_count: 2, conversation_id: null, has_summary: false }),
    ]);
    stubFetch(() => json({ reports: [{ id: 'rep-2', title: 't', updated_at: 'u' }] }));
    expect((await listReports()).map((r) => r.id)).toEqual(['rep-2']);
  });

  it('creates, gets and patches with normalised reports', async () => {
    stubFetch(() => json(REPORT));
    const created = await createReport({ title: 'Shift brief', template: 'shift', conversation_id: 'conv-1' });
    expect(calls[0]).toMatchObject({ url: '/api/reports', method: 'POST', body: { title: 'Shift brief', template: 'shift', conversation_id: 'conv-1' } });
    expect(created.title).toBe('Shift brief');
    expect(created.items.map((i) => i.id)).toEqual(['item-1']);
    expect(created.items[0].note).toBe('check this');
    expect(created.items[0].scope).toMatchObject({ sources: ['wazuh-prod'], demo: true });
    expect(created.items[0].block).toEqual({ id: 'b1', type: 'markdown', text: 'x' });

    await getReport('rep-1');
    expect(calls[1]).toMatchObject({ url: '/api/reports/rep-1', method: 'GET' });
    await patchReport('rep-1', { expected_version: 3, notes: { 'item-1': null } });
    expect(calls[2]).toMatchObject({ method: 'PATCH', body: { expected_version: 3, notes: { 'item-1': null } } });
  });

  it('deletes with the strict-CAS expected_version body', async () => {
    stubFetch(() => json({ ok: true }));
    await deleteReport('rep-1', 4);
    expect(calls[0]).toMatchObject({ url: '/api/reports/rep-1', method: 'DELETE', body: { expected_version: 4 } });
  });

  it('adds by reference only and reads the new item id leniently', async () => {
    stubFetch(() => json({ report: REPORT, item_id: 'item-1' }));
    const result = await addToReport({ conversationId: 'conv-1', messageId: 'msg-2', blockId: 'b1' });
    expect(calls[0]).toMatchObject({ url: '/api/reports/add', method: 'POST', body: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'b1' } });
    expect(result.itemId).toBe('item-1');
    expect(result.report.id).toBe('rep-1');

    stubFetch(() => json(REPORT));
    const whole = await addToReport({ conversationId: 'conv-1', messageId: 'msg-2', reportId: 'rep-1' });
    expect(calls[1].body).toEqual({ conversation_id: 'conv-1', message_id: 'msg-2', report_id: 'rep-1' });
    expect(whole.itemId).toBe('item-1');

    stubFetch(() => json({ detail: { code: 'report_full', message: 'Report is full (40 items)' } }, 409));
    await expect(addToReport({ conversationId: 'c', messageId: 'm' })).rejects.toMatchObject({ status: 409 });
  });

  it('estimates with ?dry_run=1 and generates with an idempotency key', async () => {
    stubFetch(() => json({ prompt_tokens: 1400, max_output_tokens: 800, total_tokens: 2200, cost: 0.001, simulated: true }));
    const estimate = await estimateReportSummary('rep-1');
    expect(calls[0]).toMatchObject({ url: '/api/reports/rep-1/summary?dry_run=1', method: 'POST' });
    expect(estimate).toEqual({ prompt_tokens: 1400, max_output_tokens: 800, total_tokens: 2200, cost: 0.001, simulated: true, model: null });

    const summary = {
      executive_summary: 'Quiet shift.',
      next_steps: ['Review case-1', '', 'Tune rule'],
      model: 'demo',
      usage: { calls: 1, total_tokens: 2000, cost: 0 },
      generated_at: '2026-10-08T11:00:00Z',
      based_on_version: 3,
    };
    stubFetch(() => json({ ...REPORT, summary }));
    const generated = await generateReportSummary('rep-1', { idempotencyKey: 'sum-key-0001', expectedVersion: 3 });
    expect(calls[1].body).toEqual({ idempotency_key: 'sum-key-0001', expected_version: 3 });
    expect(generated.summary?.next_steps).toEqual(['Review case-1', 'Tune rule']);
    expect(generated.report?.summary?.based_on_version).toBe(3);

    stubFetch(() => json(summary));
    const bare = await generateReportSummary('rep-1');
    expect(bare.report).toBeNull();
    expect(bare.summary?.executive_summary).toBe('Quiet shift.');
  });
});
