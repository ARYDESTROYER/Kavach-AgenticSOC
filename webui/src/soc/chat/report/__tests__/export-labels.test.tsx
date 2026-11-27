/**
 * Every export says what the screen says (Round 12 polish, final tour finding Q1): a
 * lifetime performance report and an open-cases answer are generated in every format
 * (Markdown, HTML, Word, Excel, CSV, JSON, Print) and the files are opened again (the
 * Office packages through the strict ZIP reader and an XML parser). The Open work table
 * reads "Critical", "True positive", "Needs human", "Escalated" and "On hold" as the case
 * list badges do, never `critical`, `true_positive`, `needs_human` or `on_hold`. Only the
 * JSON export, the machine-readable copy, keeps the stored keys.
 *
 * A yes/no cell reads "Yes" or "No" in every format but JSON, the CSV and Copy data
 * included, as the table does on screen. A query block's caption names its language as
 * the screen does ("ES|QL", "Lucene", "Query DSL"), never the upper-cased key; the code
 * fence keeps the raw key as its syntax hint.
 *
 * Also: a Word table split by columns names a single-column part "Column 4 of 4
 * (continued)", never "Columns 4–4 of 4".
 */
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatConversation, Report, ReportItem } from '@/lib/types';

import { blockTabular, toCSV, toTSV } from '../../blocks/export-helpers';
import { parseBlock } from '../../blocks/schema';
import { buildConversationDoc, buildReportDoc } from '../model';
import { conversationToHtml, conversationToMarkdown } from '../export/conversation';
import { reportTablesCsv } from '../export/csv';
import { columnChunks, reportToDocx } from '../export/docx';
import { reportToHtml } from '../export/html';
import { reportToJson } from '../export/json';
import { reportToMarkdown } from '../export/markdown';
import { PRINT_ROOT_ID, clearPrintRoot, printDocument } from '../export/print';
import { documentNodes, type TableNode } from '../export/walker';
import { reportToXlsx, workbookModel } from '../export/xlsx';
import { NOW } from './fixtures';
import { parseXml, zipMap } from './zip-reader';

/* -------------------------------------------------------------------------- */
/* Fixtures: the shapes the live demo produced on the final tour.             */
/* -------------------------------------------------------------------------- */

const SCOPE = { window: 'all time (since 28 Sep 2026)', sources: [], generated_by: 'demo-chat', app_version: '0.1.13', demo: true };

/** The lifetime report's "Open work" section (`case_list`), one case per enum shape. */
const OPEN_WORK = {
  type: 'case_list',
  id: 'b12',
  title: 'Highest-risk open cases',
  caption: 'Top 4 of 20 · 20 cases · exact · all time',
  provenance: 'code',
  artifact_kind: 'case_list',
  allowed_views: ['case_list', 'table'],
  untrusted: true,
  truncated: true,
  total: 20,
  items: [
    { case_id: 'demo-recent-00000539-0000', title: 'user:vpatel phishing chain', severity: 'critical', verdict: 'true_positive', status: 'escalated', risk: 88, created_at: '2026-10-12T11:04:05Z' },
    { case_id: 'demo-00000539-0004', title: 'user:dsingh sign-in', severity: 'high', verdict: 'needs_human', status: 'on_hold', risk: 64, created_at: '2026-10-10T14:52:49Z' },
    { case_id: 'demo-00000539-0012', title: 'user:rmenon sign-in', severity: 'medium', verdict: 'false_positive', status: 'needs_human', risk: 40, created_at: '2026-10-07T18:26:48Z' },
    { case_id: 'demo-00000539-0020', title: 'user:trao sign-in', severity: 'low', verdict: 'undetermined', status: 'investigating', risk: 20, created_at: '2026-10-05T15:35:04Z' },
  ],
};

/** The same cases as a typed `table` (the column TYPE drives the words, as on screen). */
const TYPED_TABLE = {
  type: 'table',
  id: 'typed',
  title: 'Cases waiting on an analyst',
  provenance: 'code',
  artifact_kind: 'table',
  allowed_views: ['table'],
  columns: [
    { key: 'case', label: 'Case', type: 'case' },
    { key: 'sev', label: 'Severity', type: 'severity' },
    { key: 'verdict', label: 'Verdict', type: 'verdict' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'auto', label: 'Auto-closed', type: 'text' },
  ],
  rows: [
    ['demo-00000539-0004', 'high', 'needs_human', 'on_hold', false],
    ['demo-recent-00000539-0000', 'critical', 'true_positive', 'escalated', true],
  ],
};

const SEVERITY_CHART = {
  type: 'chart',
  id: 'b4',
  kind: 'donut',
  title: 'Cases by severity',
  provenance: 'code',
  artifact_kind: 'categories',
  allowed_views: ['donut', 'bar', 'table'],
  unit: 'count',
  x: { kind: 'category', values: ['Critical', 'High', 'Medium', 'Low'], label: 'Severity' },
  series: [{ key: 'count', label: 'Count', values: [18, 19, 5, 41] }],
};

/** The log searches behind the numbers, one per language whose key is not its word. */
const QUERIES = [
  { type: 'query', id: 'q-esql', provenance: 'code', language: 'esql', query: 'FROM all-logs-* | WHERE event.outcome == "failure"', source_name: 'Elastic', hits: 12 },
  { type: 'query', id: 'q-lucene', provenance: 'code', language: 'lucene', query: 'event.outcome:failure', source_name: 'Elastic', hits: 3 },
  { type: 'query', id: 'q-dsl', provenance: 'code', language: 'dsl', query: '{"match_all": {}}', hits: 1250 },
];

/** Each query's caption as the screen's code block shows it (`queryCaption`). */
const QUERY_CAPTIONS = ['ES|QL · Elastic · 12 hits', 'Lucene · Elastic · 3 hits', 'Query DSL · 1,250 hits'];

/** The upper-cased keys a caption must never print (the fence's own `esql` is fine). */
const RAW_LANGUAGE = /(?<!Query )\b(ESQL|LUCENE|DSL) ·/;

function section(id: string, title: string, blocks: Array<Record<string, unknown>>): ReportItem {
  return {
    id,
    kind: 'section',
    block: { title, blocks, truncated: false },
    note: null,
    source: { conversation_id: 'chat-lifetime', message_id: 'msg-2', block_id: null },
    scope: SCOPE,
    added_at: '2026-10-12T10:56:00Z',
  } as ReportItem;
}

function lifetimeReport(): Report {
  return {
    id: 'rep-lifetime',
    owner: 'Admin',
    title: 'Lifetime performance report',
    template: 'executive',
    conversation_id: 'chat-lifetime',
    items: [
      section('it-overview', 'Overview', [{ id: 'b1', type: 'markdown', provenance: 'ai', text: '83 cases over all time, 20 open now.' }]),
      section('it-volume', 'Volume', [SEVERITY_CHART]),
      section('it-open', 'Open work', [OPEN_WORK]),
      section('it-waiting', 'Waiting on an analyst', [TYPED_TABLE]),
      section('it-queries', 'Searches', QUERIES),
    ],
    summary: null,
    created_at: '2026-10-12T10:56:00Z',
    updated_at: '2026-10-12T10:57:00Z',
    version: 1,
  } as Report;
}

/** "The open cases, when were they opened, month by month": prose, a chart, the cases. */
function openCasesConversation(): ChatConversation {
  const question = 'The amount of total cases right now that are open, when were they all opened? Segregate month wise';
  return {
    id: 'chat-open',
    title: question,
    created_at: '2026-10-12T10:56:00Z',
    updated_at: '2026-10-12T10:56:05Z',
    message_count: 2,
    messages: [
      { id: 'msg-1', role: 'user', content: question, created_at: '2026-10-12T10:56:00Z' },
      {
        id: 'msg-2',
        role: 'assistant',
        content: '20 cases are open now.',
        created_at: '2026-10-12T10:56:05Z',
        response: {
          answer: '20 cases are open now, most opened in October.',
          blocks: [
            {
              type: 'chart',
              id: 'by-month',
              kind: 'bar',
              title: 'Cases by month',
              provenance: 'code',
              artifact_kind: 'series',
              allowed_views: ['bar', 'table'],
              unit: 'count',
              x: { kind: 'category', values: ['Sep 2026', 'Oct 2026'], label: 'Month' },
              series: [{ key: 'open', label: 'Open cases', values: [6, 14] }],
            },
            { ...OPEN_WORK, id: 'oldest', title: 'Oldest open cases' },
          ],
          message_id: 'msg-2',
        },
      },
    ],
  } as unknown as ChatConversation;
}

const reportDoc = () => buildReportDoc(lifetimeReport(), { author: 'Admin', appVersion: '0.1.13', generatedAt: NOW.toISOString() });
const conversationDoc = () => buildConversationDoc(openCasesConversation(), { author: 'Admin', appVersion: '0.1.13', generatedAt: NOW.toISOString() });

/* -------------------------------------------------------------------------- */
/* Expectations.                                                              */
/* -------------------------------------------------------------------------- */

/** The stored keys a human document must never print. */
const RAW_ENUM = /(?<![\w-])(true_positive|false_positive|needs_human|on_hold|true\\_positive|false\\_positive|needs\\_human|on\\_hold)(?![\w-])/;

/** Each case row as the case list badges say it: Severity, Verdict, Status. */
const EXPECTED: Record<string, [string, string, string]> = {
  'demo-recent-00000539-0000': ['Critical', 'True positive', 'Escalated'],
  'demo-00000539-0004': ['High', 'Needs human', 'On hold'],
  'demo-00000539-0012': ['Medium', 'False positive', 'Open · awaiting analyst'],
  'demo-00000539-0020': ['Low', 'Undetermined', 'Investigating'],
};

const LOWER_CELL = /^(critical|high|medium|low|escalated|investigating|undetermined)$/;

/** The case rows of every table whose header has Severity, Verdict and Status. */
function caseRows(tables: string[][][]): Array<{ id: string; words: [string, string, string]; all: string[] }> {
  const out: Array<{ id: string; words: [string, string, string]; all: string[] }> = [];
  for (const table of tables) {
    // The header row (a spreadsheet's table sheet puts a title and a caption above it).
    const h = table.findIndex((r) => r.includes('Severity') && r.includes('Verdict') && r.includes('Status'));
    if (h < 0) continue;
    const head = table[h];
    const rows = table.slice(h + 1);
    const at = (name: string) => head.indexOf(name);
    for (const row of rows) {
      const id = row[at('Case')]?.replace(/[`[\]]/g, '') ?? '';
      out.push({ id, words: [row[at('Severity')], row[at('Verdict')], row[at('Status')]], all: row });
    }
  }
  return out;
}

function expectScreenWords(tables: string[][][], minRows = 4): void {
  const rows = caseRows(tables);
  expect(rows.length).toBeGreaterThanOrEqual(minRows);
  for (const r of rows) {
    expect(EXPECTED[r.id], r.id).toBeDefined();
    expect(r.words, r.id).toEqual(EXPECTED[r.id]);
    for (const cell of r.all) expect(cell, r.id).not.toMatch(LOWER_CELL);
  }
}

/** Markdown pipe tables as rows of trimmed cells. */
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

/** HTML tables (the export's own `<table>`s) as rows of cell text. */
function htmlTables(html: string): string[][][] {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(dom.querySelectorAll('table')).map((t) =>
    Array.from(t.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim())),
  );
}

/** Word tables from `word/document.xml`. */
function wordTables(xml: Document): string[][][] {
  return Array.from(xml.getElementsByTagName('w:tbl')).map((t) =>
    Array.from(t.getElementsByTagName('w:tr')).map((tr) => Array.from(tr.getElementsByTagName('w:tc')).map((c) => (c.textContent ?? '').trim())),
  );
}

/** Every worksheet of an `.xlsx` package as its rows of cell text (inline strings and numbers). */
function excelSheets(zip: Uint8Array): string[][][] {
  const parts = zipMap(zip);
  const sheets: string[][][] = [];
  for (const [name, entry] of parts) {
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

/** CSV sections ("# n. title" label rows) as tables of unquoted cells. */
function csvTables(csv: string): string[][][] {
  const parse = (line: string): string[] => (line.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g) ?? []).filter((m) => m !== '').map((m) => m.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  return csv
    .replace(/^﻿/, '')
    .split('\r\n\r\n')
    .map((part) => part.split('\r\n').filter((l) => l && !l.startsWith('"#')).map(parse));
}

const docxText = (zip: Uint8Array): Document => parseXml(zipMap(zip).get('word/document.xml')!.text);

/* -------------------------------------------------------------------------- */
/* Tests.                                                                     */
/* -------------------------------------------------------------------------- */

describe('every export of the lifetime report uses the screen words', () => {
  it('the document nodes (the single source of Markdown, HTML, Word and Excel)', () => {
    const tables = documentNodes(reportDoc(), { defang: false })
      .filter((n): n is TableNode => n.k === 'table')
      .map((t) => [t.head, ...t.rows]);
    expectScreenWords(tables, 6);
    // A yes/no cell reads Yes/No as the table does on screen.
    const waiting = tables.find((t) => t[0].includes('Auto-closed'))!;
    expect(waiting.slice(1).map((r) => r[4])).toEqual(['No', 'Yes']);
  });

  it.each([true, false])('Markdown (defang %s)', (defang) => {
    const md = reportToMarkdown(reportDoc(), { defang });
    expectScreenWords(markdownTables(md), 6);
    expect(md).not.toMatch(RAW_ENUM);
  });

  it('HTML', () => {
    const html = reportToHtml(reportDoc());
    expectScreenWords(htmlTables(html), 6);
    expect(html).not.toMatch(RAW_ENUM);
  });

  it('Word (.docx), opened again', () => {
    const xml = docxText(reportToDocx(reportDoc(), { now: NOW }));
    expectScreenWords(wordTables(xml), 6);
    expect(xml.documentElement.textContent).not.toMatch(RAW_ENUM);
  });

  it('Excel (.xlsx), opened again: the Report sheet and every table sheet', () => {
    const zip = reportToXlsx(reportDoc(), { now: NOW });
    const sheets = excelSheets(zip);
    expectScreenWords(sheets, 6);
    for (const sheet of sheets) for (const row of sheet) for (const cell of row) expect(cell).not.toMatch(RAW_ENUM);
    // The table sheets keep the exact data (undefanged) and still say the screen words.
    const model = workbookModel(reportDoc());
    const open = model.sheets.find((s) => s.name.endsWith('Highest-risk open cases'))!;
    const texts = open.rows.map((r) => r.map((c) => (c?.kind === 'text' ? c.text : c ? String((c as { value?: number }).value) : '')));
    expect(texts.find((r) => r[0] === 'demo-recent-00000539-0000')!.slice(2, 5)).toEqual(['Critical', 'True positive', 'Escalated']);
  });

  it('CSV (all tables)', () => {
    const csv = reportTablesCsv(reportDoc())!;
    expectScreenWords(csvTables(csv), 6);
    expect(csv).not.toMatch(RAW_ENUM);
    expect(csv).toContain('"demo-recent-00000539-0000","user:vpatel phishing chain","Critical","True positive","Escalated",88,');
    // The yes/no column reads as the table on screen and every other format: Yes / No.
    const waiting = csvTables(csv).find((t) => t[0]?.includes('Auto-closed'))!;
    expect(waiting.slice(1).map((r) => r[4])).toEqual(['No', 'Yes']);
    expect(csv).toContain('"demo-recent-00000539-0000","Critical","True positive","Escalated","Yes"');
    expect(csv).not.toMatch(/,(true|false)(\r\n|$)/m);
  });

  it('JSON keeps the stored keys (the machine-readable copy)', () => {
    const json = reportToJson(lifetimeReport());
    expect(json).toContain('"verdict": "true_positive"');
    expect(json).toContain('"status": "on_hold"');
    expect(json).toContain('"severity": "critical"');
    expect(json).not.toContain('True positive');
    // A yes/no cell stays a JSON boolean, a query language its key.
    expect(json).toMatch(/"demo-recent-00000539-0000",\s*"critical",\s*"true_positive",\s*"escalated",\s*true\s*\]/);
    expect(json).toContain('"language": "esql"');
  });
});

describe('query captions name the language as the screen does', () => {
  it('the document nodes keep the raw key as the fence hint and the word in the caption', () => {
    const code = documentNodes(reportDoc(), { defang: false }).filter((n) => n.k === 'code');
    const blocks = code.filter((n) => n.k === 'code' && n.caption && !/^\d+\. /.test(n.caption));
    expect(blocks.map((n) => n.k === 'code' && n.caption)).toEqual(QUERY_CAPTIONS);
    expect(blocks.map((n) => n.k === 'code' && n.lang)).toEqual(['esql', 'lucene', 'dsl']);
  });

  it.each([true, false])('Markdown (defang %s): the caption line, the fence keeps `esql`', (defang) => {
    const md = reportToMarkdown(reportDoc(), { defang });
    // Markdown escapes the pipe in text, which renders as "ES|QL".
    for (const caption of QUERY_CAPTIONS) expect(md).toContain(`_${caption.replace('|', '\\|')}_`);
    expect(md).toContain('```esql\n');
    expect(md).not.toMatch(RAW_LANGUAGE);
  });

  it('HTML', () => {
    const html = reportToHtml(reportDoc());
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
    for (const caption of QUERY_CAPTIONS) expect(text).toContain(caption);
    expect(text).not.toMatch(RAW_LANGUAGE);
  });

  it('Word (.docx), opened again', () => {
    const xml = docxText(reportToDocx(reportDoc(), { now: NOW }));
    const paragraphs = Array.from(xml.getElementsByTagName('w:p')).map((p) => p.textContent ?? '');
    for (const caption of QUERY_CAPTIONS) expect(paragraphs).toContain(caption);
    expect(xml.documentElement.textContent).not.toMatch(RAW_LANGUAGE);
  });

  it('the Excel Report sheet', () => {
    const report = excelSheets(reportToXlsx(reportDoc(), { now: NOW }))[0].map((r) => r[0]);
    for (const caption of QUERY_CAPTIONS) expect(report).toContain(caption);
    for (const line of report) expect(line ?? '').not.toMatch(RAW_LANGUAGE);
  });

  it('the conversation exports', () => {
    const convo = openCasesConversation();
    const answer = convo.messages[1] as unknown as { response: { blocks: unknown[] } };
    answer.response.blocks.push(QUERIES[0]);
    const md = conversationToMarkdown(convo, { now: NOW });
    expect(md).toContain('_ES\\|QL · Elastic · 12 hits_');
    const html = new DOMParser().parseFromString(conversationToHtml(convo, { now: NOW }), 'text/html').body.textContent ?? '';
    expect(html).toContain('ES|QL · Elastic · 12 hits');
    expect(md).not.toMatch(RAW_LANGUAGE);
    expect(html).not.toMatch(RAW_LANGUAGE);
  });
});

describe('a yes/no cell reads Yes or No in the CSV and Copy data too', () => {
  const table = () => parseBlock(TYPED_TABLE);

  it('CSV of one block', () => {
    const csv = toCSV(blockTabular(table())!);
    expect(csv.split('\r\n').slice(1).map((line) => line.split(',').pop())).toEqual(['"No"', '"Yes"']);
  });

  it('Copy data (TSV)', () => {
    const tsv = toTSV(blockTabular(table())!);
    expect(tsv.split('\n').slice(1).map((line) => line.split('\t').pop())).toEqual(['No', 'Yes']);
  });

  it('a boolean in a numeric column reads the same way (the screen shows Yes/No in any column)', () => {
    const block = parseBlock({
      ...TYPED_TABLE,
      id: 'num-bool',
      columns: [{ key: 'n', label: 'Matched', type: 'number' }],
      rows: [[true], [false], [3]],
    });
    expect(toCSV(blockTabular(block)!).split('\r\n')).toEqual(['"Matched"', '"Yes"', '"No"', '3']);
  });
});

describe('every export of the open-cases answer uses the screen words', () => {
  it('Markdown and HTML conversation exports', () => {
    const md = conversationToMarkdown(openCasesConversation(), { now: NOW });
    expectScreenWords(markdownTables(md));
    expect(md).not.toMatch(RAW_ENUM);
    const html = conversationToHtml(openCasesConversation(), { now: NOW });
    expectScreenWords(htmlTables(html));
    expect(html).not.toMatch(RAW_ENUM);
  });

  it('Word, Excel and CSV of the answer saved as a report', () => {
    const doc = conversationDoc();
    expectScreenWords(wordTables(docxText(reportToDocx(doc, { now: NOW }))));
    expectScreenWords(excelSheets(reportToXlsx(doc, { now: NOW })));
    const csv = reportTablesCsv(doc)!;
    expectScreenWords(csvTables(csv));
    expect(csv).not.toMatch(RAW_ENUM);
  });
});

describe('Print / Save as PDF uses the screen words', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'print', { configurable: true, writable: true, value: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => {
      clearPrintRoot();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('draws the case list and the typed table with the badge words', async () => {
    await act(async () => {
      await printDocument(reportDoc(), { defang: false });
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    const text = root.textContent ?? '';
    for (const words of Object.values(EXPECTED)) for (const w of words) expect(text).toContain(w);
    expect(text).not.toMatch(RAW_ENUM);
  });
});

describe('Word column split notes', () => {
  /** A table whose last part holds one column: four 20-character value columns. */
  function wideReport(): Report {
    const word = (i: number) => `${String.fromCharCode(65 + i)}`.repeat(20);
    const table = {
      type: 'table',
      id: 'wide',
      title: 'Wide table',
      provenance: 'code',
      artifact_kind: 'table',
      allowed_views: ['table'],
      columns: [{ key: 'k', label: 'Key', type: 'text' }, ...[0, 1, 2, 3].map((i) => ({ key: `c${i}`, label: word(i), type: 'text' }))],
      rows: [['row-label-of-twenty!', word(4), word(5), word(6), word(7)]],
    };
    return { ...lifetimeReport(), items: [section('it-wide', 'Wide', [table])] };
  }

  it('names a one-column part in the singular, and only later parts "continued"', () => {
    const doc = buildReportDoc(wideReport(), { generatedAt: NOW.toISOString() });
    const node = documentNodes(doc, { defang: false }).find((n): n is TableNode => n.k === 'table')!;
    const chunks = columnChunks(node.head.map((h, i) => [h, ...node.rows.map((r) => r[i] ?? '')]));
    // The fixture really ends in a single-column part (row label + one column).
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1]).toHaveLength(2);
    const xml = docxText(reportToDocx(doc, { now: NOW }));
    const notes = Array.from(xml.getElementsByTagName('w:p'))
      .map((p) => p.textContent ?? '')
      .filter((t) => /^Columns? \d/.test(t));
    expect(notes).toHaveLength(chunks.length);
    expect(notes[0]).toMatch(/^Columns 1–\d of 4$/);
    expect(notes[notes.length - 1]).toBe('Column 4 of 4 (continued)');
    for (const n of notes) expect(n).not.toMatch(/(\d+)–\1 /);
  });
});

describe('an indicator card names its kind once in a report export (T14)', () => {
  /** `lookup_indicator`'s card as answers saved before the fix hold it: a raw "Kind ip" fact. */
  const INDICATOR = {
    type: 'entity',
    id: 'ioc',
    provenance: 'source',
    artifact_kind: 'entity',
    allowed_views: ['entity'],
    entity: { kind: 'ip', value: '198.51.100.250' },
    facts: [
      { label: 'Kind', value: 'ip' },
      { label: 'Providers', value: '1 of 1 answered' },
    ],
    reputation: [],
    counts: [],
    related_cases: [],
  };

  it('writes one Kind row, in words, in the document nodes and the Markdown', () => {
    const doc = buildReportDoc({ ...lifetimeReport(), items: [section('it-ioc', 'Indicator', [INDICATOR])] }, { generatedAt: NOW.toISOString() });
    const table = documentNodes(doc, { defang: false }).find((n): n is TableNode => n.k === 'table')!;
    const kindRows = table.rows.filter((row) => row[0] === 'Kind');
    expect(kindRows).toEqual([['Kind', 'IP address']]);
    expect(table.rows.map((row) => row[0])).toContain('Providers');
    const md = reportToMarkdown(doc, { defang: false });
    expect(md.match(/\| Kind \|/g)).toHaveLength(1);
    expect(md).not.toMatch(/\| ip \|/);
  });
});
