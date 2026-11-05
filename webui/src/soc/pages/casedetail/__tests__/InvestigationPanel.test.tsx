/**
 * InvestigationPanel — the "Investigation" tab (task 5 split).
 *
 * Task 5 moved the "what happened" six-stage narrative out to the sibling
 * <TimelinePanel>, so this panel is now the investigation proper: the AI assessment
 * (WhyPanel reasoning), the pinned deterministic DecisionCard, and the collapsible full
 * ReAct trace. Verifies the two lanes render in order (AI ASSESSMENT → pinned DECISION),
 * that the AI lane is persistently AI-marked, that the raw ReAct trace stays behind a
 * "Full agent trace" disclosure, and that opening it lazy-loads the timeline when the
 * parent hasn't fetched it yet. A request to open the trace (the audit log's "Open case
 * trace", closing QA integ-06) opens it and brings it into view once, in both
 * presentations, and lands focus that had dropped on the trace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { InvestigationPanel, type InvestigationPanelProps } from '../InvestigationPanel';
import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';

expect.extend(toHaveNoViolations);

const CASE = {
  case_id: 'c1',
  verdict: 'true_positive',
  status: 'escalated',
  decision_by: 'agent',
  risk_score: 72,
} as unknown as Case;

const RATIONALE = {
  case_id: 'c1',
  reasoning: 'Repeated failed logons then a success from a new ASN — credential stuffing.',
} as unknown as CaseRationale;

const decisionSpan: TraceSpan = {
  step_index: 5,
  kind: 'decision',
  name: 'case_manager',
  ts: '2026-07-05T00:00:00Z',
  latency_ms: null,
  cost: null,
  tokens: null,
  trusted: true,
  summary: 'Escalated to a human analyst.',
  payload_ref: {
    verdict: 'true_positive',
    decision_status: 'escalated',
    decision_by: 'agent',
    escalate: true,
    policy_clause: { verdict_class: 'true_positive', auto_closable: false },
  },
};

const TIMELINE: TimelineResponse = {
  case_id: 'c1',
  total: 1,
  totals: { cost: 0, tokens: 0 },
  spans: [decisionSpan],
};

function props(over: Partial<InvestigationPanelProps> = {}): InvestigationPanelProps {
  return {
    c: CASE,
    rationale: RATIONALE,
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

describe('InvestigationPanel — the AI-assessment + decision story', () => {
  it('renders AI ASSESSMENT → DECISION in order', () => {
    render(<InvestigationPanel {...props()} />);

    // 1. AI ASSESSMENT lane — marked "AI", showing the WhyPanel reasoning (not decision).
    expect(screen.getByText('AI assessment')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('Agent reasoning')).toBeInTheDocument();
    expect(
      screen.getByText(/Repeated failed logons then a success from a new ASN/),
    ).toBeInTheDocument();

    // 2. DECISION lane — the pinned deterministic authority card.
    expect(screen.getByRole('region', { name: 'Decision' })).toBeInTheDocument();
    expect(screen.getByText('Deterministic decision')).toBeInTheDocument();
  });

  it('no longer renders the "what happened" stage narrative (moved to TimelinePanel)', () => {
    render(<InvestigationPanel {...props()} />);
    expect(screen.queryByText('What happened')).toBeNull();
  });

  it('hides the WhyPanel decision summary (the DecisionCard is the sole authority)', () => {
    render(<InvestigationPanel {...props()} />);
    // hideDecision ⇒ the WhyPanel's own "Deterministic decision" Alert title is gone;
    // the only decision heading is the pinned DecisionCard's.
    expect(screen.getAllByText('Deterministic decision')).toHaveLength(1);
    // The pinned card reads the clause off the timeline (proves the timeline prop flows).
    expect(screen.getByText('Policy clause evaluated')).toBeInTheDocument();
  });

  it('keeps the raw ReAct trace behind a "Full agent trace" disclosure', () => {
    render(<InvestigationPanel {...props()} />);
    const trigger = screen.getByRole('button', { name: /full agent trace/i });
    expect(trigger).toBeInTheDocument();
  });

  it('lazy-loads the timeline when the disclosure opens and none is loaded yet', () => {
    const onRetryTimeline = vi.fn();
    render(
      <InvestigationPanel
        {...props({
          timeline: null,
          timelineLoading: false,
          timelineError: null,
          onRetryTimeline,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /full agent trace/i }));
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
  });

  it('does not re-fetch the timeline on open when it is already loaded', () => {
    const onRetryTimeline = vi.fn();
    render(<InvestigationPanel {...props({ onRetryTimeline })} />);
    fireEvent.click(screen.getByRole('button', { name: /full agent trace/i }));
    expect(onRetryTimeline).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<InvestigationPanel {...props()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('InvestigationPanel — Case Manager presentation (Round 12, CM-6)', () => {
  const toolSpan: TraceSpan = {
    step_index: 2,
    kind: 'execute_tool',
    name: 'es_query',
    ts: '2026-07-05T00:00:00Z',
    latency_ms: 12,
    cost: 0.0012,
    tokens: 340,
    trusted: false,
    summary: 'hits=3',
    payload_ref: { tool_name: 'es_query', model: 'gpt-5.6-luna' },
  };
  const agentSpan: TraceSpan = { ...toolSpan, step_index: 1, kind: 'invoke_agent', name: 'investigator', trusted: true, summary: 'Thinking', payload_ref: null };
  const FULL: TimelineResponse = {
    case_id: 'c1',
    total: 3,
    totals: { cost: 0.0012, tokens: 340 },
    spans: [agentSpan, toolSpan, decisionSpan],
  };

  function renderCm(over: Partial<InvestigationPanelProps> = {}) {
    return render(
      <InvestigationPanel {...props({ timeline: FULL, ...over })} presentation="case-manager" />,
    );
  }

  it('shows a machine decision record as a mono record line, prose as prose', () => {
    const record = 'verdict=TRUE_POSITIVE status=escalated decision_by=system risk=7.41';
    const { unmount } = renderCm({
      rationale: { decision_rationale: record } as unknown as InvestigationPanelProps['rationale'],
    });
    expect(screen.getByTestId('investigation-decision-line')).toHaveTextContent(record);
    expect(screen.getByTestId('investigation-decision-line')).toHaveClass('font-mono');
    unmount();
    renderCm({
      rationale: { decision_rationale: 'Escalated for a person to review.' } as unknown as InvestigationPanelProps['rationale'],
    });
    expect(screen.getByTestId('investigation-decision-line')).not.toHaveClass('font-mono');
  });

  it('leads with the decision, then the AI assessment, with the trace collapsed and counted', () => {
    const { container } = renderCm();
    const decision = screen.getByTestId('investigation-decision');
    const assessment = screen.getByTestId('investigation-assessment');
    const trace = screen.getByTestId('investigation-trace');
    expect(decision.compareDocumentPosition(assessment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(assessment.compareDocumentPosition(trace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(decision).getByRole('heading', { name: 'Decision' })).toBeInTheDocument();
    expect(within(decision).getByText('Escalated')).toBeInTheDocument();

    // Sentence case, never tracked capitals.
    expect(screen.getByRole('heading', { name: 'AI assessment' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Investigation trace' })).toBeInTheDocument();
    expect(container.querySelectorAll('.uppercase')).toHaveLength(0);

    // Collapsed by default, with the counts visible before opening.
    expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('3 steps · 1 tool');
    expect(screen.queryByText('hits=3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
    expect(screen.getByText('hits=3')).toBeInTheDocument();
    // Per-step tool, model, cost and tokens are kept in the compact trace.
    expect(screen.getAllByText('es_query').length).toBeGreaterThan(0);
    expect(screen.getByText('gpt-5.6-luna')).toBeInTheDocument();
  });

  it('filters the trace by actor and jumps to the decision step', async () => {
    renderCm();
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Tool' }));
    expect(screen.getByText('hits=3')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Code' }));
    expect(screen.queryByText('hits=3')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Jump to decision' }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-trace-kind')).toBe('decision'),
    );
  });

  it('colours risk by its own band: Risk 7 is never red', () => {
    renderCm({ c: { ...CASE, risk_score: 7, severity_band: 'critical' } as Case });
    const assessment = screen.getByTestId('investigation-assessment');
    expect(assessment).toHaveAttribute('data-risk-band', 'low');
    expect(assessment.className).not.toContain('critical');
    expect(screen.getByTestId('investigation-risk')).toHaveClass('text-low-text');
    expect(screen.getByTestId('investigation-risk')).not.toHaveClass('text-critical-text');
  });

  it('a human close reads "Analyst resolved" and demotes the AI recommendation', () => {
    renderCm({
      c: {
        ...CASE,
        verdict: 'NEEDS_HUMAN',
        confidence: 0.75,
        status: 'closed',
        decision_by: 'analyst',
        disposition: 'false_positive',
        recommended_action: 'Benign baseline activity; no action required.',
        history: [
          { event: 'analyst_action', action: 'close', analyst: 'aryan', ts: '2026-10-09T10:00:00Z', classified_disposition: 'false_positive' },
        ],
      } as unknown as Case,
    });
    const decision = screen.getByTestId('investigation-decision');
    expect(within(decision).getByRole('heading', { name: 'Analyst resolved' })).toBeInTheDocument();
    expect(decision).toHaveTextContent('Closed as false positive by aryan.');
    expect(screen.getByTestId('investigation-ai-line')).toHaveTextContent('AI verdict: Needs human review (75%)');
    expect(screen.getByText('AI recommendation at triage')).toBeInTheDocument();
    expect(screen.queryByText('Recommended action')).toBeNull();
    expect(screen.getByText('AI confidence at assessment')).toBeInTheDocument();
  });

  it('keeps every earlier datum one disclosure away (evidence, policy inputs, grading)', () => {
    renderCm();
    fireEvent.click(screen.getByRole('button', { name: /show full assessment evidence/i }));
    expect(screen.getByText('Agent reasoning')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show policy inputs/i }));
    expect(screen.getByText('Policy clause evaluated')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderCm();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('InvestigationPanel: a request to open the trace (closing QA integ-06)', () => {
  /** Each element a request brought into view, with the options it asked for. */
  const scrolled: Array<{ el: Element; options: ScrollIntoViewOptions | boolean | undefined }> = [];
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    scrolled.length = 0;
    // jsdom has no layout: record what a request brings into view.
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: ScrollIntoViewOptions | boolean) {
      scrolled.push({ el: this, options });
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    Element.prototype.scrollIntoView = originalScrollIntoView;
    window.matchMedia = originalMatchMedia;
  });

  /** Past the beat the panel waits before it brings the open trace into view. */
  const pastTheBeat = () =>
    act(() => {
      vi.advanceTimersByTime(200);
    });

  it('opens the full trace, reports the request, and brings it into view once after a beat', () => {
    const onHandled = vi.fn();
    const onRetryTimeline = vi.fn();
    const request = { traceRequest: 1, onTraceRequestHandled: onHandled };
    const { rerender } = render(<InvestigationPanel {...props({ timeline: null, onRetryTimeline })} {...request} />);
    const trigger = screen.getByRole('button', { name: /hide full agent trace/i });
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith(1);
    // Opening never reads the trace itself: the case detail's tab load does that, and a
    // second read would race it.
    expect(onRetryTimeline).not.toHaveBeenCalled();
    expect(scrolled).toHaveLength(0);

    expect(document.activeElement).toBe(document.body);
    pastTheBeat();
    // Nothing had read it by then, so the beat does, once; the trace comes into view.
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].el).toContainElement(trigger);
    expect(scrolled[0].options).toEqual({ block: 'start', behavior: 'smooth' });
    // Focus had dropped, so it lands on the trace's own control.
    expect(document.activeElement).toBe(trigger);

    // The same request again, before the parent forgets it, is never replayed.
    rerender(<InvestigationPanel {...props({ timeline: null, onRetryTimeline })} {...request} />);
    pastTheBeat();
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveLength(1);
  });

  it('leaves a trace closed by hand before the beat closed, and a later open is ordinary', () => {
    const onRetryTimeline = vi.fn();
    render(
      <InvestigationPanel
        {...props({ timeline: null, onRetryTimeline })}
        traceRequest={2}
        onTraceRequestHandled={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /hide full agent trace/i }));
    pastTheBeat();
    expect(screen.getByRole('button', { name: /show full agent trace/i })).toBeInTheDocument();
    expect(onRetryTimeline).not.toHaveBeenCalled();
    expect(scrolled).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);

    // Opened by hand later: it reads the trace as any open does, and nothing scrolls.
    fireEvent.click(screen.getByRole('button', { name: /show full agent trace/i }));
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
    pastTheBeat();
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveLength(0);
  });

  it('brings the trace into view without animation for a viewer who asks for reduced motion', () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    render(<InvestigationPanel {...props()} traceRequest={3} onTraceRequestHandled={vi.fn()} />);
    pastTheBeat();
    expect(scrolled.map((entry) => entry.options)).toEqual([{ block: 'start', behavior: 'auto' }]);
  });

  it('leaves the trace collapsed and still with no request', () => {
    const onRetryTimeline = vi.fn();
    render(<InvestigationPanel {...props({ timeline: null, onRetryTimeline })} traceRequest={null} />);
    pastTheBeat();
    expect(screen.getByRole('button', { name: /show full agent trace/i })).toBeInTheDocument();
    expect(onRetryTimeline).not.toHaveBeenCalled();
    expect(scrolled).toHaveLength(0);
  });

  it('in the Case Manager presentation opens its own trace section, handled once', () => {
    const onHandled = vi.fn();
    const onRetryTimeline = vi.fn();
    render(
      <InvestigationPanel
        {...props({ onRetryTimeline })}
        presentation="case-manager"
        traceRequest={4}
        onTraceRequestHandled={onHandled}
      />,
    );
    const trace = screen.getByTestId('investigation-trace');
    expect(within(trace).getByRole('button', { name: 'Hide trace' })).toBeInTheDocument();
    // The wrapper hands the request to the Case Manager layout and never applies it too.
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith(4);

    pastTheBeat();
    expect(scrolled.map((entry) => entry.el)).toEqual([trace]);
    // The trace was already loaded, so the beat read nothing.
    expect(onRetryTimeline).not.toHaveBeenCalled();
    // Focus had dropped, so it lands on the trace heading, which takes it without a ring
    // stop of its own in the tab order.
    const heading = within(trace).getByRole('heading', { name: 'Investigation trace' });
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it.each(['default', 'case-manager'] as const)(
    'in the %s presentation keeps focus on a control the analyst is using',
    (presentation) => {
      render(
        <>
          <input aria-label="Search the queue" />
          <InvestigationPanel {...props()} presentation={presentation} traceRequest={5} onTraceRequestHandled={vi.fn()} />
        </>,
      );
      const search = screen.getByRole('textbox', { name: 'Search the queue' });
      search.focus();
      pastTheBeat();
      expect(scrolled).toHaveLength(1);
      expect(document.activeElement).toBe(search);
    },
  );

  it('lands focus on the trace when the control that asked left the page', () => {
    function Page({ link }: { link: boolean }) {
      return (
        <>
          {link ? <a href="#/case_manager">Open case trace</a> : null}
          <InvestigationPanel {...props()} traceRequest={link ? null : 6} onTraceRequestHandled={vi.fn()} />
        </>
      );
    }
    const { rerender } = render(<Page link />);
    screen.getByRole('link', { name: 'Open case trace' }).focus();
    rerender(<Page link={false} />);
    pastTheBeat();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /hide full agent trace/i }));
  });
});
