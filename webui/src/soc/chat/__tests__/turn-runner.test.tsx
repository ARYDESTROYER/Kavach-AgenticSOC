/**
 * turn-runner (Round 12, SPEC D13 / D6): the module-level registry behind turns that
 * outlive their view — the bounded per-case session transcripts, sign-out stopping every
 * read, and the run-log line while a question waits for chat capacity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ChatRequest } from '@/lib/types';
import { clearChatActivity, getChatActivity } from '../../chat-activity/activity';
import { RunLogHeader } from '../message/RunLog';
import { live } from '../message/__tests__/fixtures';
import {
  MAX_CASE_SESSIONS,
  MAX_CASE_SESSION_ITEMS,
  findRun,
  readCaseSession,
  resetTurnRunnerForTests,
  startRun,
  writeCaseSession,
  type ChatTranscriptItem,
} from '../turn-runner';

const user = (n: number): ChatTranscriptItem => ({
  kind: 'user',
  key: `u${n}`,
  messageId: null,
  content: `Question ${n}`,
  prompt: `Question ${n}`,
  origin: 'user',
  at: n,
  requestKey: `k${n}`,
  failed: false,
});
const answer = (n: number): ChatTranscriptItem => ({
  kind: 'assistant',
  key: `a${n}`,
  messageId: `m${n}`,
  at: n,
  requestKey: `k${n}`,
  status: 'done',
  response: { answer: `Answer ${n}` },
  live: null,
  failure: null,
  restored: false,
  model: null,
  source: null,
  request: null,
});

beforeEach(() => {
  resetTurnRunnerForTests();
  clearChatActivity();
  vi.stubGlobal('BroadcastChannel', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('case sessions (memory only)', () => {
  it('keep the last 20 cases, each to its last 50 items starting on a prompt', () => {
    for (let i = 0; i < MAX_CASE_SESSIONS + 3; i += 1) {
      writeCaseSession(`case-${i}`, { items: [user(i), answer(i)], history: [] });
    }
    expect(readCaseSession('case-0')).toBeNull();
    expect(readCaseSession('case-2')).toBeNull();
    expect(readCaseSession('case-3')?.items).toHaveLength(2);
    expect(readCaseSession(`case-${MAX_CASE_SESSIONS + 2}`)).not.toBeNull();

    const long: ChatTranscriptItem[] = [];
    for (let i = 0; i < 40; i += 1) long.push(user(i), answer(i));
    writeCaseSession('case-long', { items: long, history: [] });
    const kept = readCaseSession('case-long')?.items ?? [];
    expect(kept.length).toBeLessThanOrEqual(MAX_CASE_SESSION_ITEMS);
    expect(kept[0].kind).toBe('user');
    expect(kept[kept.length - 1]).toMatchObject({ key: 'a39' });
  });

  it('an empty session is forgotten rather than stored', () => {
    writeCaseSession('case-empty', { items: [user(1)], history: [] });
    writeCaseSession('case-empty', { items: [], history: [] });
    expect(readCaseSession('case-empty')).toBeNull();
  });
});

describe('sign-out', () => {
  it('stops reading every turn and forgets it (the server finishes and saves it)', async () => {
    let signal: AbortSignal | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? null;
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }),
    );
    const request: ChatRequest = { message: 'Investigate host X', history: [], idempotency_key: 'chat-key-0001', persist_conversation: true };
    const run = startRun({ scope: 'draft:chat-key-0001', kind: 'workspace', request, origin: 'user', transport: 'stream', streamMode: 'steps' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getChatActivity().entries.map((entry) => entry.scope)).toEqual(['draft:chat-key-0001']);
    expect(signal).not.toBeNull();
    clearChatActivity();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(run.state).toBe('lost');
    expect(findRun('draft:chat-key-0001')).toBeNull();
    expect(getChatActivity().entries).toEqual([]);
  });
});

describe('RunLogHeader', () => {
  it('says the question is waiting while chat is at capacity (SPEC D6)', () => {
    render(<RunLogHeader live={live({ waiting: true })} open={false} onToggle={() => undefined} controls="log" />);
    expect(screen.getByTestId('run-log-header')).toHaveTextContent('Waiting for another answer to finish');
  });
});
