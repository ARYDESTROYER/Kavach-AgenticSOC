/**
 * Pure chart geometry (BLOCKS.md §6): clean zero-anchored ticks, regular UTC labels,
 * honest stacks (a missing part hatches the slot), reconciling shares, donut arcs and
 * line runs that break at null instead of interpolating (G3).
 */
import { describe, expect, it } from 'vitest';

import {
  areaPath,
  barWidth,
  donutArcs,
  extent,
  intensityStep,
  lastMeasured,
  lineRuns,
  niceScale,
  niceStep,
  pickXLabels,
  placeXLabels,
  reconcilingShares,
  roundedRightPath,
  roundedTopPath,
  stackSegments,
  stackTotals,
} from '../charts/geometry';

describe('niceStep / niceScale', () => {
  it('picks clean 1·2·2.5·5 steps', () => {
    expect(niceStep(10, 2)).toBe(5);
    expect(niceStep(7, 2)).toBe(5);
    expect(niceStep(1840, 3)).toBe(1000);
    expect(niceStep(0.9, 3)).toBe(0.5);
    expect(niceStep(0, 3)).toBe(1);
  });

  it('anchors the domain at zero and covers the data', () => {
    const s = niceScale(3, 1840, 4, true);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(1840);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks.length).toBeLessThanOrEqual(5);
  });

  it('never divides by nothing on an all-zero or empty domain', () => {
    expect(niceScale(0, 0)).toMatchObject({ min: 0, max: 1 });
  });

  it('covers negative values and keeps float ticks tidy', () => {
    const s = niceScale(-12, 30, 4);
    expect(s.min).toBeLessThanOrEqual(-12);
    expect(s.ticks).toContain(0);
    expect(niceScale(0, 0.3, 4).ticks.every((t) => String(t).length < 8)).toBe(true);
  });

  it('keeps count steps whole', () => {
    expect(niceScale(0, 3, 4, true).step).toBeGreaterThanOrEqual(1);
  });
});

describe('extent / stackTotals', () => {
  it('ignores nulls and non-finite values', () => {
    expect(extent([[null, 3, 9], [-2, null]])).toEqual([-2, 9]);
    expect(extent([[null, null]])).toEqual([0, 0]);
  });

  it('gives a slot no total when any part is missing (never summed as 0)', () => {
    expect(stackTotals([[1, 2, null], [3, 4, 5]], 3)).toEqual([4, 6, null]);
  });
});

describe('pickXLabels / placeXLabels', () => {
  it('labels every slot when they fit', () => {
    expect(pickXLabels(['a', 'b', 'c'], 600)).toEqual([0, 1, 2]);
  });

  it('chooses regular UTC intervals (≤ 5) on a time axis', () => {
    const start = Date.UTC(2026, 9, 7);
    const instants = Array.from({ length: 24 }, (_, i) => start + i * 3_600_000);
    const labels = instants.map((ms) => new Date(ms).toISOString().slice(11, 16));
    const picks = pickXLabels(labels, 400, instants);
    expect(picks.length).toBeLessThanOrEqual(5);
    expect(picks.every((i) => instants[i] % (6 * 3_600_000) === 0)).toBe(true);
  });

  it('labels sub-hour buckets on aligned minutes, never with a single tick', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 9, 7, h, m);
    // 12 × 5m from 10:00 → :00 :15 :30 :45 (it used to be one label at 10:00).
    const five = Array.from({ length: 12 }, (_, i) => at(10, i * 5));
    const fiveLabels = five.map((ms) => new Date(ms).toISOString().slice(11, 16));
    expect(pickXLabels(fiveLabels, 560, five)).toEqual([0, 3, 6, 9]);
    // 60 × 1m from 10:01 → :15 :30 :45 11:00 (it used to be one label at 11:00).
    const one = Array.from({ length: 60 }, (_, i) => at(10, 1 + i));
    const oneLabels = one.map((ms) => new Date(ms).toISOString().slice(11, 16));
    const p1 = pickXLabels(oneLabels, 560, one);
    expect(p1.length).toBeGreaterThanOrEqual(2);
    expect(p1.length).toBeLessThanOrEqual(5);
    expect(p1.every((i) => one[i] % (15 * 60_000) === 0)).toBe(true);
  });

  it('falls back to even stepping when no aligned interval gives two labels', () => {
    // 7-minute buckets starting off-grid: no aligned interval is a multiple of 7 minutes.
    const start = Date.UTC(2026, 9, 7, 10, 3);
    const odd = Array.from({ length: 30 }, (_, i) => start + i * 7 * 60_000);
    const picks = pickXLabels(odd.map(() => 'xx:xx'), 300, odd);
    expect(picks.length).toBeGreaterThanOrEqual(2);
    expect(picks[0]).toBe(0);
  });

  it('drops a label instead of overlapping it', () => {
    const placed = placeXLabels([0, 1], ['aaaaaaaa', 'bbbbbbbb'], (i) => 10 + i * 10, 200);
    expect(placed).toHaveLength(1);
  });
});

describe('stackSegments', () => {
  it('stacks from the baseline with a 1px inset gap and a top flag', () => {
    const segs = stackSegments([10, 20], 100, 2)!;
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ series: 0, y: 80, h: 20, top: false });
    expect(segs[1].top).toBe(true);
    // The upper segment gives up one pixel (inset), its top stays on the true total.
    expect(segs[1].y).toBe(40);
    expect(segs[1].h).toBe(80 - 1 - 40);
  });

  it('never paints a non-zero segment under 2px', () => {
    const segs = stackSegments([1000, 0.0001], 100, 0.05)!;
    expect(segs[1].h).toBeGreaterThanOrEqual(2);
  });

  it('refuses to stack a slot with a missing visible part', () => {
    expect(stackSegments([1, null, 3], 100, 1)).toBeNull();
    // A hidden series does not count as missing.
    expect(stackSegments([1, null, 3], 100, 1, [true, false, true])).not.toBeNull();
  });
});

describe('paths', () => {
  it('rounds only the top (or the tip) and stays finite', () => {
    expect(roundedTopPath(0, 10, 10, 20)).toMatch(/^M0,30V12A2,2/);
    expect(roundedRightPath(0, 0, 50, 14)).toMatch(/^M0,0H48A2,2/);
    expect(roundedTopPath(0, 10, 1, 0.5)).not.toMatch(/NaN/);
  });

  it('caps column width at ⅔ of the slot and 22px', () => {
    expect(barWidth(9)).toBe(6);
    expect(barWidth(300)).toBe(22);
    expect(barWidth(0.2)).toBe(1);
  });
});

describe('reconcilingShares', () => {
  it('sums to exactly 100 (largest remainder)', () => {
    const s = reconcilingShares([1, 1, 1], 3)!;
    expect(s.reduce((a, b) => a + b, 0)).toBe(100);
    expect(s).toEqual([34, 33, 33]);
  });

  it('returns null when the parts do not reconcile or are unmeasured', () => {
    expect(reconcilingShares([1, 2], 4)).toBeNull();
    expect(reconcilingShares([1, null], 1)).toBeNull();
    expect(reconcilingShares([0, 0], 0)).toBeNull();
  });
});

describe('donutArcs', () => {
  it('draws only positive measured parts, clockwise, with pad gaps', () => {
    const arcs = donutArcs([3, null, 0, 1], 50, 50, 48, 30);
    expect(arcs.map((a) => a.index)).toEqual([0, 3]);
    expect(arcs[0].end).toBeLessThan(arcs[1].start);
    expect(arcs.every((a) => !a.path.includes('NaN'))).toBe(true);
  });

  it('draws a single part as a full ring', () => {
    const [ring] = donutArcs([5], 50, 50, 48, 30);
    expect(ring.end - ring.start).toBeCloseTo(Math.PI * 2);
  });

  it('draws nothing when nothing was measured', () => {
    expect(donutArcs([null, 0], 50, 50, 48, 30)).toEqual([]);
  });
});

describe('lineRuns / areaPath', () => {
  const xOf = (i: number) => i * 10;
  const yOf = (v: number) => 100 - v;

  it('breaks the line at null instead of interpolating', () => {
    const runs = lineRuns([1, 2, null, 4, null, 6, 7], xOf, yOf);
    expect(runs.map((r) => r.indices)).toEqual([[0, 1], [3], [5, 6]]);
    expect(runs[0].path).toBe('M0,99L10,98');
  });

  it('closes an area down to the baseline', () => {
    const [run] = lineRuns([1, 2], xOf, yOf);
    expect(areaPath(run, [1, 2], xOf, yOf, 100)).toBe('M0,99L10,98L10,100L0,100Z');
  });

  it('finds the last measured point', () => {
    expect(lastMeasured([1, null, 3, null])).toBe(2);
    expect(lastMeasured([null])).toBe(-1);
  });
});

describe('intensityStep', () => {
  it('quantises into five visible steps and keeps zero empty', () => {
    expect(intensityStep(0, 10)).toBe(0);
    expect(intensityStep(1, 100)).toBeCloseTo(0.18);
    expect(intensityStep(100, 100)).toBe(1);
    expect(intensityStep(5, 0)).toBe(0);
  });
});
