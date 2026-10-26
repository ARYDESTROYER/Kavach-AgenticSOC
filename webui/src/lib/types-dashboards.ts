/**
 * Round 14 dashboard contracts (SPEC §2.2, §4.4). Type-only: every declaration here
 * is erased at compile time, so importing this module costs the entry bundle nothing.
 *
 * Mirrors `backend/app/models.py` (`MetricsBreakdown*`, `DashboardLayout.default_window`
 * and `derived_from`, the `UserPrefs.misc` list keys). Keep the two in sync; the
 * generated `api-types.gen.ts` is the final authority once WP-B1 reconciles them.
 * Every key (a rule id, a source name, a technique name) is untrusted text the
 * Console renders as plain text (#9).
 */

/** The windows a board may start on (`DashboardLayout.default_window`). */
export type DashboardWindow = 'now-24h' | 'now-7d' | 'now-30d' | 'now-90d';

/** The three built-in boards (code-defined, never stored). */
export type BuiltinBoardId =
  | 'builtin:soc-operations'
  | 'builtin:detection-data-health'
  | 'builtin:executive-summary';

/** The landing page's library card id; it is a link to `#/overview` and cannot be hidden. */
export type BuiltinLandingId = 'builtin:cyber-defence-center';

export type BuiltinDashboardId = BuiltinBoardId | BuiltinLandingId;

/**
 * The `UserPrefs.misc` keys Round 14 adds (written through the existing
 * `PUT /api/prefs/user`). The server normalises both on load: `dashboards_hidden`
 * keeps at most 8 built-in ids (never the landing board), `dismissed_intros` at most
 * 50 notice ids; a value that is not a list is removed.
 */
export interface Round14PrefsMisc {
  /** Built-in boards hidden from the Dashboards library. Unknown ids are dropped on read. */
  dashboards_hidden?: string[];
  /** `Callout intro` notices this viewer dismissed (for example the runbook migration note). */
  dismissed_intros?: string[];
}

// --------------------------------------------------------------------------- //
// GET /api/metrics/breakdown (§4.4.2)
// --------------------------------------------------------------------------- //
export type BreakdownKind = 'cases' | 'usage';

/** `by` and `then` for `kind=cases`. */
export type BreakdownCaseField =
  | 'rule'
  | 'source'
  | 'severity'
  | 'status'
  | 'verdict'
  | 'closed_by'
  | 'assignee'
  | 'mitre_tactic'
  | 'mitre_technique';

/** `by` and `then` for `kind=usage` (gate `cost:view`). */
export type BreakdownUsageField = 'surface' | 'role' | 'model' | 'provider' | 'service_tier';

export type BreakdownField = BreakdownCaseField | BreakdownUsageField;

export type BreakdownBucket = 'hour' | 'day' | 'week';

export type BreakdownStatusGroup = 'open' | 'closed';

/**
 * Query of `GET /api/metrics/breakdown`. `window` takes the Round 12 window grammar
 * (`now-24h`, `now-7d`, `now-30d`, `all`, calendar tokens, ISO ranges); default
 * `now-7d`. `top` is 1 to 50 (default 10); the remainder is one exact `other` row.
 * With `status_group=open`, pass `window: 'all'` for "open now" figures.
 */
export interface MetricsBreakdownQuery {
  kind?: BreakdownKind;
  by: BreakdownField;
  then?: BreakdownField;
  window?: string;
  bucket?: BreakdownBucket;
  top?: number;
  /** Exact match on `Case.rule_ids`, 1 to 256 printable characters. */
  filter_rule?: string;
  status_group?: BreakdownStatusGroup;
}

/**
 * One breakdown row. Case metrics are numbers for `kind=cases` and `null` for
 * `kind=usage`; `calls` and `cost_usd` the other way round.
 *
 * Two families, never mixed on one surface:
 * - AI verdicts: `verdicted = verdict_tp + verdict_fp + verdict_needs_human`.
 * - Analyst outcome (analyst-policy closes excluded):
 *   `count = analyst_tp + analyst_fp + analyst_ungraded`.
 */
export interface MetricsBreakdownGroup {
  /** The `by` value; `null` is the empty group (for example the unassigned cases). */
  key: string | null;
  then_key: string | null;
  bucket: string | null;
  count: number;
  open_now: number | null;
  verdicted: number | null;
  verdict_tp: number | null;
  verdict_fp: number | null;
  verdict_needs_human: number | null;
  analyst_tp: number | null;
  analyst_fp: number | null;
  analyst_ungraded: number | null;
  calls: number | null;
  cost_usd: number | null;
}

/** The exact remainder past `top`. */
export interface MetricsBreakdownOther {
  count: number;
  groups: number;
  calls: number | null;
  cost_usd: number | null;
}

/** One zero-filled calendar bucket of a bucketed breakdown, in order. */
export interface MetricsBreakdownBucket {
  label: string;
  in_progress: boolean;
}

/**
 * `GET /api/metrics/breakdown`. `exact: false` with `partial: true` means a store
 * failure cut the scan: the figures are lower bounds and the widget says so.
 * `multi_valued` (rule, technique, tactic) means rows never sum to `total`.
 */
export interface MetricsBreakdown {
  kind: BreakdownKind;
  by: BreakdownField;
  then: BreakdownField | null;
  bucket: BreakdownBucket | null;
  status_group: BreakdownStatusGroup | null;
  window_label: string;
  window_from: string | null;
  window_to: string | null;
  total: number;
  exact: boolean;
  partial: boolean;
  partial_reason: string | null;
  multi_valued: boolean;
  groups: MetricsBreakdownGroup[];
  buckets: MetricsBreakdownBucket[];
  other: MetricsBreakdownOther | null;
}

/** Error codes of the breakdown endpoint, for the widget states. */
export type MetricsBreakdownErrorCode =
  | 'breakdown_bad_param'
  /** Row-level data scope is on (D16): "Hidden while row-level scope is on." */
  | 'breakdown_scope_unsupported';
