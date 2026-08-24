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

export interface PostureResponse {
  window_hours: number;
  generated_at: string;
  case_count: number;
  /** True when the server's bounded case scan omitted older store rows. */
  truncated?: boolean;
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
