/**
 * The report export dispatcher (chat revamp SPEC §9.3; Round 12 SPEC WP-REP): one entry
 * point the panel's and the library's Export menus call. Formats:
 *
 *   print · docx · markdown · html   human documents — content defanged by default;
 *   xlsx · csv                        data: every table-like block (never defanged);
 *   json                              `{ blocks_version, report }` exactly as received.
 *
 * Everything runs client-side from the report already in memory; no request is made.
 * The Word and Excel writers (and the ZIP writer under them) load on first use, so a
 * Markdown export never downloads them. The outcome carries a short message for the
 * shell announcer and a toast, plus the file name that was saved.
 */
import { CONSOLE_RELEASE_IDENTITY } from '@/lib/release';
import { EXPORT_MIME, UTF8_BOM, downloadBlob, downloadText, exportFileName, exportFileStem } from '@/lib/download';
import type { Report } from '@/lib/types';

import { buildReportDoc, type ConversationReadStatus, type ReportDoc, type SourceTurns } from '../model';
import { reportTablesCsv } from './csv';
import { reportToHtml } from './html';
import { reportToJson } from './json';
import { reportToMarkdown } from './markdown';
import { PRINT_OPENED_MESSAGE, REPORT_EXPORT_NAME, type ReportExportFormat } from './formats';

export {
  DEFANGED_FORMATS,
  PRINT_OPENED_MESSAGE,
  REPORT_EXPORT_FORMATS,
  REPORT_EXPORT_LABEL,
  REPORT_EXPORT_NAME,
  type ReportExportFormat,
} from './formats';

export interface ExportOutcome {
  ok: boolean;
  /** Plain text for the shell announcer and the toast ("Markdown downloaded"). */
  message: string;
  /** The file saved (or, for print, the name the dialog suggests). */
  filename?: string;
  /**
   * For a failure: false when trying again cannot change it (no tables for CSV, a browser
   * without downloads or printing). The host shows a neutral notice without Retry.
   */
  retryable?: boolean;
  /** For print: the guidance was already shown before the dialog opened (`onPrintOpening`). */
  guided?: boolean;
}

export interface ReportExportOptions {
  defang?: boolean;
  author?: string | null;
  sourceTurns?: SourceTurns | null;
  conversationTitles?: ReadonlyMap<string, string> | null;
  /** How reading each source conversation went (`loadReportSourceContext`). */
  conversationStatus?: ReadonlyMap<string, ConversationReadStatus> | null;
  /** Export instant (tests pin it). */
  now?: Date;
  /**
   * Print only: called just before the browser's print dialog opens, with the suggested
   * PDF file name, so the host shows its guidance while the dialog is up (R17).
   */
  onPrintOpening?: (filename: string) => void;
}

const UNAVAILABLE: ExportOutcome = { ok: false, message: 'Downloads are not available in this browser', retryable: false };
const NO_PRINT: ExportOutcome = { ok: false, message: 'Printing is not available in this browser', retryable: false };
const NO_TABLES: ExportOutcome = { ok: false, message: 'This report has no tables to export as CSV', retryable: false };

function saved(ok: boolean, name: string, filename: string): ExportOutcome {
  return ok ? { ok: true, message: `${name} downloaded`, filename } : UNAVAILABLE;
}

/** Bytes as a Blob (copied into a fresh ArrayBuffer: a view may share a larger buffer). */
function bytesBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

export type DocumentExportFormat = 'markdown' | 'html' | 'print' | 'docx';

/** Save a document in one of the human formats (shared with the conversation export). */
export async function exportDocument(
  doc: ReportDoc,
  format: DocumentExportFormat,
  options: { defang?: boolean; kind: string; now?: Date; onPrintOpening?: (filename: string) => void },
): Promise<ExportOutcome> {
  const defang = options.defang !== false;
  const now = options.now ?? new Date();
  if (format === 'print') {
    const { printDocument } = await import('./print');
    const stem = exportFileStem(options.kind, doc.title, now);
    const filename = `${stem}.pdf`;
    let guided = false;
    const opening = options.onPrintOpening;
    const printed = await printDocument(doc, {
      defang,
      documentTitle: stem,
      onBeforePrint: opening
        ? () => {
            guided = true;
            opening(filename);
          }
        : undefined,
    });
    return printed ? { ok: true, message: PRINT_OPENED_MESSAGE, filename, guided } : NO_PRINT;
  }
  if (format === 'docx') {
    const { reportToDocx } = await import('./docx');
    const filename = exportFileName(options.kind, doc.title, 'docx', now);
    return saved(downloadBlob(filename, bytesBlob(reportToDocx(doc, { defang, now }), EXPORT_MIME.docx)), REPORT_EXPORT_NAME.docx, filename);
  }
  if (format === 'markdown') {
    const filename = exportFileName(options.kind, doc.title, 'md', now);
    return saved(downloadText(filename, EXPORT_MIME.markdown, reportToMarkdown(doc, { defang })), REPORT_EXPORT_NAME.markdown, filename);
  }
  const filename = exportFileName(options.kind, doc.title, 'html', now);
  return saved(downloadText(filename, EXPORT_MIME.html, reportToHtml(doc, { defang })), REPORT_EXPORT_NAME.html, filename);
}

/** Export a report. Never throws for an unavailable download; resolves an outcome. */
export async function exportReport(
  report: Report,
  format: ReportExportFormat,
  options: ReportExportOptions = {},
): Promise<ExportOutcome> {
  const now = options.now ?? new Date();
  if (format === 'json') {
    const filename = exportFileName('report', report.title, 'json', now);
    return saved(downloadText(filename, EXPORT_MIME.json, reportToJson(report)), REPORT_EXPORT_NAME.json, filename);
  }
  const doc = buildReportDoc(report, {
    author: options.author ?? null,
    appVersion: CONSOLE_RELEASE_IDENTITY.version,
    generatedAt: now.toISOString(),
    sourceTurns: options.sourceTurns ?? null,
    conversationTitles: options.conversationTitles ?? null,
    conversationStatus: options.conversationStatus ?? null,
  });
  if (format === 'csv') {
    const csv = reportTablesCsv(doc);
    if (!csv) return NO_TABLES;
    const filename = exportFileName('report', report.title, 'csv', now);
    // The BOM makes Excel read the file as UTF-8 ("—", "≥" and names stay intact).
    return saved(downloadText(filename, EXPORT_MIME.csv, `${UTF8_BOM}${csv}`), REPORT_EXPORT_NAME.csv, filename);
  }
  if (format === 'xlsx') {
    const { reportToXlsx } = await import('./xlsx');
    const filename = exportFileName('report', report.title, 'xlsx', now);
    return saved(downloadBlob(filename, bytesBlob(reportToXlsx(doc, { now }), EXPORT_MIME.xlsx)), REPORT_EXPORT_NAME.xlsx, filename);
  }
  return exportDocument(doc, format, { defang: options.defang, kind: 'report', now, onPrintOpening: options.onPrintOpening });
}
