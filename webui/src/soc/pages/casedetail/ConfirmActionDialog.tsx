/**
 * CaseDetail: the lifecycle confirm-action dialog (Coupling-D split; Round 12 CM-3;
 * Round 15 D4.1 to D4.6).
 *
 * ONE dialog drives EVERY lifecycle action (close / escalate / resolve / hold / …). It
 * is polymorphic on the pending `ActionDef.fields`: it renders only the structured inputs
 * that action declares (disposition / actions taken / assignee / priority / reason / the
 * AI rating) plus an always-present analyst note. It is fully CONTROLLED: the
 * orchestrator owns the field state and the submit handler.
 *
 * Round 15 (SPEC D4.1 to D4.6): a close asks "what was it" ONCE, the disposition. The
 * overlapping Resolution select and the "What actually happened?" select left the
 * dialog, and so did tags (edited in the facts rail). It adds "Actions taken" (a fixed
 * vocabulary), shows whether the disposition agrees with the AI as text (never asks it),
 * keeps the stars and "What did the AI miss?" in a collapsed "Rate the AI (optional)",
 * and requires the note only when the disposition overrides the AI verdict. Screenshots
 * join through `renderScreenshots` (the WP4 drop zone, mounted by the caller), which gets
 * the dialog as its paste scope; the close never waits for or rolls back an upload.
 *
 * Layout: a header, a body that scrolls on its own and a STICKY footer, so the submit
 * button is always on screen. A disposition action lays out in two columns from 40rem:
 * the classification on the left, what was done (open steps, actions taken, the note,
 * screenshots, the rating) on the right. "Close & next" advances the queue. Focus returns
 * to the control that opened the dialog on every exit path.
 *
 * #3 CONTRACT: this dialog NEVER posts an action itself. It calls `onSubmit` (or
 * `onSubmitAndNext`), and the orchestrator's `runAction` POSTs the EXISTING backend verb
 * (`pending.wireAction ?? pending.key`), so `close_disposition` maps to `close` and the
 * analyst layer never reaches `decide()`. A disposition is REQUIRED whenever the action
 * declares the field, and the picker opens EMPTY, never pre-seeded from
 * `case.disposition` (G1).
 *
 * Round 14 (SPEC §4.10.11, D34): a close or resolve on a case whose active runbook still
 * has required steps open lists those steps and asks "Why are you closing with required
 * steps open?" (required, except for a duplicate). The close is never blocked by the
 * runbook; the reason is audited. Automatic closes never look at runbook steps (#3).
 *
 * SECURITY (#9): option labels are static enums; the free text (assignee / reason /
 * note) is stored, never rendered as markup here.
 */
import * as React from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';

import { aiVerdictLine } from '@/soc/components/outcome';

import { type ActionDef, type WireActionTaken, DURABLE_CONTEXT_NOTE, PRIORITY_OPTIONS } from './shared';
import { DispositionPicker, focusDispositionPicker } from './DispositionPicker';
import { ActionsTakenField } from './ActionsTakenField';
import { OpenStepsNotice } from '@/soc/runbooks/run/OpenStepsNotice';
import type { OpenRequiredStep } from '@/soc/runbooks/run/model';
import { AgreementLine, RateTheAi, requiresDisagreementNote, type GradingDraft } from './grading';

export interface ConfirmActionDialogProps {
  /** The pending action, or null when the dialog is closed. */
  pending: ActionDef | null;
  /** True while the action POST is in flight (disables controls + shows a spinner). */
  acting: boolean;
  /** Close the dialog (only allowed while not `acting`). */
  onClose: () => void;
  /** Run the action: the orchestrator's `runAction` (posts the wire verb, #3). */
  onSubmit: () => void;
  /**
   * Optional "Close & next": run the same action, then advance the queue to the next
   * case. Offered only for terminal (close / resolve) actions; when present it is the
   * primary button and plain submit becomes the secondary.
   */
  onSubmitAndNext?: () => void;
  /**
   * Where focus returns when the dialog closes: the control that opened it (the
   * Take action trigger or the primary action). The dialog is opened from STATE, so
   * Radix has no trigger of its own and would otherwise drop focus on <body>.
   */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
  /**
   * Where focus goes when a SUBMIT closes the dialog and the opener may have left (the
   * Case Manager: a queue row the action took out of the view, or "Close & next", which
   * lands on the next case's row). Return null to keep `returnFocusTo` / the opener.
   */
  focusAfterSubmit?: (opener: HTMLElement | null, andNext: boolean) => HTMLElement | null;

  // Controlled field values + setters (owned by the orchestrator).
  note: string;
  onNoteChange: (v: string) => void;
  priority: string;
  onPriorityChange: (v: string) => void;
  assignee: string;
  onAssigneeChange: (v: string) => void;
  disposition: string;
  onDispositionChange: (v: string) => void;
  /**
   * The disposition already recorded on the case, shown as READ-ONLY context beneath
   * the picker. It is context, never a default (see DispositionPicker, G1).
   */
  currentDisposition?: string | null;
  reason: string;
  onReasonChange: (v: string) => void;
  /** Round 15 (D4.2): what the person did about the case (fixed vocabulary). */
  actionsTaken?: readonly WireActionTaken[];
  onActionsTakenChange?: (v: WireActionTaken[]) => void;

  // Round-7 #10 (feedback-into-close). Only consumed when the pending action carries
  // the `grading` field; the derived AI-decision grade is submitted as a SEPARATE
  // `caseFeedback` POST by the orchestrator's `runAction` (never through `decide()`, #3).
  /** The AI verdict on the case: the derived agreement and the note rule read it. */
  verdict?: string | null;
  /** The AI confidence on the case, shown beside the agreement. */
  confidence?: number | null;
  /** The in-dialog grading draft (owned by the orchestrator). */
  grading: GradingDraft;
  onGradingChange: (next: GradingDraft) => void;

  // Round 14 (D34): required runbook steps still open on a close or resolve.
  /** The open required steps; empty or omitted when none (or the action ends nothing). */
  openSteps?: readonly OpenRequiredStep[];
  openStepsReason?: string;
  onOpenStepsReasonChange?: (v: string) => void;
  /** Set by the orchestrator (for example after a `409 runbook_steps_open`). */
  openStepsError?: string | null;

  /**
   * Round 15 (D4.6): the "Add screenshots" drop zone (WP4's kit, mounted by the caller),
   * rendered for an action that ends the case or records its outcome. It receives the
   * dialog as the scope where a pasted image is caught. Uploads are independent of the
   * action: the close never waits for one and never rolls one back.
   */
  renderScreenshots?: (pasteScope: React.RefObject<HTMLElement | null>) => React.ReactNode;
}

/** The footer and field message when a reason for the open steps is missing. */
export const OPEN_STEPS_REASON_MISSING = 'Say why you are closing with required steps open.';

/** Round 15 (D4.3): the note a disposition that overrides the AI verdict needs. */
export const DISAGREEMENT_NOTE_MISSING = 'Say why you disagree with the AI.';
/** The same, where the note becomes precedent (a close, `DURABLE_CONTEXT_NOTE`). */
export const DISAGREEMENT_NOTE_REASON =
  'Say why you disagree with the AI. Your note is kept as precedent for future investigations.';

const EMPTY_STEPS: readonly OpenRequiredStep[] = [];
const NO_ACTIONS: readonly WireActionTaken[] = [];

/** Which actions end the case (and so may advance the queue with "& next"). */
function isTerminalAction(pending: ActionDef): boolean {
  const verb = pending.wireAction ?? pending.key;
  return verb === 'close' || verb === 'resolve';
}

export const ConfirmActionDialog: React.FC<ConfirmActionDialogProps> = ({
  pending,
  acting,
  onClose,
  onSubmit,
  onSubmitAndNext,
  returnFocusTo,
  focusAfterSubmit,
  note,
  onNoteChange,
  priority,
  onPriorityChange,
  assignee,
  onAssigneeChange,
  disposition,
  onDispositionChange,
  currentDisposition,
  reason,
  onReasonChange,
  actionsTaken = NO_ACTIONS,
  onActionsTakenChange,
  verdict,
  confidence,
  grading,
  onGradingChange,
  openSteps = EMPTY_STEPS,
  openStepsReason = '',
  onOpenStepsReasonChange,
  openStepsError = null,
  renderScreenshots,
}) => {
  // The element that held focus when the dialog OPENED, captured during render (the
  // same pattern as the case sheet): child effects run before ours, so by the time an
  // effect ran Radix would already have moved focus inside.
  const openerRef = React.useRef<HTMLElement | null>(null);
  if (pending && !openerRef.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  // A submit with required runbook steps open and no reason: the field says so.
  const [stepsBlocked, setStepsBlocked] = React.useState(false);
  const stepsReasonRef = React.useRef<HTMLTextAreaElement | null>(null);
  // A submit whose disposition overrides the AI with no note: the note says so (D4.3).
  const [noteBlocked, setNoteBlocked] = React.useState(false);
  const noteRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    if (pending) return;
    // The captured opener is NOT released here: Radix fires `onCloseAutoFocus` from a
    // timeout after the content unmounts, i.e. after this effect, and it still needs the
    // opener. `restoreFocus` releases it.
    setStepsBlocked(false);
    setNoteBlocked(false);
  }, [pending]);

  // Which actions carry the note into DURABLE, AGENT-VISIBLE context. The backend
  // indexes the resolved case (note included) on the `close` and `confirm_fp` verbs
  // only, and the Console posts `close` (`close_disposition` maps to it via
  // `wireAction`), so the disclosure follows that wire verb; an escalate/hold note is not
  // indexed.
  const notePersists = pending ? (pending.wireAction ?? pending.key) === 'close' : false;

  const hasDisposition = Boolean(pending?.fields.includes('disposition'));
  // There is something to rate only when the AI gave a verdict: on a case it never
  // assessed the orchestrator posts no grade, so stars there would be dropped unseen.
  const aiVerdict = String(verdict ?? '').trim().toLowerCase();
  const hasGrading = Boolean(pending?.fields.includes('grading')) && Boolean(aiVerdict) && aiVerdict !== 'none';
  const hasActionsTaken = Boolean(pending?.fields.includes('actions_taken') && onActionsTakenChange);
  const hasOpenSteps = openSteps.length > 0;
  const showScreenshots = Boolean(renderScreenshots && pending && (hasDisposition || isTerminalAction(pending)));
  const wide = hasDisposition || hasGrading || hasOpenSteps;
  // Marking a duplicate needs no reason (the work lives in the other case).
  const stepsReasonRequired = hasOpenSteps && disposition !== 'duplicate';
  const stepsReasonMissing = stepsReasonRequired && !openStepsReason.trim();
  const stepsError = openStepsError ?? (stepsBlocked && stepsReasonMissing ? OPEN_STEPS_REASON_MISSING : null);
  // D4.3: the note is optional, except when the disposition overrides the AI verdict.
  const noteRequired = hasDisposition && requiresDisagreementNote(verdict, disposition);
  const noteMissing = noteRequired && !note.trim();
  const noteError = noteBlocked && noteMissing ? DISAGREEMENT_NOTE_MISSING : null;
  const aiLine = aiVerdictLine(verdict, confidence);
  const canSubmit = !acting && !(hasDisposition && !disposition);
  const offerNext = Boolean(pending && onSubmitAndNext && isTerminalAction(pending));

  /** False (and points at the note) while an override has no note. */
  const noteSettled = (): boolean => {
    if (!noteMissing) return true;
    setNoteBlocked(true);
    const field = noteRef.current;
    if (field) {
      field.focus({ preventScroll: true });
      field.scrollIntoView?.({ block: 'nearest' });
    }
    return false;
  };

  /** False (and points at the reason) while required steps are open with no reason. */
  const stepsSettled = (): boolean => {
    if (!stepsReasonMissing) return true;
    setStepsBlocked(true);
    const field = stepsReasonRef.current;
    if (field) {
      field.focus({ preventScroll: true });
      field.scrollIntoView?.({ block: 'nearest' });
    }
    return false;
  };
  const settled = () => stepsSettled() && noteSettled();
  // What the footer says before the submit can go (polite, never an alert).
  const footerStatus =
    hasDisposition && !disposition
      ? 'Pick a disposition.'
      : stepsReasonMissing
        ? OPEN_STEPS_REASON_MISSING
        : noteMissing
          ? DISAGREEMENT_NOTE_MISSING
          : '';

  // Which submit closed the dialog (null: cancelled or dismissed). Reset on every open.
  const submitRef = React.useRef<'submit' | 'next' | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    // A fresh dialog starts with no submit recorded. (Not cleared on close: the close
    // focus handler runs after that render and must still see which submit closed it.)
    if (pending) submitRef.current = null;
  }, [pending]);
  // A submit that finished with the dialog still open (the server refused it because
  // required runbook steps are open, or a field was missing) did not close it, so a later
  // Cancel returns focus to the opener, never to where a finished submit would have gone
  // (the next queue row after "Close & next").
  const wasActing = React.useRef(false);
  React.useEffect(() => {
    if (wasActing.current && !acting && pending) submitRef.current = null;
    wasActing.current = acting;
  }, [acting, pending]);

  const restoreFocus = (event: Event) => {
    const submitted = submitRef.current;
    submitRef.current = null;
    const opener = openerRef.current ?? returnFocusTo?.current ?? null;
    openerRef.current = null;
    const afterSubmit = submitted && focusAfterSubmit ? focusAfterSubmit(opener, submitted === 'next') : null;
    const target = [afterSubmit, returnFocusTo?.current, opener].find(
      (el): el is HTMLElement => Boolean(el && el.isConnected),
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  // Initial focus: the disposition the analyst must choose (scrolled into view), not
  // the first control after it. Other actions keep Radix's default.
  const focusFirstField = (event: Event) => {
    if (focusDispositionPicker(contentRef.current)) event.preventDefault();
  };

  const noteHelp = [
    noteRequired ? 'confirm-action-note-reason' : null,
    notePersists ? 'confirm-action-note-help' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const noteField = pending ? (
    <div className="space-y-1.5">
      <Label htmlFor="confirm-action-note" className="text-xs">
        Analyst note{' '}
        <span className="font-normal text-muted-foreground">{noteRequired ? '(required)' : '(optional)'}</span>
      </Label>
      <Textarea
        ref={noteRef}
        id="confirm-action-note"
        rows={wide ? 4 : 3}
        // One prompt for the note in every case: on an override the line under the field says
        // why it is required, and "What did the AI miss?" stays the rating's own question.
        placeholder="Add context for the next analyst…"
        value={note}
        required={noteRequired || undefined}
        aria-invalid={noteError ? true : undefined}
        aria-describedby={noteHelp || undefined}
        onChange={(e) => {
          onNoteChange(e.target.value);
          setNoteBlocked(false);
        }}
      />
      {noteRequired ? (
        <p
          id="confirm-action-note-reason"
          className={cn(
            'text-xs leading-relaxed',
            noteError ? 'font-medium text-critical-text' : 'text-foreground',
          )}
        >
          {notePersists ? DISAGREEMENT_NOTE_REASON : DISAGREEMENT_NOTE_MISSING}
        </p>
      ) : null}
      {/* The analyst-comment disclosure: on a close this note is carried into the
          resolved-case precedent chunk and read back by the investigator on similar
          future cases (see DURABLE_CONTEXT_NOTE). */}
      {notePersists ? (
        <p id="confirm-action-note-help" className="text-xs leading-relaxed text-muted-foreground">
          {DURABLE_CONTEXT_NOTE}
        </p>
      ) : null}
    </div>
  ) : null;

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(o) => {
        if (!o && !acting) onClose();
      }}
    >
      {pending ? (
        <DialogContent
          ref={contentRef}
          data-testid="confirm-action-dialog"
          onOpenAutoFocus={focusFirstField}
          onCloseAutoFocus={restoreFocus}
          className={cn(
            'flex flex-col gap-0 overflow-hidden p-0',
            wide ? 'max-w-3xl' : 'max-w-md',
          )}
        >
          <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
            <DialogTitle className="flex items-center gap-2">
              <pending.icon className="h-5 w-5" />
              {pending.confirmTitle}
            </DialogTitle>
            <DialogDescription>{pending.confirmBody}</DialogDescription>
          </DialogHeader>

          <div
            data-testid="confirm-action-body"
            className={cn(
              'min-h-0 flex-1 overflow-y-auto px-6 pb-6',
              wide && '@container/confirm',
            )}
          >
            {wide ? (
              <div className="grid gap-6 @[40rem]/confirm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @[40rem]/confirm:gap-8">
                {/* The classification stays in view while the right column is filled in. */}
                <div className="min-w-0 space-y-3 @[40rem]/confirm:sticky @[40rem]/confirm:top-0 @[40rem]/confirm:self-start">
                  {hasDisposition ? (
                    <>
                      <DispositionPicker
                        value={disposition}
                        onChange={onDispositionChange}
                        verdict={verdict}
                        currentDisposition={currentDisposition}
                        idPrefix="confirm-action-disposition"
                        disabled={acting}
                      />
                      {/* D4.4: whether the choice agrees with the AI, shown and never asked. */}
                      {disposition ? (
                        <AgreementLine
                          data-testid="confirm-action-compare"
                          verdict={verdict}
                          disposition={disposition}
                          aiLine={aiLine}
                        />
                      ) : null}
                    </>
                  ) : null}
                </div>

                <div className="min-w-0 space-y-5">
                  {hasOpenSteps ? (
                    <OpenStepsNotice
                      steps={openSteps}
                      reason={openStepsReason}
                      onReasonChange={(value) => {
                        onOpenStepsReasonChange?.(value);
                        setStepsBlocked(false);
                      }}
                      required={stepsReasonRequired}
                      error={stepsError}
                      disabled={acting}
                      fieldRef={stepsReasonRef}
                      idPrefix="confirm-action-open-steps"
                    />
                  ) : null}
                  {hasActionsTaken && onActionsTakenChange ? (
                    <ActionsTakenField
                      value={actionsTaken}
                      onChange={onActionsTakenChange}
                      disabled={acting}
                      idPrefix="confirm-action-actions-taken"
                    />
                  ) : null}
                  {pending.fields.includes('reason') ? (
                    <ReasonField reason={reason} onReasonChange={onReasonChange} />
                  ) : null}
                  {noteField}
                  {showScreenshots && renderScreenshots ? (
                    <div className="space-y-1.5" data-testid="confirm-action-screenshots">
                      <span className="block text-xs font-medium text-foreground">
                        Screenshots <span className="font-normal text-muted-foreground">(optional)</span>
                      </span>
                      {renderScreenshots(contentRef)}
                    </div>
                  ) : null}
                  {/* D4.4: stars and "What did the AI miss?", collapsed. The derived
                      agreement is posted on submit whether or not this is opened. */}
                  {hasGrading ? (
                    <RateTheAi
                      verdict={verdict}
                      disposition={disposition}
                      draft={grading}
                      onChange={onGradingChange}
                      className="border-t border-border/60 pt-4"
                    />
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {pending.fields.includes('assignee') ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="confirm-action-assignee" className="text-xs">
                      Assign to (optional)
                    </Label>
                    <Input
                      id="confirm-action-assignee"
                      placeholder="e.g. tier-2 or jdoe"
                      value={assignee}
                      onChange={(e) => onAssigneeChange(e.target.value)}
                    />
                  </div>
                ) : null}

                {pending.fields.includes('priority') ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Priority (optional)</Label>
                    <Select
                      value={priority || '__none__'}
                      onValueChange={(v) => onPriorityChange(v === '__none__' ? '' : v)}
                    >
                      <SelectTrigger className="h-9" aria-label="Priority (optional)">
                        <SelectValue placeholder="No priority" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">No priority</SelectItem>
                        {PRIORITY_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.text}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                {pending.fields.includes('reason') ? (
                  <ReasonField reason={reason} onReasonChange={onReasonChange} />
                ) : null}

                {noteField}
                {showScreenshots && renderScreenshots ? renderScreenshots(contentRef) : null}
              </div>
            )}
          </div>

          <DialogFooter
            data-testid="confirm-action-footer"
            className="shrink-0 border-t border-border bg-card px-6 py-4 sm:items-center"
          >
            <p
              data-testid="confirm-action-status"
              aria-live="polite"
              className="text-xs text-muted-foreground sm:mr-auto"
            >
              {footerStatus}
            </p>
            <Button variant="ghost" onClick={onClose} disabled={acting}>
              Cancel
            </Button>
            {offerNext ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!settled()) return;
                    submitRef.current = 'submit';
                    onSubmit();
                  }}
                  disabled={!canSubmit}
                >
                  {acting ? (
                    <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                  ) : (
                    <pending.icon className="h-4 w-4" aria-hidden />
                  )}
                  {pending.label}
                </Button>
                <Button
                  onClick={() => {
                    if (!settled()) return;
                    submitRef.current = 'next';
                    onSubmitAndNext?.();
                  }}
                  disabled={!canSubmit}
                >
                  {acting ? (
                    <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                  ) : (
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  )}
                  {pending.key === 'resolve' ? 'Resolve & next' : 'Close & next'}
                </Button>
              </>
            ) : (
              <Button
                variant={pending.variant === 'outline' ? 'default' : pending.variant}
                onClick={() => {
                  if (!settled()) return;
                  submitRef.current = 'submit';
                  onSubmit();
                }}
                disabled={!canSubmit}
              >
                {acting ? (
                  <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <pending.icon className="h-4 w-4" aria-hidden />
                )}
                {pending.label}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

/** The optional status reason of a hold or a de-escalation. */
const ReasonField: React.FC<{ reason: string; onReasonChange: (v: string) => void }> = ({
  reason,
  onReasonChange,
}) => (
  <div className="space-y-1.5">
    <Label htmlFor="confirm-action-reason" className="text-xs">
      Reason (optional)
    </Label>
    <Input
      id="confirm-action-reason"
      placeholder="Why, for example awaiting a vendor reply or confirmed benign"
      value={reason}
      onChange={(e) => onReasonChange(e.target.value)}
    />
  </div>
);

export default ConfirmActionDialog;
