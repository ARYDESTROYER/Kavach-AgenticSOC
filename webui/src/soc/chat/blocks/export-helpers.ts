/**
 * Copy / download helpers for answer blocks (BLOCKS.md amendment 9, SPEC §9.3).
 *
 * TEMPORARY HOME: SPEC §9.3 puts `csvField`/`tsvField` in `lib/csv.ts`, `defang` in
 * `lib/defang.ts` and `downloadText` in `lib/download.ts` (WP-K). They live here until
 * those modules land so the two packages never edit one file at the same time; WP-K
 * should consolidate and re-point these imports (see the WP-J report).
 *
 * Rules:
 *   - STRING cells are formula-defused (a leading `= + - @ TAB CR` gets a `'` prefix,
 *     the KpiDrilldownPanel rule, also when only spaces precede it): a source-controlled
 *     rule named `=HYPERLINK(…)` must land in a spreadsheet as text, not as a live
 *     formula. TSV (the clipboard) also defuses a leading `"`: a paste target treats it
 *     as a text qualifier, strips it and would then evaluate `"=HYPERLINK(…)"` as a
 *     formula. NUMERIC cells stay numeric — a negative count is a number, not a formula,
 *     and defusing it would turn it into text.
 *   - `null` is an empty field (G3: not measured is not 0).
 *   - IOCs are defanged by default for the clipboard (`hxxp`, `[.]`, `[@]`); never in the
 *     live UI and never in JSON.
 *   - Everything is a pure string transform; nothing here touches the DOM except
 *     {@link downloadText}, which is feature-detected (jsdom has no object-URL store).
 */
import { formatUtc, formatValue } from './format';
import type { AnswerBlock, Cell, ChartBlock, ColumnType, TableBlock, ValueUnit } from './schema';
import { leafBlocks } from './schema';

/* -------------------------------------------------------------------------- */
/* Field encoders.                                                             */
/* -------------------------------------------------------------------------- */
const FORMULA_LEAD = /^(?:[=+\-@\t\r]| +[=+\-@])/;
/** TSV also treats a leading double quote as dangerous (a paste-time text qualifier). */
const TSV_LEAD = /^"/;

/** Neutralise a spreadsheet formula lead in a STRING cell. */
export function defuseFormula(text: string): string {
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/** One CSV field: numbers raw, strings defused then RFC-4180 quoted, null empty. */
export function csvField(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `"${defuseFormula(value).replace(/"/g, '""')}"`;
}

/**
 * One TSV field (Copy data → paste into a spreadsheet): numbers raw, strings defused
 * with tabs and line breaks folded to spaces (TSV has no quoting a paste target honours
 * reliably), null empty. Defusing runs on the RAW text first, so a leading TAB/CR — itself
 * a formula lead — is neutralised before it is folded into a space.
 */
export function tsvField(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const safe = TSV_LEAD.test(value) ? `'${value}` : defuseFormula(value);
  return safe.replace(/[\t\r\n]+/g, ' ');
}

/* -------------------------------------------------------------------------- */
/* Defang.                                                                     */
/* -------------------------------------------------------------------------- */
const URL_SCHEME_RE = /\b(h)(tt)(ps?)(:\/\/)/gi;
const FTP_SCHEME_RE = /\b(f)(t)(p)(:\/\/)/gi;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
// A dotted host name ending in a letter TLD (`evil.example.com`), not a version number.
const DOMAIN_RE = /\b((?:[A-Za-z0-9-]+\.)+)([A-Za-z]{2,24})\b/g;
/**
 * File extensions that are NOT top-level domains, so `svchost.exe`, `cmd.exe` and
 * `report.docx` are left readable. Extensions that ARE delegated TLDs (`.zip`, `.mov`,
 * `.sh`, `.py`) are deliberately absent: a missed defang is worse than an extra `[.]`.
 */
const NOT_A_TLD = new Set([
  'exe', 'dll', 'sys', 'drv', 'ocx', 'cpl', 'scr', 'bat', 'cmd', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'lnk',
  'msi', 'msp', 'jar', 'class', 'pyc', 'bin', 'dat', 'tmp', 'log', 'txt', 'ini', 'cfg', 'conf', 'json',
  'xml', 'yaml', 'yml', 'csv', 'tsv', 'doc', 'docx', 'docm', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pdf',
  'rtf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico', 'iso', 'img', 'vhd', 'vhdx', 'rar', 'gz',
  'tgz', 'tar', 'xz', 'evtx', 'etl', 'reg', 'inf', 'sqlite', 'db',
]);

/**
 * Is `tld` plausibly a top-level domain? Not a known non-TLD file extension, and
 * single-cased: DNS names in logs are lower (or upper) case, while `Mr.Smith` or
 * `end.Next` are prose.
 */
function plausibleTld(tld: string): boolean {
  if (NOT_A_TLD.has(tld.toLowerCase())) return false;
  return tld === tld.toLowerCase() || tld === tld.toUpperCase();
}

/**
 * Defang indicators in free text so a pasted IOC cannot be clicked or resolved:
 * `http://` → `hxxp://`, dots in IPv4 addresses and host names → `[.]`, `@` in e-mail
 * addresses → `[@]`. Idempotent (an already defanged value is left alone).
 */
export function defang(text: string): string {
  let out = text.replace(URL_SCHEME_RE, (_m, _h, _tt, p: string, sep: string) => `hxx${p}${sep}`);
  out = out.replace(FTP_SCHEME_RE, (_m, _f, _t, _p, sep: string) => `fxp${sep}`);
  out = out.replace(EMAIL_RE, (_m, user: string, host: string) => `${user}[@]${host}`);
  out = out.replace(IPV4_RE, '$1[.]$2[.]$3[.]$4');
  out = out.replace(DOMAIN_RE, (m: string, _host: string, tld: string) => (plausibleTld(tld) ? m.replace(/\./g, '[.]') : m));
  return out;
}

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

/* -------------------------------------------------------------------------- */
/* Download.                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Save `text` as a file. Feature-DETECTED, not assumed: `URL.createObjectURL` is absent
 * in some environments (jsdom), and an unguarded call there would throw out of a click
 * handler. Returns whether a download was started; the object URL is revoked at once.
 */
export function downloadText(filename: string, mime: string, text: string): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  URL.revokeObjectURL?.(url);
  return true;
}
