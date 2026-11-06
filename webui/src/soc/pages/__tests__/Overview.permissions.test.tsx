/**
 * The Cyber Defence Center sends only the reads the viewer's role may make, and leaves out
 * the panels it cannot read (Round 14 second acceptance pass, roles-02, roles-03):
 *
 * - The strip, the flow, Human vs AI, Response time, the timing tiles and Case volume read
 *   the metrics endpoints (`metrics:view`): GET /api/metrics, /metrics/posture,
 *   /metrics/trends and /metrics/noise-reduction. Without the grant none is sent, the
 *   panels are left out, and one plain line where the strip was says why, never a load
 *   error with a Retry.
 * - LLM spend reads /api/usage/summary (`cost:view`), Ingest coverage reads
 *   /api/sources/coverage (`sources:read`), and the automation nudge reads /api/sources and
 *   /api/tuning/config (`sources:read` and `automation:read`). Each is left out without
 *   its grant.
 * - A 403 on a read the Console believed allowed (a role changed after sign-in) counts as
 *   the grant missing: the panels are left out, the read is not sent again, and the shell's
 *   grants are loaded again once.
 * - Grants that could not be loaded are a load failure with a Retry, never "You do not
 *   have access".
 * - The case snapshots and Latest cases follow `cases:read`, the page's own grant, and a
 *   quiet window is never taken for an empty install without the store-wide total.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const h = vi.hoisted(() => ({
  grants: new Set<string>(),
  /** False: the grants failed to load (RBAC reported off and every check denied). */
  grantsLoaded: true,
  refresh: vi.fn(),
  fetchPosture: vi.fn(),
  listCases: vi.fn(),
  getMetrics: vi.fn(),
  usageSummary: vi.fn(),
  noiseReduction: vi.fn(),
  sourcesCoverage: vi.fn(),
  metricsTrends: vi.fn(),
  listSources: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/soc/auth', () => {
  const has = (resource: string, action: string) =>
    h.grantsLoaded && h.grants.has(`${resource}:${action}`);
  const auth = () => ({
    hasPermission: has,
    username: 'probe',
    authEnabled: true,
    isAuthenticated: true,
    rbacEnabled: h.grantsLoaded,
    refresh: h.refresh,
  });
  return { useOptionalAuth: auth, useAuth: auth };
});

vi.mock('../Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../Metrics.posture.api')>('../Metrics.posture.api');
  return { ...actual, fetchPosture: h.fetchPosture };
});

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  api: {
    listCases: h.listCases,
    getMetrics: h.getMetrics,
    usageSummary: h.usageSummary,
    noiseReduction: h.noiseReduction,
    sourcesCoverage: h.sourcesCoverage,
    metricsTrends: h.metricsTrends,
    listSources: h.listSources,
    get: h.get,
  },
}));

import { ApiError } from '@/lib/api';
import Overview, { projectPosture } from '../Overview';
import type { PostureResponse } from '../Metrics.posture.api';
import type { PostureState } from '@/soc/hooks/usePosture';

const NOW = new Date().toISOString();
const CASES = [
  { case_id: 'c1', status: 'open', risk_score: 88, title: 'Unauthorized S3 access', created_at: NOW },
  { case_id: 'c2', status: 'resolved', risk_score: 20, title: 'Brute force on the gateway', created_at: NOW },
];

const POSTURE = {
  window_hours: 24,
  generated_at: NOW,
  case_count: 2,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 1, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: 30, p90: 60, mean: 40, max: 90, count: 1, available: true, reason: '' },
    mttd_minutes: { p50: 9, p90: 30, mean: 12, max: 60, count: 2, available: true, reason: '' },
  },
  quality: {
    total_cases: 2, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    alert_to_incident_ratio: 0.5, false_positive_rate: 0.5, escalation_rate: 0,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: { queue_depth: 1, age_buckets: [], oldest: [], arrivals: 2, closures: 1, closure_vs_arrival: 0.5, backlog: 1 },
  sla: { enabled: false },
} as unknown as PostureResponse;

const METRICS = {
  total_cases: 2,
  by_status: { open: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 0, none: 0 },
  cases_per_day: [{ date: '2026-11-05', count: 2 }],
  timing_trend: [],
  cost: {},
  feedback: {},
};

const ALL_GRANTS = [
  'cases:read',
  'metrics:view',
  'cost:view',
  'sources:read',
  'automation:read',
];

async function openDeeperAnalytics() {
  const deeper = await screen.findByRole('button', { name: /Deeper analytics/i });
  if (deeper.getAttribute('aria-expanded') !== 'true') await userEvent.click(deeper);
}

const EMPTY_PAGE = { cases: [], total: 0, window_total_exact: true };
const refusal = () => Promise.reject(new ApiError(403, 'permission denied: metrics:view'));

beforeEach(() => {
  localStorage.clear();
  h.grantsLoaded = true;
  h.refresh.mockReset().mockResolvedValue(null);
  h.fetchPosture.mockReset().mockResolvedValue(POSTURE);
  h.listCases.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length, window_total_exact: true });
  h.getMetrics.mockReset().mockResolvedValue(METRICS);
  h.usageSummary
    .mockReset()
    .mockResolvedValue({ total_cost: 1.25, total_tokens: 4000, call_count: 3, currency: 'USD' });
  h.noiseReduction.mockReset().mockResolvedValue(null);
  h.sourcesCoverage.mockReset().mockResolvedValue({
    sources_total: 1, sources_enabled: 1, sources_silent: 0,
    events_per_min: 4, alerts_triaged_24h: 2, worst_last_event_seconds: 30,
  });
  h.metricsTrends.mockReset().mockResolvedValue(null);
  h.listSources.mockReset().mockResolvedValue({ sources: [{ id: 's1', enabled: true }] });
  h.get.mockReset().mockResolvedValue({ config: { enabled: true } });
});

describe('Cyber Defence Center reads follow the viewer’s grants', () => {
  it('sends only the case reads to a viewer with cases:read alone and refuses the rest plainly', async () => {
    h.grants = new Set(['cases:read']);
    render(<Overview onNavigate={vi.fn()} />);

    expect(await screen.findByText('Unauthorized S3 access')).toBeInTheDocument();
    // ONE line where the strip was says why the metrics panels are missing.
    expect(screen.getByTestId('overview-metrics-restricted')).toHaveTextContent(
      'You do not have access to metrics, so the summary figures, alert flow and response times are not shown.',
    );
    expect(screen.getAllByText(/You do not have access/)).toHaveLength(1);
    expect(screen.queryByText('Access restricted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-strip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('noise-reduction-unavailable')).not.toBeInTheDocument();
    // Response time is left out (with its window caption and help tip). The queue takes its
    // columns, and the snapshots keep a column narrow enough to stack, so the row holds no
    // void under two short rings.
    expect(screen.queryByRole('region', { name: /Response time/ })).not.toBeInTheDocument();
    expect(screen.queryByText('About Response time')).not.toBeInTheDocument();
    expect(screen.getByTestId('case-state').className).toContain('xl:col-span-5');
    expect(screen.getByTestId('case-state').className).toContain('3xl:col-span-4');
    expect(screen.getByTestId('latest-cases-cell').className).toContain('xl:col-span-7');
    expect(screen.getByTestId('cases-band-grid').className).toContain(
      '4xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]',
    );
    expect(screen.getByRole('region', { name: 'Open cases' })).toBeInTheDocument();

    await openDeeperAnalytics();
    // Nothing in Efficiency and cost is readable, so the sub-band is left out; what's
    // driving volume (case-derived) stays.
    expect(screen.queryByRole('region', { name: 'Efficiency and cost' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('deeper-timing-strip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-llm-spend-detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ingest coverage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Case volume' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: /What.s driving volume/ })).toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: /Deeper analytics/i })).getByTestId('deeper-summary'),
    ).toHaveTextContent('Workload and outcomes');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();

    // Only the two case windows were read: no metrics, posture, trends, flow, spend,
    // coverage or nudge request was sent.
    expect(h.listCases).toHaveBeenCalledTimes(2);
    for (const read of [
      h.fetchPosture,
      h.getMetrics,
      h.metricsTrends,
      h.noiseReduction,
      h.usageSummary,
      h.sourcesCoverage,
      h.listSources,
      h.get,
    ]) {
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('shows a case read failure as the page error when metrics are not readable', async () => {
    h.grants = new Set(['cases:read']);
    h.listCases.mockRejectedValue(new Error('cases offline'));
    render(<Overview onNavigate={vi.fn()} />);
    expect(await screen.findByText('Could not load the dashboard')).toBeInTheDocument();
  });

  it('reads metrics with metrics:view but leaves spend, coverage and the nudge to their own grants', async () => {
    h.grants = new Set(['cases:read', 'metrics:view']);
    render(<Overview onNavigate={vi.fn()} />);

    expect(await screen.findByTestId('kpi-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-metrics-restricted')).not.toBeInTheDocument();
    await waitFor(() => expect(h.fetchPosture).toHaveBeenCalled());
    expect(h.getMetrics).toHaveBeenCalled();
    expect(h.metricsTrends).toHaveBeenCalled();
    expect(h.noiseReduction).toHaveBeenCalled();

    expect(screen.getByRole('region', { name: /Response time/ })).toBeInTheDocument();
    expect(screen.getByTestId('case-state').className).toContain('3xl:col-span-8');
    expect(screen.getByTestId('latest-cases-cell').className).toContain('xl:col-span-4');

    await openDeeperAnalytics();
    // The three timing tiles without LLM spend, and Case volume without Ingest coverage.
    const efficiency = screen.getByRole('region', { name: 'Efficiency and cost' });
    expect(within(efficiency).getByTestId('subband-caption')).toHaveTextContent('Timing over the last 24 hours');
    const timingStrip = within(screen.getByTestId('deeper-timing-strip'));
    for (const label of ['MTTA', 'MTTR', 'Dwell']) expect(timingStrip.getByText(label)).toBeInTheDocument();
    expect(timingStrip.queryByText('LLM spend')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-llm-spend-detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ingest coverage' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Case volume' }).className).toContain('xl:col-span-12');
    expect(screen.queryByText(/You do not have access/)).not.toBeInTheDocument();
    expect(h.usageSummary).not.toHaveBeenCalled();
    expect(h.sourcesCoverage).not.toHaveBeenCalled();
    expect(h.listSources).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('reads the nudge only with both sources:read and automation:read', async () => {
    h.grants = new Set(['cases:read', 'metrics:view', 'sources:read']);
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('kpi-strip');
    await waitFor(() => expect(h.sourcesCoverage).toHaveBeenCalled());
    expect(h.listSources).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('sends every read and shows every panel with all the grants', async () => {
    h.grants = new Set(ALL_GRANTS);
    render(<Overview onNavigate={vi.fn()} />);
    expect(await screen.findByTestId('kpi-strip')).toBeInTheDocument();
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('tuning/config'));
    for (const read of [
      h.fetchPosture,
      h.getMetrics,
      h.metricsTrends,
      h.noiseReduction,
      h.usageSummary,
      h.sourcesCoverage,
      h.listSources,
    ]) {
      expect(read).toHaveBeenCalled();
    }
    await openDeeperAnalytics();
    expect(screen.getByTestId('kpi-llm-spend-detail')).toHaveTextContent('$1.25');
    expect(screen.getByTestId('coverage-tile')).toBeInTheDocument();
    const timingStrip = within(screen.getByTestId('deeper-timing-strip'));
    for (const label of ['MTTA', 'MTTR', 'Dwell', 'LLM spend']) {
      expect(timingStrip.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('overview-metrics-restricted')).not.toBeInTheDocument();
    expect(screen.queryByText(/You do not have access/)).not.toBeInTheDocument();
  });

  it('keeps the page mounted through a refresh of a quiet window without metrics:view', async () => {
    h.grants = new Set(['cases:read']);
    let release: (value: unknown) => void = () => undefined;
    h.listCases
      .mockResolvedValueOnce(EMPTY_PAGE)
      .mockResolvedValueOnce(EMPTY_PAGE)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    render(<Overview onNavigate={vi.fn()} />);
    const refresh = await screen.findByRole('button', { name: 'Refresh dashboard' });
    await userEvent.click(refresh);
    // The second load is in flight: the masthead and its controls stay, no blocking loader.
    expect(h.listCases).toHaveBeenCalledTimes(4);
    expect(refresh).toBeInTheDocument();
    expect(screen.queryByText('Loading dashboard')).not.toBeInTheDocument();
    await act(async () => {
      release(EMPTY_PAGE);
    });
  });

  it('never takes a quiet window for an empty install without metrics:view', async () => {
    h.grants = new Set(['cases:read']);
    h.listCases
      .mockResolvedValueOnce(EMPTY_PAGE)
      .mockResolvedValueOnce({ cases: [CASES[0]], total: 1, window_total_exact: true });
    render(<Overview onNavigate={vi.fn()} />);
    expect(await screen.findByTestId('overview-metrics-restricted')).toBeInTheDocument();
    expect(screen.queryByText('No triage activity yet')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Open cases' })).toBeInTheDocument();
  });

  it('still shows the onboarding state for an empty store with metrics:view', async () => {
    h.grants = new Set(['cases:read', 'metrics:view']);
    h.listCases.mockResolvedValue(EMPTY_PAGE);
    h.getMetrics.mockResolvedValue({ ...METRICS, total_cases: 0, by_status: {}, cases_per_day: [] });
    render(<Overview onNavigate={vi.fn()} />);
    expect(await screen.findByText('No triage activity yet')).toBeInTheDocument();
  });

  it('treats a refused read as the missing grant: no Retry, no resend, grants reloaded once', async () => {
    h.grants = new Set(['cases:read', 'metrics:view', 'cost:view', 'sources:read']);
    for (const read of [h.noiseReduction, h.getMetrics, h.metricsTrends, h.fetchPosture]) {
      read.mockImplementation(refusal);
    }
    h.usageSummary.mockImplementation(() => Promise.reject(new ApiError(403, 'permission denied: cost:view')));
    h.sourcesCoverage.mockImplementation(() =>
      Promise.reject(new ApiError(403, 'permission denied: sources:read')),
    );
    render(<Overview onNavigate={vi.fn()} />);

    expect(await screen.findByTestId('overview-metrics-restricted')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('kpi-strip')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Posture unavailable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('noise-reduction-unavailable')).not.toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalledTimes(1);

    const refused = [
      h.noiseReduction,
      h.getMetrics,
      h.metricsTrends,
      h.fetchPosture,
      h.usageSummary,
      h.sourcesCoverage,
    ];
    const sent = () => refused.reduce((total, read) => total + read.mock.calls.length, 0);
    const before = sent();
    const casesBefore = h.listCases.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    await waitFor(() => expect(h.listCases.mock.calls.length).toBe(casesBefore + 2));
    expect(sent()).toBe(before);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    await openDeeperAnalytics();
    expect(screen.queryByRole('region', { name: 'Efficiency and cost' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('keeps an outage an outage: a failed flow read still offers its Retry', async () => {
    h.grants = new Set(['cases:read', 'metrics:view']);
    h.noiseReduction.mockRejectedValue(new ApiError(503, 'noise counters unavailable'));
    render(<Overview onNavigate={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Retry noise reduction' })).toBeInTheDocument();
    expect(screen.getByTestId('kpi-strip')).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('says the grants could not be loaded, with a Retry, never that the role lacks them', async () => {
    h.grantsLoaded = false;
    h.grants = new Set(ALL_GRANTS);
    render(<Overview onNavigate={vi.fn()} />);
    const notice = await screen.findByTestId('grants-unknown');
    expect(notice).toHaveTextContent('Your permissions could not be loaded.');
    expect(screen.queryByText(/You do not have access/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview-metrics-restricted')).not.toBeInTheDocument();
    // Nothing the unknown grants cover was read.
    expect(h.getMetrics).not.toHaveBeenCalled();
    expect(h.fetchPosture).not.toHaveBeenCalled();
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('projectPosture', () => {
  const reload = vi.fn(async () => undefined);
  const fed = (hours: number, state: Partial<PostureState>) => ({
    hours,
    state: { data: null, loading: false, error: null, stale: false, reload, ...state },
  });

  it('is settled and empty without metrics:view, and loading before the first read', () => {
    expect(projectPosture(false, fed(24, { data: POSTURE }), 24)).toMatchObject({
      data: null,
      loading: false,
      error: null,
      stale: false,
    });
    expect(projectPosture(true, null, 24)).toMatchObject({ data: null, loading: true, stale: false });
  });

  it('passes the fed state through for its own window', () => {
    const state = fed(24, { data: POSTURE });
    expect(projectPosture(true, state, 24)).toBe(state.state);
  });

  it('shows a state fed for another window as a stale, loading snapshot, as the hook does', () => {
    expect(projectPosture(true, fed(24, { data: POSTURE, error: null }), 168)).toEqual({
      data: POSTURE,
      loading: true,
      error: null,
      stale: true,
      reload,
    });
    expect(projectPosture(true, fed(24, { error: new Error('down') }), 168)).toMatchObject({
      data: null,
      loading: true,
      error: null,
      stale: false,
    });
  });
});
