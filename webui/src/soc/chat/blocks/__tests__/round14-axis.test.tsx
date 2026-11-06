/**
 * Round 14 closing acceptance (FX5c): the chart kit's one time-axis rule and its line-end
 * labels, for every Cartesian chart (chat answers, board widgets, the rule sheet, the
 * image export).
 *
 *   - qa1-03, qa2-04, composites-01: the first tick and every tick that starts a new day
 *     carry the day ("Nov 2 12:00", "Nov 2"); a later tick on the same day its time only;
 *     no axis of sub-day buckets reads "00:00" or "12:00" alone throughout.
 *   - qa1-09: a weekly bucket reads the day its week starts, never an ISO week code.
 *   - qa2-06: "(in progress)" sits under the newest bucket's own tick and under no other.
 *   - qa1-02: line-end labels never overlap each other, the "(in progress)" note or the
 *     plot edge; where they cannot fit, the legend names the series.
 *   - review (FX5c fix): the regular clock-time ticks (00:00, 06:00, 12:00, 18:00) are read
 *     in the axis's own clock, so a labelled axis (the rule sheet, a board breakdown) and a
 *     local calendar axis tick on the same hours as a trends chart; a span label ("Aug 7
 *     to Sep 5") ticks at the day it starts; a board chart can turn brush zoom off.
 *   - second review: ticks a week or more apart follow the calendar (Mondays, then the
 *     first of each month), so a daily and a weekly chart name the same days; the note is
 *     centred under the newest tick on a line chart too (its end labels stay above the
 *     baseline); a leader never runs across a series' unmeasured newest buckets; a week's
 *     full name says the day it starts; the accessible name names a zone only when known.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => vi.fn() }));

import { CartesianChart, type CartesianKind, yAxisOf } from '../charts/CartesianChart';
import { ChartControlsContext, type ChartControls } from '../charts/export-context';
import { chartSvg } from '../charts/export-svg';
import { CHAR_W, END_LABEL_LINE, spreadLabels } from '../charts/geometry';
import { IN_PROGRESS_NOTE, layoutXAxis, onTickStep, tickMoments, tickTexts, type XAxisLayout } from '../charts/x-axis';
import { isoWeekStartMs, shortCalendarLabel, weekFullLabel, weekStartDay, xPositionLabel, xRangeLabel, xTickLabel } from '../format';
import { parseBlock, type ChartBlock, type TimeBucket } from '../schema';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const series = (start: string, n: number, stepMs: number) => Array.from({ length: n }, (_, i) => iso(Date.parse(start) + i * stepMs));

type Box = [number, number];
const boxOf = (x: number, text: string, charW = CHAR_W): Box => [x - (text.length * charW) / 2, x + (text.length * charW) / 2];
const overlaps = (a: Box, b: Box) => a[0] < b[1] && b[0] < a[1];

/** Lay out an axis the way a 560 px chart with a 40 px gutter does. */
function axis(values: string[], bucket: TimeBucket | undefined, opts: { width?: number; labels?: string[]; tz?: string; inProgress?: boolean } = {}) {
  const width = opts.width ?? 560;
  const x0 = 40;
  const plotW = width - x0 - 8;
  const slot = plotW / values.length;
  const centre = (i: number) => x0 + (i + 0.5) * slot;
  const layout = layoutXAxis({
    x: { kind: 'time', values, ...(bucket ? { bucket } : {}), ...(opts.labels ? { labels: opts.labels } : {}), tz: opts.tz ?? 'UTC' },
    centre,
    width,
    plotWidth: plotW,
    inProgress: opts.inProgress ?? false,
  });
  return { layout, width };
}

/** No two tick labels overlap, none leaves the figure, and the note sits only under the last tick. */
function expectClean({ ticks, inProgress }: XAxisLayout, width: number, n: number) {
  for (let k = 1; k < ticks.length; k += 1) {
    expect(overlaps(boxOf(ticks[k - 1].x, ticks[k - 1].text), boxOf(ticks[k].x, ticks[k].text)), `${ticks[k - 1].text} / ${ticks[k].text}`).toBe(false);
  }
  for (const t of ticks) {
    const [l, r] = boxOf(t.x, t.text);
    expect(l).toBeGreaterThanOrEqual(-0.5);
    expect(r).toBeLessThanOrEqual(width + 0.5);
  }
  if (inProgress) {
    expect(ticks[ticks.length - 1].index).toBe(n - 1);
    const note = boxOf(inProgress.x, IN_PROGRESS_NOTE);
    for (const t of ticks.slice(0, -1)) expect(overlaps(note, boxOf(t.x, t.text)), `note under ${t.text}`).toBe(false);
  }
}

/**
 * The one time-axis rule over shown ticks: the first tick names its day, and a tick that
 * shows its time only follows a tick of the same day (read from the axis's values in UTC).
 */
function expectDated({ ticks }: XAxisLayout, values: readonly string[]) {
  const dayOf = (i: number) => values[i].slice(0, 10);
  const bareClock = /^\d{2}:\d{2}$/;
  expect(ticks[0].text, 'first tick').not.toMatch(bareClock);
  for (let k = 1; k < ticks.length; k += 1) {
    if (bareClock.test(ticks[k].text)) expect(dayOf(ticks[k - 1].index), ticks[k].text).toBe(dayOf(ticks[k].index));
    else expect(ticks[k].text).toMatch(/^[A-Z][a-z]{2} \d{1,2}( \d{2}:\d{2})?$/);
  }
}

describe('the one time-axis rule', () => {
  it('dates the 7-day board in 6-hour buckets: no tick reads "00:00" alone (qa1-03)', () => {
    const values = series('2026-10-28T12:00:00Z', 29, 6 * HOUR);
    for (const width of [800, 560, 330]) {
      const { layout } = axis(values, '6h', { width, inProgress: true });
      const texts = layout.ticks.map((t) => t.text);
      expect(texts.some((t) => t === '00:00')).toBe(false);
      expect(texts[0]).toMatch(/^[A-Z][a-z]{2} \d{1,2}( \d{2}:\d{2})?$/);
      expectClean(layout, width, values.length);
    }
    const { layout } = axis(values, '6h', { width: 800, inProgress: true });
    expect(layout.ticks.map((t) => t.text)).toEqual(['Oct 30', 'Nov 1', 'Nov 3', 'Nov 4 12:00']);
  });

  it('names the day on the first tick and on each new day, the time only after that', () => {
    const values = series('2026-11-03T14:00:00Z', 25, HOUR);
    const { layout } = axis(values, '1h', { width: 800, inProgress: true });
    expect(layout.ticks.map((t) => t.text)).toEqual(['Nov 3 18:00', 'Nov 4', '06:00', '14:00']);
    expectClean(layout, 800, values.length);
    // The rule itself, on any set of shown positions.
    const x = { kind: 'time' as const, values, bucket: '1h' as const };
    expect(tickTexts(x, [0, 4, 10, 11]).filter(Boolean)).toEqual(['Nov 3 14:00', '18:00', 'Nov 4', '01:00']);
  });

  it('dates every tick of a 12 h series that starts at noon, with no schema bucket (qa2-04, composites-01)', () => {
    const values = series('2026-11-01T12:00:00Z', 7, 12 * HOUR);
    const labels = values.map((v) => `label ${v}`);
    for (const width of [700, 420, 330]) {
      const { layout } = axis(values, undefined, { width, labels, inProgress: true });
      expectDated(layout, values);
      expectClean(layout, width, values.length);
    }
    // The rule sheet's axis (UTC, with labels) ticks on its midnights, as a plain UTC axis
    // does, each naming its day; the newest bucket keeps its own tick, the same day's noon.
    // Before the review fix a labelled axis took evenly stepped noons.
    expect(axis(values, undefined, { width: 700, labels }).layout.ticks.map((t) => t.text)).toEqual(['Nov 2', 'Nov 3', 'Nov 4']);
    expect(axis(values, undefined, { width: 700 }).layout.ticks.map((t) => t.text)).toEqual(['Nov 2', 'Nov 3', 'Nov 4']);
    expect(axis(values, undefined, { width: 700, labels, inProgress: true }).layout.ticks.map((t) => t.text)).toEqual([
      'Nov 2',
      'Nov 3',
      'Nov 4',
      '12:00',
    ]);
  });

  it('ticks a labelled hourly axis on the same regular hours as a plain one (a board breakdown)', () => {
    // A breakdown: each bucket's wall-clock start written as an instant, with labels, no zone.
    const values = series('2026-11-03T20:00:00Z', 25, HOUR);
    const labels = values.map((v) => `label ${v}`);
    const x = { kind: 'time' as const, values, bucket: '1h' as const, labels };
    const centre = (i: number) => 40 + (i + 0.5) * (712 / 25);
    const labelled = layoutXAxis({ x, centre, width: 760, plotWidth: 712, inProgress: true });
    const plain = layoutXAxis({ x: { ...x, labels: undefined, tz: 'UTC' }, centre, width: 760, plotWidth: 712, inProgress: true });
    // Before the fix: "Nov 3 20:00", "Nov 4 01:00", "06:00", "11:00", "16:00", "20:00".
    expect(labelled.ticks.map((t) => t.text)).toEqual(['Nov 4', '06:00', '12:00', '20:00']);
    expect(labelled.ticks).toEqual(plain.ticks);
    expectDated(labelled, values);
  });

  it('reads the regular clock times in the axis zone, so a local axis ticks on its own midnights', () => {
    // Hourly buckets of a local day in Asia/Kolkata (UTC+05:30): local midnight is 18:30 UTC.
    const values = Array.from({ length: 25 }, (_, i) => iso(Date.parse('2026-11-03T14:30:00Z') + i * HOUR));
    const labels = values.map((v) => `label ${v}`);
    const { layout } = axis(values, '1h', { width: 800, labels, tz: 'Asia/Kolkata' });
    const texts = layout.ticks.map((t) => t.text);
    // Local 20:00 on Nov 3 is the first bucket; the regular ticks are local 00, 06, 12, 18.
    expect(texts).toEqual(['Nov 4', '06:00', '12:00', '18:00']);
    expect(tickMoments({ kind: 'time', values, bucket: '1h', labels, tz: 'Asia/Kolkata' })[4]).toMatchObject({
      day: 'Nov 4',
      clock: '00:00',
      wall: Date.UTC(2026, 10, 4),
    });
  });

  it('ticks a span label at the day it starts (the rule sheet\'s 30-day buckets)', () => {
    expect(shortCalendarLabel('Aug 7 to Sep 5', undefined)).toBe('Aug 7');
    expect(shortCalendarLabel('Nov 3, 2024 to Dec 2, 2024', undefined)).toBe('Nov 3, 2024');
    // Server period labels never read as spans.
    expect(shortCalendarLabel('Mar 2026', '1M')).toBe('Mar 2026');
    expect(shortCalendarLabel('Jul 2026 (from 12 Jul)', '1M')).toBe('Jul 2026');
    const values = ['2026-08-07T00:00:00+00:00', '2026-09-06T00:00:00+00:00', '2026-10-06T00:00:00+00:00'];
    const x = { kind: 'time' as const, values, labels: ['Aug 7 to Sep 5', 'Sep 6 to Oct 5', 'Oct 6 to Nov 4'], tz: 'UTC' };
    expect(values.map((_, i) => xTickLabel(x, i))).toEqual(['Aug 7', 'Sep 6', 'Oct 6']);
    const { layout } = axis(values, undefined, { width: 560, labels: x.labels, inProgress: true });
    expect(layout.ticks.map((t) => t.text)).toEqual(['Aug 7', 'Sep 6', 'Oct 6']);
  });

  it('puts "(in progress)" under the newest daily bar, never under an earlier tick (qa2-06)', () => {
    // 31 daily buckets with weekly-spaced ticks: before the fix the note slid under "Nov 2".
    const values = series('2026-10-05T00:00:00Z', 31, DAY);
    for (const width of [800, 560, 330]) {
      const { layout } = axis(values, '1d', { width, labels: values.map((v) => v.slice(0, 10)), inProgress: true });
      expect(layout.ticks[layout.ticks.length - 1]).toMatchObject({ index: 30, text: 'Nov 4' });
      expect(layout.ticks.map((t) => t.text)).not.toContain('Nov 2');
      expectClean(layout, width, values.length);
    }
  });

  it('reads a week by the day it starts, never its ISO week code (qa1-09)', () => {
    expect(weekStartDay('W41 2026')).toBe('Oct 5');
    expect(weekStartDay('W01 2026')).toBe('Dec 29');
    expect(weekStartDay('W53 2026')).toBe('Dec 28');
    expect(weekStartDay('W53 2025')).toBeNull();
    expect(weekStartDay('Week 41')).toBeNull();
    expect(isoWeekStartMs(2026, 41)).toBe(Date.UTC(2026, 9, 5));
    const values = ['2026-10-05T00:00:00+05:30', '2026-10-12T00:00:00+05:30', '2026-10-19T00:00:00+05:30'];
    const labels = ['W41 2026', 'W42 2026', 'W43 2026'];
    const { layout } = axis(values, '1w', { labels, tz: 'Asia/Kolkata' });
    // Local Mondays in the axis's own zone, not the UTC day before.
    expect(layout.ticks.map((t) => t.text)).toEqual(['Oct 5', 'Oct 12', 'Oct 19']);
  });

  it('steps a week or more by the calendar: Mondays, then the first of each month (second review)', () => {
    // Epoch multiples put weekly ticks on Thursdays (1 Jan 1970 was one) and 30-day ones
    // on any date: "Oct 8, Oct 15, ..." over a weekly chart reading "Oct 5, Oct 12, ...".
    const month = series('2026-10-06T00:00:00Z', 31, DAY);
    expect(axis(month, '1d', { width: 800 }).layout.ticks.map((t) => t.text)).toEqual(['Oct 12', 'Oct 19', 'Oct 26', 'Nov 2']);
    const quarter = series('2026-08-07T00:00:00Z', 91, DAY);
    expect(axis(quarter, '1d', { width: 800 }).layout.ticks.map((t) => t.text)).toEqual(['Sep 1', 'Oct 1', 'Nov 1']);
    // Hours over a month tick on its Mondays' midnights too.
    const hourly = series('2026-10-06T00:00:00Z', 30 * 24, HOUR);
    expect(axis(hourly, '1h', { width: 800 }).layout.ticks.map((t) => t.text)).toEqual(['Oct 12', 'Oct 19', 'Oct 26', 'Nov 2']);
    // In the axis zone: a local Monday, not the UTC Sunday evening before it.
    const local = Array.from({ length: 31 }, (_, i) => iso(Date.parse('2026-10-05T18:30:00Z') + i * DAY));
    expect(axis(local, '1d', { width: 800, labels: local.map((v) => v), tz: 'Asia/Kolkata' }).layout.ticks.map((t) => t.text)).toEqual([
      'Oct 12',
      'Oct 19',
      'Oct 26',
      'Nov 2',
    ]);
    expect(onTickStep(Date.UTC(2026, 9, 12), 7 * 1440)).toBe(true);
    expect(onTickStep(Date.UTC(2026, 9, 15), 7 * 1440)).toBe(false);
    expect(onTickStep(Date.UTC(2026, 9, 12, 6), 7 * 1440)).toBe(false);
    expect(onTickStep(Date.UTC(1969, 11, 29), 7 * 1440)).toBe(true);
    expect(onTickStep(Date.UTC(2026, 9, 1), 30 * 1440)).toBe(true);
    expect(onTickStep(Date.UTC(2026, 9, 2), 30 * 1440)).toBe(false);
    expect(onTickStep(Date.UTC(2026, 9, 12, 18), 360)).toBe(true);
  });

  it('ticks a daily and a weekly chart over the same window on the same days', () => {
    const days = series('2026-10-05T00:00:00Z', 31, DAY);
    const weeks = series('2026-10-05T00:00:00Z', 5, 7 * DAY);
    const daily = axis(days, '1d', { width: 800 }).layout.ticks.map((t) => t.text);
    const weekly = axis(weeks, '1w', { width: 800, labels: ['W41 2026', 'W42 2026', 'W43 2026', 'W44 2026', 'W45 2026'] }).layout.ticks.map(
      (t) => t.text,
    );
    expect(weekly).toEqual(['Oct 5', 'Oct 12', 'Oct 19', 'Oct 26', 'Nov 2']);
    expect(daily).toEqual(weekly);
  });

  it('reads a calendar axis in its zone and falls back to the label where it cannot place a value', () => {
    const x = { kind: 'time' as const, values: ['2026-08-01T00:00:00+05:30', 'not a time'], bucket: '1d' as const, labels: ['1 Aug 2026', '2 Aug 2026'], tz: 'Asia/Kolkata' };
    expect(tickMoments(x)[0]).toMatchObject({ day: 'Aug 1', clock: null });
    expect(tickMoments(x)[1]).toBeNull();
    expect(tickTexts(x, [0, 1])).toEqual(['Aug 1', 'Aug 2']);
    // Months read as the server names them.
    const months = { kind: 'time' as const, values: ['2026-03-01T00:00:00Z'], bucket: '1M' as const, labels: ['Mar 2026'] };
    expect(tickTexts(months, [0])).toEqual(['Mar 2026']);
  });
});

describe('end labels', () => {
  it('spreads labels at least one line apart inside the band, keeping their order', () => {
    expect(spreadLabels([100, 100, 100], 10, 200, 14)).toEqual([86, 100, 114]);
    expect(spreadLabels([195, 195, 195], 10, 200, 14)).toEqual([172, 186, 200]);
    expect(spreadLabels([5, 6], 10, 200, 14)).toEqual([10, 24]);
    // Order follows the values, whatever order they arrive in.
    expect(spreadLabels([120, 50, 118], 10, 200, 14)).toEqual([126, 50, 112]);
    expect(spreadLabels([50, 150], 10, 200, 14)).toEqual([50, 150]);
    expect(spreadLabels([100, 100, 100], 10, 30, 14)).toBeNull();
    expect(spreadLabels([], 0, 10, 14)).toEqual([]);
  });

  const flow = (values: number[][], extra: Partial<Record<string, unknown>> = {}) =>
    parseBlock({
      id: 'case-flow',
      type: 'chart',
      kind: 'line',
      title: 'Arrivals and closures',
      provenance: 'code',
      artifact_kind: 'series',
      allowed_views: ['line', 'table'],
      unit: 'count',
      x: { kind: 'time', values: series('2026-11-03T14:00:00Z', values[0].length, HOUR), bucket: '1h', tz: 'UTC' },
      series: [
        { key: 'ai', label: 'AI closed', values: values[0] },
        { key: 'human', label: 'Human closed', values: values[1] },
        { key: 'other', label: 'New cases', values: values[2] },
      ],
      last_in_progress: true,
      ...extra,
    }) as ChartBlock & { kind: CartesianKind };

  function endLabelBoxes(container: HTMLElement) {
    return Array.from(container.querySelectorAll('text[data-end-label]')).map((t) => {
      const y = Number(t.getAttribute('y'));
      const x = Number(t.getAttribute('x'));
      const text = t.textContent ?? '';
      return { text, x, box: [y - END_LABEL_LINE / 2, y + END_LABEL_LINE / 2] as Box, xs: [x, x + text.length * CHAR_W] as Box };
    });
  }

  afterEach(() => vi.restoreAllMocks());

  /** As a board card draws it: the card takes the series toggles, so named ends draw no legend. */
  const CONTROLS: ChartControls = { groupBy: null, publishSeries: () => undefined };
  const onCard = (block: ChartBlock & { kind: CartesianKind }, height: number) => (
    <ChartControlsContext.Provider value={CONTROLS}>
      <CartesianChart block={block} title="Arrivals and closures" height={height} />
    </ChartControlsContext.Provider>
  );

  it('never overlaps each other, the note or the baseline when every line ends at zero (qa1-02)', () => {
    for (const px of [1242, 760, 338]) {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(px);
      const zeros = Array.from({ length: 25 }, (_, i) => (i === 24 ? 0 : (i % 5) + 2));
      const { container, unmount } = render(onCard(flow([zeros, zeros, zeros]), 236));
      const svg = container.querySelector('svg[data-baseline]') as SVGSVGElement;
      const baseline = Number(svg.getAttribute('data-baseline'));
      const labels = endLabelBoxes(container);
      expect(labels.map((l) => l.text).sort()).toEqual(['AI closed', 'Human closed', 'New cases']);
      for (const l of labels) expect(l.box[1]).toBeLessThanOrEqual(baseline + 0.5);
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) expect(overlaps(labels[i].box, labels[j].box)).toBe(false);
      }
      const note = screen.getByTestId('chart-in-progress');
      const noteY = Number(note.getAttribute('y'));
      const noteBox: Box = [noteY - END_LABEL_LINE / 2, noteY + END_LABEL_LINE / 2];
      for (const l of labels) expect(overlaps(l.box, noteBox)).toBe(false);
      // The note is centred under the newest bucket's own tick (the last x tick), whatever
      // the width of the end-label column beside it (second review: it was clamped to the
      // plot's edge, 39 px left of that tick at phone width).
      const xTicks = Array.from(svg.querySelectorAll('text[text-anchor="middle"]:not([data-testid])'));
      expect(Math.abs(Number(note.getAttribute('x')) - Number(xTicks[xTicks.length - 1].getAttribute('x')))).toBeLessThanOrEqual(1);
      // A label moved off its line is tied back to it; the series stay named, no legend.
      expect(container.querySelectorAll('path[data-end-leader]').length).toBeGreaterThanOrEqual(2);
      expect(container.querySelector('ul')).toBeNull();
      unmount();
      vi.restoreAllMocks();
    }
  });

  it('centres the note under the newest tick at phone width, the end labels above the baseline (second review)', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(326);
    const rising = (base: number) => Array.from({ length: 25 }, (_, i) => base + (i % 6));
    const { container } = render(onCard(flow([rising(2), rising(9), rising(16)]), 236));
    const svg = container.querySelector('svg[data-baseline]') as SVGSVGElement;
    const baseline = Number(svg.getAttribute('data-baseline'));
    const ticks = Array.from(svg.querySelectorAll('text[text-anchor="middle"]:not([data-testid])'));
    const note = screen.getByTestId('chart-in-progress');
    expect(Math.abs(Number(note.getAttribute('x')) - Number(ticks[ticks.length - 1].getAttribute('x')))).toBeLessThanOrEqual(1);
    const labels = endLabelBoxes(container);
    expect(labels).toHaveLength(3);
    for (const l of labels) expect(l.box[1]).toBeLessThanOrEqual(baseline + 0.5);
  });

  it('keeps the leader of a series whose newest buckets are unmeasured inside the label gutter (second review)', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1242);
    const full = Array.from({ length: 25 }, () => 5);
    const early = full.map((v, i) => (i >= 21 ? null : v));
    const { container } = render(onCard(flow([full, full, early]), 236));
    const svg = container.querySelector('svg[data-baseline]') as SVGSVGElement;
    const plotRight = Number(svg.getAttribute('data-plot-x')) + Number(svg.getAttribute('data-plot-width'));
    const startOf = (k: number) => {
      const d = container.querySelector(`path[data-end-leader="${k}"]`)?.getAttribute('d') ?? '';
      const m = /^M(-?[\d.]+),(-?[\d.]+)L/.exec(d);
      return m ? Number(m[1]) : null;
    };
    // All three end at 5, so the first and the last labels move off their lines.
    expect(startOf(2)).not.toBeNull();
    expect(startOf(0)).not.toBeNull();
    // The series that stops measuring 4 buckets early: its leader starts at the plot's
    // edge, never at its end dot ~200 px left (a stroke across the unmeasured buckets).
    expect(startOf(2) as number).toBeGreaterThanOrEqual(plotRight - 2);
    const earlyDot = Number(container.querySelector('circle[data-end-dot="2"]')?.getAttribute('cx'));
    expect(earlyDot).toBeLessThan(plotRight - 100);
    // A line that reaches the newest bucket is still tied back to its own end dot.
    const dot = Number(container.querySelector('circle[data-end-dot="0"]')?.getAttribute('cx'));
    expect(Math.abs((startOf(0) as number) - (dot + 5))).toBeLessThanOrEqual(1);
    for (const path of Array.from(container.querySelectorAll('path[data-end-leader]'))) {
      const m = /L(-?[\d.]+),/.exec(path.getAttribute('d') ?? '');
      expect(Number(m?.[1])).toBeLessThanOrEqual(plotRight + 6);
    }
  });

  it('leaves lines that end apart where they are, without leaders', () => {
    const { container } = render(onCard(flow([[10, 10, 10, 10], [50, 50, 50, 50], [90, 90, 90, 90]]), 236));
    expect(endLabelBoxes(container)).toHaveLength(3);
    expect(container.querySelector('path[data-end-leader]')).toBeNull();
  });

  it('offers brush zoom by default and drops its row, hint and instructions when zoom is off', () => {
    const block = flow([[1, 2, 3, 4], [2, 3, 4, 5], [3, 4, 5, 6]]);
    const zoomable = render(onCard(block, 236));
    expect(zoomable.container.querySelector('[data-testid="chart-zoom-hint"]')).not.toBeNull();
    expect(zoomable.container.textContent).toMatch(/To zoom/);
    zoomable.unmount();
    const { container } = render(
      <ChartControlsContext.Provider value={CONTROLS}>
        <CartesianChart block={block} title="Arrivals and closures" height={236} zoom={false} />
      </ChartControlsContext.Provider>,
    );
    expect(container.querySelector('[data-testid="chart-controls"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart-zoom-hint"]')).toBeNull();
    expect(container.textContent).not.toMatch(/to zoom/i);
    // The lines stay named at their ends.
    expect(endLabelBoxes(container)).toHaveLength(3);
  });

  it('names the series in the legend when the labels cannot fit one line apart in the plot', () => {
    const { container } = render(onCard(flow([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]), 60));
    expect(container.querySelector('text[data-end-label]')).toBeNull();
    const legend = container.querySelector('ul');
    expect(legend).not.toBeNull();
    expect(legend).toHaveTextContent('Human closed');
  });
});

describe('a week by the day it starts, in every reading (second review)', () => {
  const weekly = parseBlock({
    id: 'weekly',
    type: 'chart',
    kind: 'bar',
    title: 'Cases by week',
    provenance: 'code',
    artifact_kind: 'series',
    allowed_views: ['bar', 'table'],
    unit: 'count',
    x: {
      kind: 'time',
      values: ['2026-03-30T00:00:00Z', '2026-04-06T00:00:00Z', '2026-04-13T00:00:00Z'],
      bucket: '1w',
      labels: ['W14 2026 (from 1 Apr)', 'W15 2026', 'W16 2026'],
      tz: 'UTC',
    },
    series: [{ key: 'c', label: 'Cases', values: [3, 5, 2] }],
    last_in_progress: true,
  }) as ChartBlock & { kind: CartesianKind };

  it('names the day a week starts, its ISO week and any cut in the tooltip, the table and a range', () => {
    expect(weekFullLabel('W14 2026')).toBe('Week of Mar 30 (W14 2026)');
    // The server's cut note reads its days in the kit's one day format too (re-review F1).
    expect(weekFullLabel('W31 2026 (from 1 Aug)')).toBe('Week of Jul 27 (W31 2026) (from Aug 1)');
    expect(weekFullLabel('W32 2026 (from 8 Aug)')).toBe('Week of Aug 3 (W32 2026) (from Aug 8)');
    // A week the window cuts at both ends keeps both notes, each in the same order.
    expect(weekFullLabel('W45 2026 (from 3 Nov) (to 5 Nov)')).toBe('Week of Nov 2 (W45 2026) (from Nov 3) (to Nov 5)');
    expect(shortCalendarLabel('W45 2026 (from 3 Nov) (to 5 Nov)', '1w')).toBe('Nov 2');
    expect(weekFullLabel('Week of Oct 5 (W41 2026)')).toBeNull();
    expect(weekFullLabel('Mar 2026')).toBeNull();
    expect(xPositionLabel(weekly.x, 1)).toBe('Week of Apr 6 (W15 2026)');
    // Only a weekly axis reads its labels as weeks.
    expect(xPositionLabel({ ...weekly.x, bucket: '1d' }, 1)).toBe('W15 2026');
    expect(xRangeLabel(weekly.x, 1, 2)).toBe('Weeks of Apr 6 – Apr 13 (W15 – W16 2026)');
    const turn = { kind: 'time' as const, values: ['2025-12-22T00:00:00Z', '2026-01-05T00:00:00Z'], bucket: '1w' as const, labels: ['W52 2025', 'W02 2026'] };
    expect(xRangeLabel(turn, 0, 1)).toBe('Weeks of Dec 22 – Jan 5 (W52 2025 – W02 2026)');
    // A cut week keeps every part.
    expect(xRangeLabel(weekly.x, 0, 1)).toBe('Week of Mar 30 (W14 2026) (from Apr 1) – Week of Apr 6 (W15 2026)');

    render(<CartesianChart block={weekly} title="Cases by week" height={160} />);
    const plot = screen.getByTestId('chart-bar-plot');
    const ticks = Array.from(document.querySelectorAll('svg text[text-anchor="middle"]:not([data-testid])')).map((t) => t.textContent);
    expect(ticks).toEqual(['Mar 30', 'Apr 6', 'Apr 13']);
    const rows = Array.from(screen.getByTestId('chart-data-table').querySelectorAll('th[scope="row"]')).map((r) => r.textContent);
    expect(rows).toEqual(['Week of Mar 30 (W14 2026) (from Apr 1)', 'Week of Apr 6 (W15 2026)', 'Week of Apr 13 (W16 2026) (in progress)']);
    // One day format in every row: no day-first date survives.
    for (const row of rows) expect(row).not.toMatch(/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
    act(() => plot.focus());
    expect(screen.getByTestId('chart-bar-tooltip')).toHaveTextContent('Week of Apr 13 (W16 2026)');
  });
});

describe('the accessible name names a zone only when the axis knows it (second review)', () => {
  const block = (x: Record<string, unknown>) =>
    parseBlock({
      id: 'zone',
      type: 'chart',
      kind: 'bar',
      title: 'Cases',
      provenance: 'code',
      artifact_kind: 'series',
      allowed_views: ['bar', 'table'],
      unit: 'count',
      x: { kind: 'time', values: series('2026-11-01T00:00:00Z', 3, DAY), bucket: '1d', ...x },
      series: [{ key: 'c', label: 'Cases', values: [1, 2, 3] }],
    }) as ChartBlock & { kind: CartesianKind };
  const nameOf = (b: ChartBlock & { kind: CartesianKind }) => {
    const { unmount } = render(<CartesianChart block={b} title="Cases" height={140} />);
    const label = screen.getByTestId('chart-bar-plot').getAttribute('aria-label');
    unmount();
    return label;
  };

  it('says nothing of a zone for labelled buckets without one (a board breakdown) and names a known one', () => {
    const labels = ['Nov 1', 'Nov 2', 'Nov 3'];
    // Operator-zone wall clocks written as UTC instants: claiming "UTC" would be false.
    expect(nameOf(block({ labels }))).toBe('Cases. Column chart, count.');
    expect(nameOf(block({ labels, tz: 'UTC' }))).toBe('Cases. Column chart, count, UTC.');
    expect(nameOf(block({ labels, tz: 'Asia/Kolkata' }))).toBe('Cases. Column chart, count, Asia/Kolkata.');
    // A plain time axis is UTC by the shared grammar.
    expect(nameOf(block({}))).toBe('Cases. Column chart, count, UTC.');
  });
});

describe('charts that share an x axis', () => {
  const bars = (id: string, values: number[]) =>
    parseBlock({
      id,
      type: 'chart',
      kind: 'bar',
      title: id,
      provenance: 'code',
      artifact_kind: 'series',
      allowed_views: ['bar', 'table'],
      unit: 'count',
      x: { kind: 'time', values: series('2026-10-28T12:00:00Z', values.length, 6 * HOUR), bucket: '6h', tz: 'UTC' },
      series: [{ key: id, label: id, values }],
      last_in_progress: true,
    }) as ChartBlock & { kind: CartesianKind };

  it('start their plots at the same x when given the wider y-gutter, so the ticks line up (qa1-03)', () => {
    const alerts = bars('alerts', Array.from({ length: 29 }, (_, i) => 150 + (i % 4) * 20));
    const cases = bars('cases', Array.from({ length: 29 }, (_, i) => i % 5));
    const gutter = Math.max(yAxisOf(alerts).chars, yAxisOf(cases).chars);
    expect(yAxisOf(alerts).chars).toBeGreaterThan(yAxisOf(cases).chars);
    const a = render(<CartesianChart block={alerts} title="Alerts" height={140} minAxisChars={gutter} />);
    const c = render(<CartesianChart block={cases} title="Cases" height={120} minAxisChars={gutter} />);
    const plotX = (r: ReturnType<typeof render>) => r.container.querySelector('svg[data-plot-x]')?.getAttribute('data-plot-x');
    expect(plotX(a)).toBe(plotX(c));
    const ticks = (r: ReturnType<typeof render>) =>
      Array.from(r.container.querySelectorAll('svg text[text-anchor="middle"]:not([data-testid])')).map((t) => [t.getAttribute('x'), t.textContent]);
    expect(ticks(a)).toEqual(ticks(c));
  });
});

describe('the image export reads the same axis', () => {
  it('dates its ticks and puts the note under the newest bucket', () => {
    const block = parseBlock({
      id: 'daily',
      type: 'chart',
      kind: 'bar',
      title: 'Cases by day',
      provenance: 'code',
      artifact_kind: 'series',
      allowed_views: ['bar', 'table'],
      unit: 'count',
      x: { kind: 'time', values: series('2026-10-28T12:00:00Z', 29, 6 * HOUR), bucket: '6h', tz: 'UTC' },
      series: [{ key: 'c', label: 'Cases', values: Array.from({ length: 29 }, (_, i) => i % 4) }],
      last_in_progress: true,
    }) as ChartBlock;
    const { svg } = chartSvg(block, { title: 'Cases by day', paint: () => ({ color: 'black', opacity: 1 }), generatedAt: new Date('2026-11-04T14:00:00Z') });
    expect(svg).not.toMatch(/>00:00</);
    expect(svg).toMatch(/>Oct 30</);
    expect(svg).toMatch(/>Nov 4 12:00</);
    expect(svg).toMatch(/>\(in progress\)</);
  });
});
