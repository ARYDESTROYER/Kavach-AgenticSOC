/**
 * Board figures explain themselves (acceptance package FXD1). Each figure below opens an
 * explanation whose arithmetic reproduces the figure on the board, from the same answers
 * the board read:
 *
 *   - The SLA panel's empty state names the cases it counts (opened in the window), says
 *     how many open cases from earlier are past target, and links to them
 *     (socops-sla-widget-contradiction). Its "97.4% met" opens the attainment.
 *   - Noisiest rules: "89%" is the Wilson lower bound of 30 of 30 (noisy-rules-wilson-unexplained).
 *   - Auto-close health: "82%" is 31 of 38 decided (board-figures-unexplained).
 *   - Human vs AI: "31 94%" is 31 of 33 closed cases, shown 94% (human-vs-ai-shares).
 *   - Spend per investigated case divides investigation spend by the verdicted cases.
 *   - A strip change chip names both counts and the difference (delta-chips-unexplained).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  listCases: vi.fn(),
  get: vi.fn(),
  metricsTrends: vi.fn(),
  noiseReduction: vi.fn(),
  usageSummary: vi.fn(),
  getAgentImprovement: vi.fn(),
  auth: { me: vi.fn() },
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMocks }));

const { breakdownMock } = vi.hoisted(() => ({ breakdownMock: vi.fn() }));
vi.mock('@/lib/api-dashboards', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-dashboards')>()),
  getMetricsBreakdown: breakdownMock,
}));

const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn(), fetchMitreMock: vi.fn() }));
vi.mock('@/soc/pages/Metrics.posture.api', async (orig) => ({
  ...(await orig<typeof import('@/soc/pages/Metrics.posture.api')>()),
  fetchPosture: fetchPostureMock,
  fetchMitreCoverage: fetchMitreMock,
}));

import type { DashboardWidget } from '@/lib/types';
import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import { slaEmptyText } from '@/soc/dashboard/widgets/shift';

import {
  AGENT_IMPROVEMENT,
  COVERAGE,
  SHIFT_REPORT,
  USAGE,
  fixtureBreakdown,
  fixtureGet,
  noise,
  posture,
  trends,
} from './dashboard-fixtures';

function w(type: string, options: Record<string, unknown> = {}, i = type): DashboardWidget {
  return { i, type, x: 0, y: 0, w: 4, h: 3, options } as unknown as DashboardWidget;
}

function board(widgets: DashboardWidget[]) {
  return render(
    <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets}>
      <WidgetGrid widgets={widgets} />
    </DashboardDataProvider>,
  );
}

function cell(type: string): HTMLElement {
  const el = document.querySelector(`[data-widget-type="${type}"]`);
  if (!el) throw new Error(`no ${type} on the board`);
  return el as HTMLElement;
}

/** A trigger's accessible name, read without the space jsdom puts before ", explain". */
function named(pattern: RegExp) {
  return (name: string) => pattern.test(name.replace(/\s+, explain$/, ', explain'));
}

/** Open the first Explain trigger whose name matches, and return its panel's text. */
async function openExplain(scope: HTMLElement, name: RegExp): Promise<string> {
  const trigger = (await within(scope).findAllByRole('button', { name: named(name) }, { timeout: 4000 }))[0];
  fireEvent.click(trigger);
  const panel = await screen.findByRole('dialog');
  return panel.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getMetrics.mockResolvedValue({ active_risk_index: 46, active_risk_case_count: 3 });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.get.mockImplementation((path: string) => fixtureGet(path));
  apiMocks.metricsTrends.mockImplementation((hours: number) => Promise.resolve(trends(Math.min(hours, 24))));
  apiMocks.noiseReduction.mockResolvedValue(noise());
  apiMocks.usageSummary.mockResolvedValue(USAGE);
  apiMocks.getAgentImprovement.mockResolvedValue(AGENT_IMPROVEMENT);
  apiMocks.auth.me.mockResolvedValue({ object_scoped: false });
  breakdownMock.mockImplementation((q: { by: string }) => fixtureBreakdown(q));
  fetchPostureMock.mockResolvedValue(posture());
  fetchMitreMock.mockResolvedValue(COVERAGE);
});

describe('the SLA panel (socops-sla-widget-contradiction)', () => {
  it('an empty window names the cases it counts and links to the open breaches from earlier', async () => {
    board([w('table.sla_breaches')]);
    const el = cell('table.sla_breaches');
    await waitFor(() =>
      expect(el.textContent).toContain('No case opened in the last 24 hours breached or came close to a target'),
    );
    // SHIFT_REPORT counts one open case past its response target, whatever its arrival.
    await waitFor(() => expect(el.textContent).toContain('1 open case from earlier is past the response target.'));
    const link = within(el).getByRole('link', { name: /View the open breaches/ });
    expect(link).toHaveAttribute('href', '#/standup');
  });

  it('with no open breach the empty state says only what the window holds', async () => {
    apiMocks.get.mockImplementation((path: string) =>
      path === 'standup/report'
        ? Promise.resolve({ ...SHIFT_REPORT, sla_aging: { ...SHIFT_REPORT.sla_aging, totals: { open: 15, breached: 0, about_to_breach: 0 }, breached: [] } })
        : fixtureGet(path),
    );
    board([w('table.sla_breaches')]);
    const el = cell('table.sla_breaches');
    await waitFor(() => expect(el.textContent).toContain('No case opened in the last 24 hours breached'));
    expect(el.textContent).not.toContain('from earlier');
    expect(within(el).queryByRole('link', { name: /View the open breaches/ })).toBeNull();
  });

  it('the attainment in the caption opens its explanation', async () => {
    board([w('table.sla_breaches')]);
    const el = cell('table.sla_breaches');
    const text = await openExplain(el, /^97\.4% met, explain$/);
    expect(text).toContain('SLA attainment');
    expect(text).toContain('38 cases');
  });

  it('the words, one open breach and several', () => {
    expect(slaEmptyText('last 7 days', 3)).toEqual({
      title: 'No case opened in the last 7 days breached or came close to a target',
      description: '3 open cases from earlier are past the response target.',
    });
    expect(slaEmptyText('last 7 days', null).description).toBeUndefined();
  });
});

describe('board figures (board-figures-unexplained, noisy-rules-wilson-unexplained, human-vs-ai-shares)', () => {
  it('a noisy rule FP rate is the Wilson lower bound of its graded counts', async () => {
    board([w('table.noisy_rules')]);
    const text = await openExplain(cell('table.noisy_rules'), /^89%, explain$/);
    expect(text).toContain('89% is the lower end of the 95% range for 30 false positives in 30 graded cases (88.65%).');
    expect(text).toContain('not the observed ratio (30 / 30 = 100%)');
  });

  it('the auto-close rate is the closed share of the decided cases', async () => {
    board([w('kpi.auto_close_health')]);
    const text = await openExplain(cell('kpi.auto_close_health'), /^82%, explain$/);
    expect(text).toContain('31 closed by the AI agent on its first decision of 38 cases decided = 81.6%, the last 24 hours.');
    expect(text).toContain('floor(81.6 + 0.5)');
  });

  it('a Human vs AI figure is its count over the closed cases, in the card whole percents', async () => {
    board([w('chart.autonomous_vs_human')]);
    const text = await openExplain(cell('chart.autonomous_vs_human'), /^31 94%, explain$/);
    expect(text).toContain('31 closed by the AI agent of 33 closed cases = 93.9%, shown 94%, the last 24 hours.');
  });

  it('spend per investigated case divides investigation spend by the verdicted cases', async () => {
    board([w('kpi.cost_budget')]);
    const text = await openExplain(cell('kpi.cost_budget'), /^\$0\.\d+, explain$/);
    expect(text).toMatch(/\$1 investigation spend \/ \d+ verdicted cases? = \$[\d.]+, the last 24 hours\./);
  });

  it('a strip change chip names both counts and the difference', async () => {
    board([w('kpi.strip', { preset: 'executive' })]);
    const text = await openExplain(cell('kpi.strip'), /^changed up by \+8, explain$/);
    expect(text).toContain('38 cases in the last 24 hours and 30 cases in the 24 hours before. 38 - 30 = +8.');
  });
});

describe('the trend footer (detection-trend-57-vs-56)', () => {
  it('says the first bucket counts only the window, so its total matches the other panels', async () => {
    board([w('chart.case_trend', { series: 'flow' })]);
    const el = cell('chart.case_trend');
    await waitFor(() => expect(el.textContent).toContain('The first bucket counts only the cases that arrived inside the window.'));
  });

  it('the alert series counts from the window first hour, as the noise counters do', async () => {
    board([w('chart.case_trend', { series: 'alerts' })]);
    const el = cell('chart.case_trend');
    await waitFor(() => expect(el.textContent).toContain("The first bucket counts alerts from the window's first hour on."));
  });
});
