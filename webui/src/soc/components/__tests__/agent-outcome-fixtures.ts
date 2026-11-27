/**
 * Shared fixtures for the operational outcome evidence (Agent effectiveness): the additive
 * `outcomes` contract, a week-over-week and a rolling-28-day period comparison, and the
 * evidence that carries them. Test-only data; no stored or real values.
 */
import type {
  AgentOperationalOutcomes as OutcomeContract,
  AgentPeriodComparison,
} from '@/lib/types';
import type { AgentImprovementEvidenceWithOutcomes } from '../AgentOperationalOutcomes';

export const DEFINITION = {
  formula: 'bounded aggregate formula',
  numerator: 'Eligible current observations.',
  denominator: 'Eligible observations in the same window.',
  eligibility: 'Complete UTC windows.',
  caveats: 'Observed association only.',
};

export function outcomes(): OutcomeContract {
  return {
    recorded_case_cost: {
      label: 'Recorded case-associated AI cost',
      unit: 'USD',
      currency: 'USD',
      status: 'enough_data',
      reason: '',
      current: {
        total_cost: 18.4,
        call_count: 80,
        costed_cases: 40,
        cost_per_costed_case: 0.46,
        cost_per_day: 2.628571,
      },
      baseline: {
        total_cost: 20,
        call_count: 88,
        costed_cases: 40,
        cost_per_costed_case: 0.5,
        cost_per_day: 0.714286,
      },
      delta: {
        cost_per_day_relative: 2.68,
        cost_per_costed_case_relative: -0.08,
      },
      direction: 'up',
      cost_per_day_direction: 'up',
      definition: DEFINITION,
    },
    observed_time_saved: {
      label: 'Estimated elapsed time avoided',
      unit: 'minutes',
      status: 'enough_data',
      reason: '',
      current: {
        status: 'enough_data',
        reason: '',
        human_owned_closure_p50_minutes: 52,
        agent_closed_p50_minutes: 18,
        observed_difference_minutes_per_case: 34,
        observed_aggregate_elapsed_difference_minutes: 680,
        estimated_total_minutes_saved: 680,
        human_owned_closure_count: 28,
        agent_closed_count: 20,
        analyst_reported_total_minutes_saved: 610,
        analyst_reported_sample_count: 18,
        minimum_sample_per_owner: 10,
      },
      baseline: {
        status: 'enough_data',
        reason: '',
        human_owned_closure_p50_minutes: 50,
        agent_closed_p50_minutes: 20,
        observed_difference_minutes_per_case: 30,
        observed_aggregate_elapsed_difference_minutes: 570,
        estimated_total_minutes_saved: 570,
        human_owned_closure_count: 30,
        agent_closed_count: 19,
        analyst_reported_total_minutes_saved: 500,
        analyst_reported_sample_count: 16,
        minimum_sample_per_owner: 10,
      },
      delta: { minutes_per_case: 4 },
      direction: 'stable',
      definition: DEFINITION,
    },
    confirmed_positive_case_rate: {
      label: 'Confirmed-positive share of evaluated cases',
      unit: 'ratio',
      status: 'enough_data',
      reason: '',
      current: {
        value: 0.12,
        available: true,
        status: 'enough_data',
        reason: '',
        sample_count: 60,
        minimum_sample: 30,
        confirmed_positive_cases: 7,
        outcome_evaluable_cases: 60,
      },
      baseline: {
        value: 0.1,
        available: true,
        status: 'enough_data',
        reason: '',
        sample_count: 70,
        minimum_sample: 30,
        confirmed_positive_cases: 7,
        outcome_evaluable_cases: 70,
      },
      delta: { percentage_points: 2 },
      direction: 'up',
      definition: DEFINITION,
    },
    true_positive_alert_yield: {
      label: 'True-positive alert yield',
      unit: 'ratio',
      status: 'unavailable',
      reason:
        'Analyst outcomes are persisted per case while durable volume is counted per alert; the current schema has no defensible alert-level outcome lineage.',
      current: {
        value: null,
        true_positive_alerts: null,
        total_alerts: 8_400,
        lineage_coverage: null,
      },
      baseline: {
        value: null,
        true_positive_alerts: null,
        total_alerts: 7_700,
        lineage_coverage: null,
      },
      delta: { percentage_points: null },
      direction: 'insufficient_evidence',
      supported_alternative: 'confirmed_positive_case_rate',
      definition: DEFINITION,
    },
    alert_volume: {
      label: 'Observed alert volume',
      unit: 'alerts',
      status: 'enough_data',
      reason: '',
      window_basis: 'complete_utc_days',
      current: {
        ingested_alerts: 8_400,
        after_clustering_alerts: 980,
        clustering_reduction_count: 7_420,
        clustering_reduction_rate: 0.8833,
        ingested_per_day: 1_200,
        after_clustering_per_day: 140,
      },
      baseline: {
        ingested_alerts: 30_800,
        after_clustering_alerts: 4_200,
        clustering_reduction_count: 26_600,
        clustering_reduction_rate: 0.8636,
        ingested_per_day: 1_100,
        after_clustering_per_day: 150,
      },
      delta: {
        ingested_per_day_relative: 0.091,
        after_clustering_per_day_relative: -0.067,
      },
      direction: 'down',
      ingested_direction: 'up',
      after_clustering_direction: 'down',
      definition: DEFINITION,
    },
    tuning_context: {
      label: 'Threshold-tuning context',
      status: 'enough_data',
      reason: '',
      current: { applied_changes: 2, rolled_back_changes: 0 },
      baseline: { applied_changes: 1, rolled_back_changes: 1 },
      delta: { applied_changes: 1 },
      direction: 'down',
      cooccurring_after_clustering_direction: 'down',
      causal_claim: false,
      model_fine_tuning_evidence: false,
      definition: DEFINITION,
    },
    source_guidance: {
      status: 'not_available',
      reason:
        'The current product does not persist validated source-gap-to-alert recommendation evidence.',
      items: [],
      long_term_objective: true,
      required_evidence:
        'A governed coverage model linking missing telemetry to alert-specific triage uncertainty.',
    },
  };
}

export function period(days: number, currentAgreement: number): AgentPeriodComparison {
  const compact = (
    current: number,
    baseline: number,
    direction: 'improving' | 'stable' | 'regressing' | 'up' | 'down',
  ) => ({
    status: 'enough_data' as const,
    reason: '',
    current,
    baseline,
    current_sample_count: 40,
    baseline_sample_count: 45,
    delta: current - baseline,
    direction,
  });
  const operational = outcomes();
  if (days === 7) {
    operational.recorded_case_cost.current.total_cost = 12.2;
    operational.recorded_case_cost.current.cost_per_day = 1.743;
    operational.recorded_case_cost.current.cost_per_costed_case = 0.61;
    operational.recorded_case_cost.baseline.total_cost = 11;
    operational.recorded_case_cost.baseline.cost_per_day = 1.571;
    operational.recorded_case_cost.baseline.cost_per_costed_case = 0.55;
    operational.recorded_case_cost.delta.cost_per_costed_case_relative = 0.109;
    operational.observed_time_saved.current.human_owned_closure_p50_minutes = 31;
    operational.observed_time_saved.current.agent_closed_p50_minutes = 20;
    operational.observed_time_saved.current.observed_difference_minutes_per_case = 11;
    operational.observed_time_saved.current.observed_aggregate_elapsed_difference_minutes = 220;
    operational.observed_time_saved.current.estimated_total_minutes_saved = 220;
    operational.observed_time_saved.baseline.human_owned_closure_p50_minutes = 29;
    operational.observed_time_saved.baseline.agent_closed_p50_minutes = 21;
    operational.observed_time_saved.baseline.observed_difference_minutes_per_case = 8;
    operational.observed_time_saved.baseline.observed_aggregate_elapsed_difference_minutes = 152;
    operational.observed_time_saved.baseline.estimated_total_minutes_saved = 152;
    operational.observed_time_saved.delta.minutes_per_case = 3;
    operational.alert_volume.current.after_clustering_alerts = 637;
    operational.alert_volume.current.clustering_reduction_count = 7_763;
    operational.alert_volume.current.clustering_reduction_rate = 0.9242;
    operational.alert_volume.current.after_clustering_per_day = 91;
    operational.alert_volume.baseline.after_clustering_alerts = 700;
    operational.alert_volume.baseline.clustering_reduction_count = 7_000;
    operational.alert_volume.baseline.clustering_reduction_rate = 0.9091;
    operational.alert_volume.baseline.after_clustering_per_day = 100;
    operational.alert_volume.delta.after_clustering_per_day_relative = -0.09;
  } else {
    operational.recorded_case_cost.current.total_cost = 29.2;
    operational.recorded_case_cost.current.cost_per_day = 1.043;
    operational.recorded_case_cost.current.cost_per_costed_case = 0.73;
    operational.recorded_case_cost.baseline.total_cost = 25.6;
    operational.recorded_case_cost.baseline.cost_per_day = 0.914;
    operational.recorded_case_cost.baseline.cost_per_costed_case = 0.64;
    operational.recorded_case_cost.delta.cost_per_costed_case_relative = 0.141;
    operational.observed_time_saved.current.human_owned_closure_p50_minutes = 45;
    operational.observed_time_saved.current.agent_closed_p50_minutes = 22;
    operational.observed_time_saved.current.observed_difference_minutes_per_case = 23;
    operational.observed_time_saved.current.observed_aggregate_elapsed_difference_minutes = 460;
    operational.observed_time_saved.current.estimated_total_minutes_saved = 460;
    operational.observed_time_saved.baseline.human_owned_closure_p50_minutes = 39;
    operational.observed_time_saved.baseline.agent_closed_p50_minutes = 24;
    operational.observed_time_saved.baseline.observed_difference_minutes_per_case = 15;
    operational.observed_time_saved.baseline.observed_aggregate_elapsed_difference_minutes = 285;
    operational.observed_time_saved.baseline.estimated_total_minutes_saved = 285;
    operational.observed_time_saved.delta.minutes_per_case = 8;
    operational.alert_volume.current.after_clustering_alerts = 2_016;
    operational.alert_volume.current.clustering_reduction_count = 31_584;
    operational.alert_volume.current.clustering_reduction_rate = 0.94;
    operational.alert_volume.current.after_clustering_per_day = 72;
    operational.alert_volume.baseline.after_clustering_alerts = 2_688;
    operational.alert_volume.baseline.clustering_reduction_count = 28_112;
    operational.alert_volume.baseline.clustering_reduction_rate = 0.9127;
    operational.alert_volume.baseline.after_clustering_per_day = 96;
    operational.alert_volume.delta.after_clustering_per_day_relative = -0.25;
  }

  return {
    label: days === 7 ? 'Week over week' : 'Rolling 28 days over prior 28 days',
    status: 'enough_data',
    reason: '',
    current: {
      start: days === 7 ? '2026-07-21' : '2026-06-30',
      end_exclusive: '2026-07-28',
      days,
    },
    baseline: {
      start: days === 7 ? '2026-07-14' : '2026-06-02',
      end_exclusive: days === 7 ? '2026-07-21' : '2026-06-30',
      days,
    },
    calendar_period: false,
    metrics: {
      analyst_reported_verdict_agreement: compact(currentAgreement, 0.8, 'improving'),
      material_analyst_correction_rate: compact(0.08, 0.12, 'improving'),
      human_review_turnaround: compact(42, 53, 'improving'),
      confirmed_positive_case_rate: compact(0.12, 0.1, 'up'),
    },
    outcomes: operational,
  };
}

export function evidence(): AgentImprovementEvidenceWithOutcomes {
  return {
    windows: {
      as_of_exclusive: '2026-07-28',
      current: { start: '2026-07-21', end_exclusive: '2026-07-28', days: 7 },
      baseline: { start: '2026-06-23', end_exclusive: '2026-07-21', days: 28 },
      timezone: 'UTC',
      complete_days_only: true,
    },
    headline: {
      signal_domains: {
        analyst_grade_quality: 'improving',
        human_review_turnaround: 'improving',
      },
    },
    outcomes: outcomes(),
    period_comparisons: {
      week_over_week: period(7, 0.84),
      month_over_month: period(28, 0.88),
    },
  } as AgentImprovementEvidenceWithOutcomes;
}
