/**
 * Round 14 value formatting (SPEC §4.9.5, defect F8): durations, overages and case labels.
 *
 * The raw values the page audit found ("165h", "+18613m", "+8124%" over target, internal
 * case ids) each have one shared formatter. They are reached through `@/lib/format`, but
 * live in `format-values.ts` so the entry chunk never carries them (SPEC §3.4): the
 * module-boundary test below pins that `format.ts` only re-exports them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { caseLabel, DASH, fmtDuration, fmtOverage } from '../format';

describe('fmtDuration', () => {
  it('shows the largest two units, never a bare count of hours or minutes', () => {
    expect(fmtDuration(45)).toBe('45m');
    expect(fmtDuration(60)).toBe('1h');
    expect(fmtDuration(135)).toBe('2h 15m');
    expect(fmtDuration(165 * 60)).toBe('6d 21h');
    expect(fmtDuration(24 * 60)).toBe('1d');
    expect(fmtDuration(18613)).toBe('12d 22h');
  });

  it('rounds to whole minutes and says under a minute plainly', () => {
    expect(fmtDuration(0)).toBe('<1m');
    expect(fmtDuration(0.4)).toBe('<1m');
    expect(fmtDuration(59.6)).toBe('1h');
  });

  it('degrades to the shared placeholder for unusable input', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(fmtDuration(value as number | null | undefined)).toBe(DASH);
    }
  });
});

describe('fmtOverage', () => {
  it('turns minutes past a target into plain words (F8)', () => {
    expect(fmtOverage(18613)).toBe('12d 22h over');
    expect(fmtOverage(8124)).toBe('5d 15h over');
    expect(fmtOverage(30)).toBe('30m over');
  });

  it('never calls zero or a negative value an overage', () => {
    expect(fmtOverage(0)).toBe('Within target');
    expect(fmtOverage(-120)).toBe('Within target');
  });

  it('degrades to the shared placeholder for unusable input', () => {
    expect(fmtOverage(null)).toBe(DASH);
    expect(fmtOverage(Number.NaN)).toBe(DASH);
  });
});

describe('caseLabel', () => {
  it('always prefers the case number', () => {
    expect(caseLabel({ case_id: 'case-dfec7e70b4', case_number: 'CASE-000045' })).toBe('CASE-000045');
    expect(caseLabel({ case_id: 'case-1', case_number: '  CASE-000046 ', display_id: 'X-1' })).toBe(
      'CASE-000046',
    );
  });

  it('falls back to the display id, then the internal id, never to an empty string', () => {
    expect(caseLabel({ case_id: 'case-1', case_number: '', display_id: 'INC-7' })).toBe('INC-7');
    expect(caseLabel({ case_id: 'case-1', case_number: '   ' })).toBe('case-1');
    expect(caseLabel({})).toBe(DASH);
    expect(caseLabel(null)).toBe(DASH);
  });
});

describe('copy', () => {
  it('no formatted value carries an em dash or en dash as punctuation', () => {
    const values = [fmtDuration(9900), fmtOverage(8124), fmtOverage(0), caseLabel({ case_number: 'CASE-1' })];
    for (const value of values) {
      expect(value).not.toMatch(/[–—]/);
    }
  });
});

describe('module boundary (entry bundle, SPEC §3.4)', () => {
  const lib = path.resolve(__dirname, '..');
  const format = readFileSync(path.join(lib, 'format.ts'), 'utf8');

  it('format.ts re-exports the helpers and defines none of them', () => {
    expect(format).toMatch(/export \{[^}]*\bfmtDuration\b[^}]*\} from '\.\/format-values'/);
    expect(format).not.toMatch(/function (fmtDuration|fmtOverage|caseLabel)\b/);
  });

  it('format-values.ts imports nothing, so it can never pull a module into the entry', () => {
    const values = readFileSync(path.join(lib, 'format-values.ts'), 'utf8');
    expect(values).not.toMatch(/^import\b/m);
  });
});
