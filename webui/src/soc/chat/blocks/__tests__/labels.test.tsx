/**
 * The ONE wording of the answer-block enums (Round 12 polish, tour 2 finding Q1): the
 * badges a case list or typed table draws on screen and every file an answer or report is
 * exported to read the same words. A download says "True positive", "Needs human",
 * "Critical" and "Escalated" where the screen does, never `true_positive` or `critical`.
 * Only JSON keeps the stored keys.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SeverityBadge, StatusBadge, VerdictBadge } from '@/soc/components/badges';
import { severityLabel, statusLabel, verdictLabel } from '@/soc/components/semantic-labels';

import { blockTabular, toCSV, toTSV } from '../export-helpers';
import { columnPartLabel } from '../format';
import {
  CITATION_KIND_LABEL,
  ENTITY_KIND_LABEL,
  QUERY_LANGUAGE_LABEL,
  TIMELINE_KIND_LABEL,
  booleanText,
  queryCaption,
  semanticColumn,
  semanticText,
} from '../labels';
import { QueryView } from '../renderers/SimpleViews';
import type { AnswerBlock, QueryBlock } from '../schema';
import {
  CASE_STATUS_KEYS,
  CITATION_KINDS,
  ENTITY_KINDS,
  QUERY_LANGUAGES,
  SEVERITY_KEYS,
  TIMELINE_KINDS,
  VERDICT_KEYS,
  parseBlocks,
} from '../schema';

const badgeText = (node: React.ReactElement): string => {
  const { container, unmount } = render(node);
  const text = container.textContent ?? '';
  unmount();
  return text;
};

const one = (raw: Record<string, unknown>): AnswerBlock => {
  const { blocks } = parseBlocks([raw], { limit: 1 });
  expect(blocks).toHaveLength(1);
  return blocks[0];
};

const RAW_ENUM = /\b(true_positive|false_positive|needs_human|on_hold)\b/;

describe('the shared enum words match the badges', () => {
  it.each(SEVERITY_KEYS)('severity %s reads as its badge', (key) => {
    expect(semanticText('severity', key)).toBe(badgeText(<SeverityBadge severity={key} icon={false} />));
    expect(semanticText('severity', key)).toBe(severityLabel(key));
  });

  it.each(VERDICT_KEYS)('verdict %s reads as its badge', (key) => {
    expect(semanticText('verdict', key)).toBe(badgeText(<VerdictBadge verdict={key} icon={false} />));
    expect(semanticText('verdict', key)).not.toMatch(/_/);
  });

  it.each(CASE_STATUS_KEYS)('status %s reads as its badge', (key) => {
    expect(semanticText('status', key)).toBe(badgeText(<StatusBadge status={key} icon={false} />));
    expect(semanticText('status', key)).not.toMatch(/_/);
  });

  it('says the words the tour expected', () => {
    expect(semanticText('verdict', 'true_positive')).toBe('True positive');
    expect(semanticText('verdict', 'needs_human')).toBe('Needs human');
    expect(semanticText('severity', 'critical')).toBe('Critical');
    expect(semanticText('status', 'escalated')).toBe('Escalated');
    expect(semanticText('status', 'on_hold')).toBe('On hold');
    // The legacy lifecycle alias reads as the F8 taxonomy does on screen.
    expect(semanticText('status', 'needs_human')).toBe('Open · awaiting analyst');
    expect(statusLabel('NEEDS_HUMAN')).toBe('Open · awaiting analyst');
    expect(verdictLabel(null)).toBe('Unverdicted');
    expect(verdictLabel('none')).toBe('Unverdicted');
  });

  it('matches a key in any case and leaves text the screen shows as text unchanged', () => {
    expect(semanticText('verdict', ' TRUE_POSITIVE ')).toBe('True positive');
    expect(semanticText('severity', 'High')).toBe('High');
    // Not a badge key: the screen prints it as written, so the file does too.
    expect(semanticText('severity', 'crit')).toBe('crit');
    expect(semanticText('status', 'paused by vendor')).toBe('paused by vendor');
    expect(severityLabel('sev-9')).toBeNull();
  });

  it('marks only severity, verdict and status columns', () => {
    expect(semanticColumn('severity')).toBe('severity');
    expect(semanticColumn('verdict')).toBe('verdict');
    expect(semanticColumn('status')).toBe('status');
    for (const t of ['text', 'number', 'risk', 'time', 'case', 'entity', 'code', 'mitre'] as const) expect(semanticColumn(t)).toBeNull();
    expect(semanticColumn(undefined)).toBeNull();
  });

  it('names every entity, timeline and citation kind in words', () => {
    for (const k of ENTITY_KINDS) expect(ENTITY_KIND_LABEL[k]).toMatch(/^[A-Z]/);
    for (const k of TIMELINE_KINDS) expect(TIMELINE_KIND_LABEL[k]).toMatch(/^[A-Z]/);
    for (const k of CITATION_KINDS) expect(CITATION_KIND_LABEL[k]).toMatch(/^[A-Z]/);
    expect(ENTITY_KIND_LABEL.ip).toBe('IP address');
    expect(booleanText(true)).toBe('Yes');
    expect(booleanText(false)).toBe('No');
  });

  it.each(QUERY_LANGUAGES)('query language %s: the caption the screen draws is the shared one', (language) => {
    const block = one({ id: `q-${language}`, type: 'query', provenance: 'code', language, query: 'x', source_name: 'Elastic', hits: 1250 }) as QueryBlock;
    const caption = queryCaption(block);
    expect(caption).toBe(`${QUERY_LANGUAGE_LABEL[language]} · Elastic · 1,250 hits`);
    const { container, unmount } = render(<QueryView block={block} />);
    expect(container.textContent).toContain(caption);
    unmount();
  });

  it('names the query languages as people read them, never the upper-cased key', () => {
    expect(QUERY_LANGUAGE_LABEL).toEqual({ kql: 'KQL', lucene: 'Lucene', esql: 'ES|QL', dsl: 'Query DSL', sql: 'SQL' });
    const block = one({ id: 'q', type: 'query', provenance: 'code', language: 'esql', query: 'FROM x' }) as QueryBlock;
    // No source and no hit count: the language alone.
    expect(queryCaption(block)).toBe('ES|QL');
  });
});

describe('Copy data and the per-block CSV use the screen words', () => {
  const caseList = () =>
    one({
      id: 'open',
      type: 'case_list',
      title: 'Highest-risk open cases',
      provenance: 'code',
      artifact_kind: 'case_list',
      allowed_views: ['case_list', 'table'],
      items: [
        { case_id: 'case-1', title: 'Phishing chain', severity: 'critical', verdict: 'true_positive', status: 'escalated', risk: 88, created_at: '2026-10-12T11:04:05Z' },
        { case_id: 'case-2', title: 'Loan API access', severity: 'high', verdict: 'needs_human', status: 'on_hold', risk: 55, created_at: '2026-09-29T11:49:00Z' },
      ],
    });

  it('writes a case list in badge words, keeping the stored keys in the projection', () => {
    const tab = blockTabular(caseList())!;
    // The projection keeps the keys (the "Show table" view draws them as badges) …
    expect(tab.rows[0].slice(2, 5)).toEqual(['critical', 'true_positive', 'escalated']);
    // … and every file and the clipboard write the badge words.
    const csv = toCSV(tab);
    expect(csv).toContain('"case-1","Phishing chain","Critical","True positive","Escalated",88,');
    expect(csv).toContain('"case-2","Loan API access","High","Needs human","On hold",55,');
    expect(csv).not.toMatch(RAW_ENUM);
    expect(csv).not.toMatch(/"(critical|escalated|high)"/);
    const tsv = toTSV(tab);
    expect(tsv.split('\n')[1].split('\t').slice(2, 5)).toEqual(['Critical', 'True positive', 'Escalated']);
    expect(tsv).not.toMatch(RAW_ENUM);
  });

  it('writes a typed table column, a timeline kind, an entity kind and a citation kind in words', () => {
    const table = one({
      id: 'typed',
      type: 'table',
      title: 'Typed',
      provenance: 'code',
      artifact_kind: 'table',
      allowed_views: ['table'],
      columns: [
        { key: 's', label: 'Severity', type: 'severity' },
        { key: 'v', label: 'Verdict', type: 'verdict' },
        { key: 't', label: 'Status', type: 'status' },
        { key: 'r', label: 'Rule', type: 'text' },
      ],
      rows: [['critical', 'false_positive', 'needs_human', 'critical_rule_on_hold']],
    });
    const csv = toCSV(blockTabular(table)!);
    // Plain text is never rewritten, even when it contains an enum-looking word.
    expect(csv.split('\r\n')[1]).toBe('"Critical","False positive","Open · awaiting analyst","critical_rule_on_hold"');
    const timeline = one({
      id: 'tl',
      type: 'timeline',
      title: 'What happened',
      provenance: 'source',
      artifact_kind: 'timeline',
      allowed_views: ['timeline', 'table'],
      events: [{ at: '2026-10-08T00:04:00Z', label: 'Rule fired', kind: 'detection' }],
    });
    expect(toCSV(blockTabular(timeline)!)).toContain('"Detection"');
    const entity = one({
      id: 'ioc',
      type: 'entity',
      provenance: 'source',
      artifact_kind: 'entity',
      allowed_views: ['entity'],
      entity: { kind: 'ip', value: '203.0.113.14' },
      facts: [],
      reputation: [{ provider: 'AbuseIPDB', verdict: 'malicious', score: 92 }],
      counts: [],
      related_cases: [],
    });
    const entityCsv = toCSV(blockTabular(entity)!);
    expect(entityCsv).toContain('"Kind","IP address"');
    expect(entityCsv).toContain('"Reputation: AbuseIPDB","Malicious (92)"');
    const cites = one({
      id: 'cites',
      type: 'citations',
      provenance: 'code',
      artifact_kind: null,
      allowed_views: ['citations'],
      items: [{ n: 1, kind: 'runbook', label: 'Brute force runbook' }],
    });
    expect(toCSV(blockTabular(cites)!)).toContain('1,"Runbook","Brute force runbook"');
  });
});

describe('column part notes', () => {
  it('names one column in the singular and a range in the plural', () => {
    expect(columnPartLabel(1, 5, 6)).toBe('Columns 1–5 of 6');
    expect(columnPartLabel(6, 6, 6, true)).toBe('Column 6 of 6 (continued)');
    expect(columnPartLabel(1, 1, 6)).toBe('Column 1 of 6');
    expect(columnPartLabel(13, 24, 24, true)).toBe('Columns 13–24 of 24 (continued)');
    expect(columnPartLabel(1001, 1200, 1200, true)).toBe('Columns 1,001–1,200 of 1,200 (continued)');
    for (const s of [columnPartLabel(6, 6, 6, true), columnPartLabel(1, 5, 6)]) expect(s).not.toMatch(/(\d+)–\1 /);
  });
});
