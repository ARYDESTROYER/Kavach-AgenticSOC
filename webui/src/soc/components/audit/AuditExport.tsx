/**
 * The audit log's Export menu and export dialog (Round 14 SPEC §4.5.6).
 *
 * The export is exactly what the page shows: its scope, filters, search and time range.
 * When the dialog opens it resolves the range to absolute UTC instants once; the count,
 * the range it shows, the file name and the job all use those instants. One file holds
 * at most 100,000 events (D7): over that the count reads "More than 100,000 events", the
 * Export button is disabled, and the dialog offers "Use last 30 days" only when that
 * range fits. Nothing is ever cut off silently.
 *
 * Submitting creates the `audit_export` job (`audit:export`, a fresh sign-in, D6). Small
 * exports (5,000 events or fewer) are waited for here and downloaded automatically;
 * larger ones finish in the background with the usual Inbox notice and Jobs entry. While
 * a small export is waited for, "Continue in the background" (or Esc) closes the dialog
 * and leaves the job to finish in Jobs; once the job is accepted, a failed status check
 * or download never reads as "the export did not run". The request, the finished file and
 * each download are recorded in the audit log. Exports always read oldest first,
 * whatever order the list shows.
 *
 * Focus: the dialog opens from a menu item, so the menu does not take focus back to its
 * trigger; the dialog focuses itself, then the chosen format once the count is in, and
 * on closing hands focus to the Export button (SPEC §3.3).
 */
import * as React from 'react';
import { ChevronDown, Download, ExternalLink, FileJson, FileSpreadsheet, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError, api } from '@/lib/api';
import { AUDIT_COUNT_CAP, countAudit, submitAuditExport } from '@/lib/api-audit';
import { errorMessage } from '@/lib/errorMessage';
import type { BackgroundJob } from '@/lib/types';
import type { AuditCount, AuditExportJobParams } from '@/lib/types-audit';
import { Callout, LoadingState } from '@/design-system';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import {
  announceJobAccepted,
  isTerminalJobStatus,
  releaseJobToast,
  retainJobSubmissionIntent,
  saveBlob,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';

import {
  EXPORT_ROW_CAP,
  SCOPE_LABEL,
  SMALL_EXPORT_ROWS,
  absoluteRange,
  apiFilters,
  exportFileName,
  formatMinute,
  type AbsoluteRange,
  type AuditExportFileFormat,
  type AuditLocalFilters,
  type AuditView,
} from './audit-model';

/* -------------------------------------------------------------------- the menu -- */

export interface AuditExportMenuProps {
  /** Why the export items are unavailable (an empty view, Demo Mode), or null. */
  disabledReason: string | null;
  /** Show "Full application export" (the person holds `data_export:export`). */
  showFullExport: boolean;
  onPick: (format: AuditExportFileFormat) => void;
  onOpenFullExport: () => void;
}

/**
 * The header's Export menu (hidden by the page without `audit:export`). The ref is the
 * Export button: the dialog hands focus back to it when it closes.
 */
export const AuditExportMenu = React.forwardRef<HTMLButtonElement, AuditExportMenuProps>(function AuditExportMenu(
  { disabledReason, showFullExport, onPick, onOpenFullExport },
  ref,
) {
  const disabled = disabledReason !== null;
  // A pick opens the dialog: the closing menu must not pull focus back to its trigger,
  // behind the dialog's overlay.
  const opening = React.useRef(false);
  const pick = (format: AuditExportFileFormat) => {
    opening.current = true;
    onPick(format);
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={ref} variant="outline" size="sm" className="gap-1.5">
          <Download className="size-4" aria-hidden />
          Export
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        onCloseAutoFocus={(event) => {
          if (opening.current) {
            event.preventDefault();
            opening.current = false;
          }
        }}
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {disabledReason ?? 'Exports what this page shows: scope, filters, search and time range.'}
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={disabled} onSelect={() => pick('csv')} className="items-start gap-2 py-2">
          <FileSpreadsheet className="mt-0.5 size-4" aria-hidden />
          <span className="flex flex-col">
            <span>Export CSV (spreadsheet)</span>
            <span className="text-xs text-muted-foreground">Every field in a fixed set of columns</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={() => pick('jsonl')} className="items-start gap-2 py-2">
          <FileJson className="mt-0.5 size-4" aria-hidden />
          <span className="flex flex-col">
            <span>Export JSON Lines (for a SIEM)</span>
            <span className="text-xs text-muted-foreground">Each stored record unchanged, one per line</span>
          </span>
        </DropdownMenuItem>
        {showFullExport ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenFullExport} className="gap-2">
              <ExternalLink className="size-4" aria-hidden />
              Full application export
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/* ------------------------------------------------------------------ the dialog -- */

/** How often a small export is checked while the dialog waits for it. */
const POLL_MS = 1000;
/** A small export that takes longer than this finishes in the background instead. */
const WAIT_LIMIT_MS = 120_000;

type CountState =
  | { phase: 'counting' }
  | { phase: 'error'; error: unknown }
  | { phase: 'ready'; count: AuditCount; narrowTo: { range: AbsoluteRange; count: number } | null; narrowChecked: boolean };

export interface AuditExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  format: AuditExportFileFormat;
  onFormatChange: (format: AuditExportFileFormat) => void;
  view: AuditView;
  local: AuditLocalFilters;
  /** The page's filter chips, in words ("Event: Signed in"), for the summary. */
  filterWords: readonly string[];
  /** Open the Jobs page (the large-export notice's action). */
  onOpenJobs: () => void;
  /** Where focus goes when the dialog closes (the Export button). */
  returnFocusRef?: React.RefObject<HTMLElement>;
}

/** The job was accepted, then a status check or the download failed: the file is in Jobs. */
class AfterAcceptance extends Error {
  constructor(
    message: string,
    readonly finished: boolean,
  ) {
    super(message);
  }
}

const fmt = (n: number) => n.toLocaleString();

function exceedsCap(count: AuditCount): boolean {
  return count.relation === 'gte' || count.count > EXPORT_ROW_CAP;
}

function exportErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { detail?: { code?: string } } | undefined;
    const code = body?.detail?.code;
    if (code === 'job_busy') return 'You already have an audit export running. Wait for it to finish, then try again.';
    if (code === 'reauth_required') return 'Sign in again to export the audit log.';
  }
  return errorMessage(error, 'The export could not be started.');
}

/** The file name with a line-break chance after each underscore. */
function FileName({ name }: { name: string }) {
  const parts = name.split('_');
  return (
    <span className="font-mono text-foreground">
      {parts.map((part, i) => (
        <React.Fragment key={`${i}-${part}`}>
          {i ? (
            <>
              _<wbr />
            </>
          ) : null}
          {part}
        </React.Fragment>
      ))}
    </span>
  );
}

export function AuditExportDialog({
  open,
  onOpenChange,
  format,
  onFormatChange,
  view,
  local,
  filterWords,
  onOpenJobs,
  returnFocusRef,
}: AuditExportDialogProps) {
  const [range, setRange] = React.useState<AbsoluteRange | null>(null);
  const [count, setCount] = React.useState<CountState>({ phase: 'counting' });
  const [narrowed, setNarrowed] = React.useState(false);
  const [busy, setBusy] = React.useState<null | 'submitting' | 'waiting'>(null);
  const [submitError, setSubmitError] = React.useState<{ title: string; text: string } | null>(null);
  const intentRef = React.useRef<JobSubmissionIntent | null>(null);
  const aliveRef = React.useRef(true);
  const contentRef = React.useRef<HTMLDivElement>(null);
  // The wait a submit started; anything else (Continue in the background, Esc, a new
  // opening) moves it on, and the old wait stops at its next check.
  const waitRunRef = React.useRef(0);
  // The small export this dialog waits for. The shell holds its terminal toast while the
  // dialog reports the outcome itself, so the dialog releases it when it stops waiting.
  const waitedJobRef = React.useRef<string | null>(null);
  const filters = React.useMemo(() => apiFilters(view, local), [view, local]);

  /** Stop waiting: `reported` when the dialog told the person the outcome itself. */
  const releaseWaitedJob = React.useCallback((reported: boolean) => {
    const jobId = waitedJobRef.current;
    waitedJobRef.current = null;
    if (jobId) releaseJobToast(jobId, { reported });
  }, []);

  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // The page closed mid-wait: the shell's toast tells the outcome instead.
      releaseWaitedJob(false);
    };
  }, [releaseWaitedJob]);

  // Resolve the range and count once per opening (SPEC §4.5.6: absolute instants).
  React.useEffect(() => {
    if (!open) return undefined;
    const now = Date.now();
    const resolved = absoluteRange(view, now);
    setRange(resolved);
    setNarrowed(false);
    setSubmitError(null);
    setBusy(null);
    intentRef.current = null;
    waitRunRef.current += 1;
    releaseWaitedJob(false);
    if (!resolved) {
      setCount({ phase: 'error', error: new Error('The time range of this view cannot be read.') });
      return undefined;
    }
    const controller = new AbortController();
    setCount({ phase: 'counting' });
    const base = { ...filters, scope: view.scope, q: view.q ?? undefined, cap: AUDIT_COUNT_CAP };
    void (async () => {
      try {
        const total = await countAudit({ ...base, from: resolved.from, to: resolved.to }, controller.signal);
        if (controller.signal.aborted) return;
        if (!exceedsCap(total)) {
          setCount({ phase: 'ready', count: total, narrowTo: null, narrowChecked: false });
          return;
        }
        setCount({ phase: 'ready', count: total, narrowTo: null, narrowChecked: false });
        // One more count: does the last 30 days fit in one file?
        const last30 = absoluteRange({ from: 'now-30d', to: null }, now);
        if (!last30 || last30.fromMs <= resolved.fromMs) {
          setCount({ phase: 'ready', count: total, narrowTo: null, narrowChecked: true });
          return;
        }
        const recent = await countAudit({ ...base, from: last30.from, to: last30.to }, controller.signal);
        if (controller.signal.aborted) return;
        setCount({
          phase: 'ready',
          count: total,
          narrowTo: exceedsCap(recent) || recent.count === 0 ? null : { range: last30, count: recent.count },
          narrowChecked: true,
        });
      } catch (error) {
        if (!controller.signal.aborted) setCount({ phase: 'error', error });
      }
    })();
    return () => controller.abort();
    // The dialog reads the view as it was when it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ready = count.phase === 'ready' ? count : null;
  const over = ready ? exceedsCap(ready.count) : false;

  // The format radios appear once the count is in: move focus there from the dialog
  // frame, unless the person has already moved it.
  React.useEffect(() => {
    if (!open || count.phase !== 'ready') return;
    const content = contentRef.current;
    if (!content || document.activeElement !== content) return;
    content.querySelector<HTMLElement>('button[role="radio"][data-state="checked"]')?.focus();
  }, [open, count.phase]);
  const events = ready ? ready.count.count : 0;
  const fileName = range ? exportFileName(format, range) : '';
  const canExport = Boolean(ready && range && !over && events > 0 && !busy);

  const useLast30 = () => {
    if (!ready?.narrowTo) return;
    setRange(ready.narrowTo.range);
    setCount({ phase: 'ready', count: { count: ready.narrowTo.count, relation: 'eq' }, narrowTo: null, narrowChecked: true });
    setNarrowed(true);
  };

  const stillRunning = React.useCallback(() => {
    toast.info('The export is still running.', {
      description: 'The file will be in Jobs, with an Inbox notice, when it is ready.',
      action: { label: 'Open Jobs', onClick: onOpenJobs },
    });
  }, [onOpenJobs]);

  /** Stop waiting here: the job keeps running and its file lands in Jobs. */
  const continueInBackground = () => {
    waitRunRef.current += 1;
    releaseWaitedJob(false);
    setBusy(null);
    onOpenChange(false);
    stillRunning();
  };

  const waitAndDownload = async (job: BackgroundJob, name: string, run: number) => {
    const waiting = () => aliveRef.current && waitRunRef.current === run;
    const started = Date.now();
    let current = job;
    while (!isTerminalJobStatus(current.status)) {
      if (!waiting()) return;
      if (Date.now() - started > WAIT_LIMIT_MS) {
        waitRunRef.current += 1;
        releaseWaitedJob(false);
        onOpenChange(false);
        stillRunning();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      if (!waiting()) return;
      try {
        current = await api.jobs.get(current.job_id);
      } catch (error) {
        throw new AfterAcceptance(errorMessage(error, 'The status check failed.'), false);
      }
    }
    if (!waiting()) return;
    if (current.status !== 'succeeded' || !current.result?.artifact_id) {
      const reason = current.failures[0]?.reason;
      throw new Error(
        current.status === 'cancelled'
          ? 'The export was cancelled before the file was written.'
          : reason
            ? `The export failed: ${reason}`
            : 'The export failed before the file was written.',
      );
    }
    let download: Awaited<ReturnType<typeof api.jobs.artifact>>;
    try {
      download = await api.jobs.artifact(current.job_id);
    } catch (error) {
      throw new AfterAcceptance(errorMessage(error, 'The download failed.'), true);
    }
    if (!waiting()) return;
    const saved = saveBlob(download, name);
    releaseWaitedJob(true);
    onOpenChange(false);
    toast.success('Audit export downloaded.', { description: saved });
  };

  const submit = async () => {
    if (!canExport || !range || !ready) return;
    const params: AuditExportJobParams = {
      format,
      filters,
      // Exports are always oldest first (the server refuses any other order).
      order: 'asc',
      scope: view.scope,
      from: range.from,
      to: range.to,
      ...(view.q ? { q: view.q } : {}),
    };
    const intent = retainJobSubmissionIntent(intentRef.current, 'audit_export', params as unknown as Record<string, unknown>);
    intentRef.current = intent;
    setSubmitError(null);
    setBusy('submitting');
    let job: BackgroundJob;
    try {
      job = await submitAuditExport(params, intent.idempotencyKey);
    } catch (error) {
      // Nothing was accepted: the dialog says so and keeps the intent for a retry.
      if (aliveRef.current) {
        setSubmitError({ title: 'The export did not run.', text: exportErrorText(error) });
        setBusy(null);
      }
      return;
    }
    intentRef.current = null;
    // A small export is waited for here, and this dialog reports how it ends.
    const waited = events <= SMALL_EXPORT_ROWS;
    announceJobAccepted(job, { quiet: waited });
    if (!waited) {
      if (aliveRef.current) setBusy(null);
      onOpenChange(false);
      toast.success('Audit export started.', {
        description: 'You will get an Inbox notice when the file is ready.',
        action: { label: 'Open Jobs', onClick: onOpenJobs },
      });
      return;
    }
    const run = (waitRunRef.current += 1);
    waitedJobRef.current = job.job_id;
    setBusy('waiting');
    try {
      await waitAndDownload(job, fileName, run);
    } catch (error) {
      if (!aliveRef.current || waitRunRef.current !== run) return;
      if (error instanceof AfterAcceptance) {
        // The job exists and finishes (or has finished) in Jobs: never "did not run".
        // A finished job's notice below is its outcome; a running one's comes from the
        // shell when it ends.
        waitRunRef.current += 1;
        releaseWaitedJob(error.finished);
        onOpenChange(false);
        toast.info(error.finished ? 'The export finished. Download the file from Jobs.' : 'The export is running. The file will be in Jobs.', {
          description: error.message,
          action: { label: 'Open Jobs', onClick: onOpenJobs },
        });
      } else {
        // The dialog shows how the export ended.
        releaseWaitedJob(true);
        setSubmitError({ title: 'The export did not finish.', text: errorMessage(error, 'The export failed.') });
      }
    } finally {
      if (aliveRef.current && waitRunRef.current === run) setBusy(null);
    }
  };

  const title = !ready ? 'Export audit events' : over ? 'Export audit events' : `Export ${fmt(events)} ${events === 1 ? 'event' : 'events'}?`;
  const rangeText = range ? `${formatMinute(range.fromMs, 'utc')} to ${formatMinute(range.toMs, 'utc')} UTC` : '';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return onOpenChange(true);
        // While the job is being created, stay; while it is waited for, Esc and Close
        // leave it to finish in the background.
        if (busy === 'submitting') return undefined;
        if (busy === 'waiting') return continueInBackground();
        return onOpenChange(false);
      }}
    >
      <DialogContent
        ref={contentRef}
        className="max-w-lg focus:outline-none"
        onOpenAutoFocus={(event) => {
          // Focus the chosen format once it is shown; until the count is in, the dialog
          // itself (never the page behind it).
          event.preventDefault();
          const content = event.currentTarget as HTMLElement;
          const radio = content.querySelector<HTMLElement>('button[role="radio"][data-state="checked"]');
          (radio ?? content).focus();
        }}
        onCloseAutoFocus={(event) => {
          const back = returnFocusRef?.current;
          if (back && back.isConnected) {
            event.preventDefault();
            back.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {count.phase === 'counting'
              ? 'Counting the events in this view.'
              : over
                ? `More than ${fmt(EXPORT_ROW_CAP)} events match. One file holds up to ${fmt(EXPORT_ROW_CAP)}.`
                : 'The file holds exactly the events this view shows.'}
          </DialogDescription>
        </DialogHeader>

        {count.phase === 'counting' ? <LoadingState label="Counting events" layout="inline" /> : null}
        {count.phase === 'error' ? (
          <Callout intent="error" title="The events could not be counted.">
            {errorMessage(count.error, 'Try again in a moment.')}
          </Callout>
        ) : null}

        {ready && range ? (
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-y border-border/70 py-3 text-sm">
            <dt className="text-muted-foreground">Events</dt>
            <dd className="font-medium tabular-nums text-foreground" data-testid="audit-export-count">
              {over ? `More than ${fmt(EXPORT_ROW_CAP)} events` : fmt(events)}
            </dd>
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="text-foreground">{SCOPE_LABEL[view.scope]}</dd>
            <dt className="text-muted-foreground">Time range</dt>
            <dd className="tabular-nums text-foreground" data-testid="audit-export-range">
              {rangeText}
              {narrowed ? <span className="text-muted-foreground"> (last 30 days)</span> : null}
            </dd>
            <dt className="text-muted-foreground">Filters</dt>
            <dd className="text-foreground [overflow-wrap:anywhere]">{filterWords.length ? filterWords.join(' · ') : 'None added'}</dd>
            <dt className="text-muted-foreground">Order</dt>
            <dd className="text-foreground">Oldest first, times in ISO 8601 UTC</dd>
          </dl>
        ) : null}

        {ready && over ? (
          <Callout intent="warning" title="Too many events for one file">
            {!ready.narrowChecked
              ? 'Checking whether the last 30 days fit in one file.'
              : ready.narrowTo
                ? `The last 30 days hold ${fmt(ready.narrowTo.count)} events, which fit in one file. Or narrow the filters.`
                : 'Narrow the filters or the time range; nothing is ever cut off silently.'}
          </Callout>
        ) : null}

        {ready && !over ? (
          <fieldset className="space-y-2" disabled={busy !== null}>
            <legend className="mb-2 text-sm font-medium text-foreground">Format</legend>
            <RadioGroup
              value={format}
              onValueChange={(v) => onFormatChange(v as AuditExportFileFormat)}
              className="grid gap-2"
              aria-label="Format"
            >
              <Label htmlFor="audit-export-csv" className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border/70 px-3 py-2">
                <RadioGroupItem id="audit-export-csv" value="csv" className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">CSV (spreadsheet)</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Every field in a fixed set of columns. Cells that start like a formula are made safe.
                  </span>
                </span>
              </Label>
              <Label htmlFor="audit-export-jsonl" className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border/70 px-3 py-2">
                <RadioGroupItem id="audit-export-jsonl" value="jsonl" className="mt-0.5" />
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">JSON Lines (for a SIEM)</span>
                  <span className="text-xs font-normal text-muted-foreground">Each stored record unchanged, one per line.</span>
                </span>
              </Label>
            </RadioGroup>
          </fieldset>
        ) : null}

        {ready && range && !over ? (
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p className="[overflow-wrap:anywhere]">
              File: <FileName name={fileName} />
            </p>
            <p className="flex items-start gap-1.5">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                You will be asked to sign in again. This export is recorded in the audit log. The file contains user names and IP
                addresses.
              </span>
            </p>
          </div>
        ) : null}

        {busy === 'waiting' ? (
          <p className="text-sm text-muted-foreground" role="status">
            Preparing the file. It downloads when it is ready.
          </p>
        ) : null}
        {submitError ? (
          <Callout intent="error" title={submitError.title}>
            {submitError.text}
          </Callout>
        ) : null}

        <DialogFooter>
          {busy === 'waiting' ? (
            <Button variant="outline" onClick={continueInBackground}>
              Continue in the background
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy !== null}>
              Cancel
            </Button>
          )}
          {ready && over && ready.narrowTo ? (
            <Button variant="outline" onClick={useLast30}>
              Use last 30 days
            </Button>
          ) : null}
          <Button onClick={() => void submit()} disabled={!canExport}>
            <Download className="size-4" aria-hidden />
            {busy ? 'Exporting' : ready && !over && events > 0 ? `Export ${fmt(events)} ${events === 1 ? 'event' : 'events'}` : 'Export'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
