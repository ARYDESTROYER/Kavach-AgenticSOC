/**
 * Dashboard widget bodies (Round 14, SPEC §4.4.3): every type renders from the shared
 * provider with real-shaped answers, in plain sentence-case copy, and each one owns its
 * states (loading, no data naming the window, a load error with Retry for that widget
 * only, an honest gap with its reason).
 *
 *   - F4: "Awaiting a decision" counts open cases by AI verdict (13 of 15 open), never
 *     the legacy status count.
 *   - The KPI strip follows the honesty rules cell by cell; a denied cell reads "No
 *     access" and is not fetched.
 *   - AI spend shows chat outside the budget, the budget used, and the spend per case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const apiMocks = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  listCases: vi.fn(),
  standup: vi.fn(),
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

import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import { WIDGET_TYPES } from '@/soc/dashboard/registry';
import type { DashboardWidget } from '@/lib/types';
import type { DashboardWindow } from '@/lib/types-dashboards';

import {
  AGENT_IMPROVEMENT,
  COVERAGE,
  OPEN_BY_VERDICT,
  USAGE,
  breakdown,
  fixtureBreakdown,
  fixtureGet,
  noise,
  posture,
  trends,
} from './dashboard-fixtures';

function w(type: string, options: Record<string, unknown> = {}, i = type, x = 0, y = 0): DashboardWidget {
  return { i, type, x, y, w: 4, h: 3, options } as unknown as DashboardWidget;
}

function board(widgets: DashboardWidget[], props: { window?: DashboardWindow; can?: (r: string, a: string) => boolean } = {}) {
  return render(
    <DashboardDataProvider window={props.window ?? 'now-24h'} objectScoped={false} can={props.can} widgets={widgets}>
      <WidgetGrid widgets={widgets} />
    </DashboardDataProvider>,
  );
}

function cell(type: string): HTMLElement {
  const el = document.querySelector(`[data-widget-type="${type}"]`);
  if (!el) throw new Error(`no ${type} on the board`);
  return el as HTMLElement;
}

async function untilSettled(types: readonly string[]) {
  await waitFor(
    () => {
      for (const t of types) {
        const el = cell(t);
        expect(el.querySelector('[aria-busy="true"], [data-widget-state="loading"]'), t).toBeNull();
      }
    },
    { timeout: 5000 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getMetrics.mockResolvedValue({ active_risk_index: 46, active_risk_case_count: 3 });
  apiMocks.listCases.mockResolvedValue({
    cases: [
      { case_id: 'c-1', case_number: 'CASE-000001', title: 'Brute force on vpn-01', status: 'new', verdict: 'NEEDS_HUMAN', risk_score: 72, created_at: '2026-10-28T20:00:00Z', updated_at: '2026-10-28T20:00:00Z' },
    ],
    total: 1,
  });
  apiMocks.get.mockImplementation((path: string) => fixtureGet(path));
  apiMocks.metricsTrends.mockImplementation((hours: number) => Promise.resolve(trends(Math.min(hours, 24))));
  apiMocks.noiseReduction.mockResolvedValue(noise());
  apiMocks.usageSummary.mockResolvedValue(USAGE);
  apiMocks.getAgentImprovement.mockResolvedValue(AGENT_IMPROVEMENT);
  breakdownMock.mockImplementation((q: { by: string }) => fixtureBreakdown(q));
  fetchPostureMock.mockResolvedValue(posture());
  fetchMitreMock.mockResolvedValue(COVERAGE);
});

describe('every widget type', () => {
  it('renders its ready body in plain sentence-case copy, without an error or a stray value', async () => {
    const widgets = WIDGET_TYPES.map((t, i) => w(t, {}, `w${i}`, (i % 3) * 4, Math.floor(i / 3) * 3));
    board(widgets);
    await untilSettled(WIDGET_TYPES);
    for (const t of WIDGET_TYPES) {
      const el = cell(t);
      const text = el.textContent ?? '';
      expect(el.querySelector('[data-widget-state="error"]'), `${t} error`).toBeNull();
      expect(el.querySelector('[data-widget-gate]'), `${t} gate`).toBeNull();
      expect(text.trim().length, `${t} text`).toBeGreaterThan(0);
      // No em or en dash used as punctuation, no raw sentinel or code value, no retired word.
      expect(text, t).not.toMatch(/\s[\u2013\u2014]\s/);
      expect(text, t).not.toMatch(/\b(NaN|undefined|null|\[object Object\])\b/);
      expect(text.toLowerCase(), t).not.toContain('playbook');
    }
  }, 20_000);
});

describe('accessibility', () => {
  it('a board of every widget type, loaded, has no axe violations', async () => {
    const widgets = WIDGET_TYPES.map((t, i) => w(t, {}, `w${i}`, (i % 3) * 4, Math.floor(i / 3) * 3));
    const { container } = board(widgets);
    await untilSettled(WIDGET_TYPES);
    expect(await axe(container)).toHaveNoViolations();
  }, 30_000);

  it('a board still loading has no axe violations either', async () => {
    breakdownMock.mockReturnValue(new Promise(() => undefined));
    const widgets = [w('kpi.needs_human', {}, 'a'), w('table.top_rules', {}, 'b', 4)];
    const { container } = board(widgets);
    await waitFor(() => expect(container.querySelectorAll('[data-widget-state="loading"]').length).toBeGreaterThan(0));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('F4: Awaiting a decision', () => {
  it('counts open cases whose AI verdict is Needs human, over every open case', async () => {
    board([w('kpi.needs_human')]);
    const el = cell('kpi.needs_human');
    await waitFor(() => expect(within(el).getByText('13')).toBeInTheDocument());
    expect(el.textContent).toContain('Awaiting a decision');
    expect(el.textContent).toContain('of 15 open');
    expect(breakdownMock).toHaveBeenCalledWith(expect.objectContaining({ by: 'verdict', status_group: 'open', window: 'all' }), expect.anything());
    expect(apiMocks.getMetrics).not.toHaveBeenCalled();
  });

  it('is Not measured, never 0, when top cut the Needs human group', async () => {
    breakdownMock.mockResolvedValue(
      breakdown({ by: 'verdict', status_group: 'open', groups: [], other: { count: 9, groups: 3, calls: null, cost_usd: null } }),
    );
    board([w('kpi.needs_human')]);
    const el = cell('kpi.needs_human');
    await waitFor(() => expect(el.textContent).toContain('Not measured'));
    expect(within(el).queryByText('0')).toBeNull();
  });
});

describe('KPI strip', () => {
  it('shows each operations figure from its binding, with the gaps stated', async () => {
    board([w('kpi.strip', { preset: 'operations' })]);
    const el = cell('kpi.strip');
    await waitFor(() => expect(within(el).getByTestId('kpi-strip-awaiting_decision').textContent).toContain('13'));
    expect(within(el).getByTestId('kpi-strip-open_now').textContent).toContain('15');
    expect(within(el).getByTestId('kpi-strip-new_cases').textContent).toContain('38');
    // The comparison follows the window.
    expect(within(el).getByTestId('kpi-strip-new_cases').textContent).toMatch(/vs prior 24h/);
    expect(within(el).getByTestId('kpi-strip-sla_breached').textContent).toContain('1');
  });

  it('a cell the role cannot read says No access and is not fetched', async () => {
    const can = (resource: string, action: string) => !(resource === 'metrics' && action === 'view');
    board([w('kpi.strip', { preset: 'operations' })], { can });
    const el = cell('kpi.strip');
    await waitFor(() => expect(within(el).getByTestId('kpi-strip-open_now').textContent).toContain('15'));
    expect(within(el).getByTestId('kpi-strip-awaiting_decision').textContent).toContain('No access');
    expect(within(el).getByTestId('kpi-strip-new_cases').textContent).toContain('No access');
    expect(breakdownMock).not.toHaveBeenCalled();
  });

  it('detection: Alert reduction and events per minute come from the counters, withheld when they warm up', async () => {
    apiMocks.noiseReduction.mockResolvedValue(
      noise({ counters: { available: false, incomplete: false } as never, events_per_min: null, events_per_min_reason: 'the counters started recently' }),
    );
    board([w('kpi.strip', { preset: 'detection' })]);
    const el = cell('kpi.strip');
    await waitFor(() => expect(within(el).getByTestId('kpi-strip-alert_reduction').textContent).toContain('Not measured'));
    // The visible line stays short (the numerals share one baseline); the source's reason
    // is in the cell's help popover, which a keyboard reaches.
    expect(within(el).getByTestId('kpi-strip-alert_reduction').textContent).not.toContain('warming up');
    fireEvent.click(within(el).getByRole('button', { name: 'About Alert reduction' }));
    expect(await screen.findByText(/Not measured\. Alert counters are still warming up\./)).toBeInTheDocument();
    fireEvent.click(within(el).getByRole('button', { name: 'About Events per minute' }));
    expect(await screen.findByText(/Not measured\. The counters started recently\./)).toBeInTheDocument();
    expect(within(el).getByTestId('kpi-strip-sources_reporting').textContent).toContain('1');
  });
});

describe('widget states', () => {
  it('a failed read shows a load error with Retry for that widget only, and Retry reads again', async () => {
    breakdownMock.mockImplementation((q: { by: string }) =>
      q.by === 'rule' ? Promise.reject(new Error('503 Service Unavailable')) : fixtureBreakdown(q),
    );
    board([w('table.top_rules', {}, 'r'), w('chart.case_breakdown', { by: 'severity' }, 'b', 4)]);
    const rules = cell('table.top_rules');
    await waitFor(() => expect(rules.querySelector('[data-widget-state="error"]')).not.toBeNull());
    expect(rules.textContent).toContain('Top detection rules could not be loaded.');
    // The other widget is unaffected.
    await untilSettled(['chart.case_breakdown']);
    expect(cell('chart.case_breakdown').querySelector('[data-widget-state="error"]')).toBeNull();
    breakdownMock.mockImplementation((q: { by: string }) => fixtureBreakdown(q));
    const before = breakdownMock.mock.calls.length;
    fireEvent.click(within(rules).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(within(rules).getAllByText('demo_noisy_scanner').length).toBeGreaterThan(0));
    expect(breakdownMock.mock.calls.length).toBe(before + 1);
  });

  it('no data names the window', async () => {
    breakdownMock.mockResolvedValue(breakdown({ by: 'status', groups: [] }));
    board([w('chart.case_breakdown', { by: 'status' })], { window: 'now-7d' });
    const el = cell('chart.case_breakdown');
    await waitFor(() => expect(el.textContent).toContain('No cases in the last 7 days'));
  });

  it('a gap the server reports is stated with its reason, never as 0', async () => {
    fetchPostureMock.mockResolvedValue(posture());
    board([w('kpi.lifecycle_timing')]);
    const el = cell('kpi.lifecycle_timing');
    await waitFor(() => expect(within(el).getByTestId('kpi-timing-mtta').textContent).toContain('Not measured'));
    // The server's reason is in the cell's help, after the definition.
    fireEvent.click(within(el).getByRole('button', { name: 'About Time to acknowledge' }));
    expect(await screen.findByText(/first acknowledgement by a person\. Not measured\. No case has been acknowledged yet\./)).toBeInTheDocument();
    expect(within(el).getByTestId('kpi-timing-mttd').textContent).toMatch(/2\s?m/);
  });

  it('an operator title replaces the default, as plain text', async () => {
    board([w('chart.case_breakdown', { by: 'severity', title: '<b>Severity mix</b>' })]);
    const el = cell('chart.case_breakdown');
    await waitFor(() => expect(el.textContent).toContain('<b>Severity mix</b>'));
    expect(el.querySelector('b')).toBeNull();
  });

  it('without an override a body keeps its own descriptive title', async () => {
    board([w('chart.case_breakdown', { by: 'source', population: 'open' })]);
    const el = cell('chart.case_breakdown');
    await waitFor(() => expect(el.textContent).toContain('Open cases by source'));
    expect(breakdownMock).toHaveBeenCalledWith(expect.objectContaining({ by: 'source', status_group: 'open', window: 'all' }), expect.anything());
  });
});

describe('AI spend', () => {
  it('shows the window spend, chat outside the budget, the budget used and the spend per case', async () => {
    board([w('kpi.cost_budget')]);
    const el = cell('kpi.cost_budget');
    await waitFor(() => expect(el.textContent).toContain('$1.25'));
    expect(el.textContent).toContain('Of which chat, outside the budget');
    expect(el.textContent).toContain('$0.25');
    expect(el.textContent).toMatch(/\$1\.00 of \$10\.00 today \(10%\)/);
    // $1 of investigation spend over 36 investigated cases.
    await waitFor(() => expect(el.textContent).toContain('$0.0278'));
  });

  it('counts one call as one call', async () => {
    apiMocks.usageSummary.mockResolvedValue({ ...USAGE, call_count: 1 });
    board([w('kpi.cost_budget')]);
    const el = cell('kpi.cost_budget');
    await waitFor(() => expect(el.textContent).toContain('model spend, 1 call'));
    expect(el.textContent).not.toContain('1 calls');
  });

  it('leaves the budget out for a role without models:read', async () => {
    const can = (resource: string) => resource !== 'models';
    board([w('kpi.cost_budget')], { can });
    const el = cell('kpi.cost_budget');
    await waitFor(() => expect(el.textContent).toContain('$1.25'));
    expect(el.textContent).not.toContain('Budget used');
    expect(apiMocks.get).not.toHaveBeenCalledWith('budget/status', undefined, expect.anything());
  });
});

describe('Cases by verdict', () => {
  it('reads the board window by AI verdict and gives each verdict its share of the window', async () => {
    breakdownMock.mockResolvedValue(
      breakdown({
        by: 'verdict',
        groups: [
          { ...OPEN_BY_VERDICT.groups[1], count: 30 },
          { ...OPEN_BY_VERDICT.groups[2], count: 6 },
          { ...OPEN_BY_VERDICT.groups[0], count: 2 },
        ],
      }),
    );
    board([w('chart.verdict_mix')], { window: 'now-7d' });
    const el = cell('chart.verdict_mix');
    await waitFor(() => expect(el.textContent).toContain('False positive'));
    expect(breakdownMock).toHaveBeenCalledWith(expect.objectContaining({ by: 'verdict', window: 'now-168h' }), expect.anything());
    // Never the all-time `/api/metrics` counts under a window caption.
    expect(apiMocks.getMetrics).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Last 7 days · AI verdicts · 38 cases');
    expect(el.textContent).toContain("79% of the window's cases");
    expect(el.textContent).toContain("5% of the window's cases");
  });
});

describe('detection and executive modules', () => {
  it('the noise funnel reports the shared Alert reduction', async () => {
    board([w('chart.noise_funnel')]);
    const el = cell('chart.noise_funnel');
    await waitFor(() => expect(el.textContent).toContain('Alerts ingested'));
    expect(el.textContent).toContain('97%');
  });

  it('campaigns are named by their shared entity, never by the internal id', async () => {
    board([w('table.campaigns')]);
    const el = cell('table.campaigns');
    await waitFor(() => expect(el.textContent).toContain('pnair · 2 cases'));
    expect(el.textContent).not.toContain('campaign-1e57');
  });

  it('agent quality says it needs more evidence, never a rate from too few reviews', async () => {
    board([w('kpi.agent_quality')]);
    const el = cell('kpi.agent_quality');
    await waitFor(() => expect(el.textContent).toContain('Not enough evidence yet'));
    expect(el.textContent).toContain('Needs 30 analyst reviews; 4 so far.');
    expect(el.textContent).not.toMatch(/\d+%/);
  });

  it('telemetry gaps say capture is not available yet, never that no gap was recorded', async () => {
    board([w('table.telemetry_gaps')]);
    const el = cell('table.telemetry_gaps');
    await waitFor(() => expect(el.textContent).toContain('Telemetry gap capture is not available yet'));
    expect(el.textContent).toMatch(/query tools do not yet emit controlled field-level failure evidence/);
    expect(el.textContent).not.toContain('No telemetry gap recorded');
    // Nothing was scanned for gaps, so the caption states no scan count.
    expect(el.querySelector('[data-widget-caption]')!.textContent).toBe('Right now · from query evidence');
  });
});
