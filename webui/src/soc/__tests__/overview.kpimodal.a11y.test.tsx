/**
 * The KPI deep-inspection MODAL — the contract that replaced the docked disclosure.
 *
 * The drill-down used to be a non-modal `<section>` read alongside the strip. It is now a
 * Radix Dialog, at operator instruction, and that reverses a decision this repository had
 * written down and tested. This file is where the NEW contract is pinned, deliberately and
 * in one place, so that "it is a dialog now" is a proven statement rather than a comment.
 *
 * What is proven here, and why each one earns its place:
 *
 *   1. THE DIALOG SEMANTICS, including `aria-describedby` RESOLVING to a real, visible
 *      element. Radix wires `aria-describedby` before the consumer spread, so passing
 *      `undefined` leaves a DANGLING reference that no axe rule and no smoke test catches —
 *      the panel simply announces its name and then nothing. Resolving it to the population
 *      sentence is also what makes the open announce which population is being listed.
 *   2. THE TRAP. The old suite proved the opposite ("lets Tab leave the panel without
 *      closing it"). The budget is DERIVED from the stops the fixture actually produces,
 *      with a vacuity guard, because a literal budget would silently stop proving anything
 *      the day a control is added.
 *   3. FOCUS RETURN, per tile and per close affordance. `it.each` over all five tiles is not
 *      ceremony: `Overview` keeps a ref MAP, so a bug that always returned focus to tile one
 *      would pass a single-tile test.
 *   4. THE SWITCHER, which is load-bearing rather than chrome. Behind a scrim the four
 *      neighbouring tiles are `aria-hidden` and unclickable, so this is the ONLY surviving
 *      way to compare populations — it is the answer to the strongest objection the
 *      non-modal contract raised, and it must keep working at every width.
 *   5. THE INTERIOR CONTRACT, as class assertions. jsdom has no layout, so the fixed-height
 *      shell, the single scroll region and the pinned footer cannot be measured — but they
 *      CAN be pinned as the class facts they are, and nothing else in the suite covers them.
 *   6. NO REOPENED HOVER CARD after either close path. This is the §2.6 arbiter: the focus
 *      return happens after the commit that drops `forceClosed`, so a reopen timer armed by
 *      that focus resolves right on the old suppression boundary. It reopened every time
 *      until the window was widened, and it did so ~160ms later — long after any assertion
 *      that did not deliberately wait for it.
 *
 * Offline: api + posture mocked. Read-only; nothing here reaches #3.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
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

// A drill-down row can open a case, which mounts the shared <CaseDetail>. The real
// component calls `useAuth()` unconditionally and this page mounts under no
// <AuthProvider>, so it is stubbed to a probe — the same stub the sibling suites use.
vi.mock('@/soc/pages/CaseDetail', () => ({
  CaseDetail: ({ caseId }: { caseId?: string | null }) =>
    caseId ? <div data-testid="case-detail-probe">{caseId}</div> : null,
}));

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

import Overview from '../pages/Overview';
import { AnnouncerProvider } from '../components/announcer';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

const PAGE: Case[] = [
  {
    case_id: 'c-alpha',
    case_number: 'CS-11',
    title: 'Alpha beacon from finance subnet',
    status: 'open',
    risk_score: 91,
    detection_source: 'rule',
    assignee: 'nina',
    created_at: '2026-07-01T06:00:00Z',
    updated_at: '2026-07-01T07:00:00Z',
  },
  {
    case_id: 'c-beta',
    case_number: 'CS-12',
    title: 'Beta lateral movement attempt',
    status: 'investigating',
    risk_score: 44,
    detection_source: 'anomaly',
    created_at: '2026-07-01T04:00:00Z',
    updated_at: '2026-07-01T05:00:00Z',
  },
] as unknown as Case[];

const METRICS = {
  total_cases: 2,
  open_cases: 2,
  needs_human_cases: 0,
  closed_cases: 0,
  by_status: { open: 1, investigating: 1 },
  by_verdict: { TRUE_POSITIVE: 1, FALSE_POSITIVE: 0, NEEDS_HUMAN: 0, none: 1 },
  persona_usage: {},
  playbook_usage: {},
  avg_risk_score: 67,
  mttr_minutes: 90,
  resolved_count: 0,
  cases_per_day: [],
  feedback: {
    graded_cases: 0,
    feedback_count: 0,
    agreement_rate: 0,
    avg_accuracy: 0,
    avg_reasoning_quality: 0,
    avg_action_appropriateness: 0,
    time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 900,
  severity_counts: { critical: 12, high: 34, medium: 56, low: 78, info: 9 },
  open_now: {
    count: 41,
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
      p50: '—',
      p90: '—',
      mean: '—',
      max: '—',
      count: 0,
      available: false,
      reason: 'no case has received a first response yet',
    },
    mttd_minutes: { p50: 9, p90: 30, mean: 12, max: 60, count: 3, available: true, reason: '' },
  },
  quality: {
    total_cases: 900,
    verdicted_cases: 400,
    true_positive_cases: 300,
    false_positive_cases: 100,
    needs_human_cases: 10,
    escalated_cases: 5,
    terminal_cases: 200,
    auto_closed_cases: 150,
    human_closed_cases: 40,
    system_closed_cases: 10,
    alert_to_incident_ratio: 0.2,
    false_positive_rate: 0.25,
    escalation_rate: 0.01,
    containment_rate: 0.5,
    automation_rate: 0.75,
  },
  aging: {
    queue_depth: 41,
    age_buckets: [],
    oldest: [],
    arrivals: 900,
    closures: 200,
    closure_vs_arrival: 0.22,
    backlog: 41,
  },
  sla: {
    enabled: false,
    evaluated: 0,
    response_breached: 0,
    response_at_risk: 0,
    resolve_breached: 0,
    resolve_at_risk: 0,
    attainment_pct: 100,
    breaching: [],
  },
};

const RESPONSE = { cases: PAGE, total: 900, limit_applied: 2, window_total_exact: false };

/** Every tile on the strip, in render order. Their trend series are noted where it matters. */
const TILES = [
  'kpi-total-cases',
  'kpi-total-critical',
  'kpi-open-cases',
  'kpi-false-positive-rate',
  'kpi-resolved-closed',
] as const;

/**
 * A tile that HAS a trend series. Only three of the five do, and the reopen regression can
 * only be observed on one that does.
 */
const TILE_WITH_TREND = 'kpi-total-cases';

/**
 * ONE user-event instance with the pointer-events guard OFF.
 *
 * An open Radix modal sets `pointer-events: none` on `<body>`, and user-event cannot tell
 * that from a genuinely inert control — it throws a message naming user-event rather than
 * the modal, which is the most expensive kind of failure to read. Anything INSIDE the panel
 * could keep the guard (the layer carries inline `pointer-events: auto`), but one instance
 * for the file is simpler than two and proves the same things.
 */
function makeUser() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

/**
 * The `<main>` is the SHELL's, not the page's, and modelling it is what makes an axe run
 * over `document.body` a fair audit rather than a report about mounting one page on a bare
 * document. `AnnouncerProvider` supplies the one live region the page announces through.
 */
function renderOverview() {
  return render(
    <AnnouncerProvider>
      <main>
        <Overview onNavigate={vi.fn()} />
      </main>
    </AnnouncerProvider>,
  );
}

/** Render the dashboard, open one tile's panel, and wait for its first page to land. */
async function openPanel(user: ReturnType<typeof makeUser>, testId: string) {
  renderOverview();
  const tile = await screen.findByTestId(testId);
  await user.click(tile);
  const panel = await screen.findByTestId('kpi-drilldown');
  await waitFor(() =>
    expect(
      screen.queryByTestId('kpi-drilldown-rows') ?? screen.getByTestId('kpi-drilldown-scope'),
    ).toBeInTheDocument(),
  );
  return { tile, panel };
}

describe('KPI deep-inspection modal', () => {
  beforeEach(() => {
    listCasesMock.mockReset().mockResolvedValue(RESPONSE);
    getMetricsMock.mockReset().mockResolvedValue(METRICS);
    usageMock
      .mockReset()
      .mockResolvedValue({ total_cost: 0, total_tokens: 0, call_count: 0, currency: 'USD' });
    fetchPostureMock.mockReset().mockResolvedValue(POSTURE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------- T1: semantics ----
  it('is a real dialog whose name AND description resolve to visible elements', async () => {
    const user = makeUser();
    // Resolve by TESTID, never `getByRole('dialog')`: the point of this test is to prove the
    // role is there, so querying by it would assume the very thing under test.
    const { panel } = await openPanel(user, TILE_WITH_TREND);

    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');

    const heading = screen.getByTestId('kpi-drilldown-heading');
    expect(heading.tagName).toBe('H2');
    expect(panel.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.id).toBeTruthy();

    // The dangling-description guard. `aria-describedby` pointing at nothing is silent:
    // it produces no axe violation and no visible defect, and the panel simply announces
    // its name and stops. So the id must RESOLVE, and the element it resolves to must be
    // the population sentence and must be visible — never sr-only, never hover-only.
    const describedBy = panel.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description).not.toBeNull();
    expect(description).toBe(screen.getByTestId('kpi-drilldown-population'));
    expect(description).toBeVisible();
    expect((description?.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------- T2: the trap ----
  it('TRAPS focus: tabbing well past its own controls never leaves the panel', async () => {
    const user = makeUser();
    const { panel } = await openPanel(user, TILE_WITH_TREND);
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

    // The budget is DERIVED from the stops this fixture actually produces, never a literal.
    // A literal is worse than wrong here: the day a control is added the walk simply
    // finishes inside the panel and the containment assertion below passes while saying
    // nothing at all about the real cause.
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
      ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const controls = panel.querySelectorAll(FOCUSABLE).length;
    // Guard against a vacuous sweep: a panel that rendered no controls at all would make
    // every budget sufficient and prove nothing.
    expect(controls).toBeGreaterThan(0);
    const budget = controls + 4;

    for (let i = 0; i < budget; i += 1) await user.tab();

    // The cost the operator accepted when this stopped being a docked disclosure: Tab no
    // longer walks on into the instrument band. It cycles.
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(screen.getByTestId('kpi-drilldown')).toBe(panel);
  });

  it('hides the rest of the page from assistive tech with aria-hidden, not inert', async () => {
    const user = makeUser();
    await openPanel(user, TILE_WITH_TREND);

    // A POSITIVE shape. The old suite asserted `querySelector('[inert]')` was null, which
    // was vacuous in both directions: Radix has never set `inert`, so it passed before the
    // change for the wrong reason and would pass after it for the wrong reason too.
    const neighbour = screen.getByTestId('kpi-open-cases');
    expect(neighbour.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  // ------------------------------------------------------------- T3: focus return ----
  it.each(TILES)('returns focus to %s when Escape closes the panel', async (testId) => {
    const user = makeUser();
    const { tile } = await openPanel(user, testId);
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    // Per TILE, because `Overview` keeps a ref MAP: a bug that always returned focus to
    // tile one would pass a single-tile test and fail every operator who opened tile four.
    await waitFor(() => expect(screen.getByTestId(testId)).toHaveFocus());
    expect(screen.getByTestId(testId)).toBe(tile);
  });

  it.each(TILES)('returns focus to %s when its own Close button closes the panel', async (testId) => {
    const user = makeUser();
    await openPanel(user, testId);

    await user.click(screen.getByTestId('kpi-drilldown-close'));

    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await waitFor(() => expect(screen.getByTestId(testId)).toHaveFocus());
  });

  it('announces a popup on the trigger, and never a disclosure state', async () => {
    renderOverview();
    const tile = await screen.findByTestId(TILE_WITH_TREND);

    expect(tile).toHaveAttribute('aria-haspopup', 'dialog');
    // `aria-expanded` is a DISCLOSURE semantic and is wrong on a dialog trigger;
    // `aria-controls` could only ever dangle, because the panel is portalled and is not in
    // the DOM at all while it is closed.
    expect(tile).not.toHaveAttribute('aria-expanded');
    expect(tile).not.toHaveAttribute('aria-controls');
    expect(screen.queryByTestId('kpi-drilldown')).toBeNull();
  });

  // ---------------------------------------------------------------- T4: the switcher ----
  it('re-points at another metric, moving the heading and its focus, without closing', async () => {
    const user = makeUser();
    const { panel } = await openPanel(user, TILE_WITH_TREND);
    const before = screen.getByTestId('kpi-drilldown-heading').textContent;

    // Driven through the panel's OWN switcher. Clicking a neighbouring TILE is not a
    // user-reachable path any more — behind the scrim the strip is `aria-hidden` and
    // pointer-events:none — and a synthetic click there would additionally trip Radix's
    // `onPointerDownOutside` and close-then-reopen the panel.
    await user.click(screen.getByTestId('kpi-drilldown-metric-open-cases'));

    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-heading').textContent).not.toBe(before),
    );
    expect(screen.getByTestId('kpi-drilldown')).toBe(panel);
    // The heading, never a filter control: a screen-reader user must hear WHAT they are now
    // reading before they hear how to narrow it.
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());
  });

  it('keeps the switcher visible at EVERY width, carrying each tile’s own numeral', async () => {
    const user = makeUser();
    await openPanel(user, TILE_WITH_TREND);
    const group = screen.getByTestId('kpi-drilldown-metrics');

    // Not breakpoint-gated. Hiding the switcher below a breakpoint would delete the very
    // thing that answers the strongest objection to making this a modal — that the operator
    // can no longer compare a tile with its four neighbours — on exactly the 13" laptops
    // where the objection bites hardest. jsdom runs `css: false`, so a `hidden` node still
    // satisfies `toBeVisible()`: the class list is the only honest assertion available.
    const cls = group.className;
    expect(cls).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(cls).not.toMatch(/(^|\s)(hidden)\s.*\b(sm|md|lg|xl|2xl):(flex|block|inline-flex)\b/);
    expect(group).toHaveAttribute('aria-label');

    // Each pill restates its tile's RENDERED numeral, verbatim. Nothing at HEAD covered
    // this, and a switcher that recomputed its own numbers could disagree with the strip.
    for (const testId of TILES) {
      const key = testId.replace(/^kpi-/, '');
      const pill = within(group).getByTestId(`kpi-drilldown-metric-${key}`);
      const tileValue = screen.getByTestId(testId).textContent ?? '';
      const pillValue = pill.textContent ?? '';
      const numeral = pillValue.replace(pill.querySelector('span')?.textContent ?? '', '').trim();
      expect(numeral.length).toBeGreaterThan(0);
      expect(tileValue).toContain(numeral);
    }
    // Exactly one pill is current.
    const pressed = within(group)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
  });

  // -------------------------------------------------- T5 (§2.6 arbiter): hover card ----
  it.each([
    ['Escape', async (user: ReturnType<typeof makeUser>) => user.keyboard('{Escape}')],
    [
      'the Close button',
      async (user: ReturnType<typeof makeUser>) =>
        user.click(screen.getByTestId('kpi-drilldown-close')),
    ],
  ])('does not let the focus return pop the trend card back open after %s', async (_name, close) => {
    const user = makeUser();
    // A tile that HAS a series — only three of the five do, and the regression is invisible
    // on a tile with no card to reopen.
    await openPanel(user, TILE_WITH_TREND);

    await close(user);
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await waitFor(() => expect(screen.getByTestId(TILE_WITH_TREND)).toHaveFocus());

    // The card opens on a TIMER (`openDelay`), so it reappears well after every ordinary
    // assertion has already passed. Waiting past that timer is the whole test.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(screen.queryByTestId('metric-trend-card')).toBeNull();
  });

  // --------------------------------------------- the interior contract, as classes ----
  it('is a fixed-height shell with exactly ONE scroll region and a pinned footer', async () => {
    const user = makeUser();
    const { panel } = await openPanel(user, TILE_WITH_TREND);

    // jsdom has no layout, so none of this can be MEASURED. It can be pinned as the class
    // facts it is, and nothing else in the suite covers it.
    const shell = panel.className;
    // FIXED height, not `max-h`: identical for three rows or two hundred.
    expect(shell).toContain('h-[92dvh]');
    // LOAD-BEARING. `h-*` and `max-h-*` are different tailwind-merge groups, so the base
    // `max-h-[85dvh]` on DialogContent survives a bare `h-[92dvh]` and silently clamps the
    // panel to 85dvh. Only the pixel cap evicts it.
    expect(shell).toContain('max-h-[900px]');
    // The shell itself never scrolls — its children do.
    expect(shell).toContain('overflow-hidden');
    expect(shell.split(/\s+/)).not.toContain('overflow-y-auto');
    // `dvh`, never `vh`: mobile URL bars make `vh` wrong, and viewport-units.test.ts lints
    // the primitive for exactly this.
    expect(shell).not.toMatch(/\b\d+vh\b/);
    expect(shell).not.toMatch(/\b\d+vw\b/);

    // EXACTLY ONE scroll region, and it is the labelled, focusable one.
    const scroller = screen.getByTestId('kpi-drilldown-scroll');
    expect(scroller.className).toContain('overflow-auto');
    expect(scroller.className).toContain('min-h-0');
    expect(scroller.className).toContain('flex-1');
    expect(scroller).toHaveAttribute('tabindex', '0');
    expect(scroller).toHaveAttribute('role', 'group');
    expect(scroller.getAttribute('aria-label')).toBeTruthy();
    // Every focusable cell in the table lives in the first column, so an unfocusable scroll
    // port would leave Source, Severity, Status and Owner unreachable by keyboard.

    const scrollers = Array.from(panel.querySelectorAll<HTMLElement>('*')).filter((el) =>
      /(^|\s)overflow-(auto|y-auto|y-scroll)(\s|$)/.test(el.className),
    );
    expect(scrollers).toEqual([scroller]);

    // The rows wrapper is NOT a second scroller: the sticky <thead> must pin to the box the
    // operator is actually looking at, and it pins to its nearest scrollport.
    const rows = screen.getByTestId('kpi-drilldown-rows');
    expect(rows.className).not.toMatch(/overflow-/);
    expect(rows.className).not.toContain('max-h-80');

    // The completeness disclosure is a SIBLING of the scroller, never a child of it. In
    // normal flow it could not clip; under a fixed shell on a short laptop it would, and it
    // is the one sentence that separates a drill-down from a lie.
    const scope = screen.getByTestId('kpi-drilldown-scope');
    expect(scroller.contains(scope)).toBe(false);
    expect(panel.contains(scope)).toBe(true);
  });

  it('pins the table header flush to the scroll port, opaquely', async () => {
    const user = makeUser();
    const { panel } = await openPanel(user, TILE_WITH_TREND);

    // Both halves of this were REAL, observed defects in a browser, and neither is
    // observable in jsdom — so the class contract is the only guard available.
    //
    // 1. The scroll port must carry NO TOP padding. `position: sticky; top: 0` pins to the
    //    padding box, so a `pt-*` on the port left a strip above the header through which
    //    rows scrolled in full view. The vertical rhythm lives on the port's children.
    const scroller = screen.getByTestId('kpi-drilldown-scroll');
    expect(scroller.className).not.toMatch(/(^|\s)(pt-|py-)/);

    // 2. The opaque fill must be on the CELLS. A background on `<thead>` is not reliably
    //    painted — the row-group box is transparent in several engines — and rows scrolling
    //    behind a transparent header read straight through its labels.
    const thead = panel.querySelector('thead');
    expect(thead).not.toBeNull();
    expect(thead?.className).toContain('sticky');
    expect(thead?.className).toContain('top-0');
    expect(thead?.className.split(/\s+/)).not.toContain('bg-card');
    const headerCells = Array.from(panel.querySelectorAll('thead th'));
    expect(headerCells.length).toBeGreaterThan(0);
    for (const cell of headerCells) expect(cell.className).toContain('bg-card');
  });

  it('states completeness honestly, from the store’s own three-valued flag', async () => {
    const user = makeUser();
    await openPanel(user, TILE_WITH_TREND);

    // The fixture's `window_total_exact: false` means the store could not PROVE this page
    // complete. "Bounded" is then the only truthful word, and the badge must not say LIVE,
    // or FRESH, or anything else this panel does not measure.
    const badge = screen.getByTestId('kpi-drilldown-completeness');
    expect(badge).toHaveTextContent(/bounded page/i);
    expect(badge).not.toHaveTextContent(/live/i);
  });

  // ------------------------------------------------------------------------- axe ----
  it('has no axe violations with the panel open', async () => {
    const user = makeUser();
    await openPanel(user, TILE_WITH_TREND);

    // `document.body`, never `container`: the panel is portalled out of the render
    // container, so a container-scoped audit would be green while auditing nothing.
    // The probe is the non-vacuity guard.
    expect(document.body.querySelector('[data-testid="kpi-drilldown"]')).not.toBeNull();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
