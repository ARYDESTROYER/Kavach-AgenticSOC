/**
 * The saved-report line under an answer (Round 12 SPEC D11, SYNTHESIS-chat P0-7):
 *
 *   Saved to Reports · September 2026 SOC report · Open · Export ▾
 *
 * The SERVER created the report from the persisted answer (never the model); the title
 * came from the model's header, so it is display-sanitised text (#9). Open goes to the
 * report in the Reports library; Export opens the report's own export menu (the same
 * guarded runner as the library: progress on the trigger, an inline failure with Retry).
 *
 * A save that could not happen (`saved_report_error`) is one quiet line with the
 * server's sentence; when the same save may work later, "Save as report" creates the
 * report from the answer explicitly (a new report holding the whole answer).
 */
import * as React from 'react';
import { toast } from 'sonner';
import { ChevronDown, FileText } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { ChatReportSaveError, ChatSavedReport } from '@/lib/types';
import { useAuth } from '@/soc/auth';
import { useAnnouncer } from '@/soc/components/announcer';
import { useNavigateOptional } from '@/soc/router';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { addToReport, createReport, getReport } from '../chat-api';
import { ExportErrorNote, ExportMenuItems, useDefangPreference } from '../report/ExportMenu';
import { useReportExport } from '../report/useReportExport';
import type { ReportExportFormat } from '../report/export/formats';

const LINK = cn('rounded-sm font-medium text-primary underline-offset-2 hover:underline', focusRing);

function Dot() {
  return (
    <span className="text-muted-foreground/60" aria-hidden>
      ·
    </span>
  );
}

export interface SavedReportLineProps {
  report: ChatSavedReport;
  className?: string;
}

export function SavedReportLine({ report, className }: SavedReportLineProps) {
  const navigate = useNavigateOptional();
  const { username } = useAuth();
  const exports = useReportExport({ author: username });
  const [defang, setDefang] = useDefangPreference();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const busy = exports.exporting(report.id);
  const title = report.title || 'Untitled report';
  const run = (format: ReportExportFormat, on: boolean) =>
    void exports.run(report.id, () => getReport(report.id), format, on, { title });
  const error = exports.error?.reportId === report.id ? exports.error : null;

  return (
    <div className={cn('space-y-1', className)} data-testid="saved-report-line">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <FileText className="size-3.5 shrink-0" aria-hidden />
        <span>Saved to Reports</span>
        <Dot />
        <span className="min-w-0 break-words font-medium text-foreground">{title}</span>
        {report.skipped ? (
          <>
            <Dot />
            <span>
              {report.skipped} {report.skipped === 1 ? 'section' : 'sections'} did not fit
            </span>
          </>
        ) : null}
        <Dot />
        <button type="button" className={LINK} onClick={() => navigate('reports', { reportId: report.id })}>
          Open<span className="sr-only"> {title} in Reports</span>
        </button>
        <Dot />
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) exports.warm(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              className={cn(LINK, 'inline-flex items-center gap-0.5', busy && 'cursor-progress')}
              aria-busy={busy ? true : undefined}
              data-testid="saved-report-export"
            >
              Export<span className="sr-only"> {title}</span>
              <ChevronDown className="size-3" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <ExportMenuItems
              onExport={run}
              defang={defang}
              onDefangChange={setDefang}
              busy={busy}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </p>
      {error ? (
        <ExportErrorNote
          error={error}
          onRetry={exports.retry}
          onDismiss={exports.dismissError}
          returnFocus={() => triggerRef.current}
        />
      ) : null}
    </div>
  );
}

export interface ReportSaveErrorLineProps {
  error: ChatReportSaveError;
  conversationId: string | null;
  messageId: string | null;
  /** The answer's question, for the new report's title. */
  title?: string | null;
  className?: string;
}

/** "The report could not be saved …" and, when it may work later, "Save as report". */
export function ReportSaveErrorLine({ error, conversationId, messageId, title, className }: ReportSaveErrorLineProps) {
  const announce = useAnnouncer();
  const navigate = useNavigateOptional();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<{ id: string; title: string } | null>(null);
  const canSave = error.retryable && !!conversationId && !!messageId;

  const save = async () => {
    if (!conversationId || !messageId || saving) return;
    setSaving(true);
    try {
      const created = await createReport({ title: (title ?? '').trim().slice(0, 120) || 'Chat answer' });
      const added = await addToReport({ conversationId, messageId, reportId: created.id });
      const done = { id: added.report.id, title: added.report.title || created.title };
      setSaved(done);
      announce(`Saved to Reports: ${done.title}`);
      toast.success('Saved to Reports', { action: { label: 'Open', onClick: () => navigate('reports', { reportId: done.id }) } });
    } catch {
      announce('The report could not be saved. Try again.');
      toast.error('The report could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (saved) return <SavedReportLine report={{ id: saved.id, title: saved.title, items: 1, skipped: 0 }} className={className} />;
  return (
    <p
      className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground', className)}
      data-testid="report-save-error"
    >
      <FileText className="size-3.5 shrink-0" aria-hidden />
      <span>{error.message || 'The report could not be saved.'}</span>
      {canSave ? (
        <>
          <Dot />
          <button type="button" className={LINK} disabled={saving} aria-busy={saving || undefined} onClick={() => void save()}>
            Save as report
          </button>
        </>
      ) : null}
    </p>
  );
}
