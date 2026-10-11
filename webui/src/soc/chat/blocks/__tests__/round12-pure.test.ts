/**
 * Round 12 (WP-BLK) pure logic: parsing the new block fields, calendar labels, the
 * comparison change rule, client-side re-binning (sums equal a server query at the
 * coarser unit, in the axis zone, ISO weeks from Monday) and the standalone chart SVG.
 */
import { describe, expect, it } from 'vitest';

import { chartSvg, esc, viewNotes, wrapText, type Paint } from '../charts/export-svg';
import { chartFileName, chartSvgDocument, parseComputedColor, paintResolver } from '../charts/export-image';
import { isoWeek, localParts, rebinChart, rebinChoices, zoneSupported } from '../charts/rebin';
import { sliceChart } from '../charts/CartesianChart';
import { changeParts, roundHalfEven, shortCalendarLabel, xAxisHeader, xPositionLabel, xRangeLabel, xTickLabel } from '../format';
import { comparisonFacts } from '../renderers/ComparisonView';
import { headingRepeatsLeaf, highlightColumns, infographicParts, leafVisibleTitle, spanPlan } from '../renderers/InfographicView';
import { TEMPLATE_NAME, reportLayout } from '../renderers/ReportView';
import { TEMPLATE_LABEL } from '../../report/model';
import { FALLBACK_TEXT, allowedRebin, parseBlock } from '../schema';
import type { ChartBlock, KpiGroupBlock, ReportBlock } from '../schema';
import { ROUND12_RAW, dailyCount, istDays, round12Block } from '../__fixtures__/round12';

const chart = (id: string) => round12Block(id) as ChartBlock;

function rawChart(over: Record<string, unknown>): ChartBlock {
  const b = parseBlock({
    id: 'c',
    type: 'chart',
    kind: 'bar',
    provenance: 'code',
    artifact_kind: 'series',
    allowed_views: ['bar', 'line', 'table'],
    unit: 'count',
    x: { kind: 'time', values: ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'], bucket: '1d' },
    series: [{ key: 's', label: 'S', values: [1, 2] }],
    ...over,
  });
  if (b.type !== 'chart') throw new Error(`not a chart: ${JSON.stringify(b)}`);
  return b;
}

describe('schema: calendar axis, re-bin and layout fields', () => {
  it('keeps calendar labels and the zone aligned with the x values', () => {
    const c = chart('daily-cases');
    expect(c.x.labels).toHaveLength(70);
    expect(c.x.labels?.[0]).toBe('1 Aug 2026');
    expect(c.x.tz).toBe('Asia/Kolkata');
    expect(c.allowed_rebin).toEqual(['1w', '1M']);
  });

  it('re-aligns labels like the backend: time keeps the newest, padding with blanks', () => {
    const c = rawChart({ x: { kind: 'time', bucket: '1d', values: ['2026-10-01', '2026-10-02', '2026-10-03'], labels: ['b', 'c'] } });
    expect(c.x.labels).toEqual(['b', 'c', '']);
    const cat = rawChart({ x: { kind: 'category', values: ['a', 'b'], labels: ['A', 'B', 'C'] } });
    expect(cat.x.labels).toEqual(['A', 'B']);
    const blank = rawChart({ x: { kind: 'time', bucket: '1d', values: ['2026-10-01'], labels: [''] } });
    expect(blank.x.labels).toBeUndefined();
  });

  it('accepts only an IANA-shaped zone name', () => {
    expect(rawChart({ x: { kind: 'time', bucket: '1d', values: ['2026-10-01'], tz: 'America/Argentina/Buenos_Aires' } }).x.tz).toBe(
      'America/Argentina/Buenos_Aires',
    );
    expect(rawChart({ x: { kind: 'time', bucket: '1d', values: ['2026-10-01'], tz: '<script>' } }).x.tz).toBeUndefined();
    expect(rawChart({ x: { kind: 'time', bucket: '1d', values: ['2026-10-01'], tz: 'UTC; x' } }).x.tz).toBeUndefined();
  });

  it('allows a re-bin only for an additive calendar time series into buckets it nests in', () => {
    const time = { kind: 'time' as const, bucket: '1d' as const };
    expect(allowedRebin(['1w', '1M', '1M', 'bogus', '1h', '1q'], time, 'count')).toEqual(['1w', '1M', '1q']);
    expect(allowedRebin(['1w'], time, 'percent')).toEqual([]);
    expect(allowedRebin(['1w'], time, 'minutes')).toEqual([]);
    expect(allowedRebin(['1M'], { kind: 'time', bucket: '1w' }, 'count')).toEqual([]);
    expect(allowedRebin(['1w'], { kind: 'category', bucket: '1d' }, 'count')).toEqual([]);
    expect(allowedRebin(['1y'], { kind: 'time', bucket: '1M' }, 'usd')).toEqual(['1y']);
    expect(allowedRebin('1w', time, 'count')).toEqual([]);
    expect(rawChart({ allowed_rebin: ['1w'], unit: 'percent' }).allowed_rebin).toEqual([]);
    expect(rawChart({ allowed_rebin: ['1w'] }).allowed_rebin).toEqual(['1w']);
    // Saved history keeps only the newest points: the window it summed is gone.
    expect(rawChart({ allowed_rebin: ['1w'], downsampled_for_storage: true }).allowed_rebin).toEqual([]);
  });

  it('parses the Brief layout and lets the infographic template imply it', () => {
    const report = round12Block('posture-infographic') as ReportBlock;
    expect(report.layout).toBe('infographic');
    const base = ROUND12_RAW[4] as Record<string, unknown>;
    expect((parseBlock({ ...base, layout: 'poster' }) as ReportBlock).layout).toBe('infographic');
    expect((parseBlock({ ...base, layout: undefined, template: 'monthly' }) as ReportBlock).layout).toBeUndefined();
    expect(reportLayout(parseBlock({ ...base, layout: undefined, template: 'monthly' }) as ReportBlock)).toBe('document');
    expect((parseBlock({ ...base, layout: 'document' }) as ReportBlock).layout).toBe('document');
  });
});

describe('format: calendar labels and the comparison change', () => {
  it('reads the server label, shortens it for ticks and names the zone in table headers', () => {
    const c = chart('daily-cases');
    expect(xPositionLabel(c.x, 0)).toBe('1 Aug 2026');
    expect(xTickLabel(c.x, 0)).toBe('1 Aug');
    expect(xAxisHeader(c.x)).toBe('Period (Asia/Kolkata)');
    expect(shortCalendarLabel('Jul 2026 (from 12 Jul)', '1M')).toBe('Jul 2026');
    expect(shortCalendarLabel('10 Oct 14:00', '1h')).toBe('14:00');
    expect(shortCalendarLabel('W14 2026', '1w')).toBe('W14 2026');
    // A plain time axis keeps its UTC reading.
    const plain = rawChart({});
    expect(xAxisHeader(plain.x)).toBe('Time (UTC)');
    expect(xPositionLabel(plain.x, 0)).toBe('Oct 1');
  });

  it('computes absolute and relative change; a zero baseline is "new", never ∞ or NaN', () => {
    expect(changeParts(1284, 1188, 'count')).toMatchObject({ abs: '+96', pct: '+8.1%', isNew: false });
    expect(changeParts(18.4, 16.3, 'percent')).toMatchObject({ abs: '+2.1 pp', pct: '+12.9%' });
    expect(changeParts(42, 48, 'minutes')).toMatchObject({ abs: '−6 min', pct: '−12.5%' });
    expect(changeParts(5, 0, 'count')).toMatchObject({ abs: '+5', pct: 'new', isNew: true });
    expect(changeParts(0, 0, 'count')).toMatchObject({ abs: '0', pct: '0%', isNew: false });
    expect(changeParts(null, 3, 'count')).toMatchObject({ delta: null, abs: '—', pct: '—' });
    for (const c of [changeParts(5, 0, 'count'), changeParts(0, 0, 'count')]) {
      expect(c.pct).not.toMatch(/Infinity|NaN|∞/);
    }
  });

  it('rounds the relative change exactly like the server (Python round, half-even)', () => {
    // [current, baseline, delta_pct] generated by backend `blocks.compare_values`
    // (`round(round(cur - base, 6) / abs(base) * 100, 1)`): the half-way cases are where
    // "round half up" read +1.3% on a chart tooltip beside a +1.2% server tile.
    const SERVER: Array<[number, number, number]> = [
      [81, 80, 1.2],
      [401, 400, 0.2],
      [79, 80, -1.2],
      [1036, 800, 29.5],
      [3, 40, -92.5],
      [21, 40, -47.5],
      [18.4, 16.3, 12.9],
      [1001, 100000, -99],
      [99999, 100000, 0],
      [77.7, 8, 871.2],
      [282, 32, 781.2],
      [786, 32, 2356.2],
      [75.1, 8, 838.7],
      [11.7, 8, 46.2],
      [72.4, 32, 126.2],
      [1789, 80, 2136.2],
      [90.5, 8, 1031.2],
      [71.3, 40, 78.2],
      [2833, 16, 17606.2],
      [42.9, 8, 436.2],
      [2202, 32, 6781.2],
    ];
    for (const [cur, base, pct] of SERVER) {
      const want = pct === 0 ? '0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
      expect(changeParts(cur, base, 'count').pct, `${base} → ${cur}`).toBe(want);
    }
    expect(roundHalfEven(1.25, 1)).toBe(1.2);
    expect(roundHalfEven(1.75, 1)).toBe(1.8);
    expect(roundHalfEven(-0.25, 1)).toBe(-0.2);
    // 2.675 is 2.67499999… in binary: not a tie, so it rounds down (as Python does).
    expect(roundHalfEven(2.675, 2)).toBe(2.67);
  });

  it('reads a comparison tile from its own fields, preferring the server percentage', () => {
    const tiles = round12Block('compare-tiles') as KpiGroupBlock;
    const [cases, fp, esc2, mttr] = tiles.items.map(comparisonFacts);
    expect(cases).toMatchObject({ period: 'Sep 2026', baseline: 1188, abs: '+96', pct: '+8.1%', smallSample: null });
    expect(fp).toMatchObject({ baseline: 16.3, abs: '+2.1 pp', pct: '+12.9%', smallSample: 20 });
    expect(esc2).toMatchObject({ baseline: 0, pct: 'new', isNew: true });
    expect(mttr).toMatchObject({ baseline: 48, abs: '−6 min', pct: '−12.5%' });
  });
});

describe('rebin: client-side calendar re-binning', () => {
  it('offers the block bucket first, then the allowed coarser ones', () => {
    expect(rebinChoices(chart('daily-cases'))).toEqual(['1d', '1w', '1M']);
    expect(rebinChoices(chart('monthly-alerts'))).toEqual(['1M', '1q', '1y']);
    expect(rebinChoices(chart('compare-bars'))).toEqual([]);
    expect(zoneSupported('Mars/Olympus_Mons')).toBe(false);
    expect(rebinChoices({ ...chart('daily-cases'), x: { ...chart('daily-cases').x, tz: 'Mars/Olympus_Mons' } })).toEqual([]);
  });

  it('daily → weekly in Asia/Kolkata equals an independent ISO-week sum (Monday weeks)', () => {
    const daily = chart('daily-cases');
    const weekly = rebinChart(daily, '1w');
    // Independent ground truth: walk local dates, key each by its Monday.
    const sums = new Map<string, number>();
    const [, labels] = istDays(2026, 8, 1, 70);
    labels.forEach((_, i) => {
      const local = new Date(Date.UTC(2026, 7, 1 + i));
      const monday = new Date(local.getTime() - ((local.getUTCDay() + 6) % 7) * 86_400_000);
      const key = monday.toISOString().slice(0, 10);
      sums.set(key, (sums.get(key) ?? 0) + dailyCount(i));
    });
    expect(weekly.series[0].values).toEqual(Array.from(sums.values()));
    expect(weekly.x.bucket).toBe('1w');
    expect(weekly.x.labels?.[0]).toBe('W31 2026 (from 1 Aug)');
    expect(weekly.x.labels?.at(-1)).toBe('W41 2026');
    expect(weekly.last_in_progress).toBe(true);
    // The window total is unchanged.
    const total = (b: ChartBlock) => (b.series[0].values as number[]).reduce((a, v) => a + v, 0);
    expect(total(weekly)).toBe(total(daily));
    expect(weekly.allowed_rebin).toEqual([]);
  });

  it('daily → monthly cuts at local month boundaries, the current month still in progress', () => {
    const monthly = rebinChart(chart('daily-cases'), '1M');
    expect(monthly.x.labels).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026']);
    const sum = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => dailyCount(from + k)).reduce((a, v) => a + v, 0);
    expect(monthly.series[0].values).toEqual([sum(0, 31), sum(31, 61), sum(61, 70)]);
    // Each group starts at its first local day's instant (18:30 UTC the day before).
    expect(monthly.x.values[1]).toBe('2026-08-31T18:30:00Z');
  });

  it('names a period the series only partly covers at either end', () => {
    const [values, labels] = istDays(2026, 7, 12, 30); // 12 Jul → 10 Aug
    const b = rawChart({
      x: { kind: 'time', bucket: '1d', tz: 'Asia/Kolkata', values, labels },
      series: [{ key: 's', label: 'S', values: values.map(() => 1) }],
      allowed_rebin: ['1M'],
      last_in_progress: false,
    });
    const m = rebinChart(b, '1M');
    expect(m.x.labels).toEqual(['Jul 2026 (from 12 Jul)', 'Aug 2026 (to 10 Aug)']);
    expect(m.series[0].values).toEqual([20, 10]);
  });

  it('hourly → daily follows local midnight (18:30 UTC in Asia/Kolkata)', () => {
    const start = Date.UTC(2026, 9, 7, 18, 30); // 8 Oct 00:00 IST
    const values = Array.from({ length: 30 }, (_, i) => new Date(start + i * 3_600_000).toISOString().replace('.000Z', 'Z'));
    const b = rawChart({
      x: { kind: 'time', bucket: '1h', tz: 'Asia/Kolkata', values },
      series: [{ key: 's', label: 'S', values: values.map((_, i) => i) }],
      allowed_rebin: ['1d'],
    });
    const d = rebinChart(b, '1d');
    expect(d.x.labels).toEqual(['8 Oct 2026', '9 Oct 2026 (to 06:00)']);
    expect(d.series[0].values).toEqual([(23 * 24) / 2, Array.from({ length: 6 }, (_, k) => 24 + k).reduce((a, v) => a + v, 0)]);
  });

  it('keeps DST days whole in America/New_York', () => {
    // Local midnights around the 1 Nov 2026 fall-back: 04:00Z before, 05:00Z after.
    const values = ['2026-10-31T04:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-03T05:00:00Z'];
    expect(localParts(Date.parse(values[2]), 'America/New_York')).toMatchObject({ year: 2026, month: 11, day: 2, hour: 0, weekday: 1 });
    const b = rawChart({
      x: { kind: 'time', bucket: '1d', tz: 'America/New_York', values },
      series: [{ key: 's', label: 'S', values: [1, 2, 3, 4] }],
      allowed_rebin: ['1w'],
    });
    const w = rebinChart(b, '1w');
    // Sat 31 Oct and Sun 1 Nov are W44; Mon 2 Nov starts W45.
    expect(w.x.labels?.map((l) => l.replace(/ \(.*\)$/, ''))).toEqual(['W44 2026', 'W45 2026']);
    expect(w.series[0].values).toEqual([3, 7]);
  });

  it('numbers ISO weeks across a year boundary', () => {
    expect(isoWeek({ year: 2026, month: 12, day: 31 })).toEqual([2026, 53]);
    expect(isoWeek({ year: 2027, month: 1, day: 1 })).toEqual([2026, 53]);
    expect(isoWeek({ year: 2027, month: 1, day: 4 })).toEqual([2027, 1]);
    expect(isoWeek({ year: 2024, month: 12, day: 30 })).toEqual([2025, 1]);
  });

  it('a period with a not-measured part is not measured (G3); money keeps its cents', () => {
    const b = rawChart({
      unit: 'usd',
      x: { kind: 'time', bucket: '1M', tz: 'UTC', values: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'] },
      series: [{ key: 's', label: 'S', values: [0.1, 0.2, null, 1] }],
      allowed_rebin: ['1q'],
    });
    expect(rebinChart(b, '1q').series[0].values).toEqual([null, 1]);
    const c = rawChart({
      unit: 'usd',
      x: { kind: 'time', bucket: '1M', tz: 'UTC', values: ['2026-01-01', '2026-02-01', '2026-03-01'] },
      series: [{ key: 's', label: 'S', values: [0.1, 0.2, 0.3] }],
      allowed_rebin: ['1q'],
    });
    expect(rebinChart(c, '1q').series[0].values).toEqual([0.6]);
  });

  it('returns the block itself for a target it cannot honour', () => {
    const daily = chart('daily-cases');
    expect(rebinChart(daily, '1q')).toBe(daily);
    expect(rebinChart(daily, '1d')).toBe(daily);
  });
});

describe('zoom slice', () => {
  it('cuts every aligned list and keeps "in progress" only when the newest bucket is shown', () => {
    const c = chart('daily-cases');
    const head = sliceChart(c, [0, 9]);
    expect(head.x.values).toHaveLength(10);
    expect(head.x.labels).toHaveLength(10);
    expect(head.series[0].values).toHaveLength(10);
    expect(head.last_in_progress).toBe(false);
    expect(sliceChart(c, [60, 69]).last_in_progress).toBe(true);
    expect(sliceChart(c, [0, 69])).toBe(c);
  });

  it('names a zoomed range short enough for a phone: a shared year once, everything else in full', () => {
    const axis = (labels: string[], kind: 'time' | 'category' = 'time') => ({
      kind,
      values: kind === 'time' ? labels.map((_, i) => `2026-0${i + 1}-01T00:00:00Z`) : labels,
      bucket: '1d' as const,
      labels: kind === 'time' ? labels : undefined,
    });
    expect(xRangeLabel(axis(['23 Sep 2026', '7 Oct 2026']), 0, 1)).toBe('23 Sep – 7 Oct 2026');
    expect(xRangeLabel(axis(['Jul 2026', 'Oct 2026']), 0, 1)).toBe('Jul – Oct 2026');
    expect(xRangeLabel(axis(['W14 2026', 'W17 2026']), 0, 1)).toBe('W14 – W17 2026');
    expect(xRangeLabel(axis(['Dec 2025', 'Feb 2026']), 0, 1)).toBe('Dec 2025 – Feb 2026');
    // A cut-edge note, a clock or a label that is itself a range keeps every part.
    expect(xRangeLabel(axis(['Jul 2026 (from 14 Jul)', 'Oct 2026']), 0, 1)).toBe('Jul 2026 (from 14 Jul) – Oct 2026');
    expect(xRangeLabel(axis(['10 Oct 2026 14:00', '10 Oct 2026 18:00']), 0, 1)).toBe('10 Oct 2026 14:00 – 10 Oct 2026 18:00');
    expect(xRangeLabel(axis(['16 Sep 2026 – 22 Sep 2026', '7 Oct 2026 – 13 Oct 2026']), 0, 1)).toBe(
      '16 Sep 2026 – 22 Sep 2026 – 7 Oct 2026 – 13 Oct 2026',
    );
    // On a category axis a trailing number is a name, never a year.
    expect(xRangeLabel(axis(['Host 1001', 'Gateway 1001'], 'category'), 0, 1)).toBe('Host 1001 – Gateway 1001');
    expect(xRangeLabel(axis(['Oct 2026', 'Oct 2026']), 0, 1)).toBe('Oct 2026');
    // The live daily chart: calendar days in the operator zone.
    const c = chart('daily-cases');
    expect(xRangeLabel(c.x, 0, 9)).toBe('1 Aug – 10 Aug 2026');
  });
});

describe('infographic layout plan', () => {
  it('takes the hero from the first KPI group and the highlights from the callouts', () => {
    const r = round12Block('posture-infographic') as ReportBlock;
    const parts = infographicParts(r);
    expect(parts.hero?.block.title).toBe('Security posture');
    expect(parts.highlights.map((h) => h.block.type)).toEqual(['callout', 'callout', 'callout']);
  });

  it('prefers as hero the first KPI group that carries trends (its sparklines)', () => {
    const raw = JSON.parse(JSON.stringify(ROUND12_RAW[4])) as { sections: Array<{ blocks: Array<Record<string, unknown>> }> };
    const kpis = raw.sections[0].blocks[1] as { items: Array<Record<string, unknown>> };
    const plain = { ...kpis, id: 'plain', title: 'Plain figures', items: kpis.items.map(({ trend: _t, ...it }) => it) };
    raw.sections[0].blocks.splice(1, 0, plain);
    const parts = infographicParts(parseBlock(raw) as ReportBlock);
    expect(parts.hero?.block.title).toBe('Security posture');
    // Without any trend, the first KPI group is the hero.
    raw.sections[0].blocks.splice(2, 1);
    expect(infographicParts(parseBlock(raw) as ReportBlock).hero?.block.title).toBe('Plain figures');
  });

  it('hides a section heading only when the card right under it carries the same title', () => {
    const r = round12Block('posture-infographic') as ReportBlock;
    const [, volume, rules] = r.sections;
    expect(headingRepeatsLeaf('  rules THAT opened the most   cases ', rules.blocks)).toBe(true);
    expect(headingRepeatsLeaf('Top rules', rules.blocks)).toBe(false);
    // The first of two cards repeats it; the second one does not sit under the heading.
    expect(headingRepeatsLeaf('Cases opened per month', volume.blocks)).toBe(true);
    expect(headingRepeatsLeaf('Cases by severity', volume.blocks)).toBe(false);
    // A summary between the heading and the card keeps the heading.
    expect(headingRepeatsLeaf('Cases opened per month', volume.blocks, 'Volume rose in September.')).toBe(false);
    expect(headingRepeatsLeaf('Anything', [])).toBe(false);
  });

  it('never hides a section heading over a leaf that carries the title without drawing it', () => {
    const leaf = (raw: Record<string, unknown>) => {
      const b = parseBlock({ id: 'l', provenance: 'ai', ...raw });
      if (b.type === 'report') throw new Error('not a leaf');
      return b;
    };
    // Prose renders its text only: its title would be the section's only visible heading.
    const prose = leaf({ type: 'markdown', title: 'Next steps', text: '1. Tune the rule.\n2. Review open cases.' });
    expect(prose.type === 'markdown' && prose.title).toBe('Next steps');
    expect(leafVisibleTitle(prose)).toBeNull();
    expect(headingRepeatsLeaf('Next steps', [prose])).toBe(false);
    // A note draws its own title; a fallback notice draws none; a retention stub always draws one.
    const note = leaf({ type: 'callout', tone: 'info', title: 'Next steps', text: 'Tune the rule.' });
    expect(leafVisibleTitle(note)).toBe('Next steps');
    expect(headingRepeatsLeaf('next  STEPS', [note])).toBe(true);
    const fallback = leaf({ type: 'callout', tone: 'info', title: 'Next steps', text: FALLBACK_TEXT });
    expect(leafVisibleTitle(fallback)).toBeNull();
    expect(headingRepeatsLeaf('Next steps', [fallback])).toBe(false);
    const stub = leaf({ type: 'callout', tone: 'info', expired: { type: 'chart', artifact_kind: 'series' }, text: 'x' });
    expect(leafVisibleTitle(stub)).toBe('Earlier result');
    expect(headingRepeatsLeaf('Earlier result', [stub])).toBe(true);
    // An untitled card's generic heading ("Key figures") never stands in for a section heading.
    const kpis = leaf({ type: 'kpi_group', items: [{ key: 'k', label: 'Cases', value: 3, unit: 'count' }] });
    expect(leafVisibleTitle(kpis)).toBeNull();
    expect(headingRepeatsLeaf('Key figures', [kpis])).toBe(false);
  });

  it('lays highlights out by their count, never two plus an orphan', () => {
    expect(highlightColumns(1)).toBe('grid-cols-1');
    expect(highlightColumns(3)).toBe('grid-cols-1 @[48rem]:grid-cols-3');
    expect(highlightColumns(3)).not.toContain('grid-cols-2');
    expect(highlightColumns(4)).toContain('@[64rem]:grid-cols-4');
  });

  it('names every template exactly as the Reports library does', () => {
    // The Brief's template chip and the library's template column must never disagree.
    expect(TEMPLATE_NAME).toEqual(TEMPLATE_LABEL);
  });

  it('spans wide leaves and an odd chart out, so no grid track is left empty', () => {
    const leaf = (type: string) => ({ type }) as never;
    expect(spanPlan([leaf('chart'), leaf('chart')])).toEqual([false, false]);
    expect(spanPlan([leaf('chart'), leaf('chart'), leaf('chart')])).toEqual([false, false, true]);
    expect(spanPlan([leaf('chart'), leaf('table'), leaf('chart'), leaf('kpi_group')])).toEqual([true, true, false, false]);
  });
});

/* -------------------------------------------------------------------------- */
/* The standalone SVG.                                                         */
/* -------------------------------------------------------------------------- */
const LIGHT: Record<string, string> = { background: '#ffffff', foreground: '#111111', 'muted-foreground': '#666666', border: '#dddddd' };
const DARK: Record<string, string> = { background: '#0b0f17', foreground: '#e4e8f1', 'muted-foreground': '#94a0b8', border: '#202837' };
function paintFrom(map: Record<string, string>) {
  return (css: string): Paint => {
    const m = /var\(--([a-z0-9-]+)\)(?:\s*\/\s*([\d.]+))?/.exec(css);
    const name = m?.[1] ?? '';
    return { color: map[name] ?? (name.startsWith('chart-') ? `#00${name.slice(6).padStart(2, '0')}aa` : '#808080'), opacity: m?.[2] ? Number(m[2]) : 1 };
  };
}
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0));

describe('export SVG', () => {
  it('is a standalone document with resolved colours, a background and escaped text', () => {
    const block = { ...chart('compare-bars'), title: 'A < B & "C"' };
    const { svg, width, height } = chartSvg(block, { title: 'A < B & "C"', subtitle: 'Oct <vs> Sep', paint: paintFrom(LIGHT), generatedAt: NOW });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(width).toBe(960);
    expect(height).toBeGreaterThan(300);
    expect(svg).not.toContain('var(');
    expect(svg).not.toContain('hsl(');
    expect(svg).toContain(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
    expect(svg).toContain('A &lt; B &amp; &quot;C&quot;');
    expect(svg).toContain('Oct &lt;vs&gt; Sep');
    expect(svg).not.toMatch(/<script|onload=/i);
    // Two periods × four metrics, one at zero (no bar): seven column paths.
    expect(svg.match(/<path d="M[^"]+"\s?fill="#00/g)?.length).toBe(7);
    expect(svg).toContain('Sep 2026');
    expect(svg).toContain('Agentic SOC, computed from your data · 2026-10-10 12:00 UTC');
  });

  it('takes the theme it is given: dark and light images differ only in paint', () => {
    const block = chart('monthly-alerts');
    const light = chartSvg(block, { title: 'Alerts', paint: paintFrom(LIGHT), generatedAt: NOW }).svg;
    const dark = chartSvg(block, { title: 'Alerts', paint: paintFrom(DARK), generatedAt: NOW }).svg;
    expect(light).toContain('fill="#ffffff"/>');
    expect(dark).toContain('fill="#0b0f17"/>');
    expect(dark.replace(/#[0-9a-f]{6}/g, '#x')).toBe(light.replace(/#[0-9a-f]{6}/g, '#x'));
  });

  it('marks the period in progress in words and names the zone', () => {
    const { svg } = chartSvg(chart('daily-cases'), { title: 'Cases', paint: paintFrom(LIGHT), generatedAt: NOW });
    expect(svg).toContain('(in progress)');
    expect(svg).toContain('times in Asia/Kolkata');
  });

  it('draws only the shown series but keeps each colour bound to its series', () => {
    const block = chart('monthly-alerts');
    const all = chartSvg(block, { title: 'A', paint: paintFrom(LIGHT), generatedAt: NOW }).svg;
    const one = chartSvg(block, { title: 'A', paint: paintFrom(LIGHT), generatedAt: NOW, hidden: [true, false] }).svg;
    expect(all).toContain('stroke="#0001aa"');
    expect(one).not.toContain('stroke="#0001aa"');
    expect(one).toContain('stroke="#0002aa"');
    // Hiding every series is not possible: all are drawn.
    expect(chartSvg(block, { title: 'A', paint: paintFrom(LIGHT), hidden: [true, true], generatedAt: NOW }).svg).toContain('stroke="#0001aa"');
  });

  it('says how the view differs from the answer: hidden series, a stack of shown series, a zoom', () => {
    const stack = rawChart({
      kind: 'stacked_bar',
      title: 'Cases by verdict',
      allowed_views: ['stacked_bar', 'bar', 'table'],
      series: [
        { key: 'tp', label: 'True positive', values: [3, 4] },
        { key: 'fp', label: 'False positive', values: [10, 20] },
      ],
    });
    const { svg } = chartSvg(stack, { title: 'Cases by verdict', subtitle: 'Last 12 months', paint: paintFrom(LIGHT), generatedAt: NOW, hidden: [false, true] });
    expect(svg).toContain('True positive');
    expect(svg).toContain('False positive (hidden)');
    expect(svg).toContain('Showing 1 of 2 series, so each stack totals the shown series only');
    // Nothing hidden, nothing zoomed: no note at all.
    expect(viewNotes(stack, [0, 1], null)).toEqual([]);
    const zoomed = viewNotes(chart('monthly-alerts'), [0, 1], { first: 'Jul 2026', last: 'Oct 2026', shown: 4, total: 12 });
    expect(zoomed).toEqual(['Zoomed to Jul 2026 – Oct 2026 (4 of 12 points)']);
  });

  it('a re-binned chart image says "grouped by month" (and its file name too)', () => {
    const monthly = rebinChart(chart('daily-cases'), '1M');
    const doc = chartSvgDocument({ block: monthly, title: 'Cases opened per day', subtitle: '1 Aug – 9 Oct 2026', grouping: 'month', host: null });
    expect(doc).toContain('1 Aug – 9 Oct 2026 · grouped by month · times in Asia/Kolkata');
    expect(doc).toContain('Sep 2026');
    expect(chartFileName({ title: 'Cases opened per day', grouping: 'month' }, 'png', NOW)).toBe(
      'agentic-soc-chart-cases-opened-per-day-by-month-20261010-1200Z.png',
    );
    expect(chartFileName({ title: 'Cases opened per day' }, 'svg', NOW)).toBe('agentic-soc-chart-cases-opened-per-day-20261010-1200Z.svg');
  });

  it('draws a donut with its legend values and shares beside the ring', () => {
    const report = round12Block('posture-infographic') as ReportBlock;
    const donut = report.sections[1].blocks[1] as ChartBlock;
    const { svg } = chartSvg(donut, { title: 'Severity', paint: paintFrom(LIGHT), generatedAt: NOW });
    expect(svg).toContain('3,642');
    expect(svg).toMatch(/1,730 · 4[78]%/);
  });

  it('wraps long titles and escapes attribute-breaking characters', () => {
    expect(wrapText('one two three four five', 9, 2)).toEqual(['one two', 'three fo…']);
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('drops code points XML 1.0 forbids, so a log-derived label never breaks the file', () => {
    // U+FFFE and U+FFFF survive the display sanitiser (they are not invisible); a lone
    // surrogate and a C0 control are dropped too. Tab, line feed and an emoji stay.
    expect(esc('a￾b￿c\uD800d\u0001e\tf😀')).toBe('abcde\tf😀');
    const block = parseBlock({
      id: 'top-users',
      type: 'chart',
      kind: 'hbar',
      title: 'Top users ￿ by sign-ins',
      provenance: 'source',
      artifact_kind: 'categories',
      allowed_views: ['hbar', 'bar', 'table'],
      untrusted: true,
      unit: 'count',
      x: { kind: 'category', values: ['admin￿x', 'svc￾-backup', 'alice'], label: 'User' },
      series: [{ key: 'n', label: 'Sign-ins ￾', values: [12, 7, 3] }],
    });
    if (block.type !== 'chart') throw new Error('not a chart');
    // The parsed labels still carry the characters: only the XML writer drops them.
    expect(block.x.values[0]).toContain('￿');
    for (const bar of ['hbar', 'bar'] as const) {
      const doc = chartSvgDocument({ block: { ...block, kind: bar }, title: 'Top users ￿ by sign-ins', subtitle: 'Last 7 days ￾', host: null });
      expect(doc).not.toMatch(/[￾￿]/);
      expect(doc).toContain('adminx');
      expect(doc).toContain('svc-backup');
      const parsed = new DOMParser().parseFromString(doc, 'image/svg+xml');
      expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
      expect(parsed.documentElement.nodeName).toBe('svg');
    }
  });
});

describe('export colours', () => {
  it('parses the browser computed colour forms', () => {
    expect(parseComputedColor('rgb(13, 116, 206)')).toEqual({ color: '#0d74ce', opacity: 1 });
    expect(parseComputedColor('rgba(13, 116, 206, 0.3)')).toEqual({ color: '#0d74ce', opacity: 0.3 });
    expect(parseComputedColor('rgb(13 116 206 / 50%)')).toEqual({ color: '#0d74ce', opacity: 0.5 });
    expect(parseComputedColor('color(srgb 1 0 0.5)')).toEqual({ color: '#ff0080', opacity: 1 });
    expect(parseComputedColor('hsl(var(--x))')).toBeNull();
  });

  it('falls back to a legible light palette where nothing can be resolved', () => {
    const paint = paintResolver(null);
    expect(paint('hsl(var(--background))')).toEqual({ color: '#ffffff', opacity: 1 });
    expect(paint('hsl(var(--muted-foreground) / 0.3)').opacity).toBe(0.3);
    paint.dispose();
  });
});
