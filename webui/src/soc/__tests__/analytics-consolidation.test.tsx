/**
 * Analytics consolidation (Round 4 / #10 declutter) render test.
 *
 * The reporting surfaces used to be split four ways (Metrics operational / Cost /
 * Overview KPIs / Standup) behind a double tab strip. They now live under ONE strip
 * owned by the Metrics page:
 *
 *   Operational | Performance | Posture | Effectiveness | Cost
 *
 * with Cost folded in as the SINGLE spend home. This spec asserts:
 *   1. all five tabs render in one strip (no double strip),
 *   2. the Cost tab shows the spend ledger (the former standalone Cost page, hosted),
 *   3. the Operational tab no longer owns the full cost view (LLM spend moved) but
 *      keeps a compact pointer into the Cost tab, and
 *   4. `onTabChange` fires so the host can mirror the tab into the route opts.
 *
 * Fully offline — only the data calls (posture + usage + metrics) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
}));

vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return {
    ...actual,
    fetchPosture: fetchPostureMock,
    fetchMitreCoverage: fetchMitreMock,
  };
});

vi.mock('@/soc/components/HealthDiagnostics', () => ({
  HealthDiagnostics: ({ windowHours }: { windowHours?: number }) => (
    <section data-testid="analytics-health-diagnostics">health:{windowHours}</section>
  ),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getMetrics: vi.fn().mockResolvedValue({
      total_cases: 8,
      open_cases: 3,
      needs_human_cases: 1,
      closed_cases: 5,
      by_status: {},
      by_verdict: { TRUE_POSITIVE: 2, FALSE_POSITIVE: 4, NEEDS_HUMAN: 1, none: 1 },
      by_disposition: {},
      persona_usage: {},
      playbook_usage: {},
      avg_risk_score: 40,
      mttr_minutes: 90,
      resolved_count: 5,
      cases_per_day: [],
      feedback: {
        graded_cases: 0, feedback_count: 0, agreement_rate: 0,
        avg_accuracy: 0, avg_reasoning_quality: 0, avg_action_appropriateness: 0,
        time_saved_minutes: 0, outcome_distribution: {},
      },
      retrieval_history: {
        status: 'unavailable', available: false,
        reason: '3 investigated cases have unavailable historical retrieval instrumentation.',
        loaded_cases: 8, total_cases: 8, truncated: false, eligible_cases: 7,
        history_available_cases: 4, history_unavailable_cases: 3,
        completed_attempt_cases: 2, cases_with_references: null,
        reference_coverage: null,
        formula: 'cases with references / completed retrieval attempts',
      },
      // The compact Operational spend pointer reads these; the FULL ledger is the Cost tab.
      cost: { total_cost: 1.23, total_tokens: 45000, call_count: 12, currency: 'USD' },
    }),
    ragStats: vi.fn().mockResolvedValue(null),
    getMemory: vi.fn().mockResolvedValue(null),
    getAgentImprovement: vi.fn().mockResolvedValue({
      generated_at: '2026-07-28T00:00:00Z',
      synthetic: false,
      windows: {
        as_of_exclusive: '2026-07-28',
        current: { start: '2026-07-21', end_exclusive: '2026-07-28', days: 7 },
        baseline: { start: '2026-06-23', end_exclusive: '2026-07-21', days: 28 },
        timezone: 'UTC', complete_days_only: true,
      },
      headline: {
        state: 'insufficient_evidence',
        reason: 'Complete comparable cohorts are required before declaring improvement.',
        improving_signals: 0, regressing_signals: 0, guardrails_ready: false,
        comparable_mix_coverage: 0, minimum_comparable_mix_coverage: 0.8,
        composite_score: null,
        signal_domains: {
          analyst_grade_quality: 'insufficient_evidence',
          human_review_turnaround: 'insufficient_evidence',
        },
      },
      metrics: Object.fromEntries([
        ['analyst_reported_verdict_agreement', ['Analyst-reported verdict agreement', 'ratio', 'up']],
        ['material_analyst_correction_rate', ['Material analyst correction rate', 'ratio', 'down']],
        ['human_review_turnaround', ['Human review turnaround', 'minutes', 'down']],
      ].map(([key, [label, unit, good_direction]]) => [key, {
        label, unit, good_direction,
        current: { value: null, available: false, status: 'unavailable', reason: 'No eligible observations.', sample_count: 0, minimum_sample: 20 },
        baseline: { value: null, available: false, status: 'unavailable', reason: 'No eligible observations.', sample_count: 0, minimum_sample: 20 },
        delta: {}, direction: 'insufficient_evidence',
        definition: { formula: 'aggregate formula', numerator: 'eligible outcomes', denominator: 'eligible cases', eligibility: 'complete UTC days', caveats: 'Observed outcomes only.' },
      }])),
      guardrails: {
        confirmed_false_negative_rate: {
          status: 'unavailable', minimum_sample: 20,
          current: { value: null, confirmed_positive_count: 0, missed_positive_count: 0 },
          baseline: { value: null, confirmed_positive_count: 0, missed_positive_count: 0 },
          material_increase_threshold: 0.01, breached: null,
          definition: 'Missed confirmed positives divided by confirmed positives.',
        },
        reopen_after_agent_close_rate: {
          status: 'not_applicable', minimum_sample: 20,
          current: { candidate_agent_terminal_decisions: 0, eligible_agent_terminal_decisions: 0, right_censored_decisions: 0, human_reopens: 0, rate: null, follow_up_hours: 24 },
          baseline: { candidate_agent_terminal_decisions: 0, eligible_agent_terminal_decisions: 0, right_censored_decisions: 0, human_reopens: 0, rate: null, follow_up_hours: 24 },
          material_increase_threshold: 0.02, breached: null,
          caveat: 'Only complete 24-hour follow-up windows are eligible.',
        },
      },
      case_mix: {
        dimensions: ['source', 'severity'], minimum_per_stratum: 5,
        baseline_total: 0, current_total: 0, baseline_covered: 0, current_covered: 0,
        comparable_mix_coverage: 0, baseline_mix_coverage: 0, current_mix_coverage: 0,
        comparable_strata: 0, baseline_only_strata: 0, current_only_strata: 0,
        suppressed_strata: 0, adjusted_baseline_agreement: null,
        adjusted_current_agreement: null, adjusted_baseline_correction_rate: null,
        adjusted_current_correction_rate: null,
      },
      daily_points: [], exclusions: {},
      provenance: { truncated: false, store_total: 0, fetched: 0, aggregate_only: true, case_ids_included: false, billing: 'none', decision_authority: 'reporting_only' },
    }),
    // The Cost tab (embedded) reads this ONE ledger endpoint.
    usageSummary: vi.fn().mockResolvedValue({
      total_cost: 1.23,
      total_tokens: 45000,
      call_count: 12,
      today_cost: 0.5,
      currency: 'USD',
      cost_over_time: [{ cost: 0.4 }, { cost: 0.83 }],
      by_model: [{ key: 'claude-x', cost: 1.23, tokens: 45000, calls: 12 }],
      by_role: [],
      by_surface: [],
      top_cost_drivers: [],
    }),
    // Presence preserves the older-proxy typeof guard and mounts the relocated
    // diagnostics surface. The component itself is isolated above.
    diagnosticsHealth: vi.fn(),
    autoCloseHealth: vi.fn(),
  },
}));

import Metrics from '../pages/Metrics';
import type { PostureResponse } from '../pages/Metrics.posture.api';

const POSTURE: PostureResponse = {
  window_hours: 168,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 8,
  lifecycle: {
    mtta_minutes: { p50: 30, p90: 90, mean: 45, max: 150, count: 6, available: true, reason: '' },
    mttr_minutes: { p50: 90, p90: 300, mean: 150, max: 500, count: 5, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no first response yet' },
  },
  quality: {
    total_cases: 8, verdicted_cases: 7, true_positive_cases: 2, false_positive_cases: 4,
    needs_human_cases: 1, escalated_cases: 1, terminal_cases: 5, auto_closed_cases: 2,
    alert_to_incident_ratio: 0.25, false_positive_rate: 0.5, escalation_rate: 0.12,
    containment_rate: 0.6, automation_rate: 0.4,
  },
  aging: {
    queue_depth: 3, age_buckets: [], oldest: [], arrivals: 8, closures: 5,
    closure_vs_arrival: 0.6, backlog: 3,
  },
  sla: { enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0, resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 0, breaching: [], reason: 'off' },
  compare: undefined,
};

describe('Analytics consolidation (Round 4 / #10)', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    fetchMitreMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    fetchMitreMock.mockResolvedValue(null);
  });

  it('renders ONE tab strip: Operational | Performance | Posture | Effectiveness | Cost', async () => {
    render(<Metrics embedded />);
    // Anchor on the stable per-id tab testids (reword-proof) while KEEPING the
    // accessible role+name checks (a tab that drops its label still fails).
    await waitFor(() =>
      expect(screen.getByTestId('metrics-tab-operational')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('metrics-tab-performance')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-tab-posture')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-tab-effectiveness')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-tab-cost')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /operational/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /performance/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /posture/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /effectiveness/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^cost$/i })).toBeInTheDocument();
    // Exactly five SECTION tabs in the metrics strip — no double strip / phantom
    // tab. Scoped to the metrics TabsList; the inline window/sort SegmentedControls
    // (now radiogroups, role="radio") in the same row can't inflate a role="tab" count.
    const strip = screen.getByTestId('metrics-tabs');
    expect(within(strip).getAllByRole('tab')).toHaveLength(5);
  });

  it('shows unavailable retrieval history without fabricating zero coverage', async () => {
    render(<Metrics embedded />);

    expect(await screen.findByText('Knowledge reference coverage')).toBeInTheDocument();
    expect(
      screen.getByText(/3 investigated cases have unavailable historical retrieval instrumentation/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/4 of 7 investigated cases/i)).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText(/retrieval quality/i)).toBeNull();
  });

  it('keeps the time window and refresh ahead of contextual sort controls', async () => {
    render(<Metrics embedded />);

    const controls = await screen.findByRole('group', { name: 'Analytics controls' });
    const primary = controls.querySelector('[data-controlbar-slot="primary"]') as HTMLElement;
    const secondary = controls.querySelector('[data-controlbar-slot="secondary"]') as HTMLElement;

    expect(within(primary).getByRole('radiogroup', { name: 'Time window' })).toBeInTheDocument();
    expect(within(primary).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(
      within(secondary).getByRole('radiogroup', { name: 'Sort ranked breakdowns' }),
    ).toBeInTheDocument();
    expect(primary.nextElementSibling).toBe(secondary);
  });

  it('keeps weak evidence explicit and never invents an agent score', async () => {
    render(<Metrics embedded tab="effectiveness" />);
    await waitFor(() =>
      expect(screen.getByText(/not enough evidence to assess change/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/not a model-learning score/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent score/i)).not.toBeInTheDocument();
    expect(screen.getByText(/reporting only/i)).toBeInTheDocument();
  });

  it('places full Agent health above Effectiveness and follows its time selector', async () => {
    render(<Metrics embedded tab="effectiveness" />);

    const health = await screen.findByTestId('analytics-health-diagnostics');
    const effectiveness = await screen.findByTestId('agent-effectiveness');
    expect(health).toHaveTextContent('health:168');
    expect(
      health.compareDocumentPosition(effectiveness) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const controls = screen.getByRole('group', { name: 'Analytics controls' });
    await userEvent.click(within(controls).getByRole('radio', { name: '24h' }));
    expect(await screen.findByTestId('analytics-health-diagnostics')).toHaveTextContent(
      'health:24',
    );
  });

  it('Cost tab is the single spend home — shows the ledger controls + breakdown', async () => {
    render(<Metrics embedded />);
    // Scope the section-tab lookup to the metrics strip: the embedded Cost ledger's
    // own window/rank SegmentedControls are radiogroups (one segment labelled "Cost");
    // scoping to the real TabsList keeps the section-tab lookup unambiguous.
    await waitFor(() => expect(screen.getByTestId('metrics-tabs')).toBeInTheDocument());
    const costTabTrigger = () =>
      within(screen.getByTestId('metrics-tabs')).getByRole('tab', { name: /^cost$/i });
    await waitFor(() => expect(costTabTrigger()).toBeInTheDocument());
    await userEvent.click(costTabTrigger());

    // The embedded Cost ledger renders its own breakdowns (single cost home).
    await waitFor(() => expect(screen.getByText(/detailed cost ledger/i)).toBeInTheDocument());
    expect(screen.getByText(/by model/i)).toBeInTheDocument();
    // The verbatim model id renders as plain text (#9).
    expect(screen.getAllByText('claude-x').length).toBeGreaterThan(0);
  });

  it('Operational tab keeps a compact spend pointer INTO the Cost tab (no full cost view)', async () => {
    render(<Metrics embedded />);
    await waitFor(() => expect(screen.getByText(/verdict mix/i)).toBeInTheDocument());

    // The compact spend card + its jump control live on Operational...
    const jump = await screen.findByRole('button', { name: /cost tab/i });
    expect(jump).toBeInTheDocument();
    // ...but the full ledger does NOT (it lives only in the Cost tab).
    expect(screen.queryByText(/detailed cost ledger/i)).not.toBeInTheDocument();

    // Clicking the pointer switches to the Cost tab (and reveals the ledger).
    await userEvent.click(jump);
    await waitFor(() => expect(screen.getByText(/detailed cost ledger/i)).toBeInTheDocument());
  });

  it('fires onTabChange so the host can mirror the tab into the route opts', async () => {
    const onTabChange = vi.fn();
    render(<Metrics embedded onTabChange={onTabChange} />);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /posture/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('tab', { name: /posture/i }));
    expect(onTabChange).toHaveBeenCalledWith('posture');
  });

  it('honours a deep-link `tab` prop (host drives the active tab from the route)', async () => {
    render(<Metrics embedded tab="cost" />);
    // With tab='cost' the Cost ledger is active on first paint.
    await waitFor(() => expect(screen.getByText(/detailed cost ledger/i)).toBeInTheDocument());
    // Sanity: the Cost SECTION tab is selected. Scope to the metrics strip so the
    // embedded ledger's own "Cost"-labelled SegmentedControl segment isn't matched.
    const costTab = within(screen.getByTestId('metrics-tabs')).getByRole('tab', {
      name: /^cost$/i,
    });
    expect(costTab).toHaveAttribute('aria-selected', 'true');
  });

  it('restores the Effectiveness deep-link with diagnostics above its report', async () => {
    render(<Metrics embedded tab="effectiveness" />);

    const effectivenessTab = within(screen.getByTestId('metrics-tabs')).getByRole('tab', {
      name: /effectiveness/i,
    });
    expect(effectivenessTab).toHaveAttribute('aria-selected', 'true');
    const health = await screen.findByTestId('analytics-health-diagnostics');
    const report = await screen.findByTestId('agent-effectiveness');
    expect(
      health.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
