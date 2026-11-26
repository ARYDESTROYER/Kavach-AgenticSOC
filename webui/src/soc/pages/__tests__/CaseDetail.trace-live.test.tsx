/**
 * The AI investigation tab while an AI run is under way, and its tab count (XFCM):
 *
 * - the trace follows the run: an `agent.step` or `case.investigation` frame for this case
 *   on the page's one event stream leads to one quiet re-read after TRACE_REFRESH_MS
 *   (frames in that time share it), with the shown trace kept on screen, no skeleton;
 * - a frame for another case reads nothing, and the run's end reads once more whatever its
 *   outcome; a failed re-read keeps the last good trace;
 * - the tab's count is the AI's own steps (agent and tool), the same number as the trace's
 *   "N AI steps", so people's work, runbook lookups and the code decision add nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';

import type { InvestigationView } from '@/lib/types';
import type { StreamEvent } from '@/lib/useEventStream';

const h = vi.hoisted(() => ({
  run: null as InvestigationView | null,
  timelines: [] as Array<unknown>,
  timelineCalls: 0,
  onEvent: null as ((ev: StreamEvent) => void) | null,
  topics: [] as string[],
}));

const CASE = {
  case_id: 'c-trace-1',
  case_number: 'CASE-2026-0600',
  title: 'Credential stuffing against the portal',
  status: 'investigating',
  verdict: 'TRUE_POSITIVE',
  confidence: 0.8,
  risk_score: 61,
  severity_band: 'high',
  updated_at: '2026-10-10T10:00:00Z',
  created_at: '2026-10-10T09:00:00Z',
  history: [],
};

function span(kind: string, i: number) {
  return {
    step_index: i,
    kind,
    name: `${kind}-${i}`,
    ts: '2026-10-10T10:00:00Z',
    latency_ms: null,
    cost: null,
    tokens: null,
    trusted: true,
    summary: `${kind} step ${i}`,
    payload_ref: null,
  };
}
function trace(kinds: string[]) {
  return { case_id: CASE.case_id, total: kinds.length, totals: { cost: 0, tokens: 0 }, spans: kinds.map(span) };
}

vi.mock('@/lib/api', () => {
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(CASE)),
    get: vi.fn((path: string) => {
      if (path.endsWith('/timeline')) {
        h.timelineCalls += 1;
        const next = h.timelines.length > 1 ? h.timelines.shift() : h.timelines[0];
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      return Promise.resolve({});
    }),
  };
  class ApiError extends Error {
    status = 500;
  }
  return {
    ApiError,
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'probe', hasPermission: () => true, user: null }),
  useCan: () => () => true,
}));

vi.mock('@/soc/investigations/useAiRun', () => ({
  useAiRun: (caseId: string | null | undefined) => (caseId && h.run?.case_id === caseId ? h.run : null),
  useAiRunFinished: () => null,
  useAiRunCount: () => 0,
}));

// The page's one event stream: capture the case room hook the AI investigation tab opens.
vi.mock('@/lib/useEventStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/useEventStream')>();
  return {
    ...actual,
    useEventStream: (topics: string[], opts: { enabled?: boolean; onEvent?: (ev: StreamEvent) => void } = {}) => {
      if (opts.enabled && topics.includes(`cases:${CASE.case_id}`)) {
        h.onEvent = opts.onEvent ?? null;
        h.topics = topics;
      }
      return { live: true };
    },
  };
});

import { CaseDetail, TRACE_REFRESH_MS } from '@/soc/pages/CaseDetail';

function running(): InvestigationView {
  const now = Date.now();
  return {
    run_id: 'inv-trace',
    case_id: CASE.case_id,
    state: 'running',
    phase: 'evidence',
    trigger: 'manual',
    queued_at: new Date(now - 10_000).toISOString(),
    started_at: new Date(now - 9_000).toISOString(),
    deadline_at: new Date(now + 120_000).toISOString(),
    time_cap_seconds: 180,
    finished_at: null,
    outcome: null,
    status_after: null,
    verdict_after: null,
  } as InvestigationView;
}

function view() {
  return <CaseDetail caseId={CASE.case_id} presentation="embedded" requestedTab="investigation" onClose={() => undefined} />;
}

async function renderOnAiTab() {
  const utils = render(view());
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/Credential stuffing/));
  await waitFor(() => expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent(/AI step/));
  return utils;
}

function frame(type: string, caseId = CASE.case_id): StreamEvent {
  return { type, data: { case_id: caseId, step: 'investigator' }, lastEventId: String(Math.random()) };
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  h.run = null;
  h.timelines = [];
  h.timelineCalls = 0;
  h.onEvent = null;
  h.topics = [];
});
afterEach(() => {
  h.run = null;
});

describe('the AI investigation tab follows a run (XFCM)', () => {
  it('reads the trace again once after frames for this case, with no skeleton', async () => {
    h.run = running();
    h.timelines = [trace(['invoke_agent', 'person']), trace(['invoke_agent', 'invoke_agent', 'execute_tool', 'person'])];
    await renderOnAiTab();
    const counts = screen.getByTestId('investigation-trace-counts');
    expect(counts).toHaveTextContent('1 AI step · 0 tools · 1 by people');
    expect(h.timelineCalls).toBe(1);
    // The tab subscribes to this case's room on the page's one stream.
    expect(h.topics).toEqual([`cases:${CASE.case_id}`]);

    act(() => {
      h.onEvent?.(frame('agent.step'));
      h.onEvent?.(frame('case.investigation'));
      h.onEvent?.(frame('agent.step'));
    });
    // Nothing before the wait, and the trace stays on screen meanwhile.
    expect(h.timelineCalls).toBe(1);
    await wait(TRACE_REFRESH_MS + 200);
    expect(h.timelineCalls).toBe(2);
    await waitFor(() => expect(counts).toHaveTextContent('3 AI steps · 1 tool · 1 by people'));
    expect(within(screen.getByTestId('investigation-trace')).queryByText('Loading…')).toBeNull();
  });

  it('reads nothing for a frame about another case, or a channel that is not the run', async () => {
    h.run = running();
    h.timelines = [trace(['invoke_agent'])];
    await renderOnAiTab();
    act(() => {
      h.onEvent?.(frame('agent.step', 'c-other'));
      h.onEvent?.(frame('case.activity'));
    });
    await wait(TRACE_REFRESH_MS + 200);
    expect(h.timelineCalls).toBe(1);
  });

  it('reads the trace once more when the run ends, whatever its outcome', async () => {
    h.run = running();
    h.timelines = [trace(['invoke_agent']), trace(['invoke_agent', 'invoke_agent', 'decision'])];
    const { rerender } = await renderOnAiTab();
    expect(h.timelineCalls).toBe(1);
    h.run = null;
    rerender(view());
    await waitFor(() => expect(h.timelineCalls).toBe(2));
    await waitFor(() => expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('2 AI steps'));
  });

  it('keeps the shown trace when a quiet re-read fails', async () => {
    h.run = running();
    h.timelines = [trace(['invoke_agent', 'execute_tool']), new Error('down')];
    await renderOnAiTab();
    const counts = screen.getByTestId('investigation-trace-counts');
    expect(counts).toHaveTextContent('2 AI steps · 1 tool');
    act(() => h.onEvent?.(frame('agent.step')));
    await wait(TRACE_REFRESH_MS + 200);
    expect(h.timelineCalls).toBe(2);
    expect(counts).toHaveTextContent('2 AI steps · 1 tool');
    expect(screen.queryByText(/Could not load/i)).toBeNull();
  });

  it('opens no case room while no run is under way', async () => {
    h.timelines = [trace(['invoke_agent'])];
    await renderOnAiTab();
    expect(h.onEvent).toBeNull();
  });
});

describe('the AI investigation tab count (XFCM)', () => {
  it('counts no step for people, system and decision spans', async () => {
    h.timelines = [trace(['person', 'system', 'decision', 'person'])];
    await renderOnAiTab();
    const tab = screen.getByRole('tab', { name: /AI investigation/ });
    expect(tab).toHaveAccessibleName('AI investigation');
  });

  it('counts the AI steps only, the same number as the trace summary', async () => {
    h.timelines = [trace(['invoke_agent', 'invoke_agent', 'execute_tool', 'person', 'person', 'person'])];
    await renderOnAiTab();
    expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('3 AI steps · 1 tool · 3 by people');
    expect(screen.getByRole('tab', { name: /AI investigation/ })).toHaveAccessibleName(/^AI investigation\s*, 3 AI steps$/);
  });

  it('says "AI step" for one', async () => {
    h.timelines = [trace(['invoke_agent', 'decision'])];
    await renderOnAiTab();
    expect(screen.getByRole('tab', { name: /AI investigation/ })).toHaveAccessibleName(/^AI investigation\s*, 1 AI step$/);
  });
});
