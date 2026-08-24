/**
 * Overview (Cyber Defence Center) — the "Human vs AI" close-attribution instrument.
 *
 * It replaced the Active Risk Index in the instrument band. This file pins the
 * honesty contract the card exists to keep:
 *   1. three headline counts + three shares that RECONCILE — agent / human / the
 *      system-or-unattributed RESIDUAL, over closed cases, summing to exactly 100%;
 *   2. the residual is always rendered, never folded into either side (two shares
 *      that silently fail to sum to 100 is the failure mode this guards);
 *   3. a two/three-series trendline over the same window's buckets;
 *   4. missing evidence (an older backend that omits the partition, a partition that
 *      does not add up, or a bounded scan) renders an EM DASH — never a 0%;
 *   5. the last-writer caveat is disclosed on the card itself: `decision_by` records
 *      the last decider, so an agent-closed case a human merely acknowledges migrates
 *      into the human share;
 *   6. raw alert volume, when shown at all, is labelled as a different population and
 *      is never divided into a case count.
 *
 * Offline: api + posture fetch mocked. Advisory only — no #3 behaviour touched.
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
import { reconcilingShares } from '../components/HumanVsAiCard';
import type { PostureResponse, PostureQuality } from '../pages/Metrics.posture.api';
import type { Case, Metrics, MetricsTrends, MetricsTrendBucket } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c1', status: 'open', risk_score: 88 },
  { case_id: 'c2', status: 'needs_human', risk_score: 65 },
  { case_id: 'c3', status: 'resolved', risk_score: 20 },
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

/** Base quality WITHOUT the close-attribution partition (an older backend). */
const QUALITY_LEGACY: PostureQuality = {
  total_cases: 12, verdicted_cases: 8, true_positive_cases: 3, false_positive_cases: 4,
  needs_human_cases: 1, escalated_cases: 1, terminal_cases: 10, auto_closed_cases: 6,
  alert_to_incident_ratio: 0.25, false_positive_rate: 0.5, escalation_rate: 0.08,
  containment_rate: 0.83, automation_rate: 0.6,
};

/** 6 agent + 3 human + 1 residual === 10 terminal → 60% / 30% / 10%. */
const QUALITY: PostureQuality = {
  ...QUALITY_LEGACY,
  human_closed_cases: 3,
  system_closed_cases: 1,
};

function posture(quality: PostureQuality, extra: Partial<PostureResponse> = {}): PostureResponse {
  return {
    window_hours: 24,
    generated_at: '2026-07-01T08:00:00Z',
    case_count: 12,
    lifecycle: {
      mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
      mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
      dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no response yet' },
    },
    quality,
    aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1, closure_vs_arrival: 0.33, backlog: 2 },
    sla: { enabled: false },
    ...extra,
  };
}

/** Three hourly buckets carrying the full three-way partition (auto+human+system=closed). */
const BUCKETS: MetricsTrendBucket[] = [
  { t: '2026-07-01T05:00:00Z', new_cases: 4, closed: 4, auto_closed: 3, human_closed: 1, system_closed: 0, false_positives: 1, needs_human: 0, escalated: 0, sent_to_human: 0, fp_rate: 25, alerts: 40 },
  { t: '2026-07-01T06:00:00Z', new_cases: 3, closed: 2, auto_closed: 1, human_closed: 1, system_closed: 0, false_positives: 1, needs_human: 1, escalated: 0, sent_to_human: 1, fp_rate: 50, alerts: 30 },
  { t: '2026-07-01T07:00:00Z', new_cases: 5, closed: 4, auto_closed: 2, human_closed: 1, system_closed: 1, false_positives: 2, needs_human: 1, escalated: 1, sent_to_human: 1, fp_rate: 50, alerts: 55 },
];

const TRENDS: MetricsTrends = {
  window_hours: 24,
  bucket_minutes: 60,
  generated_at: '2026-07-01T08:00:00Z',
  buckets: BUCKETS,
  truncated: false,
  store_total: 12,
  fetched: 12,
};

/**
 * The 7-day preset: the backend returns 6h buckets for any window <= 168h, so four
 * ticks per day repeat once per day unless the label carries the date.
 */
const TRENDS_7D: MetricsTrends = {
  ...TRENDS,
  window_hours: 168,
  bucket_minutes: 360,
  buckets: [
    { ...BUCKETS[0], t: '2026-07-01T00:00:00Z' },
    { ...BUCKETS[1], t: '2026-07-01T06:00:00Z' },
    { ...BUCKETS[2], t: '2026-07-02T00:00:00Z' },
  ],
};

/** The same buckets with the partition stripped (an older backend's payload). */
const TRENDS_LEGACY: MetricsTrends = {
  ...TRENDS,
  buckets: BUCKETS.map(({ human_closed: _h, system_closed: _s, ...rest }) => rest),
};

describe('reconcilingShares — whole shares that always add to 100', () => {
  it('splits an exact partition into shares summing to 100', () => {
    expect(reconcilingShares([6, 3, 1], 10)).toEqual([60, 30, 10]);
  });

  it('uses largest-remainder so a repeating split still totals exactly 100', () => {
    const out = reconcilingShares([1, 1, 1], 3)!;
    expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out).toEqual([34, 33, 33]);
  });

  it('refuses a set that does NOT reconcile rather than massaging it to 100', () => {
    // 6 + 3 + 1 = 10, not 12 — that is not a partition of the stated total.
    expect(reconcilingShares([6, 3, 1], 12)).toBeNull();
  });

  it('refuses a zero, negative, or non-finite denominator/part (never a synthetic 0%)', () => {
    expect(reconcilingShares([0, 0, 0], 0)).toBeNull();
    expect(reconcilingShares([-1, 2, 1], 2)).toBeNull();
    expect(reconcilingShares([Number.NaN, 1, 1], 2)).toBeNull();
  });
});

describe('Overview — Human vs AI card', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    trendsMock.mockReset();
    fetchPostureMock.mockResolvedValue(posture(QUALITY));
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD' });
    trendsMock.mockResolvedValue(TRENDS);
  });

  it('reports the three-way partition as counts AND shares that sum to exactly 100%', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');

    const sharePct = (band: string): number =>
      Number(
        within(within(card).getByTestId(`human-vs-ai-${band}`))
          .getByText(/^\d+%$/)
          .textContent!.replace('%', ''),
      );

    await waitFor(() =>
      expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('6')).toBeInTheDocument(),
    );
    // Counts: 6 agent + 3 human + 1 residual === the 10 closed cases.
    expect(within(within(card).getByTestId('human-vs-ai-human')).getByText('3')).toBeInTheDocument();
    expect(within(within(card).getByTestId('human-vs-ai-system')).getByText('1')).toBeInTheDocument();
    // Shares over CLOSED cases: 60 + 30 + 10 = 100, with the residual VISIBLE.
    expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('60%')).toBeInTheDocument();
    expect(within(within(card).getByTestId('human-vs-ai-human')).getByText('30%')).toBeInTheDocument();
    expect(within(within(card).getByTestId('human-vs-ai-system')).getByText('10%')).toBeInTheDocument();
    const pcts = ['ai', 'human', 'system'].map(sharePct);
    expect(pcts).toEqual([60, 30, 10]);
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);
    // The denominator is named, so the reader knows what the shares are shares OF.
    expect(within(card).getByText(/Share of closed cases/i)).toBeInTheDocument();
  });

  it('charts the agent and human series together and names the window', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    const chart = await within(card).findByTestId('human-vs-ai-chart');
    // Both series are plotted in ONE labelled figure (recharts renders a line per key).
    const figure = within(chart).getByRole('img', {
      name: /closed by the agent versus by a human/i,
    });
    expect(figure).toBeInTheDocument();
    expect(chart.querySelectorAll('.recharts-line').length).toBe(3);
    expect(within(card).getByText(/last 24 hours · 1h buckets/i)).toBeInTheDocument();
    expect(within(card).queryByTestId('human-vs-ai-no-series')).toBeNull();
  });

  it('discloses that attribution is the LAST decider, not proof of who did the work', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    // The disclosure is reachable from the card's own help affordance.
    expect(
      within(card).getByRole('button', { name: /About Human vs AI attribution/i }),
    ).toBeInTheDocument();
    // …and the advisory (#3) line the removed autonomy card used to carry lives here now.
    expect(within(card).getByText(/never influences that/i)).toBeInTheDocument();
  });

  it('labels raw alert volume as a different population and never divides it into cases', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    const alerts = await within(card).findByTestId('human-vs-ai-alerts');
    // 40 + 30 + 55 ingested, stated as CONTEXT with its population named.
    expect(alerts).toHaveTextContent('125 alerts ingested');
    expect(alerts).toHaveTextContent(/not this case cohort/i);
  });

  it('omits the alert context entirely when any bucket did not report its counters', async () => {
    trendsMock.mockResolvedValue({
      ...TRENDS,
      buckets: BUCKETS.map((b, i) => (i === 1 ? { ...b, alerts: null } : b)),
    });
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    await within(card).findByTestId('human-vs-ai-chart');
    // A warming-up counter is a GAP, not a smaller total quietly presented as fact.
    expect(within(card).queryByTestId('human-vs-ai-alerts')).toBeNull();
  });

  it('falls back to the reconciling bucket sums when the posture rollup is unavailable', async () => {
    fetchPostureMock.mockRejectedValue(new Error('posture unavailable'));
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    // Bucket sums: agent 3+1+2 = 6, human 1+1+1 = 3, residual 0+0+1 = 1, closed 10.
    await waitFor(() =>
      expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('6')).toBeInTheDocument(),
    );
    expect(within(within(card).getByTestId('human-vs-ai-human')).getByText('3')).toBeInTheDocument();
    expect(within(within(card).getByTestId('human-vs-ai-system')).getByText('1')).toBeInTheDocument();
    expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('60%')).toBeInTheDocument();
  });

  it('renders em dashes — never zeros — when the backend does not report attribution', async () => {
    fetchPostureMock.mockResolvedValue(posture(QUALITY_LEGACY));
    trendsMock.mockResolvedValue(TRENDS_LEGACY);
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');

    for (const band of ['ai', 'human', 'system']) {
      const cell = within(card).getByTestId(`human-vs-ai-${band}`);
      expect(within(cell).getAllByText('—')).toHaveLength(2); // count AND share
      expect(within(cell).queryByText('0')).toBeNull();
      expect(within(cell).queryByText('0%')).toBeNull();
    }
    expect(within(card).getByTestId('human-vs-ai-unavailable')).toHaveTextContent(
      /does not report how closed cases were attributed/i,
    );
    // With no human series, a lone agent line would read as "humans closed nothing".
    expect(within(card).getByTestId('human-vs-ai-no-series')).toBeInTheDocument();
    expect(within(card).queryByTestId('human-vs-ai-chart')).toBeNull();
  });

  it('suppresses the shares when the underlying scan was truncated', async () => {
    fetchPostureMock.mockResolvedValue(posture(QUALITY, { truncated: true }));
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    await waitFor(() =>
      expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('6')).toBeInTheDocument(),
    );
    // The counts still stand, but a bounded scan under-counts every band, so no share
    // is claimed and the bound is named rather than silently understating the split.
    for (const band of ['ai', 'human', 'system']) {
      const cell = within(card).getByTestId(`human-vs-ai-${band}`);
      expect(within(cell).getByText('—')).toBeInTheDocument();
    }
    expect(within(card).getByText(/bounded sample, shares unavailable/i)).toBeInTheDocument();
  });

  it('withholds the SAME bounded partition from the KPI strip in that same render', async () => {
    // Regression (HIGH): the card suppressed its shares on `posture.truncated` while
    // the strip a few pixels above published the identical numbers off the identical
    // truncated `posture.quality` — Auto-Resolved's "60% of 10" IS the card's agent
    // band (auto_closed/terminal), and the FP tile printed a rate + sample size taken
    // off the same bounded scan. One page cannot declare a share unmeasurable and
    // print it. Both must go dark, with the bound NAMED, in this one render.
    fetchPostureMock.mockResolvedValue(posture(QUALITY, { truncated: true }));
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    await waitFor(() =>
      expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('6')).toBeInTheDocument(),
    );
    expect(within(card).getByText(/bounded sample, shares unavailable/i)).toBeInTheDocument();

    // Auto-Resolved: the COUNT is still a count, but its share is the card's band.
    const auto = within(screen.getByTestId('kpi-auto-resolved'));
    await waitFor(() => expect(auto.getByText('6')).toBeInTheDocument());
    expect(auto.getByText('—')).toBeInTheDocument();
    expect(auto.queryByText('60% of 10')).toBeNull();
    expect(auto.queryByText(/% of/)).toBeNull();
    expect(auto.getByText('Bounded sample · share unavailable')).toBeInTheDocument();

    // False Positive Rate: the rate's own denominator (verdicted_cases) is bounded
    // too, so the rate AND the sample size behind it are withheld.
    const fp = within(screen.getByTestId('kpi-false-positive-rate'));
    expect(fp.queryByText('50%')).toBeNull();
    expect(fp.queryByText('4 of 8 verdicted')).toBeNull();
    expect(fp.getAllByText('—').length).toBeGreaterThan(0);
    expect(fp.getByText('Bounded sample · share unavailable')).toBeInTheDocument();
  });

  it('withholds the previous window\u2019s partition while the new window is in flight', async () => {
    // Regression: `usePosture` is stale-while-revalidate and Overview deliberately
    // accepts the stale snapshot, but `trends` is REJECTED on a window mismatch — so
    // the card's footer label fell back to the NEWLY selected window while the counts
    // were still the previous one's. The KPI tiles mark that state with a
    // "Loading 7 days" sub; the card had no marker at all.
    const pending: Array<(value: PostureResponse) => void> = [];
    fetchPostureMock.mockImplementation(
      () => new Promise<PostureResponse>((resolve) => pending.push(resolve)),
    );
    const user = userEvent.setup();
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0](posture(QUALITY));

    const card = await screen.findByTestId('human-vs-ai');
    await waitFor(() =>
      expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('6')).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /Time range: Last 24 hours/i }));
    await user.click(
      within(screen.getByRole('group', { name: /Relative time ranges/i })).getByRole('button', {
        name: /Last 7 days/i,
      }),
    );

    // The label already says 7 days, so the 24h counts must NOT be under it.
    expect(within(card).getByText(/last 7 days/i)).toBeInTheDocument();
    for (const band of ['ai', 'human', 'system']) {
      const cell = within(card).getByTestId(`human-vs-ai-${band}`);
      expect(within(cell).getAllByText('—')).toHaveLength(2); // count AND share
    }
    expect(within(card).queryByText('60%')).toBeNull();
    expect(within(card).getByTestId('human-vs-ai-stale')).toBeInTheDocument();

    // …and the fresh 168h payload restores real counts under that same label.
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1](
      posture(
        {
          ...QUALITY,
          auto_closed_cases: 9,
          human_closed_cases: 4,
          system_closed_cases: 2,
          terminal_cases: 15,
        },
        { window_hours: 168 },
      ),
    );
    await waitFor(() =>
      expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('9')).toBeInTheDocument(),
    );
    expect(within(card).queryByTestId('human-vs-ai-stale')).toBeNull();
  });

  it('dates the trend axis when the window spans more than one day', async () => {
    // Regression: `bucketAxisLabel` only dated a tick at bucket_minutes >= 1440, but
    // the backend returns 360-minute buckets for the 7-day preset (and 180 for 72h).
    // The axis therefore read 00:00 06:00 12:00 18:00 seven times over and the tooltip
    // header was a bare "12:00", so a spike could not be located to a day.
    fetchPostureMock.mockImplementation((h: number) =>
      Promise.resolve(posture(QUALITY, { window_hours: h })),
    );
    trendsMock.mockImplementation((h: number) => Promise.resolve(h === 168 ? TRENDS_7D : TRENDS));
    const user = userEvent.setup();
    const { container } = render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    await within(card).findByTestId('human-vs-ai-chart');

    const ticks = () =>
      Array.from(container.querySelectorAll('.recharts-cartesian-axis-tick-value')).map(
        (n) => n.textContent ?? '',
      );
    // A 24h window fits inside one day: a bare HH:mm tick is unambiguous there.
    expect(ticks().length).toBeGreaterThan(0);
    for (const tick of ticks()) expect(tick).toMatch(/^\d{2}:\d{2}$/);

    await user.click(screen.getByRole('button', { name: /Time range: Last 24 hours/i }));
    await user.click(
      within(screen.getByRole('group', { name: /Relative time ranges/i })).getByRole('button', {
        name: /Last 7 days/i,
      }),
    );
    await waitFor(() =>
      expect(ticks().some((t) => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(t))).toBe(true),
    );
    const dated = ticks();
    for (const tick of dated) expect(tick).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    // Two calendar days are distinguishable, which is the whole point.
    expect(new Set(dated.map((t) => t.slice(0, 5))).size).toBeGreaterThan(1);
    expect(new Set(dated).size).toBe(dated.length);
  });

  it('reports unavailable when the partition does not add up to the closed total', async () => {
    fetchPostureMock.mockResolvedValue(
      // 6 + 3 + 1 = 10, but terminal_cases claims 12 — not a partition.
      posture({ ...QUALITY, terminal_cases: 12 }),
    );
    trendsMock.mockResolvedValue(TRENDS_LEGACY);
    render(<Overview onNavigate={vi.fn()} />);
    const card = await screen.findByTestId('human-vs-ai');
    expect(within(card).getByTestId('human-vs-ai-unavailable')).toBeInTheDocument();
    for (const band of ['ai', 'human', 'system']) {
      expect(
        within(within(card).getByTestId(`human-vs-ai-${band}`)).getAllByText('—'),
      ).toHaveLength(2);
    }
  });
});
