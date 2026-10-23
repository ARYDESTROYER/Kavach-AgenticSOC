/**
 * Word export (Round 12 SPEC WP-REP; SYNTHESIS-chat P1-7): a client-side `.docx`
 * generated from the SAME document nodes the Markdown and HTML exports serialise
 * (`walker.ts`), packed by the in-repo store-only ZIP writer. No dependency.
 *
 * The package is the minimum Word, LibreOffice and Google Docs open without repair:
 * `[Content_Types].xml`, the package and document relationships, `word/document.xml`,
 * `word/styles.xml` (Normal, Title, Heading 1–6 with outline levels so the navigation
 * pane works, Caption, a code style and table style), a footer with the report title and
 * "Page N of M", and the core/app properties. Pages are A4.
 *
 * Content rules (the same as the Markdown and HTML exports):
 *   - a chart or heatmap is its DATA TABLE plus a caption naming the kind and unit (an
 *     embedded picture is optional and not produced);
 *   - untrusted values are monospace runs, never links; model prose comes from the
 *     sanitised AST, so a model-written link, image or tag is literal text;
 *   - the only hyperlinks are ATT&CK technique pages constructed from validated ids;
 *   - IOCs are defanged by default (the export-menu toggle), like Markdown, HTML and PDF.
 *
 * #9: every string reaches the XML through `xmlText` / `xmlAttr` (XML-invalid
 * characters dropped, markup escaped). Nothing from data becomes markup, a field code or
 * a relationship target.
 */
import type { MdAlign, MdBlock, MdInline } from '../../ChatMarkdown';
import { columnPartLabel } from '../../blocks/format';
import type { ToneKey } from '../../blocks/schema';
import { maybeDefang } from '@/lib/defang';
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
  xmlText,
  type Relationship,
} from './ooxml';
import { codeCellText, documentNodes, type DocNode, type Line, type WalkOptions } from './walker';
import { zipStore } from './zip';

/** A4 in twentieths of a point, with 15 mm side and 18 mm top/bottom margins. */
const PAGE = { width: 11906, height: 16838, top: 1021, bottom: 1021, side: 850 } as const;
/** The text column width (twips). */
export const TEXT_WIDTH = PAGE.width - 2 * PAGE.side;

const MONO = 'Consolas';

/* -------------------------------------------------------------------------- */
/* Runs and paragraphs.                                                        */
/* -------------------------------------------------------------------------- */

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  muted?: boolean;
}

/** One run; line breaks and tabs inside the text become `<w:br/>` / `<w:tab/>`. */
function run(textValue: string, style: RunStyle = {}): string {
  if (!textValue) return '';
  const props: string[] = [];
  if (style.code) props.push('<w:rStyle w:val="CodeChar"/>');
  if (style.bold) props.push('<w:b/><w:bCs/>');
  if (style.italic) props.push('<w:i/><w:iCs/>');
  if (style.strike) props.push('<w:strike/>');
  if (style.muted) props.push('<w:color w:val="5F6B7A"/>');
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  const parts = textValue.replace(/\r\n?/g, '\n').split(/(\n|\t)/);
  const body = parts
    .map((part) => {
      if (part === '\n') return '<w:br/>';
      if (part === '\t') return '<w:tab/>';
      return part ? `<w:t xml:space="preserve">${xmlText(part)}</w:t>` : '';
    })
    .join('');
  return `<w:r>${rPr}${body}</w:r>`;
}

interface ParaStyle {
  style?: string;
  align?: 'left' | 'center' | 'right';
  indent?: number;
  hanging?: number;
  keepNext?: boolean;
  /** A left border colour (callouts). */
  border?: string;
}

function para(content: string, style: ParaStyle = {}): string {
  const p: string[] = [];
  if (style.style) p.push(`<w:pStyle w:val="${style.style}"/>`);
  if (style.keepNext) p.push('<w:keepNext/>');
  if (style.border) p.push(`<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${style.border}"/></w:pBdr>`);
  if (style.indent || style.hanging) {
    p.push(`<w:ind w:left="${style.indent ?? 0}"${style.hanging ? ` w:hanging="${style.hanging}"` : ''}/>`);
  }
  if (style.align && style.align !== 'left') p.push(`<w:jc w:val="${style.align}"/>`);
  const pPr = p.length ? `<w:pPr>${p.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${content}</w:p>`;
}

/* -------------------------------------------------------------------------- */
/* The writer.                                                                 */
/* -------------------------------------------------------------------------- */

const TONE_COLOR: Record<ToneKey, string> = {
  info: '6B7280',
  success: '0E8A5F',
  warning: 'C27803',
  critical: 'C81E2B',
};

class DocxWriter {
  readonly body: string[] = [];
  readonly rels: Relationship[] = [{ id: 'rId1', type: NS.styles, target: 'styles.xml' }];
  private links = new Map<string, string>();

  constructor() {
    this.rels.push({ id: 'rId2', type: NS.footer, target: 'footer1.xml' });
  }

  /** A relationship id for an external link (deduplicated). */
  private linkId(url: string): string {
    const known = this.links.get(url);
    if (known) return known;
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type: NS.hyperlink, target: url, external: true });
    this.links.set(url, id);
    return id;
  }

  /** Inline AST → runs. */
  inline(nodes: readonly MdInline[], defang: boolean, style: RunStyle = {}): string {
    return nodes
      .map((n) => {
        switch (n.t) {
          case 'text':
            return run(n.v, style);
          case 'code':
            return run(n.v, { ...style, code: true });
          case 'strong':
            return this.inline(n.c, defang, { ...style, bold: true });
          case 'em':
            return this.inline(n.c, defang, { ...style, italic: true });
          case 'del':
            return this.inline(n.c, defang, { ...style, strike: true });
          case 'doc':
            // A same-origin Help Center path does not resolve from a saved file: text only.
            return `${this.inline(n.c, defang, style)}${run(' (Help Center ', { ...style, muted: true })}${run(n.href, { code: true })}${run(')', { ...style, muted: true })}`;
          case 'url':
            return run(defang ? n.defanged : n.url, { ...style, code: true });
          case 'cite':
            return run(`[${n.id}]`, style);
          case 'br':
            return '<w:r><w:br/></w:r>';
          default:
            return '';
        }
      })
      .join('');
  }

  lineRuns(line: Line, style: RunStyle = {}): string {
    return line.map((r) => run(r.text, { ...style, code: r.code || style.code, bold: r.strong || style.bold })).join('');
  }

  heading(level: number, content: string): void {
    const lvl = Math.max(1, Math.min(6, level));
    this.body.push(para(content, { style: lvl === 1 ? 'Title' : `Heading${lvl - 1}` }));
  }

  /**
   * A table. `cells[r][c]` is ready run XML; `plain[c]` holds column c's texts (header
   * first) for sizing. The header row repeats on every page and no row splits across
   * pages.
   */
  table(head: string[], cells: string[][], align: Array<'left' | 'center' | 'right'>, plain: string[][]): void {
    // A row needs at least one cell; a table with no columns has nothing to show.
    if (!head.length) return;
    const chunks = columnChunks(plain);
    chunks.forEach((cols, k) => {
      if (chunks.length > 1) {
        // Which columns this part holds; the paragraph also keeps Word from merging the parts.
        const label = columnPartLabel(cols[1], cols[cols.length - 1], head.length - 1, k > 0);
        this.body.push(para(run(label), { style: 'Meta', keepNext: true }));
      }
      const widths = columnWidths(cols.map((i) => plain[i]));
      const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
      const cell = (content: string, i: number, j: number, header: boolean) =>
        `<w:tc><w:tcPr><w:tcW w:w="${widths[j]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F3F6"/>' : ''}</w:tcPr>` +
        `${para(content || '', { style: 'TableText', align: align[i] ?? 'left', keepNext: header })}</w:tc>`;
      const headRow = `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${cols.map((i, j) => cell(run(head[i], { bold: true }), i, j, true)).join('')}</w:tr>`;
      const rows = cells.map((row) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cols.map((i, j) => cell(row[i] ?? '', i, j, false)).join('')}</w:tr>`).join('');
      this.body.push(
        '<w:tbl><w:tblPr><w:tblStyle w:val="ReportTable"/>' +
          `<w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
          '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>' +
          `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headRow}${rows}</w:tbl>`,
      );
      if (k < chunks.length - 1) this.afterTable();
    });
  }

  /**
   * The paragraph after a table: its caption, or a small gap. Word joins two tables
   * with nothing between them into one, so a table is never followed directly by another.
   */
  afterTable(caption?: string): void {
    this.body.push(caption ? para(run(caption), { style: 'Caption' }) : '<w:p><w:pPr><w:spacing w:before="0" w:after="60"/></w:pPr></w:p>');
  }

  /** Answer prose (sanitised AST): rank-1 headings render at `base`. */
  md(blocks: readonly MdBlock[], base: number, defang: boolean, indent = 0): void {
    for (const b of blocks) {
      switch (b.type) {
        case 'heading': {
          const rank = Number.isInteger(b.rank) && b.rank > 0 ? b.rank : 1;
          this.heading(Math.min(6, base + rank - 1), this.inline(b.inline, defang));
          break;
        }
        case 'paragraph':
          this.body.push(para(this.inline(b.inline, defang), { indent }));
          break;
        case 'rule':
          this.body.push(para('', { style: 'Rule' }));
          break;
        case 'code':
          this.body.push(para(run(b.code, { code: true }), { style: 'CodeBlock', indent }));
          break;
        case 'blockquote':
          this.md(b.blocks, base, defang, indent + 360);
          break;
        case 'list':
          b.items.forEach((item, i) => {
            const marker = b.ordered ? `${b.start + i}.` : '•';
            const [first, ...rest] = item.blocks;
            if (first && first.type === 'paragraph') {
              this.body.push(para(`${run(`${marker}\t`)}${this.inline(first.inline, defang)}`, { style: 'ListText', indent: indent + 360, hanging: 360 }));
              this.md(rest, base, defang, indent + 360);
            } else {
              this.body.push(para(run(marker), { style: 'ListText', indent: indent + 360, hanging: 360 }));
              this.md(item.blocks, base, defang, indent + 360);
            }
          });
          break;
        case 'table': {
          const align = b.header.map((_, i) => alignOf(b.align[i] ?? null));
          const head = b.header.map((c) => plainInline(c, defang));
          const cells = b.rows.map((row) => b.header.map((_, i) => this.inline(row[i] ?? [], defang)));
          this.table(head, cells, align, head.map((h, i) => [h, ...b.rows.map((r) => plainInline(r[i] ?? [], defang))]));
          this.afterTable();
          break;
        }
        default:
          break;
      }
    }
  }

  node(n: DocNode): void {
    switch (n.k) {
      case 'heading':
        this.heading(n.level, run(n.text));
        return;
      case 'meta':
        this.body.push(para(run(n.text), { style: 'Meta' }));
        return;
      case 'para':
        this.body.push(para(this.lineRuns(n.line, { muted: n.muted }), n.muted ? { style: 'Meta' } : {}));
        return;
      case 'md':
        this.md(n.blocks, n.base, n.defang);
        return;
      case 'table': {
        const cells = n.rows.map((row, r) =>
          row.map((c, i) => {
            const code = (n.cellCode?.[r]?.[i] ?? n.code[i] ?? false) && codeCellText(c);
            return run(c, { code });
          }),
        );
        this.table(
          n.head,
          cells,
          n.head.map((_, i) => (n.numeric[i] ? 'right' : 'left')),
          n.head.map((h, i) => [h, ...n.rows.map((r) => r[i] ?? '')]),
        );
        this.afterTable(n.caption);
        return;
      }
      case 'list':
        n.items.forEach((line, i) => {
          this.body.push(para(`${run(`${n.ordered ? `${i + 1}.` : '•'}\t`)}${this.lineRuns(line)}`, { style: 'ListText', indent: 360, hanging: 360 }));
        });
        return;
      case 'code':
        if (n.caption) this.body.push(para(run(n.caption), { style: 'Meta', keepNext: true }));
        this.body.push(para(run(n.text, { code: true }), { style: 'CodeBlock' }));
        return;
      case 'callout':
        this.body.push(para(`${run(`${n.label}: `, { bold: true })}${run(n.text)}`, { style: 'Callout', border: TONE_COLOR[n.tone] }));
        return;
      case 'attack':
        for (const t of n.items) {
          const id = t.url
            ? `<w:hyperlink r:id="${this.linkId(t.url)}" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">${xmlText(t.id)}</w:t></w:r></w:hyperlink>`
            : run(t.id, { code: true });
          this.body.push(para(`${run('•\t')}${id}${t.label ? run(` ${t.label}`) : ''}`, { style: 'ListText', indent: 360, hanging: 360 }));
        }
        return;
      case 'rule':
        this.body.push(para('', { style: 'Rule' }));
        return;
      default:
        return;
    }
  }
}

function alignOf(a: MdAlign): 'left' | 'center' | 'right' {
  return a === 'center' || a === 'right' ? a : 'left';
}

/** Approximate width of one character at the table's 9 pt (twips), and a cell's margins. */
const CHAR_TWIPS = 100;
const CELL_PAD_TWIPS = 220;

/** A column's minimum (twips): room for its longest WORD, capped at 24 characters. */
function minimumWidths(plain: ReadonlyArray<readonly string[]>): number[] {
  return plain.map((texts) => {
    const word = Math.max(1, ...texts.flatMap((t) => t.split(/\s+/).map((w) => w.length)));
    return Math.min(24, word) * CHAR_TWIPS + CELL_PAD_TWIPS;
  });
}

/**
 * Column widths (twips) that fill the text column: every column first gets room for its
 * longest WORD (so "Severity" or "critical" never breaks mid-word; very long tokens such
 * as ids are capped and may wrap), then the rest is shared by how much text each holds.
 * The total never exceeds {@link TEXT_WIDTH} (a fixed-layout table wider than the text
 * column runs off the page); a table whose minimums do not fit is first split by
 * {@link columnChunks}, so the scaling below is a backstop only.
 */
export function columnWidths(plain: ReadonlyArray<readonly string[]>): number[] {
  const minimum = minimumWidths(plain);
  const weight = plain.map((texts) => Math.min(40, Math.max(4, ...texts.map((t) => t.length))));
  const floor = minimum.reduce((a, b) => a + b, 0);
  if (floor >= TEXT_WIDTH) return minimum.map((m) => Math.floor((m * TEXT_WIDTH) / floor));
  const spare = TEXT_WIDTH - floor;
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  return minimum.map((m, i) => Math.floor(m + (spare * weight[i]) / total));
}

/**
 * The column sets a table prints as (indexes into its columns). One set when every
 * column's minimum fits the text column; otherwise consecutive tables, each repeating
 * the FIRST column (the row label: a day, a rule, a host) with as many further columns
 * as fit — a 48-bucket heatmap prints as a few readable tables instead of one squeezed
 * past the page edge.
 */
export function columnChunks(plain: ReadonlyArray<readonly string[]>): number[][] {
  const minimum = minimumWidths(plain);
  if (minimum.reduce((a, b) => a + b, 0) <= TEXT_WIDTH || plain.length < 3) return [plain.map((_, i) => i)];
  const chunks: number[][] = [];
  let chunk = [0];
  let used = minimum[0];
  for (let i = 1; i < plain.length; i += 1) {
    if (chunk.length > 1 && used + minimum[i] > TEXT_WIDTH) {
      chunks.push(chunk);
      chunk = [0];
      used = minimum[0];
    }
    chunk.push(i);
    used += minimum[i];
  }
  chunks.push(chunk);
  return chunks;
}

function plainInline(nodes: readonly MdInline[], defang: boolean): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v;
        case 'strong':
        case 'em':
        case 'del':
        case 'doc':
          return plainInline(n.c, defang);
        case 'url':
          return defang ? n.defanged : n.url;
        case 'cite':
          return `[${n.id}]`;
        default:
          return ' ';
      }
    })
    .join('');
}

/* -------------------------------------------------------------------------- */
/* Fixed parts.                                                                */
/* -------------------------------------------------------------------------- */

const headingStyle = (n: number, size: number, before: number) =>
  `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
  `<w:rPr><w:b/><w:bCs/><w:color w:val="1A2233"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

export const DOCX_STYLES_XML =
  `${XML_DECL}<w:styles xmlns:w="${NS.wordMain}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:spacing w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1A2233"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>' +
  headingStyle(1, 30, 320) +
  headingStyle(2, 26, 240) +
  headingStyle(3, 23, 200) +
  headingStyle(4, 21, 160) +
  headingStyle(5, 20, 140) +
  headingStyle(6, 20, 120) +
  '<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:color w:val="5F6B7A"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:before="40" w:after="160"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="5F6B7A"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListText"><w:name w:val="List Text"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:spacing w:after="40"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="D5D9E0"/><w:left w:val="single" w:sz="4" w:space="4" w:color="D5D9E0"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="4" w:color="D5D9E0"/><w:right w:val="single" w:sz="4" w:space="4" w:color="D5D9E0"/></w:pBdr>' +
  '<w:shd w:val="clear" w:color="auto" w:fill="F1F3F6"/><w:spacing w:before="60" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr>' +
  `<w:rPr><w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>` +
  '<w:style w:type="paragraph" w:styleId="Callout"><w:name w:val="Callout"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F7F8FA"/><w:spacing w:before="80" w:after="120"/><w:ind w:left="200" w:right="120"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Rule"><w:name w:val="Rule"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9CED8"/></w:pBdr><w:spacing w:after="160"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="5F6B7A"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
  '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code"/><w:basedOn w:val="DefaultParagraphFont"/>' +
  `<w:rPr><w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:cs="${MONO}"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr></w:style>` +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/>' +
  '<w:rPr><w:color w:val="0B5CC4"/><w:u w:val="single"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/>' +
  '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
  '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '<w:style w:type="table" w:styleId="ReportTable"><w:name w:val="Report Table"/><w:basedOn w:val="TableNormal"/>' +
  '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="C9CED8"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="C9CED8"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E1E4EA"/></w:tblBorders>' +
  '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '</w:styles>';

function footerXml(title: string): string {
  const field = (instr: string) =>
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  return (
    `${XML_DECL}<w:ftr xmlns:w="${NS.wordMain}" xmlns:r="${NS.officeRels}">` +
    `<w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="${TEXT_WIDTH}"/></w:tabs></w:pPr>` +
    `${run(title)}${run('\t')}${run('Page ')}${field('PAGE')}${run(' of ')}${field('NUMPAGES')}</w:p>` +
    '</w:ftr>'
  );
}

export interface DocxOptions extends WalkOptions {
  /** Export instant (DOS timestamps and document properties; tests pin it). */
  now?: Date;
}

/** `word/document.xml` and its relationships for a document (pure; exported for tests). */
export function docxParts(doc: ReportDoc, options: WalkOptions = {}): { document: string; rels: string; footer: string; title: string } {
  const writer = new DocxWriter();
  for (const node of documentNodes(doc, options)) writer.node(node);
  const title = maybeDefang(doc.title, options.defang !== false);
  const sect =
    '<w:sectPr><w:footerReference w:type="default" r:id="rId2"/>' +
    `<w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/>` +
    `<w:pgMar w:top="${PAGE.top}" w:right="${PAGE.side}" w:bottom="${PAGE.bottom}" w:left="${PAGE.side}" w:header="567" w:footer="567" w:gutter="0"/>` +
    '</w:sectPr>';
  const document =
    `${XML_DECL}<w:document xmlns:w="${NS.wordMain}" xmlns:r="${NS.officeRels}">` +
    `<w:body>${writer.body.join('')}${sect}</w:body></w:document>`;
  return { document, rels: relationshipsXml(writer.rels), footer: footerXml(title), title };
}

/** The `.docx` package bytes of a document (defanged by default). */
export function reportToDocx(doc: ReportDoc, options: DocxOptions = {}): Uint8Array {
  const at = options.now ?? new Date();
  const parts = docxParts(doc, options);
  return zipStore(
    [
      {
        name: '[Content_Types].xml',
        data: contentTypesXml([
          { part: '/word/document.xml', type: CONTENT_TYPE.wordDocument },
          { part: '/word/styles.xml', type: CONTENT_TYPE.wordStyles },
          { part: '/word/footer1.xml', type: CONTENT_TYPE.wordFooter },
          { part: '/docProps/core.xml', type: CONTENT_TYPE.core },
          { part: '/docProps/app.xml', type: CONTENT_TYPE.app },
        ]),
      },
      { name: '_rels/.rels', data: packageRelsXml('word/document.xml') },
      { name: 'docProps/core.xml', data: corePropsXml({ title: parts.title, creator: doc.author, at }) },
      { name: 'docProps/app.xml', data: appPropsXml() },
      { name: 'word/document.xml', data: parts.document },
      { name: 'word/_rels/document.xml.rels', data: parts.rels },
      { name: 'word/styles.xml', data: DOCX_STYLES_XML },
      { name: 'word/footer1.xml', data: parts.footer },
    ],
    at,
  );
}
