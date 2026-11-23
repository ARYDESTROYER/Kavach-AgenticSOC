/**
 * Round 15 (SPEC D6.7, D6.12): the auto-close review source of `caseOutcome` and the
 * `isReviewGrade` mirror of `backend/app/engine/review_origin.py`.
 *
 *   - a grade is a review grade by its `origin`, or by a history event with a non-empty
 *     `review_id` naming its `ts` and `analyst` (an older build drops the entry marker);
 *   - an ordinary grade, or a history event with an empty `review_id`, is not;
 *   - only an agent-decided terminal case reads as its review: "Reviewed: ..." when the
 *     reviewer agreed, "Review disagreed: ..." when not; ordinary feedback keeps today's
 *     "Auto-closed as ..." rendering.
 */
import { describe, expect, it } from 'vitest';

import type { Case, CaseFeedback } from '@/lib/types';
import { caseOutcome, isReviewGrade, latestReview, outcomeCellText } from '../outcome';

const TS = '2026-11-23T10:00:00+00:00';

function agentClosed(extra: Partial<Case> & { history?: unknown[] } = {}): Case {
  return {
    case_id: 'case-1',
    status: 'closed',
    decision_by: 'agent',
    verdict: 'FALSE_POSITIVE',
    confidence: 0.93,
    feedback: [],
    ...extra,
  } as unknown as Case;
}

const reviewGrade = (over: Partial<CaseFeedback> = {}): CaseFeedback => ({
  ts: TS,
  analyst: 'asha.iyer',
  assessment: 'agree',
  actual_outcome: 'false_positive',
  origin: 'auto_close_review',
  review_id: 'acr-1',
  ...over,
});

const event = (over: Record<string, unknown> = {}) => ({
  event: 'auto_close_review',
  review_id: 'acr-1',
  feedback_ts: TS,
  analyst: 'asha.iyer',
  ts: TS,
  agrees: true,
  ...over,
});

describe('isReviewGrade', () => {
  it('is true by the entry marker', () => {
    expect(isReviewGrade(agentClosed(), reviewGrade())).toBe(true);
  });

  it('is true by the history event when the entry lost its marker (rollback)', () => {
    const plain = reviewGrade({ origin: '', review_id: '' });
    expect(isReviewGrade(agentClosed({ history: [event()] }), plain)).toBe(true);
  });

  it('is false for an ordinary grade, a different analyst or time, and an empty review id', () => {
    const plain: CaseFeedback = { ts: TS, analyst: 'asha.iyer', assessment: 'agree' };
    expect(isReviewGrade(agentClosed(), plain)).toBe(false);
    expect(isReviewGrade(agentClosed({ history: [event({ analyst: 'someone.else' })] }), plain)).toBe(false);
    expect(isReviewGrade(agentClosed({ history: [event({ feedback_ts: '2026-11-22T00:00:00Z' })] }), plain)).toBe(false);
    expect(isReviewGrade(agentClosed({ history: [event({ review_id: '' })] }), plain)).toBe(false);
    expect(isReviewGrade(agentClosed(), null)).toBe(false);
  });
});

describe('caseOutcome review source', () => {
  it('reads "Reviewed: ..." for an agreeing review of an automatic close', () => {
    const c = agentClosed({ feedback: [reviewGrade()], history: [event({ classification: 'benign' })] });
    const o = caseOutcome(c);
    expect(o.source).toBe('review');
    expect(o.headline).toBe('Reviewed: benign');
    expect(o.shortLabel).toBe('Reviewed');
    expect(o.agreement).toBe('agrees');
    expect(o.by).toBe('asha.iyer');
    expect(outcomeCellText(o)).toEqual({ label: 'Reviewed', full: 'Reviewed: benign' });
  });

  it('reads "Review disagreed: ..." for a disagreeing review', () => {
    const c = agentClosed({
      feedback: [reviewGrade({ assessment: 'disagree', actual_outcome: 'true_positive' })],
    });
    const o = caseOutcome(c);
    expect(o.headline).toBe('Review disagreed: true positive');
    expect(o.shortLabel).toBe('Review disagreed');
    expect(o.agreement).toBe('overrides');
  });

  it('reads an unsure review without a label', () => {
    const c = agentClosed({ feedback: [reviewGrade({ assessment: '', actual_outcome: 'unknown' })] });
    expect(caseOutcome(c).headline).toBe('Reviewed: unsure');
    expect(latestReview(c)?.agrees).toBeNull();
  });

  it('keeps today rendering for ordinary feedback on an automatic close', () => {
    const c = agentClosed({ feedback: [{ ts: TS, analyst: 'demo.analyst', assessment: 'agree', actual_outcome: 'false_positive' }] });
    const o = caseOutcome(c);
    expect(o.source).toBe('agent_auto');
    expect(o.headline).toBe('Auto-closed as false positive');
  });

  it('applies only to agent-decided terminal cases', () => {
    const reopened = agentClosed({ status: 'open', decision_by: 'analyst', feedback: [reviewGrade()] });
    expect(caseOutcome(reopened).source).not.toBe('review');
    const routed = agentClosed({ status: 'closed', decision_by: 'system', feedback: [reviewGrade()] });
    expect(caseOutcome(routed).source).not.toBe('review');
  });

  it('uses the newest review grade', () => {
    const c = agentClosed({
      feedback: [reviewGrade(), reviewGrade({ ts: '2026-11-23T11:00:00+00:00', assessment: 'disagree', actual_outcome: 'true_positive' })],
    });
    expect(caseOutcome(c).headline).toBe('Review disagreed: true positive');
  });
});
