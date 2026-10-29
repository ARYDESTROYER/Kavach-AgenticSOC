/**
 * `DashboardDataProvider` request model (Round 14, SPEC §4.4.3, §4.4.5): what a board
 * fetches, with which window, how often, and what it never fetches.
 *
 *   - Requests are named up front by the placed widgets and deduplicated: equal
 *     breakdown queries share one read, different `by` read twice.
 *   - Windowed keys get the board window (`window_hours`); a breakdown gets the hours
 *     token (`now-168h`), the open stock `all`.
 *   - Changing the window refetches every windowed request, not the others.
 *   - A Demo identity switch drops every held answer and reads afresh.
 *   - Row-level scope on (D16): no case-derived key is fetched (a fetch spy), whoever
 *     asks, and every listed case-derived widget shows the scope sentence.
 *   - Never `GET /api/standup` (it runs the model, #6/#7).
 *   - Held figures are never shown as current: a failure holds while the request is read
 *     again (the note and its busy Retry stay, so keyboard focus stays on it), a refresh
 *     that arrives while a read hangs joins it instead of aborting it, and a read that runs
 *     past one refresh interval marks the held figures as not current.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';

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

const demo = vi.hoisted(() => ({ identity: 'off' }));
vi.mock('@/soc/chat/demo-identity', () => ({ useChatDemoIdentity: () => demo.identity }));

import { ApiError } from '@/lib/api';
import { DashboardDataProvider, useDashboardData, useDashboardRequest } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import { CASE_DERIVED_KEYS } from '@/soc/dashboard/widgets/requests';
import { SCOPED_SENTENCE, SCOPE_UNCONFIRMED_MESSAGE } from '@/soc/dashboard/widgets/common';
import type { DashboardWidget } from '@/lib/types';
import type { DashboardWindow } from '@/lib/types-dashboards';

import { BUDGET, CAMPAIGNS, OPEN_BY_VERDICT, TELEMETRY_NONE, USAGE, breakdown, group, noise, posture, sourcesHealth } from './dashboard-fixtures';

function w(type: string, options: Record<string, unknown> = {}, i = type): DashboardWidget {
  return { i, type, x: 0, y: 0, w: 4, h: 3, options } as unknown as DashboardWidget;
}

/** Every `api.get` path the provider reads, answered from fixtures. */
function answerGet(path: string) {
  switch (path) {
    case 'sources/health':
      return Promise.resolve(sourcesHealth(Date.now()));
    case 'standup/report':
      return Promise.resolve({ attention_queue: [], workload: [], sla_aging: { enabled: true, totals: { breached: 1, open: 4 }, breaching: [] } });
    case 'metrics/auto-close-health/recorded':
      return Promise.resolve({ current: { available: false, reason: 'too few decided cases' } });
    case 'budget/status':
      return Promise.resolve(BUDGET);
    case 'campaigns':
      return Promise.resolve(CAMPAIGNS);
    case 'tuning/recommendations':
      return Promise.resolve({ rule_noise: [], recommendations: [], applied: [] });
    case 'tuning/source-recommendations':
      return Promise.resolve(TELEMETRY_NONE);
    default:
      return Promise.reject(new Error(`unexpected GET ${path}`));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  demo.identity = 'off';
  apiMocks.getMetrics.mockResolvedValue({ active_risk_index: 40, active_risk_case_count: 3 });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.get.mockImplementation((path: string) => answerGet(path));
  apiMocks.metricsTrends.mockResolvedValue({ window_hours: 24, bucket_minutes: 60, buckets: [] });
  apiMocks.noiseReduction.mockResolvedValue(noise());
  apiMocks.usageSummary.mockResolvedValue(USAGE);
  apiMocks.getAgentImprovement.mockResolvedValue({ metrics: {}, windows: {} });
  apiMocks.auth.me.mockResolvedValue({ object_scoped: false });
  breakdownMock.mockImplementation((q: { by: string }) => Promise.resolve(q.by === 'verdict' ? OPEN_BY_VERDICT : breakdown({ by: q.by as never })));
  fetchPostureMock.mockResolvedValue(posture());
  fetchMitreMock.mockResolvedValue({ total_techniques: 697, covered_techniques: 4, by_tactic: {}, top_techniques: [], truncated: false });
});

function Probe() {
  const { loading } = useDashboardData();
  return <div data-testid="probe">{loading ? 'loading' : 'settled'}</div>;
}

async function settle() {
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('settled'));
}

/** Sign a viewer in (the scope is then read from `/api/auth/me`); restore the spy after. */
async function signedIn(username: string, role: string) {
  const auth = await import('@/soc/auth');
  return vi.spyOn(auth, 'useOptionalAuth').mockReturnValue({
    authEnabled: true,
    isAuthenticated: true,
    username,
    role,
    hasPermission: () => true,
  } as unknown as ReturnType<typeof auth.useOptionalAuth>);
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

/** The `window_hours` each windowed api call received, by key. */
function breakdownQueries() {
  return breakdownMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

describe('requests named by the placed widgets', () => {
  it('shares one read between equal breakdown queries and reads different ones apart', async () => {
    render(
      <DashboardDataProvider
        window="now-7d"
        objectScoped={false}
        widgets={[
          w('chart.case_breakdown', { by: 'severity' }, 'a'),
          w('chart.case_breakdown', { by: 'severity' }, 'b'),
          w('chart.case_breakdown', { by: 'source' }, 'c'),
        ]}
      >
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    const qs = breakdownQueries();
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => q.by).sort()).toEqual(['severity', 'source']);
    // The hours token for the board window, never `now-7d` (aligned to whole days).
    for (const q of qs) expect(q.window).toBe('now-168h');
  });

  it('F4: the Needs human count reads open cases by verdict over all time', async () => {
    render(
      <DashboardDataProvider window="now-30d" objectScoped={false} widgets={[w('kpi.needs_human')]}>
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    expect(breakdownQueries()).toEqual([expect.objectContaining({ by: 'verdict', status_group: 'open', window: 'all' })]);
    // Never the legacy status count.
    expect(apiMocks.getMetrics).not.toHaveBeenCalled();
  });

  it('passes the board window to every windowed key and none to the others', async () => {
    render(
      <DashboardDataProvider
        window="now-30d"
        objectScoped={false}
        widgets={[
          w('kpi.strip', { preset: 'operations' }),
          w('chart.noise_funnel'),
          w('chart.case_trend'),
          w('kpi.cost_budget'),
          w('table.attention_queue'),
          w('kpi.auto_close_health'),
          w('table.campaigns'),
          w('table.noisy_rules'),
          w('table.telemetry_gaps'),
          w('kpi.lifecycle_timing'),
        ]}
      >
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    expect(fetchPostureMock).toHaveBeenCalledWith(720, 'prev', expect.anything());
    // The open stock (posture over all time) has nothing to compare against.
    expect(fetchPostureMock).toHaveBeenCalledWith(0, '', expect.anything());
    expect(apiMocks.noiseReduction).toHaveBeenCalledWith(720);
    expect(apiMocks.metricsTrends).toHaveBeenCalledWith(720, expect.anything());
    expect(apiMocks.usageSummary).toHaveBeenCalledWith(720);
    expect(apiMocks.get).toHaveBeenCalledWith('standup/report', { window_hours: 0 }, expect.anything());
    expect(apiMocks.get).toHaveBeenCalledWith(
      'metrics/auto-close-health/recorded',
      { window_hours: 720, anchor: 'first' },
      expect.anything(),
    );
    expect(apiMocks.get).toHaveBeenCalledWith('campaigns', undefined, expect.anything());
    expect(apiMocks.get).toHaveBeenCalledWith('tuning/recommendations', undefined, expect.anything());
    expect(apiMocks.get).toHaveBeenCalledWith('tuning/source-recommendations', undefined, expect.anything());
    // The billing standup is never read by a board (#6/#7).
    expect(apiMocks.standup).not.toHaveBeenCalled();
    expect(apiMocks.get.mock.calls.map((c) => c[0])).not.toContain('standup');
  });

  it('changing the window refetches every windowed read and leaves the stock alone', async () => {
    const widgets = [w('kpi.needs_human'), w('chart.case_breakdown', { by: 'rule' }), w('table.campaigns')];
    const { rerender } = render(
      <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets}>
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    expect(breakdownMock).toHaveBeenCalledTimes(2);
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    rerender(
      <DashboardDataProvider window={'now-90d' as DashboardWindow} objectScoped={false} widgets={widgets}>
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    // The rule breakdown reads the new window; the open stock and campaigns are not re-read.
    expect(breakdownMock).toHaveBeenCalledTimes(3);
    expect(breakdownQueries()[2]).toMatchObject({ by: 'rule', window: 'now-2160h' });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
  });

  it('a Demo identity switch reads every request afresh and never shows the old answer', async () => {
    let calls = 0;
    breakdownMock.mockImplementation(() => {
      calls += 1;
      return Promise.resolve(breakdown({ by: 'verdict', status_group: 'open', groups: [{ ...OPEN_BY_VERDICT.groups[0], count: calls === 1 ? 13 : 4 }] }));
    });
    function Count() {
      const a = useDashboardRequest({ key: 'breakdown', window: 'all', query: { by: 'verdict', status_group: 'open' } });
      return <div data-testid="count">{a.data ? String(a.data.groups[0]?.count) : a.loading ? 'loading' : 'none'}</div>;
    }
    const { rerender } = render(
      <DashboardDataProvider objectScoped={false}>
        <Count />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('13'));
    demo.identity = 'demo:run-2';
    rerender(
      <DashboardDataProvider objectScoped={false}>
        <Count />
      </DashboardDataProvider>,
    );
    // The answer read before the switch is never shown under the new identity.
    expect(screen.getByTestId('count')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'));
    expect(breakdownMock).toHaveBeenCalledTimes(2);
  });

  it('an older host that names nothing reads the five Round 5 defaults only', async () => {
    render(
      <DashboardDataProvider objectScoped={false}>
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    expect(apiMocks.getMetrics).toHaveBeenCalledTimes(1);
    expect(fetchPostureMock).toHaveBeenCalledTimes(1);
    expect(fetchMitreMock).toHaveBeenCalledTimes(1);
    expect(apiMocks.listCases).toHaveBeenCalledTimes(1);
    expect(apiMocks.get).toHaveBeenCalledWith('sources/health');
    expect(breakdownMock).not.toHaveBeenCalled();
    expect(apiMocks.noiseReduction).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------- //
// Row-level scope (D16)
// --------------------------------------------------------------------------- //

/** The case-derived widget types of SPEC §4.4.5 that hide whole. */
const WHOLLY_CASE_DERIVED = [
  'chart.case_trend',
  'chart.case_breakdown',
  'chart.severity_trend',
  'chart.backlog_aging',
  'chart.autonomous_vs_human',
  'table.attention_queue',
  'table.workload',
  'table.sla_breaches',
  'table.top_rules',
  'table.top_techniques',
  'table.campaigns',
  'kpi.auto_close_health',
  'kpi.lifecycle_timing',
  'kpi.needs_human',
  'kpi.agent_quality',
  'gauge.active_risk',
  'mitre.heatmap',
] as const;

const CASE_KEY_SPIES = () => [
  apiMocks.getMetrics,
  apiMocks.listCases,
  apiMocks.metricsTrends,
  apiMocks.getAgentImprovement,
  breakdownMock,
  fetchPostureMock,
  fetchMitreMock,
];

describe('row-level scope on (D16)', () => {
  it('fetches no case-derived key and every listed widget shows the scope sentence', async () => {
    const widgets = [
      ...WHOLLY_CASE_DERIVED.map((t) => w(t)),
      w('kpi.strip', { preset: 'detection' }, 'strip'),
      w('chart.noise_funnel'),
      w('kpi.cost_budget'),
      w('table.connector_health'),
      w('table.noisy_rules'),
      w('table.telemetry_gaps'),
    ].map((x, i) => ({ ...x, x: (i % 3) * 4, y: Math.floor(i / 3) * 3 })) as DashboardWidget[];
    render(
      <DashboardDataProvider window="now-7d" objectScoped widgets={widgets}>
        <WidgetGrid widgets={widgets} />
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    // Let every lazy body mount and register what it reads.
    await waitFor(() => expect(screen.getAllByText(/Silent sources|Sources reporting/).length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    for (const spy of CASE_KEY_SPIES()) expect(spy).not.toHaveBeenCalled();
    for (const path of ['standup/report', 'metrics/auto-close-health/recorded', 'campaigns']) {
      expect(apiMocks.get.mock.calls.map((c) => c[0])).not.toContain(path);
    }
    // Not case derived: still read.
    expect(apiMocks.get).toHaveBeenCalledWith('sources/health');
    expect(apiMocks.noiseReduction).toHaveBeenCalledWith(168);
    expect(apiMocks.usageSummary).toHaveBeenCalledWith(168);
    // Every wholly case-derived widget shows the sentence instead of mounting its body.
    for (const t of WHOLLY_CASE_DERIVED) {
      const cell = document.querySelector(`[data-widget-type="${t}"]`);
      expect(cell, t).not.toBeNull();
      expect(cell!.getAttribute('data-widget-gate'), t).toBe('scoped');
      expect(cell!.textContent, t).toContain(SCOPED_SENTENCE);
    }
    // The partial ones hide their case parts only.
    const strip = document.querySelector('[data-widget-type="kpi.strip"]')!;
    expect(strip.textContent).toContain(SCOPED_SENTENCE);
    expect(strip.textContent).toContain('Sources reporting');
    const spend = document.querySelector('[data-widget-type="kpi.cost_budget"]')!;
    await waitFor(() => expect(spend.textContent).toContain(SCOPED_SENTENCE));
  });

  it('a case-derived read asked for by a body directly is not fetched either', async () => {
    function Rogue() {
      const a = useDashboardRequest({ key: 'posture' });
      return <div data-testid="rogue">{a.loading ? 'loading' : a.data ? 'data' : 'none'}</div>;
    }
    render(
      <DashboardDataProvider objectScoped>
        <Rogue />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('rogue')).toHaveTextContent('none'));
    expect(fetchPostureMock).not.toHaveBeenCalled();
  });

  it('every case-derived provider key is guarded', () => {
    expect([...CASE_DERIVED_KEYS].sort()).toEqual(
      ['agentImprovement', 'autoClose', 'breakdown', 'campaigns', 'cases', 'coverage', 'metrics', 'mitre', 'posture', 'shift', 'trends'].sort(),
    );
  });

  it('waits while scope is unknown and reads once /auth/me says it is off', async () => {
    let resolveMe: (v: unknown) => void = () => undefined;
    apiMocks.auth.me.mockReturnValue(new Promise((r) => (resolveMe = r)));
    const auth = await import('@/soc/auth');
    const spy = vi.spyOn(auth, 'useOptionalAuth').mockReturnValue({
      authEnabled: true,
      isAuthenticated: true,
      username: 'ana',
      hasPermission: () => true,
    } as unknown as ReturnType<typeof auth.useOptionalAuth>);
    try {
      render(
        <DashboardDataProvider widgets={[w('kpi.needs_human')]}>
          <Probe />
        </DashboardDataProvider>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(breakdownMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('probe')).toHaveTextContent('loading');
      await act(async () => resolveMe({ object_scoped: false }));
      await settle();
      expect(breakdownMock).toHaveBeenCalledTimes(1);
      expect(apiMocks.auth.me).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed /auth/me read confirms nothing: case panels wait with Retry, never the scope sentence', async () => {
    apiMocks.auth.me.mockRejectedValueOnce(new Error('503')).mockResolvedValue({ object_scoped: false });
    const spy = await signedIn('bo', 'analyst_tier1');
    function Scope() {
      const { objectScoped, scopeError } = useDashboardData();
      return <div data-testid="scope">{`${String(objectScoped)}|${String(scopeError)}`}</div>;
    }
    const widgets = [w('kpi.needs_human', {}, 'n'), { ...w('table.connector_health', {}, 'c'), x: 4 } as DashboardWidget];
    try {
      render(
        <DashboardDataProvider widgets={widgets}>
          <WidgetGrid widgets={widgets} />
          <Scope />
        </DashboardDataProvider>,
      );
      // Not known, and the read failed: never claimed as scoped.
      await waitFor(() => expect(screen.getByTestId('scope')).toHaveTextContent('undefined|true'));
      const cellEl = document.querySelector('[data-widget-type="kpi.needs_human"]')!;
      expect(cellEl.getAttribute('data-widget-gate')).toBe('unconfirmed');
      expect(cellEl.textContent).toContain(SCOPE_UNCONFIRMED_MESSAGE);
      expect(cellEl.textContent).not.toContain(SCOPED_SENTENCE);
      expect(breakdownMock).not.toHaveBeenCalled();
      // A panel that reads no case data is unaffected.
      await waitFor(() => expect(screen.getAllByText('Edge firewall').length).toBeGreaterThan(0));
      // Retry reads the scope again; once it is confirmed off, the case read is made.
      fireEvent.click(within(cellEl as HTMLElement).getByRole('button', { name: /retry/i }));
      await waitFor(() => expect(breakdownMock).toHaveBeenCalledTimes(1));
      expect(apiMocks.auth.me).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(document.querySelector('[data-widget-type="kpi.needs_human"]')!.getAttribute('data-widget-gate')).toBeNull(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('reads the scope again on a refresh, so a scope an administrator turns on hides the case panels', async () => {
    apiMocks.auth.me.mockResolvedValueOnce({ object_scoped: false }).mockResolvedValue({ object_scoped: true });
    const spy = await signedIn('cy', 'soc_manager');
    const widgets = [w('kpi.needs_human', {}, 'n')];
    try {
      render(
        <DashboardDataProvider widgets={widgets}>
          <WidgetGrid widgets={widgets} />
          <RefreshProbe />
        </DashboardDataProvider>,
      );
      await waitFor(() => expect(breakdownMock).toHaveBeenCalledTimes(1));
      expect(document.querySelector('[data-widget-type="kpi.needs_human"]')!.getAttribute('data-widget-gate')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
      await waitFor(() =>
        expect(document.querySelector('[data-widget-type="kpi.needs_human"]')!.getAttribute('data-widget-gate')).toBe('scoped'),
      );
      expect(apiMocks.auth.me).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[data-widget-type="kpi.needs_human"]')!.textContent).toContain(SCOPED_SENTENCE);
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed re-read keeps the answer already confirmed for the viewer', async () => {
    apiMocks.auth.me.mockResolvedValueOnce({ object_scoped: false }).mockRejectedValue(new Error('offline'));
    const spy = await signedIn('di', 'analyst_tier2');
    function Scope() {
      const { objectScoped, scopeError } = useDashboardData();
      return <div data-testid="scope">{`${String(objectScoped)}|${String(scopeError)}`}</div>;
    }
    try {
      render(
        <DashboardDataProvider widgets={[w('kpi.needs_human')]}>
          <Scope />
          <RefreshProbe />
        </DashboardDataProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('scope')).toHaveTextContent('false|false'));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
      await waitFor(() => expect(apiMocks.auth.me).toHaveBeenCalledTimes(2));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(screen.getByTestId('scope')).toHaveTextContent('false|false');
    } finally {
      spy.mockRestore();
    }
  });

  it('a server refusal for row-level scope hides every case panel at once, whatever the host said', async () => {
    breakdownMock.mockRejectedValue(
      new ApiError(409, 'refused', {
        detail: { code: 'breakdown_scope_unsupported', message: 'Breakdowns are not available while row-level scope applies.' },
      }),
    );
    const widgets = [
      w('kpi.needs_human', {}, 'n'),
      { ...w('kpi.lifecycle_timing', {}, 'l'), x: 4 } as DashboardWidget,
      { ...w('table.connector_health', {}, 'c'), x: 8 } as DashboardWidget,
    ];
    render(
      <DashboardDataProvider window="now-7d" objectScoped={false} widgets={widgets}>
        <WidgetGrid widgets={widgets} />
      </DashboardDataProvider>,
    );
    for (const t of ['kpi.needs_human', 'kpi.lifecycle_timing']) {
      await waitFor(() => expect(document.querySelector(`[data-widget-type="${t}"]`)!.getAttribute('data-widget-gate'), t).toBe('scoped'));
      expect(document.querySelector(`[data-widget-type="${t}"]`)!.textContent, t).toContain(SCOPED_SENTENCE);
    }
    // A refusal is not a failure to retry: no load error anywhere on the board.
    expect(document.querySelector('[data-widget-state="error"]')).toBeNull();
    expect(document.querySelector('[data-widget-type="table.connector_health"]')!.getAttribute('data-widget-gate')).toBeNull();
  });
});

describe('older hosts and stored windows', () => {
  it('a host that names keys reads only the ones its role can read', async () => {
    const can = (resource: string) => resource !== 'cases';
    render(
      <DashboardDataProvider objectScoped={false} can={can}>
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    // `metrics` and `cases` both need cases:read: never requested, so no 403 to explain.
    expect(apiMocks.getMetrics).not.toHaveBeenCalled();
    expect(apiMocks.listCases).not.toHaveBeenCalled();
    expect(fetchPostureMock).toHaveBeenCalledTimes(1);
    expect(apiMocks.get).toHaveBeenCalledWith('sources/health');
  });

  it('a stored window that is not one of the four presets falls back to the last 24 hours', async () => {
    function Window() {
      const { windowInfo, windowHours } = useDashboardData();
      return <div data-testid="window">{`${windowInfo.label}|${windowHours}`}</div>;
    }
    render(
      <DashboardDataProvider window={'now-1y' as DashboardWindow} objectScoped={false} widgets={[w('chart.case_breakdown', { by: 'rule' })]}>
        <Window />
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    expect(screen.getByTestId('window')).toHaveTextContent('Last 24 hours|24');
    expect(breakdownQueries()).toEqual([expect.objectContaining({ by: 'rule', window: 'now-24h' })]);
  });
});

describe('role gates', () => {
  it('a widget the role cannot read is not fetched and says so', async () => {
    const can = (resource: string) => resource !== 'metrics';
    const widgets = [w('kpi.needs_human', {}, 'n'), { ...w('table.connector_health', {}, 'c'), x: 4 } as DashboardWidget];
    render(
      <DashboardDataProvider objectScoped={false} can={can} widgets={widgets}>
        <WidgetGrid widgets={widgets} />
        <Probe />
      </DashboardDataProvider>,
    );
    await settle();
    const denied = document.querySelector('[data-widget-type="kpi.needs_human"]')!;
    expect(denied.getAttribute('data-widget-gate')).toBe('denied');
    expect(denied.textContent).toContain('No access');
    expect(breakdownMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText('Edge firewall').length).toBeGreaterThan(0));
  });
});


describe('a refresh that fails while earlier figures are held', () => {
  it('keeps the figures under one line that says so, with the time they were read, and Retry reads again', async () => {
    const widgets = [w('table.top_rules', {}, 'r')];
    breakdownMock.mockImplementation((q: { by: string }) =>
      Promise.resolve(breakdown({ by: q.by as never, multi_valued: true, groups: [group('ssh_bruteforce', 9, { open_now: 1 })] })),
    );
    render(
      <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets}>
        <WidgetGrid widgets={widgets} />
        <RefreshProbe />
        <Probe />
      </DashboardDataProvider>,
    );
    const panel = () => document.querySelector('[data-widget-type="table.top_rules"]') as HTMLElement;
    await waitFor(() => expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0));
    expect(panel().querySelector('[data-widget-stale]')).toBeNull();

    // The 60 s tick or the refresh control re-reads, and the store does not answer.
    breakdownMock.mockRejectedValue(new Error('503 Service Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
    await waitFor(() => expect(panel().querySelector('[data-widget-stale]')).not.toBeNull());
    const note = panel().querySelector('[data-widget-stale]') as HTMLElement;
    expect(note.textContent).toMatch(/Refresh failed\. Showing figures loaded at .+\./);
    expect(note.getAttribute('role')).toBe('status');
    // The figures read earlier stay on screen; nothing replaces them with an error.
    expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0);
    expect(panel().querySelector('[data-widget-state="error"]')).toBeNull();

    // Retry reads that panel again; a good answer clears the note.
    breakdownMock.mockImplementation((q: { by: string }) => Promise.resolve(breakdown({ by: q.by as never, groups: [] })));
    const before = breakdownMock.mock.calls.length;
    fireEvent.click(within(note).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(breakdownMock.mock.calls.length).toBe(before + 1));
    await waitFor(() => expect(panel().querySelector('[data-widget-stale]')).toBeNull());
  });

  it('the KPI strip names the figures it kept and offers one Retry', async () => {
    const widgets = [w('kpi.strip', { preset: 'operations' }, 's')];
    render(
      <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets}>
        <WidgetGrid widgets={widgets} />
        <RefreshProbe />
        <Probe />
      </DashboardDataProvider>,
    );
    const strip = () => document.querySelector('[data-widget-type="kpi.strip"]') as HTMLElement;
    await settle();
    await waitFor(() => expect(within(strip()).getByTestId('kpi-strip-new_cases').textContent).toMatch(/\d/));
    const shown = within(strip()).getByTestId('kpi-strip-new_cases').textContent;
    expect(strip().querySelector('[data-strip-failure]')).toBeNull();

    fetchPostureMock.mockRejectedValue(new Error('503 Service Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
    await waitFor(() => expect(strip().querySelector('[data-strip-failure]')).not.toBeNull());
    const line = strip().querySelector('[data-strip-failure]') as HTMLElement;
    // Open now, New cases and Closed all read the posture rollup.
    expect(line.textContent).toMatch(/^3 figures could not be refreshed\. Showing figures loaded at .+\./);
    // The kept figure is still the one read before.
    expect(within(strip()).getByTestId('kpi-strip-new_cases').textContent).toBe(shown);

    fetchPostureMock.mockResolvedValue(posture());
    const before = fetchPostureMock.mock.calls.length;
    fireEvent.click(within(line).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchPostureMock.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(strip().querySelector('[data-strip-failure]')).toBeNull());
  });
});

/** A read the test answers when it chooses (a backend that hangs until then). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let React and the pending promises run for `ms` of real time. */
async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('held figures while the backend hangs (never shown as current)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function topRulesBoard(props: { refreshIntervalMs?: number } = {}) {
    const widgets = [w('table.top_rules', {}, 'r')];
    render(
      <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets} refreshIntervalMs={props.refreshIntervalMs}>
        <WidgetGrid widgets={widgets} />
        <RefreshProbe />
      </DashboardDataProvider>,
    );
    return () => document.querySelector('[data-widget-type="table.top_rules"]') as HTMLElement;
  }

  function answerRules(name: string) {
    breakdownMock.mockImplementation((q: { by: string }) =>
      Promise.resolve(breakdown({ by: q.by as never, multi_valued: true, groups: [group(name, 9, { open_now: 1 })] })),
    );
  }

  it('a Retry that never answers keeps the note, the held figures and keyboard focus on a busy Retry', async () => {
    answerRules('ssh_bruteforce');
    const panel = topRulesBoard();
    await waitFor(() => expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0));

    breakdownMock.mockRejectedValue(new Error('503 Service Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
    await waitFor(() => expect(panel().querySelector('[data-widget-stale="failed"]')).not.toBeNull());

    // The store now hangs: every read never answers.
    breakdownMock.mockImplementation(() => new Promise(() => {}));
    const note = panel().querySelector('[data-widget-stale]') as HTMLElement;
    const button = within(note).getByRole('button', { name: 'Retry' });
    button.focus();
    const before = breakdownMock.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() => expect(breakdownMock.mock.calls.length).toBe(before + 1));
    await wait(30);

    // The note is still there and still says the refresh failed, over the held figures.
    expect(panel().querySelector('[data-widget-stale="failed"]')).toBe(note);
    expect(note.textContent).toMatch(/^Refresh failed\. Showing figures loaded at .+\./);
    expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0);
    // Retry kept its place and focus; it is busy, not disabled (a disabled button would drop focus).
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAccessibleName('Retrying');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    // Busy is said in words, never by a second spinner (RefreshButton is the only one).
    expect(button.querySelector('svg')?.getAttribute('class') ?? '').not.toMatch(/animate-spin/);
    // A second press while it reads does not start another read.
    fireEvent.click(button);
    await wait(30);
    expect(breakdownMock.mock.calls.length).toBe(before + 1);

    // The refresh control (or the tick) while the read hangs: it joins that read, nothing
    // is aborted or read again, and the note stays over the held figures.
    const signal = breakdownMock.mock.calls[before][1] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
    await wait(30);
    expect(breakdownMock.mock.calls.length).toBe(before + 1);
    expect(signal.aborted).toBe(false);
    expect(panel().querySelector('[data-widget-stale="failed"]')).not.toBeNull();
    expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0);
  });

  it('a refresh that hangs is said to be taking longer once it runs past one interval, and still lands', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    answerRules('ssh_bruteforce');
    const panel = topRulesBoard({ refreshIntervalMs: 120 });
    await waitFor(() => expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0));

    // The next tick's read hangs (no error ever comes back).
    const slow = deferred<ReturnType<typeof breakdown>>();
    breakdownMock.mockImplementation(() => slow.promise);
    const before = breakdownMock.mock.calls.length;
    await waitFor(() => expect(breakdownMock.mock.calls.length).toBe(before + 1));
    const signal = breakdownMock.mock.calls[before][1] as AbortSignal;

    // Past one interval with no answer: the held figures are marked, never shown as current.
    await waitFor(() => expect(panel().querySelector('[data-widget-stale="slow"]')).not.toBeNull(), { timeout: 2000 });
    const note = panel().querySelector('[data-widget-stale]') as HTMLElement;
    expect(note.textContent).toMatch(/^Refresh is taking longer than usual\. Showing figures loaded at .+\./);
    expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0);
    // Nothing failed, so there is nothing to retry yet.
    expect(within(note).queryByRole('button')).toBeNull();

    // Later ticks join the hung read: it is never aborted and the store is not hit again.
    await wait(400);
    expect(breakdownMock.mock.calls.length).toBe(before + 1);
    expect(signal.aborted).toBe(false);

    // The slow read lands at last: its figures show and the note goes.
    slow.resolve(breakdown({ by: 'rule' as never, multi_valued: true, groups: [group('rdp_bruteforce', 4, { open_now: 1 })] }));
    await waitFor(() => expect(within(panel()).getAllByText('rdp_bruteforce').length).toBeGreaterThan(0));
    await waitFor(() => expect(panel().querySelector('[data-widget-stale]')).toBeNull());
  });

  it('an interval that is not a finite positive number turns auto refresh off rather than firing at once', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    answerRules('ssh_bruteforce');
    const panel = topRulesBoard({ refreshIntervalMs: Number.POSITIVE_INFINITY });
    await waitFor(() => expect(within(panel()).getAllByText('ssh_bruteforce').length).toBeGreaterThan(0));
    const reads = breakdownMock.mock.calls.length;
    await wait(80);
    // No tick re-read the board, and nothing was marked as taking longer than usual.
    expect(breakdownMock.mock.calls.length).toBe(reads);
    expect(panel().querySelector('[data-widget-stale]')).toBeNull();
  });

  it('a first read that failed stays a load error while it is read again, with focus on a busy Retry', async () => {
    breakdownMock.mockRejectedValue(new Error('503 Service Unavailable'));
    const panel = topRulesBoard();
    await waitFor(() => expect(panel().querySelector('[data-widget-state="error"]')).not.toBeNull());

    breakdownMock.mockImplementation(() => new Promise(() => {}));
    const state = panel().querySelector('[data-widget-state="error"]') as HTMLElement;
    const button = within(state).getByRole('button', { name: 'Retry' });
    button.focus();
    const before = breakdownMock.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() => expect(breakdownMock.mock.calls.length).toBe(before + 1));
    await wait(30);

    // Not a skeleton: the error and its Retry stay, so focus is not dropped to the page.
    expect(panel().querySelector('[data-widget-state="loading"]')).toBeNull();
    expect(panel().querySelector('[data-widget-state="error"]')).toBe(state);
    expect(state).toHaveAttribute('aria-busy', 'true');
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAccessibleName('Retrying');
    fireEvent.click(button);
    await wait(30);
    expect(breakdownMock.mock.calls.length).toBe(before + 1);
  });

  it('the KPI strip keeps its failure line and a busy Retry while the failed reads are read again', async () => {
    const widgets = [w('kpi.strip', { preset: 'operations' }, 's')];
    render(
      <DashboardDataProvider window="now-24h" objectScoped={false} widgets={widgets}>
        <WidgetGrid widgets={widgets} />
        <RefreshProbe />
        <Probe />
      </DashboardDataProvider>,
    );
    const strip = () => document.querySelector('[data-widget-type="kpi.strip"]') as HTMLElement;
    await settle();
    await waitFor(() => expect(within(strip()).getByTestId('kpi-strip-new_cases').textContent).toMatch(/\d/));
    const shown = within(strip()).getByTestId('kpi-strip-new_cases').textContent;

    fetchPostureMock.mockRejectedValue(new Error('503 Service Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board' }));
    await waitFor(() => expect(strip().querySelector('[data-strip-failure]')).not.toBeNull());

    fetchPostureMock.mockImplementation(() => new Promise(() => {}));
    const line = strip().querySelector('[data-strip-failure]') as HTMLElement;
    const button = within(line).getByRole('button', { name: 'Retry' });
    button.focus();
    const before = fetchPostureMock.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() => expect(fetchPostureMock.mock.calls.length).toBeGreaterThan(before));
    await wait(30);

    expect(strip().querySelector('[data-strip-failure]')).toBe(line);
    expect(line.textContent).toMatch(/^3 figures could not be refreshed\. Showing figures loaded at .+\./);
    expect(within(strip()).getByTestId('kpi-strip-new_cases').textContent).toBe(shown);
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAccessibleName('Retrying');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });
});
