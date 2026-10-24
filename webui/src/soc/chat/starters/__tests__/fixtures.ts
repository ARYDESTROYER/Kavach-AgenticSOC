/**
 * Starter fixtures: the exact shapes the Round 13 backend serves (generated from
 * `engine.chat_starters.starter_from_template` and `evergreen_starters`), plus a small
 * scripted `fetch` for the starter endpoints. Plain data; every test copies it.
 */
import { vi } from 'vitest';

import type { ChatCatchUp, ChatStarter, ChatStartersInfo } from '@/lib/types';

export const NEEDS_HUMAN: ChatStarter = {
  id: 'needs_human',
  label: 'Needs a person',
  description: 'Escalated 2 hours ago, risk 87',
  prompt: 'Why does case-0042 need a person, and what would settle it?',
  tools: ['get_case', 'explain_decision'],
  template: 'needs_human',
  reason: 'Escalated 2 hours ago, risk 87',
  action: 'send',
  ref: { kind: 'case', value: 'case-0042' },
  key: '3cf51d4967fc61e9',
  urgency: 'critical',
  as_of: null,
  expires_at: null,
};

export const NEW_CASES: ChatStarter = {
  id: 'new_cases',
  label: 'New cases',
  description: '2 critical',
  prompt: 'Which of the 5 cases opened since 09:12 need attention first?',
  tools: ['search_cases', 'case_stats'],
  template: 'new_cases',
  reason: '2 critical',
  action: 'send',
  ref: null,
  key: '89f4b56ced3bb163',
  urgency: 'critical',
  as_of: null,
  expires_at: null,
};

export const SILENT_SOURCE: ChatStarter = {
  id: 'silent_source',
  label: 'Quiet log source',
  description: 'No events for 3 hours',
  prompt: 'Why has log source Wazuh gone quiet, and is ingestion working?',
  tools: ['source_health'],
  template: 'silent_source',
  reason: 'No events for 3 hours',
  action: 'send',
  ref: { kind: 'source', value: 'Wazuh' },
  key: '082bb58bfc7dda29',
  urgency: 'attention',
  as_of: null,
  expires_at: null,
};

export const CONTINUE: ChatStarter = {
  id: 'continue',
  label: 'Continue a chat',
  description: 'Answer ready',
  prompt: 'Continue: Brute force review',
  tools: [],
  template: 'continue',
  reason: 'Answer ready',
  action: 'open_conversation',
  ref: { kind: 'conversation', value: 'c-older' },
  key: 'f24fc03d1a90a7e5',
  urgency: 'none',
  as_of: null,
  expires_at: null,
};

export const SAVED_BOOK: ChatStarter = {
  id: 'saved_prompt',
  label: 'Promptbook',
  description: 'Promptbook, 3 steps',
  prompt: 'Run your promptbook: Weekly review',
  tools: [],
  template: 'saved_book',
  reason: 'Promptbook, 3 steps',
  action: 'use_prompt',
  ref: { kind: 'prompt', value: 'book-x1' },
  key: '777050436ba69a64',
  urgency: 'none',
  as_of: null,
  expires_at: null,
};

export const TRIAGE: ChatStarter = {
  id: 'triage',
  label: 'Triage',
  description: 'Your open queue',
  prompt: 'Which open cases need attention first, and why?',
  tools: ['search_cases'],
  template: 'triage',
  reason: 'Your open queue',
  action: 'send',
  ref: null,
  key: 'b9ff95ce21792212',
  urgency: 'none',
  as_of: null,
  expires_at: null,
};

export const POSTURE: ChatStarter = {
  id: 'posture',
  label: 'Posture now',
  description: 'Key figures and the trend',
  prompt: 'How is our security posture right now, and how did it change in the last 24 hours?',
  tools: ['soc_metrics'],
  template: 'posture',
  reason: 'Key figures and the trend',
  action: 'send',
  ref: null,
  key: 'c80fd438d775fb98',
  urgency: 'none',
  as_of: null,
  expires_at: null,
};

export const CASE_NEEDS_PERSON: ChatStarter = {
  id: 'case_needs_person',
  label: 'Needs a person',
  description: '',
  prompt: 'Why does this case need a person, and what would settle it?',
  tools: ['get_case', 'explain_decision'],
  template: 'case_needs_person',
  reason: '',
  action: 'send',
  ref: null,
  key: '828e8c60ce53d8c9',
  urgency: 'none',
  as_of: null,
  expires_at: null,
};

export const CASE_HANDOFF: ChatStarter = {
  id: 'case_handoff',
  label: 'Handoff note',
  description: '',
  prompt: 'Summarise this case for a handoff note.',
  tools: ['get_case'],
  template: 'case_handoff',
  reason: '',
  action: 'send',
  ref: null,
  key: 'f666db87e1b091e3',
  urgency: 'none',
  as_of: null,
  expires_at: null,
};

export const CATCH_UP: ChatCatchUp = {
  since: '2026-10-17T09:12:00Z',
  since_label: '09:12',
  clauses: [
    { text: '5 new cases (2 critical)', starter: NEW_CASES },
    { text: 'Wazuh quiet for 3 hours', starter: SILENT_SOURCE },
  ],
};

/** Six cards in server order: three signals, then evergreen. */
export const HOME_STARTERS: ChatStarter[] = [NEEDS_HUMAN, NEW_CASES, SILENT_SOURCE, CONTINUE, TRIAGE, POSTURE];

export function makeInfo(overrides: Partial<ChatStartersInfo> = {}): ChatStartersInfo {
  const asOf = new Date();
  return {
    surface: 'home',
    enabled: true,
    as_of: asOf.toISOString(),
    expires_at: new Date(asOf.getTime() + 120_000).toISOString(),
    timezone: 'Europe/London',
    starters: HOME_STARTERS.map((s) => ({ ...s })),
    catch_up: null,
    ...overrides,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface StarterCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | null | undefined;
}

/**
 * A scripted fetch for the starter endpoints: `reply(call)` answers each GET
 * `/api/chat/starters`; events are recorded and answered 204. Anything else is a 404.
 */
export function stubStarterFetch(reply: (call: StarterCall) => Response | Promise<Response>) {
  const calls: StarterCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: StarterCall = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const path = url.split('?')[0];
    if (path === '/api/chat/starters/events') return new Response(null, { status: 204 });
    if (path === '/api/chat/starters') return reply(call);
    return json({ detail: 'Not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    reads: () => calls.filter((c) => c.url.split('?')[0] === '/api/chat/starters'),
    events: () => calls.filter((c) => c.url.split('?')[0] === '/api/chat/starters/events').map((c) => c.body),
  };
}

export function query(call: StarterCall): URLSearchParams {
  return new URLSearchParams(call.url.split('?')[1] ?? '');
}
