/**
 * Excel export (Round 12 SPEC WP-REP; SYNTHESIS-chat P1-7): a client-side `.xlsx`
 * workbook generated from the SAME document nodes the Markdown and HTML exports
 * serialise (`walker.ts`), packed by the in-repo store-only ZIP writer. No dependency.
 *
 *   - Sheet "Report": the whole document as readable lines (title, metadata, summary,
 *     items, methodology, queries); every data table is listed there with a link to
 *     its own sheet.
 *   - One sheet per data table (a block's table, a chart's or heatmap's data, a KPI
 *     group): title, caption, a bold frozen header row with a filter, then the rows.
 *     Numbers stay NUMERIC (the walker's raw values) with a number format for their
 *     unit; text is an inline string.
 *
 * Like CSV, a spreadsheet is a DATA format: it is never defanged (the toggle applies to
 * the human documents). Safety (#9):
 *   - every string goes through `xmlText` (XML 1.0-invalid characters dropped, markup
 *     characters escaped) — an inline string is never parsed as markup or a formula;
 *   - Excel and LibreOffice DECODE `_xHHHH_` inside cell text (ST_Xstring), so a literal
 *     `_x003D_HYPERLINK(…)` would become `=HYPERLINK(…)` and `_x0000_` a NUL after both
 *     checks above ran on the raw text. Every literal `_xHHHH_` is therefore written as
 *     `_x005F_xHHHH_` (the escaped underscore), so it reads back exactly as it was;
 *     sheet names drop the pattern;
 *   - a STRING cell that starts with `= + - @`, TAB or CR (also after spaces) takes the
 *     quote-prefix cell style (`quotePrefix="1"`): Excel shows it as typed and keeps it
 *     TEXT when it is edited, re-entered or pasted. When the text could still act as a
 *     formula outside Excel's own cell (re-saved as CSV and reopened) — any lead but a
 *     plain sign, or a sign followed by formula syntax (a call, DDE `|`, a reference
 *     `!`, quotes, operators) — it is ALSO prefixed with a literal `'` (`lib/csv`
 *     `defuseFormula`, the CSV rule), so a source-controlled `=HYPERLINK(…)` is never a
 *     live formula. A plain sign and words ("+10 vs previous window", "-3%") show no
 *     apostrophe;
 *   - sheet names are sanitised (no `[ ] : * ? / \`, no leading/trailing `'`, ≤ 31
 *     characters, unique ignoring case, never the reserved "History").
 */
import { defuseFormula } from '@/lib/csv';

import type { MdBlock, MdInline } from '../../ChatMarkdown';
import type { ValueUnit } from '../../blocks/schema';
import type { ReportDoc } from '../model';
import {
  CONTENT_TYPE,
  NS,
  XML_DECL,
  appPropsXml,
  contentTypesXml,
  corePropsXml,
  packageRelsXml,
  relationshipsXml,
  xmlAttr,
  xmlText,
} from './ooxml';
import { documentNodes, type DocNode, type Line, type TableNode } from './walker';
import { zipStore } from './zip';

/* -------------------------------------------------------------------------- */
/* Cells and styles.                                                           */
/* -------------------------------------------------------------------------- */

/** Excel's hard limit on one cell's text. */
export const MAX_CELL_CHARS = 32_767;
/** Excel's limit on a sheet name. */
export const MAX_SHEET_NAME = 31;

/** Style indexes into `cellXfs` (see {@link STYLES_XML}). */
const S = {
  normal: 0,
  header: 1,
  title: 2,
  caption: 3,
  wrap: 4,
  bold: 5,
  link: 6,
} as const;

/** The quote-prefix twin (`quotePrefix="1"`) of each text style: `cellXfs` index 17 + style. */
export const QUOTED_STYLE_BASE = 17;
const quoted = (style: number): number => QUOTED_STYLE_BASE + style;

/** Number-format styles by unit (`cellXfs` indexes ≥ 7). */
const UNIT_STYLE: Partial<Record<ValueUnit, number>> = {
  percent: 7,
  ratio: 8,
  score: 9,
  ms: 10,
  seconds: 11,
  minutes: 12,
  hours: 13,
  usd: 14,
  bytes: 15,
  tokens: 16,
};

export const STYLES_XML =
  `${XML_DECL}<styleSheet xmlns="${NS.sheetMain}">` +
  '<numFmts count="9">' +
  '<numFmt numFmtId="164" formatCode="0.0&quot;%&quot;"/>' +
  '<numFmt numFmtId="165" formatCode="0.0%"/>' +
  '<numFmt numFmtId="166" formatCode="0&quot;/100&quot;"/>' +
  '<numFmt numFmtId="167" formatCode="#,##0&quot; ms&quot;"/>' +
  '<numFmt numFmtId="168" formatCode="#,##0.0&quot; s&quot;"/>' +
  '<numFmt numFmtId="169" formatCode="#,##0.0&quot; min&quot;"/>' +
  '<numFmt numFmtId="170" formatCode="#,##0.0&quot; h&quot;"/>' +
  '<numFmt numFmtId="171" formatCode="&quot;$&quot;#,##0.00"/>' +
  '<numFmt numFmtId="172" formatCode="#,##0&quot; B&quot;"/>' +
  '</numFmts>' +
  '<fonts count="5">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><i/><sz val="10"/><color rgb="FF5F6B7A"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><u/><sz val="11"/><color rgb="FF0B5CC4"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FFC9CED8"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="24">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="170" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="171" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="172" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  // 17–23: the text styles 0–6 with quotePrefix (a formula-led string stays text).
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" quotePrefix="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" quotePrefix="1"/>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" quotePrefix="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1" quotePrefix="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" quotePrefix="1"/>' +
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" quotePrefix="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

type XCell = { kind: 'text'; text: string; style?: number } | { kind: 'number'; value: number; style?: number } | null;

const text = (value: string, style?: number): XCell => ({ kind: 'text', text: value, style });

/** A formula lead (`lib/csv`'s rule): `= + - @`, TAB or CR, also after spaces. */
const FORMULA_LEAD = /^(?:[=+\-@\t\r]| +[=+\-@])/;
/** A plain sign lead (`+` / `-`, maybe after spaces). */
const SIGN_LEAD = /^ *[+-]/;
/**
 * After a plain sign, what could make the text compute or reach out if it were ever
 * evaluated: a call `(`, DDE `|`, a reference `!` / `[`, quotes, operators.
 */
const FORMULA_SYNTAX = /[=+\-@()|!"'&^*/<>;[\]{}\\~`\t\r]/;

/** A literal `_xHHHH_` (either case of `x`), which Excel and LibreOffice may decode in cell text. */
const XSTRING_ESCAPE = /_(?=[xX][0-9A-Fa-f]{4}_)/g;

/** Text for an ST_Xstring (cell text, a hyperlink's display): `_xHHHH_` stays literal. */
export function xstring(text: string): string {
  return text.replace(XSTRING_ESCAPE, '_x005F_');
}

/** A STRING cell as written: its text and whether it takes the quote-prefix style. */
export interface SheetString {
  text: string;
  quoted: boolean;
}

/**
 * A STRING cell's text and style (cut to Excel's cell limit). A formula-led string takes
 * the quote-prefix style; it also keeps a literal `'` unless it is a plain sign followed
 * by plain words, which no spreadsheet could turn into a call, a link or a reference.
 */
export function sheetString(value: string): SheetString {
  let text = value;
  let isQuoted = false;
  if (FORMULA_LEAD.test(value)) {
    isQuoted = true;
    const sign = SIGN_LEAD.exec(value);
    const inert = sign !== null && !FORMULA_SYNTAX.test(value.slice(sign[0].length));
    if (!inert) text = defuseFormula(value);
  }
  if (text.length > MAX_CELL_CHARS) text = `${text.slice(0, MAX_CELL_CHARS - 1)}…`;
  return { text, quoted: isQuoted };
}

/** A STRING cell's text as stored (see {@link sheetString}). */
export function sheetText(value: string): string {
  return sheetString(value).text;
}

/** `A`, `B`, … `Z`, `AA`, … for a 0-based column index. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Sheet names.                                                                */
/* -------------------------------------------------------------------------- */

/** A sheet name Excel accepts, unique (ignoring case) among `taken`; adds it there. */
export function sheetName(raw: string, taken: Set<string>, fallback: string): string {
  let base = raw
    // A `_xHHHH_` would be decoded in the name: drop the pattern's underscore.
    .replace(XSTRING_ESCAPE, ' ')
    .replace(/[\u0000-\u001f\u007f[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  if (!base || base.toLowerCase() === 'history') base = fallback;
  const cut = (s: string, room: number) => {
    // Never split a surrogate pair at the cut.
    let out = s.slice(0, room);
    if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
    return out.replace(/'+$/, '').trim() || fallback.slice(0, room);
  };
  let name = cut(base, MAX_SHEET_NAME);
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = `${cut(base, MAX_SHEET_NAME - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

/** A sheet name quoted for a formula / defined-name reference (`'It''s'!A1`). */
export function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/* -------------------------------------------------------------------------- */
/* Worksheets.                                                                 */
/* -------------------------------------------------------------------------- */

interface Sheet {
  name: string;
  rows: XCell[][];
  /** Column widths in characters. */
  widths: number[];
  /** 1-based row of the frozen header (0 = no frozen pane). */
  headerRow: number;
  /** Filter range over header + data. */
  filter: string | null;
  /** Internal links: cell ref → target location. */
  links: Array<{ ref: string; location: string; display: string }>;
}

function cellXml(cell: XCell, ref: string): string {
  if (!cell) return '';
  if (cell.kind === 'number') {
    const s = cell.style ? ` s="${cell.style}"` : '';
    return `<c r="${ref}"${s}><v>${String(cell.value)}</v></c>`;
  }
  const str = sheetString(cell.text);
  const style = str.quoted ? quoted(cell.style ?? S.normal) : cell.style;
  const s = style ? ` s="${style}"` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(xstring(str.text))}</t></is></c>`;
}

function sheetXml(sheet: Sheet, selected: boolean): string {
  const lastCol = Math.max(1, ...sheet.rows.map((r) => r.length));
  const dim = `A1:${columnName(lastCol - 1)}${Math.max(1, sheet.rows.length)}`;
  const pane = sheet.headerRow
    ? `<pane ySplit="${sheet.headerRow}" topLeftCell="A${sheet.headerRow + 1}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${sheet.headerRow + 1}" sqref="A${sheet.headerRow + 1}"/>`
    : '';
  const cols = sheet.widths.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const data = sheet.rows
    .map((row, r) => {
      const cells = row.map((cell, c) => cellXml(cell, `${columnName(c)}${r + 1}`)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const filter = sheet.filter ? `<autoFilter ref="${sheet.filter}"/>` : '';
  const links = sheet.links.length
    ? `<hyperlinks>${sheet.links
        .map((l) => `<hyperlink ref="${l.ref}" location="${xmlAttr(l.location)}" display="${xmlAttr(xstring(sheetText(l.display)))}"/>`)
        .join('')}</hyperlinks>`
    : '';
  return (
    `${XML_DECL}<worksheet xmlns="${NS.sheetMain}" xmlns:r="${NS.officeRels}">` +
    `<dimension ref="${dim}"/>` +
    `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `${cols}<sheetData>${data}</sheetData>${filter}${links}` +
    '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

/* -------------------------------------------------------------------------- */
/* Document nodes → sheets.                                                    */
/* -------------------------------------------------------------------------- */

const lineText = (line: Line): string => line.map((r) => r.text).join('');

function inlineText(nodes: readonly MdInline[], defang: boolean): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v;
        case 'strong':
        case 'em':
        case 'del':
          return inlineText(n.c, defang);
        case 'doc':
          return `${inlineText(n.c, defang)} (Help Center ${n.href})`;
        case 'url':
          return defang ? n.defanged : n.url;
        case 'cite':
          return `[${n.id}]`;
        case 'br':
          return '\n';
        default:
          return '';
      }
    })
    .join('');
}

/** Answer prose as plain lines (`bold` marks headings). */
function mdLines(blocks: readonly MdBlock[], defang: boolean, indent = ''): Array<{ text: string; bold?: boolean }> {
  const out: Array<{ text: string; bold?: boolean }> = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        out.push({ text: `${indent}${inlineText(b.inline, defang)}`, bold: true });
        break;
      case 'paragraph':
        out.push({ text: `${indent}${inlineText(b.inline, defang)}` });
        break;
      case 'rule':
        out.push({ text: '' });
        break;
      case 'code':
        out.push({ text: b.code });
        break;
      case 'blockquote':
        out.push(...mdLines(b.blocks, defang, `${indent}  `));
        break;
      case 'list':
        b.items.forEach((item, i) => {
          const marker = b.ordered ? `${b.start + i}. ` : '• ';
          const inner = mdLines(item.blocks, defang, `${indent}   `);
          if (inner.length) inner[0] = { ...inner[0], text: `${indent}${marker}${inner[0].text.trimStart()}` };
          out.push(...inner);
        });
        break;
      case 'table':
        out.push({ text: `${indent}${b.header.map((c) => inlineText(c, defang)).join(' | ')}`, bold: true });
        for (const row of b.rows) out.push({ text: `${indent}${b.header.map((_, i) => inlineText(row[i] ?? [], defang)).join(' | ')}` });
        break;
      default:
        break;
    }
  }
  return out;
}

function widthOf(values: readonly string[], min = 8, max = 60): number {
  const longest = Math.max(0, ...values.map((v) => Math.max(...v.split('\n').map((l) => l.length))));
  return Math.min(max, Math.max(min, longest + 2));
}

/** One data table as its own sheet. */
function tableSheet(node: TableNode, name: string, index: number): Sheet {
  const rows: XCell[][] = [];
  rows.push([text(node.label || `Table ${index}`, S.title)]);
  if (node.caption) rows.push([text(node.caption, S.caption)]);
  const headerRow = rows.length + 1;
  rows.push(node.head.map((h) => text(h, S.header)));
  node.rows.forEach((row, r) => {
    rows.push(
      row.map((cell, c) => {
        const raw = node.values?.[r]?.[c];
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          const unit = node.units?.[c] ?? null;
          return { kind: 'number', value: raw, style: unit ? UNIT_STYLE[unit] : undefined };
        }
        // Not measured is an empty cell (as in CSV), never a 0 and never a dash in a number column.
        if ((cell === '—' && node.numeric[c]) || cell === '') return null;
        return text(cell);
      }),
    );
  });
  const lastRow = rows.length;
  const widths = node.head.map((h, c) => widthOf([h, ...node.rows.map((r) => r[c] ?? '')]));
  return {
    name,
    rows,
    widths,
    headerRow,
    filter: node.head.length ? `A${headerRow}:${columnName(node.head.length - 1)}${Math.max(headerRow, lastRow)}` : null,
    links: [],
  };
}

export interface WorkbookOptions {
  /** Export instant (DOS timestamps and document properties; tests pin it). */
  now?: Date;
}

export interface WorkbookModel {
  sheets: Sheet[];
}

/** Build the workbook model from a document (pure; exported for tests). */
export function workbookModel(doc: ReportDoc): WorkbookModel {
  // A spreadsheet is a data format: never defanged (like CSV and JSON).
  const nodes: DocNode[] = documentNodes(doc, { defang: false });
  const taken = new Set<string>();
  const overviewName = sheetName('Report', taken, 'Report');
  const overview: Sheet = { name: overviewName, rows: [], widths: [110], headerRow: 0, filter: null, links: [] };
  const tables: Sheet[] = [];
  const push = (cell: XCell) => overview.rows.push([cell]);

  for (const node of nodes) {
    switch (node.k) {
      case 'heading':
        push(text(node.text, node.level === 1 ? S.title : S.bold));
        break;
      case 'meta':
        push(text(node.text, S.caption));
        break;
      case 'para':
        push(text(lineText(node.line), node.muted ? S.caption : S.wrap));
        break;
      case 'md':
        for (const line of mdLines(node.blocks, false)) push(line.text ? text(line.text, line.bold ? S.bold : S.wrap) : null);
        break;
      case 'list':
        node.items.forEach((line, i) => push(text(`${node.ordered ? `${i + 1}. ` : '• '}${lineText(line)}`, S.wrap)));
        break;
      case 'code':
        if (node.caption) push(text(node.caption, S.caption));
        push(text(node.text, S.wrap));
        break;
      case 'callout':
        push(text(`${node.label}: ${node.text}`, S.wrap));
        break;
      case 'attack':
        for (const t of node.items) push(text(`${t.id}${t.label ? ` ${t.label}` : ''}${t.url ? ` — ${t.url}` : ''}`, S.wrap));
        break;
      case 'table': {
        const n = tables.length + 1;
        const name = sheetName(`${n} ${node.label ?? 'Table'}`, taken, `Table ${n}`);
        tables.push(tableSheet(node, name, n));
        const display = `Table ${n}: ${node.label ?? 'data'} (sheet "${name}")`;
        push(text(display, S.link));
        overview.links.push({ ref: `A${overview.rows.length}`, location: `${quoteSheet(name)}!A1`, display });
        break;
      }
      case 'rule':
        push(null);
        break;
      default:
        break;
    }
  }
  return { sheets: [overview, ...tables] };
}

function workbookXml(model: WorkbookModel): string {
  const sheets = model.sheets.map((s, i) => `<sheet name="${xmlAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const names = model.sheets
    .map((s, i) =>
      s.filter
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(
            `${quoteSheet(s.name)}!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`,
          )}</definedName>`
        : '',
    )
    .join('');
  return (
    `${XML_DECL}<workbook xmlns="${NS.sheetMain}" xmlns:r="${NS.officeRels}">` +
    '<bookViews><workbookView activeTab="0"/></bookViews>' +
    `<sheets>${sheets}</sheets>${names ? `<definedNames>${names}</definedNames>` : ''}` +
    '</workbook>'
  );
}

/** The `.xlsx` package bytes of a document. */
export function reportToXlsx(doc: ReportDoc, options: WorkbookOptions = {}): Uint8Array {
  const at = options.now ?? new Date();
  const model = workbookModel(doc);
  const sheetParts = model.sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i === 0) }));
  return zipStore(
    [
      {
        name: '[Content_Types].xml',
        data: contentTypesXml([
          { part: '/xl/workbook.xml', type: CONTENT_TYPE.workbook },
          { part: '/xl/styles.xml', type: CONTENT_TYPE.sheetStyles },
          ...sheetParts.map((p) => ({ part: `/${p.name}`, type: CONTENT_TYPE.worksheet })),
          { part: '/docProps/core.xml', type: CONTENT_TYPE.core },
          { part: '/docProps/app.xml', type: CONTENT_TYPE.app },
        ]),
      },
      { name: '_rels/.rels', data: packageRelsXml('xl/workbook.xml') },
      { name: 'docProps/core.xml', data: corePropsXml({ title: doc.title, creator: doc.author, at }) },
      { name: 'docProps/app.xml', data: appPropsXml() },
      { name: 'xl/workbook.xml', data: workbookXml(model) },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: relationshipsXml([
          ...model.sheets.map((_, i) => ({ id: `rId${i + 1}`, type: NS.worksheet, target: `worksheets/sheet${i + 1}.xml` })),
          { id: `rId${model.sheets.length + 1}`, type: NS.styles, target: 'styles.xml' },
        ]),
      },
      { name: 'xl/styles.xml', data: STYLES_XML },
      ...sheetParts,
    ],
    at,
  );
}
