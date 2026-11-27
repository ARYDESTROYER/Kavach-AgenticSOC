/**
 * Round 16 package FXF: runbook AI help in the trace.
 *
 * The model call a person asks for on a runbook step (a step draft or a suggestion) is
 * never a step of the investigation. The server marks its span `runbook_ai`, and the
 * trace shows it as runbook AI help asked for by that person, with its own cost, outside
 * the AI step count of the heading and the AI investigation tab.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';
import { TraceTimeline, filterSpans, spanActor, spanName, traceCountsText, traceStepCounts } from '../TraceTimeline';

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

const help = span({
  step_index: 1,
  kind: 'runbook_ai',
  name: 'Admin',
  cost: 0.003447,
  tokens: 420,
  cost_basis: 'exact',
  summary: 'runbook step draft model call tokens=420 cost=0.003447',
  payload_ref: { action_type: 'prompt', actor: 'Admin', actor_type: 'agent' },
});

const SPANS = [span({ step_index: 0 }), help];

describe('runbook AI help in the trace', () => {
  it('is its own actor, never an AI step of the investigation', () => {
    expect(spanActor(help)).toBe('runbook');
    expect(traceStepCounts(SPANS)).toMatchObject({ ai: 1, agent: 1, runbook: 1 });
    expect(traceCountsText(SPANS)).toBe('1 AI step · 0 tools · 1 runbook AI help');
    expect(filterSpans(SPANS, 'agent').map((s) => s.step_index)).toEqual([0]);
    expect(filterSpans(SPANS, 'runbook').map((s) => s.step_index)).toEqual([1]);
  });

  it('names the person who asked, never as the agent', () => {
    expect(spanName(help)).toBe('Asked by Admin');
    expect(spanName({ kind: 'runbook_ai', name: '' })).toBe('Runbook AI help');
  });

  it('shows its own cost and kind on the case manager trace', () => {
    const data: TimelineResponse = { case_id: 'case-1', spans: SPANS, total: 2, totals: { cost: 0.0045, tokens: 600 } };
    const { container } = render(<TraceTimeline data={data} presentation="case-manager" />);
    const row = container.querySelector('[data-trace-kind="runbook_ai"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('RUNBOOK AI');
    expect(row.textContent).toContain('Asked by Admin');
    expect(row.textContent).not.toContain('AGENT');
    expect(row.textContent).toContain('$0.0034');
  });
});
