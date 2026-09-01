/**
 * Co-located data layer for the Posture + MITRE-coverage views (Round 3 / Feature 5).
 *
 * These call the NEW server-side rollup endpoints introduced in Round 3 Wave 0-2.5
 * (the backend computes MTTA/MTTR/dwell percentiles, quality rates, aging buckets,
 * SLA attainment, and period-over-period deltas server-side — the UI no longer
 * derives them from a 200-case client sample). We use the low-level `api.get` helper
 * exported from `@/lib/api` rather than adding methods to the shared client, so this
 * builder stays parallel-safe.
 *
 * SECURITY (#9): every label/title/entity in these payloads is operator-/log-derived.
 * The consuming components render them as PLAIN text. The types below describe the
 * SHAPE only; they grant no trust.
 */
import { api, API_BASE } from '@/lib/api';

/** The labelled-DASH-or-number p50/p90/mean block from `_stat_block`. */
export interface StatBlock {
  /** number when available; the backend DASH string ("—") when not. */
  p50: number | string;
  p90: number | string;
  mean: number | string;
  max: number | string;
  count: number;
  available: boolean;
  /** Honest reason the block is unavailable (plain text). */
  reason: string;
}

export interface PostureLifecycle {
  mtta_minutes: StatBlock;
  mttr_minutes: StatBlock;
  dwell_minutes: StatBlock;
  /**
   * Mean-time-to-detect (real detection latency: the cluster's first event → case-open,
   * from the case's `first_seen_millis`). Additive + OPTIONAL so an older server / a
   * minimal test posture literal without it still type-checks; a labelled-DASH StatBlock
   * when no case carries a first-event instant. Advisory only (never #3).
   */
  mttd_minutes?: StatBlock;
}

export interface PostureQuality {
  /**
   * The AGENT-WORKED cohort size, NOT the window's arrival count. `quality_metrics`
   * strips operator "declared benign" analyst-policy closes before computing anything
   * here (no model ran on them, so counting them would deflate `automation_rate` and
   * inflate `containment_rate`), and reports them separately as `policy_closed_cases`.
   * Every rate in this block, and `terminal_cases` itself, is measured over this
   * narrowed population — so it is the only honest denominator for them. The window's
   * arrival cohort is the sibling `PostureResponse.case_count`, which is policy-
   * INCLUSIVE; mixing the two puts a numerator and a denominator on two different
   * populations.
   */
  total_cases: number;
  verdicted_cases: number;
  true_positive_cases: number;
  false_positive_cases: number;
  needs_human_cases: number;
  escalated_cases: number;
  terminal_cases: number;
  auto_closed_cases: number;
  /**
   * The rest of the LAST-WRITER `decision_by` partition of `terminal_cases`:
   * `auto_closed_cases` (agent) + `human_closed_cases` (analyst) +
   * `system_closed_cases` (deterministic SYSTEM routing plus legacy records with no
   * recorded provenance) === `terminal_cases`, exactly. `human_closed_cases` is NOT
   * `terminal_cases - auto_closed_cases`: that difference over-states human work by
   * absorbing the residual. Optional — older backends omit both, and their absence
   * means "close attribution not reported", never zero.
   */
  human_closed_cases?: number;
  system_closed_cases?: number;
  /**
   * Cases closed deterministically by an operator's analyst RULE POLICY ("declared
   * benign"). Stripped from `total_cases` and from every rate above — no model ran, so
   * they are not agent performance — and reported here so the volume stays visible. A
   * surface that counts "cases that reached a terminal state" wants
   * `terminal_cases + policy_closed_cases`.
   *
   * Optional: a backend that omits it is one that does not strip them either (the
   * exclusion and this field shipped together), so its `terminal_cases` already
   * includes them and the sum above is still exact.
   */
  policy_closed_cases?: number;
  alert_to_incident_ratio: number;
  false_positive_rate: number;
  escalation_rate: number;
  containment_rate: number;
  automation_rate: number;
}

export interface AgeBucket {
  bucket: string;
  count: number;
}

export interface OldestCaseRow {
  case_id: string;
  case_number: string;
  age_hours: number;
  status: string;
  risk_score: number | null;
}

export interface PostureAging {
  queue_depth: number;
  age_buckets: AgeBucket[];
  oldest: OldestCaseRow[];
  arrivals: number;
  closures: number;
  closure_vs_arrival: number;
  backlog: number;
}

export interface SlaBreachRow {
  case_id: string;
  case_number: string;
  priority: string;
  clock: string;
  state: 'breached' | 'at_risk' | string;
  elapsed_minutes: number;
  target_minutes: number;
  over_pct: number;
}

export interface PostureSla {
  enabled: boolean;
  evaluated?: number;
  reason?: string;
  response_breached?: number;
  response_at_risk?: number;
  resolve_breached?: number;
  resolve_at_risk?: number;
  attainment_pct?: number;
  breaching?: SlaBreachRow[];
}

/** One `_compare_block`: a metric value, its prior-window value, and the delta%. */
export interface CompareBlock {
  /** number, or the backend DASH string. */
  value: number | string;
  prev: number | string;
  /**
   * Period-over-period delta percent. number = a real delta; the DASH string when
   * undefined; `null` = "new growth" (prior was 0, current is not).
   */
  delta_pct: number | string | null;
}

export interface PostureCompare {
  mode: string;
  case_count: CompareBlock;
  alert_to_incident_ratio: CompareBlock;
  false_positive_rate: CompareBlock;
  escalation_rate: CompareBlock;
  automation_rate: CompareBlock;
  mttr_p50: CompareBlock;
  mtta_p50: CompareBlock;
}

/**
 * `severity_counts` (produced by the backend's `severity_band_counts()`) — a per-band
 * tally of the window's ARRIVAL COHORT, keyed by
 * the backend's own closed `constants.SEVERITY_BANDS` vocabulary (never a client-side
 * literal list). Every band is present and zero-filled, and the values sum EXACTLY to
 * `case_count`, so it is a partition of that population rather than a filtered subset.
 *
 * Optional: an older server omits it, and its ABSENCE means "not reported" — never
 * zero. It replaces the client-side band derivation over a bounded case page, which
 * silently reported a 200-row sample as a total.
 */
export type PostureSeverityCounts = Record<string, number>;

/**
 * `open_now` — the open-case STOCK measured at `generated_at` over the WHOLE fetched
 * set. Deliberately window-EXEMPT (`window_exempt: true` is on the wire for exactly
 * this reason): a case that arrived last month and is still open is on the queue
 * today, so this number must never be presented as summing or reconciling with the
 * windowed cohort tiles. `aging.queue_depth` is the cohort-scoped counterpart and is
 * a DIFFERENT number.
 *
 * `complete` is false when the fetch was truncated (the count is then a LOWER BOUND)
 * or when the case read FAILED outright, with `reason` naming which. `window_covered`
 * does NOT rescue it — its population is the fetch, not the window.
 */
export interface PostureOpenNow {
  count: number;
  window_exempt?: boolean;
  as_of?: string;
  complete?: boolean;
  reason?: string;
}

export interface PostureResponse {
  window_hours: number;
  generated_at: string;
  case_count: number;
  /** Partition of `case_count` by advisory severity band (sums to it exactly). */
  severity_counts?: PostureSeverityCounts;
  /** The window-EXEMPT open-case stock (see {@link PostureOpenNow}). */
  open_now?: PostureOpenNow;
  /** True when the server's bounded case scan omitted older store rows. */
  truncated?: boolean;
  /**
   * Whether the SELECTED WINDOW is fully answerable from the rows actually fetched.
   *
   * `truncated` alone is permanent for any deployment above the route's fetch bound,
   * so gating on it presents every posture number as a lower bound forever — true, and
   * useless. Cases are fetched newest-first, so a truncated fetch can only have dropped
   * rows OLDER than the oldest one read: when the window's cutoff is at or after that
   * floor, the window's numbers are COMPLETE even though the overall fetch was not.
   *
   * Emitted ALONGSIDE the truncation marker, never inside it. Absent on an older
   * server — a consumer then falls back to `truncated`.
   */
  window_covered?: boolean;
  /** Plain-text reason `window_covered` is false (empty when it is true). */
  window_coverage_reason?: string;
  /** ISO creation instant of the OLDEST fetched case (null when none is parseable). */
  oldest_fetched_at?: string | null;
  /** Total rows reported by the case store before the selected-window filter. */
  store_total?: number;
  /** Rows inspected before the selected-window filter. */
  fetched?: number;
  lifecycle: PostureLifecycle;
  quality: PostureQuality;
  aging: PostureAging;
  sla: PostureSla;
  compare?: PostureCompare;
}

/** One covered technique within a tactic column (id/name/case_count). */
export interface MitreTechnique {
  id: string;
  name: string;
  case_count: number;
}

export interface MitreTacticRollup {
  tactic: string;
  covered: number;
  total: number;
  coverage_pct: number;
  techniques: MitreTechnique[];
}

export interface MitreCoverageResponse {
  corpus_version: string;
  total_techniques: number;
  covered_techniques: number;
  coverage_pct: number;
  invalid_dropped: number;
  /** tactic-id → rollup. */
  by_tactic: Record<string, MitreTacticRollup>;
  top_techniques: MitreTechnique[];
  window_hours: number;
}

/** GET /api/metrics/posture?window_hours=&compare= */
export function fetchPosture(
  windowHours: number,
  compare: 'prev' | '' = '',
  signal?: AbortSignal,
): Promise<PostureResponse> {
  // Defer through Promise.resolve so a synchronous failure (e.g. a stubbed client)
  // surfaces as a rejection — callers wrap this in Promise.all/allSettled.
  return Promise.resolve().then(() =>
    api.get<PostureResponse>(
      'metrics/posture',
      { window_hours: windowHours, compare },
      signal,
    ),
  );
}

/** GET /api/mitre/coverage?window_hours= (0 = all cases). */
export function fetchMitreCoverage(windowHours = 0): Promise<MitreCoverageResponse> {
  return Promise.resolve().then(() =>
    api.get<MitreCoverageResponse>('mitre/coverage', { window_hours: windowHours }),
  );
}

/** The API prefix, read from the shared client so it stays correct if the API is ever
 *  served under a different prefix (not hard-coded '/api'). Guarded because a unit test
 *  may replace the WHOLE `@/lib/api` module and omit this const — accessing a missing
 *  named export throws under the mock, so we fall back to the conventional '/api'. In
 *  every real build `API_BASE` is defined and this never falls back. */
function apiBase(): string {
  try {
    return API_BASE || '/api';
  } catch {
    return '/api';
  }
}

/** The Navigator-layer export URL (served as a downloadable JSON document). Built from the
 *  shared API prefix ({@link apiBase}) instead of a hard-coded '/api'. */
export function navigatorLayerUrl(windowHours = 0): string {
  const q = windowHours > 0 ? `?window_hours=${encodeURIComponent(String(windowHours))}` : '';
  return `${apiBase()}/mitre/coverage/navigator.layer.json${q}`;
}
