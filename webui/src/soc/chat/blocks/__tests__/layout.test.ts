/**
 * Round 13 (SPEC-chat §5.1, T7, T8): which blocks stay in the 42rem reading column, and
 * the one scope line an answer states for the caption parts its cards repeat.
 */
import { describe, expect, it } from 'vitest';

import { galleryBlock } from '../__fixtures__/gallery';
import {
  COMPACT_CHART_CATEGORIES,
  COMPACT_KPI_ITEMS,
  COMPACT_TABLE_COLUMNS,
  blockGroups,
  blockWidth,
  captionParts,
  ownCaptionParts,
  sharedScope,
  widestBlock,
} from '../layout';
import { parseBlock } from '../schema';
import type { AnswerBlock } from '../schema';

const kpis = (n: number) =>
  parseBlock({
    id: `k${n}`,
    type: 'kpi_group',
    provenance: 'code',
    artifact_kind: 'kpis',
    items: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `Figure ${i}`, value: i, unit: 'count' })),
  });

const table = (cols: number) =>
  parseBlock({
    id: `t${cols}`,
    type: 'table',
    provenance: 'source',
    artifact_kind: 'table',
    allowed_views: ['table'],
    columns: Array.from({ length: cols }, (_, i) => ({ key: `c${i}`, label: `Col ${i}`, type: 'text' })),
    rows: [Array.from({ length: cols }, (_, i) => `v${i}`)],
  });

const chart = (kind: string, n: number, xKind: 'category' | 'time' = 'category') =>
  parseBlock({
    id: `${kind}-${n}-${xKind}`,
    type: 'chart',
    kind,
    provenance: 'code',
    artifact_kind: xKind === 'time' ? 'series' : 'categories',
    unit: 'count',
    x: {
      kind: xKind,
      values: Array.from({ length: n }, (_, i) => (xKind === 'time' ? new Date(Date.UTC(2026, 0, i + 1)).toISOString() : `cat ${i}`)),
    },
    series: [{ key: 's', label: 'Cases', values: Array.from({ length: n }, (_, i) => i + 1) }],
  });

const captioned = (id: string, caption: string, asOf: string | null, type: 'kpi_group' | 'table' = 'kpi_group') => {
  const base = type === 'table' ? table(2) : kpis(2);
  return { ...base, id, caption, as_of: asOf ?? undefined } as AnswerBlock;
};

describe('blockWidth', () => {
  it('keeps a few KPIs, an indicator, a case list, ATT&CK, a short table and a small categorical chart compact', () => {
    expect(blockWidth(kpis(COMPACT_KPI_ITEMS))).toBe('compact');
    expect(blockWidth(kpis(COMPACT_KPI_ITEMS + 1))).toBe('wide');
    expect(blockWidth(galleryBlock('ioc'))).toBe('compact');
    expect(blockWidth(galleryBlock('open-cases'))).toBe('compact');
    expect(blockWidth(table(COMPACT_TABLE_COLUMNS))).toBe('compact');
    expect(blockWidth(table(COMPACT_TABLE_COLUMNS + 1))).toBe('wide');
    for (const kind of ['hbar', 'bar']) {
      expect(blockWidth(chart(kind, COMPACT_CHART_CATEGORIES))).toBe('compact');
      expect(blockWidth(chart(kind, COMPACT_CHART_CATEGORIES + 1))).toBe('wide');
    }
    // A donut (≤ 6 parts) and a funnel are always within the bound.
    expect(blockWidth(chart('donut', 5))).toBe('compact');
    expect(blockWidth(chart('funnel', 5))).toBe('compact');
  });

  it('makes time series, line charts, heatmaps, timelines, queries and Briefs wide', () => {
    expect(blockWidth(chart('bar', 6, 'time'))).toBe('wide');
    expect(blockWidth(chart('line', 6, 'time'))).toBe('wide');
    expect(blockWidth(galleryBlock('shift-brief'))).toBe('wide');
    for (const block of [galleryBlock('kpis'), galleryBlock('top-hosts')]) {
      expect(['compact', 'wide']).toContain(blockWidth(block));
    }
  });

  it('reads the bare prose blocks as compact (the lane caps them)', () => {
    expect(blockWidth(galleryBlock('note'))).toBe('compact');
  });

  it('names the widest framed block of an answer (prose does not count)', () => {
    expect(widestBlock([])).toBeNull();
    expect(widestBlock([galleryBlock('note')])).toBeNull();
    expect(widestBlock([kpis(2), galleryBlock('ioc')])).toBe('compact');
    expect(widestBlock([kpis(2), chart('line', 6, 'time')])).toBe('wide');
  });

  it('reads two consecutive indicators as one wide row, as AnswerBlocks lays them out (review F7)', () => {
    // Each indicator card is compact, but a pair shares one lane-wide row.
    expect(widestBlock([galleryBlock('ioc'), galleryBlock('ioc')])).toBe('wide');
    expect(widestBlock([kpis(2), galleryBlock('ioc'), galleryBlock('note'), galleryBlock('ioc')])).toBe('compact');
    expect(blockGroups([galleryBlock('ioc'), galleryBlock('ioc'), kpis(2)])).toEqual([
      { kind: 'entities', indices: [0, 1] },
      { kind: 'single', index: 2 },
    ]);
  });
});

describe('sharedScope (T8)', () => {
  const ASOF = '2026-10-17T11:13:20Z';

  it('states the parts two cards repeat once, with their shared "as of" minute', () => {
    const blocks = [
      captioned('a', '44 cases · exact · last 24 hours', ASOF),
      captioned('b', '12 rules · exact · last 24 hours', '2026-10-17T11:13:55Z'),
    ];
    const scope = sharedScope(blocks);
    expect(scope).not.toBeNull();
    expect(scope?.parts).toEqual(['exact', 'last 24 hours']);
    expect(scope?.line).toBe('exact · last 24 hours · as of 2026-10-17 11:13 UTC');
    expect(scope?.members).toEqual([0, 1]);
    // Each card keeps only its other parts.
    expect(ownCaptionParts(blocks[0].caption, scope)).toEqual(['44 cases']);
    expect(ownCaptionParts(blocks[1].caption, scope)).toEqual(['12 rules']);
  });

  it('shares nothing across a different "as of" minute, or without a shared part', () => {
    expect(sharedScope([captioned('a', 'exact · last 24 hours', ASOF), captioned('b', 'exact · last 24 hours', '2026-10-17T11:14:00Z')])).toBeNull();
    expect(sharedScope([captioned('a', '44 cases', ASOF), captioned('b', '12 rules', ASOF)])).toBeNull();
    expect(sharedScope([captioned('a', 'exact · last 24 hours', ASOF)])).toBeNull();
  });

  it('keeps a card with another window out of the group, and its caption whole', () => {
    const blocks = [
      captioned('a', '44 cases · exact · last 24 hours', ASOF),
      captioned('b', '9 hosts · exact · last 7 days', ASOF),
      captioned('c', '3 rules · exact · last 24 hours', ASOF),
    ];
    const scope = sharedScope(blocks);
    // The shared parts are those EVERY member of the same-minute group carries.
    expect(scope?.parts).toEqual(['exact']);
    expect(scope?.members).toEqual([0, 1, 2]);
    expect(ownCaptionParts(blocks[1].caption, scope)).toEqual(['9 hosts', 'last 7 days']);
  });

  it('shares a line only across consecutive cards, never past a card that states another window (review F5)', () => {
    // a and c share "last 7 days" in the 11:12 minute, but b (another window, 11:13) sits
    // between them: c must not lose its window under b.
    const blocks = [
      captioned('a', 'last 7 days', '2026-10-17T11:12:59Z'),
      captioned('b', 'last 30 days', '2026-10-17T11:13:01Z'),
      captioned('c', 'last 7 days', '2026-10-17T11:12:58Z'),
    ];
    expect(sharedScope(blocks)).toBeNull();
    // A framed card with no caption between them ends the run too.
    const uncaptioned = { ...kpis(3), caption: undefined } as AnswerBlock;
    expect(sharedScope([captioned('a', 'exact · last 7 days', ASOF), uncaptioned, captioned('c', 'exact · last 7 days', ASOF)])).toBeNull();
    // Prose between two members does not: it states no window.
    const prose = sharedScope([captioned('a', 'exact · last 7 days', ASOF), galleryBlock('note'), captioned('c', 'exact · last 7 days', ASOF)]);
    expect(prose?.members).toEqual([0, 2]);
  });

  it('picks the longest run, and keeps every caption outside it whole', () => {
    const blocks = [
      captioned('a', 'exact · last 24 hours', ASOF),
      captioned('b', 'exact · last 24 hours', ASOF),
      captioned('x', 'last 30 days', '2026-10-17T11:20:00Z'),
      captioned('c', '3 rules · exact · last 7 days', ASOF),
      captioned('d', '4 hosts · exact · last 7 days', ASOF),
      captioned('e', '5 users · exact · last 7 days', ASOF),
    ];
    const scope = sharedScope(blocks);
    expect(scope?.members).toEqual([3, 4, 5]);
    expect(scope?.parts).toEqual(['exact', 'last 7 days']);
    expect(ownCaptionParts(blocks[0].caption, scope && scope.members.includes(0) ? scope : null)).toEqual(['exact', 'last 24 hours']);
  });

  it('matches parts case-insensitively and keeps the first card’s words', () => {
    const scope = sharedScope([captioned('a', 'Last 24 hours · Exact', null), captioned('b', 'exact · last 24 hours', null)]);
    expect(scope?.parts).toEqual(['Last 24 hours', 'Exact']);
    expect(scope?.asOf).toBeNull();
    expect(scope?.line).toBe('Last 24 hours · Exact');
  });

  it('never groups prose, notes, Briefs or queries', () => {
    const md = { ...galleryBlock('note'), caption: 'exact · last 24 hours', as_of: ASOF } as AnswerBlock;
    const brief = { ...galleryBlock('shift-brief'), caption: 'exact · last 24 hours', as_of: ASOF } as AnswerBlock;
    expect(sharedScope([md, brief, captioned('a', 'exact · last 24 hours', ASOF)])).toBeNull();
  });

  it('splits captions on " · " and drops empty parts', () => {
    expect(captionParts(' a ·  · b ')).toEqual(['a', 'b']);
    expect(captionParts(null)).toEqual([]);
    expect(ownCaptionParts('a · b', null)).toEqual(['a', 'b']);
  });
});
