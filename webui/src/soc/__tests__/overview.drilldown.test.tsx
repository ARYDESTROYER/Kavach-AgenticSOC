/**
 * Overview — the KPI tile drill-down (behaviour).
 *
 * The a11y contract (roles, focus, Escape, Tab, the scrim, hover-card suppression) lives
 * in `overview.a11y.test.tsx`, and it was INVERTED when this panel became a Radix Dialog:
 * that file is where the modal contract is stated. THIS file pins the parts that are
 * about being useful and being honest:
 *
 *   1. PLACEMENT — the panel is PORTALLED to `document.body`, so it is not a child or a
 *      sibling of the KPI grid at all. That permanently settles the hazard the docked
 *      contract had to be tested for: the grid carries hand-tuned `nth-child` divider
 *      math for exactly the cells it holds, and one extra child would silently redraw
 *      every hairline on the strip.
 *   2. ONE AT A TIME — re-pointing the panel at another metric swaps it rather than
 *      stacking. Behind the scrim the neighbouring TILES are `aria-hidden` and
 *      unclickable, so that is done through the panel's own metric switcher — which is
 *      why the switcher is load-bearing rather than chrome.
 *   3. POPULATION — each tile's panel lists ITS OWN population, taken off the product's
 *      own status/verdict/band vocabulary, not a client-side literal list.
 *   4. FILTER / SORT / RANGE — all three narrow or reorder in place, without navigating.
 *      The range control is a real REFETCH (two of the five populations do not live on
 *      the dashboard's horizon at all — the open-case stock is window-EXEMPT).
 *   5. HONESTY — the footer never claims the list equals the tile's numeral. The tile
 *      is a server rollup over the whole window; this is one bounded page, and it says
 *      which, using `window_total_exact` rather than guessing from the row count.
 *   6. ANNOUNCEMENT — open/close reach the ONE app live region as plain text.
 *
 * Fully offline; nothing here touches #3 runtime behaviour.
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

// Opening a listed case now mounts the SHARED <CaseDetail> over the dashboard instead of
// routing to the Cases list. The real component reads auth context unconditionally and
// this page mounts under no <AuthProvider>, so it is stubbed down to a probe — exactly as
// the Scans and Investigate boards stub it. The probe's id is what proves WHICH case the
// panel handed over.
vi.mock('@/soc/pages/CaseDetail', () => ({
  CaseDetail: ({ caseId }: { caseId?: string | null }) =>
    caseId ? <div data-testid="case-detail-probe">{caseId}</div> : null,
}));

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
import { AnnouncerProvider } from '../components/announcer';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, MetricsTrends } from '@/lib/types';

/** A bucket payload, so the strip renders its trend caption (the panel sits below it). */
const TRENDS: MetricsTrends = {
  window_hours: 24,
  bucket_minutes: 60,
  generated_at: '2026-07-01T08:00:00Z',
  buckets: [
    { t: '2026-07-01T06:00:00Z', new_cases: 2, closed: 1, auto_closed: 1, false_positives: 0, needs_human: 0, escalated: 0, sent_to_human: 0, fp_rate: 20, alerts: null },
    { t: '2026-07-01T07:00:00Z', new_cases: 5, closed: 2, auto_closed: 1, false_positives: 1, needs_human: 0, escalated: 0, sent_to_human: 0, fp_rate: 40, alerts: null },
  ],
  truncated: false,
  store_total: 7,
  fetched: 7,
};

/**
 * A deliberately mixed cohort: two non-terminal, two terminal, one of each severity
 * band that matters here, and exactly one FALSE_POSITIVE verdict.
 */
const CASES: Case[] = [
  {
    case_id: 'c-open-crit',
    case_number: 'T-1',
    title: 'Unauthorized S3 access',
    status: 'open',
    risk_score: 90,
    verdict: 'TRUE_POSITIVE',
    updated_at: '2026-07-01T07:00:00Z',
    created_at: '2026-07-01T06:00:00Z',
  },
  {
    case_id: 'c-open-low',
    case_number: 'T-2',
    title: 'Noisy scanner beacon',
    status: 'investigating',
    risk_score: 10,
    updated_at: '2026-07-01T05:00:00Z',
    created_at: '2026-07-01T04:00:00Z',
  },
  {
    case_id: 'c-closed-fp',
    case_number: 'T-3',
    title: 'Benign admin login',
    status: 'closed',
    risk_score: 30,
    verdict: 'FALSE_POSITIVE',
    updated_at: '2026-07-01T03:00:00Z',
    created_at: '2026-07-01T02:00:00Z',
  },
  {
    case_id: 'c-resolved',
    case_number: 'T-4',
    title: 'Contained malware drop',
    status: 'resolved',
    risk_score: 80,
    verdict: 'TRUE_POSITIVE',
    updated_at: '2026-07-01T01:00:00Z',
    created_at: '2026-07-01T00:00:00Z',
  },
] as unknown as Case[];

const METRICS = {
  total_cases: 4,
  open_cases: 2,
  needs_human_cases: 0,
  closed_cases: 2,
  by_status: { open: 1, investigating: 1, closed: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 2, FALSE_POSITIVE: 1, NEEDS_HUMAN: 0, none: 1 },
  persona_usage: {},
  playbook_usage: {},
  avg_risk_score: 52,
  mttr_minutes: 120,
  resolved_count: 2,
  cases_per_day: [],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 4,
  severity_counts: { critical: 2, high: 0, medium: 1, low: 1, info: 0 },
  open_now: {
    count: 7,
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
    dwell_minutes: {
      p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false,
      reason: 'no case has received a first response yet',
    },
  },
  quality: {
    total_cases: 4, verdicted_cases: 3, true_positive_cases: 2, false_positive_cases: 1,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 2, auto_closed_cases: 1,
    human_closed_cases: 1, system_closed_cases: 0,
    alert_to_incident_ratio: 0.5, false_positive_rate: 0.33, escalation_rate: 0,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: {
    queue_depth: 2, age_buckets: [], oldest: [], arrivals: 4, closures: 2,
    closure_vs_arrival: 0.5, backlog: 2,
  },
  sla: {
    enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0,
    resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 100, breaching: [],
  },
};

/** Render inside the ONE app live region so open/close announcements are observable. */
function renderOverview(onNavigate = vi.fn()) {
  return {
    onNavigate,
    ...render(
      <AnnouncerProvider>
        <Overview onNavigate={onNavigate} />
      </AnnouncerProvider>,
    ),
  };
}

/**
 * The ONE open modal layer, asserted rather than assumed.
 *
 * Every interaction in this file is INSIDE that layer, which carries inline
 * `pointer-events: auto` while it is on top — so the direct user-event API keeps working
 * and its pointer-events guard stays meaningful. (The suites that must reach outside the
 * layer disable that guard per-instance; see `overview.a11y.test.tsx`.)
 */
function openDialog(): HTMLElement {
  const layers = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  expect(layers).toHaveLength(1);
  return layers[0];
}

async function openPanel(testId: string) {
  const tile = await screen.findByTestId(testId);
  // Opening from the STRIP is only reachable while nothing is open: behind an open panel
  // the strip is `aria-hidden` and `pointer-events: none`. Fail loudly here rather than
  // letting user-event's pointer guard report a modal scrim as an inert control.
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await userEvent.click(tile);
  await screen.findByTestId('kpi-drilldown');
  await waitFor(() =>
    expect(
      screen.queryByTestId('kpi-drilldown-rows') ?? screen.getByTestId('kpi-drilldown-scope'),
    ).toBeInTheDocument(),
  );
  return tile;
}

/**
 * Re-point the OPEN panel at another metric through the panel's OWN switcher.
 *
 * Clicking a neighbouring TILE is no longer a user-reachable path, and forcing it
 * synthetically would not test this either: the pointerdown lands outside the layer, so
 * Radix dismisses the panel and the tile's own click then re-opens it. The panel would
 * CLOSE AND REOPEN rather than swap — remounting the fetch and double-announcing — and a
 * call-count assertion would fail for a reason that has nothing to do with the contract.
 */
async function switchMetric(key: string) {
  await userEvent.click(screen.getByTestId(`kpi-drilldown-metric-${key}`));
  await waitFor(() =>
    expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', key),
  );
}

const rowText = () =>
  screen.getAllByTestId('kpi-drilldown-row').map((r) => r.textContent ?? '');

describe('Overview — KPI drill-down', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    trendsMock.mockReset();
    trendsMock.mockResolvedValue(TRENDS);
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue({
      cases: CASES,
      total: CASES.length,
      window_total_exact: true,
    });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({
      total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD',
    });
  });

  it('keeps the KPI grid at six cells and renders the panel outside the page', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const strip = screen.getByTestId('kpi-strip');
    const panel = screen.getByTestId('kpi-drilldown');

    // A SEVENTH child would silently break the strip's six-cell `nth-child` divider math.
    // That can no longer happen by accident — but the exact cell count is still the reason
    // the panel is not rendered inline, so it stays pinned. Six is also the count the
    // `:nth-child(3n)/(6n)` rules in `Overview`'s `itemClassName` are written against, so
    // this number and that string move together or the hairlines go wrong.
    expect(strip.contains(panel)).toBe(false);
    expect(strip.children).toHaveLength(6);
    // …because it is portalled OUT of the page entirely, which is the real contract now.
    // The old assertions here — same parent, DOCUMENT_POSITION_FOLLOWING after the grid
    // and after the trend caption — were retired rather than repaired: a portal div is
    // appended to `document.body` after the whole RTL container, so ANY portalled node
    // trivially "follows" everything in the page and the comparison measures nothing.
    // Reading order inside the layer is owned by the dialog and is pinned by the
    // labelledby/describedby assertions in `overview.a11y.test.tsx`.
    expect(panel.parentElement).not.toBe(strip.parentElement);
    expect(strip.parentElement?.contains(panel)).toBe(false);
    expect(panel.closest('[data-testid="page-hero"]')).toBeNull();
    expect(document.body.contains(panel)).toBe(true);
    // Walk to the top of the panel's own ancestor chain: it terminates at a direct child
    // of `<body>` that holds none of the page. Written as a walk rather than a fixed
    // parent depth so a Radix portal/guard wrapper can be added without a false failure.
    let root = panel as HTMLElement;
    while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
    expect(root.parentElement).toBe(document.body);
    expect(root.contains(strip)).toBe(false);
  });

  it('keeps exactly one panel open and swaps it when another metric is selected', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'total-cases');

    await switchMetric('open-cases');
    expect(screen.getAllByTestId('kpi-drilldown')).toHaveLength(1);
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    // The tiles carry no per-tile "which one is open" signal any more — `aria-expanded`
    // is a disclosure semantic and was removed with the docked contract. The switcher's
    // `aria-pressed` is now the single visible statement of which metric is current, and
    // the panel's `data-kpi` is the single source of truth behind it.
    expect(screen.getByTestId('kpi-total-cases')).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByTestId('kpi-drilldown-metric-open-cases')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('kpi-drilldown-metric-total-cases')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Focus follows the NEW panel's heading.
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());
  });

  it('closes from the panel’s own Close button and returns focus to the tile', async () => {
    // Re-activating the TRIGGER no longer closes the panel: a modal cannot be toggled off
    // by a control the scrim covers. The panel's own labelled Close replaces it, and the
    // focus return is the contract the removed `aria-expanded` assertion used to stand in
    // for — the operator has to get their keyboard place back.
    renderOverview();
    await screen.findByTestId('page-hero');
    const tile = await openPanel('kpi-resolved-closed');
    await userEvent.click(screen.getByTestId('kpi-drilldown-close'));
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await waitFor(() => expect(tile).toHaveFocus());
    expect(tile.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('lists each tile OWN population off the product vocabulary, not the whole page', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');

    // Total Cases — the undivided cohort.
    await openPanel('kpi-total-cases');
    expect(rowText()).toHaveLength(4);
    // Rows are real buttons: a drill-down you cannot act on is a readout, not a
    // drill-down. Exactly one interactive element per row (no nested interactives).
    for (const row of screen.getAllByTestId('kpi-drilldown-row')) {
      expect(within(row).getAllByRole('button')).toHaveLength(1);
    }

    // Open Cases — the non-terminal lifecycle set.
    await switchMetric('open-cases');
    await waitFor(() => expect(rowText()).toHaveLength(2));
    expect(rowText().join(' ')).toContain('Unauthorized S3 access');
    expect(rowText().join(' ')).not.toContain('Contained malware drop');

    // Resolved / Closed — BOTH terminal statuses, which is exactly why a
    // single-status deep link could never back this tile.
    await switchMetric('resolved-closed');
    await waitFor(() => expect(rowText()).toHaveLength(2));
    expect(rowText().join(' ')).toContain('Benign admin login'); // closed
    expect(rowText().join(' ')).toContain('Contained malware drop'); // resolved

    // Total Critical — the top band of the ONE severity ladder.
    await switchMetric('total-critical');
    await waitFor(() => expect(rowText()).toHaveLength(2));

    // False Positive Rate — a rate has no list, so the panel lists its NUMERATOR and
    // says so rather than implying the rows add up to a percentage.
    await switchMetric('false-positive-rate');
    await waitFor(() => expect(rowText()).toHaveLength(1));
    expect(rowText()[0]).toContain('Benign admin login');
    expect(screen.getByTestId('kpi-drilldown')).toHaveTextContent(/numerator/i);
  });

  it('filters, sorts and re-ranges in place — and never navigates away', async () => {
    const { onNavigate } = renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    // ---- filter (free text over the same fields the Cases list searches) ----
    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'malware');
    await waitFor(() => expect(rowText()).toHaveLength(1));
    expect(rowText()[0]).toContain('Contained malware drop');
    await userEvent.clear(screen.getByTestId('kpi-drilldown-search'));
    await waitFor(() => expect(rowText()).toHaveLength(4));

    // ---- sort ----
    // Default is most-recent-first. RE-DERIVED, because the sort AXIS deliberately
    // changed: "most recent" is now the immutable `created_at` the server orders by,
    // not the mutable `updated_at || created_at` a client comparator used to prefer.
    // Working it out for THIS cohort: created_at descending is 06:00 → 04:00 → 02:00 →
    // 00:00, i.e. c-open-crit, c-open-low, c-closed-fp, c-resolved. The fixture's
    // updated_at happens to run in the same order (07:00 → 05:00 → 03:00 → 01:00), so
    // the expected first row is unchanged — and it is still a SPECIFIC row, not a set
    // membership. `overview.drilldown.depth.test.tsx` carries the cohort whose two
    // timestamps DISAGREE, which is what actually pins the axis.
    expect(rowText()[0]).toContain('Unauthorized S3 access');
    await userEvent.click(screen.getByTestId('kpi-drilldown-sort'));
    await userEvent.click(await screen.findByRole('option', { name: 'Lowest risk' }));
    await waitFor(() => expect(rowText()[0]).toContain('Noisy scanner beacon'));
    await userEvent.click(screen.getByTestId('kpi-drilldown-sort'));
    await userEvent.click(await screen.findByRole('option', { name: 'Highest risk' }));
    await waitFor(() => expect(rowText()[0]).toContain('Unauthorized S3 access'));

    // ---- time range: a real REFETCH against the chosen horizon ----
    listCasesMock.mockClear();
    await userEvent.click(screen.getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 7 days' }));
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    expect(listCasesMock.mock.calls.at(-1)?.[0]).toMatchObject({
      limit: 200,
      from: 'now-168h',
    });

    // Not once did any of that leave the page.
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('opens the window-EXEMPT open stock on an ALL-TIME page, with no `from` bound', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    listCasesMock.mockClear();
    await openPanel('kpi-open-cases');

    // Scoping this list to the dashboard window would hand the operator a SHORTER list
    // than the stock they just clicked.
    const arg = listCasesMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg).toMatchObject({ limit: 200 });
    expect(arg).not.toHaveProperty('from');
    // That sentence is ALSO the dialog's `aria-describedby` target, so the exemption is
    // announced on open rather than only readable. Pin that it is the same node: a
    // describedby pointing anywhere else would make the caveat sighted-only.
    const population = screen.getByTestId('kpi-drilldown-population');
    expect(population).toHaveTextContent(/not filtered by the window/i);
    expect(openDialog().getAttribute('aria-describedby')).toBe(population.id);
  });

  it('states the page it read, and calls it a lower bound when the store did not prove it', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    // Proven complete: the store answered the exact window that was asked for.
    expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
      'Showing 4 of 4 in this page · complete page of 4 cases',
    );
    // The heading badge restates the SAME three-valued read, and nothing else pins that
    // the two agree — two independently rendered answers to one question is exactly the
    // "two numerals, two questions" failure this file exists to prevent. It is also a
    // SIBLING of the footer sentence, never a child, so the negative `-scope` assertions
    // below stay assertions about the footer's own wording.
    const completeness = screen.getByTestId('kpi-drilldown-completeness');
    expect(completeness).toHaveTextContent(/^Complete page$/);
    expect(screen.getByTestId('kpi-drilldown-scope').contains(completeness)).toBe(false);

    // A store that could not prove it (absent flag / a wider corpus) must NOT be read
    // as complete — absence means the store answered a different question.
    listCasesMock.mockResolvedValue({ cases: CASES, total: 4821 });
    await userEvent.click(screen.getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 30 days' }));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(/lower bound/i),
    );
    expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
      'first 4 of 4,821 in this order',
    );
    expect(screen.getByTestId('kpi-drilldown-completeness')).toHaveTextContent(
      /^Bounded page · lower bound$/,
    );
  });

  it('calls a WINDOWLESS complete read complete, not a lower bound', async () => {
    // `window_total_exact` is THREE-valued and each value means something different:
    // `true` = the store proved the windowed total, `false` = it could not, and absent
    // = NO WINDOW WAS REQUESTED, which the route documents precisely so a client can
    // tell "not applicable" from "not proven". The Open Cases tile is window-EXEMPT and
    // therefore sends no bound on every open — collapsing the flag to a boolean labelled
    // its every page a floor while simultaneously reporting "4 of 4 read".
    listCasesMock.mockResolvedValue({
      cases: CASES,
      total: CASES.length,
      window_total_exact: null,
    });
    renderOverview();
    await screen.findByTestId('page-hero');
    listCasesMock.mockClear();
    await openPanel('kpi-open-cases');

    const arg = listCasesMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('from');
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
        /complete page of 4 cases/,
      ),
    );
    expect(screen.getByTestId('kpi-drilldown-scope')).not.toHaveTextContent(/lower bound/i);
    // The badge says the same thing, from the same read.
    expect(screen.getByTestId('kpi-drilldown-completeness')).toHaveTextContent(/^Complete page$/);
  });

  it('still calls a WINDOWED page with no flag a lower bound, even when it is complete', async () => {
    // The other half of the three-state read: a backend that predates the flag returns
    // absent for a WINDOWED request too, and there the absence really is "not proven".
    // Only the request shape separates the two, and only the panel knows it.
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(/lower bound/i),
    );
    expect(screen.getByTestId('kpi-drilldown-completeness')).toHaveTextContent(/lower bound/i);
  });

  it('announces open and close through the ONE app live region, as plain text', async () => {
    const { container } = renderOverview();
    await screen.findByTestId('page-hero');
    const tile = await openPanel('kpi-total-critical');

    // Deliberately scoped to `container`, not `document.body`: this asserts the app's OWN
    // live region carried the announcement. It survives the modal because `hideOthers`
    // exempts `[aria-live]` nodes and keeps their ancestor chain unhidden — widening the
    // query to the body would quietly stop proving the region is the app's.
    const regions = () =>
      Array.from(container.querySelectorAll('[aria-live]'))
        .map((n) => n.textContent ?? '')
        .join(' ');
    await waitFor(() => expect(regions()).toContain('Total Critical details opened'));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await waitFor(() => expect(regions()).toContain('Total Critical details closed'));
    expect(tile).toHaveFocus();
  });

  it('opens a listed case from the panel, carrying no window that could hide it', async () => {
    const { onNavigate } = renderOverview();
    await screen.findByTestId('page-hero');
    // The open-case stock's panel is on an ALL-TIME page, so its rows can legitimately
    // sit outside the dashboard window — attaching that window to the handoff would
    // hide the very case the operator just clicked.
    await openPanel('kpi-open-cases');
    // Scoped to the panel: the instrument band's "Latest cases" queue offers the same
    // accessible name for the same case, and this assertion is about the PANEL's row.
    // Doubly true now — that queue is `aria-hidden` behind the scrim, so an unscoped
    // role query would be resolving against a surface the operator cannot reach.
    const panel = screen.getByTestId('kpi-drilldown');
    expect(screen.getByTestId('kpi-strip').closest('[aria-hidden="true"]')).not.toBeNull();
    await userEvent.click(
      within(panel).getByRole('button', { name: /Open case Unauthorized S3 access/i }),
    );
    // The case opens OVER the dashboard, so the panel stays open behind it and the
    // operator returns to the exact population they were reading. There is no navigation
    // at all, which is what settles the old window question: nothing can carry a window
    // narrower than the row just clicked, because nothing is carried.
    expect(await screen.findByTestId('case-detail-probe')).toHaveTextContent('c-open-crit');
    expect(onNavigate).not.toHaveBeenCalledWith('cases', expect.objectContaining({ caseId: 'c-open-crit' }));
  });

  it('degrades to an honest empty state rather than an empty list', async () => {
    listCasesMock.mockResolvedValue({ cases: [], total: 0, window_total_exact: true });
    renderOverview();
    await screen.findByTestId('page-hero');
    // The strip still renders (posture carries the numerals); the panel simply has no
    // rows to show for this range and says which.
    await userEvent.click(await screen.findByTestId('kpi-total-cases'));
    const panel = await screen.findByTestId('kpi-drilldown');
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown-rows')).toBeNull());
    expect(within(panel).getByText(/No cases in this range/i)).toBeInTheDocument();
    // The scroll port is the SHELL, not the rows: it survives an empty page, which is
    // what keeps the fixed-height panel from collapsing around an empty state.
    expect(within(panel).getAllByTestId('kpi-drilldown-scroll')).toHaveLength(1);
    // …and the completeness badge is withheld until a page has actually been read, so an
    // error or a load in flight cannot be reported as a bounded page. Here a page WAS
    // read — an empty one — so it renders and states what that read proved.
    expect(within(panel).getByTestId('kpi-drilldown-completeness')).toBeInTheDocument();
  });
});
