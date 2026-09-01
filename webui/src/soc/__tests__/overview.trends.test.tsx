/**
 * Overview (Cyber Defence Center) — hover-trendline contract (GET /api/metrics/trends).
 *
 * Pins the honest hover-trend affordance on the landing metrics:
 *   1. `metricsTrends` is fetched for the selected window (typeof-guarded elsewhere);
 *   2. hovering a KPI tile reveals its server bucket series — the right VALUES for the
 *      right metric (Total Cases → `new_cases`, Resolved/Closed → `closed`,
 *      FP rate → `fp_rate`) plus the window/bucket disclosure;
 *   3. the trend card is keyboard-reachable (Radix opens on trigger focus — WCAG 1.4.13);
 *   4. a series with no usable data renders the quiet "No trend data yet." line and
 *      NEVER an invented sparkline; per-bucket nulls are disclosed as measured-of-total;
 *   5. the two tiles with no honest series — Total Critical (no per-severity bucket
 *      series) and Open Cases (a stock, with no open-count-over-time series) — carry NO
 *      hover affordance and no decorative in-tile spark at all.
 *
 * Fully offline: api + posture fetch mocked; no #3 behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
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
  severity_counts: { critical: 1, high: 1, medium: 0, low: 1, info: 0 },
  open_now: { count: 2, window_exempt: true, as_of: '2026-07-01T08:00:00Z', complete: true, reason: '' },
  window_covered: true, window_coverage_reason: '', oldest_fetched_at: '2026-06-30T08:00:00Z',
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
    // The quiet discoverability line replaces the removed delta footnote. It is
    // device-honest: the hover/focus copy shows only on hover-capable devices,
    // while touch-only devices (hover: none) get the tap instruction — both spans
    // ship and CSS media picks exactly one.
    expect(
      await screen.findByText(/Hover or focus a metric for its last 24 hours · 1h buckets trend\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tap a metric for its last 24 hours · 1h buckets trend\./i),
    ).toBeInTheDocument();
  });

  it('hover on the Total-Cases tile reveals the new-cases arrival series it measures', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    await userEvent.hover(screen.getByTestId('kpi-total-cases'));
    const card = await findTrendCard();
    // The tile IS the arrival cohort, so this series is the metric itself rather than
    // the "honest related series" it used to be under the old Open-cases label.
    expect(within(card).getByText('New cases opened')).toBeInTheDocument();
    expect(within(card).getByText('case arrivals per bucket')).toBeInTheDocument();
    expect(within(card).getByText('last 24 hours · 1h buckets')).toBeInTheDocument();
    // First/latest come from buckets.new_cases = [2, 0, 5].
    expect(within(card).getByText('first 2')).toBeInTheDocument();
    expect(within(card).getByText('latest 5')).toBeInTheDocument();
  });

  it('hover on the Resolved / Closed tile reveals the terminal `closed` series', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-resolved-closed')).toBeInTheDocument());

    await userEvent.hover(screen.getByTestId('kpi-resolved-closed'));
    const card = await findTrendCard();
    // `closed`, NOT `auto_closed`: the tile counts every terminal case, so charting
    // the agent-only subset beneath it would be a different population.
    expect(within(card).getByText('Cases now closed')).toBeInTheDocument();
    // buckets.closed = [1, 0, 2].
    expect(within(card).getByText('first 1')).toBeInTheDocument();
    expect(within(card).getByText('latest 2')).toBeInTheDocument();
  });

  it('gives the Open-cases STOCK tile no trend affordance (no open-count series exists)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-open-cases');
    expect(tile.closest('[data-testid="metric-trend-trigger"]')).toBeNull();
    expect(tile.querySelector('svg.recharts-surface')).toBeNull();
    await userEvent.hover(tile);
    // Give any (wrong) hover card a beat to appear, then assert none did. The arrivals
    // series belongs to Total Cases; charting it under a window-exempt stock would
    // pair a cohort line with a number that is not a cohort.
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
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

  it('gives the Critical tile NO trend affordance and NO decorative spark (no honest per-severity series exists)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-total-critical');
    // The tile is not wrapped in a hover-trend trigger at all.
    expect(tile.closest('[data-testid="metric-trend-trigger"]')).toBeNull();
    // …and it no longer draws a sample-derived sparkline the hover card cannot
    // corroborate: a tile with no honest series shows no trend of ANY kind.
    expect(tile.querySelector('svg.recharts-surface')).toBeNull();
    await userEvent.hover(tile);
    // Give any (wrong) hover card a beat to appear, then assert none did.
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
  });

  it('MTTA/MTTR tiles stay ONE tab stop: the HelpTip button focus bubbles open the trend card', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // The full timing trio lives under the collapsed Deeper-analytics fold.
    await userEvent.click(await screen.findByRole('button', { name: /Deeper analytics/i }));
    const helpBtn = await screen.findByRole('button', { name: 'About MTTA' });

    // focusable={false}: the wrapper adds NO second tab stop of its own …
    const trigger = helpBtn.closest('[data-testid="metric-trend-trigger"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    expect(trigger).not.toHaveAttribute('tabindex');

    // … and focusing the tile's HelpTip (?) button — its only tab stop — bubbles
    // to the Radix trigger and opens the trend card (keyboard path retained).
    act(() => helpBtn.focus());
    const card = await findTrendCard();
    expect(within(card).getByText('MTTA · daily mean')).toBeInTheDocument();
  });

  it('a press (tap) on a non-clickable wrapped metric opens its trend card (touch access)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // The MTTD timing stat is a non-clickable wrapped metric: its wrapper is the
    // focusable trigger, so a press toggles the card (hover never fires on touch).
    const mttdLabel = await screen.findByText('MTTD', { selector: 'div' });
    const trigger = mttdLabel.closest('[data-testid="metric-trend-trigger"]') as HTMLElement;
    expect(trigger).not.toBeNull();

    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    const card = await findTrendCard();
    expect(within(card).getByText('MTTD · daily mean')).toBeInTheDocument();
  });

  it('clicking a KPI tile opens its drill-down and does NOT open a trend card', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-total-cases');

    // A plain press (no hover): the tile's own disclosure wins outright, and the
    // hover card is force-closed for as long as the panel is up — it would otherwise
    // render straight over the panel it just opened.
    fireEvent.pointerDown(tile);
    fireEvent.pointerUp(tile);
    fireEvent.click(tile);

    expect(await screen.findByTestId('kpi-drilldown')).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
    // Give any (wrong) card a beat to appear, then assert none did.
    await new Promise((r) => setTimeout(r, 350));
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
    // The series is not lost: the panel restates it, which is the ONLY surface a
    // touch-only device can reach now that every tile is a clickable trigger.
    expect(
      within(screen.getByTestId('kpi-drilldown-trend')).getByText('New cases opened'),
    ).toBeInTheDocument();
  });

  it('degrades quietly when the trends read fails: hover shows the no-data line', async () => {
    trendsMock.mockRejectedValue(new Error('trends endpoint unavailable'));
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-total-cases');
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
