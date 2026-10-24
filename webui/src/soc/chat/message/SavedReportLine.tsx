/**
 * The saved-report line under an answer (Round 12 SPEC D11, SYNTHESIS-chat P0-7):
 *
 *   Saved to Reports: September 2026 SOC report · Open · Export ▾
 *
 * One line says it once (Round 13, SPEC-chat T29): no toast repeats it, including after
 * "Save as report" (the line itself replaces the button and takes focus).
 *
 * The SERVER created the report from the persisted answer (never the model); the title
 * came from the model's header, so it is display-sanitised text (#9). Open goes to the
 * report in the Reports library; Export opens the report's own export menu (the same
 * guarded runner as the library: progress on the trigger, an inline failure with Retry).
 *
 * A save that could not happen (`saved_report_error`) is one quiet line with the
 * server's sentence; when the same save may work later, "Save as report" asks the server
 * to save it now (`POST /api/reports/from-answer`): the SAME report the answer asked for
 * (its title and template, read server-side), idempotent per answer (a second click or a
 * click after a reload returns the same report, never a duplicate), and recorded on the
 * stored answer, so a reopened thread shows the saved line instead of the offer. Focus
 * moves to the new line's "Open" (the activated button is replaced).
 */
import * as React from 'react';
import { toast } from 'sonner';
import { ChevronDown, FileText } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { ChatReportSaveError, ChatSavedReport } from '@/lib/types';
import { useOptionalAuth } from '@/soc/auth';
import { useAnnouncer } from '@/soc/components/announcer';
import { useNavigateOptional } from '@/soc/router';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { apiErrorCode, getReport, saveAnswerAsReport } from '../chat-api';
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
  /** Focus "Open" once mounted (the line replaced the button the analyst pressed). */
  focusOpen?: boolean;
}

export function SavedReportLine({ report, className, focusOpen = false }: SavedReportLineProps) {
  const navigate = useNavigateOptional();
  const auth = useOptionalAuth();
  const exports = useReportExport({ author: auth?.username ?? null });
  const [defang, setDefang] = useDefangPreference();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const openRef = React.useRef<HTMLButtonElement>(null);
  // Read once, on mount: a later re-render never steals focus.
  const focusOnMount = React.useRef(focusOpen);
  React.useEffect(() => {
    if (focusOnMount.current) openRef.current?.focus();
  }, []);
  const busy = exports.exporting(report.id);
  const title = report.title || 'Untitled report';
  const run = (format: ReportExportFormat, on: boolean) =>
    void exports.run(report.id, () => getReport(report.id), format, on, { title });
  const error = exports.error?.reportId === report.id ? exports.error : null;

  return (
    <div className={cn('space-y-1', className)} data-testid="saved-report-line">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <FileText className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          Saved to Reports: <span className="font-medium text-foreground">{title}</span>
        </span>
        {report.skipped ? (
          <>
            <Dot />
            <span>
              {report.skipped} {report.skipped === 1 ? 'section' : 'sections'} did not fit
            </span>
          </>
        ) : null}
        <Dot />
        <button ref={openRef} type="button" className={LINK} onClick={() => navigate('reports', { reportId: report.id })}>
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
  className?: string;
}

/** What a failed "Save as report" says, by the route's error code. */
export function saveAsReportFailure(code: string | null): string {
  switch (code) {
    case 'report_limit':
      return 'Reports is full. Delete a report in Reports, then save this answer again.';
    case 'report_empty':
      return 'This answer has nothing that can be saved to Reports.';
    case 'message_not_found':
      return 'This answer is no longer in the conversation.';
    default:
      return 'The report could not be saved. Try again.';
  }
}

/** "The report could not be saved …" and, when it may work later, "Save as report". */
export function ReportSaveErrorLine({ error, conversationId, messageId, className }: ReportSaveErrorLineProps) {
  const announce = useAnnouncer();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<ChatSavedReport | null>(null);
  const canSave = error.retryable && !!conversationId && !!messageId;

  const save = async () => {
    if (!conversationId || !messageId || saving) return;
    setSaving(true);
    try {
      // The server saves the report this answer asked for, once per answer.
      const done = await saveAnswerAsReport(conversationId, messageId);
      setSaved(done);
      // The saved line replaces the button and says it; assistive tech hears it once too.
      announce(`Saved to Reports: ${done.title || 'Untitled report'}`);
    } catch (err) {
      const message = saveAsReportFailure(apiErrorCode(err));
      announce(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (saved) return <SavedReportLine report={saved} className={className} focusOpen />;
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
