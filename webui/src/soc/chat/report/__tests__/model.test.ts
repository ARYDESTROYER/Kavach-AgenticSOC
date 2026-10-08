/**
 * The report document model (SPEC §9.3): snapshots re-validated, sections parsed with
 * the section limit, and the deterministic "Methodology & limitations" built only from
 * engine-recorded facts (each source turn counted once).
 */
import { describe, expect, it } from 'vitest';

import type { ReportItem } from '@/lib/types';

import {
  AI_SUMMARY_NOTICE,
  READ_ONLY_NOTICE,
  buildReportDoc,
  collectQueries,
  itemBlocks,
  notMeasuredCount,
  sourceTurnsFromConversation,
  timeRangeLabel,
  tokens,
  usd,
} from '../model';
import { LIMITS, parseBlock } from '../../blocks/schema';
import { NOW, rawBlock, sampleConversation, sampleReport } from './fixtures';

describe('itemBlocks', () => {
  it('re-validates a block snapshot and titles it', () => {
    const report = sampleReport();
    const parsed = itemBlocks(report.items[1]);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.title).toBe('Recent sign-in failures');
  });

  it('parses a section with the section limit and keeps the question as the title', () => {
    const many = Array.from({ length: LIMITS.section_blocks + 3 }, (_, i) => ({
      id: `m${i}`,
      type: 'callout',
      provenance: 'ai',
      tone: 'info',
      text: `n${i}`,
    }));
    const item: ReportItem = {
      ...sampleReport().items[0],
      block: { title: 'Q?\u202e', blocks: many, truncated: true },
    };
    const parsed = itemBlocks(item);
    expect(parsed.blocks).toHaveLength(LIMITS.section_blocks);
    expect(parsed.truncated).toBe(true);
    expect(parsed.title).toBe('Q?');
  });

  it('degrades an invalid snapshot to the quiet fallback, never throws', () => {
    const item: ReportItem = { ...sampleReport().items[1], block: { type: 'chart', provenance: 'code' } };
    const parsed = itemBlocks(item);
    expect(parsed.blocks[0].type).toBe('callout');
    expect(parsed.dropped).toBe(1);
  });
});

describe('buildReportDoc', () => {
  const doc = buildReportDoc(sampleReport(), {
    author: 'ana',
    appVersion: '0.1.13',
    generatedAt: NOW.toISOString(),
    sourceTurns: sourceTurnsFromConversation(sampleConversation()),
  });

  it('collects the header facts', () => {
    expect(doc.conversations.map((c) => c.id)).toEqual(['conv-1', 'conv-gone']);
    expect(doc.windows).toEqual(['last 24h']);
    expect(doc.sources).toEqual(['Wazuh']);
    expect(doc.models).toEqual(['demo-chat']);
    expect(doc.demo).toBe(true);
    expect(doc.summary?.stale).toBe(true);
    expect(AI_SUMMARY_NOTICE).toBe('AI-generated; verify before acting.');
  });

  it('writes the methodology from recorded facts, counting each source turn once', () => {
    expect(doc.methodology[0]).toBe(READ_ONLY_NOTICE);
    expect(doc.methodology).toContain('Lookups (2 calls): Counted log events; Searched cases.');
    expect(doc.methodology).toContain(
      '1 lookup read a sample or cached result rather than an exact count (Counted log events: newest 200 of 1,284).',
    );
    expect(doc.methodology).toContain(
      '1 lookup did not complete (1 timed out); figures that depend on them are missing, not zero.',
    );
    expect(doc.methodology.some((l) => l.startsWith('Lookup details were not recorded for 1 item'))).toBe(true);
    expect(doc.methodology).toContain('3 values were not measured and are shown as "—", never as 0.');
    expect(doc.methodology).toContain('The source answers used 2.1k tokens and $0.0042 across 1 answer (simulated).');
    expect(doc.methodology).toContain('The summary used 1.4k tokens and $0.0010 (simulated).');
    expect(doc.methodology).toContain('Demo Mode: the data is synthetic and money figures are simulated.');
  });

  it('says plainly when the source conversations were not loaded', () => {
    const bare = buildReportDoc(sampleReport(), { generatedAt: NOW.toISOString() });
    expect(bare.methodology.some((l) => l.includes('the source conversation was not loaded'))).toBe(true);
    expect(bare.methodology.some((l) => l.startsWith('Lookups ('))).toBe(false);
  });

  it('is deterministic for the same inputs', () => {
    const again = buildReportDoc(sampleReport(), {
      author: 'ana',
      appVersion: '0.1.13',
      generatedAt: NOW.toISOString(),
      sourceTurns: sourceTurnsFromConversation(sampleConversation()),
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(doc));
  });

  it('lists each distinct query once, in document order', () => {
    // Item 1's recorded step, then item 4's query block; the step repeats on later items.
    expect(doc.queries.map((q) => [q.item, q.label])).toEqual([
      [1, 'Counted log events'],
      [4, 'Query'],
    ]);
    expect(collectQueries([...doc.items, ...doc.items])).toHaveLength(2);
  });
});

describe('methodology scoping', () => {
  const turns = sourceTurnsFromConversation(sampleConversation());

  it('attributes to a block only the lookup that produced it', () => {
    const block = { ...rawBlock('signins'), from_step: 2 };
    const report = sampleReport({
      items: [{ ...sampleReport().items[1], block, source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'signins' } }],
      summary: null,
    });
    const doc = buildReportDoc(report, { generatedAt: NOW.toISOString(), sourceTurns: turns });
    expect(doc.items[0].turn?.steps.filter((s) => s.kind === 'tool').map((s) => s.index)).toEqual([2]);
    expect(doc.methodology).toContain('Lookups (1 call): Searched cases.');
    // Step 1's query belongs to another part of the answer: not in this report's appendix.
    expect(doc.queries).toEqual([]);
  });

  it('keeps every lookup for a whole answer, and for a block naming no known step', () => {
    const block = { ...rawBlock('signins'), from_step: 9 };
    const report = sampleReport({ items: [{ ...sampleReport().items[1], block }], summary: null });
    const doc = buildReportDoc(report, { generatedAt: NOW.toISOString(), sourceTurns: turns });
    expect(doc.methodology).toContain('Lookups (2 calls): Counted log events; Searched cases.');
  });

  it('says why an item has no lookup record', () => {
    const base = sampleReport();
    const items = [
      base.items[5], // conv-gone
      { ...base.items[2], id: 'x-1', source: { conversation_id: 'conv-late', message_id: 'm-1', block_id: 'b' } },
      { ...base.items[2], id: 'x-2', source: { conversation_id: 'conv-err', message_id: 'm-2', block_id: 'b' } },
      { ...base.items[2], id: 'x-3', source: { conversation_id: 'conv-1', message_id: 'msg-old', block_id: 'b' } },
    ];
    const doc = buildReportDoc(sampleReport({ items, summary: null }), {
      generatedAt: NOW.toISOString(),
      sourceTurns: turns,
      conversationStatus: new Map([
        ['conv-1', 'read'],
        ['conv-gone', 'gone'],
        ['conv-late', 'skipped'],
        ['conv-err', 'failed'],
      ] as const),
    });
    expect(doc.methodology).toContain('Lookup details were not recorded for 1 item (older answers).');
    expect(doc.methodology).toContain('Lookup details are not available for 1 item: conversation no longer available.');
    expect(doc.methodology).toContain('Lookup details are not shown for 1 item: the source conversation could not be loaded.');
    expect(doc.methodology).toContain(
      'Lookup details are not shown for 1 item: an export reads at most 10 source conversations, and theirs were not read.',
    );
  });
});

describe('helpers', () => {
  it('counts not-measured values per block type', () => {
    expect(notMeasuredCount(parseBlock(rawBlock('kpis')) as never)).toBe(1);
    expect(notMeasuredCount(parseBlock(rawBlock('alerts-by-source')) as never)).toBe(1);
  });

  it('formats money, tokens and windows without the locale', () => {
    expect(usd(0.001)).toBe('$0.0010');
    expect(usd(12.5)).toBe('$12.50');
    expect(tokens(950)).toBe('950');
    expect(tokens(2100)).toBe('2.1k');
    expect(tokens(12_400)).toBe('12k');
    expect(timeRangeLabel('now-7d')).toBe('last 7d');
    expect(timeRangeLabel('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')).toBe('2026-10-01T00:00:00Z → 2026-10-02T00:00:00Z');
  });
});
