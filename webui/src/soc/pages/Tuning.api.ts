/**
 * Co-located data layer for the adaptive-threshold TUNING admin surface
 * (Round 4 / Wave 4). Exposes the deterministic, no-LLM nightly tuner
 * (`backend/app/engine/threshold_tuner.py`) + its append-only audit/rollback ledger
 * (`backend/app/stores/tuning.py`) to an operator.
 *
 * Endpoints (all under `/api`, all gated `automation:read` / `automation:manage`):
 *   GET  /tuning/recommendations   — per-rule noise (Wilson-LB FP rate + counts) +
 *                                    the tuner's PROPOSED bounded change per rule
 *                                    (pure DRY-RUN — no write) + the applied ledger.
 *   GET  /tuning/config            — read Preferences.threshold_tuning.
 *   PUT  /tuning/config            — update Preferences.threshold_tuning (admin).
 *   POST /tuning/{rule_id}/apply   — recompute and process every current proposal for
 *                                    ONE rule. Review-first mode queues every change;
 *                                    confirmed auto-apply is an explicit policy opt-in.
 *   POST /tuning/{rule_id}/rollback — reverse the latest active auto-applied change.
 *
 * We use the low-level `api.get/post/put` verbs from `@/lib/api` rather than adding
 * methods to the shared client, so this builder stays parallel-safe.
 *
 * ⛔ HONEST FRAMING (#3): tuning ONLY moves detection-VOLUME knobs (a correlation
 * rule's `n`, a feed's `severity_floor`) that change WHICH candidates get
 * investigated — it NEVER sets a case status/disposition/verdict/risk and never calls
 * the deterministic `decide()`. A suppression DROP is never auto-applied; it becomes a
 * HITL Proposal linked to the Approvals queue.
 *
 * SECURITY (#9): every rule_id / feed key / error string here is operator-/log-derived
 * PLAIN data. The consuming components render it escaped (plain text / CodeBlock) and
 * it is never fed back into a prompt. The types below describe the SHAPE only.
 */
import { api } from '@/lib/api';

/** How often the nightly tuner runs (mirrors backend `ThresholdTuningConfig.cadence`). */
export type TuningCadence = 'hourly' | 'nightly' | 'weekly' | 'manual';

/**
 * The tuning policy (mirrors backend `config.ThresholdTuningConfig`). Default ON since
 * the Round-10 Autopilot overhaul — the tuner is a config-writer only (it never imports
 * `decide()`, #3): it observes per-rule FP rates and PROPOSES bounded, shadow-checked
 * changes. Review-first is the default, and a suppression DROP is always routed to
 * Approvals, never auto-applied.
 * Fields beyond the four the UI edits (`enabled`/`min_samples`/`fp_rate_target`/
 * `cadence`) are carried verbatim on round-trip so a PUT never drops the advanced knobs.
 */
export interface TuningConfig {
  enabled: boolean;
  min_samples: number;
  max_n_step: number;
  fp_rate_target: number;
  wilson_z: number;
  ewma_alpha: number;
  cadence: TuningCadence;
  shadow_eval: boolean;
  /** Review-first by default. When true, only independently analyst-confirmed,
   * shadow-safe bounded changes may be written without a proposal decision. */
  auto_apply_confirmed: boolean;
}

/**
 * A safe default matching the backend's Round-10 Autopilot defaults
 * (`config.ThresholdTuningConfig`): `enabled=True`, `min_samples=30` (Wilson-stable),
 * `fp_rate_target=0.10` (world-class SOC < 10% FP), `wilson_z=1.96` (0.95 lower bound),
 * `max_n_step=1` (bounded +1 nudge), mandatory `shadow_eval`. Used before the live
 * config loads and as the merge base on round-trip.
 */
export const DEFAULT_TUNING_CONFIG: TuningConfig = {
  enabled: true,
  min_samples: 30,
  max_n_step: 1,
  fp_rate_target: 0.1,
  wilson_z: 1.96,
  ewma_alpha: 0.2,
  cadence: 'nightly',
  shadow_eval: true,
  auto_apply_confirmed: false,
};

/** One observed rule's noise picture (from `_accumulate_rule_stats`). */
export interface RuleNoise {
  rule_id: string;
  /** All closed/resolved cases in which this normalized rule was observed. */
  observed?: number;
  total: number;
  /** Independently analyst-confirmed outcomes used by the tuner. */
  analyst_samples?: number;
  /** Observed cases excluded because no independent analyst outcome exists. */
  unconfirmed?: number;
  fp: number;
  tp: number;
  /** Wilson lower-bound FP rate (0..1). */
  fp_rate: number;
  volume_ewma: number | null;
  /** True when this rule has enough samples AND clears the FP-rate target. */
  over_target: boolean;
  /**
   * True when a `correlation_n` raise for this rule could NOT take effect, so the tuner
   * deliberately never drafts one. Without this an operator sees a rule flagged
   * `over_target` with no recommendation and no reason — the same silence that made the
   * original defect invisible. Additive; absent on an older backend.
   */
  correlation_n_inert?: boolean;
  /**
   * The machine reason code: `alerts_role_every_override` (every observed firing recorded
   * an effective mode=EVERY, which an alerts-role feed forces) · `correlation_mode_every`
   * (the rule is explicitly configured mode=EVERY, which never consults n) ·
   * `inline_rule_definition_correlation` (the rule's correlation is defined inline on its
   * rule definition, which takes precedence over the entry a raise would write).
   */
  correlation_n_inert_reason?: string;
  /** The backend's operator-readable sentence for that reason code (plain text). */
  correlation_n_inert_detail?: string;
}

/** One dry-run proposed bounded change for a rule. */
export interface TuningRecommendation {
  rule_id: string;
  /** "correlation_n" | "severity_floor" | "suppression". */
  kind: string;
  before: unknown;
  after: unknown;
  feed_key: string | null;
  source_id: string | null;
  feed_id: string | null;
  fp_rate: number;
  samples: number;
  analyst_samples?: number;
  observed_cases?: number;
  unconfirmed_cases?: number;
  confirmed_false_positives?: number;
  confirmed_true_positives?: number;
  /** False for a suppression DROP or a shadow-blocked raise (both need review). */
  auto_apply: boolean;
  /** True when a shadow-eval showed the change would have hidden a true positive. */
  shadow_blocked: boolean;
  /** Stable backend reason code explaining review, evidence, or auto-apply eligibility. */
  reason: string;
}

/**
 * One applied/rolled-back ledger row (from `TuningStore.list()` → `TuningRecord.to_json()`).
 *
 * ⚠ BUG #12 CONTRACT: the backend serializes `rolled_back` (bool) + `rolled_back_at`
 * — it does NOT emit an `active` field. The prior UI read a non-existent `row.active`,
 * so EVERY row rendered the same state. Consumers MUST derive the real state from
 * `rolled_back` (see {@link isLedgerRowActive}); a row without `rolled_back:true` is
 * still active. `active` is kept OPTIONAL only for the apply-response shape (which does
 * echo it in tests) and is never trusted for the ledger render.
 */
export interface TuningLedgerRow {
  id: string;
  rule_id: string;
  target: string;
  before: unknown;
  after: unknown;
  /** True once the change has been reversed (the authoritative state field, #12). */
  rolled_back?: boolean;
  rolled_back_at?: string | null;
  applied_at?: string;
  /** Optional; only some producers set it. NOT authoritative — use {@link isLedgerRowActive}. */
  active?: boolean;
  actor?: string;
  reason?: string;
  rationale?: string;
  [k: string]: unknown;
}

/**
 * BUG #12: the real per-row lifecycle state. A ledger row is ACTIVE unless it has been
 * rolled back. We honour an explicit `rolled_back` flag / `rolled_back_at` timestamp
 * first (the authoritative backend fields), then fall back to an `active` flag if a
 * producer happens to set one. A row that carries none of these defaults to ACTIVE
 * (it was just applied).
 */
export function isLedgerRowActive(row: TuningLedgerRow): boolean {
  if (row.rolled_back === true) return false;
  if (row.rolled_back_at) return false;
  if (typeof row.active === 'boolean') return row.active;
  return true;
}

/** GET /api/tuning/recommendations — the whole dry-run picture + ledger. */
export interface TuningRecommendationsResponse {
  enabled: boolean;
  cadence: string;
  fp_rate_target: number;
  min_samples: number;
  /** The z of the Wilson lower bound behind every `fp_rate` (absent from an older server: 1.96). */
  wilson_z?: number;
  auto_apply_confirmed: boolean;
  window_cases: number;
  rule_noise: RuleNoise[];
  recommendations: TuningRecommendation[];
  applied: TuningLedgerRow[];
  /** Whether the append-only tuning ledger could be read for this snapshot. */
  history_status?: 'available';
  /** Number of ledger rows included in this response. */
  history_count?: number;
}

export interface SchedulerWorkerHealth {
  enabled: boolean;
  gated: boolean;
  running: boolean;
  cadence: string;
  last_attempt_at: string;
  last_success_at: string;
  last_error: string;
  processed: number;
}

export interface SchedulerHealthResponse {
  scheduler_runtime_running: boolean;
  workers: Record<string, SchedulerWorkerHealth>;
}

export interface TelemetrySourceRecommendation {
  field: string;
  source_type: string;
  source_label: string;
  benefit: string;
  affected_case_count: number;
  case_ids: string[];
  evidence: Array<{ result: string; query: string }>;
}

export interface TelemetryRecommendationsResponse {
  status: 'available' | 'not_available';
  recommendations: TelemetrySourceRecommendation[];
  scanned_cases: number;
  truncated: boolean;
  evidence_schema: string;
  /** Whether the running build can currently persist controlled query-gap evidence. */
  capture_status?: 'available' | 'not_available';
  /** Precise reason capture is unavailable; never replaced by connector inference. */
  capture_not_available_reason?: string;
  not_available_reason: string;
}

/** POST /api/tuning/{rule}/apply outcome. */
export interface TuningApplyResponse {
  ok: boolean;
  rule_id: string;
  applied: TuningLedgerRow[];
  queued_proposals: Array<{ id: string; kind: string; status: string }>;
  shadow_blocked: string[];
}

export const tuningApi = {
  /** The dry-run per-rule noise + proposed changes + applied ledger. */
  recommendations: () =>
    api.get<TuningRecommendationsResponse>('tuning/recommendations'),
  /** Read the tuning policy. */
  getConfig: () => api.get<{ config: TuningConfig }>('tuning/config'),
  /** Update the tuning policy (admin). */
  putConfig: (config: TuningConfig) =>
    api.put<{ ok: boolean; config: TuningConfig }>('tuning/config', config),
  /** Recompute and process every current proposed change for ONE rule. */
  apply: (ruleId: string) =>
    api.post<TuningApplyResponse>(
      `tuning/${encodeURIComponent(ruleId)}/apply`,
    ),
  /** Reverse the latest active auto-applied change for a rule/feed key. */
  rollback: (ruleId: string) =>
    api.post<{ ok: boolean; rule_id: string; record_id: string }>(
      `tuning/${encodeURIComponent(ruleId)}/rollback`,
    ),
  /** Continuous-improvement worker health. Read-only and fail-soft in the page. */
  schedulerHealth: () =>
    api.get<SchedulerHealthResponse>('schedulers/health'),
  /** Query-backed telemetry gaps only; connector absence alone never creates a row. */
  sourceRecommendations: () =>
    api.get<TelemetryRecommendationsResponse>('tuning/source-recommendations'),
};

/** Human labels for the recommendation `kind`. */
export const KIND_LABELS: Record<string, string> = {
  correlation_n: 'Correlation threshold',
  severity_floor: 'Severity floor',
  suppression: 'Suppression (drop)',
};

/** Human labels for the recommendation `reason`. */
export const REASON_LABELS: Record<string, string> = {
  auto_apply_candidate: 'Safe to apply',
  shadow_eval_would_hide_tp: 'Shadow-eval blocked (would hide a true positive)',
  suppression_drop: 'Routes to Approvals (never auto-applied)',
};

/** Present a possibly-object before/after change value as a plain string. */
export function tuneValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * The OBSERVED false-positive rate for a rule = fp / total (a raw ratio, 0..1). This is
 * distinct from `RuleNoise.fp_rate`, which is the Wilson LOWER BOUND on that ratio (a
 * more conservative estimate). Returns 0 when there are no samples.
 */
export function observedFpRate(total: number, fp: number): number {
  return total > 0 ? fp / total : 0;
}

/**
 * The integer knob delta as a signed string ("+1" / "-1" / "0"), or null when either
 * side is not a finite number. The tuner only ever moves INTEGER knobs (a correlation
 * `n` or a 1..6 severity floor), so this is always an integer — never a decimal.
 */
export function tuneDelta(before: unknown, after: unknown): string | null {
  if (
    typeof before === 'number' &&
    typeof after === 'number' &&
    Number.isFinite(before) &&
    Number.isFinite(after)
  ) {
    const d = after - before;
    return d > 0 ? `+${d}` : String(d);
  }
  return null;
}
