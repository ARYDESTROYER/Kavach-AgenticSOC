/**
 * Overview → the KPI DEEP-INSPECTION panel (`KpiDrilldownPanel`).
 *
 * The panel is a Radix MODAL — `<DialogContent role="dialog" aria-modal="true">` portalled
 * to `document.body`, over a scrim, with focus trapped. It used to be a docked, non-modal
 * `<section>` read alongside the strip; that decision was reversed, and the specs that
 * described a "disclosure" were rewritten with it rather than deleted. Two consequences run
 * through every test below and are worth stating once:
 *
 *   - `getByTestId` still reaches the panel through the portal, but `getByRole` for
 *     anything OUTSIDE the top layer does not: Radix `aria-hidden`s the rest of the page.
 *   - `body { pointer-events: none }` while a layer is open, so a tile behind the scrim is
 *     unclickable and user-event THROWS on it. Metric switching therefore goes through the
 *     in-panel switcher pill, which is inside the layer, and which is the affordance a real
 *     operator has for the same act.
 *
 * The panel grew a metric switcher, a block of stat cards, a records table with a
 * detection-source facet, and a CSV export. This file pins the parts of that growth that
 * are about not lying and not losing the operator's place:
 *
 *   1. SWITCHING is a re-point, never a close. The operator is inside the panel comparing
 *      populations; closing it under them would throw away their filters and their place.
 *      Behind a scrim the switcher is the ONLY way to compare, so it is load-bearing.
 *   2. Their free text SURVIVES the switch (it is always an explicit act, and it is the
 *      narrowing most worth holding across populations) while PAGING restarts, because
 *      page four of the previous population indexes nothing in the new one.
 *   3. Focus lands on the panel HEADING — on open and again after a switch — because a
 *      screen-reader user has to hear WHAT they are reading before they hear how to narrow
 *      it. It is TRAPPED while the panel is open and RETURNED to the tile that opened it
 *      when the panel closes, by Escape and by the panel's own Close alike: a focus trap is
 *      a real cost, and the return is what pays for it.
 *   4. The severity facet speaks the PRODUCT's five bands. No vendor priority ladder
 *      (`P0`…`P3`) may leak into the panel: this suite is vendor-agnostic and the two
 *      ladders do not even have the same number of rungs.
 *   5. A stat card whose backing field is absent everywhere reports NOT MEASURED — a dash
 *      plus the reason — never a zero. "Nothing here is acknowledged" and "zero
 *      acknowledged" are different claims.
 *   6. A page the store could not PROVE complete is called a lower bound, never complete.
 *   7. All of it stays axe-clean with the panel open, and the POPULATION sentence is the
 *      dialog's `aria-describedby` target — so opening the panel announces which
 *      population is being listed rather than dangling at a missing id.
 *
 * Offline: the api and the posture fetch are mocked; read-only, nothing here reaches #3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// The panel's rows can open a case, which mounts the shared <CaseDetail> over the page.
// The real component calls `useAuth()` unconditionally and this page mounts under no
// <AuthProvider>, so it is stubbed to a probe exactly as the Scans board stubs it.
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
import { SEVERITY_BAND_ORDER } from '../components/badges';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

/**
 * One SHORT page, so the store looks like it has more to serve.
 *
 * `limit_applied: 2` is the lever: it makes the served page size 2, so a page that
 * returns two rows is a FULL page rather than an exhausted store, and the paging control
 * appears without this fixture having to carry two hundred cases. Neither case carries an
 * `acknowledged_at` — that absence is the subject of the stat-card test.
 */
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
    graded_cases: 0, feedback_count: 0, agreement_rate: 0, avg_accuracy: 0,
    avg_reasoning_quality: 0, avg_action_appropriateness: 0, time_saved_minutes: 0,
    outcome_distribution: {},
  },
  cost: {},
} as unknown as Metrics;

/** Every band non-zero, so the whole-window tally can seed the whole severity menu. */
const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 900,
  severity_counts: { critical: 12, high: 34, medium: 56, low: 78, info: 9 },
  open_now: {
    count: 41, window_exempt: true, as_of: '2026-07-01T08:00:00Z', complete: true, reason: '',
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
    total_cases: 900, verdicted_cases: 400, true_positive_cases: 300, false_positive_cases: 100,
    needs_human_cases: 10, escalated_cases: 5, terminal_cases: 200, auto_closed_cases: 150,
    human_closed_cases: 40, system_closed_cases: 10,
    alert_to_incident_ratio: 0.2, false_positive_rate: 0.25, escalation_rate: 0.01,
    containment_rate: 0.5, automation_rate: 0.75,
  },
  aging: {
    queue_depth: 41, age_buckets: [], oldest: [], arrivals: 900, closures: 200,
    closure_vs_arrival: 0.22, backlog: 41,
  },
  sla: {
    enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0,
    resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 100, breaching: [],
  },
};

/**
 * The store's answer: a short, SERVED-COMPLETE page of a much larger match set whose
 * total it explicitly could NOT prove for the narrowing that was asked for.
 */
const RESPONSE = {
  cases: PAGE,
  total: 900,
  limit_applied: 2,
  window_total_exact: false,
};

/**
 * The `<main>` is the SHELL's, not the page's: `AppShell` renders every route inside
 * `<main id="socMain" role="main">`. Modelling it here is what makes an `axe` run over
 * `document.body` a fair audit — without it the harness would report every band of the
 * dashboard as content outside a landmark, which is an artefact of mounting one page on a
 * bare document rather than anything the operator would ever meet.
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

/** Open one tile's panel and wait for its first page to land. */
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

/** The `offset` of the most recent store read. */
function lastOffset(): unknown {
  const arg = listCasesMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  return arg?.offset;
}

describe('Overview — KPI deep-inspection panel', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    listCasesMock.mockReset();
    getMetricsMock.mockReset();
    usageMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    listCasesMock.mockResolvedValue(RESPONSE);
    getMetricsMock.mockResolvedValue(METRICS);
    usageMock.mockResolvedValue({
      total_cost: 1.25, total_tokens: 12000, call_count: 8, currency: 'USD',
    });
  });

  // ------------------------------------------------------------------- D1 ---
  it('re-points the OPEN panel at another metric instead of closing it', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const panel = screen.getByTestId('kpi-drilldown');
    expect(panel).toHaveAttribute('data-kpi', 'total-cases');
    expect(screen.getByTestId('kpi-drilldown-heading')).toHaveTextContent('Total Cases · details');
    // The heading is the dialog's accessible NAME, not merely a styled line of text.
    expect(panel).toHaveAttribute(
      'aria-labelledby',
      screen.getByTestId('kpi-drilldown-heading').id,
    );

    const switcher = screen.getByTestId('kpi-drilldown-metrics');
    // Every strip metric is reachable from inside the panel, and exactly one is current.
    expect(
      within(switcher)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1);
    expect(screen.getByTestId('kpi-drilldown-metric-total-cases')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByTestId('kpi-drilldown-metric-open-cases'));

    // Still open — the panel was re-pointed, not torn down and rebuilt. One dialog, one
    // layer: a remount would have flashed the scrim and thrown away the operator's place.
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'open-cases'),
    );
    expect(screen.getAllByTestId('kpi-drilldown')).toHaveLength(1);
    expect(screen.getByTestId('kpi-drilldown-heading')).toHaveTextContent('Open Cases · details');
    // The population sentence moved with it, so the panel cannot describe the old cohort —
    // and it is the node a screen reader reads out on open, so it must stay the DESCRIBED
    // one rather than merely be present somewhere in the subtree.
    const population = screen.getByTestId('kpi-drilldown-population');
    expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute(
      'aria-describedby',
      population.id,
    );
    expect(population).toHaveTextContent(/not filtered by the window/i);

    // The tile is a DIALOG TRIGGER now, not a disclosure: it advertises the layer it opens
    // and never claims an expanded state, because the panel it would "control" does not
    // exist while it is closed and is portalled out of the tile's tree when it does.
    for (const id of ['kpi-open-cases', 'kpi-total-cases']) {
      const trigger = screen.getByTestId(id);
      expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      expect(trigger).not.toHaveAttribute('aria-expanded');
      expect(trigger).not.toHaveAttribute('aria-controls');
    }
    // "Exactly one metric claims the panel" is carried by the panel itself now: one dialog
    // in the document, pointed at one metric, with one pressed switcher pill.
    expect(document.body.querySelectorAll('[data-testid="kpi-drilldown"]')).toHaveLength(1);
    expect(screen.getByTestId('kpi-drilldown-metric-open-cases')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('kpi-drilldown-metric-total-cases')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  // ------------------------------------------------------------------- D2 ---
  it('carries the operator’s free text across a switch and restarts paging at page one', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    // The operator narrows, then reads deeper into that narrowed question.
    await userEvent.type(screen.getByTestId('kpi-drilldown-search'), 'alpha');
    await waitFor(() => expect(screen.getAllByTestId('kpi-drilldown-row')).toHaveLength(1));
    expect(screen.getByTestId('kpi-drilldown-row')).toHaveTextContent(
      'Alpha beacon from finance subnet',
    );

    // A short page that was SERVED short is exhausted; this one was served full, so the
    // store still has rows and the paging control is offered.
    await userEvent.click(await screen.findByTestId('kpi-drilldown-more'));
    await waitFor(() => expect(lastOffset()).toBe(2));

    await userEvent.click(screen.getByTestId('kpi-drilldown-metric-open-cases'));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown')).toHaveAttribute('data-kpi', 'open-cases'),
    );

    // The narrowing travels — it is the one the operator most often wants to hold while
    // moving between populations…
    expect(screen.getByTestId('kpi-drilldown-search')).toHaveValue('alpha');
    // …and it is really applied to the new population, not merely echoed in the box.
    await waitFor(() => expect(screen.getAllByTestId('kpi-drilldown-row')).toHaveLength(1));

    // …but the OFFSET does not: page two of the old population indexes nothing in the new
    // one, so the read restarts at the head.
    await waitFor(() => expect(lastOffset()).toBe(0));
    expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(/in this page/);
    expect(screen.getByTestId('kpi-drilldown-scope')).not.toHaveTextContent(/pages read/);
  });

  // ------------------------------------------------------------------- D3 ---
  it('moves focus to the panel HEADING after a metric switch, not to a control', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

    const switchTo = screen.getByTestId('kpi-drilldown-metric-resolved-closed');
    await userEvent.click(switchTo);

    const heading = await screen.findByTestId('kpi-drilldown-heading');
    await waitFor(() => expect(heading).toHaveTextContent('Resolved / Closed · details'));
    // The heading, not the switcher button that was just clicked and not the search box:
    // the reader has to hear WHAT they are now reading first.
    await waitFor(() => expect(heading).toHaveFocus());
    expect(switchTo).not.toHaveFocus();
    expect(screen.getByTestId('kpi-drilldown-search')).not.toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');

    // …and the journey onwards stays INSIDE the layer. A focus trap is the real cost the
    // modal contract accepts (the operator can no longer tab on into the page behind it),
    // so it is asserted rather than assumed: tabbing off the heading must land on another
    // panel control, never on a strip tile behind the scrim.
    await userEvent.tab();
    expect(screen.getByTestId('kpi-drilldown').contains(document.activeElement)).toBe(true);
  });

  // ------------------------------------------------------------------ D3b ---
  /**
   * The two dismissal behaviours the modal contract now owns outright: Radix's
   * `DismissableLayer` owns Escape (the hand-rolled containment guard the docked panel had
   * to carry is retired with it), and focus comes back to the exact tile the operator left
   * — the mitigation that pays for the trap D3 just pinned. Both close paths are exercised,
   * because they run through different code and only one of them goes through Radix.
   *
   * The return is deliberately NOT asserted synchronously. `FocusScope` dispatches its
   * unmount autofocus inside a `setTimeout(…, 0)`, and a `.focus()` from the parent in the
   * same tick would be bounced straight back into the still-mounted trap and then dropped
   * on `<body>`. The panel restores from `onCloseAutoFocus` instead, so this waits.
   */
  async function settleFocusReturn() {
    // The tile's hover card opens on FOCUS behind an open delay, so the return arms a timer
    // the test must let resolve — inside `act`, or its state update lands mid-assertion in
    // the next test and the strict console gate fails a suite that passed.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
    });
  }

  it('closes on Escape and hands focus back to the tile that opened it', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    const tile = await openPanel('kpi-total-cases');
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

    // Radix's built-in top-right X is suppressed (`hideClose`), so there is exactly ONE
    // close control. A stray second one would make every `name: /close/i` query ambiguous
    // and, being a `DialogClose`, would drop focus on `<body>`: this panel opens from state
    // rather than from a `DialogTrigger`, so Radix has no trigger to restore to. Anchored,
    // not `/close/i`: the switcher offers a "Resolved / Closed" metric, and a substring
    // match would count it and pass for the wrong reason.
    expect(
      within(screen.getByTestId('kpi-drilldown')).getAllByRole('button', { name: /^close$/i }),
    ).toHaveLength(1);

    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await waitFor(() => expect(tile).toHaveFocus());
    expect(document.body).not.toHaveFocus();
    // …and the page it was covering is readable and operable again.
    expect(screen.getByTestId('kpi-strip').closest('[aria-hidden="true"]')).toBeNull();
    expect(document.body.style.pointerEvents).toBe('');
    await settleFocusReturn();
  });

  it('closes on its own Close control and returns focus the same way', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    const tile = await openPanel('kpi-total-cases');
    await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

    // The second close path, measured rather than assumed to behave like the first: it
    // runs `onClose` directly instead of through `DismissableLayer`, and it is the one a
    // mouse operator actually uses.
    await userEvent.click(screen.getByTestId('kpi-drilldown-close'));
    await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
    await waitFor(() => expect(tile).toHaveFocus());
    expect(screen.getByTestId('kpi-strip').closest('[aria-hidden="true"]')).toBeNull();
    expect(document.body.style.pointerEvents).toBe('');
    await settleFocusReturn();
  });

  // ------------------------------------------------------------------- D4 ---
  it('offers the product’s five severity bands and never a vendor P0–P3 ladder', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    await userEvent.click(screen.getByTestId('kpi-drilldown-severity'));
    const listbox = await screen.findByRole('listbox');
    const options = within(listbox)
      .getAllByRole('option')
      .map((o) => (o.textContent ?? '').trim());

    // The ONE ladder in `badges.tsx`, most severe first (it is stored ascending), plus the
    // "no facet" entry. Derived from the ladder itself, never restated as five literals —
    // a literal list here would be a second, drifting copy of the vocabulary.
    const expected = [...SEVERITY_BAND_ORDER]
      .reverse()
      .map((b) => b.charAt(0).toUpperCase() + b.slice(1));
    expect(options).toEqual(['All severities', ...expected]);
    expect(expected).toHaveLength(5);

    // Nothing anywhere in the panel — or in the menu portalled out of it — speaks the
    // vendor priority ladder this product deliberately does not use.
    const VENDOR_LADDER = /\bP[0-3]\b/;
    expect(screen.getByTestId('kpi-drilldown').textContent ?? '').not.toMatch(VENDOR_LADDER);
    expect(listbox.textContent ?? '').not.toMatch(VENDOR_LADDER);
  });

  // ------------------------------------------------------------------- D5 ---
  it('reports an unmeasurable stat card as NOT MEASURED, never as a zero', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const stats = await screen.findByTestId('kpi-drilldown-stats');
    const acknowledged = within(stats).getByTestId('kpi-drilldown-stat-acknowledged');

    // A dash and the reason. A zero here would claim a measurement over a field this
    // deployment does not record at all — the lifecycle anchors are optional on the
    // backend, so the unpopulated deployment is the ORDINARY case, not an error.
    //
    // The test is presence of the KEY, not truthiness of the value, and the fixture above
    // omits `acknowledged_at` entirely. A deployment that DOES record acknowledgement but
    // has none yet must read "0", not this dash — that case is pinned below.
    expect(acknowledged).toHaveTextContent('—');
    expect(acknowledged).toHaveTextContent('this deployment records no acknowledgement instant');
    expect(acknowledged.textContent ?? '').not.toMatch(/\d/);

    // A card whose field IS populated still reports a real number, so the dash above is a
    // property of the missing field rather than of the whole block.
    const unassigned = within(stats).getByTestId('kpi-drilldown-stat-unassigned');
    expect(unassigned).toHaveTextContent('1');
    expect(unassigned).toHaveTextContent('of 2 listed');
    // And the block says whose numbers these are — the rows listed, not the window.
    expect(screen.getByTestId('kpi-drilldown')).toHaveTextContent(
      /Over the 2 cases listed below, not the whole window\./i,
    );
  });

  /**
   * The other half of the same contract, and the half that is easy to get backwards.
   *
   * A deployment that RECORDS acknowledgement but has none yet must read "0 of 2 listed",
   * not the dash above. Zero acknowledged and "we cannot tell" are different answers, and
   * collapsing them would tell a shift lead that a wired deployment is unwired. The
   * discriminator is presence of the KEY — `acknowledged_at: null` on the wire means
   * recorded-and-empty — so this fixture sets it explicitly null on every listed case.
   */
  it('reports a recorded-but-empty stat card as a real zero, not as not-measured', async () => {
    listCasesMock.mockResolvedValue({
      ...RESPONSE,
      cases: PAGE.map((c) => ({ ...c, acknowledged_at: null })),
    });

    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const stats = await screen.findByTestId('kpi-drilldown-stats');
    const acknowledged = within(stats).getByTestId('kpi-drilldown-stat-acknowledged');

    expect(acknowledged).toHaveTextContent('0');
    expect(acknowledged).toHaveTextContent('of 2 listed');
    expect(acknowledged).not.toHaveTextContent('this deployment records no acknowledgement');
  });

  // ------------------------------------------------------------------- D6 ---
  it('calls an unproven page a LOWER BOUND and never claims it is complete', async () => {
    renderOverview();
    await screen.findByTestId('page-hero');
    await openPanel('kpi-total-cases');

    const scope = screen.getByTestId('kpi-drilldown-scope');
    // `window_total_exact: false` is the store saying it could not prove the total for the
    // narrowing that was asked for. That is never proof, under any branch.
    expect(scope).toHaveTextContent(/lower bound/i);
    expect(scope.textContent ?? '').not.toMatch(/complete/i);
    expect(scope).toHaveTextContent('first 2 of 900 in this order');
    // Two numerals, two questions — and the panel says so rather than letting the reader
    // fuse "900 matched" with "2 read".
    expect(screen.getByTestId('kpi-drilldown-caveats')).toHaveTextContent(
      /900 counts every case the store matched for this request; the counts above describe the rows read\./i,
    );

    // The other half of the three-valued read, so this is a test of the FLAG rather than
    // of one fixture: once the store proves the total for the same page, the SAME wording
    // becomes a completeness claim.
    listCasesMock.mockResolvedValue({ ...RESPONSE, total: 2, window_total_exact: true });
    await userEvent.click(screen.getByTestId('kpi-drilldown-range'));
    await userEvent.click(await screen.findByRole('option', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(screen.getByTestId('kpi-drilldown-scope')).toHaveTextContent(
        /complete page of 2 cases/i,
      ),
    );
    expect(screen.getByTestId('kpi-drilldown-scope').textContent ?? '').not.toMatch(
      /lower bound/i,
    );
  });

  // ------------------------------------------------------------------- D7 ---
  it('has no axe violations with the deep-inspection panel OPEN', async () => {
    const { container } = renderOverview();
    await screen.findByTestId('page-hero');
    // Settle the strip's count-up numerals first: a lazy numeral upgrading mid-audit would
    // make the snapshot a moving target.
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId('kpi-strip')).queryAllByTestId('count-up'),
        ).toHaveLength(0),
      { timeout: 5000 },
    );
    await openPanel('kpi-total-cases');
    // Non-vacuous: the audit below must actually contain the panel's table, switcher and
    // stat block, and the open layer itself.
    expect(screen.getByTestId('kpi-drilldown-rows')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-drilldown-metrics')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-drilldown-stats')).toBeInTheDocument();
    expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();

    // EXACTLY ONE scroll region, with the row table inside it. The nested scroller this
    // panel used to carry (a `max-h-80` on the table) is the defect the fixed-height shell
    // removed: two scrollports pin the sticky `<thead>` to a box the operator is not
    // looking at, and a re-introduction would be invisible to every other assertion here.
    expect(screen.getAllByTestId('kpi-drilldown-scroll')).toHaveLength(1);
    expect(screen.getByTestId('kpi-drilldown-scroll')).toContainElement(
      screen.getByTestId('kpi-drilldown-rows'),
    );

    // `document.body` rather than the container, so a control that portals out of the
    // panel (every Radix Select here does) — and the panel itself, which is portalled —
    // is inside the audited tree too.
    expect(await axe(document.body)).toHaveNoViolations();

    // The panel is a MODAL. Radix hides the rest of the page with `aria-hidden` (through
    // `aria-hidden`'s `hideOthers`) and NEVER sets the `inert` attribute — the
    // `querySelector('[inert]')` assertion that used to stand here was vacuous for that
    // reason, and its comment ("nothing behind it is inerted") stated the opposite of the
    // contract. The positive shape is the one the case-sheet spec already uses.
    expect(screen.getByTestId('kpi-strip').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(document.body.style.pointerEvents).toBe('none');
    // …and the panel really is portalled out of the render container.
    expect(container.querySelector('[data-testid="kpi-drilldown"]')).toBeNull();
  });
});
