/**
 * The console's shared export primitives (chat revamp SPEC §9.3, BLOCKS.md amendment 9):
 * `lib/csv` (formula-injection defusal on STRING cells only), `lib/defang` (IOC
 * defanging) and `lib/download` (feature-detected downloads, one filename rule).
 * The answer-blocks kit re-exports these; its own tests pin the same behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { csvDocument, csvField, csvRow, defuseFormula, tsvField } from '../csv';
import { defang, maybeDefang } from '../defang';
import { EXPORT_MIME, downloadText, exportFileName, fileSlug, utcFileStamp } from '../download';
import * as kit from '@/soc/chat/blocks/export-helpers';

describe('lib/csv', () => {
  it('defuses every formula leader in string cells, including =HYPERLINK', () => {
    expect(csvField('=HYPERLINK("http://evil.example","click")')).toBe(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(defuseFormula(`${lead}cmd`)).toBe(`'${lead}cmd`);
    }
    // A formula hidden behind spaces is still a formula.
    expect(defuseFormula('   =1+1')).toBe(`'   =1+1`);
    expect(defuseFormula('plain text')).toBe('plain text');
  });

  it('keeps numbers numeric — a negative count is not a formula', () => {
    expect(csvField(-42)).toBe('-42');
    expect(csvField(3.5)).toBe('3.5');
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('true');
    // The STRING "-42" is text from a source and is defused.
    expect(csvField('-42')).toBe(`"'-42"`);
  });

  it('folds TAB/CR leaders and line breaks in TSV after defusing them', () => {
    expect(tsvField('\t=cmd')).toBe(`' =cmd`);
    expect(tsvField('\r@SUM(A1)')).toBe(`' @SUM(A1)`);
    expect(tsvField('"=1+1"')).toBe(`'"=1+1"`);
    expect(tsvField('a\nb')).toBe('a b');
    expect(tsvField(-7)).toBe('-7');
  });

  it('builds RFC-4180 records and documents', () => {
    expect(csvRow(['a,b', 1, null, '=x'])).toBe(`"a,b",1,,"'=x"`);
    expect(csvDocument([['h1', 'h2'], ['v', 2]])).toBe('"h1","h2"\r\n"v",2');
  });

  it('is the implementation the answer-blocks kit re-exports', () => {
    expect(kit.csvField).toBe(csvField);
    expect(kit.tsvField).toBe(tsvField);
    expect(kit.defuseFormula).toBe(defuseFormula);
    expect(kit.defang).toBe(defang);
    expect(kit.downloadText).toBe(downloadText);
  });
});

describe('lib/csv TSV folding', () => {
  it('defuses a formula that only appears after whitespace folding', () => {
    // A space, then a TAB: not a lead on the raw text, but it folds to "  =1".
    expect(tsvField(' \t=1')).toBe("'  =1");
    expect(tsvField('\t=1')).toBe("' =1");
    expect(tsvField('a\tb')).toBe('a b');
  });
});

describe('lib/defang', () => {
  it('treats a mixed-case TLD as a host when the context says so (case is attacker-chosen)', () => {
    expect(defang('Visit www.evil.Com/x now')).toBe('Visit www[.]evil[.]Com/x now');
    expect(defang('a.b.Evil.Com')).toBe('a[.]b[.]Evil[.]Com');
    expect(defang('see http://Evil.Com')).toBe('see hxxp://Evil[.]Com');
    expect(defang('evil.Com/login')).toBe('evil[.]Com/login');
    expect(defang('evil.Com:8443')).toBe('evil[.]Com:8443');
    expect(defang('mail eve@Corp.Example')).toBe('mail eve[@]Corp[.]Example');
    // A bare two-label mixed-case token stays prose (the pinned `end.Next` rule).
    expect(defang('evil.Com')).toBe('evil.Com');
    expect(defang('Mr.Smith said end.Next')).toBe('Mr.Smith said end.Next');
    const once = defang('www.evil.Com/x');
    expect(defang(once)).toBe(once);
  });

  it('defangs URLs, IPs, domains and e-mail addresses idempotently', () => {
    const out = defang('GET https://evil.example.com/x from 198.51.100.7 by eve@corp.example');
    expect(out).toBe('GET hxxps://evil[.]example[.]com/x from 198[.]51[.]100[.]7 by eve[@]corp[.]example');
    expect(defang(out)).toBe(out);
    expect(defang('ftp://files.example.org')).toBe('fxp://files[.]example[.]org');
  });

  it('leaves versions, file names and prose readable', () => {
    expect(defang('v0.1.13 wrote svchost.exe and report.docx; Mr.Smith agreed')).toBe(
      'v0.1.13 wrote svchost.exe and report.docx; Mr.Smith agreed',
    );
  });

  it('applies only when asked (the export-menu toggle)', () => {
    expect(maybeDefang('1.2.3.4', false)).toBe('1.2.3.4');
    expect(maybeDefang('1.2.3.4', true)).toBe('1[.]2[.]3[.]4');
  });
});

describe('lib/download', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names exports with one rule', () => {
    const at = new Date(Date.UTC(2026, 9, 8, 14, 5));
    expect(utcFileStamp(at)).toBe('20261008-1405');
    expect(exportFileName('report', 'Shift handoff: night!', 'md', at)).toBe('agentic-soc-report-shift-handoff-night-20261008-1405Z.md');
    expect(exportFileName('report', '###', 'html', at)).toBe('agentic-soc-report-export-20261008-1405Z.html');
    expect(fileSlug('A'.repeat(80))).toHaveLength(60);
    expect(EXPORT_MIME.html).toMatch(/^text\/html/);
  });

  it('is a no-op without an object-URL store', () => {
    const original = URL.createObjectURL;
    // @ts-expect-error — simulate jsdom without an object-URL store
    URL.createObjectURL = undefined;
    try {
      expect(downloadText('a.md', EXPORT_MIME.markdown, 'x')).toBe(false);
    } finally {
      URL.createObjectURL = original;
    }
  });

  it('clicks a temporary link and revokes the object URL at once', () => {
    const create = vi.fn(() => 'blob:report');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    expect(downloadText('a.md', EXPORT_MIME.markdown, '# x')).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:report');
  });
});
