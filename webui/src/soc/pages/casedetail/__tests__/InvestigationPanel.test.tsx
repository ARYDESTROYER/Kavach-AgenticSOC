/**
 * InvestigationPanel: the "Investigation" tab (Round 15, D8.3).
 *
 * The investigation proper, in its one layout: the AI assessment (the model's reading
 * only, G17), the decision with its authority sentence once, the Threat context section
 * (the retired tab), the inputs and the collapsed trace, which opening lazy-loads when the
 * parent hasn't fetched it yet. A request to open the trace (the audit log's "Open case
 * trace", closing QA integ-06) opens it and brings it into view once, and lands focus that
 * had dropped on the trace heading.
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
  reasoning: 'Repeated failed logons then a success from a new ASN: credential stuffing.',
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

describe('InvestigationPanel: the decision-first layout (Round 12, CM-6)', () => {
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
      <InvestigationPanel {...props({ timeline: FULL, ...over })} />,
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

  it('reads AI assessment, decision, threat context, inputs, then the collapsed, counted trace', () => {
    const { container } = renderCm({ threatContext: <p>Threat context body</p> });
    const assessment = screen.getByTestId('investigation-assessment');
    const decision = screen.getByTestId('investigation-decision');
    const threat = screen.getByTestId('investigation-threat-context');
    const trace = screen.getByTestId('investigation-trace');
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(assessment, decision)).toBe(true);
    expect(follows(decision, threat)).toBe(true);
    expect(follows(threat, trace)).toBe(true);
    expect(within(decision).getByRole('heading', { name: 'Decision' })).toBeInTheDocument();
    // The retired Threat context tab is a section a link can scroll to.
    expect(threat).toHaveAttribute('data-section', 'threat-context');
    expect(within(threat).getByRole('heading', { name: 'Threat context' })).toHaveAttribute('data-section-title');
    expect(within(threat).getByText('Threat context body')).toBeInTheDocument();

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

  it('G17: the AI assessment is the model reading only, never the code decision text', () => {
    const code = 'No confident close decision; routing to human (fail-safe).';
    // No reasoning, no summary: the decision text never stands in for the AI.
    const { unmount } = renderCm({
      c: { ...CASE, summary: '' } as Case,
      rationale: { case_id: 'c1', reasoning: '', decision_rationale: code } as unknown as CaseRationale,
    });
    const assessment = screen.getByTestId('investigation-assessment');
    expect(assessment).not.toHaveTextContent(code);
    expect(screen.getByTestId('investigation-assessment-text')).toHaveTextContent(
      'No assessment text was recorded for this investigation.',
    );
    // The code's text is still on the page, as the Decision's line.
    expect(screen.getByTestId('investigation-decision-line')).toHaveTextContent(code);
    unmount();

    // With the investigation's own summary, that is what the assessment shows.
    const { unmount: unmountSummary } = renderCm({
      c: { ...CASE, summary: 'Impossible travel between two countries.' } as Case,
      rationale: { case_id: 'c1', reasoning: '', decision_rationale: code } as unknown as CaseRationale,
    });
    expect(screen.getByTestId('investigation-assessment-text')).toHaveTextContent('Impossible travel between two countries.');
    expect(screen.getByTestId('investigation-assessment')).not.toHaveTextContent(code);
    unmountSummary();

    // A case the AI never assessed (no verdict): its system summary is not the AI's.
    renderCm({
      c: { ...CASE, verdict: undefined, summary: 'Candidate awaiting analysis: queued.' } as unknown as Case,
      rationale: { case_id: 'c1', decision_rationale: code } as unknown as CaseRationale,
    });
    expect(screen.getByTestId('investigation-assessment-text')).toHaveTextContent('The AI has not assessed this case.');
    expect(screen.getByTestId('investigation-assessment')).not.toHaveTextContent('Candidate awaiting analysis');
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

  it('repeats none of the header and rail facts: no risk score, confidence or status chip', () => {
    renderCm({ c: { ...CASE, risk_score: 7, confidence: 0.9 } as Case });
    const assessment = screen.getByTestId('investigation-assessment');
    // Risk is code's, not the model's; it lives in the facts rail's Signal (D8.4).
    expect(assessment).not.toHaveTextContent(/risk score/i);
    expect(assessment).not.toHaveTextContent('90%');
    expect(screen.queryByTestId('investigation-risk')).toBeNull();
    expect(within(screen.getByTestId('investigation-decision')).queryByText('Escalated')).toBeNull();
  });

  it('says the authority sentence once, with the auto-close reading', () => {
    renderCm({
      c: { ...CASE, verdict: 'false_positive', status: 'needs_human', decision_by: 'system', confidence: 0.6 } as Case,
      fpPolicy: { enabled: true, min_confidence: 0.85, max_risk_score: 30 },
    });
    expect(screen.getByTestId('investigation-authority')).toHaveTextContent(
      /close or escalate decision is made by deterministic code/i,
    );
    expect(screen.getAllByText(/made by deterministic code against the operator policy/i)).toHaveLength(1);
    expect(screen.getByTestId('investigation-auto-close')).toHaveTextContent('Below the 0.85 auto-close confidence bar');
  });

  it('shows the findings and the reproduce query in the AI assessment', () => {
    renderCm({
      c: {
        ...CASE,
        evidence: [
          { summary: 'Three failed logons from 203.0.113.9.', query: 'event.outcome:failure' },
          { summary: 'No match in the threat feed. Clean.', query: '' },
        ],
        reproduce_query: 'source.ip:203.0.113.9',
      } as unknown as Case,
    });
    const findings = screen.getByTestId('investigation-findings');
    expect(within(findings).getByText('Found')).toBeInTheDocument();
    expect(within(findings).getByText('Clear')).toBeInTheDocument();
    expect(within(findings).getByText('event.outcome:failure')).toBeInTheDocument();
    expect(screen.getByText('Reproduce query')).toBeInTheDocument();
    expect(screen.getByText('source.ip:203.0.113.9')).toBeInTheDocument();
  });

  it('lists the automation applied under the decision, never as a status change', () => {
    renderCm({
      c: {
        ...CASE,
        automation_actions: [{ action: 'tag', detail: 'tag=vpn', rule_id: 'r1', at: '2026-10-28T13:00:00Z' }],
      } as unknown as Case,
    });
    const decision = screen.getByTestId('investigation-decision');
    expect(within(decision).getByTestId('automation-applied')).toHaveTextContent('Tagged');
    expect(within(decision).getByText(/never changes the lifecycle status/i)).toBeInTheDocument();
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
    expect(screen.getByTestId('investigation-authority')).toHaveTextContent(/closed by an analyst/i);
    // The recommendation and the AI verdict are the Overview's and the header's (D8.4).
    expect(screen.queryByText('Recommended action')).toBeNull();
  });

  it('keeps every earlier datum one disclosure away (evidence, policy inputs, grading)', () => {
    renderCm();
    fireEvent.click(screen.getByRole('button', { name: /show full assessment evidence/i }));
    expect(screen.getByText('Agent reasoning')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show policy inputs/i }));
    expect(screen.getByText('Policy clause evaluated')).toBeInTheDocument();
  });

  it('no longer renders the "what happened" stage narrative (it is a section of the Overview)', () => {
    renderCm();
    expect(screen.queryByText('What happened')).toBeNull();
  });

  it('renders no Threat context section when the caller passes none', () => {
    renderCm();
    expect(screen.queryByTestId('investigation-threat-context')).toBeNull();
  });

  it('lazy-loads the trace when it opens and none is loaded yet, and never re-reads a loaded one', () => {
    const onRetryTimeline = vi.fn();
    const { unmount } = renderCm({ timeline: null, timelineLoading: false, timelineError: null, onRetryTimeline });
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
    unmount();
    const loaded = vi.fn();
    renderCm({ onRetryTimeline: loaded });
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
    expect(loaded).not.toHaveBeenCalled();
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
    const trace = screen.getByTestId('investigation-trace');
    expect(within(trace).getByRole('button', { name: 'Hide trace' })).toBeInTheDocument();
    const heading = within(trace).getByRole('heading', { name: 'Investigation trace' });
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
    expect(scrolled[0].el).toBe(trace);
    expect(scrolled[0].options).toEqual({ block: 'start', behavior: 'smooth' });
    // Focus had dropped, so it lands on the trace heading, which takes it without a ring
    // stop of its own in the tab order.
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');

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
    fireEvent.click(screen.getByRole('button', { name: 'Hide trace' }));
    pastTheBeat();
    expect(screen.getByRole('button', { name: 'Show trace' })).toBeInTheDocument();
    expect(onRetryTimeline).not.toHaveBeenCalled();
    expect(scrolled).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);

    // Opened by hand later: it reads the trace as any open does, and nothing scrolls.
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
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
    expect(screen.getByRole('button', { name: 'Show trace' })).toBeInTheDocument();
    expect(onRetryTimeline).not.toHaveBeenCalled();
    expect(scrolled).toHaveLength(0);
  });

  it('opens a loaded trace for a request, handled once, and reads nothing more', () => {
    const onHandled = vi.fn();
    const onRetryTimeline = vi.fn();
    render(
      <InvestigationPanel
        {...props({ onRetryTimeline })}
        traceRequest={4}
        onTraceRequestHandled={onHandled}
      />,
    );
    const trace = screen.getByTestId('investigation-trace');
    expect(within(trace).getByRole('button', { name: 'Hide trace' })).toBeInTheDocument();
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

  it('keeps focus on a control the analyst is using', () => {
    render(
      <>
        <input aria-label="Search the queue" />
        <InvestigationPanel {...props()} traceRequest={5} onTraceRequestHandled={vi.fn()} />
      </>,
    );
    const search = screen.getByRole('textbox', { name: 'Search the queue' });
    search.focus();
    pastTheBeat();
    expect(scrolled).toHaveLength(1);
    expect(document.activeElement).toBe(search);
  });

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
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Investigation trace' }));
  });
});
