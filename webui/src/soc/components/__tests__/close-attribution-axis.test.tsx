/**
 * The Human vs AI chart's x axis follows the chart kit's one time-axis rule (Round 14
 * closing fixes, FX6f; the rule is src/soc/chat/blocks/charts/x-axis.ts):
 *
 *   - the first shown tick, and every tick that starts a new UTC day, names its day
 *     ("Nov 4 06:00", "Nov 5" for a bucket at midnight); a later tick on the same day
 *     reads its hour ("12:00"). A 24-hour board used to label its first tick "06:00",
 *     with no day at all;
 *   - ticks a week or more apart follow the calendar, as the kit charts beside it do:
 *     Mondays, every other Monday, the first of each month. They used to land on epoch
 *     multiples, so a 30-day board read Thursdays (Oct 8, 15, 22, 29, Nov 5);
 *   - the rule holds on a board of any length: a 7-day board's midnight tick reads
 *     "Oct 30", not "Oct 30 00:00" (the long label used to cost it ticks, so it ticked at
 *     other positions from the kit chart beside it);
 *   - the chart builds its tick texts from each bucket's start, never from the caller's
 *     label, so the Cyber Defence Center card (bare clocks, "07-01 06:00") and a board
 *     widget tick the same; the label is only the fallback for a bucket with no start;
 *   - over the same buckets at the same width, this chart and the kit's `layoutXAxis`
 *     pick the same ticks with the same texts.
 *
 * jsdom lays nothing out, so the chart draws at its 480 x 180 fallback size.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { MetricsTrendBucket, MetricsTrends } from '@/lib/types';
import type { TimeBucket } from '@/soc/chat/blocks/schema';
import { layoutXAxis, onTickStep as kitOnTickStep } from '@/soc/chat/blocks/charts/x-axis';
import { humanVsAiSeries } from '@/soc/dashboard/widgets/mix';
import {
  CloseAttributionChart,
  layoutXLabels,
  onTickStep,
  xTickTexts,
  type CloseAttributionBand,
} from '../CloseAttributionChart';
import type { HumanVsAiPoint } from '../HumanVsAiCard';
import { token } from '../palette';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const BANDS: CloseAttributionBand[] = [
  { key: 'ai', label: 'AI agent', color: token('chart-1') },
  { key: 'human', label: 'Human', color: token('chart-2') },
  { key: 'system', label: 'System', color: token('chart-8') },
];

/** A trends payload of `count` buckets from `startIso`, as GET /api/metrics/trends answers it. */
function trends(startIso: string, count: number, bucketMinutes: number, windowHours: number): MetricsTrends {
  const start = Date.parse(startIso);
  const buckets = Array.from(
    { length: count },
    (_, i): MetricsTrendBucket => ({
      t: new Date(start + i * bucketMinutes * 60_000).toISOString(),
      new_cases: 3,
      closed: 2,
      auto_closed: 1,
      human_closed: 1,
      system_closed: 0,
      false_positives: 1,
      needs_human: 0,
      escalated: 0,
      sent_to_human: 0,
      fp_rate: 50,
      alerts: 10,
    }),
  );
  return {
    window_hours: windowHours,
    bucket_minutes: bucketMinutes,
    // After the last bucket ends: no bucket is still filling.
    generated_at: new Date(start + (count + 1) * bucketMinutes * 60_000).toISOString(),
    buckets,
    truncated: false,
    store_total: count * 3,
    fetched: count * 3,
  };
}

function series(payload: MetricsTrends): HumanVsAiPoint[] {
  const out = humanVsAiSeries(payload);
  if (!out) throw new Error('the fixture reports the close split, so a series is expected');
  return out;
}

function renderedTicks(points: HumanVsAiPoint[]): string[] {
  render(<CloseAttributionChart points={points} bands={BANDS} ariaLabel="Cases closed by the agent versus by a human" />);
  return screen.getAllByTestId('human-vs-ai-x-tick').map((t) => t.textContent ?? '');
}

describe('Human vs AI x axis: dated ticks', () => {
  it('a 24-hour board dates its first tick and the tick that starts the next day', () => {
    const points = series(trends('2026-11-04T06:00:00Z', 24, 60, 24));
    expect(renderedTicks(points)).toEqual(['Nov 4 06:00', '12:00', '18:00', 'Nov 5']);
  });

  it('keeps the tooltip range in full UTC words (the bucket labels do not reach it)', () => {
    const points = series(trends('2026-11-04T06:00:00Z', 24, 60, 24));
    expect(points[0].x).toBe('Nov 4 06:00');
    expect(points[18].x).toBe('Nov 5');
    render(<CloseAttributionChart points={points} bands={BANDS} ariaLabel="Cases closed by the agent versus by a human" />);
    // The screen-reader table reads the same range the tooltip does.
    const rows = screen.getByTestId('human-vs-ai-table').querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('Nov 4, 06:00–07:00 UTC');
    expect(rows[18].textContent).toContain('Nov 5, 00:00–01:00 UTC');
  });

  it('a 7-day board names a midnight by its day alone, as the kit charts beside it do', () => {
    expect(renderedTicks(series(trends('2026-10-29T06:00:00Z', 28, 360, 168)))).toEqual([
      'Oct 30',
      'Nov 1',
      'Nov 3',
      'Nov 5',
    ]);
  });

  it('a 72-hour board of 3-hour buckets ticks each midnight by its day', () => {
    expect(renderedTicks(series(trends('2026-11-02T12:00:00Z', 24, 180, 72)))).toEqual([
      'Nov 3',
      'Nov 4',
      'Nov 5',
    ]);
  });

  it('labels a bucket the same on a board of any length', () => {
    const day = series(trends('2026-10-28T18:00:00Z', 2, 360, 24));
    const week = series(trends('2026-10-28T18:00:00Z', 2, 360, 168));
    expect(day.map((p) => p.x)).toEqual(['Oct 28 18:00', 'Oct 29']);
    expect(week.map((p) => p.x)).toEqual(day.map((p) => p.x));
  });

  it('dates a caller\'s bare clock labels from the bucket start (the Cyber Defence Center card)', () => {
    const points: HumanVsAiPoint[] = Array.from({ length: 4 }, (_, i) => {
      const start = Date.parse('2026-07-01T05:00:00Z') + i * HOUR_MS;
      return {
        x: new Date(start).toISOString().slice(11, 16),
        ai: 1,
        human: 1,
        system: 0,
        start: new Date(start).toISOString(),
        end: new Date(start + HOUR_MS).toISOString(),
      };
    });
    // The first tick used to read a bare "05:00", with no day anywhere on the axis.
    expect(renderedTicks(points)).toEqual(['Jul 1 05:00', '06:00', '07:00', '08:00']);
  });

  it('reads a caller\'s "07-01 06:00" labels in the kit\'s one day format', () => {
    // The Cyber Defence Center writes "MM-DD HH:mm" on a board longer than a day: a second
    // day format beside the kit's "Jul 1". The chart reads the bucket start instead.
    const at = (iso: string): HumanVsAiPoint => ({
      x: `${iso.slice(5, 10)} ${iso.slice(11, 16)}`,
      ai: 1,
      human: 0,
      system: 0,
      start: iso,
    });
    const points = [at('2026-07-01T00:00:00Z'), at('2026-07-01T06:00:00Z'), at('2026-07-02T00:00:00Z')];
    expect(renderedTicks(points)).toEqual(['Jul 1', '06:00', 'Jul 2']);
  });

  it('reads daily buckets as their day whatever the caller labels them', () => {
    const at = (iso: string): HumanVsAiPoint => ({ x: iso.slice(5, 10), ai: 1, human: 0, system: 0, start: iso });
    const points = [at('2026-07-01T00:00:00Z'), at('2026-07-02T00:00:00Z'), at('2026-07-03T00:00:00Z')];
    expect(xTickTexts(points, [0, 1, 2])).toEqual(['Jul 1', 'Jul 2', 'Jul 3']);
  });

  it('reads a lone bucket by its own span: a day, or an hour that names its day', () => {
    const lone = (start: string, end: string): HumanVsAiPoint[] => [
      { x: 'own label', ai: 1, human: 0, system: 0, start, end },
    ];
    expect(xTickTexts(lone('2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z'), [0])).toEqual(['Jul 1']);
    expect(xTickTexts(lone('2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z'), [0])).toEqual(['Jul 1']);
    expect(xTickTexts(lone('2026-07-01T05:00:00Z', '2026-07-01T06:00:00Z'), [0])).toEqual(['Jul 1 05:00']);
  });

  it('tells two years\' same date apart: a tick a year on is a new day', () => {
    const at = (iso: string): HumanVsAiPoint => ({ x: '', ai: 1, human: 0, system: 0, start: iso });
    const points = [at('2025-11-04T06:00:00Z'), at('2025-11-04T12:00:00Z'), at('2026-11-04T12:00:00Z')];
    expect(xTickTexts(points, [0, 1, 2])).toEqual(['Nov 4 06:00', '12:00', 'Nov 4 12:00']);
  });

  it('reads a later tick on the same day as its hour, and lets an undated tick name nothing', () => {
    const at = (iso: string, x: string): HumanVsAiPoint => ({ x, ai: 1, human: 0, system: 0, start: iso });
    const points = [
      at('2026-11-04T06:00:00Z', 'Nov 4 06:00'),
      at('2026-11-04T12:00:00Z', 'Nov 4 12:00'),
      { x: 'bucket 3', ai: 1, human: 0, system: 0, start: null },
      at('2026-11-04T18:00:00Z', 'Nov 4 18:00'),
      at('2026-11-05T00:00:00Z', 'Nov 5'),
      at('2026-11-05T06:00:00Z', 'Nov 5 06:00'),
    ];
    const texts = xTickTexts(points, [0, 1, 2, 3, 4, 5]);
    // After a tick that cannot be placed, the next one names its day again.
    expect(texts).toEqual(['Nov 4 06:00', '12:00', 'bucket 3', 'Nov 4 18:00', 'Nov 5', '06:00']);
    // Only the shown ticks are read: the first SHOWN tick is the one that is dated.
    const sparse = xTickTexts(points, [1, 5]);
    expect(sparse[1]).toBe('Nov 4 12:00');
    expect(sparse[5]).toBe('Nov 5 06:00');
  });

  it('never draws two labels over each other, and still dates the first at a board cell width', () => {
    const points = series(trends('2026-11-04T06:00:00Z', 24, 60, 24));
    for (const width of [160, 200, 235, 320, 480, 740]) {
      const x0 = 15;
      const slot = (width - x0) / points.length;
      const labels = layoutXLabels(points, (i) => x0 + (i + 0.5) * slot, width);
      expect(labels.length).toBeGreaterThan(0);
      // The first shown tick names its day.
      expect(labels[0].text).toMatch(/^Nov \d+( \d{2}:\d{2})?$/);
      for (let k = 1; k < labels.length; k += 1) {
        const left = labels[k].x - (labels[k].text.length * 6.6) / 2;
        const right = labels[k - 1].x + (labels[k - 1].text.length * 6.6) / 2;
        expect(left).toBeGreaterThanOrEqual(right + 5);
      }
      for (const l of labels) {
        expect(l.x - (l.text.length * 6.6) / 2).toBeGreaterThanOrEqual(-1);
        expect(l.x + (l.text.length * 6.6) / 2).toBeLessThanOrEqual(width + 1);
      }
    }
  });
});

describe('Human vs AI x axis: the same ticks as the chart kit', () => {
  /** The kit bucket a board widget passes for a trends `bucket_minutes` (chart.tsx `trendsBucket`). */
  const KIT_BUCKET: Record<number, TimeBucket | undefined> = { 60: '1h', 360: '6h', 1440: '1d' };
  const CASES: Array<[string, string, number, number, number]> = [
    ['24 hours from 11:00', '2026-11-04T11:00:00Z', 24, 60, 24],
    ['24 hours from midnight', '2026-11-04T00:00:00Z', 24, 60, 24],
    ['72 hours of 3-hour buckets', '2026-11-02T12:00:00Z', 24, 180, 72],
    ['7 days from 06:00', '2026-10-29T06:00:00Z', 28, 360, 168],
    ['7 days from 12:00', '2026-10-29T12:00:00Z', 29, 360, 168],
    ['30 days', '2026-10-07T00:00:00Z', 31, 1440, 720],
    ['90 days', '2026-08-07T00:00:00Z', 91, 1440, 2160],
  ];

  for (const [name, start, count, bucketMinutes, windowHours] of CASES) {
    it(`picks the kit's ticks over ${name}, at every board cell width`, () => {
      const points = series(trends(start, count, bucketMinutes, windowHours));
      for (const width of [205, 240, 330, 480, 740]) {
        const x0 = 15;
        const slot = (width - x0) / count;
        const centre = (i: number) => x0 + (i + 0.5) * slot;
        const ours = layoutXLabels(points, centre, width).map(({ index, text }) => ({ index, text }));
        // The kit's own in-progress tick is left out: this chart marks the filling bucket
        // in its column and tooltip instead.
        const kit = layoutXAxis({
          x: { kind: 'time', values: points.map((p) => p.start as string), bucket: KIT_BUCKET[bucketMinutes], tz: 'UTC' },
          centre,
          width,
          plotWidth: width - x0,
        }).ticks.map(({ index, text }) => ({ index, text }));
        expect({ width, ticks: ours }).toEqual({ width, ticks: kit });
      }
    });
  }
});

describe('Human vs AI x axis: calendar steps', () => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** The UTC weekday of a 2026 "Oct 12" tick (0 is Sunday). */
  const weekday = (label: string) => {
    const [month, day] = label.split(' ');
    return new Date(Date.UTC(2026, MONTHS.indexOf(month), Number(day))).getUTCDay();
  };

  it('a 30-day daily board that starts on a Thursday ticks on Mondays', () => {
    // Oct 8 2026 is a Thursday: epoch-aligned weekly ticks read Oct 8, 15, 22, 29, Nov 5.
    expect(new Date('2026-10-08T00:00:00Z').getUTCDay()).toBe(4);
    const ticks = renderedTicks(series(trends('2026-10-08T00:00:00Z', 30, 1440, 720)));
    expect(ticks).toEqual(['Oct 12', 'Oct 19', 'Oct 26', 'Nov 2']);
    for (const t of ticks) expect(weekday(t)).toBe(1);
  });

  it('a 90-day daily board ticks on the first of each month', () => {
    const ticks = renderedTicks(series(trends('2026-08-07T00:00:00Z', 90, 1440, 2160)));
    expect(ticks).toEqual(['Sep 1', 'Oct 1', 'Nov 1']);
  });

  it('picks every other Monday for a fortnightly step', () => {
    const start = Date.parse('2026-08-03T00:00:00Z'); // a Monday
    const mondays = Array.from({ length: 10 }, (_, k) => start + k * 7 * DAY_MS);
    const fortnightly = mondays.filter((ms) => onTickStep(ms, 336));
    expect(fortnightly).toHaveLength(5);
    expect(new Set(fortnightly.map((ms) => new Date(ms).getUTCDay()))).toEqual(new Set([1]));
    for (let k = 1; k < fortnightly.length; k += 1) expect(fortnightly[k] - fortnightly[k - 1]).toBe(14 * DAY_MS);
  });

  it('matches the chart kit predicate it copies, at every step it uses', () => {
    const hours = [1, 2, 3, 4, 6, 12, 24, 48, 72, 168, 336, 720];
    // Every 3 hours across two years, plus instants before the epoch.
    const from = Date.parse('1969-12-01T00:00:00Z');
    const instants: number[] = [];
    for (let ms = from; ms < from + 30 * DAY_MS; ms += 3 * HOUR_MS) instants.push(ms);
    const later = Date.parse('2025-12-01T00:00:00Z');
    for (let ms = later; ms < later + 730 * DAY_MS; ms += 3 * HOUR_MS) instants.push(ms);
    const mismatches: string[] = [];
    for (const h of hours) {
      for (const ms of instants) {
        if (onTickStep(ms, h) !== kitOnTickStep(ms, h * 60)) mismatches.push(`${new Date(ms).toISOString()} @ ${h}h`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
