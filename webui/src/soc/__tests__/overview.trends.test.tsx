/**
 * Overview (Cyber Defence Center) — hover-trendline contract (GET /api/metrics/trends).
 *
 * Pins the honest hover-trend affordance on the landing metrics:
 *   1. `metricsTrends` is fetched for the selected window (typeof-guarded elsewhere);
 *   2. hovering a KPI tile reveals its server bucket series — the right VALUES for the
 *      right metric (new-cases → `new_cases`, auto-resolved → `auto_closed`,
 *      FP rate → `fp_rate`) plus the window/bucket disclosure;
 *   3. the trend card is keyboard-reachable (Radix opens on trigger focus — WCAG 1.4.13);
 *   4. a series with no usable data renders the quiet "No trend data yet." line and
 *      NEVER an invented sparkline; per-bucket nulls are disclosed as measured-of-total;
 *   5. the combined Critical/High tile deliberately has NO hover-trend affordance
 *      (no per-severity bucket series exists — honesty over decoration).
 *
 * Fully offline: api + posture fetch mocked; no #3 behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock, trendsMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
  trendsMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    metricsTrends: trendsMock,
  },
}));

import Overview from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, MetricsTrends } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c1', status: 'open', risk_score: 88, source_name: 'Elastic SIEM', title: 'Impossible travel', entity: { type: 'ip', value: '10.0.0.1' } },
  { case_id: 'c2', status: 'needs_human', risk_score: 65, source_name: 'Wazuh', title: 'Brute force', entity: { type: 'host', value: 'web-01' } },
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
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no response yet' },
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

/** Three hourly buckets: real counts, a null-fp first bucket, all-null alerts. */
const TRENDS: MetricsTrends = {
  window_hours: 24,
  bucket_minutes: 60,
  generated_at: '2026-07-01T08:00:00Z',
  buckets: [
    { t: '2026-07-01T05:00:00Z', new_cases: 2, closed: 1, auto_closed: 1, false_positives: 0, needs_human: 1, escalated: 0, sent_to_human: 1, fp_rate: null, alerts: null },
    { t: '2026-07-01T06:00:00Z', new_cases: 0, closed: 0, auto_closed: 0, false_positives: 0, needs_human: 0, escalated: 0, sent_to_human: 0, fp_rate: 25, alerts: null },
    // needs_human 2 + escalated 1 OVERLAP on one case: the honest once-counted
    // union is 2 — a client-side nh+esc sum would wrongly chart 3.
    { t: '2026-07-01T07:00:00Z', new_cases: 5, closed: 2, auto_closed: 3, false_positives: 1, needs_human: 2, escalated: 1, sent_to_human: 2, fp_rate: 50, alerts: null },
  ],
  truncated: false,
  store_total: 7,
  fetched: 7,
};

async function findTrendCard(): Promise<HTMLElement> {
  return await screen.findByTestId('metric-trend-card');
}

describe('Overview — hover trendlines', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    trendsMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD' });
    trendsMock.mockResolvedValue(TRENDS);
  });

  it('fetches the trend buckets for the selected window and states the hover affordance', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // The selected window plus the batch's cancellation signal (superseded loads abort).
    await waitFor(() =>
      expect(trendsMock).toHaveBeenCalledWith(24, expect.any(AbortSignal)),
    );
    // The quiet discoverability line replaces the removed delta footnote.
    expect(
      await screen.findByText(/Hover or focus a metric for its last 24 hours · 1h buckets trend\./i),
    ).toBeInTheDocument();
  });

  it('hover on the Open-cases tile reveals the honest new-cases arrival series', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-open-cases')).toBeInTheDocument());

    await userEvent.hover(screen.getByTestId('kpi-open-cases'));
    const card = await findTrendCard();
    // The card names the SERIES honestly (arrivals, not an invented open-count line).
    expect(within(card).getByText('New cases opened')).toBeInTheDocument();
    expect(within(card).getByText('case arrivals per bucket')).toBeInTheDocument();
    expect(within(card).getByText('last 24 hours · 1h buckets')).toBeInTheDocument();
    // First/latest come from buckets.new_cases = [2, 0, 5].
    expect(within(card).getByText('first 2')).toBeInTheDocument();
    expect(within(card).getByText('latest 5')).toBeInTheDocument();
  });

  it('hover on the Escalated tile charts the once-counted sent_to_human series', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-escalated-to-human')).toBeInTheDocument());

    await userEvent.hover(screen.getByTestId('kpi-escalated-to-human'));
    const card = await findTrendCard();
    expect(within(card).getByText('Sent to human')).toBeInTheDocument();
    // buckets.sent_to_human = [1, 0, 2]. The last bucket has needs_human 2 and
    // escalated 1 overlapping on one case — a nh+esc sum would wrongly show 3.
    expect(within(card).getByText('first 1')).toBeInTheDocument();
    expect(within(card).getByText('latest 2')).toBeInTheDocument();
  });

  it('hover on the Auto-resolved tile reveals the auto_closed series', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-auto-resolved')).toBeInTheDocument());

    await userEvent.hover(screen.getByTestId('kpi-auto-resolved'));
    const card = await findTrendCard();
    expect(within(card).getByText('Auto-resolved cases')).toBeInTheDocument();
    // buckets.auto_closed = [1, 0, 3].
    expect(within(card).getByText('first 1')).toBeInTheDocument();
    expect(within(card).getByText('latest 3')).toBeInTheDocument();
  });

  it('FP-rate hover preserves nulls as not-measured buckets and opens from keyboard focus', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-false-positive-rate');

    // Keyboard path (WCAG 1.4.13): focusing the tile (the trigger's focusable child)
    // opens the card without a pointer.
    act(() => tile.focus());
    const card = await findTrendCard();
    expect(within(card).getByText('False positive rate')).toBeInTheDocument();
    // fp_rate = [null, 25, 50] → first measured 25%, latest 50%, 2 of 3 measured.
    expect(within(card).getByText('first 25%')).toBeInTheDocument();
    expect(within(card).getByText('latest 50%')).toBeInTheDocument();
    expect(within(card).getByText('2 of 3 buckets measured.')).toBeInTheDocument();
  });

  it('shows the quiet no-data line when a series has no usable buckets (never an invented trend)', async () => {
    trendsMock.mockResolvedValue({
      ...TRENDS,
      buckets: TRENDS.buckets.map((b) => ({ ...b, fp_rate: null })),
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-false-positive-rate');

    await userEvent.hover(tile);
    const card = await findTrendCard();
    expect(within(card).getByText('No trend data yet.')).toBeInTheDocument();
    expect(within(card).queryByText(/^first /)).toBeNull();
    expect(within(card).queryByRole('img')).toBeNull();
  });

  it('gives the combined Critical/High tile NO trend affordance (no honest per-severity series exists)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-critical-high');
    // The tile is not wrapped in a hover-trend trigger at all.
    expect(tile.closest('[data-testid="metric-trend-trigger"]')).toBeNull();
    await userEvent.hover(tile);
    // Give any (wrong) hover card a beat to appear, then assert none did.
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
  });

  it('degrades quietly when the trends read fails: hover shows the no-data line', async () => {
    trendsMock.mockRejectedValue(new Error('trends endpoint unavailable'));
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-open-cases');
    // The discoverability footnote self-omits without a bucket payload.
    expect(screen.queryByText(/Hover or focus a metric/i)).toBeNull();

    await userEvent.hover(tile);
    const card = await findTrendCard();
    expect(within(card).getByText('New cases opened')).toBeInTheDocument();
    expect(within(card).getByText('No trend data yet.')).toBeInTheDocument();
    // The fallback disclosure still states the selected window.
    expect(within(card).getByText('last 24 hours')).toBeInTheDocument();
  });
});
