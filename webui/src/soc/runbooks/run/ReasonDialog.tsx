/**
 * The one "give a reason" dialog of the run inside a case (Round 14, SPEC §4.10.3,
 * §4.10.7): Not applicable and Blocked on a step, rejecting an approval and abandoning a
 * run each need a short reason (1 to 500 characters), which is audited with the change.
 *
 * Opened from state (a menu item or a button), so it captures the control that had focus
 * when it opened and gives focus back on close (WCAG 2.4.3), falling back to the caller's
 * `returnFocusTo` when that control has gone (a menu item unmounts with its menu).
 * The reason is plain text (#9).
 */
import * as React from 'react';

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
import { ARIA_DISABLED_LOOK } from './ui';

/** The longest reason a step, an approval or a run keeps. */
export const REASON_MAX_CHARS = 500;

export interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  label: string;
  placeholder?: string;
  submitLabel: string;
  /** Resolves true when the change was saved (the dialog then closes). */
  onSubmit: (reason: string) => Promise<boolean>;
  /** A refusal to show under the field (the server's own sentence). */
  error?: string | null;
  destructive?: boolean;
  /** Where focus goes on close when the opener is gone. */
  returnFocusTo?: () => HTMLElement | null;
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  submitLabel,
  onSubmit,
  error = null,
  destructive = false,
  returnFocusTo,
}: ReasonDialogProps) {
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const fieldId = React.useId();
  const helpId = React.useId();
  const errorId = React.useId();
  const openerRef = React.useRef<HTMLElement | null>(null);
  if (open && !openerRef.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  React.useEffect(() => {
    if (open) return;
    setReason('');
    setBusy(false);
    setTouched(false);
  }, [open]);

  const trimmed = reason.trim();
  const tooLong = reason.length > REASON_MAX_CHARS;
  const empty = trimmed.length === 0;
  const fieldError = touched && empty ? 'Give a reason.' : tooLong ? `Use ${REASON_MAX_CHARS} characters or fewer.` : null;
  const shown = fieldError ?? error;

  const submit = async () => {
    setTouched(true);
    if (busy || empty || tooLong) return;
    setBusy(true);
    try {
      const ok = await onSubmit(trimmed);
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!busy || next ? onOpenChange(next) : undefined)}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          const target = [opener, returnFocusTo?.() ?? null].find((el): el is HTMLElement => Boolean(el && el.isConnected));
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{label}</DialogDescription>}
        </DialogHeader>
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor={fieldId} className="text-xs">
            {label}
          </Label>
          <Textarea
            id={fieldId}
            rows={3}
            value={reason}
            placeholder={placeholder}
            aria-invalid={shown ? true : undefined}
            aria-describedby={[helpId, shown ? errorId : null].filter(Boolean).join(' ')}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <p id={helpId} className="text-xs tabular-nums text-muted-foreground">
            Recorded with your name in the case activity and the audit log. {reason.length.toLocaleString()} of{' '}
            {REASON_MAX_CHARS.toLocaleString()} characters.
          </p>
          {shown ? (
            <p id={errorId} role="alert" className="text-xs text-critical-text">
              {shown}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            className={ARIA_DISABLED_LOOK}
            onClick={() => void submit()}
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
