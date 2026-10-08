/**
 * The report export dispatcher (chat revamp SPEC §9.3): one entry point the panel's and
 * the library's Export menus call. Formats:
 *
 *   markdown · html · print   human documents — content defanged by default;
 *   csv                       every table-like block, labelled (never defanged);
 *   json                      `{ blocks_version, report }` exactly as received (never defanged).
 *
 * Everything runs client-side from the report already in memory; no request is made.
 * The outcome carries a short message for the shell announcer ("Markdown downloaded").
 */
import { CONSOLE_RELEASE_IDENTITY } from '@/lib/release';
import { EXPORT_MIME, downloadText, exportFileName } from '@/lib/download';
import type { Report } from '@/lib/types';

import { buildReportDoc, type ReportDoc, type SourceTurns } from '../model';
import { reportTablesCsv } from './csv';
import { reportToHtml } from './html';
import { reportToJson } from './json';
import { reportToMarkdown } from './markdown';

export type ReportExportFormat = 'markdown' | 'html' | 'print' | 'csv' | 'json';

export const REPORT_EXPORT_LABEL: Readonly<Record<ReportExportFormat, string>> = {
  markdown: 'Markdown (.md)',
  html: 'HTML (.html)',
  print: 'Print / Save as PDF',
  csv: 'CSV (all tables)',
  json: 'JSON',
};

/** Formats the defang toggle applies to (SPEC §9.3: off for JSON; CSV is a data format). */
export const DEFANGED_FORMATS: readonly ReportExportFormat[] = ['markdown', 'html', 'print'];

export interface ExportOutcome {
  ok: boolean;
  /** Plain text for the shell announcer. */
  message: string;
}

export interface ReportExportOptions {
  defang?: boolean;
  author?: string | null;
  sourceTurns?: SourceTurns | null;
  conversationTitles?: ReadonlyMap<string, string> | null;
  /** Export instant (tests pin it). */
  now?: Date;
}

const UNAVAILABLE: ExportOutcome = { ok: false, message: 'Downloads are not available in this browser' };

/** Save a document in one of the human formats (shared with the conversation export). */
export async function exportDocument(
  doc: ReportDoc,
  format: 'markdown' | 'html' | 'print',
  options: { defang?: boolean; kind: string; now?: Date },
): Promise<ExportOutcome> {
  const defang = options.defang !== false;
  const now = options.now ?? new Date();
  if (format === 'print') {
    const { printDocument } = await import('./print');
    return (await printDocument(doc, { defang }))
      ? { ok: true, message: 'Print dialog opened' }
      : { ok: false, message: 'Printing is not available in this browser' };
  }
  if (format === 'markdown') {
    return downloadText(exportFileName(options.kind, doc.title, 'md', now), EXPORT_MIME.markdown, reportToMarkdown(doc, { defang }))
      ? { ok: true, message: 'Markdown downloaded' }
      : UNAVAILABLE;
  }
  return downloadText(exportFileName(options.kind, doc.title, 'html', now), EXPORT_MIME.html, reportToHtml(doc, { defang }))
    ? { ok: true, message: 'HTML downloaded' }
    : UNAVAILABLE;
}

/** Export a report. Never throws for an unavailable download; resolves an outcome. */
export async function exportReport(
  report: Report,
  format: ReportExportFormat,
  options: ReportExportOptions = {},
): Promise<ExportOutcome> {
  const now = options.now ?? new Date();
  if (format === 'json') {
    return downloadText(exportFileName('report', report.title, 'json', now), EXPORT_MIME.json, reportToJson(report))
      ? { ok: true, message: 'JSON downloaded' }
      : UNAVAILABLE;
  }
  const doc = buildReportDoc(report, {
    author: options.author ?? null,
    appVersion: CONSOLE_RELEASE_IDENTITY.version,
    generatedAt: now.toISOString(),
    sourceTurns: options.sourceTurns ?? null,
    conversationTitles: options.conversationTitles ?? null,
  });
  if (format === 'csv') {
    const csv = reportTablesCsv(doc);
    if (!csv) return { ok: false, message: 'This report has no tables to export as CSV' };
    return downloadText(exportFileName('report', report.title, 'csv', now), EXPORT_MIME.csv, csv)
      ? { ok: true, message: 'CSV downloaded' }
      : UNAVAILABLE;
  }
  return exportDocument(doc, format, { defang: options.defang, kind: 'report', now });
}
