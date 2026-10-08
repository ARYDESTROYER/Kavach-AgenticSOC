/**
 * The block walker shared by every static export (chat revamp SPEC §9.3, BLOCKS.md §7,
 * amendment 8): a report document or a conversation becomes a flat list of neutral
 * document NODES, and the Markdown and HTML serialisers each render that same list.
 * Two formats therefore cannot drift: they differ only in syntax, never in content.
 *
 * Rules the walker enforces (the serialisers only escape):
 *   - Charts and heatmaps become DATA TABLES (x × series, "—" for not measured) plus a
 *     one-line note naming the chart kind and unit: a static file has no reliable
 *     charting, and the numbers are what a reader needs.
 *   - Answer prose is carried as the sanitised Markdown AST (`parseChatMarkdown`), never
 *     as raw text, so model-written links, images or HTML can never become markup.
 *   - Untrusted values (log-, source- and model-derived labels) are flagged `code` so
 *     the serialisers render them as code spans — never as links.
 *   - With `defang` on (the default for Markdown / HTML / Print), every content string
 *     is defanged (`hxxp`, `[.]`, `[@]`). Engine metadata (dates, versions, model ids)
 *     is not content and is never rewritten.
 *   - The only external URL a document may carry is an ATT&CK technique page CONSTRUCTED
 *     from a validated technique id (BLOCKS.md `mitre`), never a URL from data.
 */
import { maybeDefang } from '@/lib/defang';

import { formatUtc, formatValue, truncationNote, unitLabel } from '../../blocks/format';
import { VIEW_LABEL, honestBlock } from '../../blocks/views';
import type { AnswerBlock, Cell, ColumnType, LeafBlock, TableBlock, ToneKey } from '../../blocks/schema';
import { AI_AUTHORED_TYPES, isDocRef, isExpiredBlock } from '../../blocks/schema';
import { parseChatMarkdown, type MdBlock } from '../../ChatMarkdown';
import { navLabel } from '@/soc/nav';
import {
  AI_SUMMARY_NOTICE,
  BLOCK_TYPE_LABEL,
  SOURCE_UNAVAILABLE,
  TEMPLATE_LABEL,
  blockTitle,
  type DocItem,
  type ReportDoc,
} from '../model';

/* -------------------------------------------------------------------------- */
/* Nodes.                                                                      */
/* -------------------------------------------------------------------------- */

/** A run of inline text. `code` = untrusted/verbatim (code span); `strong` = emphasis. */
export interface Run {
  text: string;
  code?: boolean;
  strong?: boolean;
}

export type Line = Run[];

export interface TableNode {
  k: 'table';
  head: string[];
  /** Right-aligned numeric columns. */
  numeric: boolean[];
  /** Columns whose cells are untrusted (code spans). */
  code: boolean[];
  rows: string[][];
  /** Per-cell override of `code` (a key/value table whose rows differ in trust). */
  cellCode?: boolean[][];
}

export type DocNode =
  | { k: 'heading'; level: number; text: string }
  /** A muted metadata line (engine-written). */
  | { k: 'meta'; text: string }
  | { k: 'para'; line: Line; muted?: boolean }
  /**
   * Sanitised answer prose; `base` = the level its rank-1 headings render at. `defang`
   * picks a URL node's defanged form (the text itself was defanged before parsing).
   */
  | { k: 'md'; text: string; blocks: MdBlock[]; base: number; defang: boolean }
  | TableNode
  | { k: 'list'; ordered: boolean; items: Line[] }
  | { k: 'code'; lang: string | null; text: string; caption: string | null }
  | { k: 'callout'; tone: ToneKey; label: string; text: string }
  /** ATT&CK techniques with links CONSTRUCTED from validated ids. */
  | { k: 'attack'; items: Array<{ id: string; label: string; url: string | null }> }
  | { k: 'rule' };

export interface WalkOptions {
  /** Defang IOCs in content strings (default true). */
  defang?: boolean;
  /**
   * The on-screen document view (not a file): the header shows when the report last
   * changed ("Updated") rather than an export instant, and names source conversations
   * by title without their raw ids (an export keeps the ids for traceability).
   */
  screen?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

const TECHNIQUE_RE = /^T(\d{4})(?:\.(\d{3}))?$/;

/** The ATT&CK page of a validated technique id (the only external URL a document carries). */
export function attackUrl(id: string): string | null {
  const m = TECHNIQUE_RE.exec(id);
  if (!m) return null;
  return m[2] ? `https://attack.mitre.org/techniques/T${m[1]}/${m[2]}/` : `https://attack.mitre.org/techniques/T${m[1]}/`;
}

const TONE_LABEL: Record<ToneKey, string> = {
  info: 'Note',
  success: 'Note',
  warning: 'Warning',
  critical: 'Important',
};

const NUMERIC_TYPES: readonly ColumnType[] = ['number', 'risk'];
const CODE_TYPES: readonly ColumnType[] = ['entity', 'code', 'mitre'];

class Walker {
  readonly out: DocNode[] = [];
  private readonly on: boolean;
  readonly screen: boolean;

  constructor(options: WalkOptions) {
    this.on = options.defang !== false;
    this.screen = options.screen === true;
  }

  /** Content string → defanged per the toggle. */
  f(text: string): string {
    return maybeDefang(text, this.on);
  }

  push(node: DocNode): void {
    this.out.push(node);
  }

  heading(level: number, text: string): void {
    this.push({ k: 'heading', level: Math.max(1, Math.min(6, level)), text: this.f(text) });
  }

  para(text: string, muted = false): void {
    if (text) this.push({ k: 'para', line: [{ text: this.f(text) }], muted });
  }

  table(
    head: string[],
    rows: Cell[][],
    numeric: boolean[],
    code: boolean[],
    format?: (cell: Cell, col: number) => string,
    cellCode?: boolean[][],
  ): void {
    const cellText = (cell: Cell, col: number): string => {
      if (format) return format(cell, col);
      if (cell === null) return '—';
      return typeof cell === 'number' ? formatValue(cell, 'count') : String(cell);
    };
    this.push({
      k: 'table',
      head: head.map((h) => this.f(h)),
      numeric,
      code,
      rows: rows.map((row) => head.map((_, i) => this.f(cellText(row[i] ?? null, i)))),
      ...(cellCode ? { cellCode } : {}),
    });
  }

  list(ordered: boolean, items: Line[]): void {
    if (!items.length) return;
    this.push({ k: 'list', ordered, items: items.map((line) => line.map((r) => ({ ...r, text: this.f(r.text) }))) });
  }

  md(text: string, base: number): void {
    const prose = this.f(text);
    const blocks = parseChatMarkdown(prose);
    if (blocks.length) this.push({ k: 'md', text: prose, blocks, base, defang: this.on });
  }

  /* ---------------------------------------------------------------- blocks -- */

  /** One block; `level` is the heading level of its title. */
  block(raw: AnswerBlock, level: number, titled = true): void {
    if (isExpiredBlock(raw) && raw.type === 'callout') {
      const what = raw.expired ? BLOCK_TYPE_LABEL[raw.expired.type] : 'Block';
      if (titled && raw.title) this.heading(level, raw.title);
      this.push({ k: 'callout', tone: 'info', label: 'Expired', text: `${what}: ${raw.text}` });
      return;
    }
    const block = honestBlock(raw);
    switch (block.type) {
      case 'markdown':
        this.md(block.text, level);
        return;
      case 'callout':
        this.push({ k: 'callout', tone: block.tone, label: TONE_LABEL[block.tone], text: this.f(block.text) });
        return;
      default:
        break;
    }
    if (titled) this.heading(level, blockTitle(block));
    if (block.caption) this.push({ k: 'meta', text: this.f(block.caption) });
    if (block.provenance === 'ai' && !AI_AUTHORED_TYPES.includes(block.type) && block.type !== 'guide' && block.type !== 'citations') {
      this.para('Values stated by the model, not measured.', true);
    }
    this.body(block, level);
    const notes: string[] = [];
    if (block.truncated) notes.push(truncationNote(shown(block), block.total));
    if (block.downsampled_for_storage) notes.push('Downsampled for saved history');
    if (block.as_of) notes.push(`As of ${formatUtc(block.as_of)}`);
    if (notes.length) this.push({ k: 'meta', text: notes.join(' · ') });
  }

  private body(block: AnswerBlock, level: number): void {
    switch (block.type) {
      case 'kpi_group':
        this.table(
          ['Metric', 'Value', 'Context'],
          block.items.map((it) => [
            it.label,
            `${it.bound === 'lower' && it.value !== null ? '≥ ' : ''}${formatValue(it.value, it.unit)}`,
            it.context ?? null,
          ]),
          [false, true, false],
          [false, false, false],
          (cell) => (cell === null ? '' : String(cell)),
        );
        return;
      case 'chart': {
        const head = [block.x.label ?? (block.x.kind === 'time' ? 'Time (UTC)' : 'Category'), ...block.series.map((s) => s.label)];
        const rows: Cell[][] = block.x.values.map((x, i) => [
          block.x.kind === 'time' ? formatUtc(x) : x,
          ...block.series.map((s) => s.values[i] ?? null),
        ]);
        this.table(
          head,
          rows,
          head.map((_, i) => i > 0),
          head.map((_, i) => i === 0 && block.untrusted),
          (cell, col) => (col === 0 ? (cell === null ? '—' : String(cell)) : formatValue(typeof cell === 'number' ? cell : null, block.unit)),
        );
        this.push({ k: 'meta', text: `Chart: ${VIEW_LABEL[block.kind].toLowerCase()}, unit: ${unitLabel(block.unit)}.` });
        return;
      }
      case 'heatmap': {
        const head = [block.y.label ?? 'Row', ...block.x.values];
        this.table(
          head,
          block.y.values.map((y, r) => [y, ...block.x.values.map((_, c) => block.cells[r]?.[c] ?? null)]),
          head.map((_, i) => i > 0),
          head.map((_, i) => i === 0 && block.untrusted),
          (cell, col) => (col === 0 ? String(cell ?? '—') : formatValue(typeof cell === 'number' ? cell : null, block.unit)),
        );
        this.push({ k: 'meta', text: `Heatmap, unit: ${unitLabel(block.unit)}.` });
        return;
      }
      case 'table':
        this.tableBlock(block);
        return;
      case 'case_list':
        this.table(
          ['Case', 'Title', 'Severity', 'Verdict', 'Status', 'Risk', 'Created (UTC)'],
          block.items.map((it) => [
            it.case_id,
            it.title,
            it.severity ?? null,
            it.verdict ?? null,
            it.status ?? null,
            it.risk ?? null,
            it.created_at ? formatUtc(it.created_at) : null,
          ]),
          [false, false, false, false, false, true, false],
          [true, block.untrusted, false, false, false, false, false],
          (cell, col) => (cell === null ? '—' : col === 5 && typeof cell === 'number' ? formatValue(cell, 'score') : String(cell)),
        );
        return;
      case 'timeline':
        this.list(
          false,
          block.events.map((e) => {
            const line: Line = [{ text: `${formatUtc(e.at)} — ` }, { text: e.label, code: block.untrusted }];
            if (e.kind) line.push({ text: ` (${e.kind})` });
            if (e.detail) line.push({ text: ': ' }, { text: e.detail, code: block.untrusted });
            return line;
          }),
        );
        return;
      case 'entity': {
        // Key/value rows; only the indicator and untrusted facts are code (G7).
        const rows: Cell[][] = [];
        const trust: boolean[][] = [];
        const add = (label: string, value: Cell, code = false) => {
          rows.push([label, value]);
          trust.push([false, code]);
        };
        add('Kind', block.entity.kind);
        add('Value', block.entity.value, true);
        if (block.risk !== undefined) add('Risk', block.risk === null ? null : formatValue(block.risk, 'score'));
        if (block.verdict) add('Verdict', block.verdict);
        if (block.first_seen) add('First seen', formatUtc(block.first_seen));
        if (block.last_seen) add('Last seen', formatUtc(block.last_seen));
        for (const f of block.facts) add(f.label, f.value, f.untrusted || block.untrusted);
        for (const c of block.counts) add(c.label, formatValue(c.value, c.unit));
        this.table(['Field', 'Value'], rows, [false, false], [false, false], (cell) => (cell === null ? '—' : String(cell)), trust);
        if (block.reputation.length) {
          this.table(
            ['Provider', 'Verdict', 'Score', 'Detail'],
            block.reputation.map((r) => [r.provider, r.verdict, r.score ?? null, r.detail ?? null]),
            [false, false, true, false],
            [false, false, false, true],
            (cell) => (cell === null ? '—' : String(cell)),
          );
        }
        if (block.related_cases.length) {
          this.para('Related cases:', true);
          this.list(
            false,
            block.related_cases.map((c) => [{ text: c.case_id, code: true }, { text: ' — ' }, { text: c.title, code: block.untrusted }]),
          );
        }
        return;
      }
      case 'mitre': {
        const byTactic = new Map<string, typeof block.techniques>();
        for (const t of block.techniques) {
          const key = t.tactic ?? 'Other';
          byTactic.set(key, [...(byTactic.get(key) ?? []), t]);
        }
        for (const [tactic, techniques] of byTactic) {
          this.push({ k: 'meta', text: this.f(tactic) });
          this.push({
            k: 'attack',
            items: techniques.map((t) => ({
              id: t.id,
              label: this.f(
                `${t.name ? t.name : ''}${typeof t.count === 'number' ? `${t.name ? ' ' : ''}(${formatValue(t.count, 'count')})` : ''}`,
              ),
              url: attackUrl(t.id),
            })),
          });
        }
        return;
      }
      case 'query': {
        const parts = [block.language.toUpperCase()];
        if (block.source_name) parts.push(block.source_name);
        if (typeof block.hits === 'number') parts.push(`${formatValue(block.hits, 'count')} hits`);
        this.push({ k: 'code', lang: block.language, text: this.f(block.query), caption: this.f(parts.join(' · ')) });
        return;
      }
      case 'citations':
        this.list(
          true,
          block.items.map((it) => {
            const line: Line = [{ text: it.label, code: it.kind === 'log' || it.kind === 'knowledge' }];
            line.push({ text: ` (${it.kind})` });
            if (it.ref && isDocRef(it.ref)) line.push({ text: ` — Help Center ${it.ref.doc}` });
            if (it.snippet) line.push({ text: ': ' }, { text: it.snippet, code: it.kind === 'log' || it.kind === 'knowledge' });
            return line;
          }),
        );
        return;
      case 'guide':
        this.list(true, block.steps.map((s) => [{ text: s.text }]));
        this.list(
          false,
          block.links.map((l) => [
            { text: l.label },
            { text: isDocRef(l.ref) ? ` — Help Center ${l.ref.doc}` : ` — open ${navLabel(l.ref.page)} in the console` },
          ]),
        );
        return;
      case 'report':
        if (block.subtitle) this.para(block.subtitle);
        {
          const scope: string[] = [];
          if (block.scope.window_label) scope.push(`Window: ${block.scope.window_label}`);
          if (block.scope.sources.length) scope.push(`Sources: ${block.scope.sources.join(', ')}`);
          scope.push(`Generated ${formatUtc(block.scope.generated_at)}`);
          this.push({ k: 'meta', text: this.f(scope.join(' · ')) });
        }
        for (const section of block.sections) {
          this.heading(level + 1, section.heading);
          if (section.summary) this.para(section.summary);
          for (const leaf of section.blocks) this.block(leaf as LeafBlock, level + 2);
        }
        return;
      default:
        return;
    }
  }

  private tableBlock(block: TableBlock): void {
    this.table(
      block.columns.map((c) => c.label),
      block.rows,
      block.columns.map((c) => NUMERIC_TYPES.includes(c.type)),
      block.columns.map((c) => c.untrusted || CODE_TYPES.includes(c.type)),
      (cell, col) => {
        const column = block.columns[col];
        if (cell === null || cell === undefined || cell === '') return '—';
        if (typeof cell === 'number') {
          if (column?.type === 'risk') return formatValue(cell, 'score');
          return formatValue(cell, column?.unit ?? 'count');
        }
        if (typeof cell === 'boolean') return cell ? 'true' : 'false';
        if (column?.type === 'time') return formatUtc(cell);
        return cell;
      },
    );
  }
}

function shown(block: AnswerBlock): number {
  switch (block.type) {
    case 'chart':
      return block.x.values.length;
    case 'heatmap':
      return block.y.values.length;
    case 'table':
      return block.rows.length;
    case 'case_list':
    case 'kpi_group':
      return block.items.length;
    case 'timeline':
      return block.events.length;
    case 'mitre':
      return block.techniques.length;
    case 'citations':
      return block.items.length;
    case 'report':
      return block.sections.length;
    default:
      return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Document sections.                                                          */
/* -------------------------------------------------------------------------- */

const utc = (iso: string | null | undefined): string => formatUtc(iso ?? undefined);

/** The header block: title, then engine-written metadata lines. */
export function headerNodes(doc: ReportDoc, w: Walker): void {
  w.heading(1, doc.title);
  const first: string[] = [w.screen ? `Updated ${utc(doc.updatedAt)}` : `Generated ${utc(doc.generatedAt)}`];
  if (doc.author) first.push(`Author: ${doc.author}`);
  if (doc.appVersion) first.push(`Agentic SOC ${doc.appVersion.startsWith('v') ? doc.appVersion : `v${doc.appVersion}`}`);
  if (doc.template) first.push(`Template: ${TEMPLATE_LABEL[doc.template]}`);
  w.push({ k: 'meta', text: first.join(' · ') });
  const second: string[] = [];
  if (doc.conversations.length) {
    const names = doc.conversations.map((c) => (c.title ? (w.screen ? c.title : `${c.title} (${c.id})`) : c.id));
    second.push(`${doc.conversations.length === 1 ? 'Source conversation' : 'Source conversations'}: ${names.join(', ')}`);
  }
  if (doc.windows.length) second.push(`Window: ${doc.windows.join('; ')}`);
  if (doc.sources.length) second.push(`Sources: ${doc.sources.slice(0, 12).join(', ')}`);
  if (second.length) w.push({ k: 'meta', text: w.f(second.join(' · ')) });
  if (doc.demo) w.push({ k: 'callout', tone: 'info', label: 'Demo Mode', text: 'Synthetic data; money figures are simulated.' });
}

/** The AI summary with its mandatory notice. */
export function summaryNodes(doc: ReportDoc, w: Walker): void {
  if (!doc.summary) return;
  w.heading(2, 'Summary');
  w.push({ k: 'callout', tone: 'warning', label: 'AI-written summary', text: AI_SUMMARY_NOTICE });
  if (doc.summary.stale) {
    w.push({ k: 'callout', tone: 'warning', label: 'Out of date', text: 'The report changed after this summary was written.' });
  }
  w.md(doc.summary.text, 3);
  if (doc.summary.nextSteps.length) {
    w.heading(3, 'Next steps');
    w.list(true, doc.summary.nextSteps.map((s) => [{ text: s }]));
  }
  const meta = [`Written ${utc(doc.summary.generatedAt)}`];
  if (doc.summary.model) meta.push(`by ${doc.summary.model}`);
  w.push({ k: 'meta', text: meta.join(' ') });
}

/** One item: its heading, scope line, blocks and the analyst's note. */
export function itemNodes(item: DocItem, index: number, w: Walker, level = 2, verb: 'Added' | 'Asked' = 'Added'): void {
  w.heading(level, `${index + 1}. ${item.title}`);
  const meta: string[] = [item.kind === 'section' ? 'Answer' : BLOCK_TYPE_LABEL[item.blocks[0]?.type ?? 'markdown']];
  if (item.scope.window) meta.push(`Window: ${item.scope.window}`);
  if (item.scope.sources?.length) meta.push(`Sources: ${item.scope.sources.join(', ')}`);
  if (item.addedAt) meta.push(`${verb} ${utc(item.addedAt)}`);
  w.push({ k: 'meta', text: w.f(meta.join(' · ')) });
  if (item.question) w.push({ k: 'callout', tone: 'info', label: 'Question', text: w.f(item.question) });
  // A section's own title already names it; its blocks keep their own titles.
  const titled = item.kind === 'section' || item.blocks.length !== 1;
  for (const block of item.blocks) w.block(block, level + 1, titled);
  if (item.truncated) w.push({ k: 'meta', text: 'More blocks were offered than a report section holds; the first ones are shown.' });
  if (item.note) w.push({ k: 'callout', tone: 'info', label: 'Analyst note', text: w.f(item.note) });
}

export function methodologyNodes(doc: ReportDoc, w: Walker): void {
  w.heading(2, 'Methodology & limitations');
  // Methodology lines quote recorded labels and coverage (some log-derived): content.
  w.list(false, doc.methodology.map((line) => [{ text: line }]));
}

export function appendixNodes(doc: ReportDoc, w: Walker): void {
  if (!doc.queries.length) return;
  w.heading(2, 'Appendix: queries');
  doc.queries.forEach((q, i) => {
    const caption = [`${i + 1}. ${q.label}`, `item ${q.item}`];
    if (q.sources.length) caption.push(q.sources.join(', '));
    w.push({ k: 'code', lang: q.language, text: w.f(q.text), caption: w.f(caption.join(' · ')) });
  });
}

/** The whole document as nodes (the static exports' single source). */
export function documentNodes(doc: ReportDoc, options: WalkOptions = {}): DocNode[] {
  const w = new Walker(options);
  headerNodes(doc, w);
  summaryNodes(doc, w);
  w.heading(2, doc.kind === 'conversation' ? 'Conversation' : 'Findings');
  if (!doc.items.length) w.para('This report has no items yet.', true);
  doc.items.forEach((item, i) => itemNodes(item, i, w, 3, doc.kind === 'conversation' ? 'Asked' : 'Added'));
  methodologyNodes(doc, w);
  appendixNodes(doc, w);
  w.push({ k: 'rule' });
  w.push({
    k: 'meta',
    text: `Generated by Agentic SOC · ${utc(doc.generatedAt)} · Provenance: measured values come from read-only lookups; AI-stated values are labelled.`,
  });
  return w.out;
}

/** The nodes of a few blocks (per-block exports and tests). */
export function blockNodes(blocks: readonly AnswerBlock[], options: WalkOptions = {}, level = 2): DocNode[] {
  const w = new Walker(options);
  for (const b of blocks) w.block(b, level);
  return w.out;
}

/** Sections of the document the React renderer draws from nodes (header etc.). */
export function sectionNodes(doc: ReportDoc, part: 'header' | 'summary' | 'methodology' | 'appendix', options: WalkOptions = {}): DocNode[] {
  const w = new Walker(options);
  if (part === 'header') headerNodes(doc, w);
  else if (part === 'summary') summaryNodes(doc, w);
  else if (part === 'methodology') methodologyNodes(doc, w);
  else appendixNodes(doc, w);
  return w.out;
}

export { SOURCE_UNAVAILABLE };
