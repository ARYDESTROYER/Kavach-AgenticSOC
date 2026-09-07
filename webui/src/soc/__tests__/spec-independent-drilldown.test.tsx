/**
 * SPEC-DERIVED, implementation-blind tests for ASK 2 (KPI drill-down depth, client half).
 *
 * Written from `tmp/SPEC.md` alone, without reading `soc/components/KpiDrilldownPanel.tsx`
 * or `soc/pages/Overview.tsx`. Every selector below was discovered by RENDERING the page
 * and reading the DOM it produced, and every expectation is derived either from the
 * fixture this test feeds in or from a shared module the panel and this test both import
 * (`SEVERITY_BAND_ORDER`), never from a literal transcribed out of the component.
 *
 * The criteria here are the ones whose wrong implementation is SILENT to an operator:
 *
 *   B18/B19  a page-2 fetch that moves the head instant, or repeats a row, produces a
 *            list that is simply wrong and looks entirely normal.
 *   B22      a self-healing facet effect that fires on a page change silently discards
 *            the narrowing the operator set, and shows them a wider list under the old
 *            label.
 *   B29      the client's band ladder ASCENDS and the server's DESCENDS; a naive index
 *            zip therefore mislabels every severity facet option, and the labels still
 *            look plausible.
 *   B33      the first-page completeness claim is false on page 2 and reads exactly as true.
 *   B36      the server's rate and the panel's predicate answer different questions; a
 *            footer that claims they match is a lie with a number attached.
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

// Opening a listed case mounts the SHARED <CaseDetail> over the dashboard. The real
// component reads auth context unconditionally and this page mounts under no
// <AuthProvider>, so it is stubbed to a probe (the same stub Scans and Investigate use).
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
import { SEVERITY_BAND_ORDER } from '../components/badges';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, MetricsTrends } from '@/lib/types';

/* ------------------------------------------------------------------------- */
/* Fixture vocabulary.                                                        */
/*                                                                            */
/* `SERVER_BAND_TALLY` is written in the SERVER's ladder order (highest band  */
/* first) because that is the order the whole-window band histogram arrives   */
/* in on the wire. Its key order is the ONLY source of truth this file uses   */
/* for the expected facet ordering — nothing here transcribes a band list.    */
/* No deployment-observed number, no product/vendor name, no IP, no           */
/* deployer-invented field appears anywhere below.                            */
/* ------------------------------------------------------------------------- */
const SERVER_BAND_TALLY = {
  critical: 3,
  high: 0,
  medium: 0,
  low: 0,
  info: 2,
} as const;

/** The bands the tally says are present, in the server's own iteration order. */
const PRESENT_BANDS = Object.entries(SERVER_BAND_TALLY)
  .filter(([, count]) => count > 0)
  .map(([band]) => band);

const cap = (band: string) => band.charAt(0).toUpperCase() + band.slice(1);

const TRENDS: MetricsTrends = {
  window_hours: 24,
  bucket_minutes: 60,
  generated_at: '2026-07-01T08:00:00Z',
  buckets: [
    {
      t: '2026-07-01T07:00:00Z',
      new_cases: 5, closed: 2, auto_closed: 1, false_positives: 1,
      needs_human: 0, escalated: 0, sent_to_human: 0, fp_rate: 40, alerts: null,
    },
  ],
  truncated: false,
  store_total: 7,
  fetched: 7,
};

const METRICS = {
  total_cases: 4, open_cases: 2, needs_human_cases: 0, closed_cases: 2,
  by_status: { open: 1, investigating: 1, closed: 1, resolved: 1 },
  by_verdict: { TRUE_POSITIVE: 2, FALSE_POSITIVE: 1, NEEDS_HUMAN: 0, none: 1 },
  persona_usage: {}, playbook_usage: {}, avg_risk_score: 52, mttr_minutes: 120,
  resolved_count: 2, cases_per_day: [],
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

function posture(overrides: Partial<PostureResponse> = {}): PostureResponse {
  return {
    window_hours: 24,
    generated_at: '2026-07-01T08:00:00Z',
    case_count: 5,
    severity_counts: { ...SERVER_BAND_TALLY },
    open_now: {
      count: 7, window_exempt: true, as_of: '2026-07-01T08:00:00Z',
      complete: true, reason: '',
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
      total_cases: 5, verdicted_cases: 4, true_positive_cases: 2, false_positive_cases: 2,
      needs_human_cases: 0, escalated_cases: 0, terminal_cases: 3, auto_closed_cases: 1,
      human_closed_cases: 1, system_closed_cases: 0,
      alert_to_incident_ratio: 0.5, false_positive_rate: 0.4, escalation_rate: 0,
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
    ...overrides,
  };
}

/**
 * A case whose severity BAND is chosen by name rather than by an invented number.
 * The mid-point of each band's slice of the 0-100 magnitude axis is computed from the
 * shared ascending ladder, so no scale-tied number is written down here (P2/P4).
 */
function caseInBand(
  id: string,
  band: string,
  extra: Record<string, unknown> = {},
): Case {
  const index = SEVERITY_BAND_ORDER.indexOf(band as never);
  const slice = 100 / SEVERITY_BAND_ORDER.length;
  const magnitude = Math.round(slice * (index + 0.5));
  return {
    case_id: id,
    case_number: id.toUpperCase(),
    title: `case ${id}`,
    status: 'open',
    risk_score: magnitude,
    updated_at: '2026-07-01T07:00:00Z',
    created_at: '2026-07-01T06:00:00Z',
    ...extra,
  } as unknown as Case;
}

/**
 * A page is only continuable when it came back FULL, so every paging fixture below
 * pads to whatever page size the panel actually asked for. Deriving it from the
 * request means this file never writes the client page limit down (B20).
 */
function fill(size: number, make: (i: number) => Case, offset = 0): Case[] {
  return Array.from({ length: size }, (_, i) => make(offset + i));
}

function page(cases: Case[], total: number, extra: Record<string, unknown> = {}) {
  return {
    cases,
    total,
    window_total_exact: true,
    sortable_fields: ['created_at', 'updated_at', 'risk_score'],
    sort_field: 'created_at',
    sort_order: 'desc',
    limit_applied: 200,
    offset_applied: 0,
    max_offset: 9800,
    status_group_applied: null,
    ...extra,
  };
}

function renderOverview() {
  const onNavigate = vi.fn();
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
 * Open one tile's panel from the STRIP, and wait for its first page.
 *
 * The panel is a Radix MODAL: while one is open `body { pointer-events: none }`, a tile
 * behind the scrim is unclickable, and user-event throws rather than silently doing
 * nothing. So a second call closes the open panel first — which is also what an operator
 * has to do to reach a neighbouring tile. Switching metric WITHOUT closing is a different
 * act with its own in-panel affordance (`kpi-drilldown-metric-<key>`), used where a test
 * is about the switch rather than about the tile.
 */
async function openPanel(testId: string) {
  if (screen.queryByTestId('kpi-drilldown')) {
    await userEvent.click(screen.getByTestId('kpi-drilldown-close'));
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
  }
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

/** Open one of the panel's comboboxes and return the option labels it offers. */
async function optionsOf(testId: string): Promise<string[]> {
  await userEvent.click(screen.getByTestId(testId));
  const labels = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
  // Dismissing the SELECT must not dismiss the panel under it. Radix escapes exactly one
  // layer per keystroke — the highest — and the select is the highest here, so the panel
  // survives. That is the contract the panel's retired hand-rolled containment guard used
  // to approximate, and it is cheap to keep proving from every menu read in this file.
  expect(screen.getByTestId('kpi-drilldown')).toBeInTheDocument();
  return labels;
}

async function chooseOption(testId: string, label: string): Promise<void> {
  await userEvent.click(screen.getByTestId(testId));
  const option = (await screen.findAllByRole('option')).find((o) => o.textContent === label);
  if (!option) throw new Error(`no option "${label}" on ${testId}`);
  await userEvent.click(option);
  await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
}

const rowIds = () =>
  screen.queryAllByTestId('kpi-drilldown-row').map((r) => r.textContent ?? '');

/** Only the panel's own row fetches — the two trend fetches are not paging state. */
const pageRequests = () =>
  listCasesMock.mock.calls
    .map(([params]) => params as Record<string, unknown>)
    .filter((p) => p && 'offset' in p);

describe('KPI drill-down — spec-derived depth', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    trendsMock.mockReset();
    trendsMock.mockResolvedValue(TRENDS);
    fetchPostureMock.mockResolvedValue(posture());
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({
      total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD',
    });
    listCasesMock.mockResolvedValue(page([], 0));
  });

  /* ===================================================================== */
  /* B29 — the two band ladders run in OPPOSITE directions                 */
  /* ===================================================================== */
  it('B29: seeds the severity facet from the server tally without zipping the two ladders', async () => {
    // The premise the criterion rests on, asserted rather than assumed: the client's
    // shared ladder ascends, the server's whole-window tally arrives descending.
    const serverOrder = Object.keys(SERVER_BAND_TALLY);
    expect([...SEVERITY_BAND_ORDER]).toEqual([...serverOrder].reverse());

    listCasesMock.mockResolvedValue(
      page(PRESENT_BANDS.map((band, i) => caseInBand(`b${i}`, band)), PRESENT_BANDS.length),
    );
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const labels = await optionsOf('kpi-drilldown-severity');
    const bands = labels.slice(1); // the first entry is the "all" escape hatch

    // The correct answer: the present bands, in the SERVER tally's own order.
    expect(bands).toEqual(PRESENT_BANDS.map(cap));

    // …and the answer a naive index zip against the client ladder would have produced.
    // It is a DIFFERENT, entirely plausible-looking list — which is why this bug hides.
    const naive = PRESENT_BANDS.map((_, i) => SEVERITY_BAND_ORDER[i]).map(cap);
    expect(naive).not.toEqual(bands);
    expect(bands).not.toEqual(naive);
  });

  it('B28: says the severity options are page-derived once the range leaves the dashboard window', async () => {
    listCasesMock.mockResolvedValue(
      page(PRESENT_BANDS.map((band, i) => caseInBand(`b${i}`, band)), PRESENT_BANDS.length),
    );
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const windowClaim = screen.getByTestId('kpi-drilldown-caveats').textContent ?? '';
    expect(windowClaim.toLowerCase()).toMatch(/severity/);

    const ranges = await optionsOf('kpi-drilldown-range');
    const other = ranges.find((r) => !/dashboard/i.test(r));
    expect(other, 'the panel must offer a range outside the dashboard window').toBeTruthy();
    await chooseOption('kpi-drilldown-range', other as string);
    await waitFor(() => expect(pageRequests().length).toBeGreaterThan(1));

    const outsideClaim = screen.getByTestId('kpi-drilldown-caveats').textContent ?? '';
    // Outside the dashboard window the whole-window tally does not apply, and the panel
    // must SAY the list it is showing came from the rows on the page.
    expect(outsideClaim).not.toEqual(windowClaim);
    expect(outsideClaim.toLowerCase()).toMatch(/page/);
  });

  /* ===================================================================== */
  /* B18 / B19 — the pinned head, and dedupe in spite of it                */
  /* ===================================================================== */
  it('B18/B19: every page of one range repeats the same pinned head, and repeated rows are deduped', async () => {
    let pageSize = 0;
    let repeated = '';
    listCasesMock.mockImplementation(async (params: Record<string, unknown>) => {
      if (!params || !('offset' in params)) return page([], 0);
      const size = Number(params.limit);
      pageSize = size;
      const bands = PRESENT_BANDS;
      if (Number(params.offset) === 0) {
        return page(fill(size, (i) => caseInBand(`p${i}`, bands[i % bands.length])), size * 4);
      }
      // Page two DELIBERATELY repeats page one's LAST row — the exact symptom of a
      // moving head, and the thing the dedupe exists to survive.
      repeated = `p${size - 1}`;
      const rows = fill(size, (i) => caseInBand(`q${i}`, bands[i % bands.length]));
      rows[0] = caseInBand(repeated, bands[(size - 1) % bands.length]);
      return page(rows, size * 4);
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    await waitFor(() => expect(rowIds().length).toBe(pageSize));

    const more = screen.getByTestId('kpi-drilldown-more');
    await userEvent.click(more);
    await waitFor(() => expect(pageRequests().length).toBeGreaterThan(1));

    const [firstRequest, secondRequest] = pageRequests();
    // B18 — the head instant captured on the first fetch is re-sent verbatim.
    expect(secondRequest.to).toBe(firstRequest.to);
    expect(secondRequest.to).toBeTruthy();
    expect(secondRequest.from).toBe(firstRequest.from);
    // …and the page really did advance.
    expect(Number(secondRequest.offset)).toBeGreaterThan(Number(firstRequest.offset));
    // The sort axis is carried too — paging on a mutable key is what repeats rows.
    expect(secondRequest.sort_field).toBe(firstRequest.sort_field);
    expect(secondRequest.sort_order).toBe(firstRequest.sort_order);

    // B19 — two full pages sharing one row yield 2*size-1 DISTINCT rows, not 2*size.
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(pageSize));
    const ids = rowIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(pageSize * 2 - 1);
  });

  /* ===================================================================== */
  /* B33 — the completeness statement accounts for offset                  */
  /* ===================================================================== */
  it('B33: replaces the first-page "first N of M" claim with a page-scoped one after the first page', async () => {
    let pageSize = 0;
    listCasesMock.mockImplementation(async (params: Record<string, unknown>) => {
      if (!params || !('offset' in params)) return page([], 0);
      const size = Number(params.limit);
      pageSize = size;
      const prefix = Number(params.offset) === 0 ? 'a' : 'b';
      return page(
        fill(size, (i) => caseInBand(`${prefix}${i}`, PRESENT_BANDS[i % PRESENT_BANDS.length])),
        size * 4,
      );
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    await waitFor(() => expect(rowIds().length).toBe(pageSize));

    const beforePaging = screen.getByTestId('kpi-drilldown-scope').textContent ?? '';
    // Page one legitimately holds the first N rows OF THE ORDER IN FORCE. It is not
    // "the newest N" — three of the four sorts the store honours put something else
    // first — so the claim names the order rather than assuming recency.
    expect(beforePaging.toLowerCase()).toContain('in this order');

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(pageRequests().length).toBeGreaterThan(1));
    await waitFor(() => expect(rowIds().length).toBe(pageSize * 2));

    const afterPaging = screen.getByTestId('kpi-drilldown-scope').textContent ?? '';
    expect(afterPaging).not.toEqual(beforePaging);
    expect(afterPaging.toLowerCase()).not.toContain('in this order');
  });

  /* ===================================================================== */
  /* B22 — a page change must NOT run the self-healing facet effects       */
  /* ===================================================================== */
  it('B22: a selected facet survives paging to a page containing no matching row', async () => {
    const chosen = PRESENT_BANDS[0];
    const other = PRESENT_BANDS[PRESENT_BANDS.length - 1];
    expect(chosen).not.toEqual(other);

    // Page one holds EXACTLY ONE row of the band the operator will select; page two
    // holds NONE of it, which is what makes a self-healing effect fire.
    let pageSize = 0;
    listCasesMock.mockImplementation(async (params: Record<string, unknown>) => {
      if (!params || !('offset' in params)) return page([], 0);
      const size = Number(params.limit);
      pageSize = size;
      if (Number(params.offset) === 0) {
        const rows = fill(size, (i) => caseInBand(`f${i}`, other));
        rows[0] = caseInBand('f0', chosen);
        return page(rows, size * 4);
      }
      return page(fill(size, (i) => caseInBand(`s${i}`, other)), size * 4);
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    await waitFor(() => expect(rowIds().length).toBe(pageSize));

    await chooseOption('kpi-drilldown-severity', cap(chosen));
    await waitFor(() => expect(rowIds()).toHaveLength(1));
    const control = screen.getByTestId('kpi-drilldown-severity');
    expect(control.textContent).toContain(cap(chosen));

    const requestsBefore = pageRequests().length;
    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(pageRequests().length).toBeGreaterThan(requestsBefore));
    // Let any self-healing effect that was going to fire, fire.
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-severity').textContent).toContain(cap(chosen)),
    );

    // The narrowing the operator set is still in force: the page-two rows are all of
    // the OTHER band and none of them may appear under a "chosen band" label.
    expect(rowIds()).toHaveLength(1);
    expect(rowIds()[0]).toContain('F0');
  });

  /* ===================================================================== */
  /* B36 — the verdict-tile population mismatch is RESOLVED, not papered   */
  /* ===================================================================== */
  it('B36: the false-positive tile either applies the server exclusion or discloses that it does not', async () => {
    // Four FALSE_POSITIVE cases; two of them closed under an operator policy. The
    // server's rate excludes those two. Whatever the panel does, it must not claim a
    // match it does not have.
    const rows: Case[] = [
      caseInBand('v1', 'critical', { verdict: 'FALSE_POSITIVE', status: 'closed', decision_by: 'agent' }),
      caseInBand('v2', 'info', { verdict: 'FALSE_POSITIVE', status: 'closed', decision_by: 'agent' }),
      caseInBand('v3', 'critical', { verdict: 'FALSE_POSITIVE', status: 'closed', decision_by: 'analyst_policy' }),
      caseInBand('v4', 'info', { verdict: 'FALSE_POSITIVE', status: 'closed', decision_by: 'analyst_policy' }),
      caseInBand('v5', 'critical', { verdict: 'TRUE_POSITIVE', status: 'open', decision_by: 'agent' }),
    ];
    const excludedCount = rows.filter((c) => (c as never as { decision_by: string }).decision_by === 'analyst_policy').length;
    const allFalsePositives = rows.filter((c) => (c as never as { verdict?: string }).verdict === 'FALSE_POSITIVE').length;
    expect(excludedCount).toBeGreaterThan(0);

    listCasesMock.mockResolvedValue(page(rows, rows.length));
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-false-positive-rate');
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));

    const shown = rowIds().length;
    const caveats = (screen.getByTestId('kpi-drilldown-caveats').textContent ?? '').toLowerCase();
    const appliesExclusion = shown === allFalsePositives - excludedCount;

    if (!appliesExclusion) {
      // The other permitted resolution: say so. A footer that stays silent while the
      // panel counts a different population than the tile is the FAIL case.
      expect(shown).toBe(allFalsePositives);
      expect(caveats).toMatch(/polic|exclud|differ/);
    }
    // Either way the panel must never quietly count the excluded rows into the tile's
    // own population while presenting them as that population.
    expect([allFalsePositives - excludedCount, allFalsePositives]).toContain(shown);
    // And the footer must still separate "what the store matched" from "what was read".
    //
    // The two halves of that separation, named. The alternation that used to stand here
    // (`/rows read|this page|page/`) could not fail: the footer unconditionally says
    // "Status options come from every page read here.", so the bare `page` branch matched
    // every possible footer — including one that had dropped the separation entirely.
    expect(caveats).toMatch(/counts every case the store matched for this request/);
    expect(caveats).toMatch(/the counts above describe the rows read/);
  });

  /* ===================================================================== */
  /* B38 — anything the drill-through cannot carry is DISCLOSED            */
  /* ===================================================================== */
  it('B37/B38: carries the live facet state into the drill-through, and discloses what it cannot carry', async () => {
    listCasesMock.mockResolvedValue(
      page(PRESENT_BANDS.map((band, i) => caseInBand(`d${i}`, band)), PRESENT_BANDS.length),
    );
    const { onNavigate } = renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    // Operator context the drill-through must not throw away.
    const chosen = PRESENT_BANDS[0];
    await chooseOption('kpi-drilldown-severity', cap(chosen));
    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'case');
    // Wait for the panel's OWN acknowledgement that both narrowings are in force before
    // reading anything off the hand-off. Typing settles over several renders, and a
    // drill-through clicked mid-flight builds its context from whatever had landed — which
    // turns "the search was not carried" into a race rather than a finding.
    expect(screen.getByTestId('kpi-drilldown-search')).toHaveValue('case');
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-caveats')).toHaveTextContent(
        /the free-text search/i,
      ),
    );
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));

    // B39 — opening a SINGLE case carries no window, so a narrower window can never hide
    // the row the operator just clicked. It is exercised HERE, before the hand-off, because
    // the hand-off deliberately closes the panel (see below) and there would be no row left
    // to click afterwards.
    onNavigate.mockClear();
    const row = screen.getAllByTestId('kpi-drilldown-row')[0];
    const opener = within(row).queryAllByRole('button')[0] ?? row;
    await userEvent.click(opener);
    if (onNavigate.mock.calls.length > 0) {
      const [, single] = onNavigate.mock.calls[onNavigate.mock.calls.length - 1];
      expect(JSON.stringify(single ?? {}).toLowerCase()).not.toContain('window');
    }

    // B38 — the disclosure is read WHILE the panel is open, which is also the only moment
    // an operator reads it: it is a sentence BESIDE the button, weighed before pressing it,
    // not a receipt handed over afterwards.
    const disclosure = (
      screen.queryByTestId('kpi-drilldown-carryover')?.textContent ?? ''
    ).toLowerCase();

    onNavigate.mockClear();
    await userEvent.click(screen.getByTestId('kpi-drilldown-drillthrough'));
    expect(onNavigate).toHaveBeenCalled();
    const [, carried] = onNavigate.mock.calls[onNavigate.mock.calls.length - 1];

    // The hand-off CLOSES the panel before it navigates. In the app the destination
    // unmounts this page and the modal would go anyway, but that is the destination's
    // behaviour and not this panel's — and a modal left standing over a page the operator
    // has left is never right. Closing first is also what returns focus to the tile before
    // the route changes, rather than dropping it on `<body>` at the far end.
    expect(screen.queryByTestId('kpi-drilldown')).toBeNull();

    // B37 — the ZERO-ARGUMENT call is replaced: something about the operator's live
    // state travels. A destination that receives nothing cannot honour anything.
    expect(carried, 'the drill-through must receive the live state').toBeTruthy();
    const params = carried as Record<string, unknown>;
    const payload = JSON.stringify(carried).toLowerCase();
    // The destination's VALUES, never the stringified object. The old probe ran over
    // `JSON.stringify(carried)`, and the context's own key `windowHours` contains the
    // literal `window` — so the time-range row below matched the KEY and could not fail
    // whatever the payload actually carried.
    const values = Object.values(params).map((v) => String(v).toLowerCase());
    const travelled = (probe: string) => values.some((v) => v.includes(probe));

    // B38 — whatever is NOT in the payload must be named beside the button. The two halves
    // are checked TOGETHER so "carry nothing and say nothing" cannot pass, and each half is
    // now tied to its OWN label: the disclosure test used to be a blanket
    // `/cannot|not carried|reapply|drop/` that a single "It cannot carry …" sentence
    // satisfied for all three labels at once, whichever one it actually named.
    const dropClause = (disclosure.match(/cannot carry ([^—.]+)/) ?? ['', ''])[1];
    const checks: [string, boolean, RegExp][] = [
      ['the severity band', travelled(chosen), /severity|band/],
      ['the free-text search', travelled('case'), /search|text/],
      // The time range is the only member of the context that is a bare number, so a
      // numeric value in the payload IS the window travelling — asserted without this
      // file writing down an hour count it would then be pinning twice.
      ['the time range', values.some((v) => /^\d+$/.test(v)), /time range|window/],
    ];
    for (const [label, wasCarried, named] of checks) {
      expect(
        wasCarried || named.test(dropClause),
        `${label} was neither carried nor disclosed as dropped — payload ${payload}, disclosure "${disclosure}"`,
      ).toBe(true);
    }
    // Non-vacuous: at least one narrowing really travelled, so the loop above is not
    // passing purely on the disclosure branch of every row. (The converse is deliberately
    // NOT asserted: a destination that grew the ability to honour everything would leave
    // nothing to disclose, and that is an improvement rather than a regression.)
    expect(checks.some(([, wasCarried]) => wasCarried)).toBe(true);
  });

  /* ===================================================================== */
  /* B21 — paging state resets on every input that changes the question    */
  /* ===================================================================== */
  it('B21: a sort change and a search change both restart paging at the first page', async () => {
    let pageSize = 0;
    listCasesMock.mockImplementation(async (params: Record<string, unknown>) => {
      if (!params || !('offset' in params)) return page([], 0);
      const size = Number(params.limit);
      pageSize = size;
      const prefix = `o${params.offset}`;
      return page(
        fill(size, (i) => caseInBand(`${prefix}r${i}`, PRESENT_BANDS[i % PRESENT_BANDS.length])),
        size * 4,
      );
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    await waitFor(() => expect(rowIds().length).toBe(pageSize));

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() =>
      expect(Number(pageRequests()[pageRequests().length - 1].offset)).toBeGreaterThan(0),
    );

    const sortLabels = await optionsOf('kpi-drilldown-sort');
    const currentSort = screen.getByTestId('kpi-drilldown-sort').textContent ?? '';
    const nextSort = sortLabels.find((l) => l && !currentSort.includes(l));
    expect(nextSort).toBeTruthy();
    await chooseOption('kpi-drilldown-sort', nextSort as string);

    await waitFor(() =>
      expect(Number(pageRequests()[pageRequests().length - 1].offset)).toBe(0),
    );

    // …and again for free-text search, which narrows a different axis.
    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() =>
      expect(Number(pageRequests()[pageRequests().length - 1].offset)).toBeGreaterThan(0),
    );
    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'case');
    await waitFor(
      () => expect(Number(pageRequests()[pageRequests().length - 1].offset)).toBe(0),
      { timeout: 3000 },
    );
    // A harness budget, not a slack assertion: this test drives two full paging round
    // trips, a menu read and a typed narrowing whose own settle already reserves 3s of the
    // default 5s. It measures ~2.5s alone and has been seen to cross 5s when the file runs
    // beside the other Overview suites, which is a flake with nothing to teach.
  }, 15_000);

  /* ===================================================================== */
  /* B23 / B30 — the fetch dependencies, and the status facet's memory      */
  /* ===================================================================== */
  it('B23: a metric swap issues exactly one new fetch, never a stale-closure double', async () => {
    listCasesMock.mockImplementation(async (params: Record<string, unknown>) => {
      if (!params || !('offset' in params)) return page([], 0);
      const size = Number(params.limit);
      return page(
        fill(size, (i) => caseInBand(`w${i}`, PRESENT_BANDS[i % PRESENT_BANDS.length])),
        size * 4,
      );
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    const afterFirst = pageRequests().length;
    expect(afterFirst).toBeGreaterThan(0);

    // The IN-PANEL switcher, not the neighbouring tile: behind the modal scrim that tile
    // is unclickable, and a synthetic click on it would also trip the layer's
    // `onPointerDownOutside` and close-then-reopen the panel — which would fail the
    // "exactly one new fetch" count below for a reason that has nothing to do with the
    // effect dependencies this test is about. The pill performs the same state write the
    // tile does, so the contract under test is unchanged.
    await userEvent.click(screen.getByTestId('kpi-drilldown-metric-open-cases'));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'open-cases'),
    );
    // Give any second effect that was going to fire the chance to fire.
    await waitFor(() => expect(pageRequests().length).toBeGreaterThan(afterFirst));
    const settled = pageRequests().length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pageRequests().length).toBe(settled);
    expect(settled - afterFirst).toBe(1);
  });

  it('B30: status options accumulate across pages and reset on a metric swap', async () => {
    // Two pages with DISJOINT status vocabularies, so a page-scoped option list and a
    // session-scoped union give visibly different answers.
    const firstStatus = 'open';
    const secondStatus = 'investigating';
    listCasesMock.mockImplementation(async (params: Record<string, unknown>) => {
      if (!params || !('offset' in params)) return page([], 0);
      const size = Number(params.limit);
      const status = Number(params.offset) === 0 ? firstStatus : secondStatus;
      return page(
        fill(size, (i) =>
          caseInBand(`u${params.offset}${i}`, PRESENT_BANDS[i % PRESENT_BANDS.length], { status }),
        ),
        size * 4,
      );
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));

    const firstPageOptions = await optionsOf('kpi-drilldown-status');
    expect(firstPageOptions.join(' ').toLowerCase()).toContain(firstStatus);
    expect(firstPageOptions.join(' ').toLowerCase()).not.toContain(secondStatus);

    await userEvent.click(screen.getByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(pageRequests().length).toBeGreaterThan(1));

    const unionOptions = await optionsOf('kpi-drilldown-status');
    const union = unionOptions.join(' ').toLowerCase();
    // The UNION across every page read this session — page one's status did not fall
    // out just because page two did not repeat it.
    expect(union).toContain(firstStatus);
    expect(union).toContain(secondStatus);

    // …and the memory is scoped to the METRIC: re-pointing the panel resets it. Driven
    // from the in-panel switcher because the neighbouring tile is behind the modal scrim;
    // the re-seed under test is keyed on the panel's metric either way.
    await userEvent.click(screen.getByTestId('kpi-drilldown-metric-open-cases'));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'open-cases'),
    );
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    const afterSwap = (await optionsOf('kpi-drilldown-status')).join(' ').toLowerCase();
    expect(afterSwap).not.toContain(secondStatus);
  });

  /* ===================================================================== */
  /* B34 — the footer NAMES every narrowing it evaluated over rows read     */
  /* ===================================================================== */
  it('B34: names the sort, the search, the severity band and the tile predicate as page-scoped', async () => {
    listCasesMock.mockImplementation(async (params: Record<string, unknown>) => {
      if (!params || !('offset' in params)) return page([], 0);
      const size = Number(params.limit);
      return page(
        fill(size, (i) => caseInBand(`n${i}`, PRESENT_BANDS[i % PRESENT_BANDS.length])),
        size * 4,
      );
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    // Turn on every narrowing the criterion enumerates that the operator can set.
    await chooseOption('kpi-drilldown-severity', cap(PRESENT_BANDS[0]));
    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'case');
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));

    const caveats = (screen.getByTestId('kpi-drilldown-caveats').textContent ?? '').toLowerCase();

    /**
     * The narrowings must be named in the PAGE-SCOPED LIST — the clause the footer opens
     * with "…not the whole population:" — and nowhere else.
     *
     * Matching the whole footer was vacuous, and quietly so. It always carries "Severity
     * options are derived from the rows read." and "Status options come from every page
     * read here.", so `/severity|band/` and `/search|text|filter/` matched a footer that
     * had never heard of the operator's narrowings, and `/population/` matched the
     * boilerplate "not the whole population" in the very sentence being read. Scoping to
     * the list is what makes each probe fail when its narrowing goes unnamed.
     */
    const scopedList = (s: string) =>
      (s.match(/not the whole population: ([^.]+)\./) ?? ['', ''])[1];

    const listed = scopedList(caveats);
    expect(listed, `the footer names no page-scoped narrowing at all: ${caveats}`).toBeTruthy();
    expect(listed).toContain('the severity band');
    expect(listed).toContain('the free-text search');
    expect(listed).toContain('the ordering');
    // The FOURTH narrowing the criterion enumerates is the tile's own population
    // predicate — and it belongs in this list only for a tile that resolves its population
    // in the BROWSER. "Total Cases" is the whole cohort the store returned, so naming a
    // predicate here would be a false caveat, which is the same failure as a missing one
    // pointed the other way.
    expect(listed).not.toContain('population rule');

    // So re-point the OPEN panel at a metric whose population really is resolved over the
    // rows read (the false-positive population is a browser-side verdict predicate: no
    // `verdict` query parameter exists), and the clause must appear. Driven from the
    // in-panel switcher because every neighbouring tile is behind the modal scrim.
    await userEvent.click(screen.getByTestId('kpi-drilldown-metric-false-positive-rate'));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute(
        'data-kpi',
        'false-positive-rate',
      ),
    );
    await waitFor(() =>
      expect(
        scopedList((screen.getByTestId('kpi-drilldown-caveats').textContent ?? '').toLowerCase()),
      ).toContain('population rule'),
    );

    // …and the whole statement is scoped to the rows read, not to the population.
    expect(caveats).toMatch(/evaluated over the [\d,]+ rows read, not the whole population/);
  });

  /* ===================================================================== */
  /* B48 — the two recency options ride the IMMUTABLE timestamp            */
  /* ===================================================================== */
  it('B48: both recency sort options send the CREATION timestamp, never the mutable one', async () => {
    // Rationale, recorded as the criterion requires: the creation timestamp is
    // IMMUTABLE and is the same axis as both the window bound and the pinned head,
    // whereas the update timestamp MOVES while the operator pages — and a mutable sort
    // key is exactly what makes offset paging repeat and skip rows.
    listCasesMock.mockResolvedValue(
      page(PRESENT_BANDS.map((band, i) => caseInBand(`t${i}`, band)), PRESENT_BANDS.length),
    );
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const labels = await optionsOf('kpi-drilldown-sort');
    // The two RECENCY options are the pair that differ only in direction, identified
    // by exercising every option and keeping the two that share a sort FIELD while
    // sending opposite orders — derived from behaviour, not from their wording.
    const seen: { label: string; field: string; order: string }[] = [];
    for (const label of labels) {
      await chooseOption('kpi-drilldown-sort', label);
      await waitFor(() => expect(pageRequests().length).toBeGreaterThan(seen.length));
      const last = pageRequests()[pageRequests().length - 1];
      seen.push({ label, field: String(last.sort_field), order: String(last.sort_order) });
    }

    const byField = new Map<string, string[]>();
    for (const entry of seen) {
      byField.set(entry.field, [...(byField.get(entry.field) ?? []), entry.order]);
    }
    // Every axis the menu offers is exercised in both directions.
    for (const orders of byField.values()) {
      expect(new Set(orders).size).toBe(2);
    }

    // The recency pair is the one on a TIME axis, and it must be the creation one.
    const timeFields = [...byField.keys()].filter((f) => /_at$/.test(f));
    expect(timeFields).toEqual(['created_at']);
    expect(timeFields).not.toContain('updated_at');
    // …and no request the panel ever made rode the mutable axis.
    for (const params of pageRequests()) {
      expect(params.sort_field).not.toBe('updated_at');
    }
  });

  /* ===================================================================== */
  /* B31 — the verdict population stays client-side                        */
  /* ===================================================================== */
  it('B31: never sends a verdict query parameter, and never sends a status LIST', async () => {
    listCasesMock.mockResolvedValue(
      page(PRESENT_BANDS.map((band, i) => caseInBand(`q${i}`, band)), PRESENT_BANDS.length),
    );
    renderOverview();
    await screen.findByTestId('page-hero');

    for (const tile of ['kpi-total-cases', 'kpi-open-cases', 'kpi-false-positive-rate']) {
      await openPanel(tile);
    }

    for (const params of pageRequests()) {
      expect(params).not.toHaveProperty('verdict');
      // A helper that stringifies an array produces one comma-joined term that matches
      // nothing, with no error at any layer — so the client must never send a list.
      for (const [key, value] of Object.entries(params)) {
        expect(Array.isArray(value), `${key} was sent as an array`).toBe(false);
        if (key === 'status') expect(String(value)).not.toContain(',');
      }
    }
  });
});
