/**
 * Round 16 acceptance fixes (FXA2): the AI investigation tab's trace.
 *
 * * People opening the Evidence tab (`case.events_viewed`) are left out of the trace and
 *   its counts (SPEC 8.1); they stay in Activity and the audit log.
 * * The step counts show once, beside the heading. The trace card repeats a count only
 *   while a filter narrows it, as "N of M steps".
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { InvestigationPanel, filteredTraceCountText, type InvestigationPanelProps } from '../InvestigationPanel';
import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';

const CASE = { case_id: 'c1', verdict: 'true_positive', status: 'escalated', decision_by: 'agent', risk_score: 72 } as unknown as Case;

const base = (over: Partial<TraceSpan>): TraceSpan => ({
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
  base({ step_index: 0, summary: 'Read the cluster.' }),
  base({ step_index: 1, kind: 'execute_tool', trusted: false, summary: 'tool=es_query', payload_ref: { tool_name: 'es_query' } }),
  base({ step_index: 2, kind: 'person', name: 'Admin', summary: 'A person viewed the case events.', payload_ref: { action: 'case.events_viewed' } }),
  base({ step_index: 3, kind: 'person', name: 'Admin', summary: 'A person viewed the case events.', payload_ref: { action: 'case.events_viewed' } }),
  base({ step_index: 4, kind: 'person', name: 'meera.pillai', summary: 'action=acknowledge', payload_ref: { action: 'case.acknowledged' } }),
  base({ step_index: 5, kind: 'decision', name: 'case_manager', summary: 'Escalated to a person.', payload_ref: { verdict: 'true_positive' } }),
];

const TIMELINE: TimelineResponse = { case_id: 'c1', total: SPANS.length, totals: { cost: 0, tokens: 0 }, spans: SPANS };

function props(over: Partial<InvestigationPanelProps> = {}): InvestigationPanelProps {
  return {
    c: CASE,
    rationale: { case_id: 'c1', reasoning: 'Credential stuffing.' } as unknown as CaseRationale,
    rationaleLoading: false,
    rationaleError: null,
    onRetryRationale: vi.fn(),
    timeline: TIMELINE,
    timelineLoading: false,
    timelineError: null,
    onRetryTimeline: vi.fn(),
    ...over,
  };
}

describe('the AI investigation trace (FXA2)', () => {
  it('leaves people opening the Evidence tab out of the trace and its counts', () => {
    render(<InvestigationPanel {...props()} />);
    expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('2 AI steps · 1 tool · 1 by people');
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
    expect(screen.queryByText('A person viewed the case events.')).toBeNull();
    expect(screen.getByText('action=acknowledge')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'People' }));
    expect(screen.queryByText('A person viewed the case events.')).toBeNull();
    expect(screen.getByText('action=acknowledge')).toBeInTheDocument();
  });

  it('shows the step counts once with the filter on All, and the filtered count when narrowed', () => {
    render(<InvestigationPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
    const section = screen.getByTestId('investigation-trace');
    expect(within(section).getAllByText('2 AI steps · 1 tool · 1 by people')).toHaveLength(1);
    expect(screen.queryByTestId('trace-step-counts')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
    expect(screen.getByTestId('trace-step-counts')).toHaveTextContent('1 of 4 steps');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(screen.queryByTestId('trace-step-counts')).toBeNull();
  });

  it('words the filtered count', () => {
    expect(filteredTraceCountText(1, 4)).toBe('1 of 4 steps');
    expect(filteredTraceCountText(1, 1)).toBe('1 of 1 step');
    expect(filteredTraceCountText(1200, 1500)).toBe('1,200 of 1,500 steps');
  });
});
