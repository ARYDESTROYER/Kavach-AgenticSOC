/**
 * Spreadsheet-safe field encoders (chat revamp SPEC §9.3, BLOCKS.md amendment 9).
 *
 * The shared home of the formula-injection defusal for the chat answer blocks and report
 * exports (the blocks kit's copy moved here). `KpiDrilldownPanel` still carries its own
 * `csvField`, and the Excel writer (`chat/report/export/xlsx.ts`) its own lead test; both
 * are to migrate here (`csvField`, `isFormulaLed`). Until they do, they defuse a narrower
 * set of leads than this module.
 * Rules:
 *
 *   - STRING cells are formula-defused: a leading `= + - @`, TAB, CR or LF, or one of
 *     the full-width `＝ ＋ － ＠`, gets a `'` prefix, also when only spaces precede it.
 *     A source-controlled rule named `=HYPERLINK("http://…","click")` must land in a
 *     spreadsheet as the rule's NAME, never as a live, attacker-authored link. The rule
 *     set is one shared fixture, `csv-formula.contract.json` (Round 14 SPEC §4.5.6), read
 *     by this module's test and by the backend audit export writer's test, so this
 *     module's CSV and clipboard encoders and the audit export defuse alike. The Excel
 *     writer and `KpiDrilldownPanel` are not covered by that fixture yet; they migrate
 *     to `isFormulaLed` and `csvField` (see above).
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

/** A formula lead after any run of ASCII spaces (the shared fixture's `leads`). */
const FORMULA_LEAD = /^ *[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/;
/** TSV also treats a leading double quote as dangerous (a paste-time text qualifier). */
const TSV_LEAD = /^"/;

/**
 * Does a STRING cell open like a formula (any lead of the shared fixture, also after
 * spaces)? The lead test for a spreadsheet writer with its own cell quoting, so it
 * defuses exactly the cells this module does (the report Excel writer is to move to it;
 * see the module note).
 */
export function isFormulaLed(text: string): boolean {
  return FORMULA_LEAD.test(text);
}

/** Neutralise a spreadsheet formula lead in a STRING cell. */
export function defuseFormula(text: string): string {
  return isFormulaLed(text) ? `'${text}` : text;
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
 * reliably), null empty. The lead is checked on the RAW text (a leading TAB/CR is itself a
 * formula lead) AND on the folded text (` \t=1` folds to `  =1`, spaces before `=`).
 */
export function tsvField(value: CsvCell): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const folded = value.replace(/[\t\r\n]+/g, ' ');
  const dangerous = TSV_LEAD.test(value) || FORMULA_LEAD.test(value) || FORMULA_LEAD.test(folded);
  return dangerous ? `'${folded}` : folded;
}

/** One RFC-4180 record (no trailing line break). */
export function csvRow(cells: readonly CsvCell[]): string {
  return cells.map(csvField).join(',');
}

/** RFC-4180 records joined with CRLF. */
export function csvDocument(rows: ReadonlyArray<readonly CsvCell[]>): string {
  return rows.map(csvRow).join('\r\n');
}
