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
 * It ALSO owns the KPI drill-down disclosure's accessibility contract, because that is
 * where the landing page's only non-trivial interaction semantics live: the tile is a
 * WAI disclosure trigger (`aria-expanded` + `aria-controls`, both optional on `KpiTile`
 * so no other consumer changes), the panel is a labelled `<section>` with NO
 * `role="dialog"` and NO `aria-modal`, focus lands on the panel HEADING, Tab leaves
 * freely without closing, and Escape closes and returns focus to the tile. axe runs
 * with the panel OPEN — a clean run with it closed would prove nothing about it.
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
    // The complete three-way partition, so the Resolved / Closed tile's in-place
    // breakdown <dl> is part of what axe inspects.
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

  describe('KPI drill-down disclosure', () => {
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

    it('has no axe violations with the panel OPEN, and is a disclosure not a dialog', async () => {
      const { container, tile } = await mountStrip();
      // Closed: the trigger states its collapsed state and controls NOTHING — a
      // dangling `aria-controls` id is itself an invalid attribute value.
      expect(tile).toHaveAttribute('aria-expanded', 'false');
      expect(tile).not.toHaveAttribute('aria-controls');

      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-rows')).toBeInTheDocument());

      expect(tile).toHaveAttribute('aria-expanded', 'true');
      expect(tile.getAttribute('aria-controls')).toBe(panel.id);
      // The whole point of the primitive: read ALONGSIDE the tiles, so no dialog role,
      // no modal flag, and nothing inerted behind it.
      expect(panel.tagName).toBe('SECTION');
      expect(panel).not.toHaveAttribute('role');
      expect(panel).not.toHaveAttribute('aria-modal');
      expect(panel.getAttribute('aria-labelledby')).toBe(
        screen.getByTestId('kpi-drilldown-heading').id,
      );
      expect(container.querySelector('[inert]')).toBeNull();

      // axe with the panel OPEN — the closed-strip pass above proves nothing about it.
      expect(await axe(container)).toHaveNoViolations();
      // Still exactly one h1: the panel heading is an h2 under the hero.
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(screen.getByTestId('kpi-drilldown-heading').tagName).toBe('H2');
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
      expect(heading).not.toHaveAttribute('role', 'dialog');
    });

    it('lets Tab leave the panel without closing it', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      // The budget is DERIVED from the stops this fixture actually produces, never a
      // literal. A literal is worse than wrong here: the day a control is added, the walk
      // simply finishes INSIDE the panel and the containment assertion below fails while
      // saying nothing at all about the real cause.
      const FOCUSABLE =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
        ' textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])';
      const controls = panel.querySelectorAll(FOCUSABLE).length;
      // Guard against a vacuous sweep: a panel that rendered no controls at all would
      // make every budget sufficient and prove nothing.
      expect(controls).toBeGreaterThan(0);
      const budget = controls + 4;
      expect(budget).toBeGreaterThan(controls);

      // Walk forward well past the panel's own controls. A focus TRAP would keep
      // cycling inside it, and a blur-to-close panel would vanish.
      for (let i = 0; i < budget; i += 1) await userEvent.tab();

      expect(screen.getByTestId('kpi-drilldown')).toBe(panel);
      expect(tile).toHaveAttribute('aria-expanded', 'true');
      expect(panel.contains(document.activeElement)).toBe(false);
    });

    it('closes on Escape and returns focus to the trigger tile', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      await userEvent.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
      expect(tile).toHaveFocus();
      expect(tile).toHaveAttribute('aria-expanded', 'false');
      expect(tile).not.toHaveAttribute('aria-controls');
    });

    it('lets a filter dropdown swallow its own Escape without tearing down the panel', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');

      // A Radix Select portals its content into the panel's REACT tree, so its own
      // Escape dismissal bubbles all the way to the panel's key handler. Without the
      // `defaultPrevented` guard, closing a dropdown would close the whole disclosure.
      const sortTrigger = screen.getByTestId('kpi-drilldown-sort');
      await userEvent.click(sortTrigger);
      await waitFor(() => expect(sortTrigger).toHaveAttribute('aria-expanded', 'true'));
      await userEvent.keyboard('{Escape}');

      await waitFor(() => expect(sortTrigger).toHaveAttribute('aria-expanded', 'false'));
      expect(screen.getByTestId('kpi-drilldown')).toBeInTheDocument();
      expect(tile).toHaveAttribute('aria-expanded', 'true');
    });

    it('closes on Escape from EVERY control the panel renders, new ones included', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      const panel = await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      // The Escape guard is a CONJUNCTION: an Escape whose target is inside this
      // section closes unconditionally, and one from outside it defers to
      // `defaultPrevented`. Both halves bind every control. A new control that consumed
      // Escape without leaving the subtree would have its own key swallowed AND take the
      // panel down with it; one that portalled out without moving focus would make the
      // panel stop closing. Rather than trusting a reading of each new control, walk to
      // every focusable stop the panel actually renders and press Escape from it.
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
    });

    it("closes on Escape while a NEIGHBOUR tile's hover card is open", async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      // Every Radix dismissable layer marks Escape `defaultPrevented` from a DOCUMENT
      // capture listener, so a guard that simply trusted that flag was disabled by any
      // layer anywhere on the page — including a neighbouring tile's trend card, which
      // is not this panel's and which an ordinary pointer drift opens. The panel became
      // un-closable on the first Escape.
      await userEvent.hover(screen.getByTestId('kpi-false-positive-rate'));
      await waitFor(() => expect(screen.getByTestId('metric-trend-card')).toBeInTheDocument(), {
        timeout: 2000,
      });
      // Focus is still in the panel, so this Escape is the PANEL's.
      expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus();

      await userEvent.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
      expect(tile).toHaveFocus();
    });

    it('does not let the focus RETURN pop the trend card back open', async () => {
      const { tile } = await mountStrip();
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');
      await waitFor(() => expect(screen.getByTestId('kpi-drilldown-heading')).toHaveFocus());

      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('kpi-drilldown')).toBeNull());
      expect(tile).toHaveFocus();

      // Radix opens on a TIMER, so `forceClosed` read at callback time is already false
      // by the time the focus return's own open transition resolves. An explicit
      // dismiss answered by a new overlay ~160ms later needs a second Escape.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });
      expect(screen.queryByTestId('metric-trend-card')).toBeNull();
    });

    it('keeps the hover trend card suppressed for as long as the panel is open', async () => {
      const { tile } = await mountStrip();
      // Hover FIRST, so an already-latched card has to be torn down rather than merely
      // prevented — the trigger opens on focus too, and the focus return on close would
      // otherwise pop it straight back over the strip.
      await userEvent.hover(tile);
      await userEvent.click(tile);
      await screen.findByTestId('kpi-drilldown');

      await waitFor(() => expect(screen.queryByTestId('metric-trend-card')).toBeNull());
      await userEvent.hover(tile);
      await new Promise((r) => setTimeout(r, 350));
      expect(screen.queryByTestId('metric-trend-card')).toBeNull();
      // The series is not lost — the panel restates it, which is also the only surface
      // a touch-only device can reach now that every tile is a clickable trigger.
      expect(screen.getByTestId('kpi-drilldown-trend')).toBeInTheDocument();
    });
  });
});
