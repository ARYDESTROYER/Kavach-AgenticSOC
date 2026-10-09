/**
 * Client-side view switching (BLOCKS.md amendment 3): the same data in another allowed
 * view, no model call, and never a view the data cannot honestly support.
 */
import { describe, expect, it } from 'vitest';

import { parseBlock } from '../schema';
import type { ChartBlock } from '../schema';
import { canShowTable, chartKindFits, honestChart, isAdditive, switchableViews, tableBlockOf, viewAs } from '../views';
import { galleryBlock } from '../__fixtures__/gallery';

describe('switchableViews / viewAs', () => {
  it('offers the allowed chart views, current first, minus table', () => {
    const b = galleryBlock('top-hosts');
    expect(switchableViews(b)).toEqual(['hbar', 'bar']);
    const asBar = viewAs(b, 'bar') as ChartBlock;
    expect(asBar.kind).toBe('bar');
    expect(asBar.series).toBe((b as ChartBlock).series);
  });

  it('refuses a donut of several series or of more than six parts, and a multi-series sparkline', () => {
    const multi = galleryBlock('alerts-by-source') as ChartBlock;
    expect(chartKindFits(multi, 'donut')).toBe(false);
    expect(chartKindFits(multi, 'sparkline')).toBe(false);
    expect(viewAs(multi, 'sparkline')).toBe(multi);
    const many = parseBlock({
      id: 'c',
      type: 'chart',
      kind: 'hbar',
      provenance: 'code',
      artifact_kind: 'categories',
      allowed_views: ['hbar', 'bar', 'donut', 'table'],
      unit: 'count',
      x: { kind: 'category', values: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      series: [{ key: 's', label: 'S', values: [1, 2, 3, 4, 5, 6, 7] }],
    });
    expect(switchableViews(many)).not.toContain('donut');
  });

  it('never offers a stack or donut whose values do not add up (G3)', () => {
    // Median + 90th percentile in minutes: a "Total 52 min" stack would be invented.
    const mtta = galleryBlock('mtta-trend') as ChartBlock;
    expect(mtta.allowed_views).toContain('stacked_bar');
    expect(isAdditive(mtta)).toBe(false);
    expect(chartKindFits(mtta, 'stacked_bar')).toBe(false);
    expect(switchableViews(mtta)).toEqual(['line', 'area', 'bar']);
    expect((viewAs(mtta, 'stacked_bar') as ChartBlock).kind).toBe('line');

    // A rate per rule in percent is not a part-to-whole: no donut, no shares that add rates.
    const fpRate = parseBlock({
      id: 'fp',
      type: 'chart',
      kind: 'hbar',
      provenance: 'code',
      artifact_kind: 'categories',
      allowed_views: ['hbar', 'bar', 'donut', 'table'],
      unit: 'percent',
      x: { kind: 'category', values: ['rule-a', 'rule-b', 'rule-c'] },
      series: [{ key: 'fp', label: 'FP rate', values: [40, 35, 62] }],
    }) as ChartBlock;
    expect(chartKindFits(fpRate, 'donut')).toBe(false);
    expect(switchableViews(fpRate)).toEqual(['hbar', 'bar']);

    // Percent shares that reconcile to 100 ARE a part-to-whole: the donut is honest.
    const shares = parseBlock({ ...(fpRate as object), series: [{ key: 's', label: 'Share', values: [50, 30.2, 19.8] }] }) as ChartBlock;
    expect(chartKindFits(shares, 'donut')).toBe(true);
    // Scores and durations never add up, whatever their values.
    expect(isAdditive({ ...shares, unit: 'score' }, 'donut')).toBe(false);
    expect(isAdditive({ ...shares, unit: 'ms' }, 'donut')).toBe(false);
    // A 100 % stack (each slot's series sum to 100) is honest; rates per slot are not.
    const pctStack = parseBlock({
      ...(galleryBlock('alerts-by-source') as object),
      unit: 'percent',
      series: [
        { key: 'a', label: 'A', values: Array.from({ length: 12 }, () => 60) },
        { key: 'b', label: 'B', values: Array.from({ length: 12 }, (_, i) => (i === 3 ? null : 40)) },
      ],
    }) as ChartBlock;
    expect(chartKindFits(pctStack, 'stacked_bar')).toBe(true);
    const rateStack = { ...pctStack, series: pctStack.series.map((s) => ({ ...s, values: s.values.map((v) => (v === null ? null : 30)) })) };
    expect(chartKindFits(rateStack, 'stacked_bar')).toBe(false);
    // Counts, tokens, bytes and money do.
    for (const unit of ['count', 'tokens', 'bytes', 'usd'] as const) expect(isAdditive({ ...mtta, unit })).toBe(true);
  });

  it('draws a server-chosen dishonest kind as its nearest honest kind, and offers it', () => {
    const stackedMinutes = parseBlock({ ...(galleryBlock('mtta-trend') as object), kind: 'stacked_bar' }) as ChartBlock;
    expect(honestChart(stackedMinutes).kind).toBe('bar');
    expect(switchableViews(stackedMinutes)).toEqual(['line', 'area', 'bar']);
    const donutRates = parseBlock({
      id: 'd',
      type: 'chart',
      kind: 'donut',
      provenance: 'code',
      artifact_kind: 'categories',
      allowed_views: ['donut'],
      unit: 'percent',
      x: { kind: 'category', values: ['a', 'b'] },
      series: [{ key: 's', label: 'Rate', values: [40, 70] }],
    }) as ChartBlock;
    expect(honestChart(donutRates).kind).toBe('hbar');
    // The drawn stand-in is offered even though the server never listed it.
    expect(switchableViews(donutRates)).toEqual(['hbar']);
    const honest = galleryBlock('verdicts') as ChartBlock;
    expect(honestChart(honest)).toBe(honest);
  });

  it('never switches a non-chart block', () => {
    const t = galleryBlock('signins');
    expect(switchableViews(t)).toEqual([]);
    expect(viewAs(t, 'bar')).toBe(t);
  });
});

describe('tableBlockOf', () => {
  it('derives a table that keeps the label trust flag', () => {
    const t = tableBlockOf(galleryBlock('top-hosts'))!;
    expect(t.type).toBe('table');
    expect(t.columns[0]).toMatchObject({ label: 'Host', untrusted: true });
    expect(t.columns[1]).toMatchObject({ type: 'number', align: 'right', unit: 'count' });
    expect(t.rows[0]).toEqual(['web-01.corp.example', 1840]);
  });

  it('types case-list and kpi columns', () => {
    const cases = tableBlockOf(galleryBlock('open-cases'))!;
    expect(cases.columns.map((c) => c.type)).toEqual(['case', 'text', 'severity', 'verdict', 'status', 'risk', 'text']);
    const kpis = tableBlockOf(galleryBlock('kpis'))!;
    expect(kpis.rows.find((r) => r[0] === 'AI spend today')?.[1]).toBeNull();
  });

  it('is identity for a table and null for prose', () => {
    const t = galleryBlock('signins');
    expect(tableBlockOf(t)).toBe(t);
    expect(tableBlockOf(galleryBlock('note'))).toBeNull();
    expect(canShowTable(galleryBlock('lookup-query'))).toBe(false);
    expect(canShowTable(galleryBlock('logon-heatmap'))).toBe(true);
  });
});
