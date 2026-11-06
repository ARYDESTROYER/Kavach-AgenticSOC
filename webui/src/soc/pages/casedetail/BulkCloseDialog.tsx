/**
 * BulkCloseDialog — close or resolve one or many cases WITH a disposition (Round 12,
 * SPEC D15 / §3.2; SecOps parity: a bulk close requires a reason).
 *
 * Every terminal path captures the investigative outcome: the Case Manager bulk
 * toolbar, the Cases list bulk bar and the Cases list one-click row close all open this
 * dialog. The disposition is REQUIRED and the picker opens EMPTY (G1), so the submitted
 * job / action carries `disposition_declared: true` only because a person chose it.
 *
 * #3: this dialog only collects input. The caller submits the existing `close` /
 * `resolve` analyst verbs (single action or the durable `case_lifecycle` job); nothing
 * here reaches `decide()`.
 *
 * Round 14 (SPEC §4.10.15, D34): when the caller passes the selected case ids, the
 * dialog reads their runbook progress and, when some still have required steps open,
 * says how many and offers ONE shared, optional reason (`open_steps_reason`). A bulk close
 * never fails a case for open steps; each such close is audited with the reason.
 *
 * SECURITY (#9): option labels are fixed enums; the note is collected as plain text.
 */
import * as React from 'react';
import { Check, CheckCircle2, ListChecks, LoaderCircle } from 'lucide-react';

import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

import { getRunbookProgress } from '@/lib/api-runbooks';
import {
  AUTOMATIC_CLOSES_NOTE,
  OPEN_STEPS_REASON_LABEL,
  OPEN_STEPS_REASON_MAX_CHARS,
} from '@/soc/runbooks/run/OpenStepsNotice';

import { DispositionPicker, focusDispositionPicker } from './DispositionPicker';
import { DURABLE_CONTEXT_NOTE, RESOLUTION_OPTIONS } from './shared';

export type BulkTerminalAction = 'close' | 'resolve';

export interface BulkCloseInput {
  action: BulkTerminalAction;
  disposition: string;
  /** Always true: the dialog cannot submit until a person chose a disposition. */
  disposition_declared: true;
  resolution?: string;
  note?: string;
  reason?: string;
  /**
   * Round 14: the one shared reason for closing cases whose runbook still has required
   * steps open. Optional; never `require_open_steps_reason` (a bulk close never fails
   * an item for open steps).
   */
  open_steps_reason?: string;
}

export interface BulkCloseDialogProps {
  /** Which terminal verb to collect for; null keeps the dialog closed. */
  action: BulkTerminalAction | null;
  /** How many cases the submission covers (1 for a single row). */
  count: number;
  busy?: boolean;
  /** The AI verdict when the dialog covers exactly one case (read-only hint). */
  verdict?: string | null;
  /** The recorded disposition when the dialog covers exactly one case (read-only). */
  currentDisposition?: string | null;
  onCancel: () => void;
  onSubmit: (input: BulkCloseInput) => void;
  /** Where focus returns on close (the control that opened the dialog). */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
  /**
   * The cases the submission covers. When given, their runbook progress is read so the
   * dialog can say how many have required steps open and offer a shared reason.
   */
  caseIds?: readonly string[];
}

/** How many of `caseIds` have required runbook steps open (null while unknown). */
function useOpenStepsCount(caseIds: readonly string[] | undefined, open: boolean): number | null {
  const [count, setCount] = React.useState<number | null>(null);
  const key = open && caseIds?.length ? caseIds.join('\n') : '';
  React.useEffect(() => {
    setCount(null);
    if (!key) return undefined;
    const controller = new AbortController();
    void getRunbookProgress(key.split('\n'), controller.signal)
      .then((map) => {
        if (controller.signal.aborted) return;
        setCount(Object.values(map).filter((p) => p && p.required_open > 0).length);
      })
      // The close never depends on this read: without it the dialog says nothing.
      .catch(() => undefined);
    return () => controller.abort();
  }, [key]);
  return count;
}

export const BulkCloseDialog: React.FC<BulkCloseDialogProps> = ({
  action,
  count,
  busy = false,
  verdict,
  currentDisposition,
  onCancel,
  onSubmit,
  returnFocusTo,
  caseIds,
}) => {
  const [disposition, setDisposition] = React.useState('');
  const [stepsReason, setStepsReason] = React.useState('');
  const openStepsCount = useOpenStepsCount(caseIds, action !== null);
  const [resolution, setResolution] = React.useState('');
  const [note, setNote] = React.useState('');
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (action) return;
    setDisposition('');
    setResolution('');
    setNote('');
    setStepsReason('');
  }, [action]);

  const plural = count === 1 ? '' : 's';
  const isClose = action === 'close';
  const title = isClose ? `Close ${count} case${plural}` : `Resolve ${count} case${plural}`;
  const submitLabel = isClose ? `Close ${count} case${plural}` : `Resolve ${count} case${plural}`;

  const submit = () => {
    if (!action || !disposition || busy) return;
    const trimmed = note.trim();
    const why = openStepsCount ? stepsReason.trim() : '';
    onSubmit({
      action,
      disposition,
      disposition_declared: true,
      ...(isClose && resolution ? { resolution } : {}),
      ...(trimmed ? (isClose ? { note: trimmed } : { reason: trimmed, note: trimmed }) : {}),
      ...(why ? { open_steps_reason: why } : {}),
    });
  };

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      {action ? (
        <DialogContent
          data-testid="bulk-close-dialog"
          className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
          ref={contentRef}
          // Initial focus on the required disposition (scrolled into view), never the
          // Resolution select after it, which can sit under the sticky footer (CM-3).
          onOpenAutoFocus={(event) => {
            if (focusDispositionPicker(contentRef.current)) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo?.current;
            if (target && target.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
            <DialogTitle className="flex items-center gap-2">
              {isClose ? <Check className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
              {title}
            </DialogTitle>
            <DialogDescription>
              {count === 1
                ? 'Choose the outcome you confirmed. It is recorded as your classification of this case.'
                : 'Choose the outcome you confirmed. It is recorded as your classification on every selected case; each case is updated in the background and failures stay visible in Inbox.'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
            <DispositionPicker
              value={disposition}
              onChange={setDisposition}
              verdict={count === 1 ? verdict : null}
              currentDisposition={count === 1 ? currentDisposition : null}
              idPrefix="bulk-close-disposition"
              disabled={busy}
            />
            {isClose ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Resolution (optional)</Label>
                <Select
                  value={resolution || '__none__'}
                  onValueChange={(v) => setResolution(v === '__none__' ? '' : v)}
                >
                  <SelectTrigger className="h-9" aria-label="Resolution (optional)">
                    <SelectValue placeholder="No resolution" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No resolution</SelectItem>
                    {RESOLUTION_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.text}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="bulk-close-note" className="text-xs">
                {isClose ? 'Analyst note (optional)' : 'Reason (optional)'}
              </Label>
              <Textarea
                id="bulk-close-note"
                rows={3}
                value={note}
                placeholder={isClose ? 'Add context for the next analyst…' : 'Why this work is complete…'}
                aria-describedby={isClose ? 'bulk-close-note-help' : undefined}
                onChange={(event) => setNote(event.target.value)}
              />
              {isClose ? (
                <p id="bulk-close-note-help" className="text-xs leading-relaxed text-muted-foreground">
                  {DURABLE_CONTEXT_NOTE}
                </p>
              ) : null}
            </div>
            {openStepsCount ? (
              <div className="space-y-1.5" data-bulk-open-steps="">
                <p className="flex items-start gap-2 text-sm text-foreground">
                  <ListChecks className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
                  {count === 1
                    ? 'This case has required runbook steps open.'
                    : `${openStepsCount.toLocaleString()} of the ${count.toLocaleString()} selected cases have required runbook steps open.`}
                </p>
                <Label htmlFor="bulk-close-open-steps-reason" className="text-xs">
                  {OPEN_STEPS_REASON_LABEL}
                  <span className="font-normal text-muted-foreground"> (optional{count > 1 ? ', one reason for all of them' : ''})</span>
                </Label>
                <Textarea
                  id="bulk-close-open-steps-reason"
                  rows={2}
                  value={stepsReason}
                  maxLength={OPEN_STEPS_REASON_MAX_CHARS}
                  disabled={busy}
                  aria-describedby="bulk-close-open-steps-help"
                  onChange={(event) => setStepsReason(event.target.value)}
                />
                <p id="bulk-close-open-steps-help" className="text-xs leading-relaxed text-muted-foreground">
                  A bulk close never stops for open steps. The reason is saved with your name on each of those
                  cases. {AUTOMATIC_CLOSES_NOTE}
                </p>
              </div>
            ) : null}
            {count > 1 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                The selected case IDs are snapshotted when you submit; later selection changes
                do not alter the job.
              </p>
            ) : null}
          </div>
          <DialogFooter className="shrink-0 border-t border-border bg-card px-6 py-4">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!disposition || busy}>
              {busy ? (
                <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
              ) : (
                <Check className="h-4 w-4" aria-hidden />
              )}
              {submitLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

export default BulkCloseDialog;
