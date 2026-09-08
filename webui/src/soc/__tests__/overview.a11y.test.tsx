/**
 * Overview (Cyber Defence Center) — jest-axe accessibility smoke (Round-7 W1.A).
 *
 * The landing surface: a compact hero (one h1), a TRIMMED KPI strip of drill-down tiles,
 * named widget regions (autonomy split, response timing, connector health, case volume,
 * top signatures/entities), and the server-posture timing trio. It mixes headings,
 * regions, labelled tiles and status chips — a broad guard for heading order / region
 * labelling / non-color signalling / nested-interactive regressions. We render the real
 * <Overview/> with an offline-mocked api + posture fetch, wait for the KPI strip, and
 * assert exactly one h1 + no axe violations (all default rules, incl. heading-order +
 * nested-interactive).
 *
 * The Noise-Reduction funnel is intentionally NOT mocked here so the band self-omits: its
 * own a11y (nested-interactive + labels) is covered by `NoiseFunnel.test`. This keeps the
 * main-layout heading order (h1 → h2 groups) under full axe.
 *
 * It ALSO owns the KPI drill-down's accessibility contract, because that is where the
 * landing page's only non-trivial interaction semantics live. That contract was INVERTED
 * when the panel stopped being a docked `<section>` and became a Radix Dialog, so this
 * paragraph states the contract that now holds rather than the one it replaced:
 *
 *   - the tile is a DIALOG trigger: `aria-haspopup="dialog"`, and NEITHER `aria-expanded`
 *     nor `aria-controls`. Both are disclosure semantics and are wrong here, and a
 *     portalled target cannot be referenced at all while the panel does not exist.
 *   - the panel is a portalled `<div role="dialog" aria-modal="true">`, NAMED by its
 *     heading (`aria-labelledby`) and DESCRIBED by its population sentence
 *     (`aria-describedby`), so opening it announces which population is being listed.
 *   - focus lands on the panel HEADING, and Tab is TRAPPED inside the panel.
 *   - Escape, a scrim click and the panel's own Close all dismiss it, and all three
 *     return focus to the exact tile that opened it.
 *   - the rest of the page is hidden with `aria-hidden` — never `inert`, which Radix has
 *     never set and which the specs here used to assert vacuously.
 *
 * axe runs with the panel OPEN, over `document.body` rather than the render container:
 * the panel is portalled OUT of that container and `aria-hidden`s what it leaves behind,
 * so a container-scoped run audits a page the operator can no longer reach and calls it
 * clean. Every such run carries a non-vacuity probe for the same reason.
 *
 * Offline: no network, no #3 / runtime behaviour touched.
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
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c1', status: 'open', risk_score: 88, source_name: 'Elastic SIEM', entity: { type: 'ip', value: '10.0.0.1' } },
  { case_id: 'c2', status: 'needs_human', risk_score: 65, source_name: 'Wazuh', entity: { type: 'host', value: 'web-01' } },
  { case_id: 'c3', status: 'resolved', risk_score: 20, source_name: 'Elastic SIEM', entity: { type: 'user', value: 'alice' } },
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

const POSTURE: PostureResponse = {
  window_hours: 24, generated_at: '2026-07-01T08:00:00Z', case_count: 3,
  severity_counts: { critical: 1, high: 1, medium: 0, low: 1, info: 0 },
  open_now: { count: 2, window_exempt: true, as_of: '2026-07-01T08:00:00Z', complete: true, reason: '' },
  window_covered: true, window_coverage_reason: '', oldest_fetched_at: '2026-06-30T08:00:00Z',
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no case has received a first response yet' },
  },
  quality: {
    total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 1, escalated_cases: 0, terminal_cases: 4, auto_closed_cases: 2,
    // The complete three-way partition. It no longer renders on the tile FACE — it moved
    // into the tile's drill-down modal — so the <dl> axe used to inspect here is audited
    // in `overview.kpimodal.a11y.test.tsx` instead. The payload stays complete so the
    // Human-vs-AI instrument on this page still publishes its reconciling bands, which
    // this file's runs DO cover.
    human_closed_cases: 1, system_closed_cases: 1,
    alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
    containment_rate: 0.5, automation_rate: 0.5,
  },
  aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 3, closures: 1, closure_vs_arrival: 0.33, backlog: 2 },
  sla: { enabled: true, evaluated: 2, response_breached: 1, response_at_risk: 1, resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 87.5, breaching: [] },
};

describe('Overview — a11y smoke (jest-axe)', () => {
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

  it('has exactly one h1 and no axe violations on the loaded command center', async () => {
    const { container } = render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument(), {
      timeout: 5000,
    });
    // KPI numerals progressively upgrade from CountUp to the lazy motion number.
    // Wait through Testing Library's act-aware loop so the a11y snapshot represents
    // the settled strip and the Suspense completion cannot leak a React warning.
    await waitFor(
      () => {
        expect(within(screen.getByTestId('kpi-strip')).queryAllByTestId('count-up')).toHaveLength(0);
      },
      { timeout: 5000 },
    );
    // Exactly one page-level h1 (the hero title); widget groups are h2.
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  describe('KPI drill-down dialog', () => {
    /**
     * ONE user-event instance whose pointer-events guard is OFF, for the few interactions
     * that deliberately reach OUTSIDE the open panel.
     *
     * A modal Radix layer sets `pointer-events: none` on `<body>`. user-event's guard
     * exists to catch clicks on genuinely inert controls and cannot tell that from a
     * scrim, and the message it throws names user-event rather than the modal — the most
     * expensive kind of failure to read. Anything INSIDE the panel keeps the direct API:
     * the dialog content carries inline `pointer-events: auto` while it is the top layer,
     * so the guard is still meaningful there.
     *
     * The precedent (and this wording) is `overview.lattice.test.tsx`, which does the same
     * for the case sheet. It is deliberately per-instance: disabling the check globally in
     * `src/test/setup.ts` would silently retire it for every suite.
     */
    const pointer = userEvent.setup({ pointerEventsCheck: 0 });

    /** The ONE open modal layer, asserted rather than assumed. */
    function openDialog(): HTMLElement {
      const layers = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
      expect(layers).toHaveLength(1);
      return layers[0];
    }

    /** Render, settle the strip, and hand back the Total Cases tile. */
    async function mountStrip() {
      const view = render(<Overview onNavigate={vi.fn()} />);
      await screen.findByTestId('page-hero');
      const tile = await screen.findByTestId('kpi-total-cases');
      await waitFor(
        () => {
          expect(within(screen.getByTestId('kpi-strip')).queryAllByTestId('count-up')).toHaveLength(
            0,
          );
        },
        { timeout: 5000 },
      );
      return { ...view, tile };
    }

    it('has no axe violations with the panel OPEN, and is a dialog not a disclosure', async () => {
      const { tile } = await mountStrip();
      // Closed: a dialog trigger ANNOUNCES a popup and names no controlled region. There
      // is nothing to name — the panel is portalled and does not exist while it is closed,
      // so an `aria-controls` here could only ever dangle, and a dangling id is itself an
      // invalid attribute value.
      expect(tile).toHaveAttribute('aria-haspopup', 'dialog');
      expect(tile).not.toHaveAttribute('aria-expanded');
      expect(tile).not.toHaveAttribute('aria-controls');
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();

      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-rows')).toBeInTheDocument());

      // Open: still no disclosure semantics on the trigger, in EITHER state.
      expect(tile).not.toHaveAttribute('aria-expanded');
      expect(tile).not.toHaveAttribute('aria-controls');

      // The whole point of the change: one modal layer, over a scrim, with the page
      // behind it hidden from assistive tech.
      expect(panel.tagName).toBe('DIV');
      expect(panel).toBe(openDialog());
      expect(panel).toHaveAttribute('role', 'dialog');
      expect(panel).toHaveAttribute('aria-modal', 'true');
      expect(panel.getAttribute('aria-labelledby')).toBe(
        screen.getByTestId('kpi-drilldown-heading').id,
      );
      // DESCRIBED by the population sentence, so the open announces WHICH population is
      // being listed. Radix wires `aria-describedby` BEFORE the consumer spread, so a
      // dangling id is the default failure mode here, not an exotic one — resolve it.
      const population = within(panel).getByTestId('kpi-drilldown-population');
      expect(population.id).not.toBe('');
      expect(panel.getAttribute('aria-describedby')).toBe(population.id);
      expect(document.getElementById(population.id)).toBe(population);

      // EXACTLY one scroll region, and it is the shell rather than the row table: the
      // fixed-height page-in-page depends on there being one, and a keyboard-only
      // operator reaches the table's right-hand columns through nothing else.
      const scrollers = within(panel).getAllByTestId('kpi-drilldown-scroll');
      expect(scrollers).toHaveLength(1);
      expect(scrollers[0]).toHaveAttribute('tabindex', '0');
      expect(scrollers[0]).toHaveAttribute('role', 'group');
      expect(scrollers[0]).toHaveAccessibleName();
      // The three classes that make it a real scroll port rather than a named div. jsdom
      // computes no layout, so the class list is the only evidence available — and
      // `min-h-0` is the load-bearing one: without it the flex item refuses to shrink
      // below its content, the fixed shell overflows instead of scrolling, and the
      // footer's completeness disclosure goes off-screen with it.
      for (const cls of ['overflow-auto', 'min-h-0', 'flex-1']) {
        expect(scrollers[0].className.split(/\s+/)).toContain(cls);
      }
      // The rows wrapper is INSIDE it and carries no scroller of its own — a second one
      // would pin the sticky <thead> to a box that never moves.
      const rows = screen.getByTestId('kpi-drilldown-rows');
      expect(scrollers[0].contains(rows)).toBe(true);
      expect(rows).not.toHaveAttribute('tabindex');
      expect(rows).not.toHaveAttribute('role');

      // Radix hides the rest of the page from assistive tech with `aria-hidden`, never
      // with `inert`. The old `querySelector('[inert]')` assertion passed under BOTH
      // contracts while proving nothing; assert the mechanism that is really used.
      expect(tile.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(panel.closest('[aria-hidden="true"]')).toBeNull();
      expect(document.querySelector('[inert]')).toBeNull();

      // axe with the panel OPEN, over `document.body` — NOT the render container, which
      // the panel has left and which is itself `aria-hidden` while it is open. The probe
      // above the run is what stops it auditing nothing and reporting success.
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
      expect(await axe(document.body)).toHaveNoViolations();
      // Still exactly one h1 in the whole document: the panel heading is an h2.
      expect(document.body.querySelectorAll('h1')).toHaveLength(1);
      expect(screen.getByTestId('kpi-drilldown-heading').tagName).toBe('H2');
    });

    it('states the page it read on a badge, beside the heading and never inside the footer', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-rows')).toBeInTheDocument());

      // This fixture is a WINDOWED read whose store sends no `window_total_exact`, i.e.
      // "not proven" — so the badge must say so rather than rounding up to complete.
      const badge = within(panel).getByTestId('kpi-drilldown-completeness');
      expect(badge).toHaveTextContent(/^Bounded page · lower bound$/);
      // A SIBLING of the footer sentence, never a child of it: the footer's own honesty
      // assertions read `kpi-drilldown-scope` as a subtree, and a badge nested inside it
      // would make those a coin-flip on the badge's wording.
      expect(screen.getByTestId('kpi-drilldown-scope').contains(badge)).toBe(false);
    });

    it.each([
      ['{Enter}', 'Enter'],
      [' ', 'Space'],
    ])('opens on %s with focus landing on the panel heading', async (key) => {
      const { tile } = await mountStrip();
      act(() => tile.focus());
      await userEvent.keyboard(key);

      await screen.findByTestId('kpi-drilldown');
      const heading = screen.getByTestId('kpi-drilldown-heading');
      // The HEADING, never a filter control: a screen-reader user has to hear WHAT
      // opened before they hear how to narrow it.
      await waitFor(() => expect(heading).toHaveFocus());
      expect(heading).toHaveAttribute('tabindex', '-1');
      // The role belongs to the portalled CONTENT; the heading only NAMES it.
      expect(heading).not.toHaveAttribute('role', 'dialog');
      expect(openDialog().getAttribute('aria-labelledby')).toBe(heading.id);
    });

    it('traps Tab inside the panel and never leaks into the page behind', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      // The budget is DERIVED from the stops this fixture actually produces, never a
      // literal. A literal is worse than wrong here: the day a control is added the walk
      // stops short of the wrap-around, and the containment assertion below then passes
      // for the wrong reason while saying nothing at all about the real cause. The stop
      // set now includes `kpi-drilldown-scroll` — the one scroll port is a tab stop.
      const FOCUSABLE =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
        ' textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])';
      const controls = panel.querySelectorAll(FOCUSABLE).length;
      // Guard against a vacuous sweep: a panel that rendered no controls at all would
      // make every budget sufficient and prove nothing.
      expect(controls).toBeGreaterThan(0);
      const budget = controls + 4;
      expect(budget).toBeGreaterThan(controls);

      // Walk forward well past the panel's own controls. Under the modal contract the
      // walk WRAPS rather than escaping: `FocusScope` is `trapped` + `loop`, so the tab
      // after the last stop returns to the first instead of landing on the strip behind
      // the scrim — which no operator could see, reach or leave.
      for (let i = 0; i < budget; i += 1) await userEvent.tab();

      expect(screen.getByTestId('kpi-drilldown')).toBe(panel);
      expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(panel.contains(document.activeElement)).toBe(true);
      expect(tile.contains(document.activeElement)).toBe(false);
    });

    it('closes on Escape and returns focus to the trigger tile', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      await userEvent.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
      // The ONLY restore path: this panel opens from STATE, never a `DialogTrigger`, so
      // Radix's own close-autofocus has a null trigger to send focus to and would drop it
      // on `<body>`. The panel claims the default in `onCloseAutoFocus` instead.
      expect(tile).toHaveFocus();
      expect(tile).not.toHaveAttribute('aria-controls');
      // …and the page around it is usable again: no orphaned `aria-hidden`, no scrim
      // left holding `pointer-events: none` on the body.
      expect(tile.closest('[aria-hidden="true"]')).toBeNull();
      expect(document.body.style.pointerEvents).not.toBe('none');
    });

    it('closes on a scrim click and returns focus to the trigger tile', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      // The scrim is a dismissal path the docked disclosure never had, and it routes
      // through the same `onOpenChange(false)` → `onClose` as Escape — so the focus
      // return has to hold for it too, or a mouse operator loses their place.
      await pointer.click(document.body);

      await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
      await waitFor(() => expect(tile).toHaveFocus());
      expect(tile.closest('[aria-hidden="true"]')).toBeNull();
    });

    it('lets a filter dropdown swallow its own Escape without tearing down the panel', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');

      // A Radix Select stacks its own dismissable layer ABOVE this dialog, and Radix
      // answers Escape on the HIGHEST layer only — so the Select consumes its own key and
      // the dialog beneath it is untouched. That is now a property of the layer stack
      // rather than of the hand-rolled `defaultPrevented` guard this panel used to carry,
      // which is exactly why it is still worth pinning: the guard is gone, and a
      // regression would take the whole panel down on a dropdown dismissal.
      // `aria-expanded` here is the SELECT trigger's own, untouched by the change.
      const sortTrigger = screen.getByTestId('kpi-drilldown-sort');
      await userEvent.click(sortTrigger);
      await waitFor(() => expect(sortTrigger).toHaveAttribute('aria-expanded', 'true'));
      await userEvent.keyboard('{Escape}');

      await waitFor(() => expect(sortTrigger).toHaveAttribute('aria-expanded', 'false'));
      expect(screen.getByTestId('kpi-drilldown')).toBeInTheDocument();
      expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(tile).toHaveAttribute('aria-haspopup', 'dialog');
    });

    it('closes on Escape from EVERY control the panel renders, new ones included', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      // Radix owns Escape now, but the sweep still earns its keep. A control that
      // portalled out of this layer and registered no layer of its own would swallow
      // Escape with no dismissal behind it; one that stopped propagation before the
      // document listener would make the panel un-closable from that stop. Neither is
      // visible in a reading of the control, so walk to every focusable stop the panel
      // actually renders — the new `kpi-drilldown-scroll` port included — and press
      // Escape from each.
      const FOCUSABLE =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
        ' textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])';
      const stops = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      expect(stops.length).toBeGreaterThan(0);

      for (const stop of stops) {
        // Reopen for each stop: Escape closes, so every iteration needs its own panel.
        if (screen.queryByTestId('kpi-drilldown') === null) {
          await userEvent.click(tile);
          await screen.findByTestId('kpi-drilldown');
        }
        const live = screen
          .getByTestId('kpi-drilldown')
          .querySelector<HTMLElement>(`[data-testid="${stop.dataset.testid ?? ''}"]`);
        (live ?? stop).focus();
        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
        expect(tile).toHaveFocus();
      }
      // The sweep reopens the panel — and re-runs its fetch — once per focusable stop, so
      // its cost is proportional to the control count and sits just under the 5s default.
      // It passed in isolation and timed out under parallel load. Raising the budget is the
      // honest fix: thinning the sweep to fit would drop exactly the stops most likely to
      // be the one that swallows Escape.
    }, 20_000);

    // RETIRED: "closes on Escape while a NEIGHBOUR tile's hover card is open".
    //
    // It guarded a hand-rolled Escape guard that trusted `defaultPrevented`, which any
    // Radix layer anywhere on the page — including a neighbouring tile's trend card —
    // could disable. Both halves of that scenario are now structurally unreachable: the
    // guard is gone (Radix's layer stack dismisses the TOP layer, covered by the Select
    // test above), and behind the scrim no neighbouring card can open at all, because
    // every tile is `aria-hidden`, `pointer-events: none` AND passed `forceClosed`. The
    // surviving risk is the opposite one — a card popping open on the focus RETURN — and
    // that is what the two tests below cover, now for BOTH dismissal affordances.

    it.each([
      [
        'Escape',
        async () => {
          await userEvent.keyboard('{Escape}');
        },
      ],
      [
        'the panel’s own Close button',
        async () => {
          await userEvent.click(screen.getByTestId('kpi-drilldown-close'));
        },
      ],
    ])('does not let the focus RETURN after %s pop the trend card back open', async (_label, close) => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      await close();
      await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
      await waitFor(() => expect(tile).toHaveFocus());

      // Radix opens on a TIMER, and the restore now happens in the panel's own
      // `onCloseAutoFocus` — i.e. AFTER the commit that drops `forceClosed`, not before
      // it. The reopen timer the focus return arms therefore resolves just outside a
      // one-`openDelay` grace period, which is why `MetricHoverTrend` refuses opens for
      // TWO. Both close affordances arm the same timer, so both belong here.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });
      expect(screen.queryByTestId('metric-trend-card')).toBeNull();
      expect(tile.closest('[aria-hidden="true"]')).toBeNull();
    });

    it('keeps the hover trend card suppressed for as long as the panel is open', async () => {
      const { tile } = await mountStrip();
      // Hover FIRST, so an already-latched card has to be torn down rather than merely
      // prevented — the trigger opens on focus too, and the focus return on close would
      // otherwise pop it straight back over the strip.
      await userEvent.hover(tile);
      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');

      await waitFor(() => expect(screen.queryByTestId('metric-trend-card')).toBeNull());
      // A synthetic hover no real operator can perform: behind the scrim the tile is
      // `aria-hidden` and unhoverable. It still earns its place — it proves `forceClosed`
      // holds if the card is ever reached by a stray focus or a re-armed timer.
      await pointer.hover(tile);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 350));
      });
      expect(screen.queryByTestId('metric-trend-card')).toBeNull();
      // The series is not lost — the panel restates it. With the strip both `aria-hidden`
      // and pointer-events-none, this is now the ONLY reachable surface for it, on any
      // input mode.
      expect(within(panel).getByTestId('kpi-drilldown-trend')).toBeInTheDocument();
    });
  });
});
