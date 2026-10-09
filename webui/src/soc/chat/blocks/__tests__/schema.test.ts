/**
 * `parseBlocks()` — the client re-validation of answer blocks (chat revamp SPEC §7,
 * BLOCKS.md §5.5 + v2 amendments). Adversarial fixtures: unknown types, malformed
 * fields, oversized payloads, non-finite numbers, invisible/bidi characters, forged
 * links, nested reports. The parser must never throw, must keep positions (fallback
 * callouts), and must repair exactly like the backend `validate_blocks`.
 */
import { describe, expect, it } from 'vitest';

import {
  BLOCK_TYPES,
  FALLBACK_TEXT,
  LIMITS,
  allowedViewsFor,
  blockView,
  fallbackBlock,
  isDocRef,
  isEmptyDataBlock,
  isExpiredBlock,
  isInternalRef,
  leafBlocks,
  legacyTableBlock,
  parseBlock,
  parseBlocks,
  parseDocRef,
  parseInternalRef,
  parseRef,
  type AnswerBlock,
  type CalloutBlock,
  type CaseListBlock,
  type ChartBlock,
  type GuideBlock,
  type HeatmapBlock,
  type KpiGroupBlock,
  type LeafBlock,
  type ReportBlock,
  type TableBlock,
  type TimelineBlock,
} from '@/soc/chat/blocks/schema';

const chart = (over: Record<string, unknown> = {}) => ({
  id: 't1.a1',
  type: 'chart',
  kind: 'hbar',
  unit: 'count',
  provenance: 'code',
  artifact_kind: 'categories',
  allowed_views: ['hbar'],
  title: 'Top source IPs',
  x: { kind: 'category', values: ['10.0.0.1', '10.0.0.2'] },
  series: [{ key: 'events', label: 'Events', values: [12, 7] }],
  ...over,
});

/** One canonical block of every type, in the backend's serialized form. */
const VALID: Record<string, Record<string, unknown>> = {
  markdown: { type: 'markdown', id: 'm1', provenance: 'ai', text: '**Hi**' },
  kpi_group: {
    type: 'kpi_group',
    id: 'k1',
    provenance: 'code',
    artifact_kind: 'kpis',
    allowed_views: ['kpi_group'],
    items: [{ key: 'risk', label: 'Active Risk Index', unit: 'score', display: 'gauge', value: 42 }],
  },
  chart: chart(),
  heatmap: {
    type: 'heatmap',
    id: 'h1',
    provenance: 'code',
    artifact_kind: 'heatmap',
    allowed_views: ['heatmap'],
    unit: 'count',
    x: { values: ['00', '01'] },
    y: { values: ['Mon'] },
    cells: [[1, null]],
  },
  table: {
    type: 'table',
    id: 'tb1',
    provenance: 'source',
    artifact_kind: 'table',
    allowed_views: ['table'],
    columns: [{ key: 'host', label: 'Host', type: 'entity', untrusted: true }],
    rows: [['web-1']],
  },
  case_list: {
    type: 'case_list',
    id: 'cl1',
    provenance: 'code',
    artifact_kind: 'case_list',
    allowed_views: ['case_list'],
    items: [{ case_id: 'case-0042', title: 'Brute force', verdict: 'true_positive', status: 'open' }],
  },
  timeline: {
    type: 'timeline',
    id: 'tl1',
    provenance: 'code',
    artifact_kind: 'timeline',
    allowed_views: ['timeline'],
    events: [{ at: '2026-10-08T01:00:00Z', label: 'Case opened' }],
  },
  entity: {
    type: 'entity',
    id: 'e1',
    provenance: 'source',
    artifact_kind: 'entity',
    allowed_views: ['entity'],
    entity: { kind: 'ip', value: '203.0.113.9' },
    risk: 80,
  },
  mitre: {
    type: 'mitre',
    id: 'mi1',
    provenance: 'code',
    artifact_kind: 'mitre',
    allowed_views: ['mitre'],
    techniques: [{ id: 'T1110', name: 'Brute Force', count: 3 }],
  },
  query: {
    type: 'query',
    id: 'q1',
    provenance: 'source',
    artifact_kind: 'query',
    allowed_views: ['query'],
    language: 'kql',
    query: 'event.action:logon-failed',
  },
  callout: { type: 'callout', id: 'c1', provenance: 'ai', tone: 'warning', text: 'Partial data' },
  citations: {
    type: 'citations',
    id: 'ci1',
    provenance: 'code',
    items: [{ n: 1, kind: 'docs', label: 'Chat', ref: { doc: '/docs/0.1/analyst/chat/' } }],
  },
  guide: {
    type: 'guide',
    id: 'g1',
    provenance: 'code',
    artifact_kind: 'guide',
    allowed_views: ['guide'],
    steps: [{ text: 'Open Settings' }],
    links: [{ label: 'Sources', ref: { page: 'settings', opts: { section: 'sources' } } }],
  },
  report: {
    type: 'report',
    id: 'r1',
    provenance: 'ai',
    title: 'Shift brief',
    template: 'shift',
    scope: { generated_at: '2026-10-08T00:00:00Z', sources: ['Primary'] },
    sections: [{ id: 's1', heading: 'Summary', blocks: [{ type: 'markdown', id: 'r1-1', provenance: 'ai', text: 'Quiet shift.' }] }],
  },
};

const one = <T extends AnswerBlock>(raw: unknown): T => {
  const { blocks } = parseBlocks([raw]);
  return blocks[0] as T;
};

describe('parseBlocks — every type', () => {
  it('covers the whole catalogue', () => {
    expect(Object.keys(VALID).sort()).toEqual([...BLOCK_TYPES].sort());
  });

  it.each(Object.keys(VALID))('keeps a canonical %s block', (type) => {
    const { blocks, dropped } = parseBlocks([VALID[type]]);
    expect(dropped).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe(type);
    expect(blocks[0].id).toBe(VALID[type].id);
    // Normalised: explicit base defaults so renderers need none of their own.
    expect(typeof blocks[0].truncated).toBe('boolean');
    expect(Array.isArray(blocks[0].allowed_views)).toBe(true);
    // Idempotent: parsing the parsed form changes nothing.
    expect(parseBlocks(blocks).blocks).toEqual(blocks);
  });
});

describe('parseBlocks — never throws, keeps positions', () => {
  it.each([undefined, null, 1, 'x', {}, { a: 1 }])('treats a non-list (%j) as no blocks', (raw) => {
    expect(() => parseBlocks(raw)).not.toThrow();
    expect(parseBlocks(raw).blocks).toEqual([]);
  });

  it('replaces junk in place with fallback callouts', () => {
    const junk: unknown[] = [
      null,
      7,
      'x',
      [],
      {},
      { type: 5 },
      { type: 'hologram', fallback_text: 'A chart of‮ things' },
      { type: 'chart' },
      { type: 'report', sections: 'x' },
      { type: 'table', columns: null },
      { type: 'markdown', text: { a: 1 } },
      VALID.callout,
    ];
    const { blocks, dropped } = parseBlocks(junk);
    expect(blocks).toHaveLength(junk.length);
    expect(dropped).toHaveLength(junk.length - 1);
    expect(blocks.slice(0, -1).every((b) => b.type === 'callout' && (b as CalloutBlock).text === FALLBACK_TEXT)).toBe(true);
    expect(blocks[6].fallback_text).toBe('A chart of things');
    expect(blocks.at(-1)?.id).toBe('c1');
    expect(dropped.map((d) => d.reason)).toContain('unknown_type');
  });

  it('drops blocks past the per-message limit', () => {
    const many = Array.from({ length: LIMITS.blocks_per_message + 3 }, (_, i) => ({ ...VALID.markdown, id: `m${i}` }));
    const { blocks, dropped } = parseBlocks(many);
    expect(blocks).toHaveLength(LIMITS.blocks_per_message);
    expect(new Set(dropped.map((d) => d.reason))).toEqual(new Set(['block_limit']));
  });

  it('makes ids valid and unique (never a DOM id; anchors only)', () => {
    const { blocks } = parseBlocks([
      { ...VALID.callout, id: 'same' },
      { ...VALID.markdown, id: 'same' },
      { ...VALID.markdown, id: 'Bad ID!" onmouseover="x' },
    ]);
    expect(blocks.map((b) => b.id)).toEqual(['same', 'same-2', 'b3']);
  });

  it('does not let prototype keys or extra fields through', () => {
    const evil = JSON.parse('{"type":"callout","id":"c9","provenance":"code","text":"x","__proto__":{"polluted":true},"style":"color:red"}');
    const block = one<CalloutBlock>(evil);
    expect(block.type).toBe('callout');
    expect('style' in block).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parseBlocks — strings, numbers and provenance', () => {
  it('sanitises and clamps strings without stripping markup characters', () => {
    const block = one<CalloutBlock>({ ...VALID.callout, text: 'Al‮ert​\u0000\n<script>x</script>', title: 'T'.repeat(300) });
    expect(block.text).toBe('Alert\n<script>x</script>');
    expect(Array.from(block.title ?? '')).toHaveLength(LIMITS.title);
    expect(block.title?.endsWith('…')).toBe(true);
  });

  it('turns non-finite numbers, booleans and numeric strings into null (not measured)', () => {
    const c = one<ChartBlock>(
      chart({
        x: { kind: 'category', values: ['a', 'b', 'c'] },
        series: [{ key: 's', label: 'S', values: [Number.NaN, true, 4] }],
      }),
    );
    expect(c.series[0].values).toEqual([null, null, 4]);
    const k = one<KpiGroupBlock>({
      ...VALID.kpi_group,
      items: [
        { key: 'a', label: 'A', value: Number.POSITIVE_INFINITY, unit: 'count' },
        { key: 'b', label: 'B', value: '12', unit: 'count' },
        { key: 'c', label: 'C', value: 140, unit: 'score', display: 'gauge' },
      ],
    });
    expect(k.items.map((i) => i.value)).toEqual([null, null, 140]);
    expect(k.items[2].display).toBeUndefined(); // a gauge only shows a 0..100 index
  });

  it('defaults a missing provenance to ai (G5 fail-safe)', () => {
    const { provenance, ...rest } = VALID.table;
    void provenance;
    expect(one<TableBlock>(rest).provenance).toBe('ai');
  });

  it('fails safe on a malformed untrusted flag', () => {
    expect(one<TableBlock>({ ...VALID.table, untrusted: 'nope' }).untrusted).toBe(true);
  });
});

describe('parseBlocks — repairs mirror the backend', () => {
  it('aligns series to x and keeps the newest time points', () => {
    const n = LIMITS.points + 10;
    const c = one<ChartBlock>(
      chart({
        kind: 'line',
        artifact_kind: 'series',
        allowed_views: ['line', 'table'],
        x: { kind: 'time', values: Array.from({ length: n }, (_, i) => `2026-10-08T00:${String(i % 60).padStart(2, '0')}:00Z`) },
        series: [
          { key: 's', label: 'S', values: Array.from({ length: n }, (_, i) => i) },
          { key: 'short', label: 'Short', values: [1] },
        ],
      }),
    );
    expect(c.x.values).toHaveLength(LIMITS.points);
    expect(c.truncated).toBe(true);
    expect(c.series[0].values.at(-1)).toBe(n - 1);
    expect(c.series[1].values[0]).toBeNull();
    expect(c.series[1].values).toHaveLength(LIMITS.points);
  });

  it('clips series to 8 and enforces donut shape', () => {
    const many = one<ChartBlock>(chart({ series: Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, label: 'S', values: [1, 2] })) }));
    expect(many.series).toHaveLength(LIMITS.series);
    expect(many.truncated).toBe(true);
    const seven = one(chart({ kind: 'donut', x: { values: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, series: [{ key: 's', label: 'S', values: [1, 1, 1, 1, 1, 1, 1] }] }));
    expect(seven.type).toBe('callout');
  });

  it('requires the view to fit the artifact kind and filters allowed_views', () => {
    expect(one(chart({ kind: 'line' })).type).toBe('callout');
    const filtered = one<ChartBlock>(chart({ allowed_views: ['line', 'table', 'warp'] }));
    expect(filtered.allowed_views).toEqual(['hbar', 'table']);
    expect(one<CalloutBlock>({ ...VALID.callout, allowed_views: ['table'] }).allowed_views).toEqual([]);
    expect(allowedViewsFor('categories', 7)).not.toContain('donut');
    expect(blockView(one(chart()))).toBe('hbar');
  });

  it('repairs table columns positionally and aligns rows', () => {
    const t = one<TableBlock>({
      ...VALID.table,
      columns: [{ key: 'a b', label: 'A' }, { key: 'a b', label: 'B', type: 'laser' }, 'junk'],
      rows: [[1, { x: 1 }, 'y'.repeat(900), 'extra'], 'bad-row', ...Array.from({ length: 300 }, (_, i) => [i])],
      sort: { key: 'missing', dir: 'asc' },
    });
    expect(t.columns.map((c) => c.key)).toEqual(['c1', 'c2', 'c3']);
    expect(t.columns[1].type).toBe('text');
    expect(t.rows[0].slice(0, 2)).toEqual([1, null]);
    expect(Array.from(String(t.rows[0][2]))).toHaveLength(LIMITS.cell_chars);
    expect(t.rows[1]).toEqual([null, null, null]);
    expect(t.rows).toHaveLength(LIMITS.table_rows);
    expect(t.truncated).toBe(true);
    expect(t.sort).toBeUndefined();
  });

  it('aligns the heatmap grid to both axes', () => {
    const h = one<HeatmapBlock>({ ...VALID.heatmap, x: { values: Array.from({ length: 60 }, (_, i) => String(i)) }, y: { values: ['a', 'b'] }, cells: [[1, 2, 3]] });
    expect(h.x.values).toHaveLength(LIMITS.heatmap_x);
    expect(h.cells).toHaveLength(2);
    expect(h.cells.every((r) => r.length === LIMITS.heatmap_x)).toBe(true);
    expect(h.cells[1].every((v) => v === null)).toBe(true);
  });

  it('normalises case lists and orders timelines', () => {
    const cases = one<CaseListBlock>({
      ...VALID.case_list,
      items: [{ case_id: 'case-1', verdict: 'FALSE_POSITIVE', status: 'teleported', risk: 140 }, { case_id: '<script>', title: 'x' }],
    });
    expect(cases.items).toEqual([{ case_id: 'case-1', title: 'case-1', verdict: 'false_positive' }]);
    const tl = one<TimelineBlock>({
      ...VALID.timeline,
      events: [
        { at: '2026-10-08T03:00:00Z', label: 'c' },
        { at: 'not a time', label: 'dropped' },
        { at: '2026-10-08T01:00:00+00:00', label: 'a' },
        { at: '2026-10-08T02:00:00', label: 'b', kind: 'warp' },
      ],
    });
    expect(tl.events.map((e) => e.label)).toEqual(['a', 'b', 'c']);
    expect(tl.events[1].kind).toBeUndefined();
  });

  it('validates and normalises ATT&CK technique ids', () => {
    const m = one({ ...VALID.mitre, techniques: [{ id: 't1059.001' }, { id: 'T12' }, { id: 'TA0001' }] });
    expect(m.type === 'mitre' ? m.techniques.map((t) => t.id) : []).toEqual(['T1059.001']);
  });

  it('enforces the report envelope: leaves only, ≤ 40 leaves, never empty', () => {
    const leaves = Array.from({ length: LIMITS.report_leaves + 5 }, (_, i) => ({ ...VALID.markdown, id: `l${i}` }));
    const { blocks, dropped } = parseBlocks([{ ...VALID.report, sections: [{ id: 's1', heading: 'All', blocks: [...leaves, VALID.report] }] }]);
    const report = blocks[0] as ReportBlock;
    expect(report.type).toBe('report');
    expect(report.sections[0].blocks).toHaveLength(LIMITS.report_leaves);
    expect(new Set(dropped.map((d) => d.reason))).toEqual(new Set(['report_leaf_limit']));
    const nested = parseBlocks([{ ...VALID.report, sections: [{ heading: 'x', blocks: [VALID.report, VALID.callout] }] }]);
    const nestedReport = nested.blocks[0] as ReportBlock;
    expect(nestedReport.sections[0].blocks.map((b) => b.type)).toEqual(['callout', 'callout']);
    expect((nestedReport.sections[0].blocks[0] as CalloutBlock).text).toBe(FALLBACK_TEXT);
    expect(nested.dropped[0].reason).toBe('nested_report');
    expect(leafBlocks([report]).length).toBe(LIMITS.report_leaves);
    const untitled = parseBlocks([{ ...VALID.report, sections: [{ blocks: [VALID.callout] }] }]);
    expect((untitled.blocks[0] as ReportBlock).sections[0].heading).toBe('Section 1');
  });
});

describe('refs (G2: links are typed refs, never URLs)', () => {
  it.each([
    { doc: 'https://evil.example/' },
    { doc: '/docs/0.1/../../api/admin' },
    { doc: 'javascript:alert(1)' },
    { doc: '/docs/0.1/x', extra: 1 },
    { page: 'Settings' },
    { page: 'not_a_page' },
    { page: 'settings', opts: { caseId: '<x>' } },
    { page: 'settings', opts: { href: 'x' } },
    { page: 'cases', opts: { window: 0 } },
    { page: 'cases', opts: { status: 'teleported' } },
    'https://evil.example/',
  ])('rejects %j', (ref) => {
    expect(parseRef(ref)).toBeNull();
  });

  it('accepts validated in-app and Help Center refs', () => {
    expect(parseInternalRef({ page: 'cases', opts: { caseId: 'case-1', window: 24, status: 'open', severity: 'high' } })).toEqual({
      page: 'cases',
      opts: { caseId: 'case-1', window: 24, status: 'open', severity: 'high' },
    });
    expect(parseDocRef({ doc: '/docs/0.1/analyst/chat/#sources' })).toEqual({ doc: '/docs/0.1/analyst/chat/#sources' });
    const ref = parseRef({ page: 'settings', opts: { section: 'sources' } });
    expect(ref && isInternalRef(ref)).toBe(true);
    const doc = parseRef({ doc: '/docs/0.1/analyst/chat/' });
    expect(doc && isDocRef(doc)).toBe(true);
  });

  it('drops an invalid link without dropping the block', () => {
    const guide = one<GuideBlock>({
      ...VALID.guide,
      links: [
        { label: 'Bad', ref: { doc: 'https://evil.example/' } },
        { label: 'Docs', ref: { doc: '/docs/0.1/analyst/chat/#sources' } },
      ],
    });
    expect(guide.links.map((l) => l.label)).toEqual(['Docs']);
    const c = one<ChartBlock>(chart({ drill: [{ page: 'cases', opts: { caseId: 'case-1' } }, { page: 'javascript' }] }));
    expect(c.drill).toEqual([{ page: 'cases', opts: { caseId: 'case-1' } }, null]);
  });
});

describe('helpers', () => {
  it('maps a legacy table to an untrusted text table block', () => {
    const block = legacyTableBlock({ columns: ['host', 'count'], rows: [['web-1', 3]], truncated: true });
    expect(block).toMatchObject({ type: 'table', provenance: 'source', untrusted: true, truncated: true });
    expect(block?.columns.every((c) => c.type === 'text' && c.untrusted)).toBe(true);
    expect(legacyTableBlock(null)).toBeNull();
    expect(legacyTableBlock({ columns: [], rows: [] })).toBeNull();
  });

  it('recognises retention stubs and builds fallbacks', () => {
    const stub = parseBlock({
      type: 'callout',
      id: 't1.a1',
      provenance: 'code',
      tone: 'info',
      text: 'Expired from saved history',
      title: 'Top source IPs',
      expired: { type: 'chart', artifact_kind: 'categories' },
    });
    expect(isExpiredBlock(stub)).toBe(true);
    expect(isExpiredBlock(parseBlock(VALID.callout))).toBe(false);
    expect(fallbackBlock('b9', 'Was a chart').fallback_text).toBe('Was a chart');
    expect(parseBlock('junk').type).toBe('callout');
  });
});

describe('parseBlocks — limits per container', () => {
  const callouts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `c${i}`, type: 'callout', provenance: 'code', tone: 'info', text: `c${i}` }));
  const answer = { id: 'answer', type: 'markdown', provenance: 'ai', text: 'The answer' };

  it('keeps a report section snapshot whole: the answer plus a full turn', () => {
    const raw = [answer, ...callouts(LIMITS.blocks_per_message)];
    const section = parseBlocks(raw, { limit: LIMITS.section_blocks });
    expect(LIMITS.section_blocks).toBe(LIMITS.blocks_per_message + 1);
    expect(section.blocks).toHaveLength(13);
    expect(section.dropped).toEqual([]);
    // The answer limit still applies by default.
    const answerOnly = parseBlocks(raw);
    expect(answerOnly.blocks).toHaveLength(12);
    expect(answerOnly.dropped).toEqual([{ path: '13', type: 'callout', reason: 'block_limit' }]);
  });

  it('ignores a nonsensical limit instead of rendering everything', () => {
    const raw = callouts(20);
    expect(parseBlocks(raw, { limit: Number.NaN }).blocks).toHaveLength(LIMITS.blocks_per_message);
    expect(parseBlocks(raw, { limit: -3 }).blocks).toHaveLength(0);
  });

  it('drops timeline events outside the shared timestamp grammar', () => {
    const { blocks } = parseBlocks([
      {
        id: 'tl', type: 'timeline', provenance: 'code', artifact_kind: 'timeline',
        events: [
          { at: '20261008T101010Z', label: 'basic format' },
          { at: '2026-W41-3', label: 'week date' },
          { at: '2026-02-30T00:00:00Z', label: 'no such day' },
          { at: '2026-10-08T10:10:10Z', label: 'ok' },
        ],
      },
    ]);
    const timeline = blocks[0] as TimelineBlock;
    expect(timeline.events.map((e) => e.label)).toEqual(['ok']);
  });
});

describe('parseBlocks — empty data blocks are dropped, never rendered as shells (D3)', () => {
  const empties: Array<[string, Record<string, unknown>]> = [
    ['table', { ...VALID.table, rows: [] }],
    ['chart', chart({ series: [{ key: 's', label: 'S', values: [null, Number.NaN] }] })],
    ['chart', chart({ x: { kind: 'time', values: [] }, series: [{ key: 's', label: 'S', values: [] }] })],
    ['heatmap', { ...VALID.heatmap, cells: [] }],
    ['case_list', { ...VALID.case_list, items: [] }],
    ['timeline', { ...VALID.timeline, events: [] }],
    ['mitre', { ...VALID.mitre, techniques: [] }],
    ['citations', { ...VALID.citations, items: [] }],
    ['guide', { ...VALID.guide, steps: [], links: [] }],
  ];

  it.each(empties)('drops an empty %s with reason "empty" and no fallback', (type, raw) => {
    const { blocks, dropped } = parseBlocks([VALID.markdown, raw, VALID.query]);
    expect(blocks.map((b) => b.type)).toEqual(['markdown', 'query']);
    expect(dropped).toEqual([{ path: '2', type, reason: 'empty' }]);
    expect(isEmptyDataBlock(one<LeafBlock>(VALID[type]))).toBe(false);
  });

  it('keeps the ids of the blocks after a dropped one (positional on the raw list)', () => {
    const { blocks } = parseBlocks([{ ...VALID.table, id: undefined, rows: [] }, { ...VALID.query, id: undefined }]);
    expect(blocks.map((b) => b.id)).toEqual(['b2']);
  });

  it('drops an empty report leaf, and a report whose every leaf is empty', () => {
    const report = (leaves: unknown[]) => ({
      type: 'report',
      id: 'r1',
      provenance: 'code',
      title: 'Hunt report',
      scope: { sources: [], generated_at: '2026-10-08T10:00:00Z' },
      sections: [{ id: 's1', heading: 'Evidence', blocks: leaves }],
    });
    const mixed = parseBlocks([report([{ ...VALID.table, rows: [] }, VALID.query])]);
    expect(mixed.blocks).toHaveLength(1);
    const kept = mixed.blocks[0];
    expect(kept.type === 'report' && kept.sections[0].blocks.map((b) => b.type)).toEqual(['query']);
    expect(mixed.dropped).toEqual([{ path: '1.s1.1', type: 'table', reason: 'empty' }]);

    const allEmpty = parseBlocks([report([{ ...VALID.table, rows: [] }, { ...VALID.case_list, items: [] }])]);
    expect(allEmpty.blocks).toEqual([]);
    expect(allEmpty.dropped.map((d) => d.reason)).toEqual(['empty', 'empty', 'empty']);
  });

  it('a legacy table with no rows is not a block', () => {
    expect(legacyTableBlock({ columns: ['ip'], rows: [], truncated: false })).toBeNull();
  });
});
