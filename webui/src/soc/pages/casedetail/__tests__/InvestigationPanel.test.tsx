/**
 * InvestigationPanel: the "AI investigation" tab (Round 16, SPEC D8; Round 15 D8.3).
 *
 * The AI lane, in its one layout: one muted advisory line, the AI assessment (the model's
 * reading only, G17, with its findings), the inputs and the collapsed trace, which opening
 * lazy-loads when the parent hasn't fetched it yet, and which opens while an AI run is
 * under way. The decision moved to the Brief's Decision lane (DecisionLane.test.tsx) and
 * threat context to Evidence: no `code` provenance tag renders here. A request to open the
 * trace (the audit log's "Open case trace", closing QA integ-06) opens it and brings it
 * into view once, and lands focus that had dropped on the trace heading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

// The findings list is WP14's: record what the panel passes it.
const findingsProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('../records/FindingsList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../records/FindingsList')>();
  return {
    FindingsList: (props: Parameters<typeof actual.FindingsList>[0]) => {
      findingsProps.last = props as unknown as Record<string, unknown>;
      return actual.FindingsList(props);
    },
  };
});

import { AI_ADVISORY_LINE, InvestigationPanel, type InvestigationPanelProps } from '../InvestigationPanel';
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

describe('InvestigationPanel: the AI lane (Round 16, D8)', () => {
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

  it('reads the advisory line, the AI assessment, the inputs, then the collapsed, counted trace', () => {
    const { container } = renderCm();
    const advisory = screen.getByText(AI_ADVISORY_LINE);
    const assessment = screen.getByTestId('investigation-assessment');
    const trace = screen.getByTestId('investigation-trace');
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(advisory, assessment)).toBe(true);
    expect(follows(assessment, trace)).toBe(true);
    // The advisory line is the tab's first block, where the case geometry is measured.
    expect(advisory).toHaveAttribute('data-testid', 'case-tab-first');
    // The decision and threat context are the Brief's and Evidence's now.
    expect(screen.queryByTestId('investigation-decision')).toBeNull();
    expect(screen.queryByTestId('investigation-threat-context')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Decision' })).toBeNull();
    // Nothing on this tab is the code's: no code provenance tag (the segregation guard).
    expect(container.querySelector('[data-provenance="code"]')).toBeNull();
    expect(container.querySelector('[data-provenance="ai"]')).not.toBeNull();

    // Sentence case, never tracked capitals.
    expect(screen.getByRole('heading', { name: 'AI assessment' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Investigation trace' })).toBeInTheDocument();
    expect(container.querySelectorAll('.uppercase')).toHaveLength(0);

    // Collapsed by default, with the counts visible before opening.
    expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('2 AI steps · 1 tool');
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
    // The code's text is the Brief's Decision lane's line, never this tab's.
    expect(screen.queryByText(code)).toBeNull();
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

  it('filters People and Chat apart from the Agent, as the trace counts them (WP16)', () => {
    const personSpan: TraceSpan = { ...agentSpan, step_index: 3, kind: 'person', name: 'analyst.one', summary: 'Acknowledged the case' };
    const chatSpan: TraceSpan = { ...agentSpan, step_index: 4, kind: 'chat', name: 'case_chat', summary: 'Asked about the host' };
    renderCm({ timeline: { ...FULL, total: 5, spans: [agentSpan, toolSpan, personSpan, chatSpan, decisionSpan] } });
    // The header counts the AI's steps and the people's apart (never one step count).
    expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('2 AI steps · 1 tool · 1 by people');
    fireEvent.click(screen.getByRole('button', { name: 'Show trace' }));
    const filter = screen.getByRole('radiogroup', { name: 'Show trace steps by' });
    expect(within(filter).getAllByRole('radio').map((r) => r.textContent)).toEqual(['All', 'Agent', 'Tool', 'Code', 'People', 'Chat', 'Runbook']);
    // Seven filters are wider than a phone's pane: they wrap inside the rail (and every
    // arrow key moves along the wrapped rows), so the panel never scrolls sideways.
    expect(filter.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(filter.className).toMatch(/(^|\s)max-w-full(\s|$)/);
    expect(filter.className).toMatch(/(^|\s)h-auto(\s|$)/);
    expect(filter).not.toHaveAttribute('aria-orientation', 'horizontal');
    // Agent keeps the agent's own step only: no person, no chat turn.
    fireEvent.click(within(filter).getByRole('radio', { name: 'Agent' }));
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Acknowledged the case')).toBeNull();
    expect(screen.queryByText('Asked about the host')).toBeNull();
    fireEvent.click(within(filter).getByRole('radio', { name: 'People' }));
    expect(screen.getByText('Acknowledged the case')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).toBeNull();
    fireEvent.click(within(filter).getByRole('radio', { name: 'Chat' }));
    expect(screen.getByText('Asked about the host')).toBeInTheDocument();
    expect(screen.queryByText('Acknowledged the case')).toBeNull();
  });

  it('repeats none of the header and rail facts: no risk score, confidence or status chip', () => {
    renderCm({ c: { ...CASE, risk_score: 7, confidence: 0.9 } as Case });
    const assessment = screen.getByTestId('investigation-assessment');
    // Risk is code's, not the model's; it lives in the facts rail's Signal (D8.4).
    expect(assessment).not.toHaveTextContent(/risk score/i);
    expect(assessment).not.toHaveTextContent('90%');
    expect(screen.queryByTestId('investigation-risk')).toBeNull();
    expect(screen.queryByText('Escalated')).toBeNull();
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

  it('hands the findings their "Cites N events" path to the Evidence tab', () => {
    const onShowEvents = vi.fn();
    renderCm({
      c: { ...CASE, evidence: [{ summary: 'Three failed logons.', query: 'q' }] } as unknown as Case,
      onShowEvents,
    });
    expect(findingsProps.last).toMatchObject({ onShowEvents });
    expect((findingsProps.last?.findings as unknown[]).length).toBe(1);
  });

  it('opens the trace while an AI run is under way, once per run', () => {
    const onRetryTimeline = vi.fn();
    const { rerender } = render(<InvestigationPanel {...props({ timeline: null, onRetryTimeline })} />);
    expect(screen.getByRole('button', { name: 'Show trace' })).toBeInTheDocument();
    rerender(<InvestigationPanel {...props({ timeline: null, onRetryTimeline })} aiRunning />);
    expect(screen.getByRole('button', { name: 'Hide trace' })).toBeInTheDocument();
    expect(onRetryTimeline).toHaveBeenCalledTimes(1);
    // Folded by hand while the run goes on: it stays folded.
    fireEvent.click(screen.getByRole('button', { name: 'Hide trace' }));
    rerender(<InvestigationPanel {...props({ timeline: null, onRetryTimeline })} aiRunning />);
    expect(screen.getByRole('button', { name: 'Show trace' })).toBeInTheDocument();
  });

  it('says when the rationale was built from only the newest records, as the trace does (WP16)', () => {
    const cut = { ...RATIONALE, returned: 500, rows_total: 1240, rows_total_relation: 'eq', truncated: true } as unknown as CaseRationale;
    const { unmount } = renderCm({ rationale: cut });
    expect(screen.getByTestId('rationale-cut')).toHaveTextContent(
      'Built from the newest 500 of 1,240 records. The audit log has the rest.',
    );
    unmount();
    renderCm({ rationale: { ...cut, rows_total: 10_000, rows_total_relation: 'gte' } as unknown as CaseRationale });
    expect(screen.getByTestId('rationale-cut')).toHaveTextContent('the newest 500 of at least 10,000 records');
  });

  it('says nothing about a cut for a rationale that read every record or an older server', () => {
    const whole = { ...RATIONALE, returned: 12, rows_total: 12, rows_total_relation: 'eq', truncated: false } as unknown as CaseRationale;
    const { unmount } = renderCm({ rationale: whole });
    expect(screen.queryByTestId('rationale-cut')).toBeNull();
    unmount();
    renderCm();
    expect(screen.queryByTestId('rationale-cut')).toBeNull();
  });

  it('keeps the full assessment evidence one disclosure away', () => {
    renderCm();
    fireEvent.click(screen.getByRole('button', { name: /show full assessment evidence/i }));
    expect(screen.getByText('Agent reasoning')).toBeInTheDocument();
  });

  it('renders no stage narrative and no threat context (they are on Evidence)', () => {
    renderCm();
    expect(screen.queryByText('What happened')).toBeNull();
    expect(screen.queryByText('Threat context')).toBeNull();
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
