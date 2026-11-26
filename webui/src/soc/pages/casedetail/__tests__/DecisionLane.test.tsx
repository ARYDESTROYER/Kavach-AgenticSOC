/**
 * DecisionLane: the Brief's Decision lane (Round 16, SPEC D8, §4.4 WP03; the Decision
 * section of the Investigation tab before it).
 *
 * What settled the case, from the code or a person, never the model (#3): the decision
 * line, the auto-close reading against the entry for the case's verdict (B27), the
 * authority sentence ONCE, and two disclosures, Policy inputs and Automation applied (N).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { DecisionLane, autoCloseLine, decisionTitle, type DecisionLaneProps } from '../DecisionLane';
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

const TIMELINE: TimelineResponse = { case_id: 'c1', total: 1, totals: { cost: 0, tokens: 0 }, spans: [decisionSpan] };

function renderLane(over: Partial<DecisionLaneProps> = {}) {
  return render(
    <DecisionLane
      c={CASE}
      rationale={{ case_id: 'c1', decision_rationale: 'Escalated for a person to review.' } as unknown as CaseRationale}
      timeline={TIMELINE}
      {...over}
    />,
  );
}

describe('DecisionLane', () => {
  it('writes the decision record as a sentence, and never shows other text as it is (XFCM, FXA1)', () => {
    const record =
      'verdict=TRUE_POSITIVE status=escalated decision_by=system risk=7.41 cost=0.02 confidence=0.9 auto_close_gate=class_disabled';
    const { unmount } = renderLane({ rationale: { decision_rationale: record } as unknown as CaseRationale });
    const line = screen.getByTestId('decision-line');
    // No auto-close reading here (the policy is not known), so the recorded reason follows.
    expect(line).toHaveTextContent(/^Escalated by the system\. Auto-close is off for this verdict\.$/);
    expect(line).not.toHaveClass('font-mono');
    expect(line).toHaveClass('text-base');
    // The header's facts and the cost are not repeated here.
    const lane = screen.getByTestId('brief-decision');
    for (const token of ['verdict=', 'risk=', 'cost=', 'confidence=', 'auto_close_gate=']) {
      expect(lane.textContent).not.toContain(token);
    }
    unmount();
    // Text that is neither the record nor an engine template reads as the neutral line.
    renderLane();
    expect(screen.getByTestId('decision-line')).not.toHaveClass('font-mono');
    expect(screen.getByTestId('decision-line')).toHaveTextContent(
      /^The server-side case policy recorded the outcome shown for this case\.$/,
    );
  });

  it('words the rationale decide() wrote, never the raw engine string (FXA1)', () => {
    const auto = 'FALSE_POSITIVE auto-closed: confidence 0.87 >= 0.85 and risk 13.6 <= 30.0; objection window 1440m.';
    const { unmount } = renderLane({
      c: { ...CASE, verdict: 'FALSE_POSITIVE', status: 'closed', decision_by: 'agent', confidence: 0.87, risk_score: 13.6 } as Case,
      rationale: { decision_rationale: auto } as unknown as CaseRationale,
      policy: { enabled: true, min_confidence: 0.85, max_risk_score: 30 },
    });
    // The auto-close reading says why, so the line is the route alone: said once.
    expect(screen.getByTestId('decision-line')).toHaveTextContent(/^Closed automatically by the case policy\.$/);
    expect(screen.getByTestId('decision-auto-close')).toHaveTextContent(/^Eligible for auto-close/);
    const lane = screen.getByTestId('brief-decision');
    for (const raw of ['FALSE_POSITIVE', '>=', '<=', '1440m', 'auto-closed:']) expect(lane.textContent).not.toContain(raw);
    // Policy inputs keeps the record word for word.
    fireEvent.click(screen.getByRole('button', { name: /Policy inputs/ }));
    expect(screen.getByText(auto)).toBeInTheDocument();
    unmount();

    renderLane({
      c: { ...CASE, verdict: 'NEEDS_HUMAN', status: 'needs_human', decision_by: 'system' } as Case,
      rationale: { decision_rationale: 'No confident close decision; routing to human (fail-safe).' } as unknown as CaseRationale,
      policy: { enabled: true, min_confidence: 0.85, max_risk_score: 30 },
    });
    expect(screen.getByTestId('decision-line')).toHaveTextContent(/^Sent to an analyst by the case policy\.$/);
    expect(screen.getByTestId('brief-decision')).not.toHaveTextContent(/fail-safe|routing to human/);
  });

  it('leaves an unknown key=value record to Policy inputs and says the plain line instead (XFCM)', () => {
    renderLane({ rationale: { decision_rationale: 'gate=open route=human' } as unknown as CaseRationale });
    expect(screen.getByTestId('decision-line')).toHaveTextContent(
      'The server-side case policy recorded the outcome shown for this case.',
    );
  });

  it('keeps the record word for word one disclosure away, in Policy inputs (XFCM)', () => {
    const record =
      'verdict=TRUE_POSITIVE status=escalated decision_by=system risk=7.41 cost=0.02 confidence=0.9 auto_close_gate=class_disabled';
    renderLane({ rationale: { decision_rationale: record } as unknown as CaseRationale });
    expect(screen.queryByText(record)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Policy inputs/ }));
    expect(screen.getByText(record)).toBeInTheDocument();
  });

  it('says the authority sentence once, with the auto-close reading against the verdict entry', () => {
    renderLane({
      c: { ...CASE, verdict: 'false_positive', status: 'needs_human', decision_by: 'system', confidence: 0.6 } as Case,
      policy: { enabled: true, min_confidence: 0.85, max_risk_score: 30 },
    });
    expect(screen.getByTestId('decision-authority')).toHaveTextContent(
      'Made by code against the auto-close policy, never by the model.',
    );
    expect(screen.getAllByText(/never by the model/i)).toHaveLength(1);
    expect(screen.getByTestId('decision-auto-close')).toHaveTextContent('Below the 0.85 auto-close confidence bar');
  });

  it('reads a human close as the analyst\'s, in its authority and its record', () => {
    renderLane({
      rationale: {
        decision_rationale: 'No confident close decision; routing to human (fail-safe).',
      } as unknown as CaseRationale,
      c: {
        ...CASE,
        verdict: 'NEEDS_HUMAN',
        confidence: 0.75,
        status: 'closed',
        decision_by: 'analyst',
        disposition: 'false_positive',
        history: [
          { event: 'analyst_action', action: 'close', analyst: 'aryan', ts: '2026-10-09T10:00:00Z', classified_disposition: 'false_positive' },
        ],
      } as unknown as Case,
    });
    const lane = screen.getByTestId('brief-decision');
    expect(lane).toHaveAttribute('data-decided-by', 'analyst');
    // One home per fact (XFCM): the outcome and the person are the header's, the
    // inspector's and the People lane's, never this lane's.
    expect(lane).not.toHaveTextContent('Closed as false positive by aryan');
    expect(lane).not.toHaveTextContent('aryan');
    // The line is what the policy recorded before the analyst, in words, with its reason.
    expect(screen.getByTestId('decision-line')).toHaveTextContent(
      /^Before the analyst: Sent to an analyst by the case policy\. This verdict never closes automatically\.$/,
    );
    expect(screen.getByTestId('decision-authority')).toHaveTextContent(/closed by an analyst/i);
    // A person settled it: no auto-close reading.
    expect(screen.queryByTestId('decision-auto-close')).toBeNull();
  });

  it("writes the policy's record before a person's close as a sentence (XFCM)", () => {
    renderLane({
      c: {
        ...CASE,
        status: 'closed',
        decision_by: 'analyst',
        disposition: 'true_positive',
        history: [
          { event: 'analyst_action', action: 'close', analyst: 'aryan', ts: '2026-10-09T10:00:00Z', classified_disposition: 'true_positive' },
        ],
      } as unknown as Case,
      rationale: {
        decision_rationale:
          'verdict=TRUE_POSITIVE status=escalated decision_by=system risk=7.41 cost=hidden confidence=0.9 auto_close_gate=class_disabled',
      } as unknown as CaseRationale,
    });
    expect(screen.getByTestId('decision-line')).toHaveTextContent(
      /^Before the analyst: Escalated by the system\. Auto-close is off for this verdict\.$/,
    );
    expect(screen.getByTestId('brief-decision')).not.toHaveTextContent('aryan');
  });

  it('names the lane "Decision" when a person settled it, never a status or the tag again (FXA1)', () => {
    const closedBy = (status: string) =>
      ({
        ...CASE,
        status,
        decision_by: 'analyst',
        history: [{ event: 'analyst_action', action: 'close', analyst: 'aryan', ts: '2026-10-09T10:00:00Z' }],
      }) as unknown as Case;
    // The lane's Analyst tag says who; the name says what ("Analyst Decision").
    expect(decisionTitle(closedBy('closed'))).toBe('Decision');
    expect(decisionTitle(closedBy('resolved'))).toBe('Decision');
    expect(decisionTitle(CASE)).toBe('Decision');
  });

  it("shows the authority sentence alone on a person's close with no policy record (XFCM)", () => {
    renderLane({
      c: {
        ...CASE,
        status: 'resolved',
        decision_by: 'analyst',
        disposition: 'true_positive',
        history: [
          { event: 'analyst_action', action: 'resolve', analyst: 'aryan', ts: '2026-10-09T10:00:00Z', classified_disposition: 'true_positive' },
        ],
      } as unknown as Case,
      rationale: null,
    });
    expect(screen.queryByTestId('decision-line')).toBeNull();
    expect(screen.getByTestId('decision-authority')).toHaveTextContent(
      'Resolved by an analyst (a human lifecycle action). The deterministic policy did not resolve this case.',
    );
    expect(screen.getByTestId('brief-decision')).not.toHaveTextContent('aryan');
  });

  it('keeps the policy inputs one disclosure away, and asks for the trace when they open', () => {
    const onNeedTimeline = vi.fn();
    renderLane({ onNeedTimeline });
    expect(screen.queryByText('Policy clause evaluated')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Policy inputs/ }));
    expect(screen.getByText('Policy clause evaluated')).toBeInTheDocument();
    expect(onNeedTimeline).toHaveBeenCalledTimes(1);
  });

  it('lists the automation applied behind "Automation applied (N)", never as a status change', () => {
    renderLane({
      c: {
        ...CASE,
        automation_actions: [{ action: 'tag', detail: 'tag=vpn', rule_id: 'r1', at: '2026-10-28T13:00:00Z' }],
      } as unknown as Case,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Automation applied (1)' }));
    const applied = screen.getByTestId('automation-applied');
    expect(applied).toHaveTextContent('Tagged');
    expect(within(applied).getByText(/never changes the lifecycle status/i)).toBeInTheDocument();
  });

  it('offers "Open in Approvals" on an approval request to a viewer who can read the queue', () => {
    const onNavigate = vi.fn();
    renderLane({
      c: {
        ...CASE,
        automation_actions: [
          { action: 'request_approval', detail: 'proposal=prop-94f0 kind=automation_ack', proposal_id: 'prop-94f0', rule_id: 'r1' },
        ],
      } as unknown as Case,
      onNavigate,
      canOpenApprovals: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Automation applied (1)' }));
    fireEvent.click(screen.getByRole('button', { name: /Open in Approvals/ }));
    expect(onNavigate).toHaveBeenCalledWith('approvals');
  });

  it('says a case nobody decided yet is waiting for the code', () => {
    renderLane({ c: { case_id: 'c2', status: 'new' } as unknown as Case, rationale: null });
    expect(screen.getByTestId('brief-decision')).toHaveTextContent("No decision yet. The code decides after the AI's verdict.");
  });

  it('has no axe violations', async () => {
    const { container } = renderLane();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('autoCloseLine (B27: the entry for the case verdict)', () => {
  const open = (over: Partial<Case>) => ({ case_id: 'c', status: 'needs_human', decision_by: 'system', ...over }) as Case;

  it('evaluates a false positive against the false-positive entry', () => {
    const c = open({ verdict: 'FALSE_POSITIVE', confidence: 0.87, risk_score: 12 });
    expect(autoCloseLine({ enabled: true, min_confidence: 0.85, max_risk_score: 30 }, c)).toBe(
      'Eligible for auto-close: confidence is at or above the 0.85 bar and risk is within the policy ceiling.',
    );
    expect(autoCloseLine({ enabled: true, min_confidence: 0.85, max_risk_score: 10 }, c)).toBe(
      'Above the confidence bar, but risk exceeds the auto-close ceiling, so it is held for a human.',
    );
    expect(autoCloseLine({ enabled: false, min_confidence: 0.85 }, c)).toBe(
      'False-positive auto-close is off, so a person decides.',
    );
  });

  it('evaluates a true positive against its own opt-in entry, never "true positives never auto-close"', () => {
    const c = open({ verdict: 'TRUE_POSITIVE', confidence: 0.99, risk_score: 10 });
    expect(autoCloseLine({ enabled: true, min_confidence: 0.98, max_risk_score: 20 }, c)).toMatch(/^Eligible for auto-close/);
    expect(autoCloseLine({ enabled: false }, c)).toBe('True-positive auto-close is off, so a person decides.');
  });

  it('says Needs human never auto-closes, whatever the policy says', () => {
    const c = open({ verdict: 'NEEDS_HUMAN', confidence: 0.99, risk_score: 1 });
    expect(autoCloseLine({ enabled: true, min_confidence: 0.1 }, c)).toBe(
      'Needs human review verdicts never auto-close. A person decides.',
    );
    expect(autoCloseLine(null, c)).toBe('Needs human review verdicts never auto-close. A person decides.');
  });

  it('says nothing for a person close, an unassessed case or an unknown policy', () => {
    expect(autoCloseLine({ enabled: true, min_confidence: 0.85 }, open({ verdict: 'FALSE_POSITIVE', decision_by: 'analyst', status: 'closed' }))).toBeNull();
    expect(autoCloseLine({ enabled: true, min_confidence: 0.85 }, open({ verdict: undefined }))).toBeNull();
    expect(autoCloseLine(null, open({ verdict: 'FALSE_POSITIVE' }))).toBeNull();
  });
});
