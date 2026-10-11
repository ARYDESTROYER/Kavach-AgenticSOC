/**
 * Client-side Word and Excel exports and the store-only ZIP writer (Round 12 SPEC
 * WP-REP; SYNTHESIS-chat P1-7). The packages are read back with a strict ZIP reader and
 * every XML part is parsed, so "the file opens" is checked structurally:
 *
 *   - ZIP: CRC-32, contiguous local headers, central directory and end record agree,
 *     UTF-8 names, method 0, deterministic for the same instant;
 *   - OOXML: `[Content_Types].xml` declares every part, every relationship target
 *     exists, every part is well-formed XML;
 *   - #9: every text is escaped (model `<script>` stays text), XML-invalid control
 *     characters are dropped (one would make Word/Excel reject the file), the only
 *     external link is a constructed ATT&CK page;
 *   - Excel: formula-led strings take the quote-prefix style; any that could act as a
 *     formula elsewhere also keep a literal `'` (a plain "+10 vs previous window" shows
 *     none); a literal `_xHHHH_` reads back literally (never a decoded `=` or NUL);
 *     numbers stay numeric, sheet names are sanitised and unique; the "Report" sheet is
 *     defanged by default (a human document, like Word) while the table sheets stay
 *     exact (data, like CSV);
 *   - Word: every section title and every KPI value is present, defanged by default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Report } from '@/lib/types';

import { buildReportDoc, sourceTurnsFromConversation } from '../model';
import { crc32, dosDateTime, zipStore } from '../export/zip';
import { xmlAttr, xmlSafe, xmlText } from '../export/ooxml';
import {
  MAX_SHEET_NAME,
  QUOTED_STYLE_BASE,
  STYLES_XML,
  columnName,
  quoteSheet,
  reportToXlsx,
  sheetName,
  sheetString,
  sheetText,
  workbookModel,
  xstring,
} from '../export/xlsx';
import { TEXT_WIDTH, columnChunks, columnWidths, docxParts, reportToDocx } from '../export/docx';
import { documentNodes } from '../export/walker';
import { exportReport } from '../export/run';
import { NOW, calendarReport, rawBlock, sampleConversation, sampleReport } from './fixtures';
import { parseXml, readZip, zipMap } from './zip-reader';

const doc = (report: Report = sampleReport()) =>
  buildReportDoc(report, {
    author: 'ana',
    appVersion: '0.1.13',
    generatedAt: NOW.toISOString(),
    sourceTurns: sourceTurnsFromConversation(sampleConversation()),
  });

/** A table block carrying every hostile cell shape. */
function hostileReport(): Report {
  const base = sampleReport();
  const table = {
    id: 'hostile',
    type: 'table',
    title: "[Q3]: who/what*? 'x' \\ y — a very long title that exceeds the sheet limit",
    provenance: 'source',
    artifact_kind: 'table',
    allowed_views: ['table'],
    columns: [
      { key: 'v', label: 'Value', type: 'text', untrusted: true },
      { key: 'n', label: 'Count', type: 'number', unit: 'count' },
      { key: 'p', label: 'Share', type: 'number', unit: 'percent' },
    ],
    rows: [
      ['=HYPERLINK("http://evil.example","click")', 3, 12.5],
      ['+SUM(1,2)', -4, null],
      ['@cmd', 0, 50],
      ['\tTAB lead', 1, 1],
      ['-2+3', 2, 2],
      ['<script>alert(1)</script> & "q"', 5, 5],
      ['bell\u0001 nul\u0000 vt\u000b ok', 6, 6],
      ['203.0.113.10 via http://evil.example/x', 7, 7],
    ],
  };
  return {
    ...base,
    title: 'Hostile <b>report</b> & co',
    items: [
      ...base.items,
      {
        id: 'it-h',
        kind: 'block',
        block: table,
        note: '=cmd|"/c calc"!A1',
        source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'hostile' },
        scope: { window: 'last 24h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
        added_at: '2026-10-08T13:00:00Z',
      },
      {
        id: 'it-h2',
        kind: 'block',
        block: { ...table, id: 'hostile-2' },
        note: null,
        source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'hostile-2' },
        scope: { window: 'last 24h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
        added_at: '2026-10-08T13:00:00Z',
      },
    ],
  };
}

const textOf = (xml: Document): string => xml.documentElement.textContent ?? '';

/** Every part must be declared and well-formed; every relationship target must exist. */
function checkPackage(zip: Uint8Array, main: string): Map<string, ReturnType<typeof readZip>[number]> {
  const parts = zipMap(zip);
  expect(readZip(zip)[0].name).toBe('[Content_Types].xml');
  for (const [name, entry] of parts) parseXml(entry.text, name);
  const types = parseXml(parts.get('[Content_Types].xml')!.text);
  const overrides = Array.from(types.getElementsByTagName('Override')).map((o) => o.getAttribute('PartName'));
  for (const name of parts.keys()) {
    if (name.endsWith('.rels') || name === '[Content_Types].xml') continue;
    expect(overrides, name).toContain(`/${name}`);
  }
  for (const o of overrides) expect(parts.has(o!.slice(1)), o!).toBe(true);
  const root = parseXml(parts.get('_rels/.rels')!.text);
  const targets = Array.from(root.getElementsByTagName('Relationship')).map((r) => r.getAttribute('Target'));
  expect(targets).toContain(main);
  for (const t of targets) expect(parts.has(t!), t!).toBe(true);
  // Part-level relationships resolve relative to the part's folder.
  for (const [name, entry] of parts) {
    if (!name.endsWith('.rels') || name === '_rels/.rels') continue;
    const folder = name.replace(/_rels\/[^/]+\.rels$/, '');
    const rels = parseXml(entry.text, name);
    for (const r of Array.from(rels.getElementsByTagName('Relationship'))) {
      if (r.getAttribute('TargetMode') === 'External') continue;
      expect(parts.has(`${folder}${r.getAttribute('Target')}`), `${name} → ${r.getAttribute('Target')}`).toBe(true);
    }
  }
  return parts;
}

afterEach(() => vi.restoreAllMocks());

describe('store-only ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes a valid archive a strict reader accepts, with UTF-8 names', () => {
    const zip = zipStore(
      [
        { name: 'a.txt', data: 'hello' },
        { name: 'dir/ünï.xml', data: '<x>—</x>' },
        { name: 'bin', data: new Uint8Array([0, 255, 1]) },
      ],
      NOW,
    );
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/ünï.xml', 'bin']);
    expect(entries[1].text).toBe('<x>—</x>');
    expect(Array.from(entries[2].bytes)).toEqual([0, 255, 1]);
    // PK\x03\x04 at the start, PK\x05\x06 22 bytes from the end.
    expect(Array.from(zip.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Array.from(zip.subarray(zip.length - 22, zip.length - 18))).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('is deterministic for the same instant and stamps a DOS time', () => {
    const a = zipStore([{ name: 'x', data: 'y' }], NOW);
    const b = zipStore([{ name: 'x', data: 'y' }], NOW);
    expect(a).toEqual(b);
    const { date, time } = dosDateTime(NOW);
    expect(date >> 9).toBe(2026 - 1980);
    expect((time >> 11) & 0x1f).toBe(14);
  });

  it('refuses unsafe or duplicate entry names', () => {
    expect(() => zipStore([{ name: '../x', data: '' }])).toThrow();
    expect(() => zipStore([{ name: '/abs', data: '' }])).toThrow();
    expect(() => zipStore([{ name: 'a/../../b', data: '' }])).toThrow();
    expect(() => zipStore([{ name: 'a', data: '' }, { name: 'a', data: '' }])).toThrow();
  });
});

describe('XML escaping (#9)', () => {
  it('escapes markup and drops characters XML 1.0 cannot carry', () => {
    expect(xmlText('<a href="x">&\'')).toBe('&lt;a href="x"&gt;&amp;\'');
    expect(xmlAttr('a"b\'c\nd')).toBe('a&quot;b&apos;c&#10;d');
    expect(xmlSafe('a\u0000b\u0001c\u000bd\u001fe￾f\ud800g\tok\n')).toBe('abcdefg\tok\n');
    // A valid astral character survives.
    expect(xmlSafe('😀')).toBe('😀');
  });
});

describe('Excel export', () => {
  it('is a complete, well-formed workbook package', () => {
    const zip = reportToXlsx(doc(hostileReport()), { now: NOW });
    const parts = checkPackage(zip, 'xl/workbook.xml');
    const book = parseXml(parts.get('xl/workbook.xml')!.text);
    const sheets = Array.from(book.getElementsByTagName('sheet'));
    expect(sheets[0].getAttribute('name')).toBe('Report');
    expect(sheets.length).toBeGreaterThan(3);
    const rels = parseXml(parts.get('xl/_rels/workbook.xml.rels')!.text);
    const byId = new Map(Array.from(rels.getElementsByTagName('Relationship')).map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
    for (const s of sheets) {
      const target = byId.get(s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      expect(parts.has(`xl/${target}`), String(target)).toBe(true);
    }
    expect(Array.from(byId.values())).toContain('styles.xml');
    // Core properties carry the title as escaped text.
    expect(parts.get('docProps/core.xml')!.text).toContain('Hostile &lt;b&gt;report&lt;/b&gt; &amp; co');
  });

  it('sanitises sheet names: legal characters, 31 at most, unique, never "History"', () => {
    const model = workbookModel(doc(hostileReport()));
    const names = model.sheets.map((s) => s.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(MAX_SHEET_NAME);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
      expect(n).not.toMatch(/^'|'$/);
    }
    const taken = new Set<string>();
    expect(sheetName('History', taken, 'Table 1')).toBe('Table 1');
    expect(sheetName("'quoted'", taken, 'x')).toBe('quoted');
    expect(sheetName('a'.repeat(40), taken, 'x')).toHaveLength(31);
    expect(sheetName('a'.repeat(40), taken, 'x')).toBe(`${'a'.repeat(27)} (2)`);
    expect(sheetName('[a]:b*c?/d\\e', taken, 'x')).toBe('a b c d e');
    expect(quoteSheet("It's")).toBe("'It''s'");
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
  });

  it('defuses formula leads in every string cell and keeps numbers numeric', () => {
    // Every lead takes the quote-prefix style; any that could act as a formula outside
    // Excel's own cell keeps a literal apostrophe too.
    for (const lead of ['=', '@', '\t', '\r']) expect(sheetString(`${lead}x`)).toEqual({ text: `'${lead}x`, quoted: true });
    for (const v of ['+SUM(1,2)', '-2+3', '+cmd|"/c calc"!A1', '-HYPERLINK("http://e")', ' +x("y")'])
      expect(sheetString(v)).toEqual({ text: `'${v}`, quoted: true });
    // A plain sign and words cannot call, link or reference: no visible apostrophe.
    for (const v of ['+10 vs previous window', '-3%', '+1,960 vs prev 24h', '+$1.20 today', '-'])
      expect(sheetString(v)).toEqual({ text: v, quoted: true });
    expect(sheetString('plain')).toEqual({ text: 'plain', quoted: false });
    expect(sheetText('x'.repeat(40_000))).toHaveLength(32_767);

    const parts = zipMap(reportToXlsx(doc(hostileReport()), { now: NOW }));
    const all = Array.from(parts.entries())
      .filter(([n]) => n.startsWith('xl/worksheets/'))
      .map(([n, e]) => [n, parseXml(e.text, n)] as const);
    const cells = all.flatMap(([, x]) => Array.from(x.getElementsByTagName('c')));
    const strCells = cells.filter((c) => c.getAttribute('t') === 'inlineStr');
    const strings = strCells.map((c) => c.textContent ?? '');
    // Every formula-led string cell is quote-prefixed (stays text in Excel), and none
    // that could act as a formula elsewhere starts with its lead.
    for (const c of strCells) {
      const t = c.textContent ?? '';
      if (/^(?:[=+\-@\t\r]| +[=+\-@])/.test(t)) {
        expect(Number(c.getAttribute('s')), t).toBeGreaterThanOrEqual(QUOTED_STYLE_BASE);
        expect(t, t).toMatch(/^ *[+-][^=+\-@()|!"'&^*/<>;[\]{}\\~`\t\r]*$/);
      }
    }
    expect(strings).toContain('\'=HYPERLINK("http://evil.example","click")');
    expect(strings).toContain("'+SUM(1,2)");
    expect(strings).toContain("'@cmd");
    expect(strings).toContain("'-2+3");
    // No formula element anywhere: nothing is ever written as a formula.
    for (const [, x] of all) expect(x.getElementsByTagName('f')).toHaveLength(0);
    // Markup stays text; control characters are dropped.
    expect(strings).toContain('<script>alert(1)</script> & "q"');
    expect(strings).toContain('bell nul vt ok');
    // The table sheets are data: never defanged.
    expect(strings.some((s) => s.includes('203.0.113.10 via http://evil.example/x'))).toBe(true);
    // Numbers are numeric cells (a negative count is a number, not a defused string).
    const numbers = cells.filter((c) => !c.getAttribute('t')).map((c) => c.textContent);
    expect(numbers).toContain('-4');
    expect(numbers).toContain('12.5');
  });

  it('declares a quote-prefix twin of every text style', () => {
    const styles = parseXml(STYLES_XML);
    const xfs = Array.from(styles.getElementsByTagName('cellXfs')[0].getElementsByTagName('xf'));
    expect(xfs).toHaveLength(Number(styles.getElementsByTagName('cellXfs')[0].getAttribute('count')));
    for (let i = 0; i <= 6; i += 1) {
      const twin = xfs[QUOTED_STYLE_BASE + i];
      expect(twin.getAttribute('quotePrefix')).toBe('1');
      expect(twin.getAttribute('fontId')).toBe(xfs[i].getAttribute('fontId'));
    }
  });

  it('shows a KPI change without a stray apostrophe ("+10 vs previous window")', () => {
    const parts = zipMap(reportToXlsx(doc(), { now: NOW }));
    const cells = Array.from(parts.entries())
      .filter(([n]) => n.startsWith('xl/worksheets/'))
      .flatMap(([n, e]) => Array.from(parseXml(e.text, n).getElementsByTagName('c')));
    const change = cells.find((c) => (c.textContent ?? '').startsWith('+1,960'))!;
    expect(change).toBeDefined();
    expect(change.textContent).toBe('+1,960 vs prev 24h');
    expect(Number(change.getAttribute('s'))).toBeGreaterThanOrEqual(QUOTED_STYLE_BASE);
  });

  it('writes a literal _xHHHH_ escaped, so Excel never decodes it into "=" or a NUL (#9)', () => {
    expect(xstring('_x003D_HYPERLINK("http://evil.example/","click")')).toBe('_x005F_x003D_HYPERLINK("http://evil.example/","click")');
    expect(xstring('nul_x0000_here')).toBe('nul_x005F_x0000_here');
    expect(xstring('_x12_ and x0041_ stay')).toBe('_x12_ and x0041_ stay');
    const report = hostileReport();
    const table = report.items[report.items.length - 1].block as { rows: unknown[][] };
    table.rows = [['_x003D_HYPERLINK("http://evil.example/","click")', 1, 1], ['nul_x0000_here', 2, 2], ['_X003d_lower', 3, 3]];
    const parts = zipMap(reportToXlsx(doc(report), { now: NOW }));
    const strings = Array.from(parts.entries())
      .filter(([n]) => n.startsWith('xl/worksheets/'))
      .flatMap(([n, e]) => Array.from(parseXml(e.text, n).getElementsByTagName('c')))
      .filter((c) => c.getAttribute('t') === 'inlineStr')
      .map((c) => c.textContent ?? '');
    expect(strings).toContain('_x005F_x003D_HYPERLINK("http://evil.example/","click")');
    expect(strings).toContain('nul_x005F_x0000_here');
    expect(strings).toContain('_x005F_X003d_lower');
    // Decoded as Excel does (ST_Xstring), every cell reads back exactly as it was.
    const decode = (t: string) => t.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const decoded = strings.map(decode);
    expect(decoded).toContain('_x003D_HYPERLINK("http://evil.example/","click")');
    expect(decoded).toContain('nul_x0000_here');
    for (const d of decoded) {
      expect(d).not.toMatch(/^=/);
      expect(d).not.toContain('\u0000');
    }
    // A sheet name never carries the pattern.
    expect(sheetName('rule_x003D_name', new Set(), 'x')).not.toMatch(/_x[0-9A-Fa-f]{4}_/);
  });

  it('defangs the Report sheet by default and keeps every table sheet exact (P1-7)', () => {
    const texts = (sheet: { rows: Array<Array<{ kind: string; text?: string; value?: number } | null>> }) =>
      sheet.rows.flat().map((c) => (c ? (c.kind === 'text' ? (c.text ?? '') : String(c.value)) : ''));
    const base = hostileReport();
    const iocTable = { ...(base.items[base.items.length - 1].block as Record<string, unknown>), id: 'ioc-table', title: 'Hits for 198.51.100.7' };
    const report: Report = {
      ...base,
      items: [
        ...base.items,
        { ...base.items[base.items.length - 1], id: 'it-ioc', block: iocTable, note: 'Seen at evil.example' },
      ] as Report['items'],
    };
    const model = workbookModel(doc(report));
    const [overview, ...tables] = model.sheets;
    const human = texts(overview).join('\n');
    // The summary, next steps, prose and notes: no live indicator.
    expect(human).toContain('Brute force from 203[.]0[.]113[.]14 against vpn-gw-2');
    expect(human).toContain('Block 203[.]0[.]113[.]14 at the edge');
    expect(human).toContain('hxxp://evil[.]example/x');
    expect(human).toContain('Seen at evil[.]example');
    expect(human).not.toMatch(/203\.0\.113\.14|198\.51\.100\.7|https?:\/\/evil\.example|\bevil\.example/);
    // The overview names the table (and the sheet it links to) defanged …
    const line = texts(overview).find((t) => t.startsWith('Table ') && t.includes('Hits for'))!;
    expect(line).toMatch(/^Table \d+: Hits for 198\[\.\]51\[\.\]100\[\.\]7 \(sheet "\d+ Hits for 198\[\.\]51\[\.\]100\[\.\]7"\)$/);
    // … while the data sheets keep the exact values, titles and sheet names.
    const ioc = tables.find((t) => t.name.endsWith('Hits for 198.51.100.7'))!;
    expect(ioc).toBeDefined();
    expect(texts(ioc)[0]).toBe('Hits for 198.51.100.7');
    const data = tables.flatMap(texts);
    expect(data).toContain('203.0.113.10 via http://evil.example/x');
    expect(data.join('\n')).not.toMatch(/\[\.\]|\[@\]|hxxp/);
    // The toggle off: the Report sheet is exact too; the table sheets never change.
    const raw = workbookModel(doc(report), { defang: false });
    const rawHuman = texts(raw.sheets[0]).join('\n');
    expect(rawHuman).toContain('Block 203.0.113.14 at the edge');
    expect(rawHuman).toContain('http://evil.example/x');
    expect(rawHuman).not.toContain('[.]');
    expect(raw.sheets.slice(1)).toEqual(tables);
    // The package follows the model: defanged by default, exact when asked.
    const sheet1 = (bytes: Uint8Array) => textOf(parseXml(zipMap(bytes).get('xl/worksheets/sheet1.xml')!.text));
    expect(sheet1(reportToXlsx(doc(report), { now: NOW }))).toContain('203[.]0[.]113[.]14');
    expect(sheet1(reportToXlsx(doc(report), { now: NOW, defang: false }))).toContain('203.0.113.14');
  });

  it('lays out each table with a title, a caption, a frozen header and a filter', () => {
    const model = workbookModel(doc());
    const chart = model.sheets.find((s) => s.rows.some((r) => r[0]?.kind === 'text' && /^Chart: /.test(r[0].text)))!;
    expect(chart).toBeDefined();
    expect(chart.headerRow).toBe(3);
    expect(chart.filter).toMatch(/^A3:[A-Z]+\d+$/);
    const parts = zipMap(reportToXlsx(doc(), { now: NOW }));
    const book = parts.get('xl/workbook.xml')!.text;
    expect(book).toContain('_xlnm._FilterDatabase');
    // The overview lists every table with an in-workbook link to its sheet.
    expect(model.sheets[0].links.length).toBe(model.sheets.length - 1);
    for (const link of model.sheets[0].links) expect(link.location).toMatch(/^'.+'!A1$/);
  });
});

describe('Word export', () => {
  it('is a complete, well-formed document package on A4', () => {
    const zip = reportToDocx(doc(hostileReport()), { now: NOW });
    const parts = checkPackage(zip, 'word/document.xml');
    const body = parts.get('word/document.xml')!.text;
    expect(body).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(body).toContain('<w:tblHeader/>');
    expect(parts.get('word/footer1.xml')!.text).toContain('NUMPAGES');
    // A table is always followed by a paragraph (Word would merge adjacent tables).
    expect(body).not.toContain('</w:tbl><w:tbl>');
    // Styles declare the outline levels the navigation pane uses.
    expect(parts.get('word/styles.xml')!.text).toContain('<w:outlineLvl w:val="0"/>');
  });

  it('carries every section title and every KPI value', () => {
    const d = doc();
    const xml = parseXml(docxParts(d, { defang: false }).document);
    const text = textOf(xml);
    for (const node of documentNodes(d, { defang: false })) {
      if (node.k === 'heading') expect(text, node.text).toContain(node.text);
      if (node.k === 'table' && node.head[0] === 'Metric') for (const row of node.rows) expect(text, row[1]).toContain(row[1]);
    }
    expect(text).toContain('Methodology & limitations');
    expect(text).toContain('12,840');
  });

  it('escapes model text, drops invalid characters and links only ATT&CK pages', () => {
    const parts = zipMap(reportToDocx(doc(hostileReport()), { now: NOW, defang: false }));
    const body = parts.get('word/document.xml')!.text;
    const text = textOf(parseXml(body));
    expect(text).toContain('<script>alert(1)</script>');
    expect(body).not.toContain('<script>');
    expect(text).toContain('bell nul vt ok');
    expect(body).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    const rels = parseXml(parts.get('word/_rels/document.xml.rels')!.text);
    const external = Array.from(rels.getElementsByTagName('Relationship')).filter((r) => r.getAttribute('TargetMode') === 'External');
    expect(external.length).toBeGreaterThan(0);
    for (const r of external) expect(r.getAttribute('Target')).toMatch(/^https:\/\/attack\.mitre\.org\/techniques\/T\d{4}\/(\d{3}\/)?$/);
    // A model-written URL is code text, never a hyperlink.
    expect(text).toContain('http://evil.example/x');
  });

  it('sizes columns so short words never break and the table fills the page width', () => {
    const widths = columnWidths([
      ['Case', 'demo-00000539-0036'],
      ['Title', 'user:dsingh — identity_signin on a very long descriptive title'],
      ['Severity', 'critical'],
      ['Risk', '64/100'],
    ]);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TEXT_WIDTH);
    expect(widths.reduce((a, b) => a + b, 0)).toBeGreaterThan(TEXT_WIDTH - 10);
    // "Severity"/"critical" (8 characters) get at least their word's width.
    expect(widths[2]).toBeGreaterThanOrEqual(8 * 100 + 220);
    expect(widths[3]).toBeGreaterThanOrEqual(6 * 100 + 220);
    // Too many wide columns: minimums scale down to fit, never past the page.
    const many = columnWidths(Array.from({ length: 12 }, () => ['x'.repeat(30)]));
    expect(many.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TEXT_WIDTH);
    // Even far more columns than the minimums allow: never past the page (no 300-twip floor).
    const crowded = columnWidths(Array.from({ length: 60 }, () => ['1,234']));
    expect(crowded.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TEXT_WIDTH);
  });

  it.each([24, 48])('splits a %i-column heatmap into tables that fit the page, the row labels repeated', (n) => {
    const hours = Array.from({ length: n }, (_, i) => (n === 24 ? `${String(i).padStart(2, '0')}:00` : `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`));
    const heat = {
      id: 'heat',
      type: 'heatmap',
      title: 'Failed logons per hour',
      provenance: 'source',
      artifact_kind: 'matrix',
      allowed_views: ['heatmap', 'table'],
      unit: 'count',
      x: { values: hours, label: 'Hour (UTC)' },
      y: { values: ['Mon', 'Tue', 'Wed'], label: 'Day' },
      cells: [0, 1, 2].map((r) => hours.map((_, c) => 1000 + r * 37 + c)),
    };
    const base = sampleReport();
    const report = { ...base, items: [{ ...base.items[1], id: 'it-heat', block: heat, source: { ...base.items[1].source, block_id: 'heat' } }] };
    const d = doc(report);
    const node = documentNodes(d, { defang: false }).find((x) => x.k === 'table')!;
    expect(node.k === 'table' && node.head).toHaveLength(n + 1);
    const xml = parseXml(docxParts(d, { defang: false }).document);
    const tables = Array.from(xml.getElementsByTagName('w:tbl'));
    expect(tables.length).toBeGreaterThan(1);
    for (const t of tables) {
      const grid = Array.from(t.getElementsByTagName('w:gridCol')).map((g) => Number(g.getAttribute('w:w')));
      expect(grid.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TEXT_WIDTH);
      // Each column keeps at least its longest word ("1,0xx" or "00:30": five characters).
      for (const w of grid.slice(1)) expect(w).toBeGreaterThanOrEqual(5 * 100 + 220);
      // The row labels repeat in every part.
      expect(t.textContent).toContain('Wed');
    }
    const text = textOf(xml);
    expect(text).toContain(hours[n - 1]);
    expect(text).toContain((1000 + 2 * 37 + n - 1).toLocaleString('en-US'));
    expect(text).toMatch(new RegExp(`Columns \\d+–${n} of ${n} \\(continued\\)`));
    // Every column appears exactly once across the parts.
    const chunks = columnChunks(node.k === 'table' ? node.head.map((h, i) => [h, ...node.rows.map((r) => r[i] ?? '')]) : []);
    expect(chunks.flatMap((c) => c.slice(1))).toEqual(hours.map((_, i) => i + 1));
    for (const c of chunks) expect(c[0]).toBe(0);
  });

  it('defangs indicators by default, like the other human documents', () => {
    const parts = zipMap(reportToDocx(doc(), { now: NOW }));
    const text = textOf(parseXml(parts.get('word/document.xml')!.text));
    expect(text).toContain('203[.]0[.]113[.]14');
    expect(text).not.toContain('203.0.113.14');
  });
});

describe('exportReport (files)', () => {
  function capture() {
    const blobs: Array<{ blob: Blob; name: string }> = [];
    let lastName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      lastName = this.download;
      blobs[blobs.length - 1].name = lastName;
    });
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => {
        blobs.push({ blob: b, name: '' });
        return 'blob:t';
      }),
      revokeObjectURL: vi.fn(),
    });
    return blobs;
  }
  const bytesOf = (blob: Blob) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });

  it('marks an outcome a retry cannot change (no tables for CSV)', async () => {
    capture();
    const outcome = await exportReport(sampleReport({ items: [], summary: null }), 'csv', { now: NOW });
    expect(outcome).toEqual({ ok: false, message: 'This report has no tables to export as CSV', retryable: false });
  });

  it('calls the print guidance before window.print and reports it was shown', async () => {
    const order: string[] = [];
    Object.defineProperty(window, 'print', { configurable: true, writable: true, value: vi.fn(() => order.push('print')) });
    const outcome = await exportReport(sampleReport(), 'print', { now: NOW, onPrintOpening: (name) => order.push(`guide ${name}`) });
    expect(order).toEqual(['guide agentic-soc-report-brute-force-on-vpn-gw-2-20261008-1405Z.pdf', 'print']);
    expect(outcome).toMatchObject({ ok: true, guided: true, filename: 'agentic-soc-report-brute-force-on-vpn-gw-2-20261008-1405Z.pdf' });
    const { clearPrintRoot } = await import('../export/print');
    clearPrintRoot();
  });

  it('prefixes the CSV with a UTF-8 BOM so Excel reads it as UTF-8 (R15)', async () => {
    const blobs = capture();
    const outcome = await exportReport(sampleReport(), 'csv', { now: NOW });
    expect(outcome).toMatchObject({ ok: true, message: 'CSV downloaded', filename: 'agentic-soc-report-brute-force-on-vpn-gw-2-20261008-1405Z.csv' });
    const bytes = await bytesOf(blobs[0].blob);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('passes the defang toggle to the Excel Report sheet (on by default)', async () => {
    const blobs = capture();
    await exportReport(sampleReport(), 'xlsx', { now: NOW });
    await exportReport(sampleReport(), 'xlsx', { now: NOW, defang: false });
    const sheet1 = async (blob: Blob) => textOf(parseXml(zipMap(await bytesOf(blob)).get('xl/worksheets/sheet1.xml')!.text));
    expect(await sheet1(blobs[0].blob)).toContain('Block 203[.]0[.]113[.]14 at the edge');
    expect(await sheet1(blobs[1].blob)).toContain('Block 203.0.113.14 at the edge');
  });

  it('saves Word and Excel packages with their MIME types and names', async () => {
    const blobs = capture();
    const docx = await exportReport(sampleReport(), 'docx', { now: NOW, author: 'ana' });
    const xlsx = await exportReport(sampleReport(), 'xlsx', { now: NOW, author: 'ana' });
    expect(docx).toMatchObject({ ok: true, message: 'Word document downloaded', filename: expect.stringMatching(/\.docx$/) });
    expect(xlsx).toMatchObject({ ok: true, message: 'Excel workbook downloaded', filename: expect.stringMatching(/\.xlsx$/) });
    expect(blobs[0].blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(blobs[1].blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    checkPackage(await bytesOf(blobs[0].blob), 'word/document.xml');
    checkPackage(await bytesOf(blobs[1].blob), 'xl/workbook.xml');
  });

  it('writes a calendar chart in its periods in Word and Excel, never as UTC bucket starts', () => {
    const d = buildReportDoc(calendarReport(), { generatedAt: NOW.toISOString() });
    const word = textOf(parseXml(docxParts(d, { defang: false }).document));
    for (const want of ['Period (Asia/Kolkata)', 'Sep 2026 (from 12 Sep)', 'Oct 2026 (in progress)']) expect(word).toContain(want);
    expect(word).not.toContain('2026-08-31 18:30 UTC');
    expect(word).not.toContain('Time (UTC)');
    const sheet = workbookModel(d).sheets.find((s) => s.rows.some((r) => r[0]?.kind === 'text' && r[0].text === 'Period (Asia/Kolkata)'))!;
    expect(sheet).toBeDefined();
    const header = sheet.rows.findIndex((r) => r[0]?.kind === 'text' && r[0].text === 'Period (Asia/Kolkata)');
    const body = sheet.rows.slice(header + 1).filter((r) => r.length);
    expect(body.map((r) => (r[0]?.kind === 'text' ? r[0].text : null))).toEqual(['Sep 2026 (from 12 Sep)', 'Oct 2026 (in progress)']);
    // The counts stay numbers.
    expect(body.map((r) => (r[1]?.kind === 'number' ? r[1].value : null))).toEqual([2, 72]);
    const flat = sheet.rows.flat().map((c) => (c ? (c.kind === 'text' ? (c.text ?? '') : String(c.value)) : ''));
    expect(flat.join('\n')).not.toContain('18:30 UTC');
  });

  it('keeps every KPI value in the Excel overview and sheets', () => {
    const model = workbookModel(doc());
    const kpi = model.sheets.find((s) => s.rows.some((r) => r[0]?.kind === 'text' && r[0].text === 'Metric'))!;
    const flat = kpi.rows.flat().map((c) => (c ? (c.kind === 'text' ? c.text : String(c.value)) : ''));
    expect(flat).toContain('12840'); // an exact count stays a number
    expect(flat).toContain('≥ 43'); // a lower bound stays text
    expect(flat).toContain('18%');
    void rawBlock;
  });
});
