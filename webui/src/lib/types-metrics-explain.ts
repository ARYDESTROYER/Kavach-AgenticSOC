/**
 * Metric explanations (Round 16 SPEC §4.5 WP12; research explainability D-API-4, R9,
 * D10). Mirrors `GET /api/metrics/explain` (`engine.metrics.explain_metric`) and the
 * additive `GET /api/metrics` and posture fields that let a dashboard figure show its
 * inputs. Type-only: zero runtime bytes. Every case value is plain text (#9).
 */
import type { StatBlock } from '@/soc/pages/Metrics.posture.api';

/** The figures `GET /api/metrics/explain` answers for. */
export type ExplainedMetric =
  | 'mtta'
  | 'mttr'
  | 'dwell'
  | 'mttd'
  | 'active_risk_index'
  | 'fp_rate'
  | 'sla_attainment';

/** The deciders an MTTR sample is split by (`engine.metrics.MTTR_DECIDERS`). */
export type MttrDecider = 'agent' | 'analyst' | 'analyst_policy' | 'system' | 'unrecorded';

/** `mttr_by_decider`: one stat block per decider; the counts sum to the MTTR count. */
export type MttrByDecider = Partial<Record<MttrDecider, StatBlock>>;

/** One SLA clock of an explained case. */
export interface ExplainSlaClock {
  state: 'breached' | 'at_risk' | 'ok';
  elapsed_minutes: number;
  target_minutes: number;
  running: boolean;
  stop_source: string;
}

/** One case behind an explained figure. Which fields are set depends on the metric. */
export interface MetricExplainSample {
  case_id: string;
  case_number: string;
  status: string;
  /** The value this case contributes (minutes, a risk score, or 1 or 0 for a share). */
  value: number;
  /** Timings: the interval in minutes, its start and end, and the record each came from. */
  minutes?: number;
  start_at?: string | null;
  end_at?: string | null;
  start_anchor?: string;
  anchor?: string;
  decided_by?: MttrDecider;
  /** Shares: whether the case is counted in the numerator. */
  counted?: boolean;
  verdict?: string;
  created_at?: string;
  priority?: string;
  response?: ExplainSlaClock | null;
  resolution?: ExplainSlaClock | null;
}

/** `GET /api/metrics/explain?metric=&window_hours=`. */
export interface MetricExplainResponse {
  metric: ExplainedMetric;
  kind: 'timing' | 'mean' | 'ratio';
  unit: 'minutes' | 'score' | 'fraction' | 'percent';
  window_hours: number;
  /** "the last 24 hours", "the last 7 days" or "all time". */
  window: string;
  generated_at: string;
  population: string;
  population_size: number;
  headline: 'p50' | 'mean' | 'ratio';
  value: number | string | null;
  available: boolean;
  reason: string;
  /** Timings: the posture stat block for the window. */
  stat?: StatBlock;
  /** Means and shares: the sum or count on top, and the count below. */
  numerator?: number;
  denominator?: number;
  policy_closed?: number;
  by_decider?: MttrByDecider;
  /** How many cases the figure counts (a timing's stat block count). */
  sample_count: number;
  /** How many of them the caller may see (row-level data scope). */
  visible_count: number;
  hidden_by_scope: number;
  samples: MetricExplainSample[];
  /** The rank of the first listed sample (a long timing list is the run around the median). */
  samples_offset: number;
  samples_truncated: boolean;
  samples_order: string;
  /** Why no case rows are listed (the caller lacks `cases:read`), or "". */
  samples_withheld: string;
  truncated: boolean;
  store_total: number;
  fetched: number;
  case_population?: CasePopulationFreshness;
}

/** When an all-time population was read (`CasePopulation.freshness()`). */
export interface CasePopulationFreshness {
  read_at: string | null;
  age_seconds: number | null;
  stale: boolean;
}

/** The additive `GET /api/metrics` fields the Analytics tiles explain with. */
export interface MetricsExplainFields {
  /** MTTR as the lifecycle block (p50, p90, mean, count) over the analysed cases. */
  mttr_lifecycle?: StatBlock;
  mttr_by_decider?: MttrByDecider;
  /** When the analysed cases were read (an all-time population lives 60 s). */
  generated_at?: string;
  case_population?: CasePopulationFreshness;
}

/** The additive feedback fields (D10): the agreement rate's own population. */
export interface FeedbackAgreementFields {
  agreement_signals?: number;
  agreement_agreed?: number;
  agreement_partial?: number;
  agreement_disagreed?: number;
}
