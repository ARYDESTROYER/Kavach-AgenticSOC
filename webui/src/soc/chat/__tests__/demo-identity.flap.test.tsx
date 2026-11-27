/**
 * The chat's Demo identity follows CONFIRMED Demo status reads only (PR #132 verify,
 * defect 1), with the real `DemoProvider`.
 *
 * The provider shows an OFF stand-in before its first status read lands and after any
 * failed read (a network blip, a 502/503, a 429), marked `confirmed: false`. Taken as
 * "Demo left", one failed 20 s poll swung a Demo session to off and back: every case
 * transcript was dropped, a running case turn was no longer followed (nor saved when it
 * settled), and the starters dropped their cache, their hidden cards and any waiting
 * dismissal and read twice. Here:
 *
 * - a failed read changes nothing (the case chat keeps its transcript and its running
 *   turn, the starters keep their cards, their cache, their hides and their waiting
 *   dismissal, and read nothing);
 * - the first confirmed read is no switch (a case turn sent, or re-attached after a
 *   reload, before it lands is kept; the starters read once);
 * - a confirmed switch after a failed read is still a switch (the original PR #132
 *   fix: leaving, entering or resetting Demo drops the old identity's data at once).
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';

import type { ChatRequest, ChatStartersInfo } from '@/lib/types';
import { DemoProvider, useDemo, type DemoContextValue } from '@/soc/demo';
import { clearChatActivity } from '../../chat-activity/activity';
import { noteChatDemoStatus, resetChatDemoIdentityForTests } from '../demo-identity';
import {
  clearChatStartersCache,
  commitStarterDismissal,
  hideStarterLocally,
  useChatStarters,
  useHiddenStarterKeys,
} from '../starters/useChatStarters';
import { NEEDS_HUMAN, NEW_CASES, makeInfo } from '../starters/__tests__/fixtures';
import { TURN_RUNNER_TIMING, resetTurnRunnerForTests, trackRun } from '../turn-runner';
import { useChatEngine, type ChatEngine, type ChatTranscriptItem } from '../useChatEngine';

const CASE = 'demo-1337-0001';
const DEMO_CARD = { ...NEEDS_HUMAN, key: 'd1d1d1d1d1d1d1d1', prompt: 'Which cases need a person, starting with CASE-001042?' };
const DEMO_RUN_2_CARD = { ...DEMO_CARD, key: 'd2d2d2d2d2d2d2d2', prompt: 'Which cases need a person, starting with CASE-002077?' };
const REAL_CARD = { ...NEW_CASES, key: 'a0a0a0a0a0a0a0a0', prompt: 'What came in since my last visit?' };

/* -------------------------------------------------------------------------- */
/* The server: its Demo state, a status read that can fail or be held back.    */
/* -------------------------------------------------------------------------- */

type ServerDemo = 'run-1' | 'run-2' | 'off';
let serverDemo: ServerDemo = 'run-1';
/** The next status reads answer 503 (Demo stays as it is on the server). */
let statusFails = false;
/** Status reads wait until `releaseStatus()` (the first read has not landed yet). */
let holdStatus = false;
let heldStatus: Array<() => void> = [];
let calls: Array<{ url: string; method: string; body: unknown }> = [];

const encoder = new TextEncoder();
interface StreamHandle {
  url: string;
  body: ChatRequest | null;
  push: (event: unknown) => void;
}
let streams: StreamHandle[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function openStream(url: string, body: ChatRequest | null): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  streams.push({ url, body, push: (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

function statusAnswer(): Response {
  if (statusFails) return json({ detail: 'Service unavailable' }, 503);
  if (serverDemo === 'off') return json({ mode: 'off', active: false, run_id: null });
  return json({ mode: 'seeded', active: true, run_id: serverDemo });
}

function startersAnswer(): ChatStartersInfo {
  if (serverDemo === 'off') return makeInfo({ starters: [{ ...REAL_CARD }] });
  return makeInfo({ starters: [{ ...(serverDemo === 'run-2' ? DEMO_RUN_2_CARD : DEMO_CARD) }] });
}

beforeEach(() => {
  resetChatDemoIdentityForTests();
  resetTurnRunnerForTests();
  clearChatActivity();
  clearChatStartersCache();
  vi.stubGlobal('BroadcastChannel', undefined);
  serverDemo = 'run-1';
  statusFails = false;
  holdStatus = false;
  heldStatus = [];
  calls = [];
  streams = [];
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      calls.push({ url, method, body });
      const path = url.split('?')[0];
      if (path === '/api/demo/status') {
        if (holdStatus) return new Promise<Response>((resolve) => heldStatus.push(() => resolve(statusAnswer())));
        return statusAnswer();
      }
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/starters') return json(startersAnswer());
      if (path === '/api/chat/starters/events') return new Response(null, { status: 204 });
      if (path === '/api/chat/stream') return openStream(url, body as ChatRequest);
      if (/^\/api\/chat\/turns\/[^/]+\/events$/.test(path)) return openStream(url, null);
      if (path === '/api/chat/turns/active') return json([]);
      if (/^\/api\/chat\/turns\/[^/]+\/(cancel|seen)$/.test(path)) return json({ ok: true });
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

const statusReads = () => calls.filter((call) => call.url === '/api/demo/status');
const starterReads = () => calls.filter((call) => call.url.split('?')[0] === '/api/chat/starters');
const starterEvents = () => calls.filter((call) => call.url === '/api/chat/starters/events').map((call) => call.body);
const answers = (items: ChatTranscriptItem[]) =>
  items.flatMap((item) => (item.kind === 'assistant' && item.response ? [item.response.answer] : []));

/* -------------------------------------------------------------------------- */
/* The console: the shared Demo context and one case chat that can close.      */
/* -------------------------------------------------------------------------- */

let demo: DemoContextValue;
let engine: ChatEngine;

function DemoProbe() {
  demo = useDemo();
  return null;
}

function CaseView({ caseId }: { caseId: string }) {
  engine = useChatEngine({ caseId });
  return null;
}

function Shell({ open = true }: { open?: boolean }) {
  return (
    <DemoProvider>
      <DemoProbe />
      {open ? <CaseView caseId={CASE} /> : null}
    </DemoProvider>
  );
}

/** One poll of the status, as the provider's 20 s timer runs it. */
const pollStatus = () =>
  act(async () => {
    await demo.refresh();
  });

/** One failed poll (a 503 from the proxy) while Demo stays on on the server. */
async function failOnePoll() {
  statusFails = true;
  await pollStatus();
  statusFails = false;
}

async function releaseStatus() {
  holdStatus = false;
  await act(async () => {
    for (const release of heldStatus.splice(0)) release();
  });
}

function send(prompt: string) {
  act(() => {
    engine.send(prompt);
  });
}

/* -------------------------------------------------------------------------- */

describe('the Demo switch token', () => {
  const standIn = { active: false, confirmed: false, status: { run_id: null } };
  const on = (run: string) => ({ active: true, confirmed: true, status: { run_id: run } });
  const off = { active: false, confirmed: true, status: { run_id: null } };

  it('changes only on a confirmed switch: never for the stand-in, nor for the first confirmed read', () => {
    const first = noteChatDemoStatus(standIn);
    expect(noteChatDemoStatus(on('run-1'))).toBe(first); // the first read landed: no switch
    expect(noteChatDemoStatus(standIn)).toBe(first); // a failed read
    expect(noteChatDemoStatus(on('run-1'))).toBe(first); // and the next good one
    const left = noteChatDemoStatus(off);
    expect(left).not.toBe(first); // Exit demo
    expect(noteChatDemoStatus(standIn)).toBe(left);
    const back = noteChatDemoStatus(on('run-1'));
    expect([first, left]).not.toContain(back); // back to an identity seen before: a switch
    expect(noteChatDemoStatus(on('run-2'))).not.toBe(back); // a reset
    // Outside a provider (no `confirmed`) the inert OFF value is an answer.
    expect(noteChatDemoStatus({ active: false, status: { run_id: null } })).not.toBe(noteChatDemoStatus(on('run-3')));
  });

  it('the provider marks its OFF stand-in unconfirmed: before the first read and after a failed one', async () => {
    holdStatus = true;
    render(<Shell open={false} />);
    await settle();
    expect(demo).toMatchObject({ active: false, confirmed: false, loading: true });
    await releaseStatus();
    await settle();
    expect(demo).toMatchObject({ active: true, confirmed: true, loading: false });
    await failOnePoll();
    expect(demo).toMatchObject({ active: false, confirmed: false });
    serverDemo = 'off';
    await pollStatus();
    expect(demo).toMatchObject({ active: false, confirmed: true });
  });
});

describe('case chat and a failed Demo status read', () => {
  it('a failed status poll while Demo stays on keeps the case transcript and its history', async () => {
    render(<Shell />);
    await settle();
    expect(demo.active).toBe(true);
    send('Summarise the case');
    await settle();
    await push(streams[0], start('turn-1'), done('Run 1: 4 alerts from 10.0.0.5.'));
    expect(engine.items).toHaveLength(2);

    await failOnePoll();
    await settle();
    expect(demo.confirmed).toBe(false);
    expect(engine.items).toHaveLength(2);
    await pollStatus();
    await settle();
    expect(demo.active).toBe(true);
    expect(answers(engine.items)).toEqual(['Run 1: 4 alerts from 10.0.0.5.']);
    // The next question still carries the exchange as history.
    send('And the source?');
    await settle();
    expect(streams[1].body?.history?.length ?? 0).toBeGreaterThan(0);
  });

  it('keeps following a running case turn across a failed poll and saves it when it settles unseen', async () => {
    const view = render(<Shell />);
    await settle();
    send('Check indicators');
    await settle();
    await push(streams[0], start('turn-1'));
    await failOnePoll();
    await pollStatus();
    await settle();
    expect(engine.busy).toBe(true);
    expect(engine.items).toHaveLength(2);
    // The analyst closes the chat; the answer lands while nobody looks.
    view.rerender(<Shell open={false} />);
    await failOnePoll();
    await push(streams[0], done('Run 1 indicators: clean.'));
    view.rerender(<Shell />);
    await settle();
    expect(answers(engine.items)).toEqual(['Run 1 indicators: clean.']);
  });

  it('keeps a case turn sent before the first status read lands (Demo turns out to be on)', async () => {
    holdStatus = true;
    render(<Shell />);
    await settle();
    expect(demo.confirmed).toBe(false);
    send('Summarise the case');
    await settle();
    await push(streams[0], start('turn-1'), done('Run 1: 4 alerts.'));
    send('Check indicators');
    await settle();
    await push(streams[1], start('turn-2'));
    await releaseStatus();
    await settle();
    expect(demo.active).toBe(true);
    expect(engine.items).toHaveLength(4);
    await push(streams[1], done('Run 1 indicators: clean.'));
    expect(answers(engine.items)).toEqual(['Run 1: 4 alerts.', 'Run 1 indicators: clean.']);
  });

  it('follows a case turn re-attached after a reload before the first status read lands', async () => {
    TURN_RUNNER_TIMING.parkPollMs = 60_000;
    holdStatus = true;
    // The activity observer re-finds the running turn before any chat view renders.
    trackRun({ scope: `case:${CASE}`, kind: 'case', caseId: CASE, turnId: 'turn-r', title: 'Summarise the case' });
    render(<Shell />);
    await settle();
    await releaseStatus();
    await settle();
    expect(demo.active).toBe(true);
    const tail = streams.find((stream) => stream.url.startsWith('/api/chat/turns/turn-r/events'));
    expect(tail).toBeDefined();
    await push(tail as StreamHandle, start('turn-r'), done('Re-attached answer.'));
    expect(answers(engine.items)).toEqual(['Re-attached answer.']);
  });

  it('still starts the case clean on a confirmed switch after a failed poll (a reset during the outage)', async () => {
    render(<Shell />);
    await settle();
    send('Summarise the case');
    await settle();
    await push(streams[0], start('turn-1'), done('Run 1: 4 alerts.'));
    await failOnePoll();
    serverDemo = 'run-2';
    await pollStatus();
    await settle();
    expect(engine.items).toEqual([]);
    send('Summarise the case');
    await settle();
    expect(streams[1].body).toMatchObject({ case_id: CASE, history: [] });
  });
});

describe('starters and a failed Demo status read', () => {
  function renderHome() {
    return renderHook(
      () => ({ starters: useChatStarters({ surface: 'home', principal: 'alice' }), hidden: useHiddenStarterKeys(), demo: useDemo() }),
      { wrapper: DemoProvider },
    );
  }
  const prompts = (info: ChatStartersInfo | null) => (info?.starters ?? []).map((s) => s.prompt);

  it('keeps the cards and the cache, and reads nothing, across a failed poll', async () => {
    const view = renderHome();
    await waitFor(() => expect(prompts(view.result.current.starters.info)).toEqual([DEMO_CARD.prompt]));
    expect(starterReads()).toHaveLength(1);
    await act(async () => {
      statusFails = true;
      await view.result.current.demo.refresh();
      statusFails = false;
    });
    expect(view.result.current.demo.confirmed).toBe(false);
    expect(prompts(view.result.current.starters.info)).toEqual([DEMO_CARD.prompt]);
    await act(async () => {
      await view.result.current.demo.refresh();
    });
    await settle();
    expect(prompts(view.result.current.starters.info)).toEqual([DEMO_CARD.prompt]);
    expect(starterReads()).toHaveLength(1);
    // A later mount inside the minute still answers from the cache.
    view.unmount();
    const again = renderHome();
    await settle();
    expect(prompts(again.result.current.starters.info)).toEqual([DEMO_CARD.prompt]);
    expect(starterReads()).toHaveLength(1);
  });

  it('keeps a hidden card hidden and still posts its waiting dismissal after a failed poll', async () => {
    const view = renderHome();
    await waitFor(() => expect(view.result.current.starters.info).not.toBeNull());
    act(() => {
      hideStarterLocally(DEMO_CARD.key, DEMO_CARD.key, 'alice');
    });
    await act(async () => {
      statusFails = true;
      await view.result.current.demo.refresh();
      statusFails = false;
    });
    expect(view.result.current.demo.confirmed).toBe(false);
    expect(view.result.current.hidden.has(DEMO_CARD.key)).toBe(true);
    await act(async () => {
      await view.result.current.demo.refresh();
    });
    await settle();
    expect(view.result.current.hidden.has(DEMO_CARD.key)).toBe(true);
    act(() => commitStarterDismissal(DEMO_CARD.key));
    await waitFor(() => expect(starterEvents()).toEqual([{ type: 'dismissed', surface: 'home', keys: [DEMO_CARD.key] }]));
    expect(starterReads()).toHaveLength(1);
  });

  it('reads once when the cards load before the first status read lands', async () => {
    holdStatus = true;
    const view = renderHome();
    await waitFor(() => expect(prompts(view.result.current.starters.info)).toEqual([DEMO_CARD.prompt]));
    expect(view.result.current.demo.confirmed).toBe(false);
    await releaseStatus();
    await settle();
    expect(view.result.current.demo.active).toBe(true);
    expect(prompts(view.result.current.starters.info)).toEqual([DEMO_CARD.prompt]);
    expect(starterReads()).toHaveLength(1);
    expect(statusReads()).toHaveLength(1);
  });

  it('still drops the run\'s cards at once when Exit demo is confirmed after a failed poll', async () => {
    const view = renderHome();
    await waitFor(() => expect(prompts(view.result.current.starters.info)).toEqual([DEMO_CARD.prompt]));
    await act(async () => {
      statusFails = true;
      await view.result.current.demo.refresh();
      statusFails = false;
    });
    serverDemo = 'off';
    await act(async () => {
      await view.result.current.demo.refresh();
    });
    // Read at once; the run's card is never shown again.
    expect(prompts(view.result.current.starters.info)).not.toContain(DEMO_CARD.prompt);
    await waitFor(() => expect(prompts(view.result.current.starters.info)).toEqual([REAL_CARD.prompt]));
    expect(starterReads()).toHaveLength(2);
  });
});
