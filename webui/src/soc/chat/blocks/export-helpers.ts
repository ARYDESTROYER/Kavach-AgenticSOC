/**
 * Copy / download helpers for answer blocks (BLOCKS.md amendment 9, SPEC §9.3).
 *
 * The field encoders, the defang rule and the download helper live in `lib/`
 * (`lib/csv.ts`, `lib/defang.ts`, `lib/download.ts`) since the reports package
 * consolidated the console's copies there; they are re-exported here unchanged so the
 * blocks kit and its tests keep one import site. This module keeps only the block →
 * table projection and the TSV / CSV / JSON encoders built on those primitives.
 *
 * Rules (enforced by the lib modules):
 *   - STRING cells are formula-defused (a leading `= + - @ TAB CR` gets a `'` prefix,
 *     also when only spaces precede it); TSV also defuses a leading `"`. NUMERIC cells
 *     stay numeric — a negative count is a number, not a formula.
 *   - `null` is an empty field (G3: not measured is not 0).
 *   - IOCs are defanged by default for the clipboard (`hxxp`, `[.]`, `[@]`); never in the
 *     live UI and never in JSON.
 */
import { csvField, tsvField } from '@/lib/csv';
import { defang } from '@/lib/defang';
import { formatUtc, formatValue } from './format';
import type { AnswerBlock, Cell, ChartBlock, ColumnType, TableBlock, ValueUnit } from './schema';
import { leafBlocks } from './schema';

export { csvField, defuseFormula, tsvField } from '@/lib/csv';
export { defang } from '@/lib/defang';
export { downloadText } from '@/lib/download';

/* -------------------------------------------------------------------------- */
/* Tabular projection of a block.                                              */
/* -------------------------------------------------------------------------- */
export interface TabularColumn {
  label: string;
  /** Numeric columns are written raw (never defused, never defanged). */
  numeric: boolean;
}

export interface Tabular {
  columns: TabularColumn[];
  rows: Cell[][];
}

const TEXT = (label: string): TabularColumn => ({ label, numeric: false });
const NUM = (label: string): TabularColumn => ({ label, numeric: true });

function seriesTable(block: ChartBlock): Tabular {
  const head = block.x.label ?? (block.x.kind === 'time' ? 'Time (UTC)' : 'Category');
  return {
    columns: [TEXT(head), ...block.series.map((s) => NUM(s.label))],
    rows: block.x.values.map((x, i) => [x, ...block.series.map((s) => s.values[i] ?? null)]),
  };
}

const NUMERIC_COLUMN_TYPES: readonly ColumnType[] = ['number', 'risk'];

function tableTable(block: TableBlock): Tabular {
  return {
    columns: block.columns.map((c) => ({ label: c.label, numeric: NUMERIC_COLUMN_TYPES.includes(c.type) })),
    rows: block.rows.map((row) => row.map((cell) => cell)),
  };
}

/**
 * The block's data as a plain table (the same rows as the "Show table" view), or `null`
 * for blocks that have no tabular data (prose, callouts, queries, guides, reports).
 */
export function blockTabular(block: AnswerBlock): Tabular | null {
  switch (block.type) {
    case 'chart':
      return seriesTable(block);
    case 'heatmap':
      return {
        columns: [TEXT(block.y.label ?? 'Row'), ...block.x.values.map((x) => NUM(x))],
        rows: block.y.values.map((y, r) => [y, ...block.x.values.map((_, c) => block.cells[r]?.[c] ?? null)]),
      };
    case 'table':
      return tableTable(block);
    case 'kpi_group':
      return {
        columns: [TEXT('Metric'), NUM('Value'), TEXT('Unit'), TEXT('Context')],
        rows: block.items.map((it) => [it.label, it.value, it.unit, it.context ?? null]),
      };
    case 'case_list':
      return {
        columns: [TEXT('Case'), TEXT('Title'), TEXT('Severity'), TEXT('Verdict'), TEXT('Status'), NUM('Risk'), TEXT('Created (UTC)')],
        rows: block.items.map((it) => [
          it.case_id,
          it.title,
          it.severity ?? null,
          it.verdict ?? null,
          it.status ?? null,
          it.risk ?? null,
          it.created_at ? formatUtc(it.created_at) : null,
        ]),
      };
    case 'timeline':
      return {
        columns: [TEXT('Time (UTC)'), TEXT('Event'), TEXT('Kind'), TEXT('Detail')],
        rows: block.events.map((e) => [formatUtc(e.at), e.label, e.kind ?? null, e.detail ?? null]),
      };
    case 'mitre':
      return {
        columns: [TEXT('Technique'), TEXT('Name'), TEXT('Tactic'), NUM('Count')],
        rows: block.techniques.map((t) => [t.id, t.name ?? null, t.tactic ?? null, t.count ?? null]),
      };
    case 'entity':
      return {
        columns: [TEXT('Field'), TEXT('Value')],
        rows: [
          ['Kind', block.entity.kind],
          ['Value', block.entity.value],
          ...block.facts.map((f): Cell[] => [f.label, f.value]),
          ...block.reputation.map((r): Cell[] => [
            `Reputation: ${r.provider}`,
            r.score === undefined || r.score === null ? r.verdict : `${r.verdict} (${r.score})`,
          ]),
        ],
      };
    case 'citations':
      return {
        columns: [NUM('#'), TEXT('Kind'), TEXT('Source')],
        rows: block.items.map((it) => [it.n, it.kind, it.label]),
      };
    default:
      return null;
  }
}

export interface EncodeOptions {
  /** Defang IOCs in string cells (clipboard default; never for JSON). */
  defang?: boolean;
}

function encode(tab: Tabular, field: (c: Cell) => string, sep: string, options: EncodeOptions): string {
  const fang = (cell: Cell, numeric: boolean): Cell =>
    options.defang && !numeric && typeof cell === 'string' ? defang(cell) : cell;
  const header = tab.columns.map((c) => field(fang(c.label, false))).join(sep);
  const body = tab.rows.map((row) =>
    tab.columns
      .map((col, i) => {
        const cell = row[i] ?? null;
        // A non-numeric cell in a numeric column (a legacy string) is still text and is
        // defused like any other string; a number anywhere is written raw.
        return field(fang(cell, col.numeric && typeof cell === 'number'));
      })
      .join(sep),
  );
  return [header, ...body].join(sep === '\t' ? '\n' : '\r\n');
}

/** Copy-data text (TSV, defused, defanged by default). */
export function toTSV(tab: Tabular, options: EncodeOptions = { defang: true }): string {
  return encode(tab, tsvField, '\t', options);
}

/** CSV download text (RFC-4180, defused; not defanged unless asked). */
export function toCSV(tab: Tabular, options: EncodeOptions = {}): string {
  return encode(tab, csvField, ',', options);
}

/** `{ blocks_version, block }` exactly as received (JSON is never defanged). */
export function toJSON(block: AnswerBlock): string {
  return JSON.stringify({ blocks_version: 1, block }, null, 2);
}

/** A readable one-line value for a numeric cell in a unit (table display only). */
export function displayNumber(value: number | null, unit: ValueUnit | undefined): string {
  return formatValue(value, unit ?? 'count');
}

/** Every table-like leaf (report CSV export helper for WP-K). */
export function tabularLeaves(blocks: readonly AnswerBlock[]): Array<{ block: AnswerBlock; table: Tabular }> {
  return leafBlocks(blocks).flatMap((b) => {
    const table = blockTabular(b);
    return table ? [{ block: b as AnswerBlock, table }] : [];
  });
}
