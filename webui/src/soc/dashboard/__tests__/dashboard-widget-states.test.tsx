/**
 * Widget states a board must never get wrong (Round 14, SPEC §4.4.3, §4.4.5, §8.1):
 *
 *   - A shift report the server could not build is a load error with Retry, never "nothing
 *     needs a person"; one that is turned off says so.
 *   - A count that is a lower bound carries the floor mark; a share computed from part of
 *     the window is withheld.
 *   - The caption sits on its own line under the title, inside the panel, with the "View
 *     ..." exit (a real link) on the title row.
 *   - A panel the role cannot read keeps the title its body would show.
 *   - An unconfirmed row-level scope is said once in the strip, with Retry, and the cells
 *     that read no case data still show their figures.
 *   - A loading strip shows skeleton numerals, never the dash that means "not measured".
 *   - Phone width: tables have a two-line list twin; the board is one column below lg and
 *     two from lg to xl.
 *   - A fixed edit-mode cell scrolls its body, never its caption; a refresh that failed is
 *     said over the figures it kept; telemetry capture that does not exist is never "no gap".
 *   - AI spend says its figures are held when ANY read it shows (usage, the budget, the
 *     per-case reads) failed to refresh, and its one Retry reads every one again.
 */
import type { ComponentType } from 'react';
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

import { DASH } from '@/lib/format';
import type { DashboardWidget } from '@/lib/types';
import type { DashboardWindow } from '@/lib/types-dashboards';
import { DashboardDataProvider, useDashboardData } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import { SCOPE_UNCONFIRMED_MESSAGE, WidgetFrameContext, type WidgetProps } from '@/soc/dashboard/widgets/common';
import { CaseBreakdownWidget, TopRulesWidget } from '@/soc/dashboard/widgets/breakdown';
import { KpiStripWidget } from '@/soc/dashboard/widgets/strip';
import { LifecycleTimingWidget } from '@/soc/dashboard/widgets/lifecycle';
import { AutonomousVsHumanWidget } from '@/soc/dashboard/widgets/mix';

import {
  AGENT_IMPROVEMENT,
  AUTO_CLOSE,
  COVERAGE,
  SHIFT_REPORT,
  TELEMETRY_NONE,
  USAGE,
  breakdown,
  fixtureBreakdown,
  fixtureGet,
  group,
  noise,
  posture,
  trends,
} from './dashboard-fixtures';

function w(type: string, options: Record<string, unknown> = {}, i = type, x = 0): DashboardWidget {
  return { i, type, x, y: 0, w: 4, h: 3, options } as unknown as DashboardWidget;
}

function board(
  widgets: DashboardWidget[],
  props: { window?: DashboardWindow; can?: (r: string, a: string) => boolean; objectScoped?: boolean } = {},
) {
  return render(
    <DashboardDataProvider
      window={props.window ?? 'now-24h'}
      objectScoped={'objectScoped' in props ? props.objectScoped : false}
      can={props.can}
      widgets={widgets}
    >
      <WidgetGrid widgets={widgets} />
    </DashboardDataProvider>,
  );
}

/** The board's refresh control, as a host renders it. */
function RefreshProbe() {
  const { refresh } = useDashboardData();
  return (
    <button type="button" onClick={refresh}>
      Refresh board
    </button>
  );
}

function cell(type: string): HTMLElement {
  const el = document.querySelector(`[data-widget-type="${type}"]`);
  if (!el) throw new Error(`no ${type} on the board`);
  return el as HTMLElement;
}

function shiftReport(extra: Record<string, unknown>) {
  return (path: string) => (path === 'standup/report' ? Promise.resolve({ ...SHIFT_REPORT, ...extra }) : fixtureGet(path));
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

describe('the shift report', () => {
  it('a report the server could not build is a load error with Retry, never an empty queue', async () => {
    apiMocks.get.mockImplementation(shiftReport({ degraded: true, attention_queue: [], workload: [] }));
    board([w('table.attention_queue', {}, 'q'), w('table.workload', {}, 'wl', 4)]);
    const queue = cell('table.attention_queue');
    await waitFor(() => expect(queue.querySelector('[data-widget-state="error"]')).not.toBeNull());
    expect(queue.textContent).toContain('Needs attention now could not be loaded.');
    expect(queue.textContent).toContain('The shift report could not be read.');
    expect(within(queue).getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(queue.textContent).not.toContain('Nothing needs a person');
    // The workload caption states no count it did not read.
    const workload = cell('table.workload');
    await waitFor(() => expect(workload.querySelector('[data-widget-state="error"]')).not.toBeNull());
    expect(workload.querySelector('[data-widget-caption]')!.textContent).toBe('Open now');
  });

  it('a report that is turned off says so', async () => {
    apiMocks.get.mockImplementation(shiftReport({ enabled: false, attention_queue: [] }));
    board([w('table.attention_queue')]);
    const queue = cell('table.attention_queue');
    await waitFor(() => expect(queue.textContent).toContain('The shift report is turned off'));
    expect(queue.querySelector('[data-widget-state="unavailable"]')).not.toBeNull();
  });

  it('a read report ranks the breached case first and names the analyst workload in words', async () => {
    board([w('table.attention_queue', {}, 'q'), w('table.workload', {}, 'wl', 4)]);
    const queue = cell('table.attention_queue');
    await waitFor(() => expect(queue.textContent).toContain('Response 1d 3h over'));
    const workload = cell('table.workload');
    await waitFor(() => expect(workload.textContent).toContain('1 awaiting a decision'));
    expect(workload.querySelector('[data-widget-caption]')!.textContent).toBe('Open now · 7 cases, 4 unassigned');
  });
});

describe('lower bounds and withheld shares', () => {
  it('the noise funnel marks alert counts as floors when the counters cover part of the window', async () => {
    apiMocks.noiseReduction.mockResolvedValue(noise({ counters: { available: true, incomplete: true, since: null, coverage_start: null } } as never));
    board([w('chart.noise_funnel')]);
    const el = cell('chart.noise_funnel');
    await waitFor(() => expect(el.textContent).toContain('Alerts ingested'));
    expect(el.querySelectorAll('[data-bound="floor"]').length).toBe(2);
    expect(el.textContent).toContain('The alert counters cover only part of this window, so alert counts are lower bounds.');
    // No reduction headline from part of the window.
    expect(el.querySelector('[data-widget-caption]')!.textContent).toBe('Last 24 hours');
  });

  it('top detection rules from a partial read are lower bounds, said in the caption', async () => {
    breakdownMock.mockResolvedValue(
      breakdown({ by: 'rule', multi_valued: true, partial: true, partial_reason: 'A shard did not answer.', groups: [group('ssh_bruteforce', 9)] }),
    );
    board([w('table.top_rules')]);
    const el = cell('table.top_rules');
    await waitFor(() => expect(el.querySelector('[data-widget-caption]')!.textContent).toBe('Last 24 hours · cases per rule (lower bounds)'));
    expect(el.querySelectorAll('[data-bound="floor"]').length).toBeGreaterThan(0);
    expect(el.textContent).toContain('Part of the cases could not be read: A shard did not answer.');
  });

  it('the alert series counts the unmeasured buckets and says the total is at least', async () => {
    const t = trends(24);
    t.buckets.forEach((b, i) => {
      if (i < 6) (b as { alerts: number | null }).alerts = null;
    });
    apiMocks.metricsTrends.mockResolvedValue(t);
    board([w('chart.case_trend', { series: 'alerts' })]);
    const el = cell('chart.case_trend');
    await waitFor(() => expect(el.textContent).toMatch(/At least [\d,]+ alerts and \d+ cases in the last 24 hours\./));
    expect(el.textContent).toContain('Hatched hours were not measured: the alert counters started later.');
  });

  it('the risk gauge says there is nothing to score rather than drawing a 0', async () => {
    apiMocks.getMetrics.mockResolvedValue({ active_risk_index: 0, active_risk_case_count: 0 });
    board([w('gauge.active_risk')]);
    const el = cell('gauge.active_risk');
    await waitFor(() => expect(el.textContent).toContain('No open cases to score right now'));
    expect(el.textContent).not.toContain('74 and above is critical');
  });
});

describe('panel grammar', () => {
  it('puts the caption under the title inside the panel and the exit link on the title row', async () => {
    board([w('table.top_rules')]);
    const el = cell('table.top_rules');
    await waitFor(() => expect(el.querySelector('[data-widget-caption]')).not.toBeNull());
    const heading = within(el).getByRole('heading', { name: 'Top detection rules' });
    const caption = el.querySelector('[data-widget-caption]')!;
    const body = el.querySelector('[data-widget-body]')!;
    expect(heading.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(caption.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const exit = within(el).getByRole('link', { name: /view cases/i });
    expect(exit.getAttribute('href')).toBe('#/cases');
    // The exit is not inside the caption line: it stays at the top right.
    expect(caption.contains(exit)).toBe(false);
  });

  it('a panel the role cannot read keeps the title its body would show', () => {
    const can = (resource: string) => resource !== 'metrics';
    board([w('chart.case_breakdown', { by: 'rule', population: 'open' })], { can });
    const el = cell('chart.case_breakdown');
    expect(el.getAttribute('data-widget-gate')).toBe('denied');
    expect(within(el).getByRole('heading', { name: 'Open cases by detection rule' })).toBeInTheDocument();
    expect(el.textContent).toContain('No access');
    expect(breakdownMock).not.toHaveBeenCalled();
  });
});

describe('the KPI strip while scope or data is unknown', () => {
  it('says once that access could not be confirmed, with Retry, and keeps the source figures', async () => {
    apiMocks.auth.me.mockRejectedValue(new Error('offline'));
    const auth = await import('@/soc/auth');
    const spy = vi.spyOn(auth, 'useOptionalAuth').mockReturnValue({
      authEnabled: true,
      isAuthenticated: true,
      username: 'ana',
      role: 'analyst_tier1',
      hasPermission: () => true,
    } as unknown as ReturnType<typeof auth.useOptionalAuth>);
    try {
      board([w('kpi.strip', { preset: 'detection' })], { objectScoped: undefined });
      const el = cell('kpi.strip');
      await waitFor(() => expect(el.querySelector('[data-strip-failure]')).not.toBeNull());
      const line = el.querySelector('[data-strip-failure]') as HTMLElement;
      expect(line.textContent).toContain(SCOPE_UNCONFIRMED_MESSAGE);
      expect(within(line).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(within(el).getByTestId('kpi-strip-techniques_seen').textContent).toContain(SCOPE_UNCONFIRMED_MESSAGE);
      // Source health is not case data: still read and shown.
      await waitFor(() => expect(within(el).getByTestId('kpi-strip-sources_reporting').textContent).toContain('1'));
      expect(fetchMitreMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a strip still loading shows skeleton numerals, never the dash', async () => {
    fetchPostureMock.mockReturnValue(new Promise(() => undefined));
    breakdownMock.mockReturnValue(new Promise(() => undefined));
    apiMocks.get.mockReturnValue(new Promise(() => undefined));
    board([w('kpi.strip', { preset: 'operations' })]);
    const el = cell('kpi.strip');
    await waitFor(() => expect(el.querySelectorAll('[data-kpi-skeleton]').length).toBe(6));
    expect(el.textContent).not.toContain(DASH);
  });
});

describe('phone width (structure)', () => {
  it('every table has a two-line list twin for a narrow panel, and the view grid is one column on a phone', async () => {
    board([w('table.top_rules', {}, 'r'), w('table.attention_queue', {}, 'q', 4), w('table.connector_health', {}, 'c', 8)]);
    for (const [t, fit] of [
      ['table.top_rules', '32'],
      ['table.attention_queue', '40'],
      ['table.connector_health', '32'],
    ] as const) {
      const el = cell(t);
      await waitFor(() => expect(el.querySelector('[data-panel-list]'), t).not.toBeNull());
      // The switch follows the panel's width (a container query on the widget body), so a
      // half-width panel on a laptop gets the list too, never a squeezed table.
      expect(el.querySelector('[data-widget-body]'), t).toHaveClass('@container/widget');
      const list = el.querySelector('[data-panel-list]')!;
      const table = el.querySelector('[data-panel-table]')!;
      expect(list.getAttribute('data-panel-fit'), t).toBe(fit);
      expect(table.getAttribute('data-panel-fit'), t).toBe(fit);
      expect(list.className, t).toContain(`@[${fit}rem]/widget:hidden`);
      expect(table.className, t).toContain('hidden');
      expect(table.className, t).toContain(`@[${fit}rem]/widget:block`);
    }
    const grid = screen.getByTestId('widget-grid-view');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('xl:[grid-template-columns:var(--wg-cols)]');
  });
});

describe('fixed edit-mode cells', () => {
  /** One widget body in a fixed edit-mode cell, as the editable grid frames it. */
  function editCell(Body: ComponentType<WidgetProps>, type: string, options: Record<string, unknown> = {}) {
    const widgets = [w(type, options)];
    return render(
      <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets}>
        <WidgetFrameContext.Provider value="edit">
          <div style={{ height: 120 }} data-testid="cell">
            <Body id={type} options={options} />
          </div>
        </WidgetFrameContext.Provider>
      </DashboardDataProvider>,
    );
  }

  it('keeps the caption outside the scroller, so the line under the title is never clipped', async () => {
    editCell(TopRulesWidget, 'table.top_rules');
    const cellEl = screen.getByTestId('cell');
    await waitFor(() => expect(cellEl.querySelector('[data-widget-caption]')).not.toBeNull());
    const caption = cellEl.querySelector('[data-widget-caption]') as HTMLElement;
    expect(caption.closest('.overflow-auto')).toBeNull();
    // The body (and only the body) scrolls inside the fixed cell; the panel clips to it.
    const scroller = cellEl.querySelector('[data-widget-scroll]') as HTMLElement;
    expect(scroller).toHaveClass('min-h-0', 'flex-1', 'overflow-auto');
    expect(scroller.contains(cellEl.querySelector('[data-widget-body]'))).toBe(true);
    expect(cellEl.querySelector('[data-widget-panel]')).toHaveClass('min-h-0', 'overflow-hidden');
  });

  it('the KPI strip, Response timing and Human vs AI scroll inside the cell instead of cutting their figures off', async () => {
    for (const [Body, type, options] of [
      [KpiStripWidget, 'kpi.strip', { preset: 'operations' }],
      [LifecycleTimingWidget, 'kpi.lifecycle_timing', {}],
      [AutonomousVsHumanWidget, 'chart.autonomous_vs_human', {}],
    ] as const) {
      const { unmount } = editCell(Body as ComponentType<WidgetProps>, type, options);
      const cellEl = screen.getByTestId('cell');
      await waitFor(() => expect(cellEl.querySelector('[data-widget-scroll]'), type).not.toBeNull());
      expect(cellEl.querySelector('[data-widget-scroll]'), type).toHaveClass('overflow-auto');
      const caption = cellEl.querySelector('[data-widget-caption]');
      if (caption) expect(caption.closest('.overflow-auto'), type).toBeNull();
      unmount();
    }
  });

  it('view mode never scrolls a body: the panel is as tall as its content', async () => {
    board([w('table.top_rules')]);
    const el = cell('table.top_rules');
    await waitFor(() => expect(el.querySelector('[data-widget-caption]')).not.toBeNull());
    expect(el.querySelector('[data-widget-scroll]')).toBeNull();
    expect(el.querySelector('[data-widget-panel]')).not.toHaveClass('overflow-hidden');
  });
});

describe('telemetry gaps', () => {
  it('capture that ran and found nothing says so, apart from capture that does not exist yet', async () => {
    apiMocks.get.mockImplementation((path: string) =>
      path === 'tuning/source-recommendations'
        ? Promise.resolve({ ...TELEMETRY_NONE, capture_status: 'available', capture_not_available_reason: '' })
        : fixtureGet(path),
    );
    board([w('table.telemetry_gaps')]);
    const el = cell('table.telemetry_gaps');
    await waitFor(() => expect(el.textContent).toContain('No telemetry gap found'));
    expect(el.querySelector('[data-widget-state="empty"]')).not.toBeNull();
    expect(el.querySelector('[data-widget-caption]')!.textContent).toBe('Right now · from query evidence, 77 cases scanned');
  });

  it('capture that does not exist yet is unavailable, with the server\'s reason', async () => {
    board([w('table.telemetry_gaps')]);
    const el = cell('table.telemetry_gaps');
    await waitFor(() => expect(el.textContent).toContain('Telemetry gap capture is not available yet'));
    expect(el.querySelector('[data-widget-state="unavailable"]')).not.toBeNull();
    expect(el.textContent).not.toContain('No telemetry gap');
  });
});

describe('auto-close health', () => {
  it('with no decision on record it never prints a bare 0 decided', async () => {
    apiMocks.get.mockImplementation((path: string) =>
      path === 'metrics/auto-close-health/recorded'
        ? Promise.resolve({ ...AUTO_CLOSE, status: 'no_volume', current: { decided: 0, auto_closed: 0, rate: null, available: false, reason: '', no_decision_record: 77 } })
        : fixtureGet(path),
    );
    board([w('kpi.auto_close_health')]);
    const el = cell('kpi.auto_close_health');
    await waitFor(() => expect(el.textContent).toContain('77 cases have no decision record.'));
    expect(el.textContent).toContain('Decisions on record');
    expect(el.textContent).not.toContain('Decided in the window');
    expect(within(el).getByText('Decisions on record').nextElementSibling!.textContent).toBe('None');
  });
});

describe('cases by source', () => {
  function sourceBreakdown() {
    breakdownMock.mockImplementation((q: { by: string }) =>
      q.by === 'source' ? Promise.resolve(breakdown({ by: 'source' as never, groups: [group('s1', 7), group('s9', 2)] })) : fixtureBreakdown(q),
    );
  }

  it('names each source as Connector health does, and keeps an unknown id', async () => {
    sourceBreakdown();
    board([w('chart.case_breakdown', { by: 'source' })]);
    const el = cell('chart.case_breakdown');
    await waitFor(() => expect(el.textContent).toContain('Edge firewall'));
    expect(el.textContent).toContain('s9');
    expect(el.textContent).not.toMatch(/\bs1\b/);
  });

  it('without the sources grant it shows the ids and reads no source list', async () => {
    sourceBreakdown();
    const can = (resource: string) => resource !== 'sources';
    board([w('chart.case_breakdown', { by: 'source' })], { can });
    const el = cell('chart.case_breakdown');
    await waitFor(() => expect(el.textContent).toContain('s1'));
    expect(el.textContent).not.toContain('Edge firewall');
    expect(apiMocks.get).not.toHaveBeenCalledWith('sources/health', expect.anything());
    expect(apiMocks.get.mock.calls.filter((c) => c[0] === 'sources/health')).toHaveLength(0);
  });

  it('draws its bars with BarRow, so they keep their outline under forced colours', async () => {
    sourceBreakdown();
    board([w('chart.case_breakdown', { by: 'source' })]);
    const el = cell('chart.case_breakdown');
    await waitFor(() => expect(el.querySelectorAll('[data-bar-track]').length).toBe(2));
    for (const track of el.querySelectorAll('[data-bar-track]')) {
      expect(track.className).toContain('forced-colors:outline');
      expect((track.firstElementChild as HTMLElement).className).toContain('forced-colors:bg-[CanvasText]');
    }
  });
});

describe('the queue and the SLA list state their real totals', () => {
  it('a breached case outside the 25 most urgent leads the queue, and the footer counts every open case', async () => {
    const queue = Array.from({ length: 25 }, (_, i) => ({
      case_id: `q${i}`,
      case_number: `CASE-${String(100 + i).padStart(6, '0')}`,
      display_id: `CASE-${String(100 + i).padStart(6, '0')}`,
      title: `queued ${i}`,
      status: 'new',
      risk_score: 80,
      urgency: 2 - i / 100,
      age_minutes: 30,
      assignee: '',
    }));
    apiMocks.get.mockImplementation(
      shiftReport({
        attention_queue: queue,
        sla_aging: {
          enabled: true,
          warn_fraction: 0.75,
          totals: { open: 140, breached: 1, about_to_breach: 0 },
          breached: [{ case_id: 'late', display_id: 'CASE-000999', priority_level: 'P4', age_minutes: 270, target_minutes: 240, overdue_minutes: 30, assignee: 'ana' }],
          about_to_breach: [],
        },
      }),
    );
    board([w('table.attention_queue')]);
    const el = cell('table.attention_queue');
    await waitFor(() => expect(el.textContent).toContain('8 of 140 shown.'));
    const table = el.querySelector('[data-panel-table]') as HTMLElement;
    const firstRow = table.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(firstRow.textContent).toContain('CASE-000999');
    expect(firstRow.textContent).toContain('Response 30m over');
    // Its risk is not in the report: no badge, an honest blank for assistive technology.
    expect(firstRow.textContent).toContain('Not known');
  });

  it('the SLA list says how many there are when the server cut it to the 25 furthest past target', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      case_id: `c${i}`,
      case_number: `CASE-${String(i).padStart(6, '0')}`,
      clock: 'response',
      state: 'breached',
      elapsed_minutes: 200 + i,
      target_minutes: 120,
      over_pct: 70 + i,
      priority: 'P2',
    }));
    fetchPostureMock.mockResolvedValue(
      posture({ sla: { enabled: true, evaluated: 60, response_breached: 18, response_at_risk: 4, resolve_breached: 6, resolve_at_risk: 2, attainment_pct: 50, attainment_reason: '', breaching: rows } }),
    );
    board([w('table.sla_breaches')]);
    const el = cell('table.sla_breaches');
    await waitFor(() => expect(el.textContent).toContain('25 of 30 shown, furthest past target first.'));
  });

  it('a case number is the row\'s primary action: 24 px on a desktop, 44 px on a phone', async () => {
    board([w('table.attention_queue')]);
    const el = cell('table.attention_queue');
    await waitFor(() => expect(el.querySelectorAll('[data-case-link]').length).toBeGreaterThan(0));
    for (const link of el.querySelectorAll('[data-case-link]')) {
      expect(link).toHaveClass('min-h-6', 'max-sm:min-h-11', 'max-sm:inline-flex');
    }
  });
});

describe('laptop widths', () => {
  it('two columns from lg, pairing halves in reading order, then the 12 columns from xl', async () => {
    const widgets = [
      { ...w('kpi.strip', { preset: 'operations' }, 's'), w: 12, h: 3 },
      { ...w('chart.case_trend', {}, 'a'), x: 0, y: 3, w: 8, h: 5 },
      { ...w('gauge.active_risk', {}, 'b'), x: 8, y: 3, w: 4, h: 5 },
      { ...w('chart.backlog_aging', {}, 'c'), x: 0, y: 8, w: 4, h: 5 },
      { ...w('table.top_rules', {}, 'd'), x: 4, y: 8, w: 4, h: 5 },
      { ...w('chart.case_breakdown', {}, 'e'), x: 8, y: 8, w: 4, h: 5 },
    ] as unknown as DashboardWidget[];
    board(widgets);
    const grid = screen.getByTestId('widget-grid-view');
    // Let every lazy body load (and its reads land) before reading the grid.
    await waitFor(() =>
      expect(grid.querySelectorAll('[data-widget-panel], [data-widget-strip]').length).toBe(widgets.length),
    );
    await waitFor(() => expect(grid.querySelector('[aria-busy="true"]')).toBeNull());
    expect(grid).toHaveClass('grid-cols-1', 'lg:grid-cols-2');
    const spans = [...grid.querySelectorAll(':scope > [data-grid-cell]')].map((c) =>
      c.classList.contains('lg:col-span-2') ? 2 : c.classList.contains('lg:col-span-1') ? 1 : 0,
    );
    // Strip full; trend + gauge pair; aging + rules pair; the last half widens (no hole).
    expect(spans).toEqual([2, 1, 1, 1, 1, 2]);
  });
});

describe('AI spend keeps its held figures honest across every read it shows', () => {
  function spendBoard() {
    const widgets = [w('kpi.cost_budget', {}, 'spend')];
    render(
      <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets}>
        <WidgetGrid widgets={widgets} />
        <RefreshProbe />
      </DashboardDataProvider>,
    );
    return () => cell('kpi.cost_budget');
  }

  /** The value beside a definition term in the panel's list. */
  function row(panel: HTMLElement, term: string): string {
    const dt = within(panel).getByText(term);
    return (dt.nextElementSibling as HTMLElement).textContent ?? '';
  }

  it('a budget refresh that fails while usage refreshes says the figures are held, and Retry reads both', async () => {
    const panel = spendBoard();
    await waitFor(() => expect(row(panel(), 'Budget used')).toMatch(/\$1\.00 of \$10\.00 today/));
    expect(panel().querySelector('[data-widget-stale]')).toBeNull();

    apiMocks.get.mockImplementation((path: string) =>
      path === 'budget/status' ? Promise.reject(new Error('503 Service Unavailable')) : fixtureGet(path),
    );
    const usageBefore = apiMocks.usageSummary.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
    // Usage refreshed fine; the budget did not, so its held line is said to be held.
    await waitFor(() => expect(apiMocks.usageSummary.mock.calls.length).toBeGreaterThan(usageBefore));
    await waitFor(() => expect(panel().querySelector('[data-widget-stale="failed"]')).not.toBeNull());
    const note = panel().querySelector('[data-widget-stale]') as HTMLElement;
    expect(note.textContent).toMatch(/^Refresh failed\. Showing figures loaded at .+\./);
    expect(row(panel(), 'Budget used')).toMatch(/\$1\.00 of \$10\.00 today/);

    apiMocks.get.mockImplementation((path: string) => fixtureGet(path));
    const budgetReads = () => apiMocks.get.mock.calls.filter((c) => c[0] === 'budget/status').length;
    const budgetBefore = budgetReads();
    const usageAgain = apiMocks.usageSummary.mock.calls.length;
    fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(budgetReads()).toBeGreaterThan(budgetBefore));
    expect(apiMocks.usageSummary.mock.calls.length).toBeGreaterThan(usageAgain);
    await waitFor(() => expect(panel().querySelector('[data-widget-stale]')).toBeNull());
  });

  it('a per-case refresh that fails says the figures are held, and a per-case read that never landed is not "not measured"', async () => {
    const panel = spendBoard();
    await waitFor(() => expect(row(panel(), 'Per investigated case')).toMatch(/\$/));

    breakdownMock.mockImplementation((q: { kind?: string; by: string }) =>
      q.kind === 'usage' ? Promise.reject(new Error('503 Service Unavailable')) : fixtureBreakdown(q),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
    await waitFor(() => expect(panel().querySelector('[data-widget-stale="failed"]')).not.toBeNull());
    // The held per-case figure stays, under the note.
    expect(row(panel(), 'Per investigated case')).toMatch(/\$/);
  });

  it('a per-case read that failed with nothing held says it could not be loaded', async () => {
    breakdownMock.mockImplementation((q: { kind?: string; by: string }) =>
      q.kind === 'usage' ? Promise.reject(new Error('503 Service Unavailable')) : fixtureBreakdown(q),
    );
    const panel = spendBoard();
    await waitFor(() => expect(row(panel(), 'Per investigated case')).toBe('Could not be loaded'));
  });
});
