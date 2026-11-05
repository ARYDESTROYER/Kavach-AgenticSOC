/**
 * The report Excel writer defuses on the ONE shared formula rule set (Round 14 SPEC
 * §4.5.6, closing fix safety-02).
 *
 * `sheetString` used to gate on a lead test of its own that missed a leading line feed,
 * the full-width `＝ ＋ － ＠` and spaces before a tab, so those cells reached the workbook
 * with neither the quote-prefix style nor an apostrophe. It now gates on `isFormulaLed`
 * from `lib/csv`, the test the shared fixture `csv-formula.contract.json` pins for the
 * CSV writers and the backend audit export. Every formula-led text takes the quote-prefix
 * style and keeps the fixture's apostrophe, with one documented exception: a plain ASCII
 * sign before a number and plain words ("+10 vs previous window", "-3%") shows no
 * apostrophe, because no spreadsheet can turn it into a call, a link or a reference. A
 * sign before a name or a cell reference (`+A1`, `-$B$2`, `+1:1`) is not that exception:
 * re-saved as CSV and reopened it would be the live formula `=+A1`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isFormulaLed, type CsvCell } from '@/lib/csv';
import type { Report } from '@/lib/types';

import { buildReportDoc, sourceTurnsFromConversation } from '../model';
import { QUOTED_STYLE_BASE, reportToXlsx, sheetString, sheetText } from '../export/xlsx';
import { documentNodes, type TableNode } from '../export/walker';
import { NOW, sampleConversation, sampleReport } from './fixtures';
import { parseXml, zipMap } from './zip-reader';

interface FixtureCase {
  note: string;
  value: CsvCell;
  defused?: string;
}

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'lib', 'csv-formula.contract.json'), 'utf8'),
) as { version: number; leads: string[]; cases: FixtureCase[] };

const textCases = fixture.cases.filter((c): c is FixtureCase & { value: string; defused: string } => typeof c.value === 'string');

/** The fixture cases a plain ASCII sign and plain words open: quoted, but no apostrophe. */
const PLAIN_SIGN = new Set(['plus', 'minus as text']);

/** The leads the old, narrower test missed (the finding's own examples among them). */
const MISSED_BEFORE = [
  '\n=HYPERLINK("http://x.example","click")',
  '＝HYPERLINK("http://x.example","click")',
  '＋1',
  '－1',
  '＠SUM(A1)',
  ' \t=1+1',
  '  \tcmd',
  ' \ncmd',
  '  ＠x',
];

describe('sheetString follows the shared formula fixture', () => {
  it('reads the version of the fixture the CSV writers implement', () => {
    expect(fixture.version).toBe(1);
    expect(textCases.length).toBeGreaterThan(20);
  });

  it.each(textCases.map((c) => [c.note, c] as const))('%s', (note, c) => {
    const led = c.defused !== c.value;
    expect(isFormulaLed(c.value)).toBe(led);
    const cell = sheetString(c.value);
    expect(cell.quoted).toBe(led);
    if (!led) expect(cell.text).toBe(c.value);
    else if (PLAIN_SIGN.has(note)) expect(cell.text).toBe(c.value);
    else expect(cell.text).toBe(c.defused);
  });

  it('quotes and apostrophes every lead of the fixture except a plain ASCII sign', () => {
    for (const lead of fixture.leads) {
      for (const value of [`${lead}x(1)`, `   ${lead}x(1)`]) {
        const cell = sheetString(value);
        expect(cell.quoted, JSON.stringify(value)).toBe(true);
        expect(cell.text, JSON.stringify(value)).toBe(`'${value}`);
      }
      if (lead !== '+' && lead !== '-') {
        expect(sheetString(`${lead}10 vs previous window`).text, JSON.stringify(lead)).toBe(`'${lead}10 vs previous window`);
      }
    }
  });

  it('defuses the leads the old, narrower test let through', () => {
    for (const value of MISSED_BEFORE) {
      expect(sheetString(value), JSON.stringify(value)).toEqual({ text: `'${value}`, quoted: true });
      expect(sheetText(value)).toBe(`'${value}`);
    }
  });

  it('keeps the plain-sign exception narrow: a line break or a full-width operator after the sign is defused', () => {
    for (const value of ['+10 vs previous window', '-3%', ' -2 cases', '+$1.20 today', '+1,960 vs prev 24h', '-0.5']) {
      expect(sheetString(value), JSON.stringify(value)).toEqual({ text: value, quoted: true });
    }
    for (const value of ['-3%\n=HYPERLINK("http://x.example")', '+1\ncmd', '+1 ＝ 2', '-x ＠y', '+\tcmd']) {
      expect(sheetString(value), JSON.stringify(value)).toEqual({ text: `'${value}`, quoted: true });
    }
  });

  it('keeps the apostrophe on a sign before a name, a cell reference or a range (live as =+A1 in a re-saved CSV)', () => {
    const references = [
      '+A1',
      '-B2',
      '+$A$1',
      '-$B2',
      '+ A1',
      '  +A1',
      '+A1:B9',
      '-A1 B1',
      '+A:A',
      '+1:1',
      '-$1:$3',
      '+TRUE',
      '-total',
      '+_hidden',
      '+é',
      '+Σ1',
      '+1:30',
    ];
    for (const value of references) {
      expect(sheetString(value), JSON.stringify(value)).toEqual({ text: `'${value}`, quoted: true });
      expect(sheetText(value)).toBe(`'${value}`);
    }
  });
});

/** A report whose one table carries every text case of the fixture, one per row. */
function fixtureReport(): Report {
  const base = sampleReport();
  const table = {
    id: 'formula-contract',
    type: 'table',
    title: 'Formula contract',
    provenance: 'source',
    artifact_kind: 'table',
    allowed_views: ['table'],
    columns: [
      { key: 'note', label: 'Case', type: 'text' },
      { key: 'v', label: 'Value', type: 'text', untrusted: true },
    ],
    rows: textCases.map((c) => [c.note, c.value]),
  };
  return {
    ...base,
    items: [
      {
        id: 'it-formula',
        kind: 'block',
        block: table,
        note: null,
        source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'formula-contract' },
        scope: { window: 'last 24h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
        added_at: '2026-10-08T13:00:00Z',
      },
    ],
  } as Report;
}

/**
 * The fixture cases that still open with a formula lead after the report model's text
 * normalisation (it trims and folds whitespace, so a leading tab, CR, LF or run of spaces
 * never reaches a cell); the full-width leads are among them, the gap the old test left.
 */
const LED_IN_A_REPORT = [
  'equals',
  "a live link stays the rule's name",
  'at sign',
  'full-width equals',
  'full-width plus',
  'full-width minus',
  'full-width at sign',
  'spaces then equals',
  'spaces then full-width at sign',
  'a lone lead',
];

describe('the workbook writes every fixture case defused', () => {
  it('gives every formula-led cell the quote-prefix style and the apostrophe', () => {
    const doc = buildReportDoc(fixtureReport(), {
      author: 'ana',
      appVersion: '0.1.13',
      generatedAt: NOW.toISOString(),
      sourceTurns: sourceTurnsFromConversation(sampleConversation()),
    });
    // The cell text as the walker hands it to the writer (exact, never defanged).
    const table = documentNodes(doc, { defang: false }).find(
      (n): n is TableNode => n.k === 'table' && n.label === 'Formula contract',
    );
    expect(table).toBeDefined();
    const walked = new Map(table!.rows.map((row) => [row[0], row[1]] as const));

    const parts = zipMap(reportToXlsx(doc, { now: NOW }));
    const sheets = Array.from(parts.entries())
      .filter(([name]) => name.startsWith('xl/worksheets/'))
      .map(([name, entry]) => parseXml(entry.text, name));
    const sheet = sheets.find(
      (x) => (x.documentElement.textContent ?? '').includes('Formula contract') && x.getElementsByTagName('autoFilter').length > 0,
    );
    expect(sheet).toBeDefined();
    // Each fixture row, by its note; an empty value writes no second cell.
    const written = new Map<string, Element | null>();
    for (const row of Array.from(sheet!.getElementsByTagName('row'))) {
      const cells = Array.from(row.getElementsByTagName('c'));
      const note = cells[0]?.textContent ?? '';
      if (walked.has(note)) written.set(note, cells[1] ?? null);
    }
    expect(textCases.filter((c) => !written.has(c.note)).map((c) => c.note)).toEqual([]);

    for (const c of textCases) {
      const cell = written.get(c.note);
      const text = walked.get(c.note) ?? '';
      if (!cell) {
        expect(text.trim(), c.note).toBe('');
        continue;
      }
      expect(cell.getAttribute('t'), c.note).toBe('inlineStr');
      expect(cell.textContent, c.note).toBe(sheetString(text).text);
      const style = Number(cell.getAttribute('s') ?? 0);
      if (isFormulaLed(text)) {
        expect(style, c.note).toBeGreaterThanOrEqual(QUOTED_STYLE_BASE);
        if (!PLAIN_SIGN.has(c.note)) expect(cell.textContent?.startsWith("'"), c.note).toBe(true);
      } else {
        expect(style, c.note).toBeLessThan(QUOTED_STYLE_BASE);
      }
    }
    for (const note of LED_IN_A_REPORT) {
      expect(isFormulaLed(walked.get(note) ?? ''), note).toBe(true);
      expect(written.get(note)?.textContent?.startsWith("'"), note).toBe(true);
    }
    // Nothing is ever written as a formula.
    for (const x of sheets) expect(x.getElementsByTagName('f')).toHaveLength(0);
  });
});
