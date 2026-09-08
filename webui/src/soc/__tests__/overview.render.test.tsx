/**
 * Overview (Cyber Defence Center) — render test for the Stitch-inspired command center.
 *
 * Pins the load-bearing dashboard contract:
 *   1. the PLAIN header (page-hero, no hero card chrome, exactly one h1, PAGE_TITLE,
 *      and NO subtitle line);
 *   2. the un-nested KPI micro-strip of 6 SERVER-FED tiles (Total Cases / Total
 *      Critical / Open Cases / False-Positive-Rate / Resolved-Closed / Auto Closed, the
 *      last a SUBSET of the one before it rather than a sixth independent total); LLM
 *      spend is NOT a hero tile; every tile pairs its numeral with the honest denominator
 *      it is a share of — in the tile's help, since the strip gave the caption row back to
 *      a 30px numeral — and the two that HAVE no denominator (the cohort total itself, and
 *      the window-exempt open stock) say so instead of inventing one;
 *  2d. the strip's `sub` carries STATE DISCLOSURES only. Descriptive captions moved to
 *      each tile's help; a conditional BOUND could not move, and became a marker ON the
 *      numeral (`data-bound`, a `≥` floor mark or a withheld em dash, plus the sentence as
 *      `sr-only` text) which never fires on an outage's structural zeros;
 *  2b. the tile ANCHORS were re-keyed with the labels — `kpi-open-cases` names the
 *      open stock, not the cohort total, and the retired anchors are gone;
 *  2c. the posture-fed tiles gate on `window_covered`, not on `truncated`;
 *   3. the ONE integrated 12-column lattice, TWO rows — Noise-Reduction flow + Human vs
 *      AI, then the stacked resolved/open snapshots + the timing pair + latest cases;
 *   4. the Cases-burndown chart is NOT on this page (it lives on Metrics → Posture as
 *      "Closure vs arrival"); reading ORDER within the lattice is asserted, not presence;
 *   5. timing reads the SERVER posture (honest DASH / "not measured" for missing samples);
 *   6. NO period-over-period delta chips on the KPI strip (the FP-rate compare chip was
 *      deliberately removed — its baseline was not explainable at a glance);
 *   7. tiles + snapshot CTAs deep-link to the filtered case list carrying the window;
 *   8. blocking load uses the shared centered Console loading grammar;
 *   9. a window change keeps the last posture snapshot visible (stale-while-revalidate)
 *      and still discards late cross-window payloads. The "Loading N" sub is reserved for
 *      a FIRST load — a measurement already on screen is not a placeholder — and both arms
 *      of that gate are pinned together.
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
  // `total_cases` here is deliberately DIFFERENT from the posture `case_count` below:
  // `quality_metrics` strips policy-closed rows first, so the Total Cases tile must
  // read `case_count` (4) and never this narrower field (3).
  total_cases: 3, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
  needs_human_cases: 1, escalated_cases: 0, terminal_cases: 1, auto_closed_cases: 1,
  alert_to_incident_ratio: 0.33, false_positive_rate: 0.5, escalation_rate: 0.33,
  containment_rate: 0.5, automation_rate: 0.5,
};

/** QUALITY plus the complete three-way close partition (agent + analyst + residual). */
const QUALITY_ATTRIBUTED = {
  ...QUALITY,
  terminal_cases: 9,
  auto_closed_cases: 5,
  human_closed_cases: 3,
  system_closed_cases: 1,
};

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  // The window's ARRIVAL COHORT, policy-closed included — 4, one more than the
  // policy-stripped `quality.total_cases`, and one more than the 3 rows the bounded
  // case page happens to hold. Both differences are deliberate.
  case_count: 4,
  // The server-side band partition of `case_count` (sums to it exactly).
  severity_counts: { critical: 1, high: 1, medium: 1, low: 1, info: 0 },
  // The window-EXEMPT open STOCK: 5 cases are open right now, MORE than the window
  // cohort holds, because older still-open cases count toward a stock.
  open_now: {
    count: 5,
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

/**
 * Open one KPI tile's drill-down MODAL, and settle it.
 *
 * The close-attribution partition moved OFF the tile face into this panel (three rows —
 * four where the backend reports declared-benign policy closes — that the other four tiles
 * did not have, so one tile set the height of the whole strip), so every partition contract
 * below is asserted through here rather than on the strip.
 *
 * `pointerEventsCheck: 0` because an open Radix modal sets `pointer-events: none` on
 * <body>, and user-event cannot tell that from a genuinely inert control — it would report
 * a failure that names user-event rather than the modal.
 */
async function openDrilldown(testId: string): Promise<void> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  // Opening from the STRIP is only reachable while nothing is open: behind an open panel
  // the strip is `aria-hidden` and `pointer-events: none`.
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  await user.click(await screen.findByTestId(testId));
  await screen.findByTestId('kpi-drilldown');
  await waitFor(() =>
    expect(
      screen.queryByTestId('kpi-drilldown-rows') ?? screen.getByTestId('kpi-drilldown-scope'),
    ).toBeInTheDocument(),
  );
}

/** The band labels the OPEN drill-down states, in order. `null` when it states none. */
function drilldownBands(): { labels: string[]; values: string[] } | null {
  const dl = screen.queryByTestId('kpi-drilldown-partition');
  if (!dl) return null;
  return {
    labels: Array.from(dl.querySelectorAll('dt')).map((n) => n.textContent ?? ''),
    values: Array.from(dl.querySelectorAll('dd')).map((n) => n.textContent ?? ''),
  };
}

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
    // The masthead carries the title and the controls — nothing else. The former
    // "Live operational posture across triage, risk, and response." subtitle described
    // the page rather than telling the operator anything, and is gone.
    expect(within(hero).queryByText(/Live operational posture/i)).toBeNull();
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

  it('renders the KPI micro-strip: 6 server-fed tiles (LLM spend NOT a hero tile)', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());
    const strip = screen.getByTestId('kpi-strip');
    for (const id of [
      'kpi-total-cases',
      'kpi-total-critical',
      'kpi-open-cases',
      'kpi-false-positive-rate',
      'kpi-resolved-closed',
      'kpi-auto-closed',
    ]) {
      expect(within(strip).getByTestId(id)).toBeInTheDocument();
    }
    // The rename was a SWAP, not five string edits: `kpi-open-cases` survives but now
    // names the open STOCK, and every anchor whose metric moved away is gone. A
    // label-only edit would have left these three in place, carrying the wrong number.
    for (const retired of [
      'kpi-critical',
      'kpi-critical-high',
      'kpi-escalated-to-human',
      'kpi-auto-resolved',
    ]) {
      expect(within(strip).queryByTestId(retired)).toBeNull();
    }
    // EXACTLY 6 hero tiles.
    // Count the TILES, not every `kpi-*` anchor inside the strip. Each tile also carries a
    // decorative affordance mark (`kpi-<id>-affordance`), so a bare prefix count answers a
    // different question than the one this test asks — and answering it by loosening the
    // number would have stopped proving there are exactly six tiles at all. (A tile could
    // once also carry a `kpi-<id>-breakdown` partition; that anchor retired to the
    // drill-down, so the selector no longer excludes it. A tile under a conditional bound
    // also carries a `kpi-<id>-bound` mark; this fixture's window is fully covered, so no
    // tile raises one here — the bounded arm counts them out explicitly instead.)
    expect(
      strip.querySelectorAll(
        '[data-testid^="kpi-"]:not([data-testid*="-affordance"]):not([data-testid$="-bound"])',
      ),
    ).toHaveLength(6);
    // Spend is not on the strip.
    expect(within(strip).queryByTestId('kpi-llm-spend')).toBeNull();

    /*
     * The DESCRIPTIVE captions are off the face — every one of them, deliberately. They
     * were prose about numerals that had not changed, read once and then furniture, and at
     * two mono lines they outweighed the number they qualified. They are asserted VERBATIM,
     * in the help popover they moved to, by "relocates every strip caption…" below; here
     * they are counted OUT, so a caption cannot quietly come back and re-take the row the
     * 30px numeral was given. What is NOT relocatable — a conditional bound, and a state
     * disclosure — has its own arms further down this file.
     */
    // Total Cases = the posture window's ARRIVAL COHORT (4), NOT the policy-stripped
    // `quality.total_cases` (3) and NOT the bounded case page (3 rows).
    const totalCases = within(screen.getByTestId('kpi-total-cases'));
    expect(totalCases.getByText('4')).toBeInTheDocument();
    expect(totalCases.queryByText('Window arrivals · policy-closed included')).toBeNull();
    // Total Critical = the SERVER band tally, not a band counted over the page.
    expect(within(screen.getByTestId('kpi-total-critical')).getByText('1')).toBeInTheDocument();
    // The BAND NAME travelled with the rest of the captions. It is still DERIVED from the
    // severity ladder rather than written out — `overview.topband.test.tsx` moves the
    // ladder's top entry and reads the tile's help back to prove it.
    expect(within(screen.getByTestId('kpi-total-critical')).queryByText('Critical band')).toBeNull();
    // Open Cases = the window-EXEMPT stock (5), which is deliberately LARGER than the
    // 4-case window cohort — proof it is not being window-filtered.
    const openCases = within(screen.getByTestId('kpi-open-cases'));
    expect(openCases.getByText('5')).toBeInTheDocument();
    expect(openCases.queryByText('Open now · not window-filtered')).toBeNull();
    // False-positive rate reads the server quality rate (0.5 → "50%").
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%')).toBeInTheDocument();
    // The sub is GONE, not moved: "Closed as false positive" only restated the label. What
    // the tile actually needed explaining — that the denominator is verdicted cases, not
    // every case — is in its help popover instead.
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).queryByText('Closed as false positive'),
    ).toBeNull();
    // Resolved / Closed = TERMINAL cases (1), not the agent-only auto-closed subset.
    const resolved = within(screen.getByTestId('kpi-resolved-closed'));
    expect(resolved.getByText('1')).toBeInTheDocument();
    // Likewise a tautology of the label, and likewise deleted rather than shortened.
    expect(resolved.queryByText('Reached a terminal state')).toBeNull();
    // Auto Closed = `quality.auto_closed_cases` (1) straight off the server. It sits
    // IMMEDIATELY after Resolved / Closed and shares that tile's `success` accent, which
    // is half of how the row says "subset, not a sixth total" (the copy is the other half,
    // asserted in its own case below). Adjacency is a DOM-order fact, so it is asserted as
    // one rather than left to the array literal.
    const autoClosed = within(screen.getByTestId('kpi-auto-closed'));
    expect(autoClosed.getByText('1')).toBeInTheDocument();
    const cells = Array.from(strip.children);
    const cellOf = (id: string) =>
      cells.findIndex((cell) => cell.querySelector(`[data-testid="${id}"]`));
    expect(cellOf('kpi-auto-closed')).toBe(cellOf('kpi-resolved-closed') + 1);
    // The shared accent, on the numeral itself. `success` is what Resolved / Closed wears;
    // any OTHER accent here would teach the eye that a new accent means a new population.
    expect(
      screen.getByTestId('kpi-auto-closed').querySelector('.items-end > span'),
    ).toHaveClass('text-success-text');
    // DENSITY REGRESSION GUARD. The landing strip runs `density="compact"` because it
    // heads a page that must also seat the flow diagram, the case queue and the timing
    // pair. `px-3 py-2` is what compact swaps on a strip tile's trigger.
    //
    // `min-h-0` is asserted on the CELL ROOT rather than the trigger. Every strip tile now
    // has one: the trigger is a <button>, so anything that must sit beside it rather than
    // inside it — the help popover trigger (a nested button is invalid DOM) — forces a
    // wrapper, and the wrapper is then the cell and owns the cell's height. Update these
    // tokens if density changes; never delete them.
    const totalCasesTrigger = screen.getByTestId('kpi-total-cases');
    expect(totalCasesTrigger).toHaveClass('px-3', 'py-2');
    expect(totalCasesTrigger.parentElement).toHaveClass('min-h-0');
    // BOTH halves of the strip's rhythm, not just the padding. The second half used to be
    // compact's fixed 4px label→numeral gap (`mt-1`), the one token no gate could see;
    // under `numeral="hero"` that gap is SUPERSEDED — `cn` is `twMerge`, so `mt-auto`
    // replaces `mt-1` outright — because the six numerals now share a baseline instead of
    // sitting a fixed distance under labels that wrap to one, two or three lines. So the
    // guard moves to the two classes that produce it, and it is the same kind of guard:
    // drop either one and the row silently re-staggers with every suite still green. (The
    // compact `mt-1` a non-hero caller still gets is pinned in KpiTile.hero-bound.)
    expect(totalCasesTrigger).toHaveClass('flex', 'h-full', 'flex-col');
    expect(totalCasesTrigger.querySelector(':scope > div.items-end')).toHaveClass('mt-auto');
  });

  it('draws the six-cell divider math exactly, at every breakpoint', async () => {
    /*
     * The strip's hairlines are hand-tuned `nth-child` arbitrary variants, and the ONLY
     * thing a change to them can break is invisible in jsdom: a cell drawing a rule into
     * empty space, or losing the rule that separates it from the next row. The geometric
     * oracle is `right = i mod cols ≠ 0 and i ≠ n`, `bottom = i ≤ n − cols`; the classes
     * below were compiled with this repo's Tailwind and read back from computed styles in
     * a real browser at 500 / 700 / 900 / 1400px against it. jsdom performs no layout and
     * no cascade, so what CAN be pinned here — and what actually regresses — is the class
     * string itself, per breakpoint, character for character.
     *
     * ⚠️ Asserted on the className STRING, never by QUERYING with these selectors: jsdom's
     * nwsapi THROWS on `:not(:nth-child(3n))`, so a `querySelector` written against the
     * same rule would error rather than fail, which is a strictly worse signal.
     *
     * The `:not()`s are load-bearing and must not be "simplified" away. Tailwind emits
     * arbitrary-variant rules in ONE trailing block whose internal order is not by
     * breakpoint, so at `md` the `2n` ON rule beat the `3n` OFF rule on cell 6 only by
     * emission order at equal (0,2,0) specificity; `:not()` lifts it to (0,3,0). At `xl`,
     * `:not(:nth-child(6n))` is strictly required.
     */
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());
    const strip = screen.getByTestId('kpi-strip');

    // Six columns at `xl` — the count the whole rule set is written against. 6 % {1,2,3,6}
    // is 0, so every breakpoint fills whole rows and "last column" coincides with "last
    // child"; five left orphans, which is what the two new rules below repair.
    expect(strip).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'md:grid-cols-3', 'xl:grid-cols-6');
    expect(strip).not.toHaveClass('xl:grid-cols-5');
    expect(strip.children).toHaveLength(6);

    const cells = Array.from(strip.children) as HTMLElement[];
    for (const [i, cell] of cells.entries()) {
      const cls = cell.className;
      // 1 COLUMN — every cell rules below it, and `last:` lifts it off the final one.
      expect(cls, `cell ${i + 1}`).toContain('border-b');
      expect(cls, `cell ${i + 1}`).toContain('border-r-0');
      expect(cls, `cell ${i + 1}`).toContain('last:border-b-0');
      expect(cls, `cell ${i + 1}`).toContain('last:border-r-0');
      // 2 COLUMNS — rule on the left cell of each pair, and no bottom rule under the final
      // row, which at six cells starts at cell 5. (`n+5` is the half the five-cell string
      // did not have, and the half a sixth tile broke.)
      expect(cls, `cell ${i + 1}`).toContain('sm:border-r');
      expect(cls, `cell ${i + 1}`).toContain('sm:[&:nth-child(2n)]:border-r-0');
      expect(cls, `cell ${i + 1}`).toContain('sm:[&:nth-child(n+5)]:border-b-0');
      // 3 COLUMNS — rule after cells 2 and 5 (`2n` MINUS the column ends), off after every
      // 3rd, and no bottom rule under the final row, which starts at cell 4.
      expect(cls, `cell ${i + 1}`).toContain('md:[&:nth-child(2n):not(:nth-child(3n))]:border-r');
      expect(cls, `cell ${i + 1}`).toContain('md:[&:nth-child(3n)]:border-r-0');
      expect(cls, `cell ${i + 1}`).toContain('md:[&:nth-child(n+4)]:border-b-0');
      // 6 COLUMNS — one row, so no bottom rule anywhere; the only interior rule is after
      // cell 3, and `:not(:nth-child(6n))` is what keeps it off cell 6, the row's end.
      expect(cls, `cell ${i + 1}`).toContain('xl:border-b-0');
      expect(cls, `cell ${i + 1}`).toContain('xl:[&:nth-child(3n):not(:nth-child(6n))]:border-r');
      // The five-cell rules this replaced, counted OUT: at six cells `xl:[2n]:border-r`
      // ruled cells 2 and 4 mid-row and `xl:[3n]` ruled cell 6 into empty space.
      expect(cls, `cell ${i + 1}`).not.toContain('xl:[&:nth-child(2n)]:border-r');
      expect(cls, `cell ${i + 1}`).not.toContain('xl:[&:nth-child(3n)]:border-r ');
    }
    // Every cell carries the IDENTICAL string: the grid supplies the hairlines through
    // `nth-child`, so a per-cell divergence would mean someone hand-tuned one tile and the
    // oracle above no longer describes the row.
    expect(new Set(cells.map((cell) => cell.className)).size).toBe(1);
  });

  /**
   * Open ONE tile's help popover, hand back its text, and close it again.
   *
   * The strip's descriptive copy and its scale contexts BOTH live here now. Radix portals
   * the popover to `<body>` and unmounts it while closed, so the text is only readable
   * with the popover open — hence the open/close round trip, which also keeps each tile's
   * assertions independent of the last one's.
   *
   * The text is returned as a STRING and asserted with `toContain`, i.e. exact substrings:
   * these sentences are the relocated copy, and a re-point that matched them loosely would
   * be indistinguishable from having deleted them.
   */
  async function readTileHelp(label: string): Promise<string> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: `About ${label}` }));
    const content = await screen.findByRole('dialog');
    const text = content.textContent ?? '';
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    return text;
  }

  it('pairs every KPI numeral with the honest denominator it is a share of', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    /*
     * The scale context is no longer BESIDE the numeral: at six columns it and a 30px
     * numeral share one `items-end` row against ~141px of cell content on the tightest
     * supported desktop, so "12,345 of 48,901 verdicted" would ellipsize to nothing
     * useful. It is not deleted — the tile's help states the same string, from the SAME
     * derivation the tile computes (`scaleAside`), so the two can never name different
     * denominators for one numeral. This case therefore reads the help, and asserts on the
     * face only that no share was left there to go stale.
     */
    // Total Critical + Resolved / Closed are both shares of the SAME `case_count` (4),
    // and both come off the one posture payload, so numerator and denominator always
    // describe the same population.
    expect(await readTileHelp('Total Critical')).toContain('Right now: 25% of 4.');
    expect(await readTileHelp('Resolved / Closed')).toContain('Right now: 25% of 4.');
    expect(within(screen.getByTestId('kpi-total-critical')).queryByText(/% of/)).toBeNull();
    expect(within(screen.getByTestId('kpi-resolved-closed')).queryByText(/% of/)).toBeNull();
    // Total Cases IS that denominator, so it carries no share of its own — and no em
    // dash either, which would read as "a denominator we could not measure". With no
    // context to state, the help says so in words and appends no "Right now" aside: an
    // aside reading "Right now: —." is not a disclosure.
    const totalCases = within(screen.getByTestId('kpi-total-cases'));
    expect(totalCases.queryByText(/% of/)).toBeNull();
    expect(totalCases.queryByText('—')).toBeNull();
    const totalCasesHelp = await readTileHelp('Total Cases');
    expect(totalCasesHelp).toContain('this is the denominator the cohort tiles beside it are shares of');
    expect(totalCasesHelp).not.toContain('Right now:');
    // Open Cases is a window-EXEMPT stock: no window population reconciles with it, so it
    // claims no share at all and NAMES why, rather than inventing one.
    const openCases = within(screen.getByTestId('kpi-open-cases'));
    await waitFor(() => expect(openCases.getByText('5')).toBeInTheDocument());
    expect(openCases.queryByText(/% of/)).toBeNull();
    const openCasesHelp = await readTileHelp('Open Cases');
    expect(openCasesHelp).toContain('Open now, and not window-filtered.');
    expect(openCasesHelp).toContain('this one has no window denominator');
    expect(openCasesHelp).not.toContain('Right now:');
    // FP rate is ALREADY a percent, so its context is the sample size behind it.
    expect(await readTileHelp('False Positive Rate')).toContain('Right now: 1 of 2 verdicted.');
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).queryByText('1 of 2 verdicted'),
    ).toBeNull();
  });

  it('relocates every strip caption into the tile help — verbatim, never deleted', async () => {
    // The counterpart to the negatives in the micro-strip case above. Each caption that
    // came off the face is read back HERE, in the surface it moved to, so "relocated" is a
    // proven statement rather than a comment beside a deletion. The help popover is
    // reachable by click, Enter, Space AND tap (`alwaysPopover`), which is the whole reason
    // a caption was allowed to move into it at all.
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    expect(await readTileHelp('Total Cases')).toContain(
      'Window arrivals, policy-closed included.',
    );
    // The band NAME, still derived from the severity ladder rather than written out —
    // `overview.topband.test.tsx` moves the ladder's top entry and reads this same string
    // back as "The High band." to prove the derivation survived the move.
    expect(await readTileHelp('Total Critical')).toContain('The Critical band.');
    expect(await readTileHelp('Open Cases')).toContain('Open now, and not window-filtered.');
  });

  it('states the sixth tile’s CONTAINMENT wherever a reader can arrive at it', async () => {
    // Auto Closed is the one tile on this strip that is not an independent total, and the
    // row must never read as a set that SUMS. Adjacency and the shared `success` accent
    // (asserted in the micro-strip case) are the visual half; this is the half that says
    // it in words, and it must say it in EVERY surface a reader can reach — the help they
    // open on the tile, and the population sentence of the panel they drill into. One
    // constant feeds both in `Overview`, and asserting both is what keeps it that way.
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-auto-closed')).toBeInTheDocument());

    const CONTAINMENT = 'A SUBSET of Resolved / Closed, not a sixth independent total.';
    const EXCLUSION =
      'Counted over the agent-worked population only — cases an operator closed under a ' +
      '"declared benign" rule policy are excluded';

    const help = await readTileHelp('Auto Closed');
    expect(help).toContain(CONTAINMENT);
    expect(help).toContain(EXCLUSION);
    // Its share names its OWN denominator. "% of Resolved / Closed" would be false: this
    // numerator is counted over the policy-STRIPPED terminal set while that numeral is
    // policy-INCLUSIVE, which is the cross-population defect the tile exists not to repeat.
    expect(help).toContain('Right now: 50% of agent-worked closes.');

    await openDrilldown('kpi-auto-closed');
    const panel = screen.getByTestId('kpi-drilldown');
    expect(panel).toHaveTextContent(CONTAINMENT);
    expect(panel).toHaveTextContent(EXCLUSION);
  });

  const STRIP_IDS = [
    'kpi-total-cases',
    'kpi-total-critical',
    'kpi-open-cases',
    'kpi-false-positive-rate',
    'kpi-resolved-closed',
    // Auto Closed is posture-fed like the rest — `quality.auto_closed_cases` is REQUIRED
    // on the wire — so it inherits every arm below: the em dash on a failed rollup, the
    // "not measured" wording on an unreadable store, and the no-delta-chip rule.
    'kpi-auto-closed',
  ] as const;

  it('renders an em dash — never 0% — on every tile when the posture rollup is missing', async () => {
    // Every tile on the strip is posture-fed now, so a failed rollup means NOTHING on
    // it was measured. Each must say so, and none may substitute a client count off
    // the bounded case page — a 200-row cap is not the window population.
    const capped: Case[] = Array.from({ length: 200 }, (_, i) => ({
      case_id: `cap-${i}`,
      status: i % 2 === 0 ? 'open' : 'closed',
      risk_score: 90,
    })) as unknown as Case[];
    listCasesMock.mockResolvedValue({ cases: capped, total: 4000, window_total_exact: true });
    fetchPostureMock.mockRejectedValue(new Error('posture unavailable'));
    getMetricsMock.mockResolvedValue({ ...METRICS, total_cases: 0, needs_human_cases: undefined });

    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    for (const id of STRIP_IDS) {
      const tile = within(screen.getByTestId(id));
      // (The FP-rate tile shows an em dash TWICE — its unmeasurable rate and its
      // unmeasurable sample size — hence the All-variant.)
      await waitFor(() => expect(tile.getAllByText('—').length).toBeGreaterThan(0));
      expect(tile.queryByText(/0% of/)).toBeNull();
      expect(tile.queryByText(/0 of /)).toBeNull();
      // The absence is NAMED, so it reads as evidence rather than an omission — and
      // the 100 open rows in the page below are never quoted as the open count.
      expect(tile.getByText('Posture unavailable')).toBeInTheDocument();
      expect(tile.queryByText('100')).toBeNull();
    }
  });

  it('keeps the COUNTS but withholds every share when the window was not fully covered', async () => {
    // `window_covered: false` says rows that could satisfy the selected window were
    // never read, so every band is a floor. A floor is still a number an operator can
    // act on, so the counts stay and only the shares go dark — with the bound named.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      truncated: true,
      store_total: 40_000,
      fetched: 5_000,
      window_covered: false,
      window_coverage_reason:
        'the fetch was truncated and the selected window starts before the oldest fetched case',
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');

    /*
     * The bound sentence is still `getByText`-able, but it is no longer a CAPTION — it is
     * the accessible half of a marker ON the numeral, and the two are asserted TOGETHER
     * throughout this arm. On its own the text would go on passing off any caption that
     * happened to carry the same words, which is exactly the surface this change removed;
     * the `data-bound` attribute is what pins it to the number it qualifies.
     */
    const totalCasesTile = await screen.findByTestId('kpi-total-cases');
    const totalCases = within(totalCasesTile);
    await waitFor(() => expect(totalCases.getByText('4')).toBeInTheDocument());
    expect(totalCases.getByText('Partial window · lower bound')).toBeInTheDocument();
    // FLOOR: there IS a number, so the mark is a `≥` immediately before it.
    expect(totalCasesTile.querySelector('[data-bound="floor"]')).not.toBeNull();
    expect(totalCases.getByTestId('kpi-total-cases-bound')).toHaveTextContent('≥');

    const criticalTile = screen.getByTestId('kpi-total-critical');
    const critical = within(criticalTile);
    expect(critical.getByText('1')).toBeInTheDocument();
    // The share itself is withheld — and with the scale context off the face there is no
    // em-dash slot left to withhold it IN, so the absence is asserted as an absence and
    // the marker below is what says why.
    expect(critical.queryByText(/% of/)).toBeNull();
    expect(critical.getByText('Bounded sample · share unavailable')).toBeInTheDocument();
    expect(criticalTile.querySelector('[data-bound="floor"]')).not.toBeNull();
    expect(critical.getByTestId('kpi-total-critical-bound')).toHaveTextContent('≥');

    // The FP RATE is itself a share of a bounded denominator, so the rate AND the
    // sample size behind it are both withheld. It therefore takes the WITHHELD arm of the
    // grammar rather than a floor: no `≥`, because there is no number to qualify — the em
    // dash itself carries the mark.
    const fpTile = screen.getByTestId('kpi-false-positive-rate');
    const fp = within(fpTile);
    expect(fp.queryByText('50%')).toBeNull();
    expect(fp.queryByText('1 of 2 verdicted')).toBeNull();
    expect(fp.getAllByText('—').length).toBeGreaterThan(0);
    expect(fpTile.querySelector('[data-bound="withheld"]')).not.toBeNull();
    expect(fp.queryByTestId('kpi-false-positive-rate-bound')).toBeNull();
    expect(fp.getByText('Bounded sample · share unavailable')).toBeInTheDocument();

    const resolvedTile = screen.getByTestId('kpi-resolved-closed');
    const resolved = within(resolvedTile);
    expect(resolved.getByText('1')).toBeInTheDocument();
    expect(resolved.queryByText(/% of/)).toBeNull();
    expect(resolvedTile.querySelector('[data-bound="floor"]')).not.toBeNull();

    // …and the subset tile beside it is bounded on the same evidence. A tile that inherits
    // its neighbour's accent must also inherit its neighbour's caveats.
    const autoClosedTile = screen.getByTestId('kpi-auto-closed');
    expect(within(autoClosedTile).getByText('1')).toBeInTheDocument();
    expect(within(autoClosedTile).queryByText(/% of agent-worked/)).toBeNull();
    expect(autoClosedTile.querySelector('[data-bound="floor"]')).not.toBeNull();
    expect(within(autoClosedTile).getByText('Bounded sample · share unavailable')).toBeInTheDocument();
  });

  it('publishes the shares when window_covered rescues a truncated fetch', async () => {
    // The regression this replaces: gating on `truncated` alone. Any store above the
    // route's fetch bound is truncated permanently, so the strip went dark forever
    // even when the operator asked for a window that WAS read end to end.
    // `window_covered` is the narrower, checkable claim, and it must win.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      truncated: true,
      store_total: 40_000,
      fetched: 5_000,
      window_covered: true,
      window_coverage_reason: '',
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const criticalTile = await screen.findByTestId('kpi-total-critical');
    const critical = within(criticalTile);
    await waitFor(() => expect(critical.getByText('1')).toBeInTheDocument());
    // The share is published — in the tile's help, which is where the scale context lives
    // now (see "pairs every KPI numeral…"). Reaching it proves the covered window really
    // did release the share, which a pair of absent captions on the face could not.
    expect(await readTileHelp('Total Critical')).toContain('Right now: 25% of 4.');
    // …and the UNBOUNDED arm of the bound grammar: no sentence, and no marker EITHER. The
    // sentence alone would keep passing if the mark were left on the numeral with an empty
    // string, so both halves are counted out.
    expect(critical.queryByText('Bounded sample · share unavailable')).toBeNull();
    expect(criticalTile.querySelector('[data-bound]')).toBeNull();
    expect(critical.queryByTestId('kpi-total-critical-bound')).toBeNull();
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).getByText('50%'),
    ).toBeInTheDocument();
    for (const id of STRIP_IDS) {
      expect(screen.getByTestId(id).querySelector('[data-bound]')).toBeNull();
    }
  });

  it('falls back to the truncation flag when the server predates window_covered', async () => {
    // An older backend emits `truncated` and no coverage flag. The absence of the
    // narrower claim is not permission to publish: the old rule still applies.
    const { window_covered: _covered, ...legacy } = POSTURE;
    fetchPostureMock.mockResolvedValue({ ...legacy, truncated: true, store_total: 999 });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const criticalTile = await screen.findByTestId('kpi-total-critical');
    const critical = within(criticalTile);
    await waitFor(() =>
      expect(critical.getByText('Bounded sample · share unavailable')).toBeInTheDocument(),
    );
    // The sentence AND the mark it belongs to — see the note in "keeps the COUNTS…" for
    // why the text alone is not enough to pin a marker that lives on the numeral.
    expect(criticalTile.querySelector('[data-bound="floor"]')).not.toBeNull();
    expect(critical.queryByText(/% of/)).toBeNull();
  });

  it('never borrows the all-time /api/metrics fetch cap as a strip denominator', async () => {
    // Regression: `GET /api/metrics` is NOT window-filtered and is hard-capped at the
    // newest 2,000 cases with NO truncation marker, so `total_cases` is a fetch bound.
    // The strip used to divide `needs_human_cases` by it and print "7% of 2,000"
    // beside a TimeRangePicker set to (say) the last hour — a cap dressed as a
    // population. No tile reads that payload at all now; this pins that it stays so.
    getMetricsMock.mockResolvedValue({
      ...METRICS,
      total_cases: 2000,
      needs_human_cases: 137,
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const strip = within(await screen.findByTestId('kpi-strip'));
    await waitFor(() =>
      expect(within(screen.getByTestId('kpi-total-cases')).getByText('4')).toBeInTheDocument(),
    );
    expect(strip.queryByText(/of 2,000/)).toBeNull();
    expect(strip.queryByText('137')).toBeNull();
  });

  it('renders "<1%" — never a rounded-down 0% — for a real but tiny band', async () => {
    // Regression: `shareContext` rounded 1/5,000 to "0% of 5,000" beside a non-zero
    // numeral, which reads as "nothing is critical" when one case is. The
    // Noise-Reduction funnel already floors at "<1%"; the strip shares that rule.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 5000,
      severity_counts: { critical: 1, high: 0, medium: 0, low: 4999, info: 0 },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = within(await screen.findByTestId('kpi-total-critical'));
    await waitFor(() => expect(tile.getByText('1')).toBeInTheDocument());
    // Read from the tile's help, which is where the scale context moved — the FLOOR RULE
    // travelled with the string it applies to, so this is where it has to be proven now.
    const help = await readTileHelp('Total Critical');
    expect(help).toContain('Right now: <1% of 5,000.');
    expect(help).not.toContain('0% of 5,000');
    // A genuine zero still reads "0%" — the floor applies only to a non-zero count.
    expect(help).not.toMatch(/Right now: 0%/);
  });

  it('states the close partition in the Resolved / Closed DRILL-DOWN as three rows, never two', async () => {
    // `engine/metrics.py` forbids `human = terminal - auto_closed`: that difference
    // absorbs the SYSTEM/legacy residual into the analyst band. The partition therefore
    // renders all three server keys, and the residual stays visible.
    fetchPostureMock.mockResolvedValue({ ...POSTURE, quality: QUALITY_ATTRIBUTED });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('9')).toBeInTheDocument());

    // The tile FACE carries no partition at all any more — three or four rows the other
    // four tiles do not have, so it set the height of the whole strip. Nothing on the
    // strip states a band either (the instrument card below legitimately does).
    expect(tile.querySelector('dl')).toBeNull();
    expect(screen.queryByTestId('kpi-resolved-closed-breakdown')).toBeNull();
    expect(within(screen.getByTestId('kpi-strip')).queryByText('AI agent')).toBeNull();

    // The SAME partition is stated by the instrument card below, from the same memo, so
    // the two surfaces cannot disagree.
    const card = within(screen.getByTestId('human-vs-ai'));
    expect(within(card.getByTestId('human-vs-ai-human')).getByText('3')).toBeInTheDocument();
    expect(within(card.getByTestId('human-vs-ai-system')).getByText('1')).toBeInTheDocument();

    // …and in full, with its band values, one level down — directly under the numeral it
    // partitions.
    await openDrilldown('kpi-resolved-closed');
    expect(drilldownBands()).toEqual({
      labels: ['AI agent', 'Human', 'System'],
      values: ['5', '3', '1'],
    });
    // The `toEqual` above IS the reconciliation guard: 5 + 3 + 1 === 9, the numeral the
    // panel partitions, so the "Human" row can never be the 4 that `terminal − auto` would
    // have printed. A separate `queryByText('4')` used to sit here; against an exact
    // band-by-band comparison it could not fail, so it is gone rather than kept as
    // decoration.
  });

  it('counts a POLICY-CLOSED case in Resolved / Closed, and names it in the partition', async () => {
    // `quality_metrics` strips operator "declared benign" closes before it counts
    // anything, so `terminal_cases` is a policy-EXCLUSIVE number while `case_count`,
    // this tile's drill-down `match` (CLOSED_STATUSES) and its `__terminal__` deep link
    // are all policy-INCLUSIVE. Dividing one by the other put the numeral and its own
    // denominator on two different populations, and the panel listed rows the numeral
    // did not count. The tile therefore reports terminal + policy-closed.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 10,
      quality: {
        ...QUALITY_ATTRIBUTED,
        total_cases: 5,
        terminal_cases: 5,
        auto_closed_cases: 3,
        human_closed_cases: 1,
        system_closed_cases: 1,
        policy_closed_cases: 5,
      },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    // 5 agent-worked terminal + 5 declared benign === 10 of 10 arrivals.
    await waitFor(() => expect(within(tile).getByText('10')).toBeInTheDocument());
    const help = await readTileHelp('Resolved / Closed');
    expect(help).toContain('Right now: 100% of 10.');
    expect(help).not.toContain('50% of 10');

    // …and the tile's help NAMES the policy closes, because this numeral is
    // policy-INCLUSIVE while the Human-vs-AI card below it publishes bands over the
    // policy-EXCLUSIVE `terminal_cases`. Without this sentence the page states 10 here and
    // three bands summing to 5 there, with nothing bridging them — the partition's
    // `Declared benign` row used to be that bridge and now lives one level down. It is
    // still CONDITIONAL: it appears only where the server reports a gap to explain, which
    // the sibling case below pins by its absence.
    expect(help).toContain('This window includes 5 declared benign.');
    // Nothing about the reconciliation was left on the face to go stale beside it.
    expect(within(tile).queryByText(/declared benign/i)).toBeNull();

    // The partition still sums to the numeral above it — now with a fourth band. It is
    // the drill-down that states it; the tile face carries none.
    await openDrilldown('kpi-resolved-closed');
    expect(drilldownBands()).toEqual({
      labels: ['AI agent', 'Human', 'System', 'Declared benign'],
      values: ['3', '1', '1', '5'],
    });
  });

  it('omits the declared-benign band when the backend does not report it', async () => {
    // A backend that omits `policy_closed_cases` is one that never stripped them (the
    // exclusion and the field shipped together), so its `terminal_cases` already counts
    // them and there is no fourth band to state.
    fetchPostureMock.mockResolvedValue({ ...POSTURE, quality: QUALITY_ATTRIBUTED });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('9')).toBeInTheDocument());
    // No band to state, and therefore no gap between this numeral and the card's
    // denominator — so the reconciling sentence stays out of the help as well as off the
    // face. A conditional disclosure that shows when it is false is noise, not honesty.
    expect(within(tile).queryByText(/declared benign/i)).toBeNull();
    expect(await readTileHelp('Resolved / Closed')).not.toContain('This window includes');
    await openDrilldown('kpi-resolved-closed');
    expect(drilldownBands()?.labels).toEqual(['AI agent', 'Human', 'System']);
  });

  it('renders an unreadable case store as NOT MEASURED, never as four zeros', async () => {
    // `routes_metrics` soft-fails an unreadable case store and STILL answers HTTP 200,
    // so neither the loading nor the error arm fires. `posture_metrics(load_ok=False)`
    // then returns structural zeros: case_count 0, every band 0, terminal 0, open_now 0.
    // Published unqualified they read as a quiet, healthy, empty SOC — and the
    // "partial window · lower bound" caption would call those zeros a floor of a real
    // population. The discriminator is exact: `truncated !== true && !window_covered`
    // is reachable only through the outage arm.
    const REASON =
      'the case store could not be read, so this population was not measured; ' +
      'the figures shown are not a count of anything';
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 0,
      severity_counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      open_now: {
        count: 0,
        window_exempt: true,
        as_of: '2026-07-01T08:00:00Z',
        complete: false,
        reason: REASON,
      },
      truncated: false,
      window_covered: false,
      window_coverage_reason: REASON,
      quality: { ...QUALITY, total_cases: 0, verdicted_cases: 0, terminal_cases: 0 },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const strip = await screen.findByTestId('kpi-strip');
    await waitFor(() => expect(screen.getByTestId('kpi-total-cases')).toBeInTheDocument());

    for (const id of STRIP_IDS) {
      const tile = within(screen.getByTestId(id));
      await waitFor(() => expect(tile.getAllByText('—').length).toBeGreaterThan(0));
      expect(tile.queryByText('0'), `${id} published a zero it never measured`).toBeNull();
      expect(tile.queryByText('0%')).toBeNull();
    }
    // No tile may caption its blank as a lower bound of anything.
    expect(within(strip).queryByText(/lower bound/)).toBeNull();
    // …and the bound MARKER is absent with the sentence. This is the outage arm's own
    // guard on the marker grammar: `boundSub` returns undefined whenever `postureSub` is
    // set, so a window that measured nothing has no floor to state and its structural
    // zeros are never dressed as one. Asserting only the sentence would leave a mark that
    // said "≥ —" passing.
    expect(strip.querySelector('[data-bound]')).toBeNull();
    for (const id of STRIP_IDS) {
      expect(screen.getByTestId(id).querySelector('[data-bound]')).toBeNull();
      expect(within(screen.getByTestId(id)).queryByTestId(`${id}-bound`)).toBeNull();
    }
    // Every posture-fed tile states the server's OWN account of the gap.
    expect(within(strip).getAllByText(REASON).length).toBe(6);
    // …and the close partition is withheld with them, on BOTH surfaces that read it:
    // 0 + 0 + 0 === 0 passes the reconciliation guard, so an outage would otherwise
    // publish a three-band partition of a window nothing was read from. The partition
    // now lives in the tile's DRILL-DOWN, so the withholding is asserted THERE — the
    // strip anchor is gone, and a `queryByTestId` on it could no longer fail.
    const card = within(screen.getByTestId('human-vs-ai'));
    expect(within(card.getByTestId('human-vs-ai-ai')).queryByText('0')).toBeNull();
    expect(within(card.getByTestId('human-vs-ai-human')).queryByText('0')).toBeNull();
    expect(within(card.getByTestId('human-vs-ai-system')).queryByText('0')).toBeNull();
    expect(screen.getByTestId('human-vs-ai')).toHaveTextContent(REASON);
    await openDrilldown('kpi-resolved-closed');
    expect(drilldownBands()).toBeNull();
  });

  it('renders NO close breakdown when the server reports only part of the partition', async () => {
    // Two of three keys is not a partition. Rendering the two it has would fold the
    // residual into whichever band the reader assumes — the exact over-statement.
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      quality: { ...QUALITY_ATTRIBUTED, system_closed_cases: undefined },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('9')).toBeInTheDocument());
    // `tile.querySelector('dl')` alone would NOT catch a face partition — KpiTile renders
    // it as a SIBLING of the button — so the anchor check beside it is the live guard.
    expect(tile.querySelector('dl')).toBeNull();
    expect(screen.queryByTestId('kpi-resolved-closed-breakdown')).toBeNull();
    // Scoped to the strip: the instrument card below legitimately names the same band.
    expect(within(screen.getByTestId('kpi-strip')).queryByText('AI agent')).toBeNull();
    // …and the drill-down, which is where a partition WOULD be stated, states none.
    await openDrilldown('kpi-resolved-closed');
    expect(drilldownBands()).toBeNull();
    expect(within(screen.getByTestId('kpi-drilldown')).queryByText('AI agent')).toBeNull();
  });

  it('keeps a ZERO residual visible in the close breakdown', async () => {
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      quality: {
        ...QUALITY,
        terminal_cases: 8,
        auto_closed_cases: 6,
        human_closed_cases: 2,
        system_closed_cases: 0,
      },
    });
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-resolved-closed');
    await waitFor(() => expect(within(tile).getByText('8')).toBeInTheDocument());
    // Folding a zero band away would leave a two-row split that reads as the whole
    // story; the row stays, showing 0.
    await openDrilldown('kpi-resolved-closed');
    expect(drilldownBands()).toEqual({
      labels: ['AI agent', 'Human', 'System'],
      values: ['6', '2', '0'],
    });
  });

  it('captions a FIRST load, and never a refresh that still has a measurement on screen', async () => {
    /*
     * The two arms of the loading disclosure, in one case, because they are one decision:
     * `postureLoading && !posture`.
     *
     * A caption is worth the strip's height only when it says the numeral above it cannot
     * be trusted yet. On a FIRST load there is no numeral — an em dash and "Loading 1 day"
     * is the whole of what the page honestly knows. On a REFRESH the numerals are a real
     * measurement, and this page defaults to a LIVE refresh, so captioning them "Loading"
     * would both say something false about them and (now that it is the only sub a tile
     * carries) grow and shrink the entire strip on every tick.
     */
    const requests: Array<(value: PostureResponse) => void> = [];
    fetchPostureMock.mockImplementation(
      () => new Promise<PostureResponse>((resolve) => requests.push(resolve)),
    );
    const user = userEvent.setup();
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    await waitFor(() => expect(requests).toHaveLength(1));

    // FIRST LOAD — nothing measured is on screen, so every posture-fed tile names what it
    // is waiting for and shows an em dash rather than an unqualified blank.
    for (const id of STRIP_IDS) {
      const tile = within(await screen.findByTestId(id));
      expect(tile.getByText('Loading 1 day')).toBeInTheDocument();
      expect(tile.getAllByText('—').length).toBeGreaterThan(0);
    }
    // …and never as a lower bound: a window that has measured nothing has no floor to
    // state, so `boundSub` stays silent for exactly as long as `postureSub` speaks.
    expect(screen.getByTestId('kpi-strip').querySelector('[data-bound]')).toBeNull();

    // The measurement lands and the caption goes with it.
    requests[0](POSTURE);
    await waitFor(() =>
      expect(within(screen.getByTestId('kpi-total-cases')).getByText('4')).toBeInTheDocument(),
    );
    for (const id of STRIP_IDS) {
      expect(within(screen.getByTestId(id)).queryByText('Loading 1 day')).toBeNull();
    }

    // REFRESH — a second request is in flight with the previous rollup still rendered. The
    // numerals stay, and NO tile is re-captioned.
    await user.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(within(screen.getByTestId('kpi-total-cases')).getByText('4')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-open-cases')).getByText('5')).toBeInTheDocument();
    for (const id of STRIP_IDS) {
      expect(within(screen.getByTestId(id)).queryByText('Loading 1 day')).toBeNull();
    }
  });

  it('keeps the last posture snapshot visible, UNCAPTIONED, across a window change, then swaps atomically', async () => {
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
      quality: { ...POSTURE_CMP.quality, false_positive_rate: 0.48, terminal_cases: 25 },
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('48%')).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId('kpi-resolved-closed')).getByText('25')).toBeInTheDocument();

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

    /*
     * STALE-WHILE-REVALIDATE: the previous snapshot's numbers stay mounted while 168h is
     * in flight — no perceived blanking.
     *
     * They are NOT captioned "Loading 7 days" any more, and that is the point of the
     * assertions below rather than an omission. This page defaults to a LIVE refresh, so
     * posture reloads on every tick with the previous rollup still on screen: captioning
     * those numerals "Loading" said something false about them — they are a measurement,
     * not a placeholder — and, now that the caption is the ONLY sub a tile carries, it also
     * grew and shrank the whole strip by ~18px on every tick, shoving the lattice below it.
     * The loading arm is therefore gated on there being nothing on screen to caption; the
     * FIRST-LOAD half of that gate is pinned by "captions a FIRST load…" below, so the two
     * arms are proven together and the caption cannot simply be deleted.
     *
     * The refresh control still shows LIVE and spins, which is the honest place for "a
     * request is in flight".
     */
    expect(screen.getByRole('button', { name: /Time range: Last 7 days/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-false-positive-rate')).getByText('48%')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-resolved-closed')).getByText('25')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kpi-false-positive-rate')).queryByText('Loading 7 days'),
    ).toBeNull();
    expect(
      within(screen.getByTestId('kpi-resolved-closed')).queryByText('Loading 7 days'),
    ).toBeNull();

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
        terminal_cases: 1355,
      },
      compare: {
        ...POSTURE_CMP.compare!,
        false_positive_rate: { value: 0.8307, prev: 0.8628, delta_pct: -3.7 },
      },
    });
    // The fresh 168h payload replaces the stale snapshot atomically...
    const timingRegion = screen.getByRole('region', { name: /Mean time to detect/i });
    await waitFor(() => expect(within(timingRegion).getByText('4h')).toBeInTheDocument());
    // ...and the swap leaves the tiles carrying no sub at all — a healthy window is the
    // one state the `sub` slot has nothing to say about, which is exactly what gives the
    // numeral its room. Every descriptive caption moved to the tile's help; only a
    // DEGRADATION (loading-with-nothing-to-show, an error, or the server's own
    // not-measured reason) may take this row now.
    for (const id of STRIP_IDS) {
      const tile = within(screen.getByTestId(id));
      expect(tile.queryByText('Loading 7 days')).toBeNull();
      expect(tile.queryByText('Loading 24h')).toBeNull();
      expect(tile.queryByText('Posture unavailable')).toBeNull();
    }
    // (The numerals themselves are NOT re-read here: they roll via the motion spring, so
    // the plain-text timing stat above is the reliable fresh-payload witness — which is why
    // this case has always used it.)
    // Queried from `screen`, not from within the tile: the mark is a SIBLING of the
    // trigger button (it sits in the cell's corner overlay), not a descendant of it.
    expect(screen.getByTestId('kpi-resolved-closed-affordance')).toBeInTheDocument();

    // Even if the aborted transport settles late, its 24h data remains discarded.
    requests[1].resolve({
      ...POSTURE_CMP,
      lifecycle: {
        ...POSTURE_CMP.lifecycle,
        mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 2, available: true, reason: '' },
      },
      quality: { ...POSTURE_CMP.quality, false_positive_rate: 0.49, terminal_cases: 25 },
    });
    await Promise.resolve();
    expect(within(timingRegion).getByText('4h')).toBeInTheDocument();
    expect(within(timingRegion).queryByText('45m')).toBeNull();
  });

  it('mounts the instrument band: Human vs AI + two donut snapshots + latest cases', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    const heroRow = await screen.findByTestId('hero-row');
    // The close-attribution instrument, exactly once, inside the hero row. The Active
    // Risk Index gauge it replaced is gone from the landing page entirely.
    expect(within(heroRow).getByTestId('human-vs-ai')).toBeInTheDocument();
    expect(screen.getAllByTestId('human-vs-ai')).toHaveLength(1);
    expect(screen.queryByTestId('active-risk-index')).toBeNull();
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
    // The ring is 112, not the 136 it was while the two cards sat SIDE BY SIDE across
    // eight columns. Stacked in four they cost twice their own height, so the ring pays
    // for the stack; the ~58px hole still clears the widest string the centre formatter
    // can emit ("1.2K"). Update these two tokens together with `fmtSnapshotCenter`'s
    // doc — never delete them.
    expect(resolvedRing).toHaveClass('w-28');
    expect(resolvedRing).toHaveStyle({ height: '112px' });
    expect(openRing).toHaveClass('w-28');
    expect(openRing).toHaveStyle({ height: '112px' });

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

  it('shows only the five newest cases and reveals richer case context on hover', async () => {
    // Five, not four: the snapshots stacking into four columns made row 2 taller, and a
    // fourth row left the queue cell visibly short of it. Five rows still measure under
    // the stacked snapshots, so the queue fills its cell without governing the row.
    const six: Case[] = Array.from({ length: 6 }, (_, i) => ({
      case_id: `latest-${i + 1}`,
      case_number: `#CS-${9001 + i}`,
      title: `Latest case ${i + 1}`,
      summary: i === 5 ? 'Rich hover-only investigation summary.' : `Summary ${i + 1}`,
      status: i === 5 ? 'investigating' : 'open',
      risk_score: 40 + i,
      created_at: `2026-07-01T0${i + 1}:00:00Z`,
      updated_at: `2026-07-01T0${i + 1}:30:00Z`,
      source_name: 'Demo SIEM',
      entity: { type: 'host', value: `host-${i + 1}` },
    })) as unknown as Case[];
    listCasesMock.mockResolvedValue({ cases: six, total: six.length });

    render(<Overview onNavigate={vi.fn()} />);
    const latest = await screen.findByRole('region', { name: /Latest cases/i });
    const caseRows = within(latest).getAllByRole('button', { name: /^Open case /i });
    expect(caseRows).toHaveLength(5);
    expect(within(latest).getByText('Latest case 6')).toBeInTheDocument();
    expect(within(latest).queryByText('Latest case 1')).toBeNull();

    await userEvent.hover(caseRows[0]);
    expect(await screen.findByText('Rich hover-only investigation summary.')).toBeInTheDocument();
    expect(screen.getByText('host-6')).toBeInTheDocument();
    expect(screen.getByText('Demo SIEM')).toBeInTheDocument();
  });

  it('abbreviates a 4+ digit SnapshotCard center total so it never clips the ~58px donut hole (#minor)', async () => {
    // 1,234 closed cases -> `derived.resolved` = 1234. At the pinned 112px donut
    // (innerPct=52%, overflow-hidden), the raw thousands-separated "1,234" (fmtInt)
    // risks crowding the ~58px hole. The center must instead show
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

    // The ring size is asserted HERE too, not only in the mount test: this case's whole
    // premise is "the hole is ~58px", and a hole is 0.52 × the ring. Without this line the
    // title's number could go stale against a resized ring and nothing here would notice.
    expect(resolvedRing).toHaveStyle({ height: '112px' });

    // The center count-up shows the ABBREVIATED form, never the raw grouped digits.
    expect(within(resolvedRing).getByText('1.2K')).toBeInTheDocument();
    expect(within(resolvedRing).queryByText('1,234')).toBeNull();
    expect(within(resolvedRing).getAllByTestId('count-up')[0]).toHaveClass('text-2xl');

    // The legend row keeps the exact, unabbreviated count for the (sole) severity band.
    const legendRow = screen.getByText('Low', { exact: true }).closest('li')!;
    expect(within(legendRow).getByText('1,234')).toBeInTheDocument();
  });

  it('orders the detect/respond pair ahead of the live queue', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');

    // The Cases-burndown chart is deliberately NOT here any more: opened-vs-resolved
    // backlog moved to Metrics → Posture ("Closure vs arrival"), where it sits beside
    // the aging series it is read against. Only these two regions remain, and the
    // presence loop this replaced could never have caught them swapping — so assert
    // the ORDER, which is the actual contract.
    //
    // The pair used to be a full-width row BELOW the queue. It is now the MIDDLE cell of
    // row 2 (snapshots · timing · queue), so it reads before the queue. DOM order still
    // equals visual order — the cells are laid out left to right by the grid, with no
    // `order-*` utility anywhere — so this is a reading-order change, not a WCAG 1.3.2
    // regression, and it must never be "fixed" with `xl:order-*`.
    const queue = screen.getByRole('region', { name: /Latest cases/i });
    const timing = screen.getByRole('region', { name: /Mean time to detect \/ respond/i });

    expect(screen.queryByRole('region', { name: /Cases burndown/i })).toBeNull();
    expect(timing.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    for (const id of STRIP_IDS) {
      // The scale-context slot beside each numeral — and the in-tile close-attribution
      // <dl> — are PLAIN text on purpose: neither may re-introduce the delta chip's
      // role="img" or judgement colour.
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

  /** Open a tile's drill-down and hand back its drill-through button. */
  async function openDrillThrough(testId: string): Promise<HTMLElement> {
    await userEvent.click(await screen.findByTestId(testId));
    await screen.findByTestId('kpi-drilldown');
    return screen.getByTestId('kpi-drilldown-drillthrough');
  }

  it('drills Open Cases through to every non-terminal status and carries NO window', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    // The tile itself now DISCLOSES rather than navigates — the operator keeps the
    // other four numerals in view while they read the detail.
    await userEvent.click(await screen.findByTestId('kpi-open-cases'));
    expect(onNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('kpi-drilldown-drillthrough'));
    // The tile is a window-EXEMPT stock, so the list it opens must be too: passing the
    // dashboard window would hand the operator a SHORTER list than the number they
    // just clicked. Cases defaults to the all-time horizon when no window is given.
    expect(onNavigate).toHaveBeenCalledWith('cases', { status: '__active__' });
    expect(onNavigate.mock.calls[0][1]).not.toHaveProperty('window');
  });

  it('drills Total Cases through to the whole window cohort, with NO status facet', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const cta = await openDrillThrough('kpi-total-cases');
    expect(onNavigate).not.toHaveBeenCalled();
    await userEvent.click(cta);
    // No status facet at all: the list must show the same undivided cohort the tile
    // counts, so the Cases page's default active filter is deliberately dropped.
    expect(onNavigate).toHaveBeenCalledWith('cases', { window: expect.any(Number) });
    expect(onNavigate.mock.calls[0][1]).not.toHaveProperty('status');
  });

  it('drills Resolved / Closed through to the __terminal__ facet, never one status', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const cta = await openDrillThrough('kpi-resolved-closed');
    await userEvent.click(cta);
    // Terminal is TWO statuses (closed + resolved) and the Cases status filter applies
    // exactly one, so a `status: 'closed'` link would silently drop every resolved
    // case from a tile that counts both. The virtual facet is the only honest target.
    expect(onNavigate).toHaveBeenCalledWith('cases', {
      status: '__terminal__',
      window: expect.any(Number),
    });
    expect(onNavigate).not.toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ status: 'closed' }),
    );
  });

  it('deep-links the snapshot CTAs to the resolved / open case lists', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    await userEvent.click(await screen.findByRole('button', { name: /View resolved cases/i }));
    // The card's total counts BOTH terminal statuses (`CLOSED_STATUSES`), so its deep
    // link has to hand the same set to the list. `status: 'closed'` applied exactly one
    // of the two and silently dropped every RESOLVED case — a card reading 1 landing on
    // an empty list, the same defect the KPI tile's `__terminal__` facet was added for.
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ status: '__terminal__', window: expect.any(Number) }),
    );
    expect(onNavigate).not.toHaveBeenCalledWith(
      'cases',
      expect.objectContaining({ status: 'closed' }),
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

  it('drills the Critical KPI through to the severity-filtered case list', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const cta = await openDrillThrough('kpi-total-critical');
    await userEvent.click(cta);
    // The Cases page applies exactly ONE severity band. Now that the tile IS one
    // band, the drill-through can carry it truthfully (the retired Critical-OR-High
    // union deliberately could not).
    expect(onNavigate).toHaveBeenCalledWith('cases', {
      severity: 'critical',
      window: expect.any(Number),
    });
  });

  it('takes Total Critical from the SERVER band tally, never from the bounded page', async () => {
    // The regression this pins: the tile used to count the Critical band over whatever
    // page `listCases` happened to return, which silently reported a sample as a
    // total. The page and the server are deliberately made to DISAGREE here — 2 rows
    // band Critical, the server says 37 — and the tile must show the server's number.
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
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      case_count: 120,
      severity_counts: { critical: 37, high: 40, medium: 30, low: 13, info: 0 },
    });

    render(<Overview onNavigate={vi.fn()} />);
    const tile = await screen.findByTestId('kpi-total-critical');

    await waitFor(() => expect(within(tile).getByText('37')).toBeInTheDocument());
    expect(within(tile).queryByText('2')).toBeNull();
    // …and the share is of the server's own `case_count`, the population the tally
    // partitions — never "of 5", the page it was rendered beside. It is stated in the
    // tile's help now rather than beside the numeral, and it is the SAME derivation the
    // tile computes, so this still catches a share silently re-based on the case page.
    const help = await readTileHelp('Total Critical');
    expect(help).toContain('Right now: 31% of 120.');
    expect(help).not.toMatch(/of 5\./);

    // The severity DONUTS keep describing the page they are drawn from — a per-band
    // split of the rows this dashboard holds — which is a different, honest job.
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
  // CRITICAL (it read HIGH under the old 80-cut). Locked via the severity DONUT: the
  // KPI tile now reads the server tally, so the donut is where this client-side
  // projection still shows.
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
    // 88 + 76 BOTH band Critical → the Open snapshot's severity row reports 2
    // Critical. Under the old 80-cut, that row would report only 1.
    const openSnapshot = await screen.findByRole('button', { name: 'View open cases' });
    await waitFor(() =>
      expect(within(openSnapshot).getByText('Critical')).toBeInTheDocument(),
    );
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
    // s1 buckets Critical (via severity_band, NOT its risk_score 20 which is Low); s2
    // is High and is excluded.
    const openSnapshot = await screen.findByRole('button', { name: 'View open cases' });
    await waitFor(() =>
      expect(within(openSnapshot).getByText('Critical')).toBeInTheDocument(),
    );
    const criticalRow = within(openSnapshot).getByText('Critical').closest('li');
    expect(criticalRow).not.toBeNull();
    expect(within(criticalRow as HTMLElement).getByText('1')).toBeInTheDocument();
  });

  it('folds the secondary bands (connectors, volume, full timing) into Deeper analytics', async () => {
    render(<Overview onNavigate={vi.fn()} />);
    await screen.findByTestId('page-hero');
    // Folded away by default.
    expect(screen.queryByRole('region', { name: /Ingest coverage/i })).toBeNull();
    // The duplicate "Autonomous vs human" fold-out is GONE: the landing page states
    // close attribution once, in the Human-vs-AI instrument, and that instrument still
    // carries the #3 advisory the removed card used to — now in its (?) rather than as a
    // second copy of the help text on the card face. Radix portals the popover to
    // <body> and unmounts it while closed, so what is asserted here is the always-present
    // TRIGGER; the string itself is pinned against the exported constant in
    // overview.humanvsai.test.tsx, and its reachability by click/Enter/Space is proved
    // against the real component in HumanVsAiCard's own suite.
    expect(screen.queryByRole('region', { name: /Autonomous vs human/i })).toBeNull();
    expect(
      within(screen.getByTestId('human-vs-ai')).getByRole('button', {
        name: /About Human vs AI attribution/i,
      }),
    ).toBeInTheDocument();
    // Expand.
    const deeper = await screen.findByRole('button', { name: /Deeper analytics/i });
    await userEvent.click(deeper);
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Ingest coverage/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: /Autonomous vs human/i })).toBeNull();
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
