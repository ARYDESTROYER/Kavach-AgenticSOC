/**
 * Overview — Cyber Defence Center integration test (Stitch-inspired command center).
 *
 * Pins the four command-center signatures:
 *   1. the page is titled "Cyber Defence Center";
 *   2. the Human-vs-AI close-attribution instrument (which replaced the Active Risk
 *      Index gauge) is its own flat cell in the integrated instrument band, a sibling
 *      of the plain header, never nested inside it;
 *   3. the Noise-Reduction instrument renders mixed-unit conversion context followed by
 *      a conserved case flow, plus real selected-window Open-case context;
 *   4. the KPI micro-strip is 5 alert/case tiles (LLM spend is not a hero tile).
 *
 * Offline — the api + posture fetch are mocked; no auth, no #3 behaviour touched.
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

const { listCasesMock, getMetricsMock, usageMock, noiseMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
  noiseMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    noiseReduction: noiseMock,
  },
}));

import Overview, { PAGE_TITLE } from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, NoiseReduction } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c1', status: 'open', risk_score: 88, source_name: 'Elastic SIEM', title: 'Impossible travel', entity: { type: 'ip', value: '10.0.0.1' } },
  { case_id: 'c2', status: 'needs_human', risk_score: 65, source_name: 'Wazuh', title: 'Brute force', entity: { type: 'host', value: 'web-01' } },
  { case_id: 'c3', status: 'resolved', risk_score: 20, source_name: 'Elastic SIEM', title: 'Impossible travel', entity: { type: 'ip', value: '10.0.0.1' } },
] as unknown as Case[];

const METRICS: Metrics = {
  total_cases: 3, open_cases: 1, needs_human_cases: 1, closed_cases: 1,
  by_status: { open: 1, needs_human: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 1, none: 0 },
  persona_usage: {}, playbook_usage: {}, avg_risk_score: 57,
  active_risk_index: 76, active_risk_case_count: 2,
  mttr_minutes: 120, resolved_count: 1,
  cases_per_day: [{ date: '2026-06-30', count: 2 }, { date: '2026-07-01', count: 5 }],
  burndown: [{ date: '2026-06-30', opened: 4, resolved: 2 }],
  timing_trend: [{ date: '2026-06-30', mttd: 12, respond: 30, resolve: 180 }],
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
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no response yet' },
    mttd_minutes: { p50: 9, p90: 30, mean: 12, max: 60, count: 3, available: true, reason: '' },
  },
  quality: {
    total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1, closure_vs_arrival: 0.33, backlog: 2 },
  sla: { enabled: false },
};

const NOISE: NoiseReduction = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  bands: ['critical', 'high', 'medium', 'low', 'info'],
  stages: [
    { key: 'ingested', label: 'Ingested', source: 'counters', deterministic: true, total: 1000, by_severity: { critical: 50, high: 150, medium: 300, low: 400, info: 100 } },
    { key: 'clustered', label: 'Clustered', source: 'counters', deterministic: true, total: 400, by_severity: { critical: 40, high: 100, medium: 120, low: 100, info: 40 } },
    { key: 'cases', label: 'Cases opened', source: 'cases', deterministic: false, total: 40, by_severity: { critical: 8, high: 12, medium: 12, low: 6, info: 2 } },
    { key: 'auto_cleared', label: 'Auto-cleared', source: 'cases', deterministic: true, total: 20, by_severity: {} },
    // Every non-auto-cleared case is represented by the folded Escalated outcome.
    { key: 'escalated', label: 'Escalated', source: 'cases', deterministic: true, total: 20, by_severity: {} },
    { key: 'needs_human', label: 'Needs human', source: 'cases', deterministic: true, total: 6, by_severity: {} },
    { key: 'closed', label: 'Closed by human', source: 'cases', deterministic: true, total: 12, by_severity: { high: 5, medium: 5, low: 2 } },
  ],
  drops: { suppressed: 5, ignored: 2 },
  reduction: { overall_pct: 96, human_reduction_pct: 50 },
  counters: { available: true, since: '2026-06-30T08:00:00Z', incomplete: false },
  cases_meta: { truncated: false, store_total: 40, fetched: 40 },
};

describe('Overview — Cyber Defence Center', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    noiseMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD' });
    noiseMock.mockResolvedValue(NOISE);
  });

  it('is titled "Cyber Defence Center" (the rename smoke)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const hero = await screen.findByTestId('page-hero');
    expect(PAGE_TITLE).toBe('Cyber Defence Center');
    expect(hero).toHaveTextContent('Cyber Defence Center');
    // The retired title never leaks back into the masthead.
    expect(hero).not.toHaveTextContent('Security Command Center');
  });

  it('opens on Last 24 hours with LIVE refresh visibly active', async () => {
    const user = userEvent.setup();
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: 'Time range: Last 24 hours' })).toBeInTheDocument();
    const live = screen.getByRole('combobox', { name: 'Auto-refresh interval: LIVE' });
    expect(live).toBeInTheDocument();
    expect(live.querySelectorAll('.animate-pulse.bg-success')).toHaveLength(1);
    expect(live.querySelector('.lucide-refresh-cw')).toBeNull();
    const manualRefresh = screen.getByRole('button', { name: 'Refresh dashboard' });
    expect(manualRefresh).toHaveClass('text-success-text');
    expect(manualRefresh.querySelector('.lucide-refresh-cw')).toHaveClass('animate-spin');

    const callsBeforeManualRefresh = listCasesMock.mock.calls.length;
    await user.click(manualRefresh);
    await waitFor(() =>
      expect(listCasesMock.mock.calls.length).toBeGreaterThan(callsBeforeManualRefresh),
    );
  });

  it('mounts the Human-vs-AI instrument as its own flat cell in the instrument band', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const hero = await screen.findByTestId('page-hero');
    const heroRow = await screen.findByTestId('hero-row');
    const card = screen.getByTestId('human-vs-ai');
    expect(card).toBeInTheDocument();
    // Its own instrument cell, inside the band but NOT nested inside the plain header.
    expect(within(heroRow).getByTestId('human-vs-ai')).toBeInTheDocument();
    expect(within(hero).queryByTestId('human-vs-ai')).toBeNull();
    // It is the ONE close-attribution surface on the page, and the Active Risk Index
    // gauge it replaced is gone from the landing surface entirely.
    expect(screen.getAllByTestId('human-vs-ai')).toHaveLength(1);
    expect(screen.queryByTestId('active-risk-index')).toBeNull();
    // The three-way partition is always present — the residual band is never hidden.
    for (const band of ['human-vs-ai-ai', 'human-vs-ai-human', 'human-vs-ai-system']) {
      expect(within(card).getByTestId(band)).toBeInTheDocument();
    }
  });

  it('mounts the compact Noise-Reduction flow with conversion context and Open cases', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('noise-funnel')).toBeInTheDocument());
    expect(noiseMock).toHaveBeenCalled();
    const funnel = screen.getByTestId('noise-funnel');
    expect(within(funnel).getByTestId('noise-simple-view')).toBeInTheDocument();
    expect(within(funnel).getByRole('radio', { name: 'Simple' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Conversion context and the conserved terminal path render in the compact graph.
    expect(within(funnel).getAllByText('Alerts ingested').length).toBeGreaterThan(0);
    expect(within(funnel).getAllByText('After clustering').length).toBeGreaterThan(0);
    expect(within(funnel).getAllByText('Closed by human').length).toBeGreaterThan(0);
    expect(within(funnel).getAllByText('Auto-cleared by AI').length).toBeGreaterThan(0);
    expect(within(funnel).queryByTestId('noise-reduction-summary')).toBeNull();
    const conversionRibbons = Array.from(
      within(funnel)
        .getByTestId('noise-flow-band')
        .querySelectorAll<SVGPathElement>('[data-edge-kind="conversion"]'),
    );
    expect(conversionRibbons).toHaveLength(2);
    expect(
      conversionRibbons.map((ribbon) => [
        ribbon.dataset.sourceStage,
        ribbon.dataset.targetStage,
      ]),
    ).toEqual([
      ['ingested', 'clustered'],
      ['clustered', 'cases'],
    ]);
    conversionRibbons.forEach((ribbon) => {
      expect(ribbon.getAttribute('d')).toMatch(/Z$/);
      expect(ribbon).not.toHaveAttribute('fill', 'none');
    });
    expect(within(funnel).getByTestId('noise-flow-band').querySelectorAll(
      '[data-edge-kind="conserved"]',
    )).toHaveLength(4);
    expect(within(funnel).getByTestId('noise-open-cases')).toHaveTextContent('2 open cases');
    // A covered window is a measurement, not a floor — no "≥" prefix.
    expect(within(funnel).getByTestId('noise-open-cases')).toHaveAttribute('data-partial', 'false');
    // The evidence rail is the responsive fallback in Simple, then becomes persistent
    // when the operator explicitly chooses Detailed.
    expect(within(funnel).getByTestId('noise-stage-rail')).toHaveClass(
      'grid-cols-2',
      'sm:grid-cols-3',
      '@[38rem]/noise:hidden',
    );
  });

  it('keeps the last noise flow and names a noise-only refresh failure with Retry', async () => {
    const user = userEvent.setup();
    render(<Overview onNavigate={vi.fn()} />);
    const funnel = await screen.findByTestId('noise-funnel');

    // Only the optional Noise Reduction slice fails on the next dashboard refresh.
    noiseMock.mockRejectedValueOnce(new Error('noise counters are temporarily unavailable'));
    await user.click(screen.getByRole('button', { name: 'Refresh dashboard' }));

    const unavailable = await screen.findByTestId('noise-reduction-unavailable');
    expect(within(unavailable).getByText('Noise reduction unavailable')).toBeInTheDocument();
    expect(
      within(unavailable).getByRole('button', { name: 'Retry noise reduction' }),
    ).toBeInTheDocument();
    // The previous usable aggregate remains visible and healthy siblings stay mounted.
    expect(screen.getByTestId('noise-funnel')).toBe(funnel);
    expect(screen.getByRole('region', { name: /Latest cases/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Cases burndown/i })).toBeInTheDocument();

    await user.click(within(unavailable).getByRole('button', { name: 'Retry noise reduction' }));
    await waitFor(() => expect(screen.queryByTestId('noise-reduction-unavailable')).toBeNull());
    expect(screen.getByTestId('noise-funnel')).toBeInTheDocument();
  });

  it('clicking a funnel stage drills into the filtered case list', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const funnel = await screen.findByTestId('noise-funnel');
    await userEvent.click(funnel.querySelector<HTMLButtonElement>('[data-flow-label="escalated"]')!);
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ noiseOutcome: 'escalated', window: expect.any(Number) }),
    );
    // The terminal `closed` stage drills to the closed-case list.
    await userEvent.click(funnel.querySelector<HTMLButtonElement>('[data-flow-label="closed"]')!);
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ noiseOutcome: 'closed', window: expect.any(Number) }),
    );
  });

  it('marks the funnel Open-case count partial from window_covered, not from truncated', async () => {
    // `aging.queue_depth` is cohort-scoped, so its completeness is the WINDOW's. This
    // posture read more than it could return (`truncated`) but did NOT reach back far
    // enough to answer the selected window, so the count is a floor and says so.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      truncated: true,
      store_total: 40_000,
      window_covered: false,
    });
    render(<Overview onNavigate={vi.fn()} />);
    const funnel = await screen.findByTestId('noise-funnel');
    await waitFor(() =>
      expect(within(funnel).getByTestId('noise-open-cases')).toHaveAttribute('data-partial', 'true'),
    );
    expect(within(funnel).getByTestId('noise-open-cases')).toHaveTextContent('≥2 open cases');
  });

  it('publishes an exact funnel Open-case count when window_covered rescues a truncated fetch', async () => {
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      truncated: true,
      store_total: 40_000,
      window_covered: true,
    });
    render(<Overview onNavigate={vi.fn()} />);
    const funnel = await screen.findByTestId('noise-funnel');
    await waitFor(() =>
      expect(within(funnel).getByTestId('noise-open-cases')).toHaveTextContent('2 open cases'),
    );
    expect(within(funnel).getByTestId('noise-open-cases')).toHaveAttribute('data-partial', 'false');
  });

  it('falls back to the store-proven window total, NOT to a `cases.length >= 200` guess', async () => {
    // Without a posture rollup the count comes off the fetched page. The old client
    // heuristic called any 200-row page truncated — so a window holding exactly 200
    // cases was permanently reported as "≥200" even though every row had been read.
    // `#103`'s `window_total_exact` answers the question the store actually knows.
    const exactly200: Case[] = Array.from({ length: 200 }, (_, i) => ({
      case_id: `w-${i}`,
      status: 'open',
      risk_score: 30,
    })) as unknown as Case[];
    fetchPostureMock.mockRejectedValue(new Error('posture unavailable'));
    listCasesMock.mockResolvedValue({
      cases: exactly200,
      total: 200,
      window_total_exact: true,
    });
    render(<Overview onNavigate={vi.fn()} />);
    const funnel = await screen.findByTestId('noise-funnel');
    await waitFor(() =>
      expect(within(funnel).getByTestId('noise-open-cases')).toHaveTextContent('200 open cases'),
    );
    expect(within(funnel).getByTestId('noise-open-cases')).toHaveAttribute('data-partial', 'false');
  });

  it('marks the fallback partial when the store proves the window holds more rows', async () => {
    fetchPostureMock.mockRejectedValue(new Error('posture unavailable'));
    listCasesMock.mockResolvedValue({
      cases: CASES,
      total: 900,
      window_total_exact: true,
    });
    render(<Overview onNavigate={vi.fn()} />);
    const funnel = await screen.findByTestId('noise-funnel');
    await waitFor(() =>
      expect(within(funnel).getByTestId('noise-open-cases')).toHaveAttribute('data-partial', 'true'),
    );
  });

  it('marks the fallback partial when the store cannot prove the window total', async () => {
    // `window_total_exact` absent/false means the server answered a DIFFERENT question
    // than the one asked (a compatibility scan, or an unparseable bound that was
    // dropped). Absence of proof is not proof, so the count stays a floor.
    fetchPostureMock.mockRejectedValue(new Error('posture unavailable'));
    listCasesMock.mockResolvedValue({ cases: CASES, total: 3 });
    render(<Overview onNavigate={vi.fn()} />);
    const funnel = await screen.findByTestId('noise-funnel');
    await waitFor(() =>
      expect(within(funnel).getByTestId('noise-open-cases')).toHaveAttribute('data-partial', 'true'),
    );
  });

  it('opens the complete active-case cohort from the separate Open cases control', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const funnel = await screen.findByTestId('noise-funnel');

    await userEvent.click(within(funnel).getByTestId('noise-open-cases'));

    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: '__active__', window: expect.any(Number) }),
    );
  });

  it('renders a KPI micro-strip of 5 alert/case tiles (LLM spend not a hero tile)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());
    const strip = screen.getByTestId('kpi-strip');
    expect(strip.querySelectorAll('[data-testid^="kpi-"]')).toHaveLength(5);
    for (const id of [
      'kpi-total-cases',
      'kpi-total-critical',
      'kpi-open-cases',
      'kpi-false-positive-rate',
      'kpi-resolved-closed',
    ]) {
      expect(within(strip).getByTestId(id)).toHaveClass('bg-transparent');
    }
    expect(within(strip).queryByTestId('kpi-llm-spend')).toBeNull();
  });

  it('marks only LLM spend unavailable, preserves its last value, and retries in place', async () => {
    const user = userEvent.setup();
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await user.click(await screen.findByRole('button', { name: /Deeper analytics/i }));

    let spend = await screen.findByTestId('kpi-llm-spend-detail');
    expect(within(spend).getByText('$1.25')).toBeInTheDocument();

    // Only usage telemetry fails on the next dashboard refresh.
    usageMock.mockRejectedValueOnce(new Error('usage ledger is temporarily unavailable'));
    await user.click(screen.getByRole('button', { name: 'Refresh dashboard' }));

    await waitFor(() => {
      spend = screen.getByTestId('kpi-llm-spend-detail');
      expect(within(spend).getByText('Unavailable')).toBeInTheDocument();
    });
    expect(within(spend).getByText(/Last loaded \$1\.25/i)).toBeInTheDocument();
    expect(within(spend).getByText(/Retry spend telemetry/i)).toBeInTheDocument();
    expect(within(spend).queryByText('No spend recorded')).toBeNull();
    // Other dashboard slices remain available; the page never collapses to an error.
    expect(screen.getByTestId('noise-funnel')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument();

    await user.click(spend);
    await waitFor(() =>
      expect(within(screen.getByTestId('kpi-llm-spend-detail')).queryByText('Unavailable')).toBeNull(),
    );
    expect(within(screen.getByTestId('kpi-llm-spend-detail')).getByText('$1.25')).toBeInTheDocument();
  });
});
