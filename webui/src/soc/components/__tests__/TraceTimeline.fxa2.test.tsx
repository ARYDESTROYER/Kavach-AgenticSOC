/**
 * Round 16 acceptance fixes (FXA2): the trace says what it holds.
 *
 * * A person opening the Evidence tab (`case.events_viewed`) is not a step of the
 *   investigation: `investigationSpans` leaves those rows out (SPEC 8.1).
 * * A pipeline actor reads as the activity feed names it: the runbook runner
 *   `agentic_soc` is "Agentic SOC", never "Agentic soc".
 * * The decision step's Details say code made it and no model was called, never a
 *   ledger-row cost basis it does not have.
 * * The case manager trace's header count is the caller's: none while the AI tab counts
 *   the steps beside its heading.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';
import { DECISION_COST_WORDS, EVENTS_VIEWED_ACTION, TraceTimeline, investigationSpans, spanName } from '../TraceTimeline';

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

const viewed = span({
  step_index: 1,
  kind: 'person',
  name: 'Admin',
  summary: 'A person viewed the case events.',
  payload_ref: { action: EVENTS_VIEWED_ACTION, actor_type: 'human' },
});

const decision = span({
  step_index: 3,
  kind: 'decision',
  name: 'case_manager',
  cost: 0,
  tokens: 0,
  cost_basis: null,
  summary: 'False positive auto-closed.',
  payload_ref: { verdict: 'false_positive' },
  detail: {
    tool_input: { gate: { verdict: 'FALSE_POSITIVE', min_confidence: 0.85 } },
    query_text: null,
    tool_output_summary: null,
    prompt_excerpt: null,
    result_summary: null,
    outcome: 'success',
    run_id: 'inv-1',
    app_version: '0.2.0',
    build_sha: '934331273dc0c0630c00',
    truncated: false,
  },
});

const data = (spans: TraceSpan[]): TimelineResponse => ({
  case_id: 'case-1',
  spans,
  total: spans.length,
  totals: { cost: 0, tokens: 0 },
});

describe('the investigation trace (FXA2)', () => {
  it('leaves a person opening the Evidence tab out of the investigation', () => {
    const acknowledged = span({ step_index: 2, kind: 'person', name: 'Admin', payload_ref: { action: 'case.acknowledged' } });
    const kept = investigationSpans([span({ step_index: 0 }), viewed, acknowledged, decision]);
    expect(kept.map((s) => s.step_index)).toEqual([0, 2, 3]);
  });

  it('names the runbook runner Agentic SOC and keeps a person as recorded', () => {
    expect(spanName({ kind: 'system', name: 'agentic_soc' })).toBe('Agentic SOC');
    expect(spanName({ kind: 'invoke_agent', name: 'procedure_provenance' })).toBe('Procedure record');
    expect(spanName({ kind: 'invoke_agent', name: 'reinvestigate' })).toBe('Reinvestigate');
    expect(spanName({ kind: 'person', name: 'agentic_soc' })).toBe('agentic_soc');
    render(<TraceTimeline data={data([span({ kind: 'system', name: 'agentic_soc' })])} presentation="case-manager" />);
    expect(screen.getByText('Agentic SOC')).toBeInTheDocument();
    expect(screen.queryByText('Agentic soc')).toBeNull();
  });

  it('says a decision costs nothing because code made it, with no ledger row named', () => {
    render(<TraceTimeline data={data([decision])} presentation="case-manager" />);
    const step = document.querySelector('[data-trace-kind="decision"]') as HTMLElement;
    fireEvent.click(within(step).getByRole('button', { name: 'Details' }));
    const details = within(step).getByTestId('trace-span-details');
    expect(details).toHaveTextContent(DECISION_COST_WORDS);
    expect(details).toHaveTextContent('No model call. Code made this decision.');
    expect(details).not.toHaveTextContent('Cost basis');
    expect(details).not.toHaveTextContent('ledger row');
    expect(details).not.toHaveTextContent('$0.0000');
  });

  it('says so even when an older server still names a cost basis for the decision', () => {
    render(<TraceTimeline data={data([{ ...decision, cost_basis: 'exact' }])} presentation="case-manager" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = screen.getByTestId('trace-span-details');
    expect(details).toHaveTextContent(DECISION_COST_WORDS);
    expect(details).not.toHaveTextContent("this call's own ledger row");
  });

  it('shows the header count the caller gives, and none for null', () => {
    const spans = [span({ step_index: 0 }), decision];
    const { rerender } = render(<TraceTimeline data={data(spans)} presentation="case-manager" countsText={null} />);
    expect(screen.queryByTestId('trace-step-counts')).toBeNull();
    rerender(<TraceTimeline data={data(spans)} presentation="case-manager" countsText="1 of 2 steps" />);
    expect(screen.getByTestId('trace-step-counts')).toHaveTextContent('1 of 2 steps');
    rerender(<TraceTimeline data={data(spans)} presentation="case-manager" />);
    expect(screen.getByTestId('trace-step-counts')).toHaveTextContent('1 AI step · 0 tools');
  });
});
