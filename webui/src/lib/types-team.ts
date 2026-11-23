/**
 * Round 15 Team activity (SPEC D3.10): the hand mirrors of `api/routes_team.py`'s
 * response models. Type-only (no runtime bytes), imported by the lazy Team activity page
 * and `lib/api-team.ts`, never by an entry module.
 */

/** A counted kind (SPEC D3.8): case work, then sign-ins. */
export type TeamKind =
  | 'acknowledged'
  | 'closed'
  | 'reopened'
  | 'escalated'
  | 'commented'
  | 'assigned'
  | 'screenshot_added'
  | 'reviewed'
  | 'runbook_step_done'
  | 'signed_in';

/** The seven stacked kinds of the per-day chart; the rest of the case work is `other`. */
export type TeamChartKind = 'closed' | 'acknowledged' | 'commented' | 'reviewed' | 'escalated' | 'reopened' | 'other';

/** The dispositions a close is split by. */
export type TeamCloseGroup = 'true_positive' | 'false_positive' | 'benign' | 'duplicate' | 'other';

/** The kinds a bulk action can write. */
export type TeamBulkKind = 'acknowledged' | 'closed' | 'reopened' | 'escalated' | 'assigned';

/** Who a row names (SPEC D3.9). */
export type TeamPersonKind = 'account' | 'environment' | 'demo' | 'deleted' | 'unattributed';

export interface TeamWindow {
  token: string;
  label: string;
  start: string | null;
  end: string;
}

export interface TeamReviews {
  completed: number;
  agreed: number;
  disagreed: number;
  unsure: number;
  /** Agreed plus disagreed (an unsure review is not an answer). */
  answered: number;
  /** Agreed over answered, only from 30 answered reviews. */
  agreement_rate: number | null;
  /** Median time spent on the review card, measured in the Console. */
  time_spent_median_ms: number | null;
  /** Median time from the case being picked for review to the review. */
  time_to_review_median_seconds: number | null;
}

export interface TeamDay<K extends string = string> {
  /** ISO date in the operator time zone. */
  date: string;
  counts: Record<K, number>;
}

export interface PersonActivity {
  /** The normalised username; empty for Not attributed. */
  key: string;
  username: string;
  display_name: string;
  role: string;
  active: boolean;
  kind: TeamPersonKind;
  counts: Record<TeamKind, number>;
  closed_by: Record<TeamCloseGroup, number>;
  bulk: Record<TeamBulkKind, number>;
  /** Only the days with something counted, oldest first. */
  daily: TeamDay<TeamKind>[];
  last_active: string | null;
  median_ack_seconds: number | null;
  ack_samples: number;
  reviews: TeamReviews;
}

export interface TeamTotals {
  people_active: number;
  counts: Record<TeamKind, number>;
  closed_by: Record<TeamCloseGroup, number>;
  bulk: Record<TeamBulkKind, number>;
  /** Every day of the window, zeros included. */
  daily: TeamDay<TeamChartKind>[];
  median_ack_seconds: number | null;
  ack_samples: number;
  ack_status: 'measured' | 'too_many_cases' | 'unavailable';
  reviews: TeamReviews;
}

/** `GET /api/team/activity`. */
export interface TeamActivity {
  window: TeamWindow;
  timezone: string;
  days: string[];
  people: PersonActivity[];
  team: TeamTotals;
  exact: boolean;
  partial_reason: 'row_limit' | 'store_limit' | null;
  scanned_rows: number;
  auth_enabled: boolean;
  rbac_enabled: boolean;
  demo: boolean;
  generated_at: string;
}

export interface TeamPerson {
  username: string;
  display_name: string;
  role: string;
  active: boolean;
  kind: 'account' | 'environment' | 'demo';
}

/** `GET /api/team/people`. */
export interface TeamPeople {
  people: TeamPerson[];
  auth_enabled: boolean;
  demo: boolean;
}

export interface TeamEvent {
  ts: string;
  kind: TeamKind;
  /** Server-worded. */
  label: string;
  case_id: string | null;
  case_number: string | null;
  /** Built from structured fields only (disposition, actions taken, review answer). */
  detail: string;
}

/** `GET /api/team/people/{username}/events`. */
export interface TeamEvents {
  username: string;
  window: TeamWindow;
  events: TeamEvent[];
  total: number;
  next_cursor: string | null;
  exact: boolean;
  partial_reason: 'row_limit' | 'store_limit' | null;
}
