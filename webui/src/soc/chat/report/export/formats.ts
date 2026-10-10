/**
 * The report export formats, their menu labels and plain names (Round 12 SPEC WP-REP).
 * A dependency-free module so the Export menu and the export runner share one list
 * without the menu loading the serialisers (`run.ts` stays a lazy chunk).
 */

export type ReportExportFormat = 'print' | 'docx' | 'xlsx' | 'markdown' | 'html' | 'csv' | 'json';

/** Menu order: documents first, then data. */
export const REPORT_EXPORT_FORMATS: readonly ReportExportFormat[] = ['print', 'docx', 'xlsx', 'markdown', 'html', 'csv', 'json'];

/** The menu labels. */
export const REPORT_EXPORT_LABEL: Readonly<Record<ReportExportFormat, string>> = {
  print: 'PDF (.pdf)',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  markdown: 'Markdown (.md)',
  html: 'HTML (.html)',
  csv: 'CSV (all tables)',
  json: 'JSON',
};

/** The format's plain name in progress and result messages ("Preparing Word document…"). */
export const REPORT_EXPORT_NAME: Readonly<Record<ReportExportFormat, string>> = {
  print: 'PDF',
  docx: 'Word document',
  xlsx: 'Excel workbook',
  markdown: 'Markdown',
  html: 'HTML',
  csv: 'CSV',
  json: 'JSON',
};

/** Formats the defang toggle applies to (SPEC §9.3: never JSON; CSV and Excel are data). */
export const DEFANGED_FORMATS: readonly ReportExportFormat[] = ['print', 'docx', 'markdown', 'html'];

/** What a print opens with (the browser's dialog, where the analyst picks Save as PDF). */
export const PRINT_OPENED_MESSAGE = 'Print dialog opened. Choose Save as PDF.';

/** The print root's element id (`print.tsx` mounts it; the library's print fallback skips itself when it is present). */
export const PRINT_ROOT_ID = 'agentic-soc-report-print';
