/**
 * Spreadsheet-safe field encoders (chat revamp SPEC §9.3, BLOCKS.md amendment 9).
 *
 * The ONE home of the formula-injection defusal the console's exports share (it used to
 * live in `KpiDrilldownPanel` and the answer-blocks kit). Rules:
 *
 *   - STRING cells are formula-defused: a leading `= + - @ TAB CR` gets a `'` prefix,
 *     also when only spaces precede it. A source-controlled rule named
 *     `=HYPERLINK("http://…","click")` must land in a spreadsheet as the rule's NAME,
 *     never as a live, attacker-authored link.
 *   - NUMERIC cells stay numeric: a negative count is a number, not a formula, and
 *     defusing it would turn it into text that no longer sums.
 *   - `null` is an empty field (not measured is never 0).
 *   - TSV (the clipboard) also defuses a leading `"`: a paste target treats it as a text
 *     qualifier, strips it, and would then evaluate `"=HYPERLINK(…)"` as a formula.
 *
 * Pure string transforms; no DOM.
 */

/** One spreadsheet cell as the console's tabular exports carry it. */
export type CsvCell = string | number | boolean | null;

const FORMULA_LEAD = /^(?:[=+\-@\t\r]| +[=+\-@])/;
/** TSV also treats a leading double quote as dangerous (a paste-time text qualifier). */
const TSV_LEAD = /^"/;

/** Neutralise a spreadsheet formula lead in a STRING cell. */
export function defuseFormula(text: string): string {
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/** One CSV field: numbers raw, strings defused then RFC-4180 quoted, null empty. */
export function csvField(value: CsvCell): string {
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
export function tsvField(value: CsvCell): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const safe = TSV_LEAD.test(value) ? `'${value}` : defuseFormula(value);
  return safe.replace(/[\t\r\n]+/g, ' ');
}

/** One RFC-4180 record (no trailing line break). */
export function csvRow(cells: readonly CsvCell[]): string {
  return cells.map(csvField).join(',');
}

/** RFC-4180 records joined with CRLF. */
export function csvDocument(rows: ReadonlyArray<readonly CsvCell[]>): string {
  return rows.map(csvRow).join('\r\n');
}
