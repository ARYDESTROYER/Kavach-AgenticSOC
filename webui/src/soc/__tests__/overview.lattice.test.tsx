/**
 * Overview (Cyber Defence Center) — the command lattice's READING ORDER, and the case
 * sheet that opens over it.
 *
 * Three contracts, all about the shape of the page rather than about any one widget:
 *
 *   A. READING ORDER. The lattice is one band read top-to-bottom: the KPI strip heads the
 *      page, the noise-reduction flow explains how the alert stream became those numerals,
 *      the close-attribution card says who closed what, and only then does row 2 follow:
 *      the resolved/open snapshots, the detect/respond timing pair, and the live queue,
 *      left to right. Order is asserted in the DOM, never by geometry — jsdom performs no layout,
 *      so a class-derived column span proves nothing here and a measured rectangle would be
 *      a fiction. The retired Cases-burndown rail must not have crept back.
 *
 *   B. THE CASE SHEET. Opening a case from either case surface — the live queue, or a row
 *      inside a KPI drill-down — opens it OVER the dashboard. It is a peek, not a
 *      destination: the numerals that made the operator click stay behind it, and nothing
 *      navigates. Escape dismisses it and hands the dashboard back intact. (Focus RETURN
 *      is pinned separately, against the REAL component, in
 *      `soc/pages/__tests__/CaseDetail.focus-return.test.tsx` — the sheet is stubbed here,
 *      so asserting it in this file would only test the stub.)
 *
 *      From a drill-down row that is MODAL OVER MODAL, and deliberately so. The KPI
 *      drill-down is itself a Radix Dialog now, so opening a case stacks a second layer on
 *      it rather than replacing it: the documented behaviour is that closing the case
 *      returns the operator to the exact population they were reading, and throwing that
 *      population away to save one layer would be the more expensive choice. Radix unwinds
 *      dismissable layers NEWEST FIRST (`useEscapeKeydown` bails unless the layer is the
 *      highest), so one Escape closes the case and leaves the panel standing, and a second
 *      closes the panel. Both halves are asserted below.
 *
 *      While the sheet is on top the panel underneath is a SUPPRESSED layer: Radix gives
 *      inline `pointer-events: auto` only to the highest layer, and the sheet's own
 *      `hideOthers` marks the panel's portal `aria-hidden`. So `within(panel).getByRole(…)`
 *      and any click into the panel stop working for as long as the case is open — every
 *      such interaction in this file happens BEFORE the sheet exists, and that ordering is
 *      load-bearing rather than incidental.
 *
 *   C. ACCESSIBILITY WITH THE SHEET OPEN. `axe` runs against `document.body`, not the
 *      render container: the sheet is portalled out of the container and aria-hides its
 *      siblings, so a container-scoped run would happily pass over a page it never saw.
 *
 * Offline: the api and the posture fetch are mocked; no auth, no #3 behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * The shared <CaseDetail> is stubbed down to its SURFACE, exactly as the Scans board and
 * the other Overview drill-down specs stub it: the real component calls `useAuth()`
 * unconditionally and this page mounts under no <AuthProvider>, so a live mount would
 * throw on every render.
 *
 * The stub keeps the one thing this file is about — the presentation contract. The real
 * component wraps its body in the same right-side `<Sheet>`/`<SheetContent>` pair (see
 * `CaseDetailSurface` in CaseDetail.tsx), so reproducing that pair is what lets these
 * tests observe the dismissal that Overview owns: Escape closes the Radix layer, which
 * calls back into `onClose`, which is the page's own `setOpenCaseId(null)`. The probe id
 * is what proves WHICH case was handed over.
 */
vi.mock('@/soc/pages/CaseDetail', async () => {
  const { Sheet, SheetContent } = await vi.importActual<typeof import('@/ui/sheet')>(
    '@/ui/sheet',
  );
  return {
    CaseDetail: ({
      caseId,
      onClose,
    }: {
      caseId?: string | null;
      onClose?: () => void;
    }) =>
      caseId ? (
        <Sheet
          open
          onOpenChange={(next: boolean) => {
            if (!next) onClose?.();
          }}
        >
          <SheetContent side="right" size="full" aria-label="Case detail">
            <div data-testid="case-detail-probe">{caseId}</div>
          </SheetContent>
        </Sheet>
      ) : null,
  };
});

const { listCasesMock, getMetricsMock, usageMock, noiseMock, trendsMock } = vi.hoisted(
  () => ({
    listCasesMock: vi.fn(),
    getMetricsMock: vi.fn(),
    usageMock: vi.fn(),
    noiseMock: vi.fn(),
    trendsMock: vi.fn(),
  }),
);

vi.mock('@/lib/api', () => ({
  api: {
    listCases: listCasesMock,
    getMetrics: getMetricsMock,
    usageSummary: usageMock,
    noiseReduction: noiseMock,
    metricsTrends: trendsMock,
  },
}));

import Overview from '../pages/Overview';
import { AnnouncerProvider } from '../components/announcer';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics, MetricsTrends, NoiseReduction } from '@/lib/types';

const CASES: Case[] = [
  {
    case_id: 'c-open-crit',
    case_number: 'T-1',
    title: 'Unauthorized S3 access',
    status: 'open',
    risk_score: 90,
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
    verdict: 'FALSE_POSITIVE',
    risk_score: 30,
    updated_at: '2026-07-01T03:00:00Z',
    created_at: '2026-07-01T02:00:00Z',
  },
] as unknown as Case[];

const METRICS = {
  total_cases: 3,
  open_cases: 2,
  needs_human_cases: 0,
  closed_cases: 1,
  by_status: { open: 1, investigating: 1, closed: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 1, NEEDS_HUMAN: 0, none: 1 },
  persona_usage: {},
  playbook_usage: {},
  avg_risk_score: 43,
  mttr_minutes: 120,
  resolved_count: 1,
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
  case_count: 3,
  severity_counts: { critical: 1, high: 0, medium: 1, low: 1, info: 0 },
  open_now: {
    count: 2, window_exempt: true, as_of: '2026-07-01T08:00:00Z', complete: true, reason: '',
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
    mttd_minutes: { p50: 9, p90: 30, mean: 12, max: 60, count: 3, available: true, reason: '' },
  },
  quality: {
    total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
    human_closed_cases: 0, system_closed_cases: 0,
    alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0,
    containment_rate: 0.5, automation_rate: 1,
  },
  aging: {
    queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1,
    closure_vs_arrival: 0.33, backlog: 2,
  },
  sla: {
    enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0,
    resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 100, breaching: [],
  },
};

/** A funnel payload, because the flow band self-omits without one. */
const NOISE: NoiseReduction = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  bands: ['critical', 'high', 'medium', 'low', 'info'],
  stages: [
    { key: 'ingested', label: 'Ingested', source: 'counters', deterministic: true, total: 1000, by_severity: { critical: 50, high: 150, medium: 300, low: 400, info: 100 } },
    { key: 'clustered', label: 'Clustered', source: 'counters', deterministic: true, total: 400, by_severity: { critical: 40, high: 100, medium: 120, low: 100, info: 40 } },
    { key: 'cases', label: 'Cases opened', source: 'cases', deterministic: false, total: 40, by_severity: { critical: 8, high: 12, medium: 12, low: 6, info: 2 } },
    { key: 'auto_cleared', label: 'Auto-cleared', source: 'cases', deterministic: true, total: 20, by_severity: {} },
    { key: 'escalated', label: 'Escalated', source: 'cases', deterministic: true, total: 20, by_severity: {} },
    { key: 'needs_human', label: 'Needs human', source: 'cases', deterministic: true, total: 6, by_severity: {} },
    { key: 'closed', label: 'Closed by human', source: 'cases', deterministic: true, total: 12, by_severity: { high: 5, medium: 5, low: 2 } },
  ],
  drops: { suppressed: 5, ignored: 2 },
  reduction: { overall_pct: 96, human_reduction_pct: 50 },
  counters: { available: true, since: '2026-06-30T08:00:00Z', incomplete: false },
  cases_meta: { truncated: false, store_total: 40, fetched: 40 },
};

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
 * The `<main>` belongs to the SHELL, not to the page: `AppShell` renders every route
 * inside `<main id="socMain" role="main">`. Modelling it is what makes the `axe` run over
 * `document.body` a fair audit — without it the harness would report every band of the
 * dashboard as content outside a landmark, which is an artefact of mounting one page on a
 * bare document rather than anything an operator would meet.
 */
function renderOverview(onNavigate = vi.fn()) {
  return {
    onNavigate,
    ...render(
      <AnnouncerProvider>
        <main>
          <Overview onNavigate={onNavigate} />
        </main>
      </AnnouncerProvider>,
    ),
  };
}

/** True when `later` is strictly after `earlier` in document order. */
function follows(earlier: Element, later: Element): boolean {
  return Boolean(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

/**
 * Radix HoverCard's open and close both run on timers (320ms / 220ms as this page
 * configures them), so a preview that a test armed has to be settled INSIDE `act` or its
 * state update lands in the middle of the next assertion and the strict console gate fails
 * a suite whose every assertion passed.
 */
async function settleHoverPreview() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
  });
}

/**
 * Click one of the live-queue rows the way a mouse user does, and leave the row again.
 *
 * Every row in that queue is a `CaseHoverCard` trigger, and Radix arms its open timer
 * TWICE on a single click — once from the pointer-enter and once from the focus — while
 * only ever remembering the second timer id. The blur that follows (focus moves into the
 * sheet) therefore cancels only one of the two, and the orphan fires ~320ms later. Left
 * unhandled that pops the preview OVER the case sheet the click just opened, where, as a
 * dismissable layer stacked above it, it swallows the very Escape the sheet is tested with.
 *
 * The page suppresses it: while a case is open the queue passes `forceClosed` to
 * `CaseHoverCard`, which refuses the open even though the timer still fires. This helper
 * drives the full pointer story anyway — click, settle, unhover, settle — so the tests
 * below observe a page whose timers have all resolved rather than one mid-flight, and so
 * that a regression in that suppression shows up here as a stray layer rather than as a
 * mysterious Escape that stops working.
 *
 * The pointer-events check is disabled for this one instance because an open modal sheet
 * sets `pointer-events: none` on `<body>`; user-event's guard exists to catch clicks on
 * genuinely inert controls and cannot tell that from a cursor leaving the row it just
 * clicked. The CLICK itself happens before the sheet exists.
 */
async function openQueuedCase(row: HTMLElement) {
  const pointer = userEvent.setup({ pointerEventsCheck: 0 });
  await pointer.click(row);
  await settleHoverPreview();
  await pointer.unhover(row);
  await settleHoverPreview();
}

/**
 * Forget user-event's memoised `pointer-events` verdict for one node.
 *
 * user-event caches that verdict ON the element under a private symbol, and `document.body`
 * is the ONE node that survives RTL's cleanup between tests. A test that ends with a Radix
 * layer still open therefore leaves `body` memoised as `pointer-events: none` — and the
 * next test's `pointerEventsCheck: 0` instance, which by design never re-checks, reads that
 * stale verdict and throws before it has touched the page at all. (This only started
 * biting when the KPI drill-down became a modal: a test can now finish with a layer open.)
 *
 * Clearing the memo is harness bookkeeping, never product state — every check that matters
 * is then recomputed against the live DOM, which is strictly more honest than the cache.
 */
function forgetPointerEventsMemo(node: Element): void {
  const own = node as unknown as Record<symbol, unknown>;
  for (const key of Object.getOwnPropertySymbols(node)) {
    if ((key.description ?? '').includes('pointer-events')) own[key] = undefined;
  }
}

/** Did any navigation carry a case id? A peek must carry none. */
function navigatedToACase(onNavigate: ReturnType<typeof vi.fn>): boolean {
  return onNavigate.mock.calls.some(
    ([, params]) =>
      params != null && typeof params === 'object' && 'caseId' in (params as object),
  );
}

describe('Overview — the command lattice', () => {
  beforeEach(() => {
    forgetPointerEventsMemo(document.body);
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    noiseMock.mockReset();
    trendsMock.mockReset();
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
    noiseMock.mockResolvedValue(NOISE);
    trendsMock.mockResolvedValue(TRENDS);
  });

  // ---------------------------------------------------------------- GROUP A --
  it('reads top-to-bottom: strip → flow → attribution → snapshots → timing → queue', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    // The flow band is the only one that arrives on its own request, so it gates the
    // whole ordering assertion.
    const funnel = await screen.findByTestId('noise-funnel');

    const strip = screen.getByTestId('kpi-strip');
    const attribution = screen.getByTestId('human-vs-ai');
    const snapshots = screen.getByRole('region', { name: 'Resolved and open cases' });
    const queue = screen.getByRole('region', { name: 'Latest cases' });
    const timing = screen.getByRole('region', { name: 'Mean time to detect / respond' });

    // One chain, each link strictly after the one before it. Chaining is what makes the
    // assertion an ORDER rather than six independent presence checks.
    //
    // The timing pair sits BETWEEN the two case surfaces because it is the middle cell of
    // row 2 (snapshots · timing · queue) rather than a full-width row below them. DOM
    // order still equals visual order — the grid lays the three cells out left to right
    // and no `order-*` utility is used — so reading and focus order stay truthful.
    const band = [strip, funnel, attribution, snapshots, timing, queue];
    for (let i = 0; i < band.length - 1; i += 1) {
      expect(follows(band[i], band[i + 1])).toBe(true);
    }

    // The two relationships the lattice was rearranged for, restated directly so a
    // regression names itself rather than pointing at "link 2 of 5":
    //   the flow explains the numerals BEFORE the card that attributes their closes,
    expect(follows(funnel, attribution)).toBe(true);
    //   and both instruments precede the two case surfaces they are read against.
    expect(follows(attribution, snapshots)).toBe(true);
    expect(follows(attribution, queue)).toBe(true);

    // The burndown rail was retired to Analytics → Posture ("Closure vs arrival"); it
    // must not have crept back onto the landing surface as a seventh band.
    expect(screen.queryByRole('region', { name: /Cases burndown/i })).toBeNull();
  });

  // ---------------------------------------------------------------- GROUP B --
  it('opens a queued case OVER the dashboard rather than navigating to it', async () => {
    const { onNavigate } = renderOverview();
    await screen.findByTestId('page-hero');

    // Scoped to the queue: a KPI drill-down offers the SAME accessible name for the same
    // case, and this assertion is about the queue's row.
    const queue = await screen.findByRole('region', { name: 'Latest cases' });
    const row = within(queue).getByRole('button', {
      name: 'Open case Unauthorized S3 access (T-1)',
    });
    await openQueuedCase(row);

    expect(await screen.findByTestId('case-detail-probe')).toHaveTextContent('c-open-crit');
    // A peek, not a destination: the operator keeps the numerals that made them click.
    expect(navigatedToACase(onNavigate)).toBe(false);
  });

  /**
   * MODAL OVER MODAL, decided rather than tolerated.
   *
   * The drill-down is a Radix Dialog and the case sheet is another Radix layer, so opening
   * a case from a drill-down row stacks two. Collapsing the panel to keep one layer was
   * the alternative and was rejected: the operator opened this case FROM a population they
   * were reading, and the whole point of the peek is that closing it hands that population
   * back. Radix's shared, module-level layer registry makes the stack behave — one Escape
   * per layer, newest first — so the cost of the second layer is a keystroke, and the cost
   * of collapsing it would be the operator's place.
   */
  it('stacks the case sheet ON the drill-down, and unwinds one layer per Escape', async () => {
    const { onNavigate } = renderOverview();
    await screen.findByTestId('page-hero');

    await userEvent.click(await screen.findByTestId('kpi-total-cases'));
    const panel = await screen.findByTestId('kpi-drilldown');
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-rows')).toBeInTheDocument());

    // ORDERING IS LOAD-BEARING. The drill-down is still the TOP layer at this instant, so
    // its content carries Radix's inline `pointer-events: auto` and is not aria-hidden.
    // The same two lines run after the sheet opens would fail the role query AND throw on
    // the click — which is the contract, not a harness quirk.
    await userEvent.click(
      within(panel).getByRole('button', { name: 'Open case Benign admin login (T-3)' }),
    );

    expect(await screen.findByTestId('case-detail-probe')).toHaveTextContent('c-closed-fp');
    // A peek, not a destination: the operator keeps the numerals that made them click.
    expect(navigatedToACase(onNavigate)).toBe(false);

    // The population the operator was reading is still there to come back to — but as a
    // SUPPRESSED layer, which is the fact worth pinning: `pointer-events` is handed to the
    // highest layer only, and the sheet's `hideOthers` aria-hides the panel's portal.
    const panelAfter = screen.getByTestId('kpi-drilldown');
    expect(panelAfter).toHaveAttribute('data-kpi', 'total-cases');
    expect(panelAfter.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(panelAfter.style.pointerEvents).toBe('none');

    // ONE Escape closes ONE layer, newest first: the case goes and the panel stays. A
    // regression that took both down would return the operator to a dashboard instead of
    // to the list they were working through, and would look like a fixed bug.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('case-detail-probe')).toBeNull());
    const panelBack = screen.getByTestId('kpi-drilldown');
    expect(panelBack).toHaveAttribute('data-kpi', 'total-cases');
    // …and it is the top layer again: readable, and operable.
    await waitFor(() => expect(panelBack.closest('[aria-hidden="true"]')).toBeNull());
    await waitFor(() => expect(panelBack.style.pointerEvents).toBe('auto'));

    // The SECOND Escape is what closes the panel, and only then is the page handed back.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
    expect(screen.getByTestId('kpi-strip').closest('[aria-hidden="true"]')).toBeNull();

    // Closing the panel returns focus to the tile, whose hover card opens on focus behind
    // a delay — settle it here rather than letting it resolve into a torn-down tree.
    await settleHoverPreview();
  });

  /**
   * Escape dismisses the sheet and hands the dashboard back INTACT.
   *
   * What this asserts is everything the page itself owns: the layer goes away, the page's
   * own `openCaseId` clears (so the peek left no residue), the numerals it was covering
   * are re-read, and — the part a leaked modal would silently destroy — the whole
   * dashboard is exposed to assistive technology again, because Radix `aria-hidden`s every
   * sibling of an open sheet and an un-torn-down layer would leave the landing page
   * invisible to a screen reader with nothing on screen to explain it.
   *
   * It does not assert focus RETURN, for a harness reason rather than a product one: the
   * `CaseDetail` mocked above is a stub that reproduces the sheet's Radix shape, not the
   * real component, so the explicit restore the real one performs is not present here and
   * asserting it would only be testing this file's own stub.
   *
   * Focus return IS pinned, against the real mount, in
   * `soc/pages/__tests__/CaseDetail.focus-return.test.tsx`. It has to be: Radix's modal
   * content `preventDefault()`s its own restoration and then focuses `triggerRef.current`,
   * which is null for a sheet opened by state rather than by a `<SheetTrigger>` — so
   * without an explicit restore, focus is dropped on `<body>`.
   */
  /**
   * The row's hover preview must NOT stack over the sheet the same click just opened.
   *
   * Radix arms the hover card's open timer twice on one click (pointer-enter, then focus)
   * while remembering only the second id, so the blur that follows cancels one and the
   * orphan fires ~320ms later. The page holds the card shut with `forceClosed` while a case
   * is open. Without that, the preview lands ON TOP of the sheet as a dismissable layer and
   * eats the operator's first Escape.
   *
   * This asserts at the only moment that can see it: after the click has settled but BEFORE
   * the pointer leaves the row, since leaving closes the preview and would make the check
   * vacuous. Verified to fail when the suppression is removed.
   */
  it('does not pop the row preview over the sheet the click just opened', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    const queue = await screen.findByRole('region', { name: 'Latest cases' });
    const row = within(queue).getByRole('button', {
      name: 'Open case Noisy scanner beacon (T-2)',
    });

    const pointer = userEvent.setup({ pointerEventsCheck: 0 });
    await pointer.click(row);
    await settleHoverPreview();

    expect(await screen.findByTestId('case-detail-probe')).toBeInTheDocument();
    // Radix portals popper content into a wrapper div; one would mean a preview is stacked
    // above the sheet. The sheet itself is NOT popper content, so this counts only previews.
    expect(document.querySelectorAll('[data-radix-popper-content-wrapper]')).toHaveLength(0);

    // Leave the row settled so no timer resolves into a torn-down tree.
    await pointer.unhover(row);
    await settleHoverPreview();
  });

  it('dismisses the sheet on Escape and hands the dashboard back intact', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    const queue = await screen.findByRole('region', { name: 'Latest cases' });
    const row = within(queue).getByRole('button', {
      name: 'Open case Noisy scanner beacon (T-2)',
    });

    await openQueuedCase(row);
    expect(await screen.findByTestId('case-detail-probe')).toHaveTextContent('c-open-low');
    // The layer has taken focus off the queue, so the Escape below is the SHEET's.
    await waitFor(() => expect(row).not.toHaveFocus());
    // While it is open the dashboard behind is hidden from assistive technology.
    expect(queue.closest('[aria-hidden="true"]')).not.toBeNull();

    const readsBefore = listCasesMock.mock.calls.length;
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('case-detail-probe')).toBeNull());
    // The row the operator came from is still the same live element, and the page around
    // it is readable again — no orphaned `aria-hidden`, no stranded pointer-events lock.
    expect(document.body.contains(row)).toBe(true);
    await waitFor(() => expect(queue.closest('[aria-hidden="true"]')).toBeNull());
    // Radix never sets `inert` — it hides with `aria-hidden` (the line above), so the
    // `querySelector('[inert]')` assertion that used to stand here could not fail and
    // taught the wrong mechanism. What a leaked layer really WOULD strand is the body
    // pointer-events lock, which is unreachable-page territory, so assert that instead.
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
    // Whatever holds focus afterwards is still part of the live document — the layer did
    // not leave it parked on a detached node.
    expect(document.activeElement?.isConnected).toBe(true);

    // Closing the sheet refreshes the numerals it was covering (a lifecycle action inside
    // it would have changed them). Settle that batch inside the test rather than letting
    // it resolve into a torn-down tree.
    await waitFor(() =>
      expect(listCasesMock.mock.calls.length).toBeGreaterThan(readsBefore),
    );
  });

  // ---------------------------------------------------------------- GROUP C --
  it('has no axe violations with the case sheet OPEN', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    const queue = await screen.findByRole('region', { name: 'Latest cases' });
    // Settle the strip's count-up numerals first, so the a11y snapshot is of the settled
    // page and no lazy upgrade lands mid-audit.
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId('kpi-strip')).queryAllByTestId('count-up'),
        ).toHaveLength(0),
      { timeout: 5000 },
    );

    await openQueuedCase(
      within(queue).getByRole('button', { name: 'Open case Unauthorized S3 access (T-1)' }),
    );
    await screen.findByTestId('case-detail-probe');
    // Non-vacuous: the audited tree really does contain the open layer.
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // `document.body`, NOT the render container: the sheet is portalled out of the
    // container and aria-hides the rest of the body, so a container-scoped run would
    // audit a page the operator can no longer reach and call it clean.
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
