/**
 * DecisionCard — analyst-policy closes and promoted analyst precedent.
 *
 * Two Console-visible failures this guards:
 *
 * 1. `analyst_policy` contains the substring "analyst", so the card's `decidedBy`
 *    heuristic credited a HUMAN for a case no person ever worked. An operator reading
 *    the queue would conclude an analyst had reviewed it.
 * 2. A policy close carries NO verdict and NO confidence (no model ran). Without an
 *    explanation the card renders an empty verdict the reader has to interpret, which
 *    is exactly the silence this whole change exists to remove.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DecisionCard } from '../DecisionCard';
import type { Case } from '@/lib/types';

const POLICY_CASE = {
  case_id: 'c-policy',
  verdict: null,
  status: 'closed',
  decision_by: 'analyst_policy',
  disposition: 'false_positive',
  risk_score: 13.5,
  analyst_policy: {
    policy_ids: ['arp-1'],
    rule_ids: ['web_shell_php'],
    reasons: ['Internal PHP CI runner.'],
  },
} as unknown as Case;

const PROMOTED_CASE = {
  case_id: 'c-promoted',
  verdict: 'false_positive',
  confidence: 0.91,
  status: 'closed',
  decision_by: 'agent',
  risk_score: 13.5,
  precedent_signal: {
    status: 'qualified',
    qualifies: true,
    rule_identity: 'web_shell_php',
    rule_ids: ['web_shell_php'],
    confirmed_false_positive: 314,
    confirmed_true_positive: 0,
    retrieved_matching: 6,
  },
} as unknown as Case;

describe('DecisionCard — analyst rule policy', () => {
  it('never credits a human for a deterministic policy close', () => {
    render(<DecisionCard c={POLICY_CASE} rationale={null} timeline={null} />);
    // NOT "Decided by Analyst" — the operator declared a RULE, nobody worked this case.
    expect(screen.getByText(/Decided by Automated/)).toBeInTheDocument();
    expect(screen.queryByText(/Auto-closed by AI/)).not.toBeInTheDocument();
  });

  it('names the declaration and says plainly that no model was called', () => {
    render(<DecisionCard c={POLICY_CASE} rationale={null} timeline={null} />);
    expect(screen.getByText('Closed by analyst policy')).toBeInTheDocument();
    const explainer = screen.getByText(/no model was called/i);
    expect(explainer).toBeInTheDocument();
    expect(explainer.textContent).toContain('web_shell_php');
    // ...and it points at the reversal path.
    expect(explainer.textContent).toMatch(/Revoke the declaration/);
  });

  it('says nothing about analyst policy on an ordinary case', () => {
    const ordinary = { ...POLICY_CASE, decision_by: 'agent', analyst_policy: null } as Case;
    render(<DecisionCard c={ordinary} rationale={null} timeline={null} />);
    expect(screen.queryByText('Closed by analyst policy')).not.toBeInTheDocument();
  });
});

describe('DecisionCard — promoted analyst precedent', () => {
  it('records that precedent was promoted, with the count, so the close is auditable', () => {
    render(<DecisionCard c={PROMOTED_CASE} rationale={null} timeline={null} />);
    const note = screen.getByText(/Analyst-confirmed precedent was promoted/);
    expect(note.textContent).toContain('314');
    // It must never claim precedent decided the case.
    expect(note.textContent).toMatch(/verdict remained the model's/);
    expect(note.textContent).toMatch(/deterministic policy/);
  });

  it('stays silent when the signal did not qualify', () => {
    const unqualified = {
      ...PROMOTED_CASE,
      precedent_signal: { status: 'insufficient', qualifies: false, confirmed_false_positive: 3 },
    } as unknown as Case;
    render(<DecisionCard c={unqualified} rationale={null} timeline={null} />);
    expect(screen.queryByText(/Analyst-confirmed precedent was promoted/)).not.toBeInTheDocument();
  });

  it('stays silent on a case that predates the seam', () => {
    const legacy = { ...PROMOTED_CASE, precedent_signal: null } as unknown as Case;
    render(<DecisionCard c={legacy} rationale={null} timeline={null} />);
    expect(screen.queryByText(/Analyst-confirmed precedent was promoted/)).not.toBeInTheDocument();
  });
});
