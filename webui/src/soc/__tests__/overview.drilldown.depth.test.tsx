/**
 * Overview — the KPI drill-down's DEPTH contract.
 *
 * `overview.drilldown.test.tsx` pins placement, population, in-place narrowing and the
 * three-valued honesty flag. THIS file pins the parts that stop the panel from answering
 * whole-population questions over one page of the newest rows:
 *
 *   1. SORT — a real server sort on an IMMUTABLE axis, with the menu built from the
 *      allow-list the response echoes.
 *   2. PAGING — `offset` under a PINNED HEAD, accumulating and deduping, resetting when
 *      the question changes, and never re-running the self-healing facet effects.
 *   3. FACETS — a scalar lifecycle GROUP the server resolves, a status menu that is the
 *      union of every page read, and a severity menu seeded from the server's whole-window
 *      band tally.
 *   4. HONESTY — a page-aware footer, and a footer that NAMES which narrowings were
 *      evaluated over the rows read rather than the population.
 *   5. HAND-OFF — the drill-through carries what the destination can honour and DISCLOSES
 *      what it cannot.
 *
 * Fully offline; nothing here touches #3 runtime behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

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
import {
  DRILLDOWN_PAGE_LIMIT,
  DRILLDOWN_SORTS,
  dedupeById,
  mergeTokens,
} from '../components/KpiDrilldownPanel';
import { SEVERITY_BAND_ORDER } from '../components/badges';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

/**
 * A cohort whose two timestamps DISAGREE about order.
 *
 * `axis-newest-created` is the newest by creation and the OLDEST by update;
 * `axis-newest-updated` is the reverse. Under the comparator this panel used to run —
 * `updated_at || created_at` — the second row would lead. It must not: the server orders
 * by the creation instant, which is immutable and is the same axis as both the range
 * bound and the head pin, and a client comparator on a different axis would silently
 * reshuffle the very pages the server just ordered.
 */
const CASES: Case[] = [
  {
    case_id: 'axis-newest-created',
    case_number: 'A-1',
    title: 'Newest by creation',
    status: 'open',
    risk_score: 40,
    created_at: '2026-07-01T06:00:00Z',
    updated_at: '2026-07-01T01:00:00Z',
  },
  {
    case_id: 'axis-newest-updated',
    case_number: 'A-2',
    title: 'Newest by update',
    status: 'investigating',
    risk_score: 90,
    created_at: '2026-07-01T02:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
  },
  {
    case_id: 'axis-oldest',
    case_number: 'A-3',
    title: 'Oldest all round',
    status: 'closed',
    risk_score: 10,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:30:00Z',
  },
] as unknown as Case[];

const TRENDS = {
  window_hours: 24,
  bucket_minutes: 60,
  generated_at: '2026-07-01T08:00:00Z',
  buckets: [],
  truncated: false,
  store_total: 0,
  fetched: 0,
};

const METRICS = {
  total_cases: 3, open_cases: 2, needs_human_cases: 0, closed_cases: 1,
  by_status: {}, by_verdict: {}, persona_usage: {}, playbook_usage: {},
  avg_risk_score: 46, mttr_minutes: 60, resolved_count: 1, cases_per_day: [],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

/**
 * The band tally is deliberately NOT a page-derived one: `high` has cases in the window
 * but NONE of the three rows above bands as `high` (risk 40/90/10 land elsewhere on the
 * ladder), and `low` is zero-filled. A page-scoped menu can therefore never offer `high`,
 * and a menu that trusted the tally's key ORDER would offer `low`.
 */
const BAND_TALLY = { critical: 3, high: 2, medium: 1, low: 0, info: 0 };

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 6,
  severity_counts: BAND_TALLY,
  open_now: { count: 2, window_exempt: true, as_of: '2026-07-01T08:00:00Z', complete: true, reason: '' },
  window_covered: true,
  window_coverage_reason: '',
  oldest_fetched_at: '2026-06-30T08:00:00Z',
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'none yet' },
  },
  quality: {
    total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    human_closed_cases: 0, system_closed_cases: 0,
    alert_to_incident_ratio: 0.5, false_positive_rate: 0.5, escalation_rate: 0,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1, closure_vs_arrival: 0.33, backlog: 2 },
  sla: { enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0, resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 100, breaching: [] },
};

/** The echo a current server sends back on any request that engages the new parameters. */
function echo(over: Record<string, unknown> = {}) {
  return {
    sortable_fields: DRILLDOWN_SORTS.map((s) => s.field).filter(
      (f, i, all) => all.indexOf(f) === i,
    ),
    sort_field: 'created_at',
    sort_order: 'desc',
    limit_applied: DRILLDOWN_PAGE_LIMIT,
    offset_applied: 0,
    max_offset: 10_000 - DRILLDOWN_PAGE_LIMIT,
    status_group_applied: null,
    ...over,
  };
}

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

const lastQuery = () =>
  (listCasesMock.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

/** Open a Radix Select and read back the option labels it offers. */
async function optionsOf(testId: string): Promise<string[]> {
  await userEvent.click(screen.getByTestId(testId));
  const listbox = await screen.findByRole('listbox');
  const labels = within(listbox)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  return labels;
}

describe('Overview — KPI drill-down depth', () => {
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
      ...echo(),
    });
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({ total_cost: 0, total_tokens: 0, call_count: 0, currency: 'USD' });
  });

  // ---- (A) server-side sort ----------------------------------------------- //

  it('asks the STORE to sort, on the immutable creation axis', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    listCasesMock.mockClear();
    await openPanel('kpi-total-cases');

    // The default sort is "Most recent", and it is `created_at desc` on the wire.
    const recent = DRILLDOWN_SORTS.find((s) => s.key === 'recent');
    expect(recent).toMatchObject({ field: 'created_at', order: 'desc' });
    expect(lastQuery()).toMatchObject({ sort_field: 'created_at', sort_order: 'desc' });

    // Both recency sorts share that axis — neither reads the MUTABLE update timestamp,
    // which is what made offset paging repeat and skip rows.
    for (const key of ['recent', 'oldest'] as const) {
      expect(DRILLDOWN_SORTS.find((s) => s.key === key)?.field).toBe('created_at');
    }

    // Re-derived from that axis: the visible order is by CREATION, so the case that is
    // newest by creation leads even though another row was updated far more recently.
    // Under the comparator this replaces, `axis-newest-updated` would have led.
    expect(rowText()[0]).toContain('Newest by creation');
    expect(rowText()[1]).toContain('Newest by update');
    expect(rowText()[2]).toContain('Oldest all round');
  });

  it('changes the server sort when the operator picks another ordering', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    listCasesMock.mockClear();

    await userEvent.click(screen.getByTestId('kpi-drilldown-sort'));
    await userEvent.click(await screen.findByRole('option', { name: 'Highest risk' }));
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    expect(lastQuery()).toMatchObject({ sort_field: 'risk_score', sort_order: 'desc' });
  });

  it('builds the sort MENU from the allow-list the server echoed', async () => {
    // A deployment whose store cannot order by risk. No client change; the menu must
    // simply stop offering an ordering that will not be applied.
    listCasesMock.mockResolvedValue({
      cases: CASES,
      total: CASES.length,
      window_total_exact: true,
      ...echo({ sortable_fields: ['created_at'] }),
    });
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const labels = await optionsOf('kpi-drilldown-sort');
    const byCreation = DRILLDOWN_SORTS.filter((s) => s.field === 'created_at').map((s) => s.label);
    const byRisk = DRILLDOWN_SORTS.filter((s) => s.field === 'risk_score').map((s) => s.label);
    expect(labels).toEqual(byCreation);
    for (const gone of byRisk) expect(labels).not.toContain(gone);
  });

  // ---- (B) offset paging under a pinned head ------------------------------ //

  it('pages by OFFSET under one pinned head, accumulating and deduping rows', async () => {
    const pageOne = Array.from({ length: DRILLDOWN_PAGE_LIMIT }, (_, i) => ({
      ...CASES[0],
      case_id: `p1-${i}`,
      case_number: `P1-${i}`,
      title: `Page one row ${i}`,
    })) as unknown as Case[];
    // Page two deliberately REPEATS the last row of page one — the race the head pin
    // narrows but cannot close — plus one genuinely new row.
    const pageTwo = [
      pageOne[DRILLDOWN_PAGE_LIMIT - 1],
      { ...CASES[0], case_id: 'p2-new', case_number: 'P2-0', title: 'Page two row' },
    ] as unknown as Case[];

    listCasesMock.mockImplementation(async (q: Record<string, unknown>) =>
      (q.offset as number) === 0
        ? { cases: pageOne, total: 201, window_total_exact: true, ...echo() }
        : { cases: pageTwo, total: 201, window_total_exact: true, ...echo({ offset_applied: q.offset }) },
    );

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    const firstQuery = lastQuery();
    expect(firstQuery.offset).toBe(0);
    const pin = firstQuery.to;
    expect(typeof pin).toBe('string');
    expect(Number.isNaN(Date.parse(String(pin)))).toBe(false);

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(rowText().length).toBeGreaterThan(DRILLDOWN_PAGE_LIMIT));

    const secondQuery = lastQuery();
    expect(secondQuery.offset).toBe(DRILLDOWN_PAGE_LIMIT);
    // The SAME head instant, so a case created while the operator reads cannot shift
    // every subsequent offset by one.
    expect(secondQuery.to).toBe(pin);

    // 200 + 2 fetched, one of them a repeat → 201 distinct rows.
    expect(rowText()).toHaveLength(201);
    const ids = screen.getAllByTestId('kpi-drilldown-row').map((r) => r.textContent);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does NOT raise the client page limit past the server clamp', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    expect(lastQuery().limit).toBe(DRILLDOWN_PAGE_LIMIT);
    // One named module constant, mirrored by the server's own clamp, which stays.
    expect(DRILLDOWN_PAGE_LIMIT).toBe(200);
  });

  it('steps by the limit the SERVER echoed, not by the client constant', async () => {
    // A deployment that clamps below what this panel asks for. Without the echo, a
    // clamped page is indistinguishable from a small result set: the clamp raises no
    // error, sets no header and changes nothing else about the response. The panel would
    // then step `offset` by 200 over 50-row pages — leaving a 150-row hole between every
    // page — and would read the short first page as "the store is exhausted".
    const SERVED = 50;
    const page = (tag: string) =>
      Array.from({ length: SERVED }, (_, i) => ({
        ...CASES[0], case_id: `${tag}-${i}`, case_number: `${tag}-${i}`, title: `${tag} ${i}`,
      })) as unknown as Case[];
    listCasesMock.mockImplementation(async (q: Record<string, unknown>) => ({
      cases: page(`o${q.offset}`),
      total: 500,
      window_total_exact: true,
      ...echo({ limit_applied: SERVED, offset_applied: q.offset }),
    }));

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    // The request still ASKS for the client constant — that mirror is unchanged.
    expect(lastQuery().limit).toBe(DRILLDOWN_PAGE_LIMIT);
    // A 50-row page under a 50-row clamp is a FULL page, so there is more to read.
    const more = screen.getByTestId('kpi-drilldown-more');
    expect(more).toBeInTheDocument();

    await userEvent.click(more);
    // Contiguous under the served size, not the asked-for one.
    await waitFor(() => expect(lastQuery().offset).toBe(SERVED));
    await waitFor(() => expect(rowText()).toHaveLength(SERVED * 2));
  });

  it('resets paging on a range change, and takes a FRESH head pin for the new range', async () => {
    const many = Array.from({ length: DRILLDOWN_PAGE_LIMIT }, (_, i) => ({
      ...CASES[0], case_id: `m-${i}`, case_number: `M-${i}`, title: `Row ${i}`,
    })) as unknown as Case[];
    listCasesMock.mockResolvedValue({
      cases: many, total: 500, window_total_exact: true, ...echo(),
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    const firstPin = lastQuery().to;

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(lastQuery().offset).toBe(DRILLDOWN_PAGE_LIMIT));

    await userEvent.click(screen.getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 7 days' }));
    await waitFor(() => expect(lastQuery().from).toBe('now-168h'));
    // Back to the first page of the NEW question…
    expect(lastQuery().offset).toBe(0);
    // …under its own pin: the previous range's head instant describes a population this
    // request is not asking about.
    expect(lastQuery().to).not.toBe(firstPin);
  });

  it('resets paging on a sort, search or facet change too', async () => {
    const many = Array.from({ length: DRILLDOWN_PAGE_LIMIT }, (_, i) => ({
      ...CASES[0], case_id: `m-${i}`, case_number: `M-${i}`, title: `Row ${i}`,
    })) as unknown as Case[];
    listCasesMock.mockResolvedValue({
      cases: many, total: 500, window_total_exact: true, ...echo(),
    });
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(lastQuery().offset).toBe(DRILLDOWN_PAGE_LIMIT));
    await userEvent.click(screen.getByTestId('kpi-drilldown-sort'));
    await userEvent.click(await screen.findByRole('option', { name: 'Oldest first' }));
    await waitFor(() => expect(lastQuery().sort_order).toBe('asc'));
    expect(lastQuery().offset).toBe(0);

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(lastQuery().offset).toBe(DRILLDOWN_PAGE_LIMIT));
    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'row');
    await waitFor(() => expect(lastQuery().offset).toBe(0));

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(lastQuery().offset).toBe(DRILLDOWN_PAGE_LIMIT));
    await userEvent.click(screen.getByTestId('kpi-drilldown-status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Open' }));
    await waitFor(() => expect(lastQuery().offset).toBe(0));
  });

  it('keeps the a11y contract with the paging control on screen', async () => {
    // A SMALL page that is nonetheless a FULL one, via the server's echoed clamp — so
    // the paging control renders while axe still only has three rows to walk.
    listCasesMock.mockResolvedValue({
      cases: CASES,
      total: 500,
      window_total_exact: true,
      ...echo({ limit_applied: CASES.length }),
    });
    const { container } = renderOverview();
    await screen.findByTestId('page-hero');
    const tile = await openPanel('kpi-total-cases');
    const more = screen.getByTestId('kpi-drilldown-more');

    // The panel's own axe pass runs in `overview.a11y.test.tsx`, on a fixture whose
    // store is exhausted and which therefore never renders this control at all.
    expect(await axe(container)).toHaveNoViolations();

    // The Escape guard is a CONJUNCTION, and every control has to satisfy both halves.
    // A control that consumed Escape without leaving the panel's DOM subtree would have
    // its key swallowed AND tear the panel down; one that portalled out without moving
    // focus would make the panel stop closing altogether.
    more.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    expect(tile).toHaveFocus();
    // A generous budget, not a weakened assertion: a full axe pass over the whole
    // Overview plus an open panel is the slowest thing in this file, and the default
    // 5s is a scheduling accident away from failing under a fully parallel run.
  }, 20_000);

  it('does not double-fetch on a tile swap that changes the default range', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    listCasesMock.mockClear();

    // Total Cases opens on the dashboard window; Open Cases is window-EXEMPT and opens
    // all-time. A reset that ran as an EFFECT issued the old range's request first and
    // superseded it a tick later — discarded by the sequence guard, but paid for.
    await userEvent.click(screen.getByTestId('kpi-open-cases'));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'open-cases'),
    );
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    expect(listCasesMock).toHaveBeenCalledTimes(1);
    expect(lastQuery()).not.toHaveProperty('from');
  });

  it('keeps a selected facet across a page that contains none of it', async () => {
    // Page one carries both statuses; page two carries only one. A page-scoped facet menu
    // would drop the operator's selection the moment page two arrived — silently widening
    // the list they were reading.
    const pageOne = [
      { ...CASES[0], case_id: 'f-1', status: 'open', title: 'Open one' },
      { ...CASES[1], case_id: 'f-2', status: 'investigating', title: 'Investigating one' },
    ] as unknown as Case[];
    const pageTwo = [
      { ...CASES[0], case_id: 'f-3', status: 'open', title: 'Open two' },
    ] as unknown as Case[];
    const padded = [
      ...pageOne,
      ...Array.from({ length: DRILLDOWN_PAGE_LIMIT - 2 }, (_, i) => ({
        ...CASES[0], case_id: `pad-${i}`, status: 'open', title: `Pad ${i}`,
      })),
    ] as unknown as Case[];

    listCasesMock.mockImplementation(async (q: Record<string, unknown>) =>
      (q.offset as number) === 0
        ? { cases: padded, total: 300, window_total_exact: true, ...echo() }
        : { cases: pageTwo, total: 300, window_total_exact: true, ...echo() },
    );

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    await userEvent.click(screen.getByTestId('kpi-drilldown-status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Investigating' }));
    await waitFor(() => expect(rowText()).toHaveLength(1));

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(lastQuery().offset).toBe(DRILLDOWN_PAGE_LIMIT));

    // Still selected, still filtering. The self-healing effects watch the SESSION union,
    // which a page can only grow, so a page arrival cannot invalidate a selection.
    await waitFor(() => expect(rowText()).toHaveLength(1));
    expect(rowText()[0]).toContain('Investigating one');
  });

  // ---- (C) facets that are not page-scoped -------------------------------- //

  it('pushes the two multi-status populations down as a SCALAR group', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');

    await openPanel('kpi-open-cases');
    expect(lastQuery().status_group).toBe('active');
    // Never a list: the query helper stringifies an array into ONE comma-joined term
    // that matches nothing, with no error at any layer.
    expect(Array.isArray(lastQuery().status_group)).toBe(false);
    expect(lastQuery()).not.toHaveProperty('status');

    await userEvent.click(screen.getByTestId('kpi-resolved-closed'));
    await waitFor(() => expect(lastQuery().status_group).toBe('terminal'));

    // The cohort tiles have no lifecycle set to push down and must not invent one.
    await userEvent.click(screen.getByTestId('kpi-total-cases'));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'total-cases'),
    );
    expect(lastQuery()).not.toHaveProperty('status_group');
  });

  it('offers the statuses seen across EVERY page read, and resets them per question', async () => {
    const pageOne = [
      { ...CASES[0], case_id: 'u-1', status: 'open', title: 'Open one' },
      ...Array.from({ length: DRILLDOWN_PAGE_LIMIT - 1 }, (_, i) => ({
        ...CASES[0], case_id: `u-pad-${i}`, status: 'open', title: `Pad ${i}`,
      })),
    ] as unknown as Case[];
    const pageTwo = [
      { ...CASES[0], case_id: 'u-2', status: 'escalated', title: 'Escalated one' },
    ] as unknown as Case[];
    listCasesMock.mockImplementation(async (q: Record<string, unknown>) =>
      (q.offset as number) === 0
        ? { cases: pageOne, total: 300, window_total_exact: true, ...echo() }
        : { cases: pageTwo, total: 300, window_total_exact: true, ...echo() },
    );

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    expect(await optionsOf('kpi-drilldown-status')).not.toContain('Escalated');

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(lastQuery().offset).toBe(DRILLDOWN_PAGE_LIMIT));
    // The UNION, not the current page: page two's status joins page one's.
    const merged = await optionsOf('kpi-drilldown-status');
    expect(merged).toContain('Escalated');
    expect(merged).toContain('Open');

    // A range change asks about a different population, so the union starts again.
    await userEvent.click(screen.getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 24 hours' }));
    await waitFor(() => expect(lastQuery().from).toBe('now-24h'));
    expect(await optionsOf('kpi-drilldown-status')).not.toContain('Escalated');
  });

  it('seeds the severity menu from the WHOLE-WINDOW band tally, in ladder order', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const labels = (await optionsOf('kpi-drilldown-severity')).filter(
      (l) => l !== 'All severities',
    );

    // A band the WINDOW contains but no fetched row carries is offered — impossible for
    // a page-scoped menu, which is the whole point of seeding from the server tally.
    expect(labels).toContain('High');
    // A zero-filled band is not an option: the server has already said the window holds
    // none of it, so offering it would promise rows that do not exist.
    expect(labels).not.toContain('Low');
    expect(labels).not.toContain('Info');

    // Ordered by MEMBERSHIP in the client ladder, never by ZIPPING the server's key
    // order against a client index. The two ladders are the same names in OPPOSITE
    // order, so an index zip would invert severity silently. This assertion fails under
    // a naive zip: the tally's own key order is critical→high→medium, and its first key
    // paired with the client ladder's first entry would name the LOWEST band.
    const expected = [...SEVERITY_BAND_ORDER]
      .reverse()
      .filter((b) => (BAND_TALLY as Record<string, number>)[b] > 0)
      .map((b) => b.charAt(0).toUpperCase() + b.slice(1));
    expect(labels).toEqual(expected);
    expect(labels[0]).not.toBe(
      SEVERITY_BAND_ORDER[0].charAt(0).toUpperCase() + SEVERITY_BAND_ORDER[0].slice(1),
    );

    expect(screen.getByTestId('kpi-drilldown-caveats')).toHaveTextContent(
      /Severity options come from the window/i,
    );
  });

  it('falls back to a page-derived severity menu outside the dashboard window, and SAYS so', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    await userEvent.click(screen.getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'All time' }));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-caveats')).toHaveTextContent(
        /Severity options are derived from the rows read/i,
      ),
    );
    const labels = (await optionsOf('kpi-drilldown-severity')).filter(
      (l) => l !== 'All severities',
    );
    // The tally covered the dashboard window; outside it, only the rows read can speak.
    expect(labels).not.toContain('High');
  });

  it('adds no verdict query parameter — that population stays client-side', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-false-positive-rate');
    expect(lastQuery()).not.toHaveProperty('verdict');
    expect(lastQuery()).not.toHaveProperty('decision_by');
  });

  // ---- (D) honesty --------------------------------------------------------- //

  it('states a page-scoped range once it is past the first page', async () => {
    const many = Array.from({ length: DRILLDOWN_PAGE_LIMIT }, (_, i) => ({
      ...CASES[0], case_id: `s-${i}`, case_number: `S-${i}`, title: `Row ${i}`,
    })) as unknown as Case[];
    listCasesMock.mockImplementation(async (q: Record<string, unknown>) =>
      (q.offset as number) === 0
        ? { cases: many, total: 260, window_total_exact: true, ...echo() }
        : {
            cases: many.slice(0, 60).map((c, i) => ({ ...c, case_id: `s2-${i}` })),
            total: 260,
            window_total_exact: true,
            ...echo(),
          },
    );

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    // Page one: the old wording, unchanged — it really is the newest N.
    expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
      'newest 200 of 260 read',
    );

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    // Page two: "newest 260 of 260" would be a lie about WHICH rows were read, and the
    // completeness test now accounts for the offset instead of comparing the total with
    // one page's length.
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
        /complete: all 260 cases read/i,
      ),
    );
    expect(screen.getByTestId('kpi-drilldown-scope')).not.toHaveTextContent(/newest 260/);
    expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(/2 pages read/i);
  });

  it('NAMES the narrowings that were evaluated over the rows read', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    // The critical tile's predicate is a READ-TIME band, which is stored, mapped and
    // materialised nowhere — it can only ever run over the rows that were read.
    await openPanel('kpi-total-critical');
    const caveats = () => screen.getByTestId('kpi-drilldown-caveats');
    expect(caveats()).toHaveTextContent(/not the whole population/i);
    expect(caveats()).toHaveTextContent(/population rule/i);
    expect(caveats()).toHaveTextContent(/the ordering/i);

    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'newest');
    await waitFor(() => expect(caveats()).toHaveTextContent(/free-text search/i));
  });

  it('never presents the cohort total and a row count as the same measurement', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-critical');
    expect(screen.getByTestId('kpi-drilldown-caveats')).toHaveTextContent(
      /counts every case the store matched for this request; the counts above describe the rows read/i,
    );
  });

  it('excludes policy closes from the FP numerator, exactly as the rate does', async () => {
    const verdicted = [
      { ...CASES[0], case_id: 'fp-agent', title: 'Agent false positive', verdict: 'FALSE_POSITIVE' },
      {
        ...CASES[1],
        case_id: 'fp-policy',
        title: 'Policy closed',
        verdict: 'FALSE_POSITIVE',
        decision_by: 'analyst_policy',
      },
      {
        ...CASES[2],
        case_id: 'fp-policy-payload',
        title: 'Policy closed by payload',
        verdict: 'FALSE_POSITIVE',
        analyst_policy: { rule_identity: 'r' },
      },
    ] as unknown as Case[];
    listCasesMock.mockResolvedValue({
      cases: verdicted, total: 3, window_total_exact: true, ...echo(),
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-false-positive-rate');

    // The server's rate strips policy closes from BOTH halves before it counts anything,
    // so listing one as part of "the rate's numerator" would count a different
    // population than the numeral above it. Both fields the server predicate reads are
    // on the wire, so this is the same test rather than a disclosure of a mismatch.
    await waitFor(() => expect(rowText()).toHaveLength(1));
    expect(rowText()[0]).toContain('Agent false positive');
    expect(screen.getByTestId('kpi-drilldown')).toHaveTextContent(/excluding operator policy closes/i);
  });

  // ---- (E) the hand-off ---------------------------------------------------- //

  it('carries the operator’s facets through the drill-through', async () => {
    const { onNavigate } = renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    await userEvent.click(screen.getByTestId('kpi-drilldown-status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Investigating' }));
    await userEvent.click(screen.getByTestId('kpi-drilldown-drillthrough'));

    expect(onNavigate).toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ status: 'investigating' }),
    );
  });

  it('DISCLOSES what the destination cannot carry', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    // The Cases list has no seeded free-text search and no seeded ordering, so neither
    // travels — and a filter that silently disappeared on a hand-off is worse than one
    // that never travelled, because the list then looks authoritative and is wider than
    // it claims.
    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'newest');
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-carryover')).toHaveTextContent(
        /cannot carry .*search text/i,
      ),
    );

    await userEvent.click(screen.getByTestId('kpi-drilldown-status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Investigating' }));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-carryover')).toHaveTextContent(/carries .*status/i),
    );
  });

  it('still opens ONE case with no window, and widens nothing the operator set', async () => {
    const { onNavigate } = renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-open-cases');

    const panel = screen.getByTestId('kpi-drilldown');
    await userEvent.click(
      within(panel).getByRole('button', { name: /Open case Newest by creation/i }),
    );
    expect(onNavigate).toHaveBeenCalledWith('cases', { caseId: 'axis-newest-created' });
    expect(onNavigate.mock.calls[0][1]).not.toHaveProperty('window');

    // The window-exempt stock's own hand-off still carries no window when the operator
    // has not narrowed the range.
    onNavigate.mockClear();
    await userEvent.click(screen.getByTestId('kpi-drilldown-drillthrough'));
    expect(onNavigate).toHaveBeenCalledWith('cases', { status: '__active__' });
  });

  // ---- pure helpers -------------------------------------------------------- //

  it('dedupes by case id and keeps the first occurrence', () => {
    const a = [{ case_id: 'x' }, { case_id: 'y' }] as unknown as Case[];
    const b = [{ case_id: 'y' }, { case_id: 'z' }] as unknown as Case[];
    expect(dedupeById(a, b).map((c) => c.case_id)).toEqual(['x', 'y', 'z']);
    expect(dedupeById(a, []).map((c) => c.case_id)).toEqual(['x', 'y']);
  });

  it('keeps the previous array IDENTITY when a union gains nothing', () => {
    // Not an optimisation: the facet menus are derived from these unions and the
    // self-healing effects are keyed on the menus, so a fresh array on every page would
    // re-run the very effects that must not fire on a page arrival.
    const previous = ['open'];
    expect(mergeTokens(previous, ['open', '', null, undefined, '  open  '])).toBe(previous);
    expect(mergeTokens(previous, ['escalated'])).toEqual(['open', 'escalated']);
    expect(previous).toEqual(['open']);
  });
});
