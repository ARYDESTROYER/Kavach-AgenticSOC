/**
 * The shell's chat-turn observer notes the Demo status too (PR #132 verify 2), with the
 * real `DemoProvider`, the real `ActivityEffects` and the real turn runner.
 *
 * The observer makes the runs no chat view started (`trackRun`: a running turn the
 * server reports after a reload, one handed over by another tab), and the runner stamps
 * each one with the chat's Demo switch token. Noted by the chat views only, a Demo reset
 * before the first chat view rendered on the page read as the first confirmed status,
 * not as a switch: a case answer followed under run 1 then showed under run 2's case with
 * the same id (a reset re-seeds the same ids). Here:
 *
 * - a reset after such a run settled starts the case clean (nothing of run 1 shows, and
 *   the next question goes with no history), whether the observer found the turn itself
 *   (a reload) or another tab handed it over;
 * - a failed status poll is still no switch for the observer (the answer stays);
 * - nor is the first status read landing after the run was made (the answer stays).
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

import type { ChatRequest } from '@/lib/types';
import { DemoProvider, useDemo, type DemoContextValue } from '@/soc/demo';
import { resetChatDemoIdentityForTests } from '@/soc/chat/demo-identity';
import { pollParkedRuns, readCaseSession, resetTurnRunnerForTests, trackRun } from '@/soc/chat/turn-runner';
import { useChatEngine, type ChatEngine, type ChatTranscriptItem } from '@/soc/chat/useChatEngine';
import ActivityEffects from '../ActivityEffects';
import { clearChatActivity, getChatActivity } from '../activity';

const CASE = 'demo-1337-0001';

type ServerDemo = 'run-1' | 'run-2';
let serverDemo: ServerDemo = 'run-1';
/** The next status reads answer 503 (Demo stays as it is on the server). */
let statusFails = false;
/** Status reads wait until `releaseStatus()` (the first read has not landed yet). */
let holdStatus = false;
let heldStatus: Array<() => void> = [];
/** What `GET /chat/turns/active` lists (the server's running turns). */
let activeTurns: unknown[] = [];

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
  return json({ mode: 'seeded', active: true, run_id: serverDemo });
}

beforeEach(() => {
  resetChatDemoIdentityForTests();
  resetTurnRunnerForTests();
  clearChatActivity();
  vi.stubGlobal('BroadcastChannel', undefined);
  serverDemo = 'run-1';
  statusFails = false;
  holdStatus = false;
  heldStatus = [];
  activeTurns = [];
  streams = [];
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const path = url.split('?')[0];
      if (path === '/api/demo/status') {
        if (holdStatus) return new Promise<Response>((resolve) => heldStatus.push(() => resolve(statusAnswer())));
        return statusAnswer();
      }
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/turns/active') return json(activeTurns);
      if (path === '/api/chat/conversations') return json({ conversations: [] });
      if (path === '/api/chat/stream') return openStream(url, JSON.parse(String(init?.body)) as ChatRequest);
      if (/^\/api\/chat\/turns\/[^/]+\/events$/.test(path)) return openStream(url, null);
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
const answers = (items: ChatTranscriptItem[]) =>
  items.flatMap((item) => (item.kind === 'assistant' && item.response ? [item.response.answer] : []));

/* -------------------------------------------------------------------------- */
/* The console: the shell's observer, and a case chat that opens later.        */
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

/** The shell (Overview after a reload, say): no chat view until `open`. */
function Shell({ open }: { open: boolean }) {
  return (
    <DemoProvider>
      <DemoProbe />
      <ActivityEffects username="" onNavigate={vi.fn()} />
      {open ? <CaseView caseId={CASE} /> : null}
    </DemoProvider>
  );
}

const pollStatus = () =>
  act(async () => {
    await demo.refresh();
  });

/** A run-1 case turn the observer follows (no chat view open) ends with its answer. */
async function settleFollowedTurn(answer: string) {
  activeTurns = [];
  await act(async () => {
    await pollParkedRuns();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const tail = streams.find((stream) => stream.url.startsWith('/api/chat/turns/turn-x/events'));
  expect(tail).toBeDefined();
  await push(tail as StreamHandle, start('turn-x'), done(answer));
  expect(readCaseSession(CASE)).not.toBeNull();
}

/** The analyst opens the case's Chat tab and asks: what shows, and what goes as history. */
async function openCaseAndAsk(view: ReturnType<typeof render>) {
  view.rerender(<Shell open />);
  await settle();
  const shown = answers(engine.items);
  act(() => {
    engine.send('Summarise the case');
  });
  await settle();
  const sent = streams.filter((stream) => stream.url === '/api/chat/stream').at(-1)?.body ?? null;
  return { shown, sent };
}

describe('the shell observer notes the Demo status (PR #132 verify 2)', () => {
  it('a case answer followed after a reload under run 1 never shows under run 2 after a reset', async () => {
    // The reload: the server still runs a run-1 case turn, and no chat view is open.
    activeTurns = [{ turn_id: 'turn-x', case_id: CASE, status: 'running', label: 'Reading the case' }];
    const view = render(<Shell open={false} />);
    await settle();
    expect(demo).toMatchObject({ active: true, confirmed: true });
    expect(getChatActivity().entries.map((entry) => entry.turnId)).toContain('turn-x');
    await settleFollowedTurn('Run 1 answer.');

    // Reset: run 2 re-seeds the same case ids. Still no chat view.
    serverDemo = 'run-2';
    await pollStatus();
    expect(demo.status.run_id).toBe('run-2');

    const { shown, sent } = await openCaseAndAsk(view);
    expect(shown).toEqual([]);
    expect(sent).toMatchObject({ case_id: CASE, history: [] });
  });

  it('a case turn another tab handed over is held to its own run the same way', async () => {
    const view = render(<Shell open={false} />);
    await settle();
    expect(demo).toMatchObject({ active: true, confirmed: true });
    activeTurns = [{ turn_id: 'turn-x', case_id: CASE, status: 'running' }];
    act(() => {
      trackRun({ scope: `case:${CASE}`, kind: 'case', caseId: CASE, turnId: 'turn-x', title: 'Summarise the case' });
    });
    await settleFollowedTurn('Run 1 answer.');

    serverDemo = 'run-2';
    await pollStatus();

    const { shown, sent } = await openCaseAndAsk(view);
    expect(shown).toEqual([]);
    expect(sent).toMatchObject({ case_id: CASE, history: [] });
  });

  it('a failed status poll is no switch: the followed answer stays', async () => {
    activeTurns = [{ turn_id: 'turn-x', case_id: CASE, status: 'running' }];
    const view = render(<Shell open={false} />);
    await settle();
    await settleFollowedTurn('Run 1 answer.');

    statusFails = true;
    await pollStatus();
    expect(demo.confirmed).toBe(false);
    statusFails = false;
    await pollStatus();
    expect(demo).toMatchObject({ confirmed: true, status: { run_id: 'run-1' } });

    const { shown } = await openCaseAndAsk(view);
    expect(shown).toEqual(['Run 1 answer.']);
  });

  it('the first status read landing after the run was made is no switch either', async () => {
    holdStatus = true;
    activeTurns = [{ turn_id: 'turn-x', case_id: CASE, status: 'running' }];
    const view = render(<Shell open={false} />);
    await settle();
    expect(demo.confirmed).toBe(false);
    await waitFor(() => expect(getChatActivity().entries.map((entry) => entry.turnId)).toContain('turn-x'));
    await settleFollowedTurn('Run 1 answer.');

    holdStatus = false;
    await act(async () => {
      for (const release of heldStatus.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(demo).toMatchObject({ confirmed: true, status: { run_id: 'run-1' } });

    const { shown } = await openCaseAndAsk(view);
    expect(shown).toEqual(['Run 1 answer.']);
  });
});
