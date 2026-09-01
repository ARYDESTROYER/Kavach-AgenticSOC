/**
 * Overview (Cyber Defence Center) — render test for the Stitch-inspired command center.
 *
 * Pins the load-bearing dashboard contract:
 *   1. the PLAIN header (page-hero, no hero card chrome, exactly one h1, PAGE_TITLE,
 *      and NO subtitle line);
 *   2. the un-nested KPI micro-strip of 5 SERVER-FED tiles (Total Cases / Total
 *      Critical / Open Cases / False-Positive-Rate / Resolved-Closed); LLM spend is
 *      NOT a hero tile; every tile pairs its numeral with the honest denominator it is
 *      a share of, and the two that HAVE no denominator (the cohort total itself, and
 *      the window-exempt open stock) say so instead of inventing one;
 *  2b. the tile ANCHORS were re-keyed with the labels — `kpi-open-cases` names the
 *      open stock, not the cohort total, and the retired anchors are gone;
 *  2c. the posture-fed tiles gate on `window_covered`, not on `truncated`;
 *   3. the integrated instrument band = Human vs AI + resolved/open snapshots + latest cases;
 *   4. the operations band = Noise-Reduction flow + compact burndown/timing rail;
 *   5. timing reads the SERVER posture (honest DASH / "not measured" for missing samples);
 *   6. NO period-over-period delta chips on the KPI strip (the FP-rate compare chip was
 *      deliberately removed — its baseline was not explainable at a glance);
 *   7. tiles + snapshot CTAs deep-link to the filtered case list carrying the window;
 *   8. blocking load uses the shared centered Console loading grammar;
 *   9. a window change keeps the last posture snapshot visible (stale-while-revalidate,
 *      labelled by the "Loading Nh" sub) and still discards late cross-window payloads.
 *
 * Fully offline. `noiseReduction` is intentionally omitted so the funnel band self-omits.
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

import Overview, { PAGE_TITLE } from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

const CASES: Case[] = [
  {
    case_id: 'c1',
    status: 'open',
    risk_score: 88, // critical
    source_name: 'Elastic SIEM',
    title: 'Unauthorized S3 access',
    entity: { type: 'ip', value: '10.0.0.1' },
  },
  {
    case_id: 'c2',
    status: 'needs_human',
    risk_score: 65, // high
    source_name: 'Wazuh',
    title: 'Brute force: Auth-GW',
    entity: { type: 'host', value: 'web-01' },
  },
  {
    case_id: 'c3',
    status: 'resolved',
    risk_score: 20, // low
    source_name: 'Elastic SIEM',
    entity: { type: 'user', value: 'alice' },
  },
] as unknown as Case[];

const METRICS: Metrics = {
  total_cases: 3,
  open_cases: 1,
  needs_human_cases: 1,
  closed_cases: 1,
  by_status: { open: 1, needs_human: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 1, none: 0 },
  persona_usage: {},
  playbook_usage: {},
  avg_risk_score: 57,
  mttr_minutes: 120,
  resolved_count: 1,
  cases_per_day: [],
  burndown: [
    { date: '2026-06-30', opened: 4, resolved: 2 },
    { date: '2026-07-01', opened: 3, resolved: 5 },
  ],
  timing_trend: [
    { date: '2026-06-30', mttd: 12, respond: 30, resolve: 180 },
    { date: '2026-07-01', mttd: null, respond: 45, resolve: null },
  ],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const QUALITY = {
  // `total_cases` here is deliberately DIFFERENT from the posture `case_count` below:
  // `quality_metrics` strips policy-closed rows first, so the Total Cases tile must
  // read `case_count` (4) and never this narrower field (3).
  total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
  needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
  alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
  containment_rate: 0.5, automation_rate: 0.5,
};

/** QUALITY plus the complete three-way close partition (agent + analyst + residual). */
const QUALITY_ATTRIBUTED = {
  ...QUALITY,
  terminal_cases: 9,
  auto_closed_cases: 5,
  human_closed_cases: 3,
  system_closed_cases: 1,
};

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  // The window's ARRIVAL COHORT, policy-closed included — 4, one more than the
  // policy-stripped `quality.total_cases`, and one more than the 3 rows the bounded
  // case page happens to hold. Both differences are deliberate.
  case_count: 4,
  // The server-side band partition of `case_count` (sums to it exactly).
  severity_counts: { critical: 1, high: 1, medium: 1, low: 1, info: 0 },
  // The window-EXEMPT open STOCK: 5 cases are open right now, MORE than the window
  // cohort holds, because older still-open cases count toward a stock.
  open_now: {
    count: 5,
    window_exempt: true,
    as_of: '2026-07-01T08:00:00Z',
    complete: true,
    reason: '',
  },
  window_covered: true,
  window_coverage_reason: '',
  oldest_fetched_at: '2026-06-30T08:00:00Z',
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    // Unavailable → the timing card must show the honest reason, never a fake number.
    dwell_minutes: {
      p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false,
      reason: 'no case has received a first response yet',
    },
    // mttd_minutes intentionally ABSENT → the MTTD stat must read "not measured".
  },
  quality: QUALITY,
  aging: {
    queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1,
    closure_vs_arrival: 0.33, backlog: 2,
  },
  sla: {
    enabled: true, evaluated: 2, response_breached: 1, response_at_risk: 1,
    resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 87.5, breaching: [],
  },
};

/** Same posture, plus a period-over-period `compare` block (wires the KPI deltas). */
const POSTURE_CMP: PostureResponse = {
  ...POSTURE,
  compare: {
    mode: 'prev',
    case_count: { value: 3, prev: 4, delta_pct: -25 },
    alert_to_incident_ratio: { value: 0.33, prev: 0.4, delta_pct: -17.5 },
    false_positive_rate: { value: 0.5, prev: 0.6, delta_pct: -16.7 },
    escalation_rate: { value: 0.33, prev: 0.5, delta_pct: -20 },
    automation_rate: { value: 0.5, prev: 0.4, delta_pct: 25 },
    mttr_p50: { value: 180, prev: 200, delta_pct: -10 },
    mtta_p50: { value: 45, prev: 40, delta_pct: 12.5 },
  },
};

describe('Overview — Cyber Defence Center (rebuild)', () => {
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

  it('keeps dashboard controls in the plain title header without a redundant status row', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    const hero = await screen.findByTestId('page-hero');
    expect(hero).not.toHaveClass('hero-display');
    expect(hero).not.toHaveClass('bg-card');
    // Exactly one page-level h1 (the title) lives in the header.
    expect(hero.querySelectorAll('h1')).toHaveLength(1);
    expect(hero).toHaveTextContent(PAGE_TITLE);
    // The masthead carries the title and the controls — nothing else. The former
    // "Live operational posture across triage, risk, and response." subtitle described
    // the page rather than telling the operator anything, and is gone.
    expect(within(hero).queryByText(/Live operational posture/i)).toBeNull();
    const controls = within(hero).getByRole('group', { name: 'Dashboard controls' });
    expect(screen.queryByText('Operational window')).toBeNull();
    expect(screen.queryByText(/^Last polled /)).toBeNull();
    const range = within(controls).getByRole('button', { name: /Time range: Last 24 hours/i });
    expect(range).toHaveTextContent('Last 24h');
    expect(range).toHaveClass('rounded-[3px]', 'bg-transparent');
    expect(within(controls).getByRole('combobox', { name: /Auto-refresh interval: LIVE/i })).toHaveClass(
      'rounded-[3px]',
      'bg-transparent',
    );
    const manualRefresh = within(controls).getByRole('button', { name: 'Refresh dashboard' });
    expect(manualRefresh).toHaveClass(
      'rounded-[3px]',
      'bg-transparent',
      'text-success-text',
    );
    expect(manualRefresh.querySelector('.lucide-refresh-cw')).toHaveClass('animate-spin');
  });

  it('renders the KPI micro-strip: 5 server-fed tiles (LLM spend NOT a hero tile)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());
    const strip = screen.getByTestId('kpi-strip');
    for (const id of [
      'kpi-total-cases',
      'kpi-total-critical',
      'kpi-open-cases',
      'kpi-false-positive-rate',
      'kpi-resolved-closed',
    ]) {
      expect(within(strip).getByTestId(id)).toBeInTheDocument();
    }
    // The rename was a SWAP, not five string edits: `kpi-open-cases` survives but now
    // names the open STOCK, and every anchor whose metric moved away is gone. A
    // label-only edit would have left these three in place, carrying the wrong number.
    for (const retired of [
      'kpi-critical',
      'kpi-critical-high',
      'kpi-escalated-to-human',
      'kpi-auto-resolved',
    ]) {
      expect(within(strip).queryByTestId(retired)).toBeNull();
    }
    // EXACTLY 5 hero tiles.
    expect(strip.querySelectorAll('[data-testid^="kpi-"]')).toHaveLength(5);
    // Spend is not on the strip.
    expect(within(strip).queryByTestId('kpi-llm-spend')).toBeNull();

    // Total Cases = the posture window's ARRIVAL COHORT (4), NOT the policy-stripped
    // `quality.total_cases` (3) and NOT the bounded case page (3 rows).
    const totalCases = within(screen.getByTestId('kpi-total-cases'));
    expect(totalCases.getByText('4')).toBeInTheDocument();
    expect(totalCases.getByText('Arrivals in this window · policy-closed included')).toBeInTheDocument();
    // Total Critical = the SERVER band tally, not a band counted over the page.
    expect(within(screen.getByTestId('kpi-total-critical')).getByText('1')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-total-critical')).getByText('Critical band · counted server-side'),
    ).toBeInTheDocument();
    // Open Cases = the window-EXEMPT stock (5), which is deliberately LARGER than the
    // 4-case window cohort — proof it is not being window-filtered — and its sub says
    // so, so it can never be read as summing with the four cohort tiles.
    const openCases = within(screen.getByTestId('kpi-open-cases'));
    expect(openCases.getByText('5')).toBeInTheDocument();
    expect(openCases.getByText('Open now · not window-filtered')).toBeInTheDocument();
    // False-positive rate reads the server quality rate (0.5 → "50%").
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('Closed as false positive'),
    ).toBeInTheDocument();
    // Resolved / Closed = TERMINAL cases (1), not the agent-only auto-closed subset.
    const resolved = within(screen.getByTestId('kpi-resolved-closed'));
    expect(resolved.getByText('1')).toBeInTheDocument();
    expect(resolved.getByText('Reached a terminal state')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-total-cases')).toHaveClass('min-h-28', 'px-4', 'py-5');
  });

  it('pairs every KPI numeral with the honest denominator it is a share of', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    // Total Critical + Resolved / Closed are both shares of the SAME `case_count` (4),
    // and both come off the one posture payload, so numerator and denominator always
    // describe the same population.
    expect(
      within(screen.getByTestId('kpi-total-critical')).getByText('25% of 4'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-resolved-closed')).getByText('25% of 4'),
    ).toBeInTheDocument();
    // Total Cases IS that denominator, so it carries no share of its own — and no em
    // dash either, which would read as "a denominator we could not measure".
    const totalCases = within(screen.getByTestId('kpi-total-cases'));
    expect(totalCases.queryByText(/% of/)).toBeNull();
    expect(totalCases.queryByText('—')).toBeNull();
    // Open Cases is a window-EXEMPT stock: no window population reconciles with it, so
    // it shows an em dash and NAMES why in its sub rather than inventing a share.
    const openCases = within(screen.getByTestId('kpi-open-cases'));
    await waitFor(() => expect(openCases.getByText('5')).toBeInTheDocument());
    expect(openCases.getByText('—')).toBeInTheDocument();
    expect(openCases.queryByText(/% of/)).toBeNull();
    expect(openCases.getByText('Open now · not window-filtered')).toBeInTheDocument();
    // FP rate is ALREADY a percent, so its context is the sample size behind it.
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('1 of 2 verdicted'),
    ).toBeInTheDocument();
  });

  const STRIP_IDS = [
    'kpi-total-cases',
    'kpi-total-critical',
    'kpi-open-cases',
    'kpi-false-positive-rate',
    'kpi-resolved-closed',
  ] as const;

  it('renders an em dash — never 0% — on every tile when the posture rollup is missing', async () => {
    // Every tile on the strip is posture-fed now, so a failed rollup means NOTHING on
    // it was measured. Each must say so, and none may substitute a client count off
    // the bounded case page — a 200-row cap is not the window population.
    const capped: Case[] = Array.from({ length: 200 }, (_, i) => ({
      case_id: `cap-${i}`,
      status: i % 2 === 0 ? 'open' : 'closed',
      risk_score: 90,
    })) as unknown as Case[];
    listCasesMock.mockResolvedValue({ cases: capped, total: 4000, window_total_exact: true });
    fetchPostureMock.mockRejectedValue(new Error('posture unavailable'));
    getMetricsMock.mockResolvedValue({ ...METRICS, total_cases: 0, needs_human_cases: undefined });

    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    for (const id of STRIP_IDS) {
      const tile = within(screen.getByTestId(id));
      // (The FP-rate tile shows an em dash TWICE — its unmeasurable rate and its
      // unmeasurable sample size — hence the All-variant.)
      await waitFor(() => expect(tile.getAllByText('—').length).toBeGreaterThan(0));
      expect(tile.queryByText(/0% of/)).toBeNull();
      expect(tile.queryByText(/0 of /)).toBeNull();
      // The absence is NAMED, so it reads as evidence rather than an omission — and
      // the 100 open rows in the page below are never quoted as the open count.
      expect(tile.getByText('Posture unavailable')).toBeInTheDocument();
      expect(tile.queryByText('100')).toBeNull();
    }
  });

  it('keeps the COUNTS but withholds every share when the window was not fully covered', async () => {
    // `window_covered: false` says rows that could satisfy the selected window were
    // never read, so every band is a floor. A floor is still a number an operator can
    // act on, so the counts stay and only the shares go dark — with the bound named.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      truncated: true,
      store_total: 40_000,
      fetched: 5_000,
      window_covered: false,
      window_coverage_reason:
        'the fetch was truncated and the selected window starts before the oldest fetched case',
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');

    const totalCases = within(await screen.findByTestId('kpi-total-cases'));
    await waitFor(() => expect(totalCases.getByText('4')).toBeInTheDocument());
    expect(totalCases.getByText('Partial window · lower bound')).toBeInTheDocument();

    const critical = within(screen.getByTestId('kpi-total-critical'));
    expect(critical.getByText('1')).toBeInTheDocument();
    expect(critical.getByText('—')).toBeInTheDocument();
    expect(critical.queryByText(/% of/)).toBeNull();
    expect(critical.getByText('Bounded sample · share unavailable')).toBeInTheDocument();

    // The FP RATE is itself a share of a bounded denominator, so the rate AND the
    // sample size behind it are both withheld.
    const fp = within(screen.getByTestId('kpi-false-positive-rate'));
    expect(fp.queryByText('50%')).toBeNull();
    expect(fp.queryByText('1 of 2 verdicted')).toBeNull();
    expect(fp.getAllByText('—').length).toBeGreaterThan(0);

    const resolved = within(screen.getByTestId('kpi-resolved-closed'));
    expect(resolved.getByText('1')).toBeInTheDocument();
    expect(resolved.queryByText(/% of/)).toBeNull();
  });

  it('publishes the shares when window_covered rescues a truncated fetch', async () => {
    // The regression this replaces: gating on `truncated` alone. Any store above the
    // route's fetch bound is truncated permanently, so the strip went dark forever
    // even when the operator asked for a window that WAS read end to end.
    // `window_covered` is the narrower, checkable claim, and it must win.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      truncated: true,
      store_total: 40_000,
      fetched: 5_000,
      window_covered: true,
      window_coverage_reason: '',
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const critical = within(await screen.findByTestId('kpi-total-critical'));
    await waitFor(() => expect(critical.getByText('25% of 4')).toBeInTheDocument());
    expect(critical.queryByText('Bounded sample · share unavailable')).toBeNull();
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%'),
    ).toBeInTheDocument();
  });

  it('falls back to the truncation flag when the server predates window_covered', async () => {
    // An older backend emits `truncated` and no coverage flag. The absence of the
    // narrower claim is not permission to publish: the old rule still applies.
    const { window_covered: _covered, ...legacy } = POSTURE;
    fetchPostureMock.mockResolvedValue({ ...legacy, truncated: true, store_total: 999 });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const critical = within(await screen.findByTestId('kpi-total-critical'));
    await waitFor(() =>
      expect(critical.getByText('Bounded sample · share unavailable')).toBeInTheDocument(),
    );
    expect(critical.queryByText(/% of/)).toBeNull();
  });

  it('never borrows the all-time /api/metrics fetch cap as a strip denominator', async () => {
    // Regression: `GET /api/metrics` is NOT window-filtered and is hard-capped at the
    // newest 2,000 cases with NO truncation marker, so `total_cases` is a fetch bound.
    // The strip used to divide `needs_human_cases` by it and print "7% of 2,000"
    // beside a TimeRangePicker set to (say) the last hour — a cap dressed as a
    // population. No tile reads that payload at all now; this pins that it stays so.
    getMetricsMock.mockResolvedValue({
      ...METRICS,
      total_cases: 2000,
      needs_human_cases: 137,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const strip = within(await screen.findByTestId('kpi-strip'));
    await waitFor(() =>
      expect(within(screen.getByTestId('kpi-total-cases')).getByText('4')).toBeInTheDocument(),
    );
    expect(strip.queryByText(/of 2,000/)).toBeNull();
    expect(strip.queryByText('137')).toBeNull();
  });

  it('renders "<1%" — never a rounded-down 0% — for a real but tiny band', async () => {
    // Regression: `shareContext` rounded 1/5,000 to "0% of 5,000" beside a non-zero
    // numeral, which reads as "nothing is critical" when one case is. The
    // Noise-Reduction funnel already floors at "<1%"; the strip shares that rule.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 5000,
      severity_counts: { critical: 1, high: 0, medium: 0, low: 4999, info: 0 },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = within(await screen.findByTestId('kpi-total-critical'));
    await waitFor(() => expect(tile.getByText('<1% of 5,000')).toBeInTheDocument());
    expect(tile.queryByText('0% of 5,000')).toBeNull();
    // A genuine zero still reads "0%" — the floor applies only to a non-zero count.
    expect(tile.queryByText(/^0%/)).toBeNull();
  });

  it('states the close partition INSIDE the Resolved / Closed tile as three rows, never two', async () => {
    // `engine/metrics.py` forbids `human = terminal - auto_closed`: that difference
    // absorbs the SYSTEM/legacy residual into the analyst band. The tile therefore
    // renders all three server keys, and the residual stays visible.
    fetchPostureMock.mockResolvedValue({ ...POSTURE, quality: QUALITY_ATTRIBUTED });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('9')).toBeInTheDocument());

    // The list is a SIBLING of the trigger, not a child of it: `role=button` is
    // children-presentational, so a <dl> inside the tile button would be flattened
    // into the disclosure's accessible name and lose every dt/dd relationship.
    expect(tile.querySelector('dl')).toBeNull();
    const partition = screen.getByTestId('kpi-resolved-closed-breakdown');
    const rows = partition.querySelectorAll('dl > dt');
    expect(Array.from(rows).map((r) => r.textContent)).toEqual(['AI agent', 'Human', 'System']);
    const values = partition.querySelectorAll('dl > dd');
    expect(Array.from(values).map((v) => v.textContent)).toEqual(['5', '3', '1']);
    // The three bands reconcile with the numeral above them — 5 + 3 + 1 === 9 — so the
    // "Human" row can never be the 4 that `terminal − auto` would have printed.
    expect(within(tile).queryByText('4')).toBeNull();
    // …and the SAME partition is stated once more by the instrument card below, from
    // the same memo, so the two surfaces cannot disagree.
    const card = within(screen.getByTestId('human-vs-ai'));
    expect(within(card.getByTestId('human-vs-ai-human')).getByText('3')).toBeInTheDocument();
    expect(within(card.getByTestId('human-vs-ai-system')).getByText('1')).toBeInTheDocument();
  });

  it('counts a POLICY-CLOSED case in Resolved / Closed, and names it in the partition', async () => {
    // `quality_metrics` strips operator "declared benign" closes before it counts
    // anything, so `terminal_cases` is a policy-EXCLUSIVE number while `case_count`,
    // this tile's drill-down `match` (CLOSED_STATUSES) and its `__terminal__` deep link
    // are all policy-INCLUSIVE. Dividing one by the other put the numeral and its own
    // denominator on two different populations, and the panel listed rows the numeral
    // did not count. The tile therefore reports terminal + policy-closed.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 10,
      quality: {
        ...QUALITY_ATTRIBUTED,
        total_cases: 5,
        terminal_cases: 5,
        auto_closed_cases: 3,
        human_closed_cases: 1,
        system_closed_cases: 1,
        policy_closed_cases: 5,
      },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    // 5 agent-worked terminal + 5 declared benign === 10 of 10 arrivals.
    await waitFor(() => expect(within(tile).getByText('10')).toBeInTheDocument());
    expect(within(tile).getByText('100% of 10')).toBeInTheDocument();
    expect(within(tile).queryByText('50% of 10')).toBeNull();

    // The partition still sums to the numeral above it — now with a fourth band.
    const partition = screen.getByTestId('kpi-resolved-closed-breakdown');
    expect(Array.from(partition.querySelectorAll('dl > dt')).map((n) => n.textContent)).toEqual([
      'AI agent',
      'Human',
      'System',
      'Declared benign',
    ]);
    expect(Array.from(partition.querySelectorAll('dl > dd')).map((n) => n.textContent)).toEqual([
      '3',
      '1',
      '1',
      '5',
    ]);
  });

  it('omits the declared-benign band when the backend does not report it', async () => {
    // A backend that omits `policy_closed_cases` is one that never stripped them (the
    // exclusion and the field shipped together), so its `terminal_cases` already counts
    // them and there is no fourth band to state.
    fetchPostureMock.mockResolvedValue({ ...POSTURE, quality: QUALITY_ATTRIBUTED });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('9')).toBeInTheDocument());
    const partition = screen.getByTestId('kpi-resolved-closed-breakdown');
    expect(Array.from(partition.querySelectorAll('dl > dt')).map((n) => n.textContent)).toEqual([
      'AI agent',
      'Human',
      'System',
    ]);
  });

  it('renders an unreadable case store as NOT MEASURED, never as four zeros', async () => {
    // `routes_metrics` soft-fails an unreadable case store and STILL answers HTTP 200,
    // so neither the loading nor the error arm fires. `posture_metrics(load_ok=False)`
    // then returns structural zeros: case_count 0, every band 0, terminal 0, open_now 0.
    // Published unqualified they read as a quiet, healthy, empty SOC — and the
    // "partial window · lower bound" caption would call those zeros a floor of a real
    // population. The discriminator is exact: `truncated !== true && !window_covered`
    // is reachable only through the outage arm.
    const REASON =
      'the case store could not be read, so this population was not measured; ' +
      'the figures shown are not a count of anything';
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 0,
      severity_counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      open_now: {
        count: 0,
        window_exempt: true,
        as_of: '2026-07-01T08:00:00Z',
        complete: false,
        reason: REASON,
      },
      truncated: false,
      window_covered: false,
      window_coverage_reason: REASON,
      quality: { ...QUALITY, total_cases: 0, verdicted_cases: 0, terminal_cases: 0 },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const strip = await screen.findByTestId('kpi-strip');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    for (const id of [
      'kpi-total-cases',
      'kpi-total-critical',
      'kpi-open-cases',
      'kpi-false-positive-rate',
      'kpi-resolved-closed',
    ]) {
      const tile = within(screen.getByTestId(id));
      await waitFor(() => expect(tile.getAllByText('—').length).toBeGreaterThan(0));
      expect(tile.queryByText('0'), `${id} published a zero it never measured`).toBeNull();
      expect(tile.queryByText('0%')).toBeNull();
    }
    // No tile may caption its blank as a lower bound of anything.
    expect(within(strip).queryByText(/lower bound/)).toBeNull();
    // Every posture-fed tile states the server's OWN account of the gap.
    expect(within(strip).getAllByText(REASON).length).toBe(5);
    // …and the close partition is withheld with them, on BOTH surfaces that read it:
    // 0 + 0 + 0 === 0 passes the reconciliation guard, so an outage would otherwise
    // publish a three-band partition of a window nothing was read from.
    expect(screen.queryByTestId('kpi-resolved-closed-breakdown')).toBeNull();
    const card = within(screen.getByTestId('human-vs-ai'));
    expect(within(card.getByTestId('human-vs-ai-ai')).queryByText('0')).toBeNull();
    expect(within(card.getByTestId('human-vs-ai-human')).queryByText('0')).toBeNull();
    expect(within(card.getByTestId('human-vs-ai-system')).queryByText('0')).toBeNull();
    expect(screen.getByTestId('human-vs-ai')).toHaveTextContent(REASON);
  });

  it('renders NO close breakdown when the server reports only part of the partition', async () => {
    // Two of three keys is not a partition. Rendering the two it has would fold the
    // residual into whichever band the reader assumes — the exact over-statement.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      quality: { ...QUALITY_ATTRIBUTED, system_closed_cases: undefined },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('9')).toBeInTheDocument());
    expect(tile.querySelector('dl')).toBeNull();
    expect(screen.queryByTestId('kpi-resolved-closed-breakdown')).toBeNull();
    // Scoped to the strip: the instrument card below legitimately names the same band.
    expect(within(screen.getByTestId('kpi-strip')).queryByText('AI agent')).toBeNull();
  });

  it('keeps a ZERO residual visible in the close breakdown', async () => {
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      quality: {
        ...QUALITY,
        terminal_cases: 8,
        auto_closed_cases: 6,
        human_closed_cases: 2,
        system_closed_cases: 0,
      },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('8')).toBeInTheDocument());
    // Folding a zero band away would leave a two-row split that reads as the whole
    // story; the row stays, showing 0.
    const partition = screen.getByTestId('kpi-resolved-closed-breakdown');
    const rows = Array.from(partition.querySelectorAll('dl > dt')).map((r) => r.textContent);
    expect(rows).toEqual(['AI agent', 'Human', 'System']);
    expect(Array.from(partition.querySelectorAll('dl > dd')).map((v) => v.textContent)).toEqual([
      '6',
      '2',
      '0',
    ]);
  });

  it('keeps the last posture snapshot visible (labelled stale) across a window change, then swaps atomically', async () => {
    const requests: Array<{
      hours: number;
      signal: AbortSignal;
      resolve: (value: PostureResponse) => void;
    }> = [];
    fetchPostureMock.mockImplementation(
      (hours: number, _compare: string, signal: AbortSignal) =>
        new Promise<PostureResponse>((resolve) => requests.push({ hours, signal, resolve })),
    );
    const user = userEvent.setup();
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(requests).toHaveLength(1));

    requests[0].resolve({
      ...POSTURE_CMP,
      quality: { ...POSTURE_CMP.quality, false_positive_rate: 0.48, terminal_cases: 25 },
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('48%')).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId('kpi-resolved-closed')).getByText('25')).toBeInTheDocument();

    // Manual refresh and LIVE ticks share `refreshAll`; leave this 24h pulse in
    // flight to reproduce the production interleave at the range boundary.
    await user.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].hours).toBe(24);

    await user.click(screen.getByRole('button', { name: /Time range: Last 24 hours/i }));
    await user.click(
      within(screen.getByRole('group', { name: /Relative time ranges/i })).getByRole(
        'button',
        { name: /Last 7 days/i },
      ),
    );

    // STALE-WHILE-REVALIDATE: the previous snapshot's numbers stay mounted while
    // 168h is in flight — no perceived blanking — and the "Loading 7 days" sub is
    // the explicit stale/refresh indicator on the posture tiles.
    expect(screen.getByRole('button', { name: /Time range: Last 7 days/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('48%')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-resolved-closed')).getByText('25')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('Loading 7 days'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-resolved-closed')).getByText('Loading 7 days'),
    ).toBeInTheDocument();

    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[1].signal.aborted).toBe(true);
    expect(requests[2].hours).toBe(168);
    requests[2].resolve({
      ...POSTURE_CMP,
      window_hours: 168,
      lifecycle: {
        ...POSTURE_CMP.lifecycle,
        // A distinct 168h ACK clock — the plain-text Respond stat proves the swap
        // (the KPI numerals roll via the motion spring, so a static text consumer
        // is the reliable fresh-payload witness).
        mtta_minutes: { p50: 240, p90: 600, mean: 300, max: 900, count: 9, available: true, reason: '' },
      },
      quality: {
        ...POSTURE_CMP.quality,
        total_cases: 1412,
        false_positive_cases: 1173,
        false_positive_rate: 0.8307,
        terminal_cases: 1355,
      },
      compare: {
        ...POSTURE_CMP.compare!,
        false_positive_rate: { value: 0.8307, prev: 0.8628, delta_pct: -3.7 },
      },
    });
    // The fresh 168h payload replaces the stale snapshot atomically...
    const timingRegion = screen.getByRole('region', { name: /Mean time to detect/i });
    await waitFor(() => expect(within(timingRegion).getByText('4h')).toBeInTheDocument());
    // ...and the stale indicator clears with it (the subs return to their captions).
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).queryByText('Loading 7 days'),
    ).toBeNull();
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('Closed as false positive'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-resolved-closed')).getByText('Reached a terminal state'),
    ).toBeInTheDocument();

    // Even if the aborted transport settles late, its 24h data remains discarded.
    requests[1].resolve({
      ...POSTURE_CMP,
      lifecycle: {
        ...POSTURE_CMP.lifecycle,
        mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
      },
      quality: { ...POSTURE_CMP.quality, false_positive_rate: 0.49, terminal_cases: 25 },
    });
    await Promise.resolve();
    expect(within(timingRegion).getByText('4h')).toBeInTheDocument();
    expect(within(timingRegion).queryByText('45m')).toBeNull();
  });

  it('mounts the instrument band: Human vs AI + two donut snapshots + latest cases', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const heroRow = await screen.findByTestId('hero-row');
    // The close-attribution instrument, exactly once, inside the hero row. The Active
    // Risk Index gauge it replaced is gone from the landing page entirely.
    expect(within(heroRow).getByTestId('human-vs-ai')).toBeInTheDocument();
    expect(screen.getAllByTestId('human-vs-ai')).toHaveLength(1);
    expect(screen.queryByTestId('active-risk-index')).toBeNull();
    // The two snapshot headings (h2) — resolved + open case donuts.
    expect(screen.getByRole('heading', { name: 'Cases resolved', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Open cases', level: 2 })).toBeInTheDocument();
    // Operational order is live queue first, terminal history second.
    const lifecycle = within(heroRow).getByRole('region', { name: 'Resolved and open cases' });
    expect(
      within(lifecycle)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Open cases', 'Cases resolved']);
    // The resolved snapshot severity ring is present + labelled.
    const resolvedRing = screen.getByRole('img', { name: /Resolved cases by severity/i });
    const openRing = screen.getByRole('img', { name: /Open cases by severity/i });
    expect(resolvedRing).toBeInTheDocument();
    expect(openRing).toBeInTheDocument();
    expect(resolvedRing).toHaveClass('w-36');
    expect(resolvedRing).toHaveStyle({ height: '136px' });
    expect(openRing).toHaveClass('w-36');
    expect(openRing).toHaveStyle({ height: '136px' });

    // The parent panel no longer repeats what each snapshot already says.
    expect(screen.queryByText('Resolved & open cases', { exact: true })).toBeNull();
    expect(screen.queryByText(/Lifecycle snapshot/i)).toBeNull();

    // Bug #1: the donut hole no longer DUPLICATES the card's full <h2> title — each
    // multi-word title appears exactly once (the heading), never a second time in the ring.
    expect(screen.getAllByText('Cases resolved', { exact: true })).toHaveLength(1);
    expect(screen.getAllByText('Open cases', { exact: true })).toHaveLength(1);

    // The ring centers contain numbers only; the headings already identify each lifecycle.
    expect(within(resolvedRing).queryByText('res', { exact: true })).toBeNull();
    expect(within(openRing).queryByText('open', { exact: true })).toBeNull();

    // The larger ring earns a larger, vertically centered numeral for normal totals.
    const resolvedTotal = within(resolvedRing).getAllByTestId('count-up')[0];
    expect(resolvedTotal).toHaveClass('text-3xl', 'leading-none');
    expect(resolvedTotal.parentElement).toHaveClass('items-center', 'justify-center');

    // Latest Cases is the supplied prototype row treatment: ID + title + age + status,
    // with the old severity dot/source/risk/chevron/footer removed.
    const latest = screen.getByRole('region', { name: /Latest cases/i });
    const firstCase = within(latest).getByRole('button', { name: /Open case Unauthorized S3 access/i });
    expect(within(firstCase).getByText('c1')).toBeInTheDocument();
    expect(within(firstCase).getByText('Unauthorized S3 access')).toBeInTheDocument();
    expect(within(firstCase).getByText('Open')).toBeInTheDocument();
    expect(within(latest).getByText('Escalated')).toBeInTheDocument();
    expect(within(latest).queryByText('Triage')).toBeNull();
    expect(within(firstCase).queryByText('Elastic SIEM')).toBeNull();
    expect(within(firstCase).queryByText('88')).toBeNull();
    expect(firstCase.querySelector('svg')).toBeNull();
    expect(within(latest).queryByText('Review escalations')).toBeNull();

    // The page masthead keeps the title clean; SLA posture still exists in Metrics.
    expect(within(screen.getByTestId('page-hero')).queryByText(/^SLA\s/i)).toBeNull();
  });

  it('shows only the four newest cases and reveals richer case context on hover', async () => {
    const five: Case[] = Array.from({ length: 5 }, (_, i) => ({
      case_id: `latest-${i + 1}`,
      case_number: `#CS-${9001 + i}`,
      title: `Latest case ${i + 1}`,
      summary: i === 4 ? 'Rich hover-only investigation summary.' : `Summary ${i + 1}`,
      status: i === 4 ? 'investigating' : 'open',
      risk_score: 40 + i,
      created_at: `2026-07-01T0${i + 1}:00:00Z`,
      updated_at: `2026-07-01T0${i + 1}:30:00Z`,
      source_name: 'Demo SIEM',
      entity: { type: 'host', value: `host-${i + 1}` },
    })) as unknown as Case[];
    listCasesMock.mockResolvedValue({ cases: five, total: five.length });

    render(<Overview onNavigate={vi.fn()} />);
    const latest = await screen.findByRole('region', { name: /Latest cases/i });
    const caseRows = within(latest).getAllByRole('button', { name: /^Open case /i });
    expect(caseRows).toHaveLength(4);
    expect(within(latest).getByText('Latest case 5')).toBeInTheDocument();
    expect(within(latest).queryByText('Latest case 1')).toBeNull();

    await userEvent.hover(caseRows[0]);
    expect(await screen.findByText('Rich hover-only investigation summary.')).toBeInTheDocument();
    expect(screen.getByText('host-5')).toBeInTheDocument();
    expect(screen.getByText('Demo SIEM')).toBeInTheDocument();
  });

  it('abbreviates a 4+ digit SnapshotCard center total so it never clips the ~71px donut hole (#minor)', async () => {
    // 1,234 closed cases -> `derived.resolved` = 1234. At the pinned 136px donut
    // (innerPct=52%, overflow-hidden), the raw thousands-separated "1,234" (fmtInt)
    // risks crowding the ~71px hole. The center must instead show
    // the compact form ("1.2K"); the legend row beside it keeps the exact count.
    const many: Case[] = Array.from({ length: 1234 }, (_, i) => ({
      case_id: `bulk-${i}`,
      status: 'closed',
      risk_score: 15, // 'low' band (8-21 -> low, not 'info'); out of the critical/high KPI counts
      source_name: 'Elastic SIEM',
      entity: { type: 'ip', value: '10.0.0.1' },
    }));
    listCasesMock.mockResolvedValue({ cases: many, total: many.length });

    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const resolvedRing = await screen.findByRole('img', { name: /Resolved cases by severity/i });

    // The center count-up shows the ABBREVIATED form, never the raw grouped digits.
    expect(within(resolvedRing).getByText('1.2K')).toBeInTheDocument();
    expect(within(resolvedRing).queryByText('1,234')).toBeNull();
    expect(within(resolvedRing).getAllByTestId('count-up')[0]).toHaveClass('text-2xl');

    // The legend row keeps the exact, unabbreviated count for the (sole) severity band.
    const legendRow = screen.getByText('Low', { exact: true }).closest('li')!;
    expect(within(legendRow).getByText('1,234')).toBeInTheDocument();
  });

  it('leads with the burndown · detect/respond · top-cases zone', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    for (const name of [
      /Cases burndown/i,
      /Mean time to detect \/ respond/i,
      /Latest cases/i,
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('reads timing from the SERVER posture, honoring the honest "not measured" DASH', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const timingRegion = screen.getByRole('region', { name: /Mean time to detect/i });
    expect(timingRegion).toBeInTheDocument();
    // MTTD has no posture block here → an explicit "not measured", never a fabricated number.
    await waitFor(() => expect(screen.getByText(/not measured/i)).toBeInTheDocument());
    // "Respond" reads the ACK clock (mtta_minutes, p50 45) — the first HUMAN response, NOT
    // dwell (which would count an AI auto-close as a response). So it shows the honest value.
    expect(within(timingRegion).getByText('45m')).toBeInTheDocument();
    expect(fetchPostureMock).toHaveBeenCalled();
    // The posture fetch requests the period-over-period compare block.
    expect(fetchPostureMock).toHaveBeenCalledWith(
      expect.any(Number),
      'prev',
      expect.any(AbortSignal),
    );
  });

  it('renders NO period-over-period delta chip on any KPI tile (FP-rate compare removed)', async () => {
    fetchPostureMock.mockResolvedValue(POSTURE_CMP);
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() =>
      expect(
        within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%'),
      ).toBeInTheDocument(),
    );
    // The FP-rate tile shows the rate ONLY — the "-16.7%" compare chip is gone (its
    // baseline was not explainable at a glance) and no other tile borrows a delta
    // (a KpiTile delta was the only role="img" in a tile, so its absence proves it).
    for (const id of STRIP_IDS) {
      // The scale-context slot beside each numeral — and the in-tile close-attribution
      // <dl> — are PLAIN text on purpose: neither may re-introduce the delta chip's
      // role="img" or judgement colour.
      expect(within(screen.getByTestId(id)).queryByRole('img')).toBeNull();
    }
    const strip = screen.getByTestId('kpi-strip');
    expect(within(strip).queryByText('-16.7%')).toBeNull(); // false_positive_rate
    expect(within(strip).queryByText('-20%')).toBeNull(); // escalation_rate
    expect(within(strip).queryByText('+25%')).toBeNull(); // automation_rate
    expect(within(strip).queryByText('-25%')).toBeNull(); // case_count
    // With no deltas left, the comparison footnote is gone too.
    expect(screen.queryByText(/Deltas compare the previous/i)).toBeNull();
  });

  /** Open a tile's drill-down and hand back its drill-through button. */
  async function openDrillThrough(testId: string): Promise<HTMLElement> {
    await userEvent.click(await screen.findByTestId(testId));
    await screen.findByTestId('kpi-drilldown');
    return screen.getByTestId('kpi-drilldown-drillthrough');
  }

  it('drills Open Cases through to every non-terminal status and carries NO window', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    // The tile itself now DISCLOSES rather than navigates — the operator keeps the
    // other four numerals in view while they read the detail.
    await userEvent.click(await screen.findByTestId('kpi-open-cases'));
    expect(onNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('kpi-drilldown-drillthrough'));
    // The tile is a window-EXEMPT stock, so the list it opens must be too: passing the
    // dashboard window would hand the operator a SHORTER list than the number they
    // just clicked. Cases defaults to the all-time horizon when no window is given.
    expect(onNavigate).toHaveBeenCalledWith('cases', { status: '__active__' });
    expect(onNavigate.mock.calls[0][1]).not.toHaveProperty('window');
  });

  it('drills Total Cases through to the whole window cohort, with NO status facet', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const cta = await openDrillThrough('kpi-total-cases');
    expect(onNavigate).not.toHaveBeenCalled();
    await userEvent.click(cta);
    // No status facet at all: the list must show the same undivided cohort the tile
    // counts, so the Cases page's default active filter is deliberately dropped.
    expect(onNavigate).toHaveBeenCalledWith('cases', { window: expect.any(Number) });
    expect(onNavigate.mock.calls[0][1]).not.toHaveProperty('status');
  });

  it('drills Resolved / Closed through to the __terminal__ facet, never one status', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const cta = await openDrillThrough('kpi-resolved-closed');
    await userEvent.click(cta);
    // Terminal is TWO statuses (closed + resolved) and the Cases status filter applies
    // exactly one, so a `status: 'closed'` link would silently drop every resolved
    // case from a tile that counts both. The virtual facet is the only honest target.
    expect(onNavigate).toHaveBeenCalledWith('cases', {
      status: '__terminal__',
      window: expect.any(Number),
    });
    expect(onNavigate).not.toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ status: 'closed' }),
    );
  });

  it('deep-links the snapshot CTAs to the resolved / open case lists', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    await userEvent.click(await screen.findByRole('button', { name: /View resolved cases/i }));
    // The card's total counts BOTH terminal statuses (`CLOSED_STATUSES`), so its deep
    // link has to hand the same set to the list. `status: 'closed'` applied exactly one
    // of the two and silently dropped every RESOLVED case — a card reading 1 landing on
    // an empty list, the same defect the KPI tile's `__terminal__` facet was added for.
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: '__terminal__', window: expect.any(Number) }),
    );
    expect(onNavigate).not.toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ status: 'closed' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /View open cases/i }));
    expect(onNavigate).toHaveBeenLastCalledWith('cases', {
      status: '__active__',
      window: expect.any(Number),
    });
  });

  it('window-scopes the current case sample by created-at (#37)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    // The FIRST listCases call is the current window (a second call fetches the previous
    // window for the snapshot trend deltas).
    const arg = listCasesMock.mock.calls[0][0] as { limit?: number; from?: string };
    expect(arg).toMatchObject({ limit: 200 });
    expect(String(arg.from)).toMatch(/^now-\d+h$/);
  });

  it('drills the Critical KPI through to the severity-filtered case list', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const cta = await openDrillThrough('kpi-total-critical');
    await userEvent.click(cta);
    // The Cases page applies exactly ONE severity band. Now that the tile IS one
    // band, the drill-through can carry it truthfully (the retired Critical-OR-High
    // union deliberately could not).
    expect(onNavigate).toHaveBeenCalledWith('cases', {
      severity: 'critical',
      window: expect.any(Number),
    });
  });

  it('takes Total Critical from the SERVER band tally, never from the bounded page', async () => {
    // The regression this pins: the tile used to count the Critical band over whatever
    // page `listCases` happened to return, which silently reported a sample as a
    // total. The page and the server are deliberately made to DISAGREE here — 2 rows
    // band Critical, the server says 37 — and the tile must show the server's number.
    const currentWindow: Case[] = [
      { case_id: 'open-critical', status: 'open', risk_score: 88 },
      { case_id: 'human-high', status: 'needs_human', risk_score: 65 },
      { case_id: 'escalated-critical', status: 'escalated', risk_score: 90 },
      { case_id: 'resolved-high', status: 'resolved', risk_score: 60 },
      { case_id: 'closed-low', status: 'closed', risk_score: 20 },
    ] as unknown as Case[];
    const previousWindow: Case[] = Array.from({ length: 55 }, (_, i) => ({
      case_id: `previous-${i}`,
      status: 'closed',
      risk_score: 90,
    })) as unknown as Case[];
    listCasesMock
      .mockResolvedValueOnce({ cases: currentWindow, total: currentWindow.length })
      .mockResolvedValueOnce({ cases: previousWindow, total: previousWindow.length });
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 120,
      severity_counts: { critical: 37, high: 40, medium: 30, low: 13, info: 0 },
    });

    render(<Overview onNavigate={vi.fn()} />);
    const tile = await screen.findByTestId('kpi-total-critical');

    await waitFor(() => expect(within(tile).getByText('37')).toBeInTheDocument());
    // …and the share is of the server's own `case_count`, the population the tally
    // partitions — never "of 5", the page it was rendered beside.
    expect(within(tile).getByText('31% of 120')).toBeInTheDocument();
    expect(within(tile).queryByText('2')).toBeNull();
    expect(within(tile).queryByText(/of 5$/)).toBeNull();

    // The severity DONUTS keep describing the page they are drawn from — a per-band
    // split of the rows this dashboard holds — which is a different, honest job.
    const openRing = screen.getByRole('img', { name: /Open cases by severity/i });
    const resolvedRing = screen.getByRole('img', { name: /Resolved cases by severity/i });
    expect(within(openRing).getByText('3')).toBeInTheDocument();
    expect(within(resolvedRing).getByText('2')).toBeInTheDocument();

    expect(listCasesMock.mock.calls[0][0]).toMatchObject({
      limit: 200,
      from: 'now-24h',
    });
    expect(listCasesMock.mock.calls[1][0]).toMatchObject({
      limit: 200,
      from: 'now-48h',
      to: 'now-24h',
    });
  });

  // The severity banding folds onto the ONE severity authority (badges.ts
  // severityBandFromNumber, the 74/48/22/8 ladder). A risk_score of 76 must band
  // CRITICAL (it read HIGH under the old 80-cut). Locked via the severity DONUT: the
  // KPI tile now reads the server tally, so the donut is where this client-side
  // projection still shows.
  it('bands a risk_score of 76 as CRITICAL (the unified 74-cut ladder)', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        { case_id: 'u1', status: 'open', risk_score: 88 }, // critical
        { case_id: 'u2', status: 'open', risk_score: 76 }, // critical NOW (was high @ 80-cut)
        { case_id: 'u3', status: 'open', risk_score: 65 }, // high
        { case_id: 'u4', status: 'open', risk_score: 20 }, // low
      ] as unknown as Case[],
      total: 4,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // 88 + 76 BOTH band Critical → the Open snapshot's severity row reports 2
    // Critical. Under the old 80-cut, that row would report only 1.
    const openSnapshot = await screen.findByRole('button', { name: 'View open cases' });
    await waitFor(() =>
      expect(within(openSnapshot).getByText('Critical')).toBeInTheDocument(),
    );
    const criticalRow = within(openSnapshot).getByText('Critical').closest('li');
    expect(criticalRow).not.toBeNull();
    expect(within(criticalRow as HTMLElement).getByText('2')).toBeInTheDocument();
  });

  // The Cases severity FILTER prefers the source-asserted `severity_band`; the Overview
  // banding must bucket by the SAME preference so a drilled list reconciles.
  it('buckets a source_asserted case by severity_band, not the risk band', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        {
          case_id: 's1', status: 'open',
          severity_band: 'critical', severity_source: 'source_asserted', risk_score: 20,
        },
        { case_id: 's2', status: 'open', risk_score: 65 }, // high (no severity_band)
      ] as unknown as Case[],
      total: 2,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // s1 buckets Critical (via severity_band, NOT its risk_score 20 which is Low); s2
    // is High and is excluded.
    const openSnapshot = await screen.findByRole('button', { name: 'View open cases' });
    await waitFor(() =>
      expect(within(openSnapshot).getByText('Critical')).toBeInTheDocument(),
    );
    const criticalRow = within(openSnapshot).getByText('Critical').closest('li');
    expect(criticalRow).not.toBeNull();
    expect(within(criticalRow as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('folds the secondary bands (connectors, volume, full timing) into Deeper analytics', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // Folded away by default.
    expect(screen.queryByRole('region', { name: /Ingest coverage/i })).toBeNull();
    // The duplicate "Autonomous vs human" fold-out is GONE: the landing page states
    // close attribution once, in the Human-vs-AI instrument, and that instrument now
    // carries the #3 advisory the removed card used to.
    expect(screen.queryByRole('region', { name: /Autonomous vs human/i })).toBeNull();
    expect(
      within(screen.getByTestId('human-vs-ai')).getByText(/never influences that/i),
    ).toBeInTheDocument();
    // Expand.
    const deeper = await screen.findByRole('button', { name: /Deeper analytics/i });
    await userEvent.click(deeper);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Ingest coverage/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: /Autonomous vs human/i })).toBeNull();
    expect(screen.getByRole('region', { name: /Case volume/i })).toBeInTheDocument();
    // The full response-timing (MTTA/MTTR p50) lives here, not on the default view.
    expect(screen.getAllByText('45m').length).toBeGreaterThan(0); // MTTA p50
    expect(screen.getAllByText('3h').length).toBeGreaterThan(0); // MTTR p50 (180m)
    // LLM spend is the quiet runaway tripwire inside the fold.
    expect(screen.getByTestId('kpi-llm-spend-detail')).toBeInTheDocument();
  });

  it('uses the shared centered Console loading state for the blocking load', () => {
    listCasesMock.mockReturnValue(new Promise(() => {}));
    getMetricsMock.mockReturnValue(new Promise(() => {}));
    usageMock.mockReturnValue(new Promise(() => {}));
    fetchPostureMock.mockReturnValue(new Promise(() => {}));
    render(<Overview onNavigate={vi.fn()} />);
    const loading = screen.getByLabelText('Loading dashboard');
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute('data-loading-layout', 'page');
    expect(within(loading).getByTestId('console-loading-glyph')).toBeInTheDocument();
    expect(loading.querySelector('[data-loading-shape="page"]')).toBeInTheDocument();
  });
});
