/**
 * Overview — Agent health does NOT belong on the dashboard.
 *
 * The degradation strip used to mount here, handed the dashboard's own time window. It
 * moved into the notification bell (AppShell → NotificationBell), so a degradation is
 * visible from every route and a HEALTHY deployment spends zero dashboard space on it.
 *
 * This spec is the removal guard, and it is deliberately about behaviour rather than the
 * absence of a testid: the dashboard must render no health surface AND must issue no
 * health request, even when the api client exposes both endpoints. A second reader would
 * silently double the polling and re-introduce the strip's window-inheritance bug.
 *
 * Where the coverage went:
 *   - the reducer            → `soc/components/__tests__/health-degradation-signals.test.ts`
 *   - the bell's rendering   → `soc/components/__tests__/NotificationBell.health.test.tsx`
 *   - the shell's ownership  → `soc/__tests__/appshell.health.test.tsx`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));

vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock, diagnosticsMock, autoCloseMock, withHealth } =
  vi.hoisted(() => ({
    listCasesMock: vi.fn(),
    getMetricsMock: vi.fn(),
    usageMock: vi.fn(),
    diagnosticsMock: vi.fn(),
    autoCloseMock: vi.fn(),
    withHealth: { value: true },
  }));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    // Presence is the guard the page reads, so it must be toggleable per test.
    get diagnosticsHealth() {
      return withHealth.value ? diagnosticsMock : undefined;
    },
    get autoCloseHealth() {
      return withHealth.value ? autoCloseMock : undefined;
    },
  },
}));

import Overview from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

const CASES: Case[] = [
  {
    case_id: 'c1',
    status: 'open',
    risk_score: 88,
    source_name: 'Elastic SIEM',
    title: 'Unauthorized S3 access',
    entity: { type: 'ip', value: '10.0.0.1' },
  },
] as unknown as Case[];

const METRICS: Metrics = {
  total_cases: 1,
  open_cases: 1,
  needs_human_cases: 0,
  closed_cases: 0,
  by_status: { open: 1 },
  by_verdict: { TRUE_POSITIVE: 0, FALSE_POSITIVE: 0, NEEDS_HUMAN: 0, none: 1 },
  persona_usage: {},
  playbook_usage: {},
  avg_risk_score: 88,
  cases_per_day: [],
  burndown: [],
  timing_trend: [],
  feedback: {
    graded_cases: 0,
    feedback_count: 0,
    agreement_rate: 0,
    avg_accuracy: 0,
    avg_reasoning_quality: 0,
    avg_action_appropriateness: 0,
    time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-08-06T08:00:00Z',
  case_count: 1,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 1, available: true, reason: '' },
    mttr_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no resolution yet' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no first response yet' },
  },
  quality: {
    total_cases: 1, verdicted_cases: 0, true_positive_cases: 0, false_positive_cases: 0,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 0, auto_closed_cases: 0,
    alert_to_incident_ratio: 1, false_positive_rate: 0, escalation_rate: 0,
    containment_rate: 0, automation_rate: 0,
  },
  aging: { queue_depth: 1, age_buckets: [], oldest: [], arrivals: 1, closures: 0, closure_vs_arrival: 0, backlog: 1 },
  sla: { enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0, resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 100, breaching: [] },
};

describe('Overview — agent health is NOT a dashboard concern', () => {
  beforeEach(() => {
    withHealth.value = true;
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    diagnosticsMock.mockReset();
    autoCloseMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 0, total_tokens: 0, call_count: 0, currency: 'USD' });
  });

  it('renders no health surface even when BOTH endpoints are exposed', async () => {
    render(<Overview onNavigate={vi.fn()} />);

    expect(await screen.findByTestId('page-hero')).toBeInTheDocument();
    expect(screen.queryByTestId('health-degradation-section')).toBeNull();
    expect(screen.queryByRole('alert', { name: /agent health/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /view effectiveness/i })).toBeNull();
  });

  it('issues no health request of its own, so the shell stays the single reader', async () => {
    render(<Overview onNavigate={vi.fn()} />);

    await screen.findByTestId('page-hero');
    expect(diagnosticsMock).not.toHaveBeenCalled();
    expect(autoCloseMock).not.toHaveBeenCalled();
  });

  it('still renders when the client exposes neither endpoint', async () => {
    withHealth.value = false;

    render(<Overview onNavigate={vi.fn()} />);

    expect(await screen.findByTestId('page-hero')).toBeInTheDocument();
    expect(diagnosticsMock).not.toHaveBeenCalled();
    expect(autoCloseMock).not.toHaveBeenCalled();
  });
});
