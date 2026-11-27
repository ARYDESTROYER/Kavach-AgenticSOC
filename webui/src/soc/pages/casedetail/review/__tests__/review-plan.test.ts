/**
 * Round 15 (SPEC D4.7, D6.12, D8.2; WP7): the auto-close review's rows of the primary
 * action table, applied over the lifecycle plan.
 */
import { describe, expect, it } from 'vitest';

import type { CaseReviewState } from '@/lib/types-reviews';

import { actionPlanForStatus } from '../../shared';
import { REVIEW_BAND_TEXT as CARD_BAND_TEXT } from '../ReviewCard';
import { REVIEW_BAND_TEXT, reviewActionLayout, reviewPending } from '../review-plan';

const state = (over: Partial<CaseReviewState> = {}): CaseReviewState => ({
  case_id: 'c-1',
  agent_closed: true,
  state: 'pending',
  can_record: true,
  review_id: 'acr-1',
  sampled_at: '2026-11-23T10:00:00Z',
  expires_at: '2026-11-30T10:00:00Z',
  ...over,
});

const keys = (actions: ReadonlyArray<{ key: string }>) => actions.map((a) => a.key);

describe('reviewActionLayout: the D8.2 review rows', () => {
  it('leaves a case the agent did not close exactly as the lifecycle plan has it', () => {
    for (const status of ['new', 'open', 'escalated', 'resolved', 'closed']) {
      const plan = actionPlanForStatus(status);
      const layout = reviewActionLayout(plan, { agentClosed: false, review: state(), canReview: true });
      expect(layout.primary).toBe(plan.primary);
      expect(layout.overflow).toBe(plan.overflow);
      expect(layout.startReview).toBe(false);
      expect(layout.reviewInMenu).toBe(false);
    }
    // An analyst-closed case keeps Set disposition.
    const closed = reviewActionLayout(actionPlanForStatus('closed'), { agentClosed: false, review: null, canReview: true });
    expect(keys(closed.overflow)).toEqual(['set_disposition']);
  });

  it('terminal, agent-closed, pending review: Start review is the primary and Reopen moves to Take action', () => {
    const layout = reviewActionLayout(actionPlanForStatus('closed'), {
      agentClosed: true,
      review: state(),
      canReview: true,
    });
    expect(layout.startReview).toBe(true);
    expect(layout.primary).toBeNull();
    expect(keys(layout.overflow)).toEqual(['reopen']);
    expect(layout.reviewInMenu).toBe(false);
  });

  it('a resolved agent-closed sample: Start review, then the final close and Reopen', () => {
    const layout = reviewActionLayout(actionPlanForStatus('resolved'), {
      agentClosed: true,
      review: state(),
      canReview: true,
    });
    expect(layout.startReview).toBe(true);
    expect(keys(layout.overflow)).toEqual(['close_disposition', 'reopen']);
  });

  it('terminal, agent-closed, no pending review: Reopen is the primary and the review replaces Set disposition', () => {
    for (const review of [state({ state: 'none', review_id: null }), state({ state: 'expired' }), null]) {
      const layout = reviewActionLayout(actionPlanForStatus('closed'), { agentClosed: true, review, canReview: true });
      expect(layout.primary?.key).toBe('reopen');
      expect(layout.startReview).toBe(false);
      expect(layout.reviewInMenu).toBe(true);
      expect(keys(layout.overflow)).not.toContain('set_disposition');
    }
  });

  it('offers no review where it cannot be recorded (a completed sample)', () => {
    const layout = reviewActionLayout(actionPlanForStatus('closed'), {
      agentClosed: true,
      review: state({ state: 'completed', can_record: false, expires_at: null }),
      canReview: true,
    });
    expect(layout.primary?.key).toBe('reopen');
    expect(layout.reviewInMenu).toBe(false);
    expect(layout.overflow).toEqual([]);
  });

  it('without cases:write: no Start review and no review item, and still no Set disposition (D4.7)', () => {
    const layout = reviewActionLayout(actionPlanForStatus('closed'), {
      agentClosed: true,
      review: state(),
      canReview: false,
    });
    expect(layout.startReview).toBe(false);
    expect(layout.reviewInMenu).toBe(false);
    expect(layout.primary?.key).toBe('reopen');
    expect(keys(layout.overflow)).toEqual([]);
  });

  it('a pending entry the server cannot record (a reopened sample) is not pending here', () => {
    expect(reviewPending(state({ agent_closed: false, can_record: false }))).toBe(false);
    expect(reviewPending(state({ can_record: false }))).toBe(false);
    expect(reviewPending(state())).toBe(true);
    expect(reviewPending(null)).toBe(false);
  });

  it('the band copy is the SPEC sentence, shared with the card', () => {
    expect(REVIEW_BAND_TEXT).toBe(
      'Picked at random for auto-close review. Classify it yourself, then compare with the AI.',
    );
    expect(CARD_BAND_TEXT).toBe(REVIEW_BAND_TEXT);
  });
});
