/**
 * DecisionCard — the pinned deterministic-decision authority card (Round-7 #9a).
 *
 * Verifies the card reads the EXACT AutoClosePolicy clause off the terminal `decision`
 * TraceSpan in the timeline prop, surfaces the verdict/status/confidence + "Decided by",
 * flags an AI auto-close, shows the objection window, and degrades cleanly when no
 * timeline (and thus no clause) is available — falling back to the case fields.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import { DecisionCard } from '../DecisionCard';
import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';

expect.extend(toHaveNoViolations);

const FUTURE_ISO = new Date(Date.now() + 3_600_000).toISOString();

const decisionSpan = (payload: Record<string, unknown>): TraceSpan => ({
  step_index: 9,
  kind: 'decision',
  name: 'case_manager',
  ts: '2026-07-05T00:00:00Z',
  latency_ms: null,
  cost: null,
  tokens: null,
  trusted: true,
  summary: 'Auto-closed as false positive: confidence 0.92 ≥ 0.8 bar and risk 12 ≤ 40.',
  payload_ref: payload,
});

/** A timeline whose terminal span carries the exact policy clause decide() evaluated. */
const TIMELINE: TimelineResponse = {
  case_id: 'c1',
  total: 2,
  totals: { cost: 0, tokens: 0 },
  spans: [
    { ...decisionSpan({}), kind: 'invoke_agent', name: 'investigator', step_index: 0 },
    decisionSpan({
      deterministic: true,
      verdict: 'false_positive',
      confidence: 0.92,
      risk_score: 12,
      decision_status: 'closed',
      decision_by: 'agent',
      escalate: false,
      objection_window_expires_at: FUTURE_ISO,
      policy_clause: {
        verdict_class: 'false_positive',
        auto_closable: true,
        enabled: true,
        min_confidence: 0.8,
        max_risk_score: 40,
        objection_window_minutes: 30,
      },
    }),
  ],
};

const CASE = {
  case_id: 'c1',
  verdict: 'false_positive',
  status: 'closed',
  decision_by: 'agent',
  risk_score: 12,
  confidence: 0.92,
  objection_window_expires_at: FUTURE_ISO,
} as unknown as Case;

const RATIONALE = {
  case_id: 'c1',
  decision_rationale: 'FP auto-close bar met; scheduled behind a 30-minute objection window.',
} as unknown as CaseRationale;

describe('DecisionCard — policy clause from the timeline fixture', () => {
  it('reads the matched AutoClosePolicy clause off the terminal decision span', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />);

    // The clause block is present and shows the exact thresholds decide() compared.
    expect(screen.getByText('Policy clause evaluated')).toBeInTheDocument();
    expect(screen.getByText('eligible')).toBeInTheDocument(); // auto_closable: true
    expect(screen.getByText('0.8')).toBeInTheDocument(); // min_confidence
    expect(screen.getByText('40')).toBeInTheDocument(); // max_risk_score
    // verdict_class humanized appears in the clause (and the verdict badge).
    expect(screen.getAllByText('False positive').length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces the decide() inputs (verdict / confidence / risk / result) + who decided', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />);
    expect(screen.getByText('Deterministic decision')).toBeInTheDocument();
    // Confidence fact = round(0.92*100) = 92%.
    expect(screen.getAllByText('92%').length).toBeGreaterThanOrEqual(1);
    // Risk fact = 12/100 (from the span payload).
    expect(screen.getByText('12/100')).toBeInTheDocument();
    // decision_by 'agent' → the pipeline, not a human.
    expect(screen.getByText(/Decided by Automated/)).toBeInTheDocument();
  });

  it('flags an AI auto-close + the deterministic rationale (#3 authority)', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />);
    // status closed + decision_by agent ⇒ AutoClosedBadge shows, with the reopen window.
    expect(screen.getByText(/Auto-closed by AI/)).toBeInTheDocument();
    expect(screen.getByText(/reopen before/)).toBeInTheDocument();
    // The deterministic rationale string is rendered as plain prose.
    expect(
      screen.getByText(/FP auto-close bar met; scheduled behind a 30-minute objection window\./),
    ).toBeInTheDocument();
  });

  it('shows an Escalate flag when the recorded decision escalated', () => {
    const escalated: TimelineResponse = {
      ...TIMELINE,
      spans: [
        decisionSpan({
          source: 'recorded',
          verdict: 'needs_human',
          decision_status: 'escalated',
          decision_by: 'agent',
          escalate: true,
          policy_clause: { verdict_class: 'needs_human', auto_closable: false },
        }),
      ],
    };
    render(<DecisionCard c={{ ...CASE, verdict: 'needs_human', status: 'escalated' } as Case} rationale={null} timeline={escalated} />);
    expect(screen.getByText('Escalate')).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument(); // auto_closable false
    // A needs-human verdict never closes automatically: fixed by code, not by policy.
    expect(screen.getByTestId('decision-conditions')).toHaveTextContent('fixed by code, not by policy');
  });

  it('degrades to the case fields and hides the clause block when no timeline', () => {
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={null} />);
    // No decision span ⇒ no clause block.
    expect(screen.queryByText('Policy clause evaluated')).toBeNull();
    // But the card still renders the verdict/status derived from the case.
    expect(screen.getByText('Deterministic decision')).toBeInTheDocument();
    expect(screen.getAllByText('False positive').length).toBeGreaterThanOrEqual(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <DecisionCard c={CASE} rationale={RATIONALE} timeline={TIMELINE} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

/* Round 16 (research explainability D1, D8): the RECORDED decision, both conditions. */
describe('DecisionCard: the recorded decision, never a read-time re-run (D1)', () => {
  /** An older build's decision span: `decide()` re-run with TODAY's policy at read time. */
  const READ_TIME: TimelineResponse = {
    ...TIMELINE,
    spans: [
      decisionSpan({
        deterministic: true,
        verdict: 'FALSE_POSITIVE',
        confidence: 0.97,
        risk_score: 20,
        decision_status: 'closed',
        decision_by: 'agent',
        escalate: false,
        objection_window_expires_at: '2099-01-01T00:00:00Z',
        policy_clause: {
          verdict_class: 'FALSE_POSITIVE',
          enabled: true,
          auto_closable: true,
          min_confidence: 0.85,
          max_risk_score: 30,
          objection_window_minutes: 1440,
        },
      }),
    ],
  };
  const ANALYST_CLOSED = {
    case_id: 'c2',
    verdict: 'FALSE_POSITIVE',
    confidence: 0.97,
    risk_score: 20,
    status: 'closed',
    decision_by: 'analyst',
    objection_window_expires_at: null,
  } as unknown as Case;

  it("an analyst's close reads as the analyst's, with no objection window invented by a re-run", () => {
    render(<DecisionCard c={ANALYST_CLOSED} rationale={null} timeline={READ_TIME} />);
    expect(screen.getByText(/Decided by Analyst/)).toBeInTheDocument();
    expect(screen.queryByText(/Decided by Automated/)).toBeNull();
    expect(screen.queryByText(/Auto-closed by AI/)).toBeNull();
    expect(screen.queryByText(/Objection window open until/)).toBeNull();
    // The re-run's rationale never stands in for the recorded one.
    expect(screen.queryByText(/Auto-closed as false positive/)).toBeNull();
    // The thresholds are labelled as today's policy, not as the recorded gate.
    expect(screen.getByTestId('decision-clause-basis')).toHaveTextContent('thresholds were not recorded');
  });

  it('states both auto-close conditions with their numbers (D8)', () => {
    render(
      <DecisionCard
        c={{ ...ANALYST_CLOSED, risk_score: 45, status: 'needs_human', decision_by: 'system' } as Case}
        rationale={null}
        timeline={READ_TIME}
      />,
    );
    expect(screen.getByTestId('decision-conditions')).toHaveTextContent(
      'Routed to a person: confidence 97% >= 85% (met); risk 45 <= 30 (not met).',
    );
  });

  it('reads the gate recorded at decision time and notes a policy that changed since', () => {
    const recorded: TimelineResponse = {
      ...TIMELINE,
      spans: [
        decisionSpan({
          source: 'recorded',
          decision_status: 'closed',
          decision_by: 'agent',
          objection_window_expires_at: FUTURE_ISO,
          gate: {
            verdict: 'FALSE_POSITIVE',
            confidence: 0.92,
            risk_score: 12,
            class_enabled: true,
            min_confidence: 0.8,
            max_risk_score: 40,
            objection_window_minutes: 30,
            escalation_confidence: 0.6,
            critical_severity: 7,
            outcome: 'closed',
            demo: false,
          },
          current_policy: { enabled: true, min_confidence: 0.95, max_risk_score: 40, objection_window_minutes: 30 },
          policy_changed: true,
        }),
      ],
    };
    render(<DecisionCard c={CASE} rationale={RATIONALE} timeline={recorded} />);
    expect(screen.getByTestId('decision-clause-basis')).toHaveTextContent('as recorded at decision time');
    expect(screen.getByTestId('decision-conditions')).toHaveTextContent(
      'Closes automatically: confidence 92% >= 80% (met) and risk 12 <= 40 (met).',
    );
    expect(screen.getByTestId('decision-policy-changed')).toHaveTextContent(
      "The auto-close policy changed since this decision. Today's policy routes it to a person: confidence 92% >= 95% (not met); risk 12 <= 40 (met).",
    );
  });

  it('shows the risk fact as the integer rounded half up', () => {
    render(<DecisionCard c={{ ...CASE, risk_score: 73.5 } as Case} rationale={null} timeline={null} />);
    expect(screen.getByText('74/100')).toBeInTheDocument();
  });
});

describe('the precedent line (WP11 review: counts only when they were read)', () => {
  // A signal the server never read counts for carries zeros by default; stating them as
  // "0 confirmed benign ... for this rule" would invent a history.
  const withSignal = (signal: Record<string, unknown> | null) =>
    ({ ...CASE, precedent_signal: signal }) as unknown as Case;
  // The visible line (the trigger adds an sr-only ", explain" to its accessible name).
  const line = () => (screen.getByTestId('decision-precedent').textContent ?? '').replace(/, explain$/, '');

  it('says precedent was not used, with no counts, when promotion is off', () => {
    render(
      <DecisionCard
        c={withSignal({
          status: 'disabled',
          reason: 'analyst-confirmed precedent promotion is turned off for this deployment',
          qualifies: false,
          confirmed_false_positive: 0,
          confirmed_true_positive: 0,
          min_confirmed: 3,
        })}
        rationale={null}
        timeline={null}
      />,
    );
    expect(line()).toBe('Precedent: not used, because precedent promotion is off.');
  });

  it('says so for a case with no rule and for an unreadable history', () => {
    const { unmount } = render(
      <DecisionCard
        c={withSignal({ status: 'not_applicable', qualifies: false, confirmed_false_positive: 0, confirmed_true_positive: 0 })}
        rationale={null}
        timeline={null}
      />,
    );
    expect(line()).toBe('Precedent: not used, because this case has no detection rule to match.');
    unmount();
    render(<DecisionCard c={withSignal({ status: 'unavailable', qualifies: false, truncated: false })} rationale={null} timeline={null} />);
    expect(line()).toBe('Precedent: not used, because the confirmed history could not be read.');
  });

  it('states the counts it read, the minimum and the reason in words', () => {
    render(
      <DecisionCard
        c={withSignal({
          status: 'insufficient',
          reason: '1 analyst-confirmed benign precedent(s) for this rule identity; 3 are required',
          qualifies: false,
          confirmed_false_positive: 1,
          confirmed_true_positive: 0,
          min_confirmed: 3,
        })}
        rationale={null}
        timeline={null}
      />,
    );
    expect(line()).toBe(
      'Precedent: 1 confirmed benign and 0 confirmed malicious outcomes for this rule; 3 needed; it did not qualify (fewer confirmed benign outcomes than needed).',
    );
  });

  it('says "at least" for a history read that was cut short', () => {
    render(
      <DecisionCard
        c={withSignal({ status: 'unavailable', qualifies: false, truncated: true, confirmed_false_positive: 4, confirmed_true_positive: 0, min_confirmed: 3 })}
        rationale={null}
        timeline={null}
      />,
    );
    expect(line()).toBe(
      'Precedent: at least 4 confirmed benign and at least 0 confirmed malicious outcomes for this rule; 3 needed; it did not qualify (the read was cut short, so the counts are lower bounds).',
    );
  });

  it('a qualifying signal, and an older run without one', () => {
    const { unmount } = render(
      <DecisionCard
        c={withSignal({ status: 'qualified', qualifies: true, confirmed_false_positive: 5, confirmed_true_positive: 0, min_confirmed: 3 })}
        rationale={null}
        timeline={null}
      />,
    );
    expect(line()).toBe(
      'Precedent: 5 confirmed benign and 0 confirmed malicious outcomes for this rule; 3 needed; it qualified as evidence.',
    );
    unmount();
    render(<DecisionCard c={withSignal(null)} rationale={null} timeline={null} />);
    expect(line()).toBe('Precedent: not recorded for this investigation.');
  });

  it('opens the full facts on click: the best match against its floor', async () => {
    const user = userEvent.setup();
    render(
      <DecisionCard
        c={withSignal({
          status: 'not_retrieved',
          qualifies: false,
          confirmed_false_positive: 4,
          confirmed_true_positive: 0,
          min_confirmed: 3,
          top_score: 0.4123,
          min_similarity: 0.6,
        })}
        rationale={null}
        timeline={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Precedent: 4 confirmed benign/ }));
    const panel = await screen.findByTestId('explain-panel');
    expect(panel).toHaveTextContent('Best match0.4123 against a floor of 0.6');
    expect(panel).toHaveTextContent('Benign outcomes needed3');
  });
});
