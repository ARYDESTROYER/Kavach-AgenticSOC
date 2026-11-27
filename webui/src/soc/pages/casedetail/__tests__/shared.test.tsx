/**
 * casedetail/shared — lifecycle action copy (Round-6 finding #21).
 *
 * The backend `escalate` verb sets CaseStatus.ESCALATED (distinct from NEEDS_HUMAN,
 * which is only reached via the deterministic decide()/verdict path). The confirm /
 * help copy must reflect ESCALATED so the dialog matches the resulting status badge.
 */
import { describe, it, expect } from 'vitest';

import type { AutoClosePolicy } from '@/lib/types';

import { ALL_ACTIONS, confidenceCalibration, policyForVerdict } from '../shared';

describe('casedetail/shared — escalate action copy', () => {
  it('escalate confirm/help copy says ESCALATED, not NEEDS_HUMAN (#21)', () => {
    const esc = ALL_ACTIONS.escalate;
    expect(esc.confirmBody).toMatch(/ESCALATED/);
    expect(esc.help).toMatch(/ESCALATED/);
    expect(esc.confirmBody).not.toMatch(/NEEDS_HUMAN/);
    expect(esc.help).not.toMatch(/NEEDS_HUMAN/);
    expect(esc.confirmBody).not.toMatch(/tier|\bL[123]\b/i);
    expect(esc.help).not.toMatch(/tier|\bL[123]\b/i);
    // The escalate verb still maps to the real backend verb (never invented, #3).
    expect(esc.wireAction ?? esc.key).toBe('escalate');
  });
});

/**
 * B27 (Round 16, SPEC §4.4 WP03): the auto-close entry for a case's verdict comes from
 * `prefs.auto_close`, the field `decide()` acts on, one entry per verdict class.
 */
describe('casedetail/shared: policyForVerdict and confidenceCalibration (B27)', () => {
  const policy = {
    false_positive: { enabled: true, min_confidence: 0.85, max_risk_score: 30, objection_window_minutes: 0 },
    true_positive: { enabled: false, min_confidence: 0.99, max_risk_score: 20, objection_window_minutes: 60 },
  } as AutoClosePolicy;

  it('takes the false-positive entry for a false-positive or benign verdict', () => {
    expect(policyForVerdict(policy, 'FALSE_POSITIVE')).toMatchObject({ enabled: true, min_confidence: 0.85 });
    expect(policyForVerdict(policy, 'benign')).toMatchObject({ enabled: true, min_confidence: 0.85 });
  });

  it('takes the true-positive entry for a true positive', () => {
    expect(policyForVerdict(policy, 'TRUE_POSITIVE')).toMatchObject({ enabled: false, min_confidence: 0.99 });
  });

  it('never auto-closes Needs human or an unknown verdict, whatever the policy says', () => {
    expect(policyForVerdict(policy, 'NEEDS_HUMAN')).toEqual({ enabled: false });
    expect(policyForVerdict(policy, 'something else')).toEqual({ enabled: false });
    expect(policyForVerdict(policy, null)).toEqual({ enabled: false });
  });

  it('answers null when the policy is not known, and returns a copy of the entry', () => {
    expect(policyForVerdict(null, 'FALSE_POSITIVE')).toBeNull();
    expect(policyForVerdict(policy, 'FALSE_POSITIVE')).not.toBe(policy.false_positive);
  });

  it('names the verdict class in the bar note, and gives Needs human no bar', () => {
    expect(confidenceCalibration(policyForVerdict(policy, 'FALSE_POSITIVE'), 'FALSE_POSITIVE')).toEqual({
      threshold: 0.85,
      note: 'false-positive auto-close on at this bar',
    });
    expect(confidenceCalibration(policyForVerdict(policy, 'TRUE_POSITIVE'), 'TRUE_POSITIVE')).toEqual({
      threshold: 0.99,
      note: 'true-positive auto-close off',
    });
    expect(confidenceCalibration({ enabled: true, min_confidence: 0.5 }, 'NEEDS_HUMAN')).toEqual({});
  });
});
