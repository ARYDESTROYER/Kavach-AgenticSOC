/**
 * Transcript fixtures for the message/transcript/workspace tests: normalised items
 * exactly as `useChatEngine` produces them, and a stub engine whose actions are spies.
 */
import { vi } from 'vitest';

import type { ChatResponse, ChatStep, TurnUsage } from '@/lib/types';
import type { ChatAssistantItem, ChatLiveTurn, ChatUserItem } from '../../useChatEngine';
import type { MessageEngine } from '../Message';

export const USAGE: TurnUsage = {
  calls: 2,
  embedding_calls: 0,
  input_tokens: 1500,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 600,
  total_tokens: 2100,
  cost: 0.0042,
  latency_ms: 1800,
  model: 'gpt-test',
  pricing_source: 'catalog',
  simulated: false,
  estimated: false,
  context_window: 128000,
  peak_prompt_tokens: 1500,
};

export function step(index: number, extra: Partial<ChatStep> = {}): ChatStep {
  return {
    index,
    ordinal: index,
    kind: 'tool',
    tool: 'search_logs',
    label: 'Searched logs',
    params: { window: 'last 24h', source: 'Wazuh' },
    status: 'ok',
    duration_ms: 1200,
    summary: '1,284 matching events',
    untrusted_params: {},
    query: 'event.outcome:failure AND source.ip:10.0.0.5',
    rows: 200,
    basis: 'newest_n',
    coverage: 'newest 200 of 1,284',
    sources: ['Wazuh'],
    usage: null,
    group: null,
    ...extra,
  };
}

export function response(extra: Partial<ChatResponse> = {}): ChatResponse {
  return {
    answer: 'Five failed logins came from **10.0.0.5** [D1].',
    cost: USAGE.cost,
    blocks: [],
    steps: [step(1), step(2, { label: 'Counted cases', tool: 'search_cases', query: null, coverage: null, rows: 3, basis: 'exact' })],
    usage: USAGE,
    citations: [{ id: 'D1', kind: 'doc', title: 'Failed logins', untrusted: false, doc: '/docs/0.1/analyst/chat/' }],
    console_links: [],
    follow_ups: [],
    answer_kind: 'data',
    notice: null,
    stream_mode: 'steps',
    turn_id: 'turn-1',
    message_id: 'm-assistant-1',
    ...extra,
  };
}

let counter = 0;

export function userItem(content = 'Show failed logins', extra: Partial<ChatUserItem> = {}): ChatUserItem {
  counter += 1;
  return {
    kind: 'user',
    key: `user-${counter}`,
    messageId: `m-user-${counter}`,
    content,
    prompt: content,
    origin: 'user',
    at: Date.parse('2026-10-08T10:00:00Z'),
    requestKey: `chat-key-${counter}`,
    failed: false,
    ...extra,
  };
}

export function assistantItem(extra: Partial<ChatAssistantItem> = {}): ChatAssistantItem {
  counter += 1;
  return {
    kind: 'assistant',
    key: `assistant-${counter}`,
    messageId: 'm-assistant-1',
    at: Date.parse('2026-10-08T10:00:05Z'),
    requestKey: `chat-key-${counter}`,
    status: 'done',
    response: response(),
    live: null,
    failure: null,
    restored: false,
    model: 'gpt-test',
    source: 'Wazuh',
    request: { message: 'Show failed logins', idempotency_key: `chat-key-${counter}` },
    ...extra,
  };
}

export function live(extra: Partial<ChatLiveTurn> = {}): ChatLiveTurn {
  return {
    transport: 'stream',
    turnId: 'turn-9',
    model: 'gpt-test',
    streamMode: 'steps',
    replayed: false,
    estimatePromptTokens: 900,
    steps: [],
    usage: null,
    text: '',
    stopping: false,
    connection: 'open',
    startedAt: Date.now(),
    ...extra,
  };
}

export function runningItem(liveExtra: Partial<ChatLiveTurn> = {}): ChatAssistantItem {
  return assistantItem({ status: 'running', response: null, messageId: null, live: live(liveExtra) });
}

export function stubEngine(extra: Partial<MessageEngine> = {}): MessageEngine {
  return {
    busy: false,
    retry: vi.fn(() => true),
    askAgain: vi.fn(() => true),
    continueAnswer: vi.fn(() => true),
    send: vi.fn(() => true),
    ...extra,
  };
}
