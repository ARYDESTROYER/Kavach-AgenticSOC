/**
 * Round 12 P0-8 acceptance, checked against the SERVER's own calendar code: a daily
 * series re-binned in the browser gives exactly the weekly and monthly counts (and the
 * labels, cut edges included) that a server query at the coarser unit returns over the
 * same window, in UTC, a +05:30 zone and a zone with a DST change inside the window
 * (New York, 1 Nov 2026: a 25-hour local day).
 * The fixture is generated from `engine/time_windows.py` (see its header).
 */
import { describe, expect, it } from 'vitest';

import { rebinChart, rebinChoices } from '../charts/rebin';
import { blockTabular } from '../export-helpers';
import { parseBlock } from '../schema';
import type { ChartBlock } from '../schema';
import { REBIN_PARITY } from '../__fixtures__/rebin-parity';
import type { ParityCase } from '../__fixtures__/rebin-parity';

function dailyBlock(c: ParityCase): ChartBlock {
  const b = parseBlock({
    id: `daily-${c.tz}`,
    type: 'chart',
    kind: 'bar',
    provenance: 'code',
    artifact_kind: 'series',
    allowed_views: ['bar', 'line', 'table'],
    unit: 'count',
    x: { kind: 'time', values: c.day.x, labels: c.day.labels, bucket: '1d', tz: c.tz },
    series: [{ key: 'cases', label: 'Cases', values: c.day.counts }],
    last_in_progress: c.day.in_progress[c.day.in_progress.length - 1],
    allowed_rebin: ['1w', '1M'],
  });
  if (b.type !== 'chart') throw new Error(`not a chart: ${JSON.stringify(b)}`);
  return b;
}

describe.each(REBIN_PARITY.map((c) => [c.tz, c] as const))('re-bin parity with the server (%s)', (_tz, c) => {
  const daily = dailyBlock(c);

  it('offers day, week and month for the daily series', () => {
    expect(daily.allowed_rebin).toEqual(['1w', '1M']);
    expect(rebinChoices(daily)).toEqual(['1d', '1w', '1M']);
    // The daily series itself is the server's: same total as every coarser query.
    const total = c.day.counts.reduce((a, b) => a + b, 0);
    expect(c.week.counts.reduce((a, b) => a + b, 0)).toBe(total);
    expect(c.month.counts.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it.each([
    ['1w', 'week'],
    ['1M', 'month'],
  ] as const)('daily → %s equals the server %s query, bucket for bucket', (target, unit) => {
    const server = c[unit];
    const grouped = rebinChart(daily, target);
    expect(grouped.x.bucket).toBe(target);
    expect(grouped.series[0].values).toEqual(server.counts);
    expect(grouped.x.labels).toEqual(server.labels);
    // The current period is still the one in progress, and only that one.
    expect(grouped.last_in_progress).toBe(server.in_progress[server.in_progress.length - 1]);
    expect(server.in_progress.slice(0, -1).every((f) => !f)).toBe(true);
    // Every coarse bucket starts inside the server bucket of the same index.
    grouped.x.values.forEach((v, i) => {
      const at = Date.parse(v);
      expect(at).toBeGreaterThanOrEqual(Date.parse(server.x[i]));
      if (i + 1 < server.x.length) expect(at).toBeLessThan(Date.parse(server.x[i + 1]));
    });
  });

  it('the table and Copy data read the regrouped periods, the current one marked', () => {
    const grouped = rebinChart(daily, '1M');
    const tab = blockTabular(grouped);
    expect(tab?.columns[0].label).toBe(`Period (${c.tz})`);
    expect(tab?.rows.map((r) => r[0])).toEqual(c.month.labels.map((l, i) => (c.month.in_progress[i] ? `${l} (in progress)` : l)));
    expect(tab?.rows.map((r) => r[1])).toEqual(c.month.counts);
  });
});
