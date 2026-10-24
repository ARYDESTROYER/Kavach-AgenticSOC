/**
 * Report exports name a case as the screen does (Round 13 polish, re-shoot PW2-1): a case
 * list's Case column and an indicator card's related cases read the case's display
 * number ("CASE-000045"), never its internal id, in Markdown, HTML, Word, Excel and Print,
 * and in the conversation exports. A case the server sent without a number keeps its
 * internal id there: without it two cases with one title could not be told apart. The
 * machine formats (CSV, JSON) keep the internal id.
 */
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatConversation, Report, ReportItem } from '@/lib/types';

import { buildReportDoc } from '../model';
import { conversationToHtml, conversationToMarkdown } from '../export/conversation';
import { defangBlocks } from '../export/defang-blocks';
import { reportToDocx } from '../export/docx';
import { reportToHtml } from '../export/html';
import { reportToJson } from '../export/json';
import { reportToMarkdown } from '../export/markdown';
import { PRINT_ROOT_ID, clearPrintRoot, printDocument } from '../export/print';
import { documentNodes, type TableNode } from '../export/walker';
import { reportToXlsx } from '../export/xlsx';
import { parseBlock } from '../../blocks/schema';
import { NOW } from './fixtures';
import { parseXml, zipMap } from './zip-reader';

/* -------------------------------------------------------------------------- */
/* Fixtures.                                                                   */
/* -------------------------------------------------------------------------- */

const SCOPE = { window: 'last 7 days', sources: [], generated_by: 'demo-chat', app_version: '0.1.13', demo: true };

/** Two numbered cases and one the server sent without a number. */
const CASES = {
  type: 'case_list',
  id: 'open',
  title: 'Open cases',
  provenance: 'code',
  artifact_kind: 'case_list',
  allowed_views: ['case_list', 'table'],
  untrusted: true,
  items: [
    { case_id: 'demo-recent-00000539-0002', case_number: 'CASE-000045', title: 'ip:203.0.113.77 · AUTH-ANOMALY', severity: 'high', status: 'new', risk: 72 },
    { case_id: 'demo-00000539-0010', case_number: 'CASE-000046', title: 'user:dsingh sign-in', severity: 'medium', status: 'investigating', risk: 40 },
    { case_id: 'demo-00000539-0020', title: 'user:trao sign-in', severity: 'low', status: 'investigating', risk: 20 },
  ],
};

/** An indicator card with one numbered related case and one without a number. */
const INDICATOR = {
  type: 'entity',
  id: 'ioc',
  provenance: 'source',
  artifact_kind: 'entity',
  allowed_views: ['entity'],
  entity: { kind: 'ip', value: '203.0.113.77' },
  facts: [],
  reputation: [],
  counts: [],
  related_cases: [
    { case_id: 'demo-recent-00000539-0002', case_number: 'CASE-000045', title: 'ip:203.0.113.77 · AUTH-ANOMALY', severity: 'high' },
    { case_id: 'demo-00000539-0020', title: 'user:trao sign-in' },
  ],
};

/** The ids of the numbered cases: no human-readable export may print them. */
const NUMBERED_IDS = ['demo-recent-00000539-0002', 'demo-00000539-0010'];

function section(id: string, title: string, blocks: Array<Record<string, unknown>>): ReportItem {
  return {
    id,
    kind: 'section',
    block: { title, blocks, truncated: false },
    note: null,
    source: { conversation_id: 'chat-1', message_id: 'msg-2', block_id: null },
    scope: SCOPE,
    added_at: '2026-10-08T13:00:00Z',
  } as ReportItem;
}

function report(): Report {
  return {
    id: 'rep-cases',
    owner: 'Admin',
    title: 'Open work',
    template: 'executive',
    conversation_id: 'chat-1',
    items: [section('it-cases', 'Cases', [CASES]), section('it-ioc', 'Indicator', [INDICATOR])],
    summary: null,
    created_at: '2026-10-08T13:00:00Z',
    updated_at: '2026-10-08T13:00:00Z',
    version: 1,
  } as Report;
}

function conversation(): ChatConversation {
  return {
    id: 'chat-1',
    title: 'Open cases',
    created_at: '2026-10-08T13:00:00Z',
    updated_at: '2026-10-08T13:00:05Z',
    message_count: 2,
    messages: [
      { id: 'msg-1', role: 'user', content: 'Which cases are open?', created_at: '2026-10-08T13:00:00Z' },
      {
        id: 'msg-2',
        role: 'assistant',
        content: '3 cases are open.',
        created_at: '2026-10-08T13:00:05Z',
        response: { answer: '3 cases are open.', blocks: [CASES, INDICATOR], message_id: 'msg-2' },
      },
    ],
  } as unknown as ChatConversation;
}

const doc = () => buildReportDoc(report(), { author: 'Admin', appVersion: '0.1.13', generatedAt: NOW.toISOString() });

/* -------------------------------------------------------------------------- */
/* Readers.                                                                    */
/* -------------------------------------------------------------------------- */

/** The Case column of every table whose header has "Case" and "Title". */
function caseColumn(tables: string[][][]): string[] {
  const out: string[] = [];
  for (const table of tables) {
    const h = table.findIndex((r) => r.includes('Case') && r.includes('Title'));
    if (h < 0) continue;
    const at = table[h].indexOf('Case');
    for (const row of table.slice(h + 1)) out.push((row[at] ?? '').replace(/[`[\]]/g, ''));
  }
  return out;
}

function markdownTables(md: string): string[][][] {
  const tables: string[][][] = [];
  let current: string[][] | null = null;
  for (const line of md.split('\n')) {
    if (line.startsWith('|')) {
      if (/^\|\s*-/.test(line)) continue;
      const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
      if (!current) tables.push((current = []));
      current.push(cells);
    } else current = null;
  }
  return tables;
}

function htmlTables(html: string): string[][][] {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(dom.querySelectorAll('table')).map((t) =>
    Array.from(t.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim())),
  );
}

function wordTables(xml: Document): string[][][] {
  return Array.from(xml.getElementsByTagName('w:tbl')).map((t) =>
    Array.from(t.getElementsByTagName('w:tr')).map((tr) => Array.from(tr.getElementsByTagName('w:tc')).map((c) => (c.textContent ?? '').trim())),
  );
}

function excelSheets(zip: Uint8Array): string[][][] {
  const sheets: string[][][] = [];
  for (const [name, entry] of zipMap(zip)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = parseXml(entry.text, name);
    sheets.push(
      Array.from(xml.getElementsByTagName('row')).map((row) =>
        Array.from(row.getElementsByTagName('c')).map((c) => (c.getElementsByTagName('t')[0]?.textContent ?? c.getElementsByTagName('v')[0]?.textContent ?? '').trim()),
      ),
    );
  }
  return sheets;
}

const EXPECTED_COLUMN = ['CASE-000045', 'CASE-000046', 'demo-00000539-0020'];

function expectNoNumberedIds(text: string): void {
  for (const id of NUMBERED_IDS) expect(text, id).not.toContain(id);
}

/* -------------------------------------------------------------------------- */
/* Tests.                                                                      */
/* -------------------------------------------------------------------------- */

describe('report exports name a case by its number', () => {
  it('the document nodes: the Case column and the related cases', () => {
    const nodes = documentNodes(doc(), { defang: false });
    const tables = nodes.filter((n): n is TableNode => n.k === 'table').map((t) => [t.head, ...t.rows]);
    expect(caseColumn(tables)).toEqual(EXPECTED_COLUMN);
    const related = nodes.find((n) => n.k === 'list');
    expect(related && related.k === 'list' ? related.items.map((line) => line.map((r) => r.text).join('')) : []).toEqual([
      'CASE-000045: ip:203.0.113.77 · AUTH-ANOMALY',
      'demo-00000539-0020: user:trao sign-in',
    ]);
    expectNoNumberedIds(JSON.stringify(nodes));
  });

  it.each([true, false])('Markdown (defang %s)', (defang) => {
    const md = reportToMarkdown(doc(), { defang });
    expect(caseColumn(markdownTables(md))).toEqual(EXPECTED_COLUMN);
    expect(md).toContain('`CASE-000045`: ');
    expectNoNumberedIds(md);
  });

  it('HTML', () => {
    const html = reportToHtml(doc());
    expect(caseColumn(htmlTables(html))).toEqual(EXPECTED_COLUMN);
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
    expect(text).toContain('CASE-000045: ');
    expectNoNumberedIds(html);
  });

  it('Word (.docx), opened again', () => {
    const xml = parseXml(zipMap(reportToDocx(doc(), { now: NOW })).get('word/document.xml')!.text);
    expect(caseColumn(wordTables(xml))).toEqual(EXPECTED_COLUMN);
    const text = xml.documentElement.textContent ?? '';
    expect(text).toContain('CASE-000045: ');
    expectNoNumberedIds(text);
  });

  it('Excel (.xlsx), opened again: the table sheet and the Report sheet', () => {
    const sheets = excelSheets(reportToXlsx(doc(), { now: NOW }));
    // The case list's own sheet carries the Case column; the Report sheet lists the
    // indicator's related cases.
    expect(caseColumn(sheets)).toEqual(EXPECTED_COLUMN);
    // (Defanged by default, as people read the Report sheet: "203[.]0[.]113[.]77".)
    expect(sheets[0].map((r) => r[0])).toContain('• CASE-000045: ip:203[.]0[.]113[.]77 · AUTH-ANOMALY');
    expectNoNumberedIds(JSON.stringify(sheets));
  });

  it('the conversation exports (Markdown and HTML)', () => {
    const md = conversationToMarkdown(conversation(), { now: NOW });
    expect(caseColumn(markdownTables(md))).toEqual(EXPECTED_COLUMN);
    expectNoNumberedIds(md);
    const html = conversationToHtml(conversation(), { now: NOW });
    expect(caseColumn(htmlTables(html))).toEqual(EXPECTED_COLUMN);
    expectNoNumberedIds(html);
  });

  it('JSON, the machine-readable copy, keeps the internal id beside the number', () => {
    const json = reportToJson(report());
    expect(json).toContain('"case_id": "demo-recent-00000539-0002"');
    expect(json).toContain('"case_number": "CASE-000045"');
  });
});

describe('Print / Save as PDF names a case by its number', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'print', { configurable: true, writable: true, value: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => {
      clearPrintRoot();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it.each([true, false])('the case list and the related cases (defang %s)', async (defang) => {
    await act(async () => {
      await printDocument(doc(), { defang });
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    const text = root.textContent ?? '';
    expect(text).toContain('CASE-000045');
    expect(text).toContain('CASE-000046');
    // The internal id of a numbered case is only a tooltip, as on screen.
    expectNoNumberedIds(text);
    expect(root.querySelector('[data-case-ref="number"]')?.getAttribute('title')).toBe('demo-recent-00000539-0002');
  });

  it('defanging the print copy never rewrites a case number', () => {
    const list = parseBlock({ ...CASES, items: [{ ...CASES.items[0], case_number: 'SOC.IR-0042' }] });
    const [printed] = defangBlocks([list]);
    expect(printed.type === 'case_list' ? printed.items[0].case_number : null).toBe('SOC.IR-0042');
  });
});
