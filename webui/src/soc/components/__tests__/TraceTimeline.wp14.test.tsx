/**
 * Round 16 (SPEC §4.5 WP14, research data-visibility R4 and R14): the trace shows what
 * the agent ran and saw without an audit grant, and stops crediting people's work to the
 * AI.
 *
 * * Each span has a Details disclosure: the model, latency, tokens and cost with how the
 *   cost was found, the tool input as a JSON tree and the query, the tool output and the
 *   prompt excerpt fenced and marked untrusted (a hostile value renders literally).
 * * A person's span (`person`) and a case chat span (`chat`) are their own kinds: the
 *   Agent filter leaves them out and the step counter counts AI steps only.
 * * A trace cut to the newest records says so.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';
import {
  TRACE_FILTERS,
  TraceTimeline,
  filterSpans,
  isAiStep,
  spanActor,
  traceCountsText,
  traceCutText,
} from '../TraceTimeline';

const HOSTILE = '<img src=x onerror=alert(1)>';

const span = (over: Partial<TraceSpan>): TraceSpan => ({
  id: `span-${over.step_index ?? 0}`,
  case_id: 'case-1',
  step_index: 0,
  kind: 'invoke_agent',
  name: 'investigator',
  ts: '2026-11-20T10:00:00Z',
  latency_ms: null,
  cost: null,
  tokens: null,
  trusted: true,
  summary: 'Assessed the burst.',
  payload_ref: {},
  ...over,
});

const SPANS: TraceSpan[] = [
  span({ step_index: 0, kind: 'invoke_agent', name: 'router', cost: 0.001, cost_basis: 'exact', latency_ms: 840 }),
  span({
    step_index: 1,
    kind: 'execute_tool',
    name: 'investigator',
    trusted: false,
    summary: 'tool=es_query · query=source.ip:203.0.113.9',
    payload_ref: { tool_name: 'es_query' },
    detail: {
      tool_input: { query: HOSTILE, size: 50 },
      query_text: 'source.ip:203.0.113.9',
      tool_output_summary: HOSTILE,
      prompt_excerpt: null,
      result_summary: 'tool=es_query · query=source.ip:203.0.113.9',
      outcome: 'success',
      run_id: 'run-42',
      app_version: '0.2.0',
      build_sha: '0123456789abcdef0123',
      truncated: true,
    },
  }),
  span({ step_index: 2, kind: 'person', name: 'dsingh', summary: 'action=acknowledge status open to investigating' }),
  span({ step_index: 3, kind: 'chat', name: 'chat', summary: 'Case chat question' }),
  span({
    step_index: 4,
    kind: 'invoke_agent',
    name: 'investigator',
    cost: 0.004,
    cost_basis: 'split',
    tokens: 2300,
    payload_ref: { model: 'gpt-test' },
    detail: {
      tool_input: null,
      query_text: null,
      tool_output_summary: null,
      prompt_excerpt: `Prompt with ${HOSTILE}`,
      result_summary: 'Assessed the burst.',
      outcome: null,
      run_id: 'run-42',
      app_version: null,
      build_sha: null,
      truncated: false,
    },
  }),
  span({ step_index: 5, kind: 'decision', name: 'case_manager', payload_ref: { verdict: 'false_positive' } }),
];

const data = (over: Partial<TimelineResponse> = {}): TimelineResponse => ({
  case_id: 'case-1',
  spans: SPANS,
  total: SPANS.length,
  totals: { cost: 0.005, tokens: 2300 },
  ...over,
});

describe('who did a step', () => {
  it('classifies people, chat and code apart from the AI', () => {
    expect(SPANS.map(spanActor)).toEqual(['agent', 'tool', 'person', 'chat', 'agent', 'code']);
    expect(SPANS.filter(isAiStep)).toHaveLength(3);
    expect(spanActor({ kind: 'system' })).toBe('code');
    expect(spanActor({ kind: 'future_kind' })).toBe('agent');
  });

  it('counts AI steps only, and names the people steps', () => {
    expect(traceCountsText(SPANS)).toBe('3 AI steps · 1 tool · 1 by people');
    expect(traceCountsText([span({ kind: 'execute_tool' })])).toBe('1 AI step · 1 tool');
  });

  it('keeps people and chat out of the Agent filter, each with its own choice', () => {
    expect(filterSpans(SPANS, 'agent').map((s) => s.step_index)).toEqual([0, 4]);
    expect(filterSpans(SPANS, 'person').map((s) => s.step_index)).toEqual([2]);
    expect(filterSpans(SPANS, 'chat').map((s) => s.step_index)).toEqual([3]);
    expect(filterSpans(SPANS, 'all')).toHaveLength(SPANS.length);
    expect(TRACE_FILTERS.map((f) => f.label)).toEqual(['All', 'Agent', 'Tool', 'Code', 'People', 'Chat']);
  });
});

describe('the case manager trace', () => {
  it('counts AI steps in its header and keeps a person named as recorded', () => {
    render(<TraceTimeline data={data()} presentation="case-manager" />);
    expect(screen.getByTestId('trace-step-counts')).toHaveTextContent('3 AI steps · 1 tool · 1 by people');
    expect(screen.getByText('[PERSON]')).toBeInTheDocument();
    expect(screen.getByText('dsingh')).toBeInTheDocument();
  });

  it('opens a tool step with its input, query and output, fenced and literal', () => {
    render(<TraceTimeline data={data()} presentation="case-manager" />);
    const toolStep = screen.getByText('[TOOL]').closest('li') as HTMLElement;
    fireEvent.click(within(toolStep).getByRole('button', { name: 'Details' }));
    const details = within(toolStep).getByTestId('trace-span-details');
    expect(within(details).getByRole('group', { name: 'Tool input' })).toHaveTextContent(JSON.stringify(HOSTILE));
    expect(within(details).getByText('untrusted query')).toBeInTheDocument();
    expect(within(details).getByText('untrusted tool output')).toBeInTheDocument();
    expect(within(details).getByText('run-42')).toBeInTheDocument();
    expect(within(details).getByText('v0.2.0 · 0123456789ab')).toBeInTheDocument();
    expect(within(details).getByText(/Part of this record was cut/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says how a cost was found, and marks an even share', () => {
    render(<TraceTimeline data={data()} presentation="case-manager" />);
    expect(screen.getByText('$0.0040 (split)')).toBeInTheDocument();
    const step = screen.getByText('gpt-test').closest('li') as HTMLElement;
    fireEvent.click(within(step).getByRole('button', { name: 'Details' }));
    const details = within(step).getByTestId('trace-span-details');
    expect(details).toHaveTextContent("An even share of this role's recorded cost, split across its steps.");
    expect(within(details).getByText('untrusted prompt excerpt')).toBeInTheDocument();
    expect(within(details).getByText('2,300')).toBeInTheDocument();
  });

  it('says when it shows only the newest records', () => {
    const cut = data({ truncated: true, rows_total: 1240 } as Partial<TimelineResponse>);
    expect(traceCutText(cut)).toBe('Showing the newest 6 of 1,240 records. The audit log has the rest.');
    render(<TraceTimeline data={cut} presentation="case-manager" />);
    expect(screen.getByTestId('trace-cut')).toHaveTextContent('Showing the newest 6 of 1,240 records.');
    expect(traceCutText(data())).toBeNull();
    expect(traceCutText(data({ truncated: true, rows_total: null } as Partial<TimelineResponse>))).toBe(
      'Showing the newest 6 records. Older records are not shown here.',
    );
  });

  it('offers no Details for a span with nothing recorded behind it', () => {
    render(
      <TraceTimeline data={data({ spans: [span({ kind: 'person', name: 'mira' })] })} presentation="case-manager" />,
    );
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });
});
