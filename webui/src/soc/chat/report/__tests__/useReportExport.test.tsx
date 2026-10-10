/**
 * The guarded export runner and the flat Export controls (Round 12 SPEC WP-REP R1, R2,
 * R3, R17): one export per report at a time with button-level progress, announced
 * progress and result, a toast with the file name (for PDF, BEFORE the dialog opens), an
 * inline error with Retry that re-runs the export that failed and keeps keyboard focus
 * on its control, a neutral notice without Retry for an outcome a retry cannot change,
 * a chunk-load error that says to reload (never for an unreachable backend), and a
 * warm-up on menu open that makes the second export of the same report version read no
 * conversation.
 */
import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Report } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
const api = vi.hoisted(() => ({ getConversation: vi.fn() }));
vi.mock('@/soc/chat/chat-api', () => api);
type Outcome = { ok: boolean; message: string; filename?: string; retryable?: boolean; guided?: boolean };
const exportReport = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Outcome>>());
vi.mock('@/soc/chat/report/export/run', () => ({ exportReport }));

import { DownloadPdfButton, ExportErrorNote, ExportMenu } from '../ExportMenu';
import { CHUNK_ERROR_MESSAGE, UNREACHABLE_MESSAGE, exportFailureMessage, isChunkLoadError, useReportExport } from '../useReportExport';
import { clearSourceTurnCache } from '../useSourceTurns';
import { REPORT_EXPORT_FORMATS, REPORT_EXPORT_LABEL } from '../export/formats';
import { sampleConversation, sampleReport } from './fixtures';

/** One or more reports, each with its PDF button and Export menu, and ONE error note (a list). */
function Harness({ report, reports, loaders }: { report?: Report; reports?: Report[]; loaders?: Record<string, () => Promise<Report>> }) {
  const all = reports ?? [report!];
  const exports = useReportExport({ author: 'ana' });
  const triggers = React.useRef(new Map<string, HTMLButtonElement>());
  const pdfs = React.useRef(new Map<string, HTMLButtonElement>());
  const keep = (map: Map<string, HTMLButtonElement>, id: string) => (el: HTMLButtonElement | null) => {
    if (el) map.set(id, el);
    else map.delete(id);
  };
  return (
    <TooltipProvider>
      {all.map((r) => {
        const busy = exports.exporting(r.id);
        const load = loaders?.[r.id] ?? r;
        const suffix = all.length > 1 ? `-${r.id}` : '';
        return (
          <div key={r.id}>
            <DownloadPdfButton buttonRef={keep(pdfs.current, r.id)} busy={busy} onClick={() => void exports.run(r.id, load, 'print', true, { title: r.title })} />
            <ExportMenu
              triggerRef={keep(triggers.current, r.id)}
              busy={busy}
              onOpen={() => exports.warm(r)}
              onExport={(f, d) => void exports.run(r.id, load, f, d, { title: r.title })}
              defang
              onDefangChange={() => undefined}
              testId={`export-trigger${suffix}`}
            />
          </div>
        );
      })}
      {exports.error ? (
        <ExportErrorNote
          error={exports.error}
          onRetry={exports.retry}
          onDismiss={exports.dismissError}
          showTitle={all.length > 1}
          returnFocus={() => {
            const e = exports.error;
            if (!e) return null;
            return (e.format === 'print' ? pdfs : triggers).current.get(e.reportId);
          }}
        />
      ) : null}
    </TooltipProvider>
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  exportReport.mockReset();
  announce.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  api.getConversation.mockReset();
  api.getConversation.mockResolvedValue(sampleConversation());
  clearSourceTurnCache();
});
afterEach(() => vi.useRealTimers());

describe('Export menu', () => {
  it('is one flat menu: every format, then the defang toggle, no sub-menu', async () => {
    const user = userEvent.setup();
    render(<Harness report={sampleReport()} />);
    await user.click(screen.getByTestId('export-trigger'));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(REPORT_EXPORT_FORMATS.map((f) => REPORT_EXPORT_LABEL[f]));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Defang indicators (PDF, Word, Markdown, HTML)' })).toBeInTheDocument();
    expect(document.querySelector('[data-radix-menu-content] [aria-haspopup="menu"]')).toBeNull();
  });
});

describe('useReportExport', () => {
  it('runs one export per report: a second pick while it runs is ignored (R1)', async () => {
    const user = userEvent.setup();
    const gate = deferred<Outcome>();
    exportReport.mockReturnValue(gate.promise);
    render(<Harness report={sampleReport()} />);
    await user.click(screen.getByTestId('export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    // Button-level progress while it runs.
    await waitFor(() => expect(screen.getByTestId('export-trigger')).toHaveAttribute('aria-busy', 'true'));
    // The name stays stable; the spinner, aria-busy and the title carry the progress.
    expect(screen.getByTestId('export-trigger')).toHaveAccessibleName('Export');
    expect(screen.getByTestId('export-trigger')).toHaveAttribute('title', 'Preparing Markdown…');
    expect(screen.getByTestId('export-trigger')).toHaveAttribute('aria-disabled', 'true');
    expect(announce).toHaveBeenCalledWith('Preparing Markdown…');
    // The menu refuses to reopen and the PDF button is inert while it runs.
    await user.click(screen.getByTestId('export-trigger'));
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(screen.getByTestId('report-download-pdf'));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    await act(async () => {
      gate.resolve({ ok: true, message: 'Markdown downloaded', filename: 'agentic-soc-report-x.md' });
      await gate.promise;
    });
    await waitFor(() => expect(screen.getByTestId('export-trigger')).not.toHaveAttribute('aria-busy'));
    expect(exportReport).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Markdown downloaded: agentic-soc-report-x.md');
    // A visible result with the file name (R17).
    expect(toast.success).toHaveBeenCalledWith('Markdown downloaded', { description: 'agentic-soc-report-x.md' });
  });

  it('says how to save the PDF BEFORE the print dialog opens, and nothing after it closed (R17)', async () => {
    const user = userEvent.setup();
    const dialog = deferred<void>();
    let toastsWhenDialogOpened = -1;
    // The real runner calls onPrintOpening, then window.print(), which blocks until the
    // dialog closes; the outcome resolves only after that.
    exportReport.mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as { onPrintOpening: (filename: string) => void };
      options.onPrintOpening('agentic-soc-report-x.pdf');
      toastsWhenDialogOpened = toast.success.mock.calls.length;
      await dialog.promise;
      return { ok: true, message: 'Print dialog opened. Choose Save as PDF.', filename: 'agentic-soc-report-x.pdf', guided: true };
    });
    render(<Harness report={sampleReport()} />);
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'rep-1' }), 'print', expect.objectContaining({ defang: true })));
    // The guidance was on screen when the dialog opened.
    expect(toastsWhenDialogOpened).toBe(1);
    expect(toast.success).toHaveBeenCalledWith('Print dialog opened. Choose Save as PDF.', { description: 'Suggested file name: agentic-soc-report-x.pdf' });
    expect(announce).toHaveBeenCalledWith('Print dialog opened. Choose Save as PDF.');
    // The dialog closes (saved or cancelled): no second, stale message.
    await act(async () => {
      dialog.resolve();
      await dialog.promise;
    });
    await waitFor(() => expect(screen.getByTestId('report-download-pdf')).not.toHaveAttribute('aria-busy'));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('shows a failure inline with Retry instead of failing silently (R2)', async () => {
    const user = userEvent.setup();
    exportReport.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true, message: 'HTML downloaded', filename: 'r.html' });
    render(<Harness report={sampleReport()} />);
    await user.click(screen.getByTestId('export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'HTML (.html)' }));
    expect(await screen.findByTestId('report-export-error')).toHaveTextContent('The report could not be exported. Try again.');
    expect(announce).toHaveBeenCalledWith('The report could not be exported. Try again.');
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(2));
    expect(exportReport.mock.calls[1][1]).toBe('html');
    await waitFor(() => expect(screen.queryByTestId('report-export-error')).toBeNull());
    // Keyboard focus is back on the control that started the export, not on <body>.
    expect(document.activeElement).toBe(screen.getByTestId('export-trigger'));
  });

  it('retries the export that failed, not the last one started (two rows at once)', async () => {
    const user = userEvent.setup();
    const a = sampleReport({ id: 'rep-A', title: 'Network weekly' });
    const b = sampleReport({ id: 'rep-B', title: 'Second report' });
    const slowA = deferred<Report>();
    const loadA = vi.fn<() => Promise<Report>>().mockReturnValueOnce(slowA.promise).mockResolvedValue(a);
    exportReport.mockImplementation(async (...args: unknown[]) => {
      const r = args[0] as Report;
      return { ok: true, message: 'Downloaded', filename: `${r.id}.${String(args[1])}` };
    });
    render(<Harness reports={[a, b]} loaders={{ 'rep-A': loadA }} />);
    await user.click(screen.getByTestId('export-trigger-rep-A'));
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    await user.click(screen.getByTestId('export-trigger-rep-B'));
    await user.click(await screen.findByRole('menuitem', { name: 'HTML (.html)' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'rep-B' }), 'html', expect.anything()));
    await act(async () => {
      slowA.reject(new ApiError(503, 'Service unavailable'));
      await slowA.promise.catch(() => undefined);
    });
    const note = await screen.findByTestId('report-export-error');
    // The list names the report that failed.
    expect(note).toHaveTextContent('Network weekly: The report could not be exported. Try again.');
    exportReport.mockClear();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'rep-A' }), 'markdown', expect.objectContaining({ defang: true }));
    await waitFor(() => expect(screen.queryByTestId('report-export-error')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('export-trigger-rep-A'));
  });

  it('keeps another row\'s failure on screen when a different report starts exporting', async () => {
    const user = userEvent.setup();
    const a = sampleReport({ id: 'rep-A', title: 'Network weekly' });
    const b = sampleReport({ id: 'rep-B', title: 'Second report' });
    exportReport.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ok: true, message: 'HTML downloaded', filename: 'b.html' });
    render(<Harness reports={[a, b]} />);
    await user.click(screen.getByTestId('export-trigger-rep-A'));
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    expect(await screen.findByTestId('report-export-error')).toHaveTextContent('Network weekly');
    await user.click(screen.getByTestId('export-trigger-rep-B'));
    await user.click(await screen.findByRole('menuitem', { name: 'HTML (.html)' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('HTML downloaded', { description: 'b.html' }));
    expect(screen.getByTestId('report-export-error')).toHaveTextContent('Network weekly');
  });

  it('says to reload when the export code cannot load (a stale deploy)', async () => {
    const user = userEvent.setup();
    exportReport.mockRejectedValue(new TypeError('Failed to fetch dynamically imported module: /assets/run-abc.js'));
    render(<Harness report={sampleReport()} />);
    await user.click(screen.getByTestId('export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'Word (.docx)' }));
    expect(await screen.findByTestId('report-export-error')).toHaveTextContent(CHUNK_ERROR_MESSAGE);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });

  it('never calls an unreachable backend a stale bundle', async () => {
    const user = userEvent.setup();
    const unreachable = new ApiError(0, 'Cannot reach backend: Failed to fetch');
    expect(isChunkLoadError(unreachable)).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(exportFailureMessage(unreachable)).toBe(UNREACHABLE_MESSAGE);
    expect(exportFailureMessage(new ApiError(503, 'Service unavailable'))).toBe('The report could not be exported. Try again.');
    const report = sampleReport();
    render(<Harness report={report} loaders={{ [report.id]: () => Promise.reject(unreachable) }} />);
    await user.click(screen.getByTestId('export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'HTML (.html)' }));
    const note = await screen.findByTestId('report-export-error');
    expect(note).toHaveTextContent(UNREACHABLE_MESSAGE);
    expect(note).not.toHaveTextContent('Reload the page');
    // A transient failure: Retry is offered.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows an outcome a retry cannot change as a neutral notice, without Retry', async () => {
    const user = userEvent.setup();
    exportReport.mockResolvedValue({ ok: false, message: 'This report has no tables to export as CSV', retryable: false });
    render(<Harness report={sampleReport()} />);
    await user.click(screen.getByTestId('export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'CSV (all tables)' }));
    const note = await screen.findByTestId('report-export-error');
    expect(note).toHaveTextContent('This report has no tables to export as CSV');
    expect(note).toHaveAttribute('data-retryable', 'false');
    expect(note.querySelector('.text-critical-text')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('report-export-error')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('export-trigger'));
  });

  it('reports an unavailable download as a neutral notice (outcome not ok, not retryable)', async () => {
    const user = userEvent.setup();
    exportReport.mockResolvedValue({ ok: false, message: 'Downloads are not available in this browser', retryable: false });
    render(<Harness report={sampleReport()} />);
    await user.click(screen.getByTestId('export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    expect(await screen.findByTestId('report-export-error')).toHaveTextContent('Downloads are not available in this browser');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('warms the sources on menu open; a second export of the same version reads nothing (R3)', async () => {
    const user = userEvent.setup();
    exportReport.mockResolvedValue({ ok: true, message: 'Markdown downloaded', filename: 'r.md' });
    render(<Harness report={sampleReport()} />);
    expect(api.getConversation).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('export-trigger'));
    // Opening the menu starts the reads before a format is picked.
    await waitFor(() => expect(api.getConversation).toHaveBeenCalled());
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    const reads = api.getConversation.mock.calls.length;
    const options = exportReport.mock.calls[0][2] as { sourceTurns: Map<string, unknown>; conversationStatus: Map<string, string> };
    expect(options.sourceTurns.has('msg-2')).toBe(true);
    await waitFor(() => expect(screen.getByTestId('export-trigger')).not.toHaveAttribute('aria-busy'));
    // The conversation cache expires after a minute; the per-version cache does not.
    clearSourceTurnCacheConversationsOnly();
    await user.click(screen.getByTestId('export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'HTML (.html)' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(2));
    expect(api.getConversation.mock.calls.length).toBe(reads);
  });

  it('never reads sources for JSON', async () => {
    const user = userEvent.setup();
    exportReport.mockResolvedValue({ ok: true, message: 'JSON downloaded', filename: 'r.json' });
    render(<Harness report={sampleReport({ id: 'rep-json' })} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    api.getConversation.mockClear();
    await user.click(await screen.findByRole('menuitem', { name: 'JSON' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    expect((exportReport.mock.calls[0][2] as { sourceTurns: unknown }).sourceTurns).toBeNull();
  });
});

/** Drop only the per-conversation cache (simulates its 60 s expiry). */
function clearSourceTurnCacheConversationsOnly() {
  for (const id of ['conv-1', 'conv-gone']) clearSourceTurnCache(id);
}
