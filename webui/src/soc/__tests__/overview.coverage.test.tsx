/**
 * Overview — the "am I seeing everything?" ingest-coverage tile (Ask A5 surface).
 *
 * Pins the REAL coverage tile that replaced the old cases-per-source "Connector health"
 * bar list: it is fetched from the typeof-guarded `api.sourcesCoverage()` and lives inside
 * the "Deeper analytics" fold. Asserts the big-number rollup renders (sources reporting /
 * events-per-min / alerts-triaged) and that the silent-source alarm shouts + drills to the
 * Sources page. Offline — the api + posture fetch are mocked; no #3 behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock, noiseMock, coverageMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
  noiseMock: vi.fn(),
  coverageMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    noiseReduction: noiseMock,
    sourcesCoverage: coverageMock,
  },
}));

import Overview from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, SourceCoverage } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c1', status: 'open', risk_score: 88, source_name: 'Elastic SIEM', title: 'Impossible travel' },
  { case_id: 'c2', status: 'resolved', risk_score: 20, source_name: 'Wazuh', title: 'Brute force' },
] as unknown as Case[];

const METRICS: Metrics = {
  total_cases: 2, open_cases: 1, needs_human_cases: 0, closed_cases: 1,
  by_status: { open: 1, resolved: 1 }, by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 0, none: 0 },
  persona_usage: {}, playbook_usage: {}, avg_risk_score: 54,
  active_risk_index: 70, active_risk_case_count: 1, mttr_minutes: 90, resolved_count: 1,
  cases_per_day: [], burndown: [], timing_trend: [],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0, outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE: PostureResponse = {
  window_hours: 24, generated_at: '2026-07-01T08:00:00Z', case_count: 2,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 1, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'n/a' },
    mttd_minutes: { p50: 9, p90: 30, mean: 12, max: 60, count: 2, available: true, reason: '' },
  },
  quality: {
    total_cases: 2, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    alert_to_incident_ratio: 0.5, false_positive_rate: 0.5, escalation_rate: 0, containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: { queue_depth: 1, age_buckets: [], oldest: [], arrivals: 2, closures: 1, closure_vs_arrival: 0.5, backlog: 1 },
  sla: { enabled: false },
};

/** 3 enabled sources, 1 silent → 2 reporting; the tile must shout about the silent one. */
const COVERAGE: SourceCoverage = {
  sources_total: 3,
  sources_enabled: 3,
  sources_silent: 1,
  events_per_min: 128,
  alerts_triaged_24h: 42,
  worst_last_event_seconds: 5400,
};

/** All sources healthy → the tile shows the all-clear, no silent alarm. */
const COVERAGE_CLEAN: SourceCoverage = {
  sources_total: 2,
  sources_enabled: 2,
  sources_silent: 0,
  events_per_min: 64,
  alerts_triaged_24h: 10,
  worst_last_event_seconds: 120,
};

async function expandDeeperAnalytics() {
  const deeper = await screen.findByRole('button', { name: /Deeper analytics/i });
  // The open/closed choice is remembered (Round 12), so only open it when it is shut.
  if (deeper.getAttribute('aria-expanded') !== 'true') await userEvent.click(deeper);
}

describe('Overview — ingest-coverage tile', () => {
  beforeEach(() => {
    // Deeper analytics remembers its open state per browser; every case starts folded.
    localStorage.removeItem('soc.overview.deeperOpen');
    fetchPostureMock.mockReset().mockResolvedValue(POSTURE);
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockReset().mockResolvedValue(METRICS);
    usageMock.mockReset().mockResolvedValue({ total_cost: 0.5, total_tokens: 4000, call_count: 3, currency: 'USD' });
    noiseMock.mockReset().mockResolvedValue(null);
    coverageMock.mockReset().mockResolvedValue(COVERAGE);
  });

  it('fetches GET /api/sources/coverage and renders the big-number rollup', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(coverageMock).toHaveBeenCalled());

    await expandDeeperAnalytics();

    const tile = await screen.findByTestId('coverage-tile');
    expect(within(tile).getByText(/sources reporting/i)).toBeInTheDocument();
    // The server aggregates render (events/min + alerts triaged are plain, not count-ups).
    expect(within(tile).getByText('128')).toBeInTheDocument();
    expect(within(tile).getByText('42')).toBeInTheDocument();
    // The stat labels are present.
    expect(within(tile).getByText(/Events \/ min/i)).toBeInTheDocument();
    expect(within(tile).getByText(/Triaged 24h/i)).toBeInTheDocument();
  });

  it('shouts + drills to Sources when a source has gone silent', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(coverageMock).toHaveBeenCalled());

    await expandDeeperAnalytics();

    const tile = await screen.findByTestId('coverage-tile');
    const alarm = within(tile).getByRole('button', { name: /stopped reporting/i });
    expect(alarm).toBeInTheDocument();
    await userEvent.click(alarm);
    expect(onNavigate).toHaveBeenCalledWith('sources');
  });

  it('shows the all-clear when every source is reporting', async () => {
    coverageMock.mockResolvedValue(COVERAGE_CLEAN);
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(coverageMock).toHaveBeenCalled());

    await expandDeeperAnalytics();

    const tile = await screen.findByTestId('coverage-tile');
    expect(within(tile).getByText(/All enabled sources are reporting/i)).toBeInTheDocument();
    // No silent-source alarm button when nothing is silent.
    expect(within(tile).queryByRole('button', { name: /stopped reporting/i })).toBeNull();
  });

  it('falls back to the "not yet reported" empty state when coverage is unavailable', async () => {
    // A minimal/older client: sourcesCoverage rejects → the tile self-omits to an empty state.
    coverageMock.mockRejectedValue(new Error('not found'));
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');

    await expandDeeperAnalytics();

    expect(await screen.findByText(/Coverage not yet reported/i)).toBeInTheDocument();
    expect(screen.queryByTestId('coverage-tile')).toBeNull();
  });
});
