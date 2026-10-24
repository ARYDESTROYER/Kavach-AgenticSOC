/**
 * Case chat sessions across a Demo switch (PR #132 review, the same rule as the
 * starter caches). A case chat keeps its transcript for the session by case id, and a
 * Demo reset re-seeds the same case ids (the same seed), so the transcript is held per
 * Demo identity: after entering, leaving or resetting Demo, a case with the same id
 * starts clean, sends no history from the previous run, and a case turn of the previous
 * identity that settles later never joins the new identity's session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { ChatRequest } from '@/lib/types';

const { demoState } = vi.hoisted(() => ({
  demoState: { value: { active: true, run_id: 'run-1' as string | null } },
}));
vi.mock('@/soc/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/demo')>();
  return {
    ...actual,
    useDemo: () => {
      const { active, run_id } = demoState.value;
      const status = { mode: active ? 'seeded' : 'off', active, run_id } as const;
      return { status, active, loading: false, refresh: async () => status };
    },
  };
});

import { clearChatActivity } from '../../chat-activity/activity';
import { resetChatDemoIdentityForTests } from '../demo-identity';
import { noteCaseSessionsDemoIdentity, readCaseSession, resetTurnRunnerForTests, writeCaseSession } from '../turn-runner';
import { useChatEngine, type UseChatEngineOptions } from '../useChatEngine';

const encoder = new TextEncoder();
interface StreamHandle {
  body: ChatRequest;
  push: (event: unknown) => void;
}
let streams: StreamHandle[] = [];

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
  streams.push({ body, push: (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

beforeEach(() => {
  resetChatDemoIdentityForTests();
  resetTurnRunnerForTests();
  clearChatActivity();
  vi.stubGlobal('BroadcastChannel', undefined);
  demoState.value = { active: true, run_id: 'run-1' };
  streams = [];
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/prefs/user') return json({});
      if (url === '/api/chat/stream') return openStream(JSON.parse(String(init?.body)) as ChatRequest);
      if (/^\/api\/chat\/turns\/[^/]+\/cancel$/.test(url)) return json({ ok: true });
      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = (ms = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function push(stream: StreamHandle, ...events: unknown[]) {
  await act(async () => {
    for (const event of events) stream.push(event);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

const start = (turnId: string) => ({
  type: 'turn.start',
  turn_id: turnId,
  conversation_id: null,
  model: 'demo-model',
  stream_mode: 'steps',
  replayed: false,
  estimate: { prompt_tokens: 900 },
});
const done = (answer: string) => ({ type: 'turn.done', response: { answer } });

async function mountCase(caseId: string) {
  const hook = renderHook((props: UseChatEngineOptions) => useChatEngine(props), { initialProps: { caseId } });
  await settle();
  return hook;
}

describe('case chat sessions across a Demo switch', () => {
  it('a Demo reset starts the same case id clean, with no history from the previous run', async () => {
    const view = await mountCase('demo-1337-0001');
    act(() => {
      view.result.current.send('Summarise the case');
    });
    await settle();
    await push(streams[0], start('turn-1'), done('Run 1: 4 alerts from 10.0.0.5.'));
    expect(view.result.current.items).toHaveLength(2);

    demoState.value = { active: true, run_id: 'run-2' };
    view.rerender({ caseId: 'demo-1337-0001' });
    await settle();
    expect(view.result.current.items).toEqual([]);
    act(() => {
      view.result.current.send('Summarise the case');
    });
    await settle();
    expect(streams[1].body).toMatchObject({ case_id: 'demo-1337-0001', history: [] });
  });

  it('a case turn of the previous identity that settles later never joins the new session', async () => {
    const first = await mountCase('demo-1337-0001');
    act(() => {
      first.result.current.send('Check indicators');
    });
    await settle();
    await push(streams[0], start('turn-1'));
    // The analyst leaves the case while its turn runs, then Demo is reset.
    first.unmount();
    demoState.value = { active: true, run_id: 'run-2' };
    const again = await mountCase('demo-1337-0001');
    expect(again.result.current.items).toEqual([]);
    again.unmount();
    // Run 1's answer lands now: it is not kept for run 2's case.
    await push(streams[0], done('Run 1 indicators.'));
    expect(readCaseSession('demo-1337-0001')).toBeNull();
    const back = await mountCase('demo-1337-0001');
    expect(back.result.current.items).toEqual([]);
  });

  it('keeps a case session while the identity stays the same, and drops it on a switch', () => {
    noteCaseSessionsDemoIdentity('demo:run-1');
    const session = { items: [{ kind: 'user', key: 'u1', content: 'Q' }], history: [] } as unknown as Parameters<typeof writeCaseSession>[1];
    writeCaseSession('demo-1337-0001', session);
    noteCaseSessionsDemoIdentity('demo:run-1');
    expect(readCaseSession('demo-1337-0001')).not.toBeNull();
    noteCaseSessionsDemoIdentity('off');
    expect(readCaseSession('demo-1337-0001')).toBeNull();
  });
});
