/**
 * Overview (Cyber Defence Center) — jest-axe accessibility smoke (Round-7 W1.A).
 *
 * The landing surface: a compact hero (one h1), a TRIMMED KPI strip of drill-down tiles,
 * named widget regions (autonomy split, response timing, connector health, case volume,
 * top signatures/entities), and the server-posture timing trio. It mixes headings,
 * regions, labelled tiles and status chips — a broad guard for heading order / region
 * labelling / non-color signalling / nested-interactive regressions. We render the real
 * <Overview/> with an offline-mocked api + posture fetch, wait for the KPI strip, and
 * assert exactly one h1 + no axe violations (all default rules, incl. heading-order +
 * nested-interactive).
 *
 * The Noise-Reduction funnel is intentionally NOT mocked here so the band self-omits: its
 * own a11y (nested-interactive + labels) is covered by `NoiseFunnel.test`. This keeps the
 * main-layout heading order (h1 → h2 groups) under full axe.
 *
 * Offline: no network, no #3 / runtime behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
  },
}));

import Overview from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c1', status: 'open', risk_score: 88, source_name: 'Elastic SIEM', entity: { type: 'ip', value: '10.0.0.1' } },
  { case_id: 'c2', status: 'needs_human', risk_score: 65, source_name: 'Wazuh', entity: { type: 'host', value: 'web-01' } },
  { case_id: 'c3', status: 'resolved', risk_score: 20, source_name: 'Elastic SIEM', entity: { type: 'user', value: 'alice' } },
] as unknown as Case[];

const METRICS: Metrics = {
  total_cases: 3, open_cases: 1, needs_human_cases: 1, closed_cases: 1,
  by_status: { open: 1, needs_human: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 1, none: 0 },
  persona_usage: {}, playbook_usage: {}, avg_risk_score: 57, mttr_minutes: 120,
  resolved_count: 1, cases_per_day: [],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE: PostureResponse = {
  window_hours: 24, generated_at: '2026-07-01T08:00:00Z', case_count: 3,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no case has received a first response yet' },
  },
  quality: {
    total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1, closure_vs_arrival: 0.33, backlog: 2 },
  sla: { enabled: true, evaluated: 2, response_breached: 1, response_at_risk: 1, resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 87.5, breaching: [] },
};

describe('Overview — a11y smoke (jest-axe)', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD' });
  });

  it('has exactly one h1 and no axe violations on the loaded command center', async () => {
    const { container } = render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-open-cases')).toBeInTheDocument(), {
      timeout: 5000,
    });
    // KPI numerals progressively upgrade from CountUp to the lazy motion number.
    // Wait through Testing Library's act-aware loop so the a11y snapshot represents
    // the settled strip and the Suspense completion cannot leak a React warning.
    await waitFor(
      () => {
        expect(within(screen.getByTestId('kpi-strip')).queryAllByTestId('count-up')).toHaveLength(0);
      },
      { timeout: 5000 },
    );
    // Exactly one page-level h1 (the hero title); widget groups are h2.
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });
});
