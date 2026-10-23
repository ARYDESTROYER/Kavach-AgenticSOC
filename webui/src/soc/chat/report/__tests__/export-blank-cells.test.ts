/**
 * Blank cells in report exports (Round 13 closing pass, BLOCKS.md amendment 35): a blank
 * text cell is empty in every human format (Markdown, HTML, Word, Excel), as it is on
 * screen; only a value not measured (a blank `number` or `risk` cell, a case without a
 * risk score) is marked "—", and the methodology line counts exactly those marks. A
 * campaign with no technique therefore never exports as an unexplained not-measured dash,
 * and an empty code cell never becomes a blank code chip.
 */
import { describe, expect, it } from 'vitest';

import type { Report } from '@/lib/types';

import { buildReportDoc, notMeasuredCount, notMeasuredTableCell } from '../model';
import { reportToMarkdown } from '../export/markdown';
import { reportToHtml } from '../export/html';
import { docxParts } from '../export/docx';
import { reportToXlsx } from '../export/xlsx';
import { NOT_MEASURED, codeCellText, documentNodes, type DocNode } from '../export/walker';
import { parseBlock } from '../../blocks/schema';
import { NOW, sampleReport } from './fixtures';
import { parseXml, zipMap } from './zip-reader';

const campaigns = {
  id: 'open-campaigns',
  type: 'table',
  title: 'Open campaigns',
  provenance: 'source',
  artifact_kind: 'table',
  allowed_views: ['table'],
  columns: [
    { key: 'name', label: 'Campaign', type: 'text' },
    { key: 'techniques', label: 'Techniques', type: 'mitre' },
    { key: 'cases', label: 'Cases', type: 'number', unit: 'count' },
    { key: 'risk', label: 'Risk', type: 'risk' },
  ],
  rows: [
    ['Lateral movement on fin-db', 'T1021, T1078', 4, 82],
    ['Phishing wave', '', null, 40],
    ['Quiet campaign', null, 2, null],
  ],
};

const cases = {
  id: 'cases',
  type: 'case_list',
  title: 'Cases',
  provenance: 'source',
  artifact_kind: 'case_list',
  allowed_views: ['list', 'table'],
  items: [
    { case_id: 'demo-1', case_number: 'CASE-000001', title: 'Scored', severity: 'high', verdict: 'TRUE_POSITIVE', status: 'OPEN', risk: 71, created_at: '2026-10-08T10:00:00Z' },
    { case_id: 'demo-2', case_number: 'CASE-000002', title: 'Not yet scored', severity: 'low', status: 'OPEN', risk: null, created_at: '2026-10-08T11:00:00Z' },
  ],
};

function report(): Report {
  const base = sampleReport();
  const at = (id: string, block: Record<string, unknown>) => ({
    id,
    kind: 'block' as const,
    block,
    note: null,
    source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: String(block.id) },
    scope: { window: 'last 24h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
    added_at: '2026-10-08T13:00:00Z',
  });
  return { ...base, summary: null, items: [at('it-c', campaigns), at('it-l', cases)] };
}

const doc = () => buildReportDoc(report(), { author: 'ana', appVersion: '0.1.13', generatedAt: NOW.toISOString(), sourceTurns: null });

function tableNode(head0: string): Extract<DocNode, { k: 'table' }> {
  const node = documentNodes(doc(), { defang: false }).find((n): n is Extract<DocNode, { k: 'table' }> => n.k === 'table' && n.head[0] === head0);
  if (!node) throw new Error(`no ${head0} table`);
  return node;
}

describe('blank cells in report exports', () => {
  it('marks only a value not measured, and leaves any other blank cell empty', () => {
    const table = tableNode('Campaign');
    expect(table.head).toEqual(['Campaign', 'Techniques', 'Cases', 'Risk']);
    // A campaign with no technique ('' or null) is empty, never "—".
    expect(table.rows[1][1]).toBe('');
    expect(table.rows[2][1]).toBe('');
    // A blank figure is not measured: "—", which the methodology line counts.
    expect(table.rows[1][2]).toBe(NOT_MEASURED);
    expect(table.rows[2][3]).toBe(NOT_MEASURED);
    expect(table.rows[0]).toEqual(['Lateral movement on fin-db', 'T1021, T1078', '4', '82/100']);

    // A case list: a missing verdict is empty; a case without a risk score is not measured.
    const list = tableNode('Case');
    expect(list.head[3]).toBe('Verdict');
    expect(list.rows[1][3]).toBe('');
    expect(list.rows[1][5]).toBe(NOT_MEASURED);
    expect(list.rows[0][5]).toBe('71/100');
  });

  it('counts in the methodology line exactly the cells it marks', () => {
    const d = doc();
    const marks = documentNodes(d, { defang: false })
      .filter((n): n is Extract<DocNode, { k: 'table' }> => n.k === 'table')
      .reduce((n, t) => n + t.rows.flat().filter((c) => c === NOT_MEASURED).length, 0);
    expect(marks).toBe(3);
    expect(notMeasuredCount(parseBlock(campaigns) as never)).toBe(2);
    expect(notMeasuredCount(parseBlock(cases) as never)).toBe(1);
    expect(d.methodology).toContain('3 values were not measured and are shown as "—", never as 0.');
  });

  it('defines not measured as a blank number or risk cell only', () => {
    expect(notMeasuredTableCell('number', null)).toBe(true);
    expect(notMeasuredTableCell('risk', '')).toBe(true);
    expect(notMeasuredTableCell('number', 0)).toBe(false);
    expect(notMeasuredTableCell('mitre', '')).toBe(false);
    expect(notMeasuredTableCell('text', null)).toBe(false);
    expect(codeCellText('')).toBe(false);
    expect(codeCellText(NOT_MEASURED)).toBe(false);
    expect(codeCellText('T1021')).toBe(true);
  });

  it('writes no dash and no empty code span for a blank Techniques cell in Markdown and HTML', () => {
    const md = reportToMarkdown(doc(), { defang: false });
    const phishing = md.split('\n').find((l) => l.startsWith('| Phishing wave'));
    expect(phishing).toBe('| Phishing wave |   | — | 40/100 |');
    expect(md).not.toMatch(/` +`/);

    const html = reportToHtml(doc(), { defang: false });
    expect(html).not.toContain('<code></code>');
    expect(html).toMatch(/<td>Phishing wave<\/td><td><\/td><td class="num">—<\/td>/);
  });

  it('leaves the Word cell empty and the Excel cell absent', () => {
    const xml = parseXml(docxParts(doc(), { defang: false }).document);
    const rows = Array.from(xml.getElementsByTagName('w:tr')).map((tr) =>
      Array.from(tr.getElementsByTagName('w:tc')).map((tc) => tc.textContent ?? ''),
    );
    expect(rows.find((r) => r[0] === 'Phishing wave')).toEqual(['Phishing wave', '', '—', '40/100']);
    expect(rows.find((r) => r[0] === 'Quiet campaign')).toEqual(['Quiet campaign', '', '2', '—']);

    // Excel: a blank cell is no cell at all (not measured too: never a 0, never a dash).
    const parts = zipMap(reportToXlsx(doc(), { now: NOW }));
    const sheet = (title: string) =>
      [...parts.entries()].find(([k, v]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k) && v.text.includes(`<t xml:space="preserve">${title}</t></is></c></row><row r="2">`))![1].text;
    const camp = sheet('Open campaigns');
    expect(camp).not.toContain('—');
    expect(camp).toContain('<row r="4"><c r="A4" t="inlineStr"><is><t xml:space="preserve">Phishing wave</t></is></c><c r="D4" s="9"><v>40</v></c></row>');
    const list = sheet('Cases');
    expect(list).not.toContain('—');
    expect(list).not.toContain('r="D4"');
    expect(list).not.toContain('r="F4"');
  });
});
