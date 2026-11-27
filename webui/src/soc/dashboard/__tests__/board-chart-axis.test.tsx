/**
 * Board charts on the chart kit's one time axis (Round 14 closing acceptance, FX5c):
 *
 *   - qa1-09: a weekly breakdown reads the day each week starts ("Oct 5"), never "W41
 *     2026"; the tooltip and the table still name the ISO week.
 *   - a breakdown's hours and days become the kit's time axis, so its ticks are dated by
 *     the same rule as the trends charts on the same board.
 *   - qa1-03: "Alerts and cases over time" draws two charts on one day axis: both plots
 *     start at the same x, so the same bucket sits at the same place in both.
 *   - qa2-05, integ-03: "Cases by severity over time" stacks all five named levels.
 *   - review (FX5c fix): an hourly breakdown ticks on the same regular hours as a trends
 *     chart (00:00, 06:00, 12:00, 18:00 read in the axis's own clock), never on odd hours;
 *     every board chart shares one y-gutter floor, so two charts over the same buckets
 *     line up whatever their highest tick; and a board chart has no brush zoom, so no
 *     zoom row and no "Drag across the chart to zoom" hint (SPEC §4.4.4).
 *   - second review: a breakdown's buckets are operator-zone wall clocks, so its chart's
 *     accessible name claims no zone, while a trends chart (UTC) names UTC; and a daily
 *     chart ticks on the Mondays a weekly chart beside it names (never epoch Thursdays).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

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

import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import type { DashboardWidget } from '@/lib/types';
import type { MetricsBreakdown } from '@/lib/types-dashboards';

import { BOARD_Y_AXIS_CHARS, breakdownAxis, bucketDisplayLabel, bucketFullLabel } from '../widgets/chart';
import { breakdownXAxis } from '../widgets/trend';
import { breakdown, fixtureGet, group, trends } from './dashboard-fixtures';

describe('breakdown buckets on the kit time axis', () => {
  it('reads a week by the day it starts and keeps the ISO week in the full label (qa1-09)', () => {
    expect(bucketDisplayLabel('W41 2026')).toBe('Oct 5');
    expect(bucketDisplayLabel('W01 2026')).toBe('Dec 29');
    expect(bucketFullLabel('W41 2026')).toBe('Week of Oct 5 (W41 2026)');
    expect(bucketDisplayLabel('21 Oct 2026')).toBe('Oct 21');
    expect(bucketDisplayLabel('27 Oct 21:00')).toBe('Oct 27 21:00');
    expect(bucketFullLabel('21 Oct 2026')).toBe('Oct 21');
    expect(bucketDisplayLabel('Other text')).toBe('Other text');
  });

  it('turns weekly, daily and hourly buckets into the kit time axis', () => {
    const weeks = breakdownAxis({ bucket: 'week', buckets: [{ label: 'W41 2026' }, { label: 'W42 2026' }] });
    expect(weeks).toMatchObject({
      kind: 'time',
      bucket: '1w',
      values: ['2026-10-05T00:00:00Z', '2026-10-12T00:00:00Z'],
      labels: ['Week of Oct 5 (W41 2026)', 'Week of Oct 12 (W42 2026)'],
      label: 'Week',
    });
    expect(weeks).not.toHaveProperty('tz');
    expect(breakdownAxis({ bucket: 'day', buckets: [{ label: '21 Oct 2026' }] })).toMatchObject({
      values: ['2026-10-21T00:00:00Z'],
      labels: ['Oct 21'],
      label: 'Day',
    });
    // An hour label has no year: it comes from the window's end, counted back over New Year.
    const hours = breakdownAxis({
      bucket: 'hour',
      buckets: [{ label: '31 Dec 23:00' }, { label: '1 Jan 00:00' }],
      window_to: '2027-01-01T00:30:00Z',
    });
    expect(hours?.values).toEqual(['2026-12-31T23:00:00Z', '2027-01-01T00:00:00Z']);
    expect(hours?.labels).toEqual(['Dec 31 23:00', 'Jan 1 00:00']);
  });

  it('keeps a category axis for any label the server grammar does not hold', () => {
    expect(breakdownAxis({ bucket: 'day', buckets: [{ label: '31 Feb 2026' }] })).toBeNull();
    expect(breakdownAxis({ bucket: 'hour', buckets: [{ label: '21 Oct 2026' }] })).toBeNull();
    expect(breakdownAxis({ bucket: null, buckets: [{ label: '21 Oct 2026' }] })).toBeNull();
    const b = breakdown({ by: 'verdict', bucket: 'day' as never, buckets: [{ label: 'odd', in_progress: false, other_count: null }] });
    expect(breakdownXAxis(b)).toEqual({ kind: 'category', values: ['odd'] });
  });
});

// --------------------------------------------------------------------------- //
// Rendered on a board
// --------------------------------------------------------------------------- //

function w(type: string, options: Record<string, unknown> = {}, i = type): DashboardWidget {
  return { i, type, x: 0, y: 0, w: 8, h: 4, options } as unknown as DashboardWidget;
}

function board(widgets: DashboardWidget[], window: 'now-24h' | 'now-168h' | 'now-720h' = 'now-720h') {
  return render(
    <DashboardDataProvider window={window} objectScoped={false} widgets={widgets}>
      <WidgetGrid widgets={widgets} />
    </DashboardDataProvider>,
  );
}

/** Five weeks of verdicts, the newest still filling (the Executive board's Outcomes over time). */
function weeklyVerdicts(): MetricsBreakdown {
  const labels = ['W41 2026', 'W42 2026', 'W43 2026', 'W44 2026', 'W45 2026'];
  return breakdown({
    by: 'verdict',
    bucket: 'week' as never,
    window_label: 'Last 30 days',
    buckets: labels.map((label, i) => ({ label, in_progress: i === labels.length - 1, other_count: null })),
    groups: labels.flatMap((label, i) => [
      { ...group('TRUE_POSITIVE', i + 1, { verdict_tp: i + 1 }), bucket: label },
      { ...group('NEEDS_HUMAN', 2), bucket: label },
    ]),
  });
}

/** Thirty-one days of severities with only Critical, High, Medium and Low present. */
function dailySeverity(): MetricsBreakdown {
  const start = Date.UTC(2026, 9, 5);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const labels = Array.from({ length: 31 }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  });
  return breakdown({
    by: 'severity',
    bucket: 'day' as never,
    window_label: 'Last 30 days',
    buckets: labels.map((label, i) => ({ label, in_progress: i === labels.length - 1, other_count: null })),
    groups: labels.flatMap((label, i) =>
      ['critical', 'high', 'medium', 'low'].map((k, j) => ({ ...group(k, (i + j) % 3), bucket: label })),
    ),
  });
}

/** Seven days of trends in 6-hour buckets (the Detection and data health board). */
function weekTrends() {
  const start = Date.parse('2026-10-28T12:00:00Z');
  const buckets = Array.from({ length: 29 }, (_, i) => ({
    ...trends(1).buckets[0],
    t: new Date(start + i * 21_600_000).toISOString(),
    new_cases: i % 5,
    alerts: 150 + (i % 4) * 20,
  }));
  return { window_hours: 168, bucket_minutes: 360, generated_at: '2026-11-04T14:00:00Z', buckets, truncated: false };
}

const xTicks = (svg: Element) =>
  Array.from(svg.querySelectorAll('text[text-anchor="middle"]:not([data-testid])')).map((t) => ({ x: t.getAttribute('x'), text: t.textContent }));

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.get.mockImplementation((path: string) => fixtureGet(path));
  apiMocks.metricsTrends.mockImplementation(() => Promise.resolve(weekTrends()));
  breakdownMock.mockImplementation((q: { by: string; bucket?: string }) =>
    Promise.resolve(q.by === 'severity' ? dailySeverity() : weeklyVerdicts()),
  );
});

describe('board charts', () => {
  it('Outcomes over time reads weeks by their first day, never an ISO week code (qa1-09)', async () => {
    const { container } = board([w('chart.case_trend', { series: 'outcomes', bucket: 'week' })]);
    await waitFor(() => expect(container.querySelector('svg[data-plot-x]')).not.toBeNull());
    const ticks = xTicks(container.querySelector('svg[data-plot-x]') as Element).map((t) => t.text);
    expect(ticks.join(' ')).not.toMatch(/W\d{2}/);
    expect(ticks[0]).toBe('Oct 5');
    expect(ticks[ticks.length - 1]).toBe('Nov 2');
    // The week stays identifiable in the data table.
    expect(container.querySelector('[data-testid="chart-data-table"]')).toHaveTextContent('Week of Oct 5 (W41 2026)');
  });

  it('Cases by severity over time stacks all five levels and marks only the newest day in progress', async () => {
    const { container } = board([w('chart.severity_trend')]);
    await waitFor(() => expect(container.querySelector('svg[data-plot-x]')).not.toBeNull());
    const legend = container.querySelector('ul');
    expect(Array.from(legend?.querySelectorAll('li') ?? []).map((li) => li.textContent?.trim())).toEqual([
      'Critical',
      'High',
      'Medium',
      'Low',
      'Info',
    ]);
    const svg = container.querySelector('svg[data-plot-x]') as Element;
    const ticks = xTicks(svg);
    expect(ticks[ticks.length - 1].text).toBe('Nov 4');
    expect(ticks.map((t) => t.text)).not.toContain('Nov 2');
    expect(svg.querySelector('[data-testid="chart-in-progress"]')).toHaveTextContent('(in progress)');
    // Operator-zone buckets written as UTC instants: the name claims no zone (never "UTC").
    expect(container.querySelector('[data-testid="chart-stacked_bar-plot"]')?.getAttribute('aria-label')).toBe(
      'Cases by severity over time. Stacked column chart, count.',
    );
  });

  it('ticks a daily breakdown on the Mondays the weekly chart beside it names (second review)', async () => {
    const { container } = board([
      w('chart.severity_trend', {}, 'sev'),
      w('chart.case_trend', { series: 'outcomes', bucket: 'week' }, 'out'),
    ]);
    await waitFor(() => expect(container.querySelectorAll('svg[data-plot-x]')).toHaveLength(2));
    const [daily, weekly] = Array.from(container.querySelectorAll('svg[data-plot-x]')).map((svg) => xTicks(svg).map((t) => t.text));
    expect(weekly).toEqual(['Oct 5', 'Oct 12', 'Oct 19', 'Oct 26', 'Nov 2']);
    // Every regular daily tick is one of those Mondays; the last is the newest day's own.
    expect(daily.length).toBeGreaterThanOrEqual(3);
    for (const text of daily.slice(0, -1)) expect(weekly).toContain(text);
    expect(daily[daily.length - 1]).toBe('Nov 4');
  });

  it('Alerts and cases over time lines both charts up on one dated day axis (qa1-03)', async () => {
    const { container } = board([w('chart.case_trend', { series: 'alerts' })], 'now-168h');
    await waitFor(() => expect(container.querySelectorAll('svg[data-plot-x]')).toHaveLength(2));
    const [alerts, cases] = Array.from(container.querySelectorAll('svg[data-plot-x]'));
    expect(alerts.getAttribute('data-plot-x')).toBe(cases.getAttribute('data-plot-x'));
    expect(alerts.getAttribute('data-plot-width')).toBe(cases.getAttribute('data-plot-width'));
    expect(xTicks(alerts)).toEqual(xTicks(cases));
    const texts = xTicks(alerts).map((t) => t.text);
    expect(texts).not.toContain('00:00');
    expect(texts[0]).toMatch(/^[A-Z][a-z]{2} \d{1,2}/);
    // A trends chart is cut in UTC and says so in its accessible name.
    for (const plot of Array.from(container.querySelectorAll('[data-testid$="-plot"][aria-label]'))) {
      expect(plot.getAttribute('aria-label')).toMatch(/, UTC\.$/);
    }
    expect(container.querySelectorAll('[data-testid$="-plot"][aria-label]')).toHaveLength(2);
  });
});

/** A day of hourly buckets from "3 Nov 20:00" to "4 Nov 20:00", the newest still filling. */
function hourlyBreakdown(by: 'severity' | 'verdict', peak: number): MetricsBreakdown {
  const start = Date.UTC(2026, 10, 3, 20);
  const labels = Array.from({ length: 25 }, (_, i) => {
    const d = new Date(start + i * 3_600_000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    return `${d.getUTCDate()} Nov ${hh}:00`;
  });
  const key = by === 'severity' ? 'high' : 'TRUE_POSITIVE';
  return breakdown({
    by,
    bucket: 'hour' as never,
    window_label: 'Last 24 hours',
    window_from: '2026-11-03T20:30:00Z',
    window_to: '2026-11-04T20:30:00Z',
    buckets: labels.map((label, i) => ({ label, in_progress: i === labels.length - 1, other_count: null })),
    groups: labels.map((label, i) => ({ ...group(key, i === 6 ? peak : i % 2), bucket: label })),
  });
}

describe('board charts over the same buckets (review, FX5c fix)', () => {
  it('ticks an hourly breakdown on the regular hours, dated by the one rule', async () => {
    breakdownMock.mockImplementation((q: { by: string }) => Promise.resolve(hourlyBreakdown(q.by === 'severity' ? 'severity' : 'verdict', 4)));
    const { container } = board([w('chart.severity_trend')], 'now-24h');
    await waitFor(() => expect(container.querySelector('svg[data-plot-x]')).not.toBeNull());
    const texts = xTicks(container.querySelector('svg[data-plot-x]') as Element).map((t) => t.text);
    // Before the fix: "Nov 3 20:00", "Nov 4 01:00", "06:00", "11:00", "16:00", "20:00".
    expect(texts).toEqual(['Nov 4', '06:00', '12:00', '20:00']);
  });

  it('starts every board chart over the same buckets at the same x, whatever its highest tick', async () => {
    // Severity peaks at 38 (ticks up to "40"), outcomes at 4 (ticks up to "4").
    breakdownMock.mockImplementation((q: { by: string }) =>
      Promise.resolve(q.by === 'severity' ? hourlyBreakdown('severity', 38) : hourlyBreakdown('verdict', 4)),
    );
    const { container } = board(
      [w('chart.severity_trend', {}, 'sev'), w('chart.case_trend', { series: 'outcomes' }, 'out')],
      'now-24h',
    );
    await waitFor(() => expect(container.querySelectorAll('svg[data-plot-x]')).toHaveLength(2));
    const [severity, outcomes] = Array.from(container.querySelectorAll('svg[data-plot-x]'));
    expect(severity.getAttribute('data-plot-x')).toBe(outcomes.getAttribute('data-plot-x'));
    expect(severity.getAttribute('data-plot-width')).toBe(outcomes.getAttribute('data-plot-width'));
    expect(xTicks(severity)).toEqual(xTicks(outcomes));
    expect(BOARD_Y_AXIS_CHARS).toBe(4);
  });

  it('draws no zoom row and no zoom hint on a board line chart (SPEC §4.4.4)', async () => {
    const { container } = board([w('chart.case_trend', { series: 'flow' })], 'now-168h');
    await waitFor(() => expect(container.querySelector('svg[data-plot-x]')).not.toBeNull());
    expect(container.querySelector('[data-board-chart="line"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chart-zoom-hint"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart-zoom-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart-controls"]')).toBeNull();
    // The keyboard instructions do not offer a zoom the board does not have.
    expect(container.textContent ?? '').not.toMatch(/to zoom/i);
  });
});
