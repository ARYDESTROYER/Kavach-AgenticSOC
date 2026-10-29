/**
 * Cost: spend over time on the range's own time axis (Round 14 W8a review).
 *
 * The ledger returns only the hours that had spend (`cost_over_time`), so the page places
 * them on the range's hourly grid before charting or comparing: empty hours count as
 * zero, the chart's axis is linear in time, and "second half of the range against the
 * first" compares real halves of the range, not halves of a list of non-empty buckets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/soc/demo', () => ({ useDemo: () => ({ active: false }) }));

const usageSummary = vi.fn();
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: { usageSummary: (h: number) => usageSummary(h) },
}));

import Cost, { spendStats, spendTimeline, trendDelta } from '../Cost';
import { resetAnalyticsWindowForTests } from '../analytics-shared';

const HOUR = 3_600_000;
/** A fixed "now" in the middle of an hour. */
const NOW = Date.UTC(2026, 9, 29, 13, 25, 0);
const HOUR_START = Date.UTC(2026, 9, 29, 13, 0, 0);

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

describe('spendTimeline', () => {
  it('places sparse hourly spend on the range grid, zero-filled, ending at the current hour', () => {
    const points = [
      { ts: HOUR_START - 20 * HOUR, cost: 1 },
      { ts: HOUR_START - 2 * HOUR, cost: 0.5 },
    ];
    const t = spendTimeline(points, 24, NOW)!;
    expect(t.unit).toBe('hour');
    // 24 hours back from the current hour, both ends included.
    expect(t.hourly).toHaveLength(25);
    expect(t.buckets).toHaveLength(25);
    expect(t.hourly[4]).toBe(1);
    expect(t.hourly[22]).toBe(0.5);
    expect(t.hourly.filter((v) => v === 0)).toHaveLength(23);
    // Hour labels are distinct, so the chart's categories never merge.
    expect(new Set(t.buckets.map((b) => b.x)).size).toBe(25);
  });

  it('charts a longer range by local day and keeps every cent of the range', () => {
    const points = [
      { ts: HOUR_START - 150 * HOUR, cost: 1 },
      { ts: HOUR_START - 50 * HOUR, cost: 3 },
    ];
    const t = spendTimeline(points, 168, NOW)!;
    expect(t.unit).toBe('day');
    expect(t.hourly).toHaveLength(169);
    // 168 hours always touch eight local calendar days.
    expect(t.buckets).toHaveLength(8);
    expect(sum(t.buckets.map((b) => b.y))).toBe(4);
    expect(t.buckets.filter((b) => b.y > 0)).toHaveLength(2);
  });

  it('clamps a point outside the grid (clock skew) to the nearest edge instead of dropping it', () => {
    const t = spendTimeline(
      [
        { ts: HOUR_START - 30 * HOUR, cost: 2 },
        { ts: HOUR_START + 3 * HOUR, cost: 5 },
        { ts: Number.NaN, cost: 9 },
      ],
      24,
      NOW,
    )!;
    expect(t.hourly[0]).toBe(2);
    expect(t.hourly[24]).toBe(5);
    expect(sum(t.hourly)).toBe(7);
  });

  it('is null when the server sends no series', () => {
    expect(spendTimeline(undefined, 24, NOW)).toBeNull();
  });
});

describe('spendStats', () => {
  it('averages over the range length, never over the partial edge buckets', () => {
    // $7 spread over a 7-day range is $1 a day, though the range touches 8 calendar days.
    const week = spendTimeline(
      Array.from({ length: 7 }, (_, i) => ({ ts: HOUR_START - (12 + 24 * i) * HOUR, cost: 1 })),
      168,
      NOW,
    )!;
    expect(week.buckets).toHaveLength(8);
    expect(spendStats(week)).toEqual({ total: 7, avg: 1, peak: 1 });
    // $24 over a 24-hour range is $1 an hour, though the grid holds 25 hourly slots.
    const day = spendTimeline(
      Array.from({ length: 24 }, (_, i) => ({ ts: HOUR_START - i * HOUR, cost: 1 })),
      24,
      NOW,
    )!;
    expect(day.hourly).toHaveLength(25);
    expect(spendStats(day).avg).toBe(1);
    // 30 days touch 31 calendar days; the mean is still over 30.
    const month = spendTimeline([{ ts: HOUR_START - 100 * HOUR, cost: 30 }], 720, NOW)!;
    expect(month.buckets.length).toBeGreaterThan(30);
    expect(spendStats(month).avg).toBe(1);
  });

  it('is all zero without a timeline', () => {
    expect(spendStats(null)).toEqual({ total: 0, avg: 0, peak: 0 });
  });
});

describe('trendDelta', () => {
  it('compares real halves of the range, not halves of the non-empty buckets', () => {
    // Two buckets 100 hours apart in a 7-day range: one in each half of the range.
    const t = spendTimeline(
      [
        { ts: HOUR_START - 150 * HOUR, cost: 1 },
        { ts: HOUR_START - 50 * HOUR, cost: 3 },
      ],
      168,
      NOW,
    )!;
    expect(trendDelta(t.hourly)).toBe(200);
    // Both in the last two days: the first half of the range had no spend, so there is
    // nothing honest to compare against.
    const late = spendTimeline(
      [
        { ts: HOUR_START - 40 * HOUR, cost: 1 },
        { ts: HOUR_START - 10 * HOUR, cost: 3 },
      ],
      168,
      NOW,
    )!;
    expect(trendDelta(late.hourly)).toBeUndefined();
  });

  it('needs at least four hours of grid', () => {
    expect(trendDelta([1, 2, 3])).toBeUndefined();
  });
});

describe('Cost spend over time', () => {
  beforeEach(() => {
    resetAnalyticsWindowForTests();
    usageSummary.mockReset();
  });

  it('charts the range by day and states the change against the first half of the range', async () => {
    const now = Date.now();
    const hour = Math.floor(now / HOUR) * HOUR;
    usageSummary.mockResolvedValue({
      total_cost: 4,
      total_tokens: 1000,
      call_count: 4,
      today_cost: 0,
      currency: 'USD',
      cost_over_time: [
        { ts: hour - 150 * HOUR, cost: 1 },
        { ts: hour - 50 * HOUR, cost: 3 },
      ],
      by_model: [{ key: 'claude-x', cost: 4, tokens: 1000, calls: 4 }],
    });
    render(<Cost />);
    const trend = await screen.findByRole('region', { name: 'Spend over time' });
    expect(trend).toHaveTextContent('last 7 days, by day');
    expect(within(trend).getByRole('img', { name: 'Spend per day over the last 7 days' })).toBeInTheDocument();
    expect(trend).toHaveTextContent('Per day');
    expect(trend).toHaveTextContent('Peak day');
    const total = within(screen.getByTestId('cost-kpi-strip')).getByTestId('kpi-cost-total');
    expect(total).toHaveTextContent('+200%');
    expect(total).toHaveTextContent('second half of the range against the first');
  });

  it('reads Per day as the range total over the days of the range', async () => {
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    usageSummary.mockResolvedValue({
      total_cost: 7,
      total_tokens: 7000,
      call_count: 7,
      today_cost: 1,
      currency: 'USD',
      cost_over_time: Array.from({ length: 7 }, (_, i) => ({ ts: hour - (12 + 24 * i) * HOUR, cost: 1 })),
      by_model: [{ key: 'claude-x', cost: 7, tokens: 7000, calls: 7 }],
    });
    render(<Cost />);
    const trend = await screen.findByRole('region', { name: 'Spend over time' });
    const perDay = within(trend).getByText('Per day');
    // $7 over 7 days is $1.00 a day, not $7 over the 8 calendar days the range touches.
    expect(perDay.nextElementSibling).toHaveTextContent('$1.00');
    expect(within(trend).getByText('Range total').nextElementSibling).toHaveTextContent('$7.00');
  });

  it('says there is nothing to chart when the range had no spend over time', async () => {
    usageSummary.mockResolvedValue({
      total_cost: 0.5,
      total_tokens: 10,
      call_count: 1,
      today_cost: 0,
      currency: 'USD',
      cost_over_time: [],
      by_model: [{ key: 'claude-x', cost: 0.5, tokens: 10, calls: 1 }],
    });
    render(<Cost />);
    const trend = await screen.findByRole('region', { name: 'Spend over time' });
    expect(trend).toHaveTextContent('No spend over this range to chart.');
  });
});
