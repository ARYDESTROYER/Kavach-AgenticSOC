/**
 * The KPI drill-down "Download CSV" defuses on the ONE shared formula rule set (Round 14
 * SPEC §4.5.6, closing fix safety-02).
 *
 * `drilldownCsv` used to carry its own field encoder, which missed a lead after spaces, a
 * leading line feed and the full-width `＝ ＋ － ＠`. It now writes every field through
 * `lib/csv` `csvField`, so each text column follows the shared fixture
 * `csv-formula.contract.json` exactly, like the chat, report and audit exports; the risk
 * score stays a bare number.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CsvCell } from '@/lib/csv';
import type { Case } from '@/lib/types';

import { drilldownCsv } from '../KpiDrilldownPanel';

interface FixtureCase {
  note: string;
  value: CsvCell;
  csv: string;
}

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', '..', '..', 'lib', 'csv-formula.contract.json'), 'utf8'),
) as { version: number; cases: FixtureCase[] };

const textCases = fixture.cases.filter((c): c is FixtureCase & { value: string } => typeof c.value === 'string');

const HEADER = '"case_id","case_number","created_at","title","detection_source","severity_band","risk_score","status","assignee"';

/** Split one CSV record into fields, honouring RFC-4180 quotes (a field may hold CR/LF). */
function fields(record: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= record.length) {
    if (record[i] === '"') {
      let j = i + 1;
      while (j < record.length) {
        if (record[j] === '"' && record[j + 1] === '"') j += 2;
        else if (record[j] === '"') break;
        else j += 1;
      }
      out.push(record.slice(i, j + 1));
      i = j + 2;
    } else {
      const end = record.indexOf(',', i);
      const stop = end === -1 ? record.length : end;
      out.push(record.slice(i, stop));
      i = stop + 1;
    }
  }
  return out;
}

const row = (overrides: Partial<Case>): Case =>
  ({
    case_id: 'case-1',
    case_number: 'SOC-1',
    created_at: '2026-10-25T15:09:15Z',
    title: 'Brute force on vpn-gw-2',
    detection_source: 'Wazuh',
    severity_band: 'high',
    risk_score: 73,
    status: 'open',
    assignee: 'ana',
    ...overrides,
  }) as Case;

describe('drilldownCsv uses the shared spreadsheet encoder', () => {
  it('writes the header and keeps the risk score a number', () => {
    const [header, first, end] = drilldownCsv([row({})]).split('\r\n');
    expect(header).toBe(HEADER);
    expect(fields(first)).toEqual([
      '"case-1"',
      '"SOC-1"',
      '"2026-10-25T15:09:15Z"',
      '"Brute force on vpn-gw-2"',
      '"Wazuh"',
      '"high"',
      '73',
      '"open"',
      '"ana"',
    ]);
    expect(end).toBe('');
  });

  it.each(textCases.map((c) => [c.note, c] as const))('assignee %s', (_note, c) => {
    const csv = drilldownCsv([row({ assignee: c.value })]);
    const record = csv.slice(HEADER.length + 2, -2);
    expect(fields(record)[8]).toBe(c.csv);
  });

  it('defuses the leads its old encoder let through', () => {
    for (const [value, expected] of [
      ['  =HYPERLINK("http://x.example","click")', '"\'  =HYPERLINK(""http://x.example"",""click"")"'],
      ['\n=1+1', '"\'\n=1+1"'],
      ['＝1+1', '"\'＝1+1"'],
      ['＋1', '"\'＋1"'],
      ['－1', '"\'－1"'],
      ['＠SUM(A1)', '"\'＠SUM(A1)"'],
      [' \tcmd', '"\' \tcmd"'],
    ] as const) {
      const record = drilldownCsv([row({ detection_source: value })]).slice(HEADER.length + 2, -2);
      expect(fields(record)[4], JSON.stringify(value)).toBe(expected);
    }
  });

  it('defuses a source-controlled rule id that names the case', () => {
    const record = drilldownCsv([row({ title: '', cluster_signature: '', rule_ids: ['＝HYPERLINK("http://x.example")'] })]).slice(
      HEADER.length + 2,
      -2,
    );
    expect(fields(record)[3]).toBe('"\'＝HYPERLINK(""http://x.example"")"');
  });

  it('leaves an absent risk score empty instead of writing a number', () => {
    const record = drilldownCsv([row({ risk_score: undefined })]).slice(HEADER.length + 2, -2);
    expect(fields(record)[6]).toBe('""');
  });
});
