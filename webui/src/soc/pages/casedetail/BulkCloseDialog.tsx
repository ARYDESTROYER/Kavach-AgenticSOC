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
 * SECURITY (#9): option labels are fixed enums; the note is collected as plain text.
 */
import * as React from 'react';
import { Check, CheckCircle2, RefreshCw } from 'lucide-react';

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

import { DispositionPicker } from './DispositionPicker';
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
}) => {
  const [disposition, setDisposition] = React.useState('');
  const [resolution, setResolution] = React.useState('');
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    if (action) return;
    setDisposition('');
    setResolution('');
    setNote('');
  }, [action]);

  const plural = count === 1 ? '' : 's';
  const isClose = action === 'close';
  const title = isClose ? `Close ${count} case${plural}` : `Resolve ${count} case${plural}`;
  const submitLabel = isClose ? `Close ${count} case${plural}` : `Resolve ${count} case${plural}`;

  const submit = () => {
    if (!action || !disposition || busy) return;
    const trimmed = note.trim();
    onSubmit({
      action,
      disposition,
      disposition_declared: true,
      ...(isClose && resolution ? { resolution } : {}),
      ...(trimmed ? (isClose ? { note: trimmed } : { reason: trimmed, note: trimmed }) : {}),
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
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

export default BulkCloseDialog;
