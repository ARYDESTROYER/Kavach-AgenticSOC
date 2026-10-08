/**
 * The one value formatter (units are enums, null is "not measured") and the copy /
 * download encoders: string cells formula-defused, numeric cells left numeric, IOCs
 * defanged for the clipboard by default and never for JSON (BLOCKS.md amendment 9).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  blockTabular,
  csvField,
  defang,
  defuseFormula,
  downloadText,
  toCSV,
  toJSON,
  toTSV,
  tsvField,
} from '../export-helpers';
import {
  bucketRangeLabel,
  clipText,
  fileStamp,
  formatDelta,
  formatDurationMs,
  formatTick,
  formatUtc,
  formatValue,
  shortTimeLabel,
  slug,
  truncationNote,
  unitWord,
} from '../format';
import { galleryBlock } from '../__fixtures__/gallery';

describe('formatValue', () => {
  it('prints null and non-finite as an em dash, never 0', () => {
    expect(formatValue(null, 'count')).toBe('—');
    expect(formatValue(Number.NaN, 'percent')).toBe('—');
    expect(formatValue(undefined, 'usd')).toBe('—');
  });

  it('keeps percent (0..100) and ratio (0..1) apart — a real 1% is 1%', () => {
    expect(formatValue(1, 'percent')).toBe('1%');
    expect(formatValue(0.4, 'percent')).toBe('<1%');
    expect(formatValue(18.44, 'percent')).toBe('18%');
    expect(formatValue(0.184, 'ratio')).toBe('18%');
    expect(formatValue(0.05, 'ratio')).toBe('5%');
  });

  it('formats scores, durations, money, tokens and bytes', () => {
    expect(formatValue(62, 'score')).toBe('62/100');
    expect(formatValue(5_400_000, 'ms')).toBe('1.5 h');
    expect(formatValue(30, 'minutes')).toBe('30 min');
    expect(formatValue(45, 'seconds')).toBe('45 s');
    expect(formatValue(1.5, 'usd')).toMatch(/^\$1\.50$/);
    expect(formatValue(2085, 'tokens')).toBe('2.1K');
    expect(formatValue(2048, 'bytes')).toBe('2 KB');
    expect(formatValue(12840, 'count')).toBe('12,840');
    expect(formatDurationMs(250)).toBe('250 ms');
    expect(formatDurationMs(3 * 86_400_000)).toBe('3 d');
  });

  it('compacts axis ticks', () => {
    expect(formatTick(1500, 'count')).toBe('1.5k');
    expect(formatTick(20000, 'count')).toBe('20k');
    expect(formatTick(2_500_000, 'count')).toBe('2.5M');
    expect(formatTick(50, 'percent')).toBe('50%');
  });

  it('spells units out for screen readers', () => {
    expect(unitWord('percent')).toBe('percent');
    expect(unitWord('count')).toBe('');
  });
});

describe('UTC time labels', () => {
  it('formats instants in UTC, deterministically', () => {
    expect(formatUtc('2026-10-08T14:05:09+02:00')).toBe('2026-10-08 12:05 UTC');
    expect(formatUtc('2026-10-08')).toBe('2026-10-08');
    expect(formatUtc('not a time')).toBe('not a time');
    expect(formatUtc(undefined)).toBe('—');
  });

  it('labels buckets as a UTC range', () => {
    expect(bucketRangeLabel('2026-10-05T14:00:00Z', '1h')).toBe('Oct 5, 14:00–15:00 UTC');
    expect(bucketRangeLabel('2026-10-05T18:00:00Z', '6h')).toBe('Oct 5, 18:00–24:00 UTC');
    expect(bucketRangeLabel('2026-10-05', '1d')).toBe('Oct 5');
    expect(shortTimeLabel('2026-10-05T14:00:00Z', '1h')).toBe('14:00');
    expect(shortTimeLabel('2026-10-05T00:00:00Z', '1d')).toBe('Oct 5');
  });

  it('clips by code point, never splitting a surrogate pair', () => {
    expect(clipText('abcdef', 4)).toBe('abc…');
    expect(clipText('ab', 4)).toBe('ab');
    const clipped = clipText('😀😀😀😀😀', 3);
    expect(clipped).toBe('😀😀…');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped)).toBe(false);
  });

  it('builds filenames and disclosures', () => {
    expect(slug('Top hosts: failed logons!')).toBe('top-hosts-failed-logons');
    expect(slug('###')).toBe('block');
    expect(fileStamp(new Date(Date.UTC(2026, 9, 8, 9, 5)))).toBe('20261008-0905');
    expect(truncationNote(10, 1240)).toBe('Showing top 10 of 1,240');
    expect(truncationNote(10, null)).toBe('Showing the first 10; more exist');
  });
});

describe('field encoders', () => {
  it('defuses spreadsheet formula leads in strings only', () => {
    expect(defuseFormula('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(defuseFormula(`${lead}x`)).toBe(`'${lead}x`);
    expect(defuseFormula('safe')).toBe('safe');
    expect(csvField('=1+1')).toBe(`"'=1+1"`);
    expect(csvField('a "quoted", value')).toBe('"a ""quoted"", value"');
  });

  it('keeps numbers numeric (a negative count is not a formula)', () => {
    expect(csvField(-5)).toBe('-5');
    expect(tsvField(-5)).toBe('-5');
    expect(csvField(null)).toBe('');
    expect(tsvField(null)).toBe('');
    expect(tsvField(true)).toBe('true');
  });

  it('defuses a formula behind leading spaces, and a leading quote in TSV', () => {
    expect(defuseFormula('  =1+1')).toBe(`'  =1+1`);
    expect(csvField(' @SUM(A1)')).toBe(`"' @SUM(A1)"`);
    // A paste target strips a leading text qualifier and would then evaluate the formula.
    expect(tsvField('"=HYPERLINK(""http://x"")"')).toBe(`'"=HYPERLINK(""http://x"")"`);
    expect(tsvField('"quoted" note')).toBe(`'"quoted" note`);
    // CSV quotes every string, so its own escaping already neutralises the quote.
    expect(csvField('"=1+1"')).toBe('"""=1+1"""');
    expect(tsvField('plain "quote" inside')).toBe('plain "quote" inside');
  });

  it('folds tabs and newlines in TSV cells', () => {
    expect(tsvField('a\tb\nc')).toBe('a b c');
    // The leading TAB is defused BEFORE folding, so it can never become a bare formula.
    expect(tsvField('\t=cmd')).toBe(`' =cmd`);
    expect(tsvField('=cmd\tx')).toBe(`'=cmd x`);
  });
});

describe('formatDelta', () => {
  it('reads a change in a rate in percentage points and a score in plain points', () => {
    expect(formatDelta(3.2, 'percent')).toBe('3.2 pp');
    expect(formatDelta(0.05, 'ratio')).toBe('5 pp');
    expect(formatDelta(5, 'score')).toBe('5');
    expect(formatDelta(1960, 'count')).toBe('1,960');
    expect(formatDelta(null, 'count')).toBe('—');
  });
});

describe('defang', () => {
  it('defangs URLs, IPs, domains and e-mail addresses, idempotently', () => {
    const out = defang('see http://evil.example.com/x from 203.0.113.14 by bob@corp.example');
    expect(out).toContain('hxxp://evil[.]example[.]com/x');
    expect(out).toContain('203[.]0[.]113[.]14');
    expect(out).toContain('bob[@]corp[.]example');
    expect(defang(out)).toBe(out);
    expect(defang('https://a.io')).toBe('hxxps://a[.]io');
  });

  it('leaves version numbers and plain words alone', () => {
    expect(defang('version 1.2.3 is fine')).toBe('version 1.2.3 is fine');
  });

  it('leaves process and file names and prose readable', () => {
    expect(defang('svchost.exe')).toBe('svchost.exe');
    expect(defang('C:\\Windows\\System32\\cmd.exe')).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(defang('report.docx and notes.txt')).toBe('report.docx and notes.txt');
    expect(defang('Mr.Smith said end.Next')).toBe('Mr.Smith said end.Next');
    // Real host names still defang, in either case, and extensions that ARE TLDs do too.
    expect(defang('EVIL.EXAMPLE.COM')).toBe('EVIL[.]EXAMPLE[.]COM');
    expect(defang('payload.zip')).toBe('payload[.]zip');
    expect(defang('get.example.sh')).toBe('get[.]example[.]sh');
  });
});

describe('block → tabular → TSV / CSV / JSON', () => {
  it('projects a chart as x × series with null kept empty', () => {
    const tab = blockTabular(galleryBlock('alerts-by-source'))!;
    expect(tab.columns.map((c) => c.label)).toEqual(['Time (UTC)', 'Wazuh', 'Elastic', 'Other']);
    expect(tab.rows[6][1]).toBeNull();
    const tsv = toTSV(tab, { defang: false });
    expect(tsv.split('\n')[7].split('\t')[1]).toBe('');
  });

  it('defangs and defuses string cells but leaves numeric columns raw', () => {
    const tab = blockTabular(galleryBlock('signins'))!;
    const tsv = toTSV(tab);
    expect(tsv).toContain(`'=HYPERLINK("hxxp://evil[.]example","click")`);
    expect(tsv).toContain('203[.]0[.]113[.]1');
    // Attempts (number) column stays a bare number.
    const firstRow = tsv.split('\n')[1].split('\t');
    expect(firstRow[5]).toMatch(/^\d+$/);
    // CSV is not defanged unless asked.
    const csv = toCSV(tab);
    expect(csv).toContain('203.0.113.1');
    expect(csv.split('\r\n')[0]).toBe('"Time","User","Source IP","Rule","Severity","Attempts","Case","Technique","Notes"');
  });

  it('covers every tabular block type and returns null for prose', () => {
    for (const id of ['kpis', 'logon-heatmap', 'open-cases', 'incident-timeline', 'attack-coverage', 'ioc', 'sources']) {
      expect(blockTabular(galleryBlock(id))).not.toBeNull();
    }
    for (const id of ['note', 'lookup-query', 'howto', 'shift-brief', 'scan-bound']) {
      expect(blockTabular(galleryBlock(id))).toBeNull();
    }
  });

  it('serialises JSON exactly as received, never defanged', () => {
    const json = toJSON(galleryBlock('ioc'));
    expect(JSON.parse(json)).toMatchObject({ blocks_version: 1, block: { entity: { value: '203.0.113.14' } } });
  });
});

describe('downloadText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a no-op without an object-URL store (jsdom)', () => {
    const original = URL.createObjectURL;
    // @ts-expect-error — simulate an environment with no object-URL store
    URL.createObjectURL = undefined;
    try {
      expect(downloadText('a.csv', 'text/csv', 'x')).toBe(false);
    } finally {
      URL.createObjectURL = original;
    }
  });

  it('clicks a temporary link and revokes the URL', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    expect(downloadText('a.csv', 'text/csv', 'x')).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});
