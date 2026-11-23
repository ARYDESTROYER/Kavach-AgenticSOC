/**
 * Compile-time pins of the Round 15 auto-close review mirrors (`types-reviews.ts`) to
 * the generated OpenAPI contract, in the pattern of `types-contract-pins.ts`. Type-only
 * and imported by nothing: it costs the bundle nothing, and `tsc --noEmit` fails here the
 * moment a backend model in `routes_auto_close_review.py` gains, loses or renames a field
 * or changes a vocabulary while its mirror was not updated with it.
 */
import type { components, paths } from './api-types.gen';
import type {
  AutoCloseReviewMetrics,
  AutoCloseReviewSummary,
  CaseReviewState,
  ReviewAgreement,
  ReviewBody,
  ReviewClassification,
  ReviewDayRow,
  ReviewDuration,
  ReviewEligible,
  ReviewMetricsWindow,
  ReviewMissedThreat,
  ReviewMissedThreats,
  ReviewResult,
  ReviewRuleRow,
} from './types-reviews';

type S = components['schemas'];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type SameFields<M, K extends keyof S> = Equal<keyof M, keyof S[K]>;
type GetQuery<P extends keyof paths> = paths[P] extends { get: { parameters: { query?: infer Q } } }
  ? NonNullable<Q>
  : never;

export type ReviewPins = [
  Expect<SameFields<ReviewBody, 'ReviewBody'>>,
  Expect<SameFields<ReviewResult, 'ReviewResult'>>,
  Expect<SameFields<AutoCloseReviewSummary, 'AutoCloseReviewSummary'>>,
  Expect<SameFields<CaseReviewState, 'CaseReviewState'>>,
  Expect<Equal<CaseReviewState['state'], S['CaseReviewState']['state']>>,
  Expect<SameFields<AutoCloseReviewMetrics, 'AutoCloseReviewMetrics'>>,
  Expect<SameFields<ReviewMetricsWindow, 'ReviewMetricsWindow'>>,
  Expect<SameFields<ReviewAgreement, 'ReviewAgreement'>>,
  Expect<SameFields<ReviewMissedThreat, 'ReviewMissedThreat'>>,
  Expect<SameFields<ReviewMissedThreats, 'ReviewMissedThreats'>>,
  Expect<SameFields<ReviewRuleRow, 'ReviewRuleRow'>>,
  Expect<SameFields<ReviewDuration, 'ReviewDuration'>>,
  Expect<SameFields<ReviewDayRow, 'ReviewDayRow'>>,
  Expect<SameFields<ReviewEligible, 'ReviewEligible'>>,
  Expect<Equal<ReviewClassification, S['ReviewBody']['classification']>>,
  Expect<Equal<ReviewAgreement['status'], S['ReviewAgreement']['status']>>,
  Expect<Equal<keyof GetQuery<'/api/metrics/auto-close-review'>, 'window'>>,
  Expect<Equal<'review' extends keyof GetQuery<'/api/cases'> ? true : false, true>>,
];
