/**
 * Overview — the Round 12 DATA INVENTORY (SYNTHESIS-ux §2.10, diagnosis/overview.md §3).
 *
 * The redesign moved every instrument into flat titled bands, flattened Deeper analytics
 * and rebuilt the KPI drill-down's layout. Its one hard rule was "keep every datum". This
 * spec is that rule as a checklist: each item of the inventory is queried by the label an
 * operator reads (or its stable test anchor), band by band, so a datum that silently drops
 * out of a later refactor fails here by name.
 *
 * It also pins the Round 12 ADDITIONS (per-band freshness, Alert reduction, p90 timing,
 * the cross-reference line, the Deeper summary, the analyst-confirmed false positives) and
 * the glitch fixes (one "Full screen" label, the sentence-case "AI verdicts" centre, one
 * window wording, the AI-verdict FP label).
 *
 * Offline: the api and the posture fetch are mocked; no auth; nothing here can reach #3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock, noiseMock, coverageMock, trendsMock } =
  vi.hoisted(() => ({
    listCasesMock: vi.fn(),
    getMetricsMock: vi.fn(),
    usageMock: vi.fn(),
    noiseMock: vi.fn(),
    coverageMock: vi.fn(),
    trendsMock: vi.fn(),
  }));

// The Deeper analytics choice is mirrored to the viewer's server prefs (Round 12). Null
// (no provider) unless a test hands the page hydrated prefs.
const { useOptionalPrefsMock, putUserMock } = vi.hoisted(() => ({
  useOptionalPrefsMock: vi.fn((): unknown => null),
  putUserMock: vi.fn(),
}));
vi.mock('@/soc/prefs', async () => ({
  ...(await vi.importActual<typeof import('@/soc/prefs')>('@/soc/prefs')),
  useOptionalPrefs: useOptionalPrefsMock,
}));

vi.mock('@/lib/api', async () => ({
  // ApiError is real: LoadError's message helper narrows on it.
  ApiError: (await vi.importActual<typeof import('@/lib/api')>('@/lib/api')).ApiError,
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    noiseReduction: noiseMock,
    sourcesCoverage: coverageMock,
    metricsTrends: trendsMock,
    prefs: { putUser: putUserMock },
  },
}));

// The empty state's demo action reads the auth context; this spec pins its presence only.
vi.mock('@/soc/components/StartDemoButton', () => ({
  StartDemoButton: () => <button type="button">Start demo</button>,
}));

import Overview, { PAGE_TITLE, latestFloorCss, summarySignatureLabel } from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, MetricsTrends, NoiseReduction, SourceCoverage } from '@/lib/types';

const NOW = Date.now();
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const CASES: Case[] = [
  {
    case_id: 'c-open', case_number: 'CASE-1001', status: 'open', risk_score: 88,
    severity_band: 'critical', title: 'Impossible travel', detection_source: 'rule',
    created_at: iso(30), updated_at: iso(5), entity: { type: 'ip', value: '10.0.0.1' },
  },
  {
    case_id: 'c-human', case_number: 'CASE-1002', status: 'needs_human', risk_score: 65,
    severity_band: 'high', title: 'Brute force', detection_source: 'rule',
    created_at: iso(40), updated_at: iso(10), entity: { type: 'host', value: 'web-01' },
  },
  {
    // The AI called it a false positive and an analyst CLASSIFIED it so: the queue row
    // states the outcome of record, and the FP drill-down lists it.
    case_id: 'c-fp', case_number: 'CASE-1003', status: 'closed', risk_score: 20,
    severity_band: 'low', title: 'Benign admin login', detection_source: 'anomaly',
    verdict: 'FALSE_POSITIVE', decision_by: 'analyst', disposition: 'false_positive',
    history: [{ event: 'analyst_action', action: 'set_disposition', classified_disposition: 'false_positive', analyst: 'alice', ts: iso(15) }],
    created_at: iso(50), updated_at: iso(15), entity: { type: 'user', value: 'alice' },
  },
] as unknown as Case[];

/** The previous window: fewer open cases, so the snapshot carries a change chip. */
const PREV_CASES: Case[] = [CASES[0], CASES[2]];

const METRICS: Metrics = {
  total_cases: 3, open_cases: 2, needs_human_cases: 1, closed_cases: 1,
  by_status: { open: 1, needs_human: 1, closed: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 1, none: 0 },
  persona_usage: {}, playbook_usage: {}, avg_risk_score: 57,
  active_risk_index: 76, active_risk_case_count: 2,
  mttr_minutes: 120, resolved_count: 1,
  cases_per_day: [{ date: '2026-06-28', count: 2 }, { date: '2026-06-30', count: 5 }],
  burndown: [],
  timing_trend: [
    { date: '2026-06-29', mttd: 12, respond: 30, resolve: 180 },
    { date: '2026-06-30', mttd: 10, respond: 40, resolve: 200 },
  ],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE = {
  window_hours: 24, generated_at: new Date(NOW).toISOString(), case_count: 3,
  severity_counts: { critical: 1, high: 1, medium: 0, low: 1, info: 0 },
  open_now: { count: 7, window_exempt: true, as_of: new Date(NOW).toISOString(), complete: true, reason: '' },
  window_covered: true, window_coverage_reason: '',
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: 30, p90: 90, mean: 40, max: 100, count: 2, available: true, reason: '' },
    mttd_minutes: { p50: 9, p90: 30, mean: 12, max: 60, count: 3, available: true, reason: '' },
  },
  quality: {
    total_cases: 3, verdicted_cases: 3, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 1, escalated_cases: 0, terminal_cases: 3, auto_closed_cases: 1,
    human_closed_cases: 1, system_closed_cases: 1, policy_closed_cases: 0,
    alert_to_incident_ratio: 0.33, false_positive_rate: 0.33, escalation_rate: 0.33,
    containment_rate: 1, automation_rate: 0.33, analyst_confirmed_fp: 4,
  },
  aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1, closure_vs_arrival: 0.33, backlog: 2 },
  sla: { enabled: false },
} as unknown as PostureResponse;

const NOISE: NoiseReduction = {
  window_hours: 24,
  generated_at: new Date(NOW).toISOString(),
  bands: ['critical', 'high', 'medium', 'low', 'info'],
  stages: [
    { key: 'ingested', label: 'Ingested', source: 'counters', deterministic: true, total: 1000, by_severity: { critical: 50, high: 150, medium: 300, low: 400, info: 100 } },
    { key: 'clustered', label: 'Clustered', source: 'counters', deterministic: true, total: 400, by_severity: {} },
    { key: 'cases', label: 'Cases opened', source: 'cases', deterministic: false, total: 40, by_severity: {} },
    { key: 'auto_cleared', label: 'Auto-cleared', source: 'cases', deterministic: true, total: 20, by_severity: {} },
    { key: 'escalated', label: 'Escalated', source: 'cases', deterministic: true, total: 20, by_severity: {} },
    { key: 'needs_human', label: 'Needs human', source: 'cases', deterministic: true, total: 6, by_severity: {} },
    { key: 'closed', label: 'Closed by human', source: 'cases', deterministic: true, total: 12, by_severity: {} },
  ],
  drops: { suppressed: 5, ignored: 2 },
  reduction: { overall_pct: 96, human_reduction_pct: 50 },
  counters: { available: true, since: '2026-06-30T08:00:00Z', incomplete: false },
  cases_meta: { truncated: false, store_total: 40, fetched: 40 },
};

const COVERAGE: SourceCoverage = {
  generated_at: new Date(NOW).toISOString(),
  sources_total: 4, sources_enabled: 3, sources_silent: 1,
  events_per_min: 128, alerts_triaged_24h: 42, worst_last_event_seconds: 600,
  silent_after_seconds: 900, sources: [],
} as unknown as SourceCoverage;

const TRENDS: MetricsTrends = {
  window_hours: 24, bucket_minutes: 60, generated_at: new Date(NOW).toISOString(),
  buckets: [
    { t: iso(120), new_cases: 1, closed: 1, auto_closed: 1, human_closed: 0, system_closed: 0, false_positives: 0, needs_human: 0, escalated: 0, sent_to_human: 0, fp_rate: 0, alerts: 10 },
    { t: iso(60), new_cases: 2, closed: 2, auto_closed: 0, human_closed: 1, system_closed: 1, false_positives: 1, needs_human: 1, escalated: 0, sent_to_human: 1, fp_rate: 50, alerts: 20 },
  ],
  truncated: false, store_total: 3, fetched: 3,
} as unknown as MetricsTrends;

function mountMocks() {
  fetchPostureMock.mockReset().mockResolvedValue(POSTURE);
  // The page's previous-window read is the only one with a RELATIVE `to` bound; the
  // drill-down pins an absolute ISO head instead.
  listCasesMock.mockReset().mockImplementation((params?: { to?: string }) =>
    Promise.resolve(
      params?.to?.startsWith('now-')
        ? { cases: PREV_CASES, total: PREV_CASES.length }
        : { cases: CASES, total: CASES.length, window_total_exact: true },
    ),
  );
  getMetricsMock.mockReset().mockResolvedValue(METRICS);
  usageMock.mockReset().mockResolvedValue({
    total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD',
    cost_over_time: [{ ts: iso(60), cost: 0.5 }, { ts: iso(30), cost: 0.75 }],
  });
  noiseMock.mockReset().mockResolvedValue(NOISE);
  coverageMock.mockReset().mockResolvedValue(COVERAGE);
  trendsMock.mockReset().mockResolvedValue(TRENDS);
  putUserMock.mockReset().mockResolvedValue({});
  useOptionalPrefsMock.mockReset().mockReturnValue(null);
}

async function mount() {
  const onNavigate = vi.fn();
  render(<Overview onNavigate={onNavigate} />);
  await screen.findByTestId('page-hero');
  await waitFor(() => expect(screen.getByTestId('noise-funnel')).toBeInTheDocument());
  await waitFor(() => expect(within(screen.getByTestId('kpi-total-cases')).getByText('3')).toBeInTheDocument());
  return onNavigate;
}

describe('Overview — Round 12 data inventory (every datum survives the redesign)', () => {
  beforeEach(() => {
    localStorage.removeItem('soc.overview.deeperOpen');
    mountMocks();
  });

  it('masthead: title, time range, auto-refresh, manual refresh, freshness', async () => {
    await mount();
    const hero = screen.getByTestId('page-hero');
    expect(within(hero).getByRole('heading', { level: 1, name: PAGE_TITLE })).toBeInTheDocument();
    const controls = within(hero).getByRole('group', { name: 'Dashboard controls' });
    expect(within(controls).getByRole('button', { name: /Time range: Last 24 hours/i })).toBeInTheDocument();
    expect(within(controls).getByRole('combobox', { name: /Auto-refresh interval/i })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Refresh dashboard' })).toBeInTheDocument();
    // Additive: the page's freshness on the dashbar.
    expect(within(hero).getByTestId('freshness')).toHaveTextContent(/^Updated /);
    // The dashbar is floating chrome on the Console material — never a card.
    expect(hero).not.toHaveClass('bg-card');
    expect(hero.className).toContain('material-surface');
    // Pinned from `sm` up only: on a phone the stacked masthead scrolls away.
    expect(hero.className).toContain('sticky');
    expect(hero.className).toContain('max-sm:static');
  });

  it('KPI strip: six tiles, each with label, numeral, context, help, drill-down mark and dialog', async () => {
    await mount();
    const strip = screen.getByTestId('kpi-strip');
    const expected: Array<[string, string, string, RegExp]> = [
      ['kpi-total-cases', 'Total Cases', '3', /^arrivals, last 24 hours$/],
      ['kpi-total-critical', 'Total Critical', '1', /^33% of 3 cases$/],
      ['kpi-open-cases', 'Open Cases', '7', /^any arrival date$/],
      ['kpi-false-positive-rate', 'AI-verdict FP rate', '33%', /^1 of 3 verdicted$/],
      ['kpi-resolved-closed', 'Resolved / Closed', '3', /^100% of 3 cases$/],
      ['kpi-auto-closed', 'Auto Closed', '1', /^33% of worked closes$/],
    ];
    for (const [id, label, value, context] of expected) {
      const tile = within(strip).getByTestId(id);
      expect(tile, id).toHaveTextContent(label);
      await waitFor(() => expect(within(tile).getByText(value)).toBeInTheDocument());
      expect(tile.querySelector('[data-kpi-line]'), id).toHaveTextContent(context);
      expect(tile, id).toHaveAttribute('aria-haspopup', 'dialog');
      expect(within(strip).getByTestId(`${id}-affordance`), id).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `About ${label}` }), id).toBeInTheDocument();
    }
    // Hover trends where an honest series exists; none on Critical and Open (by design).
    const trended = (id: string) =>
      screen.getByTestId(id).closest('[data-testid="metric-trend-trigger"]') !== null;
    expect(trended('kpi-total-cases')).toBe(true);
    expect(trended('kpi-false-positive-rate')).toBe(true);
    expect(trended('kpi-resolved-closed')).toBe(true);
    expect(trended('kpi-total-critical')).toBe(false);
    expect(trended('kpi-open-cases')).toBe(false);
  });

  it('Alert flow band: title, freshness, flow controls, every stage, open-cases action, annotations', async () => {
    await mount();
    const band = screen.getByRole('region', { name: 'Alert flow' });
    expect(within(band).getByText(/How the last 24 hours of alerts became cases/)).toBeInTheDocument();
    expect(within(band).getByTestId('freshness')).toBeInTheDocument();
    const funnel = within(band).getByTestId('noise-funnel');
    expect(within(funnel).getByRole('heading', { name: 'Noise reduction flow' })).toBeInTheDocument();
    expect(within(funnel).getByRole('button', { name: /What the noise-reduction funnel means/i })).toBeInTheDocument();
    expect(within(funnel).getByRole('radio', { name: 'Simple' })).toBeInTheDocument();
    expect(within(funnel).getByRole('radio', { name: 'Detailed' })).toBeInTheDocument();
    expect(within(funnel).getByRole('button', { name: 'Open full-screen noise reduction flow' })).toHaveTextContent('Full screen');
    expect(within(funnel).getByRole('button', { name: 'Hide noise funnel' })).toBeInTheDocument();
    for (const stage of ['Alerts ingested', 'After clustering', 'Cases opened', 'Auto-cleared by AI', 'Escalated', 'Closed by human', 'Not analyst-closed']) {
      expect(within(funnel).getAllByText(stage).length, stage).toBeGreaterThan(0);
    }
    // Additive headline: 1 − 40 / 1000.
    expect(within(funnel).getByTestId('noise-alert-reduction')).toHaveTextContent('Alert reduction96%');
    expect(within(funnel).getByTestId('noise-scale-chip')).toHaveTextContent('Square-root scale');
    expect(within(funnel).getByRole('button', { name: /How to read these counts and percentages/i })).toBeInTheDocument();
    const open = within(funnel).getByTestId('noise-open-cases');
    expect(open).toHaveTextContent('2 open cases from this window');
    expect(open).toHaveTextContent('Review');
    expect(within(funnel).getByTestId('noise-flow-annotations')).toHaveTextContent(/5\s+suppressed/);

    // Detailed mode keeps its headline, rail and excluded spur.
    await userEvent.click(within(funnel).getByRole('radio', { name: 'Detailed' }));
    const detailed = within(funnel).getByTestId('noise-detailed-view');
    expect(within(detailed).getByText(/Reduced by/)).toBeInTheDocument();
    expect(within(detailed).getByTestId('noise-stage-rail')).toBeInTheDocument();
    expect(detailed.querySelectorAll('[data-loss-annotation]').length).toBeGreaterThan(0);
    expect(within(detailed).getByText(/excluded/)).toBeInTheDocument();
    // The same one label in Detailed (it used to read "Expand").
    expect(within(funnel).getByRole('button', { name: 'Open full-screen noise reduction flow' })).toHaveTextContent('Full screen');
  });

  it('Human vs AI: three totals with shares, the chart, its caption and the alerts tally', async () => {
    await mount();
    const card = screen.getByTestId('human-vs-ai');
    expect(within(card).getByRole('heading', { name: 'Human vs AI' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /About Human vs AI attribution/i })).toBeInTheDocument();
    for (const [band, label] of [['ai', 'AI agent'], ['human', 'Human'], ['system', 'System']]) {
      const cell = within(card).getByTestId(`human-vs-ai-${band}`);
      expect(cell).toHaveTextContent(label);
      expect(cell).toHaveTextContent('1');
      // Shares sum to 100 (largest remainder), so one of the three thirds reads 34%.
      expect(cell).toHaveTextContent(/3[34]%/);
    }
    expect(within(card).getByTestId('human-vs-ai-chart')).toBeInTheDocument();
    expect(card).toHaveTextContent(/times in UTC/);
    expect(within(card).getByTestId('human-vs-ai-alerts')).toHaveTextContent('30 alerts ingested');
    // Additive: the repeat is named — AI agent IS the Auto Closed tile's count.
    expect(within(card).getByTestId('human-vs-ai-cross-reference')).toHaveTextContent(
      'AI agent is the same count as Auto Closed above.',
    );
  });

  it('Cases and response band: the split and the snapshot legends never cost a severity name (final review)', async () => {
    // At 768px with the navigation pinned, `md:grid-cols-2` made each snapshot card 228px;
    // the legend got 44px, every severity name rendered 0px wide and the counts ran into
    // the chevron (severity told by colour only, WCAG 1.4.1). jsdom cannot measure, so
    // this pins the layout contract; the live sweep measures the widths.
    await mount();
    const grid = screen.getByTestId('cases-band-grid');
    // The band splits by ITS OWN width (a container query), never by the viewport, and
    // only below the 12-column xl grid, so the two rules never compete.
    expect(grid.className).not.toMatch(/(^|\s)md:grid-cols-2(\s|$)/);
    expect(grid.className).toContain('max-xl:@[48rem]:grid-cols-2');
    expect(grid.className).toContain('xl:grid-cols-12');
    expect(screen.getByTestId('cases-band-container')).toHaveClass('@container');
    expect(grid.parentElement).toBe(screen.getByTestId('cases-band-container'));
    const queueCell = screen.getByRole('region', { name: 'Latest cases' }).parentElement as HTMLElement;
    expect(queueCell.className).not.toMatch(/(^|\s)md:col-span-2(\s|$)/);
    expect(queueCell.className).toContain('max-xl:@[48rem]:col-span-2');
    // The detect / respond pair follows its own cell too.
    const timing = screen.getByRole('region', { name: 'Mean time to detect / respond' });
    expect(timing).toHaveClass('@container');

    const lifecycle = screen.getByRole('region', { name: 'Resolved and open cases' });
    for (const card of within(lifecycle).getAllByTestId('snapshot-card')) {
      const body = within(card).getByTestId('snapshot-body');
      const legend = within(card).getByTestId('snapshot-legend');
      // The ring and the legend share a WRAPPING row; the legend asks for its own
      // max-content width, so it drops under the ring rather than squeezing its names.
      expect(body).toHaveClass('flex-wrap');
      expect(body.contains(legend)).toBe(true);
      expect(legend).toHaveClass('w-max', 'max-w-[15rem]');
      expect(legend).not.toHaveClass('flex-1');
      // The chevron has its own column OUTSIDE the wrapping row, so no count reaches it.
      const chevron = card.querySelector('svg.lucide-chevron-right');
      expect(chevron).not.toBeNull();
      expect(body.contains(chevron)).toBe(false);
      expect(chevron).toHaveClass('shrink-0');
      // The button's name replaces its contents for assistive tech; the legend is its
      // description, so the severity split is not colour-only there either.
      const button = within(card).getByRole('button');
      expect(button).toHaveAttribute('aria-describedby', legend.id);
      expect(button).toHaveAccessibleDescription(/^(Critical|High|Medium|Low|Informational) \d/);
    }
  });

  it('Cases and response band: snapshots, cross-reference, response time with p90, the live queue', async () => {
    await mount();
    const band = screen.getByRole('region', { name: 'Cases and response' });
    expect(within(band).getByTestId('freshness')).toBeInTheDocument();

    // Snapshots ×2: title, caption, change chip, donut + centre, legend, deep link, trend.
    const lifecycle = within(band).getByRole('region', { name: 'Resolved and open cases' });
    expect(within(lifecycle).getByRole('heading', { name: 'Open cases' })).toBeInTheDocument();
    expect(within(lifecycle).getByRole('heading', { name: 'Cases resolved' })).toBeInTheDocument();
    expect(within(lifecycle).getByText('Arrived in the last 24 hours, still open')).toBeInTheDocument();
    expect(within(lifecycle).getByText('Arrived in the last 24 hours, now resolved or closed')).toBeInTheDocument();
    expect(within(lifecycle).getByRole('img', { name: /^changed up by \+1, worse$/ })).toBeInTheDocument();
    expect(within(lifecycle).getByRole('img', { name: 'Open cases by severity' })).toBeInTheDocument();
    expect(within(lifecycle).getByRole('img', { name: 'Resolved cases by severity' })).toBeInTheDocument();
    for (const sev of ['Critical', 'High', 'Low']) {
      expect(within(lifecycle).getAllByText(sev).length, sev).toBeGreaterThan(0);
    }
    expect(within(lifecycle).getByRole('button', { name: 'View open cases' })).toBeInTheDocument();
    expect(within(lifecycle).getByRole('button', { name: 'View resolved cases' })).toBeInTheDocument();
    expect(lifecycle.querySelectorAll('[data-testid="metric-trend-trigger"]')).toHaveLength(2);
    // Additive cross-reference: the cohort ties back to the window-exempt stock.
    expect(within(lifecycle).getByTestId('snapshot-footnote')).toHaveTextContent(
      'Part of the 7 open now, any arrival date (Open Cases above).',
    );

    // Response time: both stats, definitions, samples, p90 (additive), Detail.
    const timing = within(band).getByRole('region', { name: 'Mean time to detect / respond' });
    expect(within(timing).getByRole('heading', { name: 'Response time' })).toBeInTheDocument();
    expect(within(timing).getByText('MTTD')).toBeInTheDocument();
    expect(within(timing).getByText('Respond')).toBeInTheDocument();
    expect(within(timing).getByText('9m')).toBeInTheDocument();
    expect(within(timing).getByText('45m')).toBeInTheDocument();
    expect(within(timing).getByText('Detect · log arrival → case')).toBeInTheDocument();
    expect(within(timing).getByText(/First human action, e\.g\. assignment or acknowledgement/)).toBeInTheDocument();
    expect(within(timing).getByText('p50 · 3 samples · p90 30m')).toBeInTheDocument();
    expect(within(timing).getByText('p50 · 2 samples · p90 2h')).toBeInTheDocument();
    expect(within(timing).getByRole('button', { name: 'Detail →' })).toBeInTheDocument();

    // Latest cases: rows with title, id, age, status and — terminal — the outcome.
    const queue = within(band).getByRole('region', { name: 'Latest cases' });
    expect(within(queue).getByText('Real-time triage queue')).toBeInTheDocument();
    expect(within(queue).getByRole('button', { name: 'View all' })).toBeInTheDocument();
    const rows = within(queue).getAllByRole('button', { name: /^Open case / });
    expect(rows).toHaveLength(3);
    const fpRow = within(queue).getByRole('button', { name: /Open case Benign admin login \(CASE-1003\)/ });
    expect(within(fpRow).getByText('CASE-1003')).toBeInTheDocument();
    expect(within(fpRow).getByText('Resolved')).toBeInTheDocument();
    expect(within(fpRow).getByTestId('latest-case-outcome')).toHaveTextContent('False positive');
    // The 160px id cap is gone: the id truncates only against the real space.
    expect(within(fpRow).getByText('CASE-1003')).not.toHaveClass('max-w-40');
  });

  it('Deeper analytics: collapsed summary, then every instrument flat inside', async () => {
    const onNavigate = await mount();
    const trigger = screen.getByRole('button', { name: /Deeper analytics/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Additive: what the fold holds, in one line, while it is closed.
    await waitFor(() =>
      expect(screen.getByTestId('deeper-summary')).toHaveTextContent(
        'MTTA 45m · MTTR 3h · Dwell 30m · $1.25 spend · 1 silent source',
      ),
    );
    // Every signature is tied at one case, so none is named as the "top" one.
    expect(screen.getByTestId('deeper-summary')).not.toHaveTextContent(/top signature/);
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // The choice is remembered: locally, and in the viewer's own prefs.
    expect(localStorage.getItem('soc.overview.deeperOpen')).toBe('1');
    expect(putUserMock).toHaveBeenCalledWith({ misc: { overview_deeper_open: true } });

    // Efficiency and cost: the second strip.
    expect(await screen.findByRole('heading', { name: 'Efficiency and cost' })).toBeInTheDocument();
    const strip = screen.getByTestId('deeper-timing-strip');
    for (const [id, value, context] of [
      ['kpi-mtta', '45m', 'p50 · 2 samples'],
      ['kpi-mttr', '3h', 'p50 · 1 sample'],
      ['kpi-dwell', '30m', 'p50 · 2 samples'],
    ]) {
      const tile = within(strip).getByTestId(id);
      expect(tile, id).toHaveTextContent(value);
      expect(tile.querySelector('[data-kpi-line]'), id).toHaveTextContent(context);
    }
    const spend = within(strip).getByTestId('kpi-llm-spend-detail');
    expect(spend).toHaveTextContent('$1.25');
    expect(spend).toHaveTextContent('12K tokens · 8 calls');
    await userEvent.click(spend);
    expect(onNavigate).toHaveBeenCalledWith('metrics', { tab: 'cost' });

    // Ingest coverage.
    const coverage = screen.getByTestId('coverage-tile');
    expect(coverage).toHaveTextContent('sources reporting · 4 configured');
    for (const label of ['Events / min', 'Triaged 24h', 'Silent']) {
      expect(within(coverage).getByText(label)).toBeInTheDocument();
    }
    expect(within(coverage).getByText('128')).toBeInTheDocument();
    expect(within(coverage).getByRole('button', { name: /1 source stopped reporting/ })).toBeInTheDocument();

    // Case volume: one column per UTC day in the span, zero-filled between.
    const volume = screen.getByRole('region', { name: 'Case volume' });
    const table = within(volume).getByRole('table', { hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(4); // header + 3 days

    // What's driving volume.
    expect(screen.getByRole('heading', { name: 'What’s driving volume' })).toBeInTheDocument();
    const workload = screen.getByRole('region', { name: 'Case workload state' });
    expect(within(workload).getAllByRole('progressbar')).toHaveLength(3);
    // An ALL-TIME count (store-wide `by_status`) says so, and opens an all-time list.
    expect(workload).toHaveAttribute('data-scope', 'all');
    expect(within(workload).getByTestId('instrument-caption')).toHaveTextContent('All time · every case in the store');
    await userEvent.click(within(workload).getByRole('button', { name: /^View needs human cases$/i }));
    expect(onNavigate).toHaveBeenLastCalledWith('cases', { status: 'needs_human' });
    // Every Deeper instrument names its time span.
    expect(within(screen.getByRole('region', { name: 'Ingest coverage' })).getByTestId('instrument-caption')).toHaveTextContent(/^Right now/);
    expect(within(screen.getByRole('region', { name: 'Case volume' })).getByTestId('instrument-caption')).toHaveTextContent('Cases opened per UTC day · all time');
    expect(screen.getAllByTestId('subband-caption')[0]).toHaveTextContent('Timing and spend over the last 24 hours');

    const outcomes = screen.getByRole('region', { name: 'Case outcomes' });
    // One population: the window's posture quality block, captioned with the window.
    expect(outcomes).toHaveAttribute('data-scope', 'window');
    expect(within(outcomes).getByTestId('instrument-caption')).toHaveTextContent('AI-verdict mix · last 24 hours');
    const donut = within(outcomes).getByRole('img', { name: 'Case outcomes by AI verdict' });
    // The centre reads in sentence case under the numeral (the "VERDICTS" overflow fix).
    expect(within(donut).getByText('AI verdicts')).toBeInTheDocument();
    expect(within(donut).queryByText(/^VERDICTS$/)).toBeNull();
    for (const label of ['True positive', 'Needs human', 'False positive']) {
      expect(within(outcomes).getByText(label)).toBeInTheDocument();
    }
    // Additive: the analyst-confirmed false positives beside the AI verdict mix.
    expect(within(outcomes).getByTestId('analyst-confirmed-fp')).toHaveTextContent(
      'Confirmed false positive by an analyst4',
    );

    const signatures = screen.getByRole('region', { name: 'Top signatures' });
    expect(within(signatures).getByText('Impossible travel')).toBeInTheDocument();
    expect(within(signatures).getByTestId('instrument-caption')).toHaveTextContent('Most frequent detections · last 24 hours');
    const entities = screen.getByRole('region', { name: 'Top entities' });
    expect(within(entities).getByText('10.0.0.1')).toBeInTheDocument();
    expect(within(entities).getByTestId('instrument-caption')).toHaveTextContent('Most-implicated assets · last 24 hours');
  });

  it('KPI drill-down: identity, switcher, filters, partition, trend, stats, table, footer', async () => {
    await mount();
    await userEvent.click(screen.getByTestId('kpi-false-positive-rate'));
    const panel = await screen.findByTestId('kpi-drilldown');
    await waitFor(() => expect(within(panel).getByTestId('kpi-drilldown-rows')).toBeInTheDocument());

    expect(within(panel).getByTestId('kpi-drilldown-breadcrumb')).toHaveTextContent('Cyber Defence Center');
    expect(within(panel).getByTestId('kpi-drilldown-heading')).toHaveTextContent('AI-verdict FP rate · details');
    expect(within(panel).getByTestId('kpi-drilldown-completeness')).toBeInTheDocument();
    expect(within(panel).getByTestId('kpi-drilldown-population')).toHaveTextContent(/numerator/);
    expect(within(panel).getByTestId('kpi-drilldown-export')).toHaveTextContent('Export listed');
    expect(within(panel).getByTestId('kpi-drilldown-close')).toHaveTextContent('Close');

    const switcher = within(panel).getByTestId('kpi-drilldown-metrics');
    expect(within(switcher).getAllByRole('button')).toHaveLength(6);
    expect(switcher).toHaveTextContent(/window rollups, not counts of the rows/);

    for (const id of ['search', 'severity', 'status', 'sort', 'range', 'source']) {
      expect(within(panel).getByTestId(`kpi-drilldown-${id}`), id).toBeInTheDocument();
    }
    // The analyst-confirmed count beside the AI-verdict numerator (additive).
    const partition = within(panel).getByTestId('kpi-drilldown-partition');
    expect(partition).toHaveTextContent('AI verdict: false positive1');
    expect(partition).toHaveTextContent('Confirmed false positive by an analyst4');

    const trend = within(panel).getByTestId('kpi-drilldown-trend');
    expect(trend).toHaveTextContent('False positive rate');
    // The shared hover-card body's 11px captions take the dialog's 12px floor here.
    expect(trend.className).toContain('[&_.text-2xs]:text-xs');
    const stats = within(panel).getByTestId('kpi-drilldown-stats');
    for (const label of ['Unassigned', 'Acknowledged', 'Median age', 'Oldest']) {
      expect(within(stats).getByText(label)).toBeInTheDocument();
    }
    const headers = Array.from(panel.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Case', 'Created', 'Title / rule', 'Source', 'Severity', 'Status', 'Owner']);

    expect(within(panel).getByTestId('kpi-drilldown-scope')).toHaveTextContent(/^Showing /);
    expect(within(panel).getByTestId('kpi-drilldown-drillthrough')).toHaveTextContent('Open in Analytics');
    // The long explanation is one click away, and kept in the DOM.
    const about = within(panel).getByTestId('kpi-drilldown-about');
    expect(about).toHaveAttribute('aria-expanded', 'false');
    const caveats = within(panel).getByTestId('kpi-drilldown-caveats');
    expect(caveats).not.toBeVisible();
    await userEvent.click(about);
    expect(about).toHaveAttribute('aria-expanded', 'true');
    expect(caveats).toBeVisible();
    expect(caveats).toHaveTextContent(/Evaluated over the \d+ rows read/);
    // The range caveat travels with the drill-through it qualifies.
    expect(within(panel).getByTestId('kpi-drilldown-carryover')).toHaveTextContent(/cannot carry/);
  });

  it('degraded states keep their copy: load error with Retry, empty state with both actions', async () => {
    listCasesMock.mockReset().mockRejectedValue(new Error('cases down'));
    getMetricsMock.mockReset().mockRejectedValue(new Error('metrics down'));
    const { unmount } = render(<Overview onNavigate={vi.fn()} />);
    expect(await screen.findByText('Could not load the dashboard')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    unmount();

    listCasesMock.mockReset().mockResolvedValue({ cases: [], total: 0 });
    getMetricsMock.mockReset().mockResolvedValue({ ...METRICS, total_cases: 0 });
    render(<Overview onNavigate={vi.fn()} />);
    expect(await screen.findByText('No triage activity yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a source' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start demo' })).toBeInTheDocument();
  });
});

describe('Overview — Round 12 cross-references and the remembered Deeper choice', () => {
  beforeEach(() => {
    localStorage.removeItem('soc.overview.deeperOpen');
    mountMocks();
  });

  it('names each repeated figure only when the two numbers on screen are equal', async () => {
    // Every case of the window is on the page and terminal, and the flow opened exactly
    // the window's cases: each repeat now equals the strip tile it repeats.
    const closed = CASES.map((c) => ({ ...c, status: 'closed' })) as Case[];
    listCasesMock.mockReset().mockImplementation((params?: { to?: string }) =>
      Promise.resolve(
        params?.to?.startsWith('now-')
          ? { cases: PREV_CASES, total: PREV_CASES.length }
          : { cases: closed, total: closed.length, window_total_exact: true },
      ),
    );
    noiseMock.mockReset().mockResolvedValue({
      ...NOISE,
      stages: NOISE.stages.map((st) => (st.key === 'cases' ? { ...st, total: 3 } : st)),
    });
    await mount();

    const flow = screen.getByRole('region', { name: 'Alert flow' });
    await waitFor(() =>
      expect(
        within(flow).getByText(
          'How the last 24 hours of alerts became cases (the 3 in Total Cases above), and who closed them',
        ),
      ).toBeInTheDocument(),
    );
    const lifecycle = screen.getByRole('region', { name: 'Resolved and open cases' });
    const footnotes = within(lifecycle).getAllByTestId('snapshot-footnote');
    expect(footnotes.map((f) => f.textContent)).toEqual([
      'Part of the 7 open now, any arrival date (Open Cases above).',
      'The same cases as Resolved / Closed above, by severity.',
    ]);
    expect(within(screen.getByTestId('human-vs-ai')).getByTestId('human-vs-ai-cross-reference')).toBeInTheDocument();
  });

  it('says nothing when the repeat and its tile differ', async () => {
    // The flow opened 40 cases against a window of 3; only one of the three window cases
    // on the page is terminal while the rollup counts three; and the rollup's close
    // partition does not reconcile (2 + 1 + 1 ≠ 3), so Human vs AI falls back to the
    // bucket sums (AI agent 1) while the Auto Closed tile reads the rollup's 2.
    fetchPostureMock.mockReset().mockResolvedValue({
      ...POSTURE,
      quality: { ...POSTURE.quality, auto_closed_cases: 2 },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('kpi-auto-closed')).toHaveTextContent('2'));
    await waitFor(() => expect(screen.getByTestId('human-vs-ai-ai')).toHaveTextContent('1'));
    const flow = screen.getByRole('region', { name: 'Alert flow' });
    await waitFor(() => expect(within(flow).getByTestId('noise-funnel')).toBeInTheDocument());
    expect(
      within(flow).getByText('How the last 24 hours of alerts became cases, and who closed them'),
    ).toBeInTheDocument();
    expect(within(flow).queryByText(/in Total Cases above/)).toBeNull();
    expect(screen.queryByText('The same cases as Resolved / Closed above, by severity.')).toBeNull();
    expect(screen.queryByTestId('human-vs-ai-cross-reference')).toBeNull();
  });

  it('opens Deeper analytics from the viewer\u2019s server prefs and mirrors a change back', async () => {
    useOptionalPrefsMock.mockReturnValue({
      ready: true,
      prefs: { misc: { overview_deeper_open: true } },
    });
    await mount();
    const trigger = screen.getByRole('button', { name: /Deeper analytics/i });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
    expect(localStorage.getItem('soc.overview.deeperOpen')).toBe('1');

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem('soc.overview.deeperOpen')).toBe('0');
    expect(putUserMock).toHaveBeenLastCalledWith({ misc: { overview_deeper_open: false } });
  });

  it('keeps the local choice when the server copy is absent, and survives a failing save', async () => {
    localStorage.setItem('soc.overview.deeperOpen', '1');
    useOptionalPrefsMock.mockReturnValue({ ready: true, prefs: { misc: {} } });
    putUserMock.mockReset().mockRejectedValue(new Error('prefs down'));
    await mount();
    const trigger = screen.getByRole('button', { name: /Deeper analytics/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem('soc.overview.deeperOpen')).toBe('0');
  });
});

describe('Overview — Round 12 review: one population per instrument, honest bounds, no re-roll', () => {
  beforeEach(() => {
    localStorage.removeItem('soc.overview.deeperOpen');
    mountMocks();
  });

  async function openDeeper() {
    const trigger = screen.getByRole('button', { name: /Deeper analytics/i });
    await userEvent.click(trigger);
    return screen.findByRole('region', { name: 'Case outcomes' });
  }

  it('Case outcomes reads the WINDOW rollup when posture measured it, never all-time verdicts beside a window count', async () => {
    // The two payloads disagree on purpose: all-time verdicts (83) vs the window (5).
    getMetricsMock.mockResolvedValue({
      ...METRICS,
      by_verdict: { TRUE_POSITIVE: 23, NEEDS_HUMAN: 13, FALSE_POSITIVE: 47, none: 3 },
    });
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      quality: {
        ...POSTURE.quality,
        total_cases: 5, verdicted_cases: 4, true_positive_cases: 1,
        false_positive_cases: 2, needs_human_cases: 1, analyst_confirmed_fp: 1,
      },
    });
    await mount();
    const outcomes = await openDeeper();
    expect(outcomes).toHaveAttribute('data-scope', 'window');
    expect(within(outcomes).getByTestId('instrument-caption')).toHaveTextContent('AI-verdict mix · last 24 hours');
    const donut = within(outcomes).getByRole('img', { name: 'Case outcomes by AI verdict' });
    // The centre counts VERDICTS only (4), not the unverdicted case beside them (5 in all).
    expect(within(donut).getByText('4')).toBeInTheDocument();
    const legend = Array.from(outcomes.querySelectorAll('li')).map((li) => li.textContent);
    expect(legend).toContain('False positive240%');
    expect(legend).toContain('Unverdicted120%');
    expect(outcomes).not.toHaveTextContent('47');
    expect(within(outcomes).getByTestId('analyst-confirmed-fp')).toHaveTextContent(
      'Confirmed false positive by an analyst1',
    );
  });

  it('falls back to all-time verdicts captioned "all time", without the window-only analyst row', async () => {
    getMetricsMock.mockResolvedValue({
      ...METRICS,
      by_verdict: { TRUE_POSITIVE: 23, NEEDS_HUMAN: 13, FALSE_POSITIVE: 47, none: 3 },
    });
    fetchPostureMock.mockReset().mockRejectedValue(new Error('posture down'));
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const outcomes = await openDeeper();
    await waitFor(() => expect(outcomes).toHaveAttribute('data-scope', 'all'));
    expect(within(outcomes).getByTestId('instrument-caption')).toHaveTextContent(
      'AI-verdict mix · all time, every case in the store',
    );
    const donut = within(outcomes).getByRole('img', { name: 'Case outcomes by AI verdict' });
    expect(within(donut).getByText('83')).toBeInTheDocument();
    expect(within(outcomes).queryByTestId('analyst-confirmed-fp')).toBeNull();
  });

  it('names a top signature only when it genuinely leads, with its count', async () => {
    const repeated = [
      CASES[0],
      { ...CASES[1], title: 'Impossible travel' },
      CASES[2],
    ] as Case[];
    listCasesMock.mockReset().mockImplementation((params?: { to?: string }) =>
      Promise.resolve(
        params?.to?.startsWith('now-')
          ? { cases: PREV_CASES, total: PREV_CASES.length }
          : { cases: repeated, total: repeated.length, window_total_exact: true },
      ),
    );
    await mount();
    await waitFor(() =>
      expect(screen.getByTestId('deeper-summary')).toHaveTextContent(
        'top signature: Impossible travel (2 cases)',
      ),
    );
  });

  it('keeps the top signature’s case count visible: the summary wraps and a long label is capped', async () => {
    const long = 'ip:203.0.113.77 — Entra ID Protection: credential phishing and account takeover';
    expect(summarySignatureLabel('Impossible travel')).toBe('Impossible travel');
    expect(summarySignatureLabel(long)).toBe('ip:203.0.113.77 — Entra ID Protection…');
    expect(summarySignatureLabel(long).length).toBeLessThanOrEqual(40);
    const repeated = [
      { ...CASES[0], title: long },
      { ...CASES[1], title: long },
      CASES[2],
    ] as Case[];
    listCasesMock.mockReset().mockImplementation((params?: { to?: string }) =>
      Promise.resolve(
        params?.to?.startsWith('now-')
          ? { cases: PREV_CASES, total: PREV_CASES.length }
          : { cases: repeated, total: repeated.length, window_total_exact: true },
      ),
    );
    await mount();
    const summary = screen.getByTestId('deeper-summary');
    await waitFor(() =>
      expect(summary).toHaveTextContent(
        'top signature: ip:203.0.113.77 — Entra ID Protection… (2 cases)',
      ),
    );
    // Nothing is cut off to one line: the summary wraps (beside the title from `md`,
    // under it below), and the whole sentence — full label included — is its tooltip.
    expect(summary.className).not.toMatch(/\btruncate\b/);
    expect(summary.className).toContain('whitespace-normal');
    expect(summary.className).toContain('basis-full');
    expect(summary.getAttribute('title')).toContain(`top signature: ${long} (2 cases)`);
    expect(summary.getAttribute('title')).toContain('MTTA 45m');
    // Open, the header names the contents and carries no stale tooltip.
    await userEvent.click(screen.getByRole('button', { name: /Deeper analytics/i }));
    expect(summary).toHaveTextContent('Timing, spend, ingest coverage, volume, workload and outcomes');
    expect(summary).not.toHaveAttribute('title');
  });

  it('marks the snapshots as a lower bound when the case page is not the whole window', async () => {
    listCasesMock.mockReset().mockImplementation((params?: { to?: string }) =>
      Promise.resolve(
        params?.to?.startsWith('now-')
          ? { cases: PREV_CASES, total: PREV_CASES.length }
          : { cases: CASES, total: 450, window_total_exact: true },
      ),
    );
    await mount();
    const lifecycle = screen.getByRole('region', { name: 'Resolved and open cases' });
    const bounds = within(lifecycle).getAllByTestId('snapshot-bound');
    expect(bounds.map((b) => b.textContent)).toEqual([
      'Lower bound · counted from the newest 3 of 450',
      'Lower bound · counted from the newest 3 of 450',
    ]);
    // A change between two floors is not a change.
    expect(within(lifecycle).queryByRole('img', { name: /^changed / })).toBeNull();
    await openDeeper();
    expect(
      within(screen.getByRole('region', { name: 'Top signatures' })).getByTestId('instrument-caption'),
    ).toHaveTextContent('Most frequent detections · newest 3 of 450, last 24 hours');
  });

  it('shows no bound when the page provably holds the whole window', async () => {
    await mount();
    expect(screen.queryByTestId('snapshot-bound')).toBeNull();
  });

  it('a quiet refresh shows the new snapshot and coverage counts without counting up', async () => {
    await mount();
    const lifecycle = screen.getByRole('region', { name: 'Resolved and open cases' });
    // First load: the centre is a count-up (static on mount).
    expect(within(lifecycle).getAllByTestId('count-up').length).toBeGreaterThan(0);
    const more = [
      ...CASES,
      { ...CASES[0], case_id: 'c-open-2', case_number: 'CASE-1004' },
    ] as Case[];
    listCasesMock.mockReset().mockImplementation((params?: { to?: string }) =>
      Promise.resolve(
        params?.to?.startsWith('now-')
          ? { cases: PREV_CASES, total: PREV_CASES.length }
          : { cases: more, total: more.length, window_total_exact: true },
      ),
    );
    coverageMock.mockResolvedValue({ ...COVERAGE, sources_silent: 0 });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    await waitFor(() =>
      expect(
        within(lifecycle).getByRole('img', { name: 'Open cases by severity' }),
      ).toHaveTextContent('3'),
    );
    expect(within(lifecycle).queryAllByTestId('count-up')).toHaveLength(0);
    expect(within(lifecycle).getAllByTestId('snapshot-center')[0]).toHaveTextContent('3');
    await openDeeper();
    const coverage = screen.getByTestId('coverage-tile');
    expect(within(coverage).queryAllByTestId('count-up')).toHaveLength(0);
    expect(coverage).toHaveTextContent('3/ 3');
  });

  it('a quiet refresh shows a changed flow stage total without counting up', async () => {
    await mount();
    // The stage rail's first count is "Alerts ingested" (the rail the Detailed view and a
    // phone's Simple view show). A LIVE tick with steady ingest used to roll it every 5s.
    const ingested = within(screen.getByTestId('noise-stage-rail')).getAllByTestId('count-up')[0];
    expect(ingested).toHaveTextContent('1000');
    noiseMock.mockResolvedValue({
      ...NOISE,
      stages: NOISE.stages.map((s) => (s.key === 'ingested' ? { ...s, total: 1400 } : s)),
    });
    const seen = [ingested.textContent ?? ''];
    const observer = new MutationObserver(() => {
      const text = ingested.textContent ?? '';
      if (seen[seen.length - 1] !== text) seen.push(text);
    });
    observer.observe(ingested, { childList: true, characterData: true, subtree: true });
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
      await waitFor(() => expect(ingested).toHaveTextContent('1400'), { timeout: 3000 });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
    } finally {
      observer.disconnect();
    }
    // Old value, then new: no frame in between.
    expect(seen).toEqual(['1000', '1400']);
  });
});

describe('Overview — Round 12 review: layout and keyboard contracts', () => {
  beforeEach(() => {
    localStorage.removeItem('soc.overview.deeperOpen');
    mountMocks();
  });

  it('Latest cases: the outcome sits under the status badge, never on the id line', async () => {
    await mount();
    const queue = screen.getByRole('region', { name: 'Latest cases' });
    const fpRow = within(queue).getByRole('button', { name: /Open case Benign admin login \(CASE-1003\)/ });
    const outcome = within(fpRow).getByTestId('latest-case-outcome');
    const id = within(fpRow).getByText('CASE-1003');
    expect(outcome.parentElement).toContainElement(within(fpRow).getByText('Resolved'));
    expect(id.parentElement).not.toContainElement(outcome);
  });

  it('Latest cases: the in-flow floor is in rem, so larger text grows it with the rows', async () => {
    expect(latestFloorCss(5)).toBe('18.5rem');
    expect(latestFloorCss(6)).toBe('22.25rem');
    expect(latestFloorCss(0)).toBe('0rem');
    await mount();
    // Three cases → a three-row floor.
    expect(screen.getByTestId('latest-cases-box').style.minHeight).toBe('11rem');
    // Below 1920px the snapshot rings keep the 128px size.
    const ring = within(screen.getByRole('region', { name: 'Resolved and open cases' })).getByRole(
      'img',
      { name: 'Open cases by severity' },
    );
    expect(ring).toHaveClass('w-32');
    expect(ring.style.height).toBe('128px');
  });

  it('Latest cases: from 1920px the queue shows eight rows, spanning the snapshots and the response pair', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...CASES[0],
      case_id: `c-${i}`,
      case_number: `CASE-${2000 + i}`,
      title: `Case ${i}`,
    })) as Case[];
    listCasesMock.mockReset().mockImplementation((params?: { to?: string }) =>
      Promise.resolve(
        params?.to?.startsWith('now-')
          ? { cases: PREV_CASES, total: PREV_CASES.length }
          : { cases: many, total: many.length, window_total_exact: true },
      ),
    );
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(min-width: 1920px)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      render(<Overview onNavigate={vi.fn()} />);
      const queue = await screen.findByRole('region', { name: 'Latest cases' });
      // Eight rows (the spec's count at >= 1920), never more: the ninth case stays behind
      // "View all".
      await waitFor(() =>
        expect(within(queue).getAllByRole('button', { name: /^Open case / })).toHaveLength(8),
      );
      expect(screen.getByTestId('latest-cases-box').style.minHeight).toBe('29.75rem');
      // The band is two rows from 3xl: snapshots over the response pair on the left, the
      // queue spanning both on the right (the 460px rail at 4xl) — so its eight rows fill
      // the band rather than leaving blank space under a short snapshot row.
      const grid = screen.getByTestId('cases-band-grid');
      expect(grid.className).toContain('3xl:grid-rows-[auto_1fr]');
      expect(grid.className).toContain('4xl:grid-cols-[minmax(0,1fr)_460px]');
      const lifecycle = screen.getByRole('region', { name: 'Resolved and open cases' });
      expect(lifecycle.className).toContain('3xl:row-start-1');
      // The snapshot rings grow to 192px there, so the instrument — not blank space —
      // takes the height the eight-row queue gives the band.
      const ring = within(lifecycle).getByRole('img', { name: 'Open cases by severity' });
      expect(ring).toHaveClass('w-48');
      expect(ring.style.height).toBe('192px');
      expect(within(lifecycle).getByRole('img', { name: 'Resolved cases by severity (none)' })).toHaveClass(
        'h-48',
        'w-48',
      );
      const timing = screen.getByRole('region', { name: 'Mean time to detect / respond' });
      expect(timing.className).toContain('3xl:row-start-2');
      expect(timing.className).toContain('3xl:col-start-1');
      const queueCell = queue.parentElement as HTMLElement;
      expect(queueCell.className).toContain('3xl:row-span-2');
      expect(queueCell.className).toContain('4xl:col-start-2');
      // DOM (and heading) order is unchanged: case state, response time, latest cases.
      const order = Array.from(grid.children).map(
        (el) => el.getAttribute('aria-label') ?? el.firstElementChild?.getAttribute('aria-label'),
      );
      expect(order).toEqual(['Resolved and open cases', 'Mean time to detect / respond', 'Latest cases']);
    } finally {
      window.matchMedia = original;
    }
  });

  it('KPI strip: the tile focus ring is inset, so the cell root cannot clip it', async () => {
    await mount();
    const tile = screen.getByTestId('kpi-total-cases');
    const cell = tile.parentElement as HTMLElement;
    expect(cell.className).toContain('[&>button:focus-visible]:ring-inset');
  });

  it('a late focus return after Escape does not pop the tile’s trend card back open', async () => {
    await mount();
    const tile = screen.getByTestId('kpi-total-cases');
    await userEvent.click(tile);
    await screen.findByTestId('kpi-drilldown');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    // In a browser Radix restores focus only after the dialog's exit animation — past the
    // trend card's own grace period. Simulate that late arrival explicitly.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    fireEvent.focusIn(tile);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
    // Once the operator moves on, focus brings the card again as usual.
    // (After the card's own short grace for the hold being released.)
    fireEvent.blur(tile);
    fireEvent.focusOut(tile);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    fireEvent.focusIn(tile);
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();
  });

  it('after a mouse Close, hovering the tile still shows its trend card', async () => {
    await mount();
    const tile = screen.getByTestId('kpi-total-cases');
    await userEvent.click(tile);
    const panel = await screen.findByTestId('kpi-drilldown');
    // The pointer travels to Close (leaving the tile) and the focus returns to the tile.
    await userEvent.click(within(panel).getByTestId('kpi-drilldown-close'));
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    // A late FOCUS return still opens nothing…
    fireEvent.focusIn(tile);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
    // …but pointing at the tile is a hover, and a hover shows the trend.
    await userEvent.hover(tile);
    expect(await screen.findByTestId('metric-trend-card')).toBeInTheDocument();
  });

  it('KPI drill-down: pairs the partition two per row and keeps phones to one scroller', async () => {
    await mount();
    await userEvent.click(screen.getByTestId('kpi-resolved-closed'));
    const panel = await screen.findByTestId('kpi-drilldown');
    const partition = await within(panel).findByTestId('kpi-drilldown-partition');
    expect(partition.className).toContain('@[24rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]');
    // <dt>/<dd> stay direct children (axe's definition-list rule).
    expect(partition.querySelectorAll(':scope > dt').length).toBeGreaterThan(0);
    // Phone: the actions drop under the title; the body (switcher, filters, evidence)
    // scrolls as one, the evidence band taking its content height.
    const identity = within(panel).getByTestId('kpi-drilldown-actions').parentElement as HTMLElement;
    expect(identity.className).toContain('flex-col');
    expect(identity.className).toContain('sm:flex-row');
    const body = within(panel).getByTestId('kpi-drilldown-body');
    expect(body.className).toContain('max-md:overflow-y-auto');
    expect(body).toContainElement(within(panel).getByTestId('kpi-drilldown-metrics'));
    expect(body).toContainElement(within(panel).getByTestId('kpi-drilldown-controls'));
    const scroller = within(panel).getByTestId('kpi-drilldown-scroll');
    expect(body).toContainElement(scroller);
    expect(scroller.className).toContain('max-md:flex-none');
  });
});
