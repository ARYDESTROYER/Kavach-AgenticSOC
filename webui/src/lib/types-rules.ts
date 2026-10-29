/**
 * Round 14 rule summary contract (SPEC §4.6.2). Type-only: zero runtime bytes.
 *
 * Mirrors `backend/app/models.py` `RuleSummary`. Each section carries its own status,
 * so the rule sheet degrades per section ("You do not have access to cases."). The
 * rule value and every IP, host, user and title are untrusted text rendered plain
 * (#9). The summary carries no raw log rows (#7): the sheet's latest alerts come
 * from `GET /api/logs?rule=` and are shown to the person only. The generated
 * `api-types.gen.ts` is the authority for these models, and a contract test pins this
 * mirror to it; `types.ts` re-exports every name here.
 */

export type SeverityLevel = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * `ok`; `forbidden` (missing grant); `unsupported` (no source can aggregate, the
 * figures are a newest-N sample, or row-level scope hides cases); `unavailable` (an
 * error, with a short `reason`).
 */
export type RuleSectionStatus = 'ok' | 'forbidden' | 'unsupported' | 'unavailable';

export interface RuleSummaryWindow {
  /** For example "Last 3 days". */
  label: string;
  /** ISO 8601 UTC. */
  from: string;
  to: string;
}

/** One time bucket of the rule's alerts, counted per named level. */
export interface RuleSeverityPoint {
  t: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface RuleSeveritySeries {
  /** Bucket width, for example "12h". */
  bucket: string;
  /** Always all five, in display order: critical, high, medium, low, info. */
  levels: SeverityLevel[];
  points: RuleSeverityPoint[];
}

export interface RuleSummarySource {
  id: string;
  name: string;
  /** `false`: counted from a bounded newest-N sample, not filtered exactly. */
  exact: boolean;
}

export interface RuleSummaryAlerts {
  status: RuleSectionStatus;
  reason: string | null;
  count: number | null;
  /**
   * `gte` when any source was sampled. The sheet then reads "Open in Logs" with no
   * number, so the button never names a count Logs may not show.
   */
  count_relation: 'eq' | 'gte';
  first_seen: string | null;
  last_seen: string | null;
  series: RuleSeveritySeries | null;
  sources: RuleSummarySource[];
}

export interface RuleTopRow {
  value: string;
  /** For top targets: `host` or `user`. */
  kind: string | null;
  count: number;
}

/** A bounded top list (at most 10 rows). */
export interface RuleSummaryTopList {
  status: RuleSectionStatus;
  reason: string | null;
  rows: RuleTopRow[];
  exact: boolean;
}

/** The analyst-outcome family only; never the AI verdict family. */
export interface RuleCaseOutcomes {
  analyst_tp: number;
  analyst_fp: number;
  analyst_ungraded: number;
}

export interface RuleCaseRow {
  case_id: string;
  case_number: string;
  title: string;
  status: string;
  verdict: string | null;
}

export interface RuleSummaryCases {
  status: RuleSectionStatus;
  reason: string | null;
  count: number | null;
  open_now: number | null;
  outcomes: RuleCaseOutcomes | null;
  /** At most 5, newest first. */
  latest: RuleCaseRow[];
}

/** A suite detection rule's summary ("Rule settings" links to it). */
export interface RuleSuiteDefinition {
  name: string;
  enabled: boolean;
  description: string;
  mitre: string[];
  priority: number | null;
}

export interface RuleSummaryDefinition {
  status: RuleSectionStatus;
  reason: string | null;
  /** `source` reads "Defined in the source SIEM" (no settings link). */
  kind: 'suite' | 'source' | null;
  suite_rule: RuleSuiteDefinition | null;
}

export interface RuleSummaryTuning {
  status: RuleSectionStatus;
  reason: string | null;
  wilson_lower_bound: number | null;
  samples: number | null;
  proposed_change: Record<string, unknown> | null;
  last_tuned: string | null;
}

export interface RuleSummaryAnalystPolicy {
  status: RuleSectionStatus;
  reason: string | null;
  /** `null` reads "No analyst policy applies." */
  policy: Record<string, unknown> | null;
}

/** `GET /api/rules/summary`. */
export interface RuleSummary {
  rule: string;
  window: RuleSummaryWindow;
  alerts: RuleSummaryAlerts;
  top_source_ips: RuleSummaryTopList;
  top_targets: RuleSummaryTopList;
  cases: RuleSummaryCases;
  definition: RuleSummaryDefinition;
  tuning: RuleSummaryTuning;
  analyst_policy: RuleSummaryAnalystPolicy;
}

/** Query of `GET /api/rules/summary`. `window` defaults to `now-3d` or the opener's window. */
export interface RuleSummaryQuery {
  /** The exact rule value as shown (1 to 256 characters, one line). */
  rule: string;
  window?: string;
  source_id?: string;
}
