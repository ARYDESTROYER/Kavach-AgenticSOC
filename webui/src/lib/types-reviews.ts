/**
 * Round 15 auto-close review contract (SPEC D6.6, D6.12). Type-only: zero runtime bytes.
 *
 * Mirrors `backend/app/api/routes_auto_close_review.py` (`ReviewBody`, `ReviewResult`,
 * `AutoCloseReviewSummary`, `AutoCloseReviewMetrics` and its parts). A review never
 * changes a case's status, decider or disposition; agreement describes the sampled cases
 * only and is not an estimate of auto-close precision. Rule names and case numbers are
 * untrusted text rendered plain (#9).
 */

/** The reviewer's own answer, asked before the AI verdict is compared. */
export type ReviewClassification = 'true_positive' | 'false_positive' | 'benign' | 'unsure';

/** `GET /api/cases?review=`: the Review scope of the Case Manager queue. */
export type ReviewQueueState = 'pending' | 'completed' | 'disagreed' | 'expired';

/** `POST /api/cases/{id}/review` body. Ratings are above 0 and at most 1. */
export interface ReviewBody {
  classification: ReviewClassification;
  /** At most 1,000 characters. Kept as fenced, untrusted precedent text. */
  note?: string;
  accuracy?: number | null;
  reasoning_quality?: number | null;
  action_appropriateness?: number | null;
  /** Time from opening the review card to submitting it, 0 to 86,400,000. */
  elapsed_ms?: number | null;
}

/** The recorded review. `agrees` is null for "Unsure". */
export interface ReviewResult {
  agrees?: boolean | null;
  /** The caller holds `cases:close` and may reopen the case. */
  can_reopen?: boolean;
  /** The case was in the review sample (its grade is a review grade). */
  sampled?: boolean;
  review_id?: string | null;
}

/** One case's place in the sample: `none` when it was never sampled. */
export type CaseReviewSampleState = 'none' | 'pending' | 'completed' | 'expired';

/**
 * `GET /api/cases/{id}/review` (`cases:read`): what the case workspace needs for the
 * pending band, Start review and "Review this auto-close" (Round 15 WP7, D8.2).
 * `agent_closed` is the review endpoint's own rule (terminal, first decision record an
 * agent close); `can_record` says whether that endpoint would accept a review now, the
 * caller's grants aside.
 */
export interface CaseReviewState {
  case_id: string;
  agent_closed: boolean;
  state: CaseReviewSampleState;
  can_record: boolean;
  review_id?: string | null;
  sampled_at?: string | null;
  /** When a pending sample expires (null once it is completed). */
  expires_at?: string | null;
}

/** `GET /api/auto-close-review/summary`: the Review scope badge. */
export interface AutoCloseReviewSummary {
  enabled: boolean;
  pending: number;
  /** Disagreeing reviews whose case is still closed. */
  disagreed_open: number;
  sampled_today: number;
  daily_cap: number;
}

export interface ReviewMetricsWindow {
  token: string;
  label: string;
  tz: string;
  start?: string | null;
  end: string;
}

export interface ReviewAgreement {
  /** `insufficient` below `minimum` reviews: no rate and no interval. */
  status: 'ok' | 'insufficient';
  agreed: number;
  disagreed: number;
  reviews: number;
  minimum: number;
  rate?: number | null;
  /** The Wilson 95% interval, from `minimum` reviews. */
  interval?: { [key: string]: number } | null;
  statement: string;
}

export interface ReviewMissedThreat {
  case_id: string;
  case_number?: string;
  rule?: string;
  completed_at?: string;
}

export interface ReviewMissedThreats {
  count: number;
  cases?: ReviewMissedThreat[];
}

export interface ReviewRuleRow {
  rule: string;
  sampled: number;
  reviewed: number;
  agreed: number;
  disagreed: number;
}

export interface ReviewDuration {
  median?: number | null;
  reviews?: number;
}

export interface ReviewDayRow {
  day: string;
  eligible: number;
  sampled: number;
}

export interface ReviewEligible {
  count: number;
  complete: boolean;
}

/** `GET /api/metrics/auto-close-review`: the Agent effectiveness module. */
export interface AutoCloseReviewMetrics {
  window: ReviewMetricsWindow;
  enabled: boolean;
  sample_rate: number;
  daily_cap: number;
  per_rule_daily_cap: number;
  expiry_days: number;
  sampled: number;
  reviewed: number;
  pending: number;
  expired: number;
  unsure: number;
  agreement: ReviewAgreement;
  missed_threats: ReviewMissedThreats;
  by_rule: ReviewRuleRow[];
  /** Median time spent reviewing (client-measured). */
  time_spent_ms: ReviewDuration;
  /** Median time from sampled to reviewed. */
  time_to_review_ms: ReviewDuration;
  by_day: ReviewDayRow[];
  eligible: ReviewEligible;
  /** False when the ledger ring dropped samples this window may hold (the counts are then "at least"). */
  ledger_complete: boolean;
  statement: string;
  generated_at: string;
}
