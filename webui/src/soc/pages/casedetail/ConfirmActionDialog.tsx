/**
 * CaseDetail — the lifecycle confirm-action dialog (Coupling-D split; Round 12 CM-3).
 *
 * ONE dialog drives EVERY lifecycle action (close / escalate / resolve / hold / …).
 * The dialog is polymorphic on the pending `ActionDef.fields`: it renders only the
 * structured inputs that action declares (disposition / resolution / tags / assignee
 * / priority / reason) plus an always-present analyst note. It is fully CONTROLLED —
 * the orchestrator owns the field state + the submit handler.
 *
 * Round 12 layout: a header, a body that scrolls on its own, and a STICKY footer — so the
 * submit button is always on screen (at 1280×800 it used to sit below the fold). Wide
 * actions (a disposition plus the AI grading) lay out in two columns from 40rem: the
 * outcome, resolution and tags on the left, the note and grading on the right. The
 * disposition is a list of radio cards with one-line definitions (keys 1–6). A
 * close-class action can offer "Close & next" as its primary button, which advances the
 * queue. Focus returns to the control that opened the dialog on every exit path.
 *
 * #3 CONTRACT: this dialog NEVER posts an action itself. It calls `onSubmit` (or
 * `onSubmitAndNext`), and the orchestrator's `runAction` POSTs the EXISTING backend verb
 * (`pending.wireAction ?? pending.key`) — so `close_disposition` maps to `close` and the
 * analyst layer never reaches `decide()`. A disposition is REQUIRED whenever the action
 * declares the field — every terminal path (close, resolve) and set-disposition — and the
 * picker opens EMPTY, never pre-seeded from `case.disposition`, so that guard is a real
 * analyst choice rather than a value `case_manager.apply()` derived from the model's own
 * verdict (G1).
 *
 * SECURITY (#9): resolution/priority/disposition options are static enums; the free
 * text (assignee / reason / note / tags) is stored, never rendered as markup here.
 */
import * as React from 'react';
import { ArrowRight, Bot, RefreshCw } from 'lucide-react';

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

import {
  agreementWords,
  aiVerdictLine,
  dispositionWords,
  outcomeAgreement,
} from '@/soc/components/outcome';
import { TagInput, focusTagInput } from '@/soc/components/TagInput';
import { CASE_TAG_MAX_CHARS, CASE_TAG_MAX_COUNT } from '@/lib/tags';

import {
  type ActionDef,
  DURABLE_CONTEXT_NOTE,
  PRIORITY_OPTIONS,
  RESOLUTION_OPTIONS,
} from './shared';
import { DispositionPicker, focusDispositionPicker } from './DispositionPicker';
import { GradingSection, type GradingDraft } from './grading';

export interface ConfirmActionDialogProps {
  /** The pending action, or null when the dialog is closed. */
  pending: ActionDef | null;
  /** True while the action POST is in flight (disables controls + shows a spinner). */
  acting: boolean;
  /** Close the dialog (only allowed while not `acting`). */
  onClose: () => void;
  /** Run the action — the orchestrator's `runAction` (posts the wire verb, #3). */
  onSubmit: () => void;
  /**
   * Optional "Close & next": run the same action, then advance the queue to the next
   * case. Offered only for terminal (close / resolve) actions; when present it is the
   * primary button and plain submit becomes the secondary.
   */
  onSubmitAndNext?: () => void;
  /**
   * Where focus returns when the dialog closes — the control that opened it (the
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
  resolution: string;
  onResolutionChange: (v: string) => void;
  priority: string;
  onPriorityChange: (v: string) => void;
  assignee: string;
  onAssigneeChange: (v: string) => void;
  tags: string[];
  onTagsChange: (v: string[]) => void;
  tagDraft: string;
  onTagDraftChange: (v: string) => void;
  /**
   * The tags already on the case. A case holds at most `CASE_TAG_MAX_COUNT` and the
   * server refuses (422) new tags past that, so Tags stops at the room the case has
   * left and says why. Omitted: no cap here (the server still refuses).
   */
  caseTags?: readonly unknown[] | null;
  disposition: string;
  onDispositionChange: (v: string) => void;
  /**
   * The disposition already recorded on the case, shown as READ-ONLY context beneath
   * the picker. It is context, never a default (see DispositionPicker, G1).
   */
  currentDisposition?: string | null;
  reason: string;
  onReasonChange: (v: string) => void;

  // Round-7 #10 (feedback-into-close). Only consumed when the pending action carries
  // the `grading` field; the derived AI-decision grade is submitted as a SEPARATE
  // `caseFeedback` POST by the orchestrator's `runAction` (never through `decide()`, #3).
  /** The AI verdict on the case — feeds the derived agree/override grading badge. */
  verdict?: string | null;
  /** The AI confidence on the case — shown on the compare line. */
  confidence?: number | null;
  /** The in-dialog grading draft (owned by the orchestrator). */
  grading: GradingDraft;
  onGradingChange: (next: GradingDraft) => void;
}

/** A binary "what actually happened" maps onto the disposition it implies. */
function impliedDisposition(outcome?: string): string | null {
  if (outcome === 'false_positive' || outcome === 'true_negative') return 'false_positive';
  if (outcome === 'true_positive' || outcome === 'false_negative') return 'true_positive';
  return null;
}

/** Which actions end the case (and so may advance the queue with "& next"). */
function isTerminalAction(pending: ActionDef): boolean {
  const verb = pending.wireAction ?? pending.key;
  return verb === 'close' || verb === 'confirm_fp' || verb === 'resolve';
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
  resolution,
  onResolutionChange,
  priority,
  onPriorityChange,
  assignee,
  onAssigneeChange,
  tags,
  onTagsChange,
  tagDraft,
  onTagDraftChange,
  caseTags,
  disposition,
  onDispositionChange,
  currentDisposition,
  reason,
  onReasonChange,
  verdict,
  confidence,
  grading,
  onGradingChange,
}) => {
  // The element that held focus when the dialog OPENED, captured during render (the
  // same pattern as the case sheet): child effects run before ours, so by the time an
  // effect ran Radix would already have moved focus inside.
  const openerRef = React.useRef<HTMLElement | null>(null);
  if (pending && !openerRef.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  const [reconcileDismissed, setReconcileDismissed] = React.useState(false);
  // A submit found text in Tags that was typed but not added. It is never added (or
  // cut) on the analyst's behalf: the submit stops and the field asks them to press
  // Enter to add it, or clear it.
  const [tagsBlocked, setTagsBlocked] = React.useState(false);
  const tagInputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (pending) return;
    // The captured opener is NOT released here: Radix fires `onCloseAutoFocus` from a
    // timeout after the content unmounts, i.e. after this effect, and it still needs the
    // opener. `restoreFocus` releases it.
    setReconcileDismissed(false);
    setTagsBlocked(false);
  }, [pending]);

  // Which actions carry the note into DURABLE, AGENT-VISIBLE context. The backend
  // indexes the resolved case (note included) on the `close` and `confirm_fp` verbs
  // only, so the disclosure follows the same wire verb — `close_disposition` maps to
  // `close` via `wireAction`, and an escalate/hold note is not indexed.
  const notePersists = pending
    ? pending.key === 'confirm_fp' || (pending.wireAction ?? pending.key) === 'close'
    : false;

  const hasDisposition = Boolean(pending?.fields.includes('disposition'));
  const hasGrading = Boolean(pending?.fields.includes('grading'));
  const wide = hasDisposition || hasGrading;
  const committed = pending?.key === 'confirm_fp' ? 'false_positive' : disposition;
  const agreement = committed ? outcomeAgreement(verdict, committed) : null;
  const aiLine = aiVerdictLine(verdict, confidence);
  const implied = impliedDisposition(grading.actual_outcome);
  const showReconcile =
    hasDisposition &&
    !reconcileDismissed &&
    implied !== null &&
    (disposition === '' || disposition === 'undetermined') &&
    implied !== disposition;
  const canSubmit = !acting && !(hasDisposition && !disposition);
  const offerNext = Boolean(pending && onSubmitAndNext && isTerminalAction(pending));
  const hasTags = Boolean(pending?.fields.includes('tags'));
  // Room for new tags: a case holds at most CASE_TAG_MAX_COUNT. A tag the case already
  // carries takes no room (the server keeps one copy), so it does not count here.
  const existingTags = React.useMemo(
    () =>
      Array.isArray(caseTags)
        ? caseTags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
        : null,
    [caseTags],
  );
  const tagRoom = existingTags ? Math.max(0, CASE_TAG_MAX_COUNT - existingTags.length) : null;
  const tagMax =
    existingTags && tagRoom !== null
      ? tagRoom + tags.filter((t) => existingTags.includes(t.trim())).length
      : undefined;
  const tagsFull = tagMax !== undefined && tags.length >= tagMax;
  const tagsFullNote =
    !tagsFull || !existingTags
      ? undefined
      : tagRoom === 0
        ? `A case can hold up to ${CASE_TAG_MAX_COUNT} tags, and this one has ${existingTags.length}. Remove one in the case header to add another here.`
        : `That makes ${CASE_TAG_MAX_COUNT} tags on this case, the most it can hold.`;

  /**
   * False (and points at Tags) while Tags holds text that was typed but not added. The
   * whole field, message included, is scrolled into view: at common laptop heights it
   * sits at the bottom of the scroll area, where a plain focus left the message hidden.
   */
  const tagsSettled = (): boolean => {
    if (!hasTags || !tagDraft.trim()) return true;
    setTagsBlocked(true);
    focusTagInput(tagInputRef.current);
    return false;
  };

  // Which submit closed the dialog (null: cancelled or dismissed). Reset on every open.
  const submitRef = React.useRef<'submit' | 'next' | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    // A fresh dialog starts with no submit recorded. (Not cleared on close: the close
    // focus handler runs after that render and must still see which submit closed it.)
    if (pending) submitRef.current = null;
  }, [pending]);

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
              'min-h-0 flex-1 overflow-y-auto px-6 pb-5',
              wide && '@container/confirm',
            )}
          >
            <div
              className={cn(
                'grid gap-5',
                wide && '@[40rem]/confirm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @[40rem]/confirm:gap-6',
              )}
            >
              <div className="min-w-0 space-y-4">
                {hasDisposition ? (
                  <DispositionPicker
                    value={disposition}
                    onChange={onDispositionChange}
                    verdict={verdict}
                    currentDisposition={currentDisposition}
                    idPrefix="confirm-action-disposition"
                    disabled={acting}
                  />
                ) : null}

                {hasDisposition && aiLine ? (
                  <p
                    data-testid="confirm-action-compare"
                    className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
                  >
                    <Bot className="size-3.5 text-primary" aria-hidden />
                    <span>{aiLine}</span>
                    <ArrowRight className="size-3.5" aria-hidden />
                    <span className="font-medium text-foreground">
                      {committed ? `You are recording: ${dispositionWords(committed)}` : 'Choose an outcome'}
                    </span>
                    {agreementWords(agreement) ? <span>· {agreementWords(agreement)}</span> : null}
                  </p>
                ) : null}

                {showReconcile && implied ? (
                  <div
                    role="status"
                    data-testid="confirm-action-reconcile"
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground"
                  >
                    <span className="min-w-0 flex-1">
                      You graded this a {dispositionWords(implied).toLowerCase()}. Record it as the
                      case disposition?
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7"
                      onClick={() => onDispositionChange(implied)}
                    >
                      Record
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => setReconcileDismissed(true)}
                    >
                      Not now
                    </Button>
                  </div>
                ) : null}

                {pending.fields.includes('resolution') ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Resolution (optional)</Label>
                    <Select
                      value={resolution || '__none__'}
                      onValueChange={(v) => onResolutionChange(v === '__none__' ? '' : v)}
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

                {hasTags ? (
                  <TagInput
                    ref={tagInputRef}
                    label="Tags (optional)"
                    labelClassName="text-xs"
                    placeholder="Add a tag…"
                    value={tags}
                    onChange={onTagsChange}
                    inputValue={tagDraft}
                    onInputValueChange={(text) => {
                      onTagDraftChange(text);
                      setTagsBlocked(false);
                    }}
                    pendingBlocked={tagsBlocked}
                    maxLength={CASE_TAG_MAX_CHARS}
                    max={tagMax}
                    description={tagsFullNote}
                    disabled={acting}
                  />
                ) : null}

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
                ) : null}
              </div>

              <div className="min-w-0 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="confirm-action-note" className="text-xs">
                    Analyst note (optional)
                  </Label>
                  <Textarea
                    id="confirm-action-note"
                    rows={wide ? 4 : 3}
                    placeholder="Add context for the next analyst…"
                    value={note}
                    aria-describedby={notePersists ? 'confirm-action-note-help' : undefined}
                    onChange={(e) => onNoteChange(e.target.value)}
                  />
                  {/* The analyst-comment disclosure: on a close / confirm-FP this note is
                      carried into the resolved-case precedent chunk and read back by the
                      investigator on similar future cases (see DURABLE_CONTEXT_NOTE). */}
                  {notePersists ? (
                    <p
                      id="confirm-action-note-help"
                      className="text-xs leading-relaxed text-muted-foreground"
                    >
                      {DURABLE_CONTEXT_NOTE}
                    </p>
                  ) : null}
                </div>

                {/* Round-7 #10: grade the AI decision inline on close. The agree/override
                    signal is DERIVED from the disposition ↔ verdict diff (no "I agree"
                    button). `confirm_fp` carries no disposition picker, so its committed
                    outcome is FALSE_POSITIVE — feed that so the badge derives correctly. */}
                {hasGrading ? (
                  <GradingSection
                    verdict={verdict}
                    disposition={committed}
                    draft={grading}
                    onChange={onGradingChange}
                  />
                ) : null}
              </div>
            </div>
          </div>

          <DialogFooter
            data-testid="confirm-action-footer"
            className="shrink-0 border-t border-border bg-card px-6 py-4"
          >
            <Button variant="ghost" onClick={onClose} disabled={acting}>
              Cancel
            </Button>
            {offerNext ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!tagsSettled()) return;
                    submitRef.current = 'submit';
                    onSubmit();
                  }}
                  disabled={!canSubmit}
                >
                  {acting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <pending.icon className="h-4 w-4" />}
                  {pending.label}
                </Button>
                <Button
                  onClick={() => {
                    if (!tagsSettled()) return;
                    submitRef.current = 'next';
                    onSubmitAndNext?.();
                  }}
                  disabled={!canSubmit}
                >
                  {acting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {pending.key === 'resolve' ? 'Resolve & next' : 'Close & next'}
                </Button>
              </>
            ) : (
              <Button
                variant={pending.variant === 'outline' ? 'default' : pending.variant}
                onClick={() => {
                  if (!tagsSettled()) return;
                  submitRef.current = 'submit';
                  onSubmit();
                }}
                disabled={!canSubmit}
              >
                {acting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <pending.icon className="h-4 w-4" />}
                {pending.label}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};

export default ConfirmActionDialog;
