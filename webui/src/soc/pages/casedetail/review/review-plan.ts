/**
 * Round 15 (SPEC D4.7, D6.12, D8.2): how the auto-close review changes a case's actions.
 * Pure and dependency-light (type imports only), so the case workspace imports it at
 * once while the review card itself loads lazily.
 *
 * The D8.2 table's review rows, applied over the lifecycle plan (`actionPlanForStatus`):
 *
 *   | Case                                        | Primary      | Take action                         |
 *   |---------------------------------------------|--------------|-------------------------------------|
 *   | terminal, agent-closed, pending review      | Start review | the lifecycle verbs (Reopen first)  |
 *   | terminal, agent-closed, no pending review   | the plan's   | Review this auto-close, no Set disposition |
 *   | anything else                               | the plan's   | the plan's                          |
 *
 * "Agent-closed" is the review endpoint's own rule (`isAgentClosedCase`: terminal, first
 * decision record an agent close), so a reopened sampled case offers no review (the
 * endpoint would answer 409 until it is closed again, WP5 review note 14). A person who
 * cannot record a review (`cases:write`) gets the plan unchanged except that Set
 * disposition stays hidden on an agent-closed case: such a case is reviewed, never
 * re-labelled (D4.7). Nothing here decides anything (#3).
 */
import type { CaseReviewState } from '@/lib/types-reviews';

import type { ActionDef, ActionPlan } from '../shared';

/** The band copy for a pending sample (D6.12). */
export const REVIEW_BAND_TEXT =
  'Picked at random for auto-close review. Classify it yourself, then compare with the AI.';

/** The header's primary action on a pending sample, and its tooltip. */
export const START_REVIEW_LABEL = 'Start review';
export const START_REVIEW_HELP = 'Classify this case yourself, then compare your answer with the AI.';
/** The Take action item that replaces Set disposition on an agent-closed case. */
export const REVIEW_MENU_LABEL = 'Review this auto-close';

export interface ReviewPlanInput {
  /** The case is terminal and its first decision record is an agent close. */
  agentClosed: boolean;
  /** `GET /api/cases/{id}/review`, or null while it is unknown (loading or failed). */
  review: CaseReviewState | null;
  /** The viewer holds `cases:write`, the grant the review endpoint checks. */
  canReview: boolean;
}

export interface CaseActionLayout {
  /** The lifecycle primary, or null when Start review is the primary. */
  primary: ActionDef | null;
  /** Every lifecycle verb Take action offers, in order. */
  overflow: ActionDef[];
  /** The header's primary is Start review, and the pending band shows. */
  startReview: boolean;
  /** Take action offers "Review this auto-close". */
  reviewInMenu: boolean;
}

/** Is the case waiting in the review sample, and can its review be recorded now? */
export function reviewPending(review: CaseReviewState | null): boolean {
  return Boolean(review && review.state === 'pending' && review.agent_closed && review.can_record);
}

export function reviewActionLayout(plan: ActionPlan, input: ReviewPlanInput): CaseActionLayout {
  if (!input.agentClosed) {
    return { primary: plan.primary, overflow: plan.overflow, startReview: false, reviewInMenu: false };
  }
  // D4.7: an automatic close is reviewed, never re-labelled with Set disposition.
  const overflow = plan.overflow.filter((action) => action.key !== 'set_disposition');
  if (input.canReview && reviewPending(input.review)) {
    // The lifecycle primary (Reopen on a closed case) moves to the front of Take action.
    return { primary: null, overflow: [plan.primary, ...overflow], startReview: true, reviewInMenu: false };
  }
  // While the state is unknown the endpoint decides (a recorded sample answers 409).
  const recordable = input.review ? input.review.can_record : true;
  return {
    primary: plan.primary,
    overflow,
    startReview: false,
    reviewInMenu: input.canReview && recordable,
  };
}
