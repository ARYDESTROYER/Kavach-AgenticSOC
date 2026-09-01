/**
 * Overview — the KPI tile drill-down disclosure (behaviour).
 *
 * The a11y contract (roles, focus, Escape, Tab, hover-card suppression) lives in
 * `overview.a11y.test.tsx`. THIS file pins the parts that are about being useful and
 * being honest:
 *
 *   1. PLACEMENT — the panel is a SIBLING of the KPI grid, rendered AFTER it and after
 *      the trend caption. Never a sixth child: the grid carries hand-tuned `nth-child`
 *      divider math for exactly five cells, and a sixth would silently redraw every
 *      hairline on the strip.
 *   2. ONE AT A TIME — activating a second tile swaps the panel rather than stacking.
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

async function openPanel(testId: string) {
  const tile = await screen.findByTestId(testId);
  await userEvent.click(tile);
  await screen.findByTestId('kpi-drilldown');
  await waitFor(() =>
    expect(
      screen.queryByTestId('kpi-drilldown-rows') ?? screen.getByTestId('kpi-drilldown-scope'),
    ).toBeInTheDocument(),
  );
  return tile;
}

const rowText = () =>
  screen.getAllByTestId('kpi-drilldown-row').map((r) => r.textContent ?? '');

describe('Overview — KPI drill-down disclosure', () => {
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

  it('docks the panel AFTER the KPI grid and its caption, never inside the grid', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const strip = screen.getByTestId('kpi-strip');
    const panel = screen.getByTestId('kpi-drilldown');

    // A sixth child would silently break the strip's five-cell `nth-child` divider math.
    expect(strip.contains(panel)).toBe(false);
    expect(strip.children).toHaveLength(5);
    // Same parent, and strictly after the grid — DOCUMENT_POSITION_FOLLOWING.
    expect(panel.parentElement).toBe(strip.parentElement);
    expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and after the trend caption that sits between them, so reading order matches
    // the visual stack.
    // Both media-variant spans of the caption ship; either one locates the <p>.
    const caption = screen.getAllByText(/a metric for its/i)[0].closest('p') as HTMLElement;
    expect(caption.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps exactly one panel open and swaps it when a second tile is activated', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'total-cases');

    await userEvent.click(screen.getByTestId('kpi-open-cases'));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'open-cases'),
    );
    expect(screen.getAllByTestId('kpi-drilldown')).toHaveLength(1);
    // The previous trigger no longer claims to be expanded.
    expect(screen.getByTestId('kpi-total-cases')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('kpi-open-cases')).toHaveAttribute('aria-expanded', 'true');
    // Focus follows the NEW panel's heading.
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());
  });

  it('re-activating the same tile closes the panel again', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    const tile = await openPanel('kpi-resolved-closed');
    await userEvent.click(tile);
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    expect(tile).toHaveAttribute('aria-expanded', 'false');
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
    await userEvent.click(screen.getByTestId('kpi-open-cases'));
    await waitFor(() => expect(rowText()).toHaveLength(2));
    expect(rowText().join(' ')).toContain('Unauthorized S3 access');
    expect(rowText().join(' ')).not.toContain('Contained malware drop');

    // Resolved / Closed — BOTH terminal statuses, which is exactly why a
    // single-status deep link could never back this tile.
    await userEvent.click(screen.getByTestId('kpi-resolved-closed'));
    await waitFor(() => expect(rowText()).toHaveLength(2));
    expect(rowText().join(' ')).toContain('Benign admin login'); // closed
    expect(rowText().join(' ')).toContain('Contained malware drop'); // resolved

    // Total Critical — the top band of the ONE severity ladder.
    await userEvent.click(screen.getByTestId('kpi-total-critical'));
    await waitFor(() => expect(rowText()).toHaveLength(2));

    // False Positive Rate — a rate has no list, so the panel lists its NUMERATOR and
    // says so rather than implying the rows add up to a percentage.
    await userEvent.click(screen.getByTestId('kpi-false-positive-rate'));
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
    // Default is most-recent-first.
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
    expect(screen.getByTestId('kpi-drilldown')).toHaveTextContent(/not filtered by the window/i);
  });

  it('states the page it read, and calls it a lower bound when the store did not prove it', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    // Proven complete: the store answered the exact window that was asked for.
    expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
      'Showing 4 of 4 in this page · complete page of 4 cases',
    );

    // A store that could not prove it (absent flag / a wider corpus) must NOT be read
    // as complete — absence means the store answered a different question.
    listCasesMock.mockResolvedValue({ cases: CASES, total: 4821 });
    await userEvent.click(screen.getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 30 days' }));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(/lower bound/i),
    );
    expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
      'newest 4 of 4,821 read',
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
  });

  it('announces open and close through the ONE app live region, as plain text', async () => {
    const { container } = renderOverview();
    await screen.findByTestId('page-hero');
    const tile = await openPanel('kpi-total-critical');

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
    const panel = screen.getByTestId('kpi-drilldown');
    await userEvent.click(
      within(panel).getByRole('button', { name: /Open case Unauthorized S3 access/i }),
    );
    expect(onNavigate).toHaveBeenCalledWith('cases', { caseId: 'c-open-crit' });
    expect(onNavigate.mock.calls[0][1]).not.toHaveProperty('window');
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
  });
});
