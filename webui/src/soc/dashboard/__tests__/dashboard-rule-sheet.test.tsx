/**
 * Rule names on a board (Round 14, SPEC §4.4.4, §4.6.5): Top detection rules and Noisiest
 * rules name each rule as a `RuleLink`, and the whole `WidgetGrid` is ONE rule-sheet host.
 *
 *   - A rule name opens the one rule sheet, saying which panel it was opened from and
 *     reading the population behind the row (the board window's breakdown bounds).
 *   - Every rule link on the board shares that host, so one sheet is open at a time.
 *   - A board refresh that drops the row that opened the sheet (a re-rank on the 60 s
 *     tick) never closes the sheet being read.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

const { breakdownMock, summaryMock, logsMock } = vi.hoisted(() => ({
  breakdownMock: vi.fn(),
  summaryMock: vi.fn(),
  logsMock: vi.fn(),
}));
vi.mock('@/lib/api-dashboards', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-dashboards')>()),
  getMetricsBreakdown: breakdownMock,
}));
vi.mock('@/lib/api-rules', () => ({ getRuleSummary: summaryMock }));
vi.mock('@/soc/UnifiedLogs.api', async (orig) => ({
  ...(await orig<typeof import('@/soc/UnifiedLogs.api')>()),
  fetchUnifiedLogs: logsMock,
}));
vi.mock('@/soc/auth', () => {
  const auth = () => ({ username: 'analyst', hasPermission: () => true, authEnabled: false });
  return { useAuth: auth, useOptionalAuth: auth };
});

import type { DashboardWidget } from '@/lib/types';
import { DashboardDataProvider, useDashboardData } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import { resetRuleSheetStoreForTests } from '@/soc/components/rule-sheet-store';
import { latestFixture, summaryFixture } from '@/soc/components/__tests__/rule-sheet.fixtures';

import { TUNING, breakdown, fixtureGet, group } from './dashboard-fixtures';

function w(type: string, i: string, x: number): DashboardWidget {
  return { i, type, x, y: 0, w: 6, h: 6, options: {} } as unknown as DashboardWidget;
}

const RULES_WEEK = breakdown({
  by: 'rule',
  multi_valued: true,
  window_label: 'Last 168 hours',
  window_from: '2026-10-21T21:00:00Z',
  window_to: '2026-10-28T21:00:00Z',
  groups: [
    group('demo_noisy_scanner', 30, { open_now: 2, verdicted: 30, verdict_fp: 29 }),
    group('demo_rdp_bruteforce', 6, { open_now: 1, verdicted: 0 }),
  ],
});

/** The board's refresh control, as a host renders it. */
function RefreshProbe() {
  const { refresh } = useDashboardData();
  return (
    <button type="button" onClick={refresh}>
      Refresh board
    </button>
  );
}

function renderBoard(widgets: DashboardWidget[]) {
  return render(
    <DashboardDataProvider window="now-7d" objectScoped={false} widgets={widgets}>
      <WidgetGrid widgets={widgets} />
      <RefreshProbe />
    </DashboardDataProvider>,
  );
}

beforeAll(async () => {
  // The sheet is lazy; load its chunk once so a click opens it in the same tick.
  await import('@/soc/components/RuleSheet');
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.get.mockImplementation((path: string) => (path === 'tuning/recommendations' ? Promise.resolve(TUNING) : fixtureGet(path)));
  breakdownMock.mockResolvedValue(RULES_WEEK);
  summaryMock.mockImplementation(async ({ rule }: { rule: string }) => summaryFixture({ rule }));
  logsMock.mockResolvedValue(latestFixture());
});

afterEach(() => {
  act(() => resetRuleSheetStoreForTests());
});

describe('rule names on a board', () => {
  it('open the one rule sheet from the panel, for the population behind the row', async () => {
    renderBoard([w('table.top_rules', 'top', 0)]);
    const links = await screen.findAllByRole('button', { name: 'Open rule demo_noisy_scanner' });
    fireEvent.click(links[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'demo_noisy_scanner' })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription('From Top detection rules');
    await waitFor(() => expect(summaryMock).toHaveBeenCalled());
    const [args] = summaryMock.mock.calls[0] as [{ rule: string; window: string }];
    expect(args.rule).toBe('demo_noisy_scanner');
    // The breakdown's own bounds, so the sheet counts the cases the row counted.
    expect(args.window).toContain('2026-10-21T21:00:00');
  });

  it('share one host across every widget on the board', async () => {
    renderBoard([w('table.top_rules', 'top', 0), w('table.noisy_rules', 'noisy', 6)]);
    await screen.findAllByRole('button', { name: 'Open rule demo_rdp_bruteforce' });
    await waitFor(() =>
      expect(within(document.querySelector('[data-widget-type="table.noisy_rules"]') as HTMLElement).getAllByRole('button', { name: 'Open rule demo_noisy_scanner' }).length).toBeGreaterThan(0),
    );
    const hosts = new Set([...document.querySelectorAll('[data-rule-link]')].map((el) => el.getAttribute('data-rule-host')));
    expect(hosts.size).toBe(1);
    const noisy = document.querySelector('[data-widget-type="table.noisy_rules"]') as HTMLElement;
    fireEvent.click(within(noisy).getAllByRole('button', { name: 'Open rule demo_noisy_scanner' })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleDescription('From Noisiest rules');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('stay open while a refresh drops the row that opened the sheet', async () => {
    renderBoard([w('table.top_rules', 'top', 0)]);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open rule demo_noisy_scanner' }))[0]);
    await screen.findByRole('dialog');
    // The next answer re-ranks the rules and no longer lists the one being read.
    breakdownMock.mockResolvedValue(
      breakdown({ ...RULES_WEEK, groups: [group('demo_rdp_bruteforce', 7, { open_now: 1, verdicted: 0 })] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh board', hidden: true }));
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Open rule demo_noisy_scanner', hidden: true })).toHaveLength(0));
    expect(breakdownMock).toHaveBeenCalledTimes(2);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'demo_noisy_scanner' })).toBeInTheDocument();
  });
});
