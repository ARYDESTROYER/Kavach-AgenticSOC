/**
 * The one spreadsheet formula defusal rule set (Round 14 SPEC §4.5.6). The shared
 * fixture `csv-formula.contract.json` is read here and by the backend audit export
 * writer's test, so this module's CSV and clipboard encoders (the chat answer tables,
 * reports and the severity breakdown use them) and the audit export file defuse exactly
 * alike. The report Excel writer and the KPI drill-down CSV still gate on narrower leads
 * of their own until they migrate to `isFormulaLed` and `csvField` (see `csv.ts`); this
 * fixture does not cover them yet.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { csvField, defuseFormula, isFormulaLed, tsvField, type CsvCell } from '../csv';

interface FixtureCase {
  note: string;
  value: CsvCell;
  defused?: string;
  csv: string;
}

interface Fixture {
  version: number;
  leads: string[];
  cases: FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'csv-formula.contract.json'), 'utf8'),
) as Fixture;

describe('csv formula contract (shared fixture)', () => {
  it('is the version this module implements', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.cases.length).toBeGreaterThan(20);
  });

  it.each(fixture.cases.map((c) => [c.note, c] as const))('%s', (_note, c) => {
    if (typeof c.value === 'string') {
      expect(defuseFormula(c.value)).toBe(c.defused);
    }
    expect(csvField(c.value)).toBe(c.csv);
  });

  it('defuses every lead in the fixture, alone, after spaces, and in the clipboard form', () => {
    for (const lead of fixture.leads) {
      expect(defuseFormula(`${lead}x`)).toBe(`'${lead}x`);
      expect(defuseFormula(`   ${lead}x`)).toBe(`'   ${lead}x`);
      expect(tsvField(`${lead}x`).startsWith("'")).toBe(true);
    }
  });

  it('exports the one lead test other spreadsheet writers gate on', () => {
    for (const lead of fixture.leads) {
      expect(isFormulaLed(`${lead}x`)).toBe(true);
      expect(isFormulaLed(`  ${lead}x`)).toBe(true);
    }
    for (const c of fixture.cases) {
      if (typeof c.value === 'string') expect(isFormulaLed(c.value)).toBe(c.defused !== c.value);
    }
  });

  it('leaves text whose first non-space character is not a lead unchanged', () => {
    for (const text of ['a=b', 'x+1', ' a', ' =1', "'=kept", 'École']) {
      expect(defuseFormula(text)).toBe(text);
    }
  });
});
