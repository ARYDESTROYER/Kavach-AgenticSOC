/**
 * Overview (Cyber Defence Center) — render test for the Stitch-inspired command center.
 *
 * Pins the load-bearing dashboard contract:
 *   1. the PLAIN header (page-hero, no hero card chrome, exactly one h1, PAGE_TITLE);
 *   2. the un-nested KPI micro-strip of 5 alert/case tiles (Open / Critical-High /
 *      Escalated / False-Positive-Rate / Auto-Resolved); LLM spend is NOT a hero tile;
 *   3. the integrated instrument band = Active Risk + resolved/open snapshots + latest cases;
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
  total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
  needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
  alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
  containment_rate: 0.5, automation_rate: 0.5,
};

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 3,
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

  it('renders the KPI micro-strip: 5 alert/case tiles (LLM spend NOT a hero tile)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-open-cases')).toBeInTheDocument());
    const strip = screen.getByTestId('kpi-strip');
    for (const id of [
      'kpi-open-cases',
      'kpi-critical-high',
      'kpi-escalated-to-human',
      'kpi-false-positive-rate',
      'kpi-auto-resolved',
    ]) {
      expect(within(strip).getByTestId(id)).toBeInTheDocument();
    }
    // EXACTLY 5 hero tiles.
    expect(strip.querySelectorAll('[data-testid^="kpi-"]')).toHaveLength(5);
    // Spend is not on the strip.
    expect(within(strip).queryByTestId('kpi-llm-spend')).toBeNull();
    // Open cases includes both the ordinary OPEN case and the retained NEEDS_HUMAN
    // non-terminal alias (the backend lifecycle taxonomy counts both as still live).
    expect(within(screen.getByTestId('kpi-open-cases')).getByText('2')).toBeInTheDocument();
    // False-positive rate reads the server quality rate (0.5 → "50%").
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%')).toBeInTheDocument();
    // Auto-resolved reads the server quality count (auto_closed_cases = 1).
    expect(within(screen.getByTestId('kpi-auto-resolved')).getByText('1')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-open-cases')).toHaveClass('min-h-28', 'px-4', 'py-5');
    expect(
      within(screen.getByTestId('kpi-critical-high')).getByText('2 open + 0 resolved'),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-escalated-to-human')).getByText('Awaiting review')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('Closed as false pos.')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-auto-resolved')).getByText('Closed by agent')).toBeInTheDocument();
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
      quality: { ...POSTURE_CMP.quality, false_positive_rate: 0.48, auto_closed_cases: 25 },
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('48%')).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId('kpi-auto-resolved')).getByText('25')).toBeInTheDocument();

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
    expect(within(screen.getByTestId('kpi-auto-resolved')).getByText('25')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('Loading 7 days'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-auto-resolved')).getByText('Loading 7 days'),
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
        auto_closed_cases: 1355,
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
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('Closed as false pos.'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-auto-resolved')).getByText('Closed by agent'),
    ).toBeInTheDocument();

    // Even if the aborted transport settles late, its 24h data remains discarded.
    requests[1].resolve({
      ...POSTURE_CMP,
      lifecycle: {
        ...POSTURE_CMP.lifecycle,
        mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
      },
      quality: { ...POSTURE_CMP.quality, false_positive_rate: 0.49, auto_closed_cases: 25 },
    });
    await Promise.resolve();
    expect(within(timingRegion).getByText('4h')).toBeInTheDocument();
    expect(within(timingRegion).queryByText('45m')).toBeNull();
  });

  it('mounts the instrument band: Active Risk + two donut snapshots + latest cases', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const heroRow = await screen.findByTestId('hero-row');
    // The ONE risk instrument, exactly once, inside the hero row.
    expect(within(heroRow).getByTestId('active-risk-index')).toBeInTheDocument();
    expect(screen.getAllByTestId('active-risk-index')).toHaveLength(1);
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
    for (const id of [
      'kpi-open-cases',
      'kpi-critical-high',
      'kpi-escalated-to-human',
      'kpi-false-positive-rate',
      'kpi-auto-resolved',
    ]) {
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

  it('deep-links the Open KPI to the complete active-case lifecycle in this window', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const openTile = await screen.findByTestId('kpi-open-cases');
    await userEvent.click(openTile);
    expect(onNavigate).toHaveBeenCalledWith('cases', {
      status: '__active__',
      window: expect.any(Number),
    });
  });

  it('deep-links the snapshot CTAs to the resolved / open case lists', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    await userEvent.click(await screen.findByRole('button', { name: /View resolved cases/i }));
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: 'closed', window: expect.any(Number) }),
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

  it('deep-links the combined Critical/High KPI to the selected window without pretending one severity', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-critical-high');
    await userEvent.click(tile);
    expect(onNavigate).toHaveBeenCalledWith('cases', { window: expect.any(Number) });
    const [, opts] = onNavigate.mock.calls[0];
    // The Cases page only supports one severity at a time. The tile represents the
    // Critical OR High union, so applying either singleton filter would be misleading.
    expect(opts).not.toHaveProperty('severity');
    expect(opts).not.toHaveProperty('status');
  });

  it('reconciles selected-window Critical/High across every open state plus resolved cases', async () => {
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

    render(<Overview onNavigate={vi.fn()} />);
    const tile = await screen.findByTestId('kpi-critical-high');

    // Current-window all-lifecycle total = 3 still-open C/H + 1 resolved C/H. The
    // 55 previous-window C/H cases power only comparison data and never inflate it.
    await waitFor(() => expect(within(tile).getByText('4')).toBeInTheDocument());
    expect(within(tile).getByText('3 open + 1 resolved')).toBeInTheDocument();

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
  // CRITICAL (it read HIGH under the old 80-cut). Locked via the Critical/High KPI sub.
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
    // 88 + 76 BOTH band Critical → the Critical/High tile shows all 3 selected-window
    // open cases, and the Open snapshot's severity row reports 2 Critical. Under the
    // old 80-cut, that row would report only 1 Critical.
    const tile = await screen.findByTestId('kpi-critical-high');
    await waitFor(() => expect(within(tile).getByText('3')).toBeInTheDocument());
    expect(within(tile).getByText('3 open + 0 resolved')).toBeInTheDocument();
    const openSnapshot = screen.getByRole('button', { name: 'View open cases' });
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
    // s1 counts Critical (via severity_band, NOT its risk_score 20 which is Low) → the
    // Critical/High tile shows 2 selected-window open cases (s1 critical + s2 high).
    const tile = await screen.findByTestId('kpi-critical-high');
    await waitFor(() => expect(within(tile).getByText('2')).toBeInTheDocument());
    expect(within(tile).getByText('2 open + 0 resolved')).toBeInTheDocument();
    const openSnapshot = screen.getByRole('button', { name: 'View open cases' });
    const criticalRow = within(openSnapshot).getByText('Critical').closest('li');
    expect(criticalRow).not.toBeNull();
    expect(within(criticalRow as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('folds the secondary bands (autonomy #3, connectors, volume, full timing) into Deeper analytics', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // Folded away by default.
    expect(screen.queryByRole('region', { name: /Autonomous vs human/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /Ingest coverage/i })).toBeNull();
    // Expand.
    const deeper = await screen.findByRole('button', { name: /Deeper analytics/i });
    await userEvent.click(deeper);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Autonomous vs human/i })).toBeInTheDocument(),
    );
    expect(screen.getByText(/never influences that/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Ingest coverage/i })).toBeInTheDocument();
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
