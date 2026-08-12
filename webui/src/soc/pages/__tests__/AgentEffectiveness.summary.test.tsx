import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { getAgentImprovementMock } = vi.hoisted(() => ({
  getAgentImprovementMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getAgentImprovement: getAgentImprovementMock,
    },
  };
});

import type {
  AgentComparisonMetric,
  AgentImprovementDailyPoint,
  AgentImprovementEvidence,
  AgentOperationalOutcomes,
} from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { AgentEffectivenessSummary } from '../AgentEffectiveness';

function metric({
  label,
  unit,
  current,
  baseline,
  sample = 30,
  direction = 'improving',
}: {
  label: string;
  unit: 'ratio' | 'minutes';
  current: number | null;
  baseline: number | null;
  sample?: number;
  direction?: AgentComparisonMetric['direction'];
}): AgentComparisonMetric {
  const available = current !== null && baseline !== null;
  return {
    label,
    unit,
    good_direction: label.includes('agreement') ? 'up' : 'down',
    current: {
      value: current,
      available: current !== null,
      status: current === null ? 'unavailable' : 'enough_data',
      reason: available ? 'Comparable source × severity mix.' : 'No eligible observations.',
      sample_count: sample,
      minimum_sample: 20,
    },
    baseline: {
      value: baseline,
      available: baseline !== null,
      status: baseline === null ? 'unavailable' : 'enough_data',
      reason: available ? 'Comparable source × severity mix.' : 'No eligible observations.',
      sample_count: sample + 50,
      minimum_sample: 20,
    },
    delta: unit === 'ratio' ? { percentage_points: 4 } : { relative: -0.2 },
    direction,
    definition: {
      formula: `${label} aggregate formula`,
      numerator: 'Eligible outcomes',
      denominator: 'Eligible cases',
      eligibility: 'Complete UTC days with comparable strata',
      caveats: 'Observed association only.',
    },
  };
}

function dailyPoints(): AgentImprovementDailyPoint[] {
  const start = Date.UTC(2026, 5, 23);
  return Array.from({ length: 35 }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const current = index >= 28;
    return {
      date,
      window: current ? 'current' : 'baseline',
      analyst_reported_agreement: current ? 0.78 + (index - 28) * 0.01 : 0.8,
      correction_rate: current ? 0.12 - (index - 28) * 0.005 : 0.12,
      false_negative_rate: 0.02,
      review_turnaround_p50_minutes:
        current && index === 29 ? null : current ? 50 - (index - 28) : 53,
      quality_sample_count: current ? 5 : 7,
      confirmed_positive_sample_count: 4,
      turnaround_sample_count: current && index === 29 ? 0 : 5,
      status: current && index === 29 ? 'collecting_evidence' : 'enough_data',
    };
  });
}

function operationalOutcomes(): AgentOperationalOutcomes {
  const definition = {
    formula: 'aggregate formula',
    numerator: 'Eligible current observations.',
    denominator: 'Eligible observations in the same window.',
    eligibility: 'Complete UTC windows.',
    caveats: 'Observed association only.',
  };
  return {
    recorded_case_cost: {
      label: 'Recorded case-associated AI cost',
      unit: 'USD',
      currency: 'USD',
      status: 'enough_data',
      reason: '',
      current: {
        total_cost: 18,
        call_count: 80,
        costed_cases: 40,
        cost_per_costed_case: 0.45,
        cost_per_day: 2.57,
      },
      baseline: {
        total_cost: 56,
        call_count: 240,
        costed_cases: 120,
        cost_per_costed_case: 0.47,
        cost_per_day: 2,
      },
      delta: { cost_per_day_relative: 0.285, cost_per_costed_case_relative: -0.043 },
      direction: 'down',
      cost_per_day_direction: 'up',
      definition,
    },
    observed_time_saved: {
      label: 'Observed elapsed-time difference',
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
      definition,
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
      definition,
    },
    true_positive_alert_yield: {
      label: 'True-positive alert yield',
      unit: 'ratio',
      status: 'unavailable',
      reason: 'No defensible alert-level outcome lineage.',
      current: {
        value: null,
        true_positive_alerts: null,
        total_alerts: 8_400,
        lineage_coverage: null,
      },
      baseline: {
        value: null,
        true_positive_alerts: null,
        total_alerts: 30_800,
        lineage_coverage: null,
      },
      delta: { percentage_points: null },
      direction: 'insufficient_evidence',
      supported_alternative: 'confirmed_positive_case_rate',
      definition,
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
      definition,
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
      definition,
    },
    source_guidance: {
      status: 'not_available',
      reason: 'Validated source-gap evidence is not persisted.',
      items: [],
      long_term_objective: true,
      required_evidence: 'A governed telemetry coverage model.',
    },
  };
}

function evidence(): AgentImprovementEvidence {
  return {
    generated_at: '2026-07-28T00:00:00Z',
    synthetic: false,
    windows: {
      as_of_exclusive: '2026-07-28',
      current: { start: '2026-07-21', end_exclusive: '2026-07-28', days: 7 },
      baseline: { start: '2026-06-23', end_exclusive: '2026-07-21', days: 28 },
      timezone: 'UTC',
      complete_days_only: true,
    },
    headline: {
      state: 'improving',
      reason: 'Quality and review turnaround improved without an evaluable guardrail breach.',
      improving_signals: 2,
      regressing_signals: 0,
      signal_domains: {
        analyst_grade_quality: 'improving',
        human_review_turnaround: 'improving',
      },
      guardrails_ready: true,
      comparable_mix_coverage: 0.84,
      minimum_comparable_mix_coverage: 0.8,
      composite_score: null,
    },
    metrics: {
      analyst_reported_verdict_agreement: metric({
        label: 'Analyst-reported verdict agreement',
        unit: 'ratio',
        current: 0.84,
        baseline: 0.8,
      }),
      material_analyst_correction_rate: metric({
        label: 'Material analyst correction rate',
        unit: 'ratio',
        current: 0.08,
        baseline: 0.12,
      }),
      human_review_turnaround: metric({
        label: 'Human review turnaround',
        unit: 'minutes',
        current: 42,
        baseline: 53,
        sample: 24,
      }),
    },
    guardrails: {
      confirmed_false_negative_rate: {
        status: 'enough_data',
        minimum_sample: 20,
        current: { value: 0.02, confirmed_positive_count: 40, missed_positive_count: 1 },
        baseline: { value: 0.02, confirmed_positive_count: 100, missed_positive_count: 2 },
        material_increase_threshold: 0.01,
        breached: false,
        definition: 'Missed confirmed positives divided by confirmed positives.',
      },
      reopen_after_agent_close_rate: {
        status: 'not_applicable',
        minimum_sample: 20,
        current: {
          candidate_agent_terminal_decisions: 0,
          eligible_agent_terminal_decisions: 0,
          right_censored_decisions: 0,
          human_reopens: 0,
          rate: null,
          follow_up_hours: 24,
        },
        baseline: {
          candidate_agent_terminal_decisions: 0,
          eligible_agent_terminal_decisions: 0,
          right_censored_decisions: 0,
          human_reopens: 0,
          rate: null,
          follow_up_hours: 24,
        },
        material_increase_threshold: 0.02,
        breached: null,
        caveat: 'Only complete follow-up windows are eligible.',
      },
    },
    case_mix: {
      dimensions: ['source', 'severity'],
      minimum_per_stratum: 5,
      baseline_total: 90,
      current_total: 35,
      baseline_covered: 80,
      current_covered: 30,
      comparable_mix_coverage: 0.84,
      baseline_mix_coverage: 0.89,
      current_mix_coverage: 0.86,
      comparable_strata: 6,
      baseline_only_strata: 1,
      current_only_strata: 0,
      suppressed_strata: 1,
      adjusted_baseline_agreement: 0.8,
      adjusted_current_agreement: 0.84,
      adjusted_baseline_correction_rate: 0.12,
      adjusted_current_correction_rate: 0.08,
    },
    daily_points: dailyPoints(),
    exclusions: { missing_grade: 2 },
    provenance: {
      truncated: true,
      store_total: 100,
      fetched: 80,
      aggregate_only: true,
      case_ids_included: false,
      billing: 'none',
      decision_authority: 'reporting_only',
    },
  };
}

function renderSummary(props?: {
  refreshKey?: number;
  onOpenFull?: () => void;
  changes?: Array<{
    id: string;
    at?: string | null;
    label: string;
    detail: string;
    state?: 'active' | 'rolled_back';
  }>;
}) {
  return render(
    <TooltipProvider>
      <AgentEffectivenessSummary
        refreshKey={props?.refreshKey}
        changes={props?.changes}
        onOpenFull={props?.onOpenFull ?? vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe('AgentEffectivenessSummary', () => {
  beforeEach(() => {
    getAgentImprovementMock.mockReset();
    getAgentImprovementMock.mockResolvedValue(evidence());
  });

  it('shows verified comparisons, exact evidence boundaries, and distinct guardrail states', async () => {
    const onOpenFull = vi.fn();
    const view = renderSummary({
      onOpenFull,
      changes: [
        {
          id: 'change-current',
          at: '2026-07-24T03:00:00Z',
          label: 'rare-login-rule',
          detail: 'Correlation threshold 2 → 3',
          state: 'active',
        },
        {
          id: 'change-old',
          at: '2026-06-01T03:00:00Z',
          label: 'outside-window-rule',
          detail: 'Severity floor 1 → 2',
          state: 'rolled_back',
        },
      ],
    });

    expect(await screen.findByText('Observed outcomes')).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Observed outcomes' });
    expect(summary).toHaveClass('border-y');
    expect(summary.className).not.toMatch(/rounded|shadow|bg-card/);
    expect(screen.getByRole('heading', { name: 'Observed outcomes', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Analyst-reported verdict agreement')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('comparison-tuning-agent-agreement')).getByText('84.0%'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('28-day baseline')).toHaveLength(3);
    expect(screen.getByText(/Current Jul 21–27, 2026/)).toHaveTextContent(
      /baseline Jun 23–Jul 20, 2026/,
    );
    expect(screen.getByText('Daily trajectory')).toBeInTheDocument();
    expect(screen.getByText('Analyst-reported agreement')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Correction' }));
    expect(
      screen.getByRole('heading', { name: 'Material correction rate', level: 4 }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Review p50' }));
    expect(
      screen.getByRole('heading', { name: 'Human review turnaround', level: 4 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Raw daily cohorts/)).toBeInTheDocument();
    expect(screen.getByText(/Daily points use eligible cases/)).toHaveTextContent(
      /not source × severity adjusted/,
    );
    expect(screen.getByText('Confirmed false negatives').parentElement).toHaveTextContent(
      'Within threshold',
    );
    expect(screen.getByText('Reopens after agent close').parentElement).toHaveTextContent(
      'Not applicable',
    );
    fireEvent.click(screen.getByText('Applied changes in reporting window'));
    expect(screen.getByText('rare-login-rule')).toBeInTheDocument();
    expect(screen.getByText('Correlation threshold 2 → 3')).toBeInTheDocument();
    expect(screen.queryByText('outside-window-rule')).not.toBeInTheDocument();
    const missingDay = screen.getByRole('row', { name: /2026-07-22/ });
    expect(within(missingDay).getAllByText('—')).toHaveLength(1);
    expect(missingDay).not.toHaveTextContent('0 min');
    const dailyEvidenceTable = screen.getByRole('table', {
      name: 'Daily agent outcome evidence; unavailable values are not zero',
    });
    expect(dailyEvidenceTable.parentElement).toHaveClass('sr-only');
    expect(dailyEvidenceTable).not.toHaveClass('sr-only');
    const evidenceCoverage = screen.getByText('Case-history scan').parentElement;
    expect(evidenceCoverage).toHaveTextContent(/2 excluded/);
    expect(evidenceCoverage).toHaveTextContent(/1 strata suppressed/);
    expect(evidenceCoverage).toHaveTextContent(/80 of 100 cases scanned/);
    expect(screen.queryByText(/agent score/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View full evidence' }));
    expect(onOpenFull).toHaveBeenCalledTimes(1);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('uses the shared centered loading grammar without replacing its section geometry', () => {
    getAgentImprovementMock.mockReturnValue(new Promise(() => {}));
    const view = renderSummary();

    const summary = screen.getByRole('region', { name: 'Observed outcomes' });
    expect(summary).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading observed outcome evidence')).toBeInTheDocument();
    expect(
      view.container.querySelector('[data-loading-motion="indeterminate-ring"]'),
    ).toBeInTheDocument();
    expect(summary).toHaveClass('border-y');
  });

  it('keeps unavailable evidence explicit instead of rendering a favorable zero', async () => {
    const unavailable = evidence();
    unavailable.headline.state = 'insufficient_evidence';
    unavailable.metrics.human_review_turnaround = metric({
      label: 'Human review turnaround',
      unit: 'minutes',
      current: null,
      baseline: null,
      sample: 0,
      direction: 'insufficient_evidence',
    });
    getAgentImprovementMock.mockResolvedValue(unavailable);

    renderSummary();
    const comparison = await screen.findByTestId('comparison-tuning-agent-turnaround');
    expect(comparison).toHaveTextContent('Unavailable');
    expect(comparison).toHaveTextContent('—');
    expect(comparison).not.toHaveTextContent('0 min');
  });

  it('adds compact downstream volume and threshold context without claiming causation', async () => {
    const withOutcomes = evidence();
    withOutcomes.outcomes = operationalOutcomes();
    getAgentImprovementMock.mockResolvedValue(withOutcomes);

    renderSummary();

    const context = await screen.findByRole('region', {
      name: 'Downstream volume around threshold tuning',
    });
    expect(context).toHaveTextContent('1,200');
    expect(context).toHaveTextContent('140');
    expect(context).toHaveTextContent('2 applied');
    expect(context).toHaveTextContent(/not model fine-tuning/);
    expect(context).toHaveTextContent(/does not establish causation/);
  });

  it('contains an endpoint failure and leaves a retryable evidence section', async () => {
    getAgentImprovementMock.mockRejectedValue(new Error('metrics endpoint unavailable'));
    renderSummary();

    expect(await screen.findByText('Observed outcomes are unavailable')).toBeInTheDocument();
    expect(screen.getByText('metrics endpoint unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Tuning controls remain available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('preserves previous evidence when a parent-triggered refresh fails', async () => {
    const view = renderSummary({ refreshKey: 0 });
    const comparison = await screen.findByTestId('comparison-tuning-agent-agreement');
    expect(within(comparison).getByText('84.0%')).toBeInTheDocument();

    getAgentImprovementMock.mockRejectedValueOnce(new Error('refresh failed'));
    view.rerender(
      <TooltipProvider>
        <AgentEffectivenessSummary refreshKey={1} onOpenFull={vi.fn()} />
      </TooltipProvider>,
    );

    expect(await screen.findByText('Outcome refresh failed')).toBeInTheDocument();
    expect(within(comparison).getByText('84.0%')).toBeInTheDocument();
    await waitFor(() => expect(getAgentImprovementMock).toHaveBeenCalledTimes(2));
  });
});
