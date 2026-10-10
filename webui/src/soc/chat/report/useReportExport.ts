/**
 * One export runner for every report surface — the chat's report panel, the library's
 * document view and each library row (Round 12 SPEC WP-REP R1, R2, R3, R17).
 *
 *   - In-flight guard: one export per report at a time. A second pick while it runs is
 *     ignored (a double click used to save two identical files), and the host shows
 *     button-level progress (`exporting(id)`) with `aria-busy`.
 *   - Announced progress: "Preparing Markdown…", then "Markdown downloaded: <file>".
 *   - Visible result: a toast with the file name. For PDF the guidance ("Print dialog
 *     opened. Choose Save as PDF.") is shown just BEFORE the dialog opens: `print()`
 *     blocks until the dialog closes, so a toast after it would arrive too late (and
 *     after a Cancel). A failure stays INLINE (`error`, with `retry()`), never only in a
 *     screen-reader announcement or an unhandled rejection. An outcome a retry cannot
 *     change (no tables for CSV, no download support) is `retryable: false`: the host
 *     shows it as a neutral notice without Retry.
 *   - Retry re-runs the export that FAILED (its own report, loader, format and defang),
 *     never merely the last one started: two library rows can export at once. Every
 *     failure can be dismissed, and a report deleted anywhere in this tab (a
 *     report-changed event with `report: null`) takes its failure with it: a Retry of a
 *     deleted report could only fail again.
 *   - Resilience: the lazy export chunk is retried once when its download fails (a
 *     network blip); a stale deploy (the chunk is gone) says to reload the page. A
 *     backend that cannot be reached (`ApiError`, "Failed to fetch") is NOT a stale
 *     bundle and keeps its own message.
 *   - Warm-up (`warm`) on menu open: the export code and the report's source context
 *     start loading before the analyst picks a format, and the context is cached per
 *     report version (`cachedReportSourceContext`).
 */
import * as React from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import type { Report } from '@/lib/types';
import { useAnnouncer } from '@/soc/components/announcer';

import { onReportChanged, reportErrorMessage } from './report-sync';
import { cachedReportSourceContext } from './useSourceTurns';
import { PRINT_OPENED_MESSAGE, REPORT_EXPORT_NAME, type ReportExportFormat } from './export/formats';
import type { ExportOutcome } from './export/run';

/** The format's name in progress messages (from the shared list, never `run`). */
export const EXPORT_FORMAT_NAME = REPORT_EXPORT_NAME;

type RunModule = typeof import('./export/run');

/** The messages browsers give a dynamic `import()` that could not be fetched. */
const CHUNK_MESSAGE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/**
 * A lazy chunk that could not be fetched (network blip or a stale deploy). An API error
 * is never one, even when its message says "Failed to fetch" (the backend is unreachable).
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof ApiError || error.name === 'ApiError') return false;
  return error.name === 'ChunkLoadError' || CHUNK_MESSAGE.test(error.message);
}

export const CHUNK_ERROR_MESSAGE = 'The export could not load. Reload the page, then try again.';
/** The backend could not be reached while reading the report (a library row's export). */
export const UNREACHABLE_MESSAGE = 'The server could not be reached. Check the connection, then try again.';

/** The inline message for an export that threw. */
export function exportFailureMessage(err: unknown): string {
  if (isChunkLoadError(err)) return CHUNK_ERROR_MESSAGE;
  if (err instanceof ApiError && err.status === 0) return UNREACHABLE_MESSAGE;
  return reportErrorMessage(err, 'The report could not be exported. Try again.');
}

let runModule: Promise<RunModule> | null = null;

/** Load the export code, retrying once when the chunk download fails. */
export function loadExportModule(): Promise<RunModule> {
  if (!runModule) {
    runModule = import('./export/run').catch((first: unknown) => {
      if (!isChunkLoadError(first)) throw first;
      return import('./export/run');
    });
    // A failed load is not cached: the next click tries again.
    runModule.catch(() => {
      runModule = null;
    });
  }
  return runModule;
}

export interface ExportError {
  reportId: string;
  format: ReportExportFormat;
  message: string;
  /** False when a retry cannot change the outcome: show a neutral notice, no Retry. */
  retryable: boolean;
  /** The report's title when the host knows it (a list names the report that failed). */
  title: string | null;
}

/** What `run` needs besides the report: the host's label for messages. */
export interface ExportRunMeta {
  /** The report's title (a library row passes it; the list's error names it). */
  title?: string | null;
}

type Loader = Report | (() => Promise<Report>);

interface RunArgs {
  reportId: string;
  load: Loader;
  format: ReportExportFormat;
  defang: boolean;
  meta: ExportRunMeta;
}

export interface ReportExportController {
  /** The format being exported for `reportId`, else null. */
  exporting: (reportId: string) => ReportExportFormat | null;
  /** Any export running (the host may disable other actions). */
  busy: boolean;
  /**
   * Export `report` (or the report a loader returns — a library row reads it first).
   * Ignored while an export of the same report runs.
   */
  run: (reportId: string, load: Loader, format: ReportExportFormat, defang: boolean, meta?: ExportRunMeta) => Promise<void>;
  /** Start loading the export code and the report's context (menu open). */
  warm: (report: Report | null) => void;
  /** The last failure (inline, with Retry when `retryable`), cleared by the next export of that report. */
  error: ExportError | null;
  /** Re-run the export that failed (`error`'s own report, format and defang). */
  retry: () => void;
  dismissError: () => void;
}

export function useReportExport({ author }: { author: string | null }): ReportExportController {
  const announce = useAnnouncer();
  const [running, setRunning] = React.useState<ReadonlyMap<string, ReportExportFormat>>(new Map());
  const [error, setErrorState] = React.useState<ExportError | null>(null);
  const errorRef = React.useRef<ExportError | null>(null);
  // Synchronous guard: a second click can arrive before the busy state renders.
  const inflight = React.useRef(new Set<string>());
  // The arguments of each report's failed export: Retry re-runs exactly that one.
  const failed = React.useRef(new Map<string, RunArgs>());
  // Reports deleted while this host is mounted: a late failure of theirs is not shown.
  const gone = React.useRef(new Set<string>());
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setError = React.useCallback((next: ExportError | null) => {
    errorRef.current = next;
    if (alive.current) setErrorState(next);
  }, []);

  const setFormat = React.useCallback((reportId: string, format: ReportExportFormat | null) => {
    if (!alive.current) return;
    setRunning((prev) => {
      const next = new Map(prev);
      if (format) next.set(reportId, format);
      else next.delete(reportId);
      return next;
    });
  }, []);

  const run = React.useCallback(
    async (reportId: string, load: Loader, format: ReportExportFormat, defang: boolean, meta: ExportRunMeta = {}) => {
      if (inflight.current.has(reportId)) return;
      inflight.current.add(reportId);
      const args: RunArgs = { reportId, load, format, defang, meta };
      setFormat(reportId, format);
      // Only this report's earlier failure is cleared: another row's stays on screen.
      if (errorRef.current?.reportId === reportId) setError(null);
      failed.current.delete(reportId);
      const fail = (message: string, retryable: boolean) => {
        if (gone.current.has(reportId)) return;
        announce(message);
        failed.current.set(reportId, args);
        setError({ reportId, format, message, retryable, title: meta.title ?? null });
      };
      const name = EXPORT_FORMAT_NAME[format];
      announce(`Preparing ${name}…`);
      try {
        const [module, report] = await Promise.all([loadExportModule(), typeof load === 'function' ? load() : Promise.resolve(load)]);
        // The methodology needs the source turns' recorded steps (not for JSON).
        const sources = format === 'json' ? null : await cachedReportSourceContext(report);
        const outcome: ExportOutcome = await module.exportReport(report, format, {
          defang,
          author,
          sourceTurns: sources?.turns ?? null,
          conversationTitles: sources?.titles ?? null,
          conversationStatus: sources?.status ?? null,
          // PDF: the guidance paints before the dialog opens (print() blocks until it closes).
          onPrintOpening: (filename: string) => {
            announce(PRINT_OPENED_MESSAGE);
            toast.success(PRINT_OPENED_MESSAGE, { description: `Suggested file name: ${filename}` });
          },
        });
        if (outcome.ok) {
          if (format === 'print') {
            // Already guided before the dialog: nothing to add once it closed.
            if (!outcome.guided) {
              announce(outcome.message);
              toast.success(outcome.message, outcome.filename ? { description: `Suggested file name: ${outcome.filename}` } : undefined);
            }
          } else {
            announce(outcome.filename ? `${outcome.message}: ${outcome.filename}` : outcome.message);
            toast.success(outcome.message, outcome.filename ? { description: outcome.filename } : undefined);
          }
        } else {
          fail(outcome.message, outcome.retryable !== false);
        }
      } catch (err) {
        fail(exportFailureMessage(err), true);
      } finally {
        inflight.current.delete(reportId);
        setFormat(reportId, null);
      }
    },
    [announce, author, setError, setFormat],
  );

  const warm = React.useCallback((report: Report | null) => {
    void loadExportModule().catch(() => undefined);
    if (report) void cachedReportSourceContext(report).catch(() => undefined);
  }, []);

  const retry = React.useCallback(() => {
    const current = errorRef.current;
    const args = current ? failed.current.get(current.reportId) : undefined;
    if (!args) return;
    void run(args.reportId, args.load, args.format, args.defang, args.meta);
  }, [run]);

  const dismissError = React.useCallback(() => {
    const current = errorRef.current;
    if (current) failed.current.delete(current.reportId);
    setError(null);
  }, [setError]);

  // A deleted report's failure goes with it (its Retry would read a report that is gone).
  React.useEffect(
    () =>
      onReportChanged((detail) => {
        if (detail.report !== null || !detail.reportId) return;
        gone.current.add(detail.reportId);
        failed.current.delete(detail.reportId);
        if (errorRef.current?.reportId === detail.reportId) setError(null);
      }),
    [setError],
  );
  const exporting = React.useCallback((reportId: string) => running.get(reportId) ?? null, [running]);

  return { exporting, busy: running.size > 0, run, warm, error, retry, dismissError };
}
