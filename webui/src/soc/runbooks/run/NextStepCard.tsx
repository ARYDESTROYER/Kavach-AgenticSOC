/**
 * The Next step card (Round 14, SPEC §4.10.11, C10 B): the first open step, ready to act
 * on, pinned on top of the runbook on the Response tab (the Brief's Next step row is its
 * short twin since Round 16).
 *
 * The pinned card: a 3px primary rail and a neutral border; the step's phase and kind; its
 * title as an `h3` that takes focus after Confirm, Mark done or Record decision (the polite
 * live region says "Step 5 done. Next, step 6: ..."); its focus line; a lookup's evidence;
 * the AI draft with Confirm, Edit note, Not applicable, Blocked and Assign (a More menu on a
 * narrow pane). While the draft waits to be read those buttons come straight under the
 * question and the draft follows in a four-line preview ("Show the whole draft"), so
 * Confirm keeps one place however long the draft is; editing it puts the text field first
 * and "Confirm note and mark done" under it. Only the draft moves: the buttons are never
 * rebuilt, and focus that a landing draft takes away (Draft note) goes to the heading.
 * For a Decision, the options and Record decision, with the same Not applicable, Blocked
 * and Assign; for an Action, the recorded action and its approval (a rejected one can be
 * recorded again). "Escalate if and benign if" keeps the criteria one click away so
 * Confirm stays high; on a narrow pane the focus line folds in there too.
 * When no required step is left to act on the card says so: "All required steps are
 * done." with "Close case" and the optional steps left (a completed run stays workable),
 * or that the rest wait for approval.
 *
 * Runbook text is Published operator text, run data is text (#9); nothing here changes
 * the case, and Close case only opens the close dialog (#3).
 */
import * as React from 'react';
import { ArrowRight, CheckCircle2, ChevronDown, Clock } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import type { RunbookRun } from '@/lib/types-runbooks';
import { KindChip, PersonMark, PHASE_LABEL } from '@/soc/runbooks/shared';

import { useRunbookRun } from './context';
import { LookupEvidence } from './LookupEvidence';
import {
  actorName,
  isWaiting,
  lookupResultOf,
  nextStep,
  openSteps,
  runProgress,
  runWorkable,
  type NumberedStep,
} from './model';
import { StepActions } from './StepActions';
import { ActionRecordBlock, StepNote, useLookupRun } from './StepRow';
import { ActionRecordForm, AiDraftBox, DecisionPicker, FocusLine, FrameworkRefs, Implications, NoteField, noteKey } from './StepParts';
import { useKeepFocus } from './useKeepFocus';
import { useStepEditor } from './useStepEditor';

/**
 * Focus a heading without jumping, then bring it into view if it is out of sight. On the
 * Next step card an AI draft waiting to be read comes into view first, then the heading,
 * so landing on the card ("Review draft", a draft just made) shows the draft too: it
 * follows the buttons, and on a phone it would otherwise stay below the fold.
 */
export function focusHeading(el: HTMLElement | null | undefined): void {
  if (!el) return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
  const draft = el.matches('[data-next-step-heading]')
    ? el.closest('[data-next-step-card]')?.querySelector<HTMLElement>('[data-ai-draft]')
    : null;
  draft?.scrollIntoView?.({ block: 'nearest' });
  el.scrollIntoView?.({ block: 'nearest' });
}

const CardFrame = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(function CardFrame(
  { children, className, ...rest },
  ref,
) {
  return (
    <section
      ref={ref}
      {...rest}
      className={cn('relative overflow-hidden rounded-xl border border-border bg-card', className)}
    >
      <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-primary" aria-hidden />
      {children}
    </section>
  );
});

function CardHeader({ item, total, compact }: { item: NumberedStep; total: number; compact: boolean }) {
  const ctx = useRunbookRun();
  const { step, state } = item;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
        <ArrowRight className="size-3.5" aria-hidden />
        Next step
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {compact ? `step ${item.number} of ${total}` : `${PHASE_LABEL[step.phase]} · step ${item.number} of ${total}`}
      </span>
      <KindChip kind={step.kind} />
      {!compact ? <span className="text-xs text-muted-foreground">{step.required ? 'Required' : 'Optional'}</span> : null}
      {state.status === 'blocked' ? <span className="text-xs font-medium text-critical-text">Blocked · {state.reason}</span> : null}
      {!compact && (step.target_minutes || state.assignee) ? (
        <span className="ml-auto inline-flex items-center gap-3 text-xs text-muted-foreground">
          {step.target_minutes ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Clock className="size-3" aria-hidden />
              Target {step.target_minutes.toLocaleString()} min
            </span>
          ) : null}
          {state.assignee ? (
            <span className="inline-flex items-center gap-1.5">
              <PersonMark name={actorName(state.assignee, ctx.nameOf)} />
              {actorName(state.assignee, ctx.nameOf)}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Escalate if, Benign if and the step's framework references, collapsed; on a narrow pane
 * the focus line too ("Focus and criteria"), so the primary action stays above the fold.
 */
function CriteriaDisclosure({ item, withFocus = false }: { item: NumberedStep; withFocus?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const { step } = item;
  const focus = withFocus && Boolean(step.focus);
  if (!focus && !step.escalate_if && !step.benign_if && !step.react && !step.d3fend) return null;
  const criteria = Boolean(step.escalate_if || step.benign_if);
  const label = focus ? (criteria ? 'Focus and criteria' : 'Focus') : 'Escalate if and benign if';
  return (
    <div className="border-t border-border/70 pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-6 items-center gap-1 rounded-sm text-xs font-medium text-secondary-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={cn('size-3.5 transition-transform duration-fast', open && 'rotate-180')} aria-hidden />
        {label}
      </button>
      <div id={id} hidden={!open} className="mt-2 space-y-2">
        {focus ? <FocusLine step={step} /> : null}
        <Implications step={step} />
        <FrameworkRefs step={step} />
      </div>
    </div>
  );
}

/** The actionable body of the pinned card for one step. */
function PinnedStep({ item, total, compact }: { item: NumberedStep; total: number; compact: boolean }) {
  const ctx = useRunbookRun();
  const { step, state } = item;
  const editor = useStepEditor(step, state);
  const idBase = `rb-card-${ctx.run.run_id}-${step.id}`;
  const busy = Boolean(ctx.busy);
  const draftPending = Boolean(state.ai_draft && !state.ai_draft.confirmed);
  const result = lookupResultOf(state);
  const tool = step.lookup?.tool ?? result?.tool ?? null;
  const canSeeTool = tool ? ctx.canUseTool(tool) : true;
  const lookup = useLookupRun(step.id, Boolean(result));
  const workable = runWorkable(ctx.run);
  const editable = ctx.canRun && workable;
  const isAction = step.kind === 'action' || step.kind === 'record';
  // A rejected action can be recorded again (the server allows it): the record and the
  // rejection stay above the form.
  const rejected = state.approval?.status === 'rejected';
  // While an AI draft waits to be read, its actions (Confirm, Edit note, Not applicable,
  // Blocked, Assign) come straight under the step's question and the draft follows in a
  // four-line preview, so Confirm keeps one place however long the draft is (SPEC
  // §4.10.11: y 567 or less at 1440 by 900, above the fold at 390 by 844). Editing the
  // draft is a form like the note field: the text first, then "Confirm note and mark done".
  // Only the draft box moves between the two places; the buttons keep one place in the
  // tree, so a draft landing (or Edit note) never remounts them: an open reason dialog
  // keeps what was typed, an open menu stays open and a focused button keeps its focus.
  const reviewing = draftPending && !editor.editingDraft;
  const draftFieldId = `${idBase}-draft`;
  const draftLabelId = `${idBase}-draft-label`;
  const [draftExpanded, setDraftExpanded] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  // The draft box moves with the mode, so focus follows the press: into the draft's field
  // on Edit note, back to Edit note on Cancel edit.
  const refocus = React.useRef<'field' | 'edit' | null>(null);
  const setEditingDraft = editor.setEditingDraft;
  const onEditDraft = React.useCallback(
    (on: boolean) => {
      refocus.current = on ? 'field' : 'edit';
      setEditingDraft(on);
    },
    [setEditingDraft],
  );
  React.useLayoutEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    if (target === 'field') {
      const field = document.getElementById(draftFieldId);
      if (field instanceof HTMLTextAreaElement) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
        // The caret sits at the end of the draft: show it there, not the field's top.
        field.scrollTop = field.scrollHeight;
      }
      return;
    }
    rootRef.current?.querySelector<HTMLElement>('[data-edit-draft]')?.focus();
  }, [editor.editingDraft, draftFieldId]);
  // A draft landing takes Draft note (and the note field) off the card: focus they held
  // goes to the step's heading, as after Confirm, so pressing Enter again never confirms a
  // draft nobody has read; the draft comes into view with it.
  const keepFocus = useKeepFocus(draftPending, () =>
    focusHeading(rootRef.current?.querySelector<HTMLElement>('[data-next-step-heading]')),
  );

  const draftBox = (
    <AiDraftBox
      state={state}
      editing={editor.editingDraft}
      text={editor.draftText}
      onText={editor.setDraftText}
      large={!compact}
      fieldId={draftFieldId}
      labelId={draftLabelId}
      preview
      expanded={draftExpanded}
      onExpandedChange={setDraftExpanded}
    />
  );

  return (
    <div ref={rootRef} {...keepFocus} className="px-4 py-3 @[40rem]/run:px-5" data-next-step={step.id}>
      <CardHeader item={item} total={total} compact={compact} />
      <h3
        tabIndex={-1}
        data-next-step-heading=""
        className="mt-1 scroll-mt-4 rounded-sm text-md font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        {step.title}
      </h3>
      {compact ? null : <FocusLine step={step} className="mt-1" />}
      <div className="mt-2 space-y-2">
        {step.kind === 'lookup' ? (
          <LookupEvidence
            step={step}
            result={result}
            canRunLookup={ctx.canRun && canSeeTool}
            canSeeTool={canSeeTool}
            runWorkable={workable}
            busy={ctx.busy === `${step.id}:lookup`}
            nameOf={ctx.nameOf}
            ranAgainNote={lookup.ranAgain}
            attachedAt={ctx.run.attached_at}
            compact={compact}
            onRun={lookup.run}
          />
        ) : null}
        {/* Editing: the field first, "Confirm note and mark done" under it. */}
        {reviewing ? null : draftBox}
        {step.kind === 'decision' && editable ? (
          <DecisionPicker
            run={ctx.run}
            step={step}
            value={editor.choice}
            onChange={editor.setChoice}
            onRecord={() => void editor.recordDecision({ announce: true, focusNext: true })}
            onLeaveNote={editor.leaveNote}
            busy={ctx.busy === `${step.id}:update`}
            disabled={busy}
          />
        ) : null}
        {isAction && state.action_record ? <ActionRecordBlock step={step} state={state} /> : null}
        {isAction && (!state.action_record || rejected) && editable ? (
          <ActionRecordForm
            step={step}
            draft={editor.action}
            onChange={editor.setAction}
            disabled={busy}
            idBase={idBase}
            roleLabels={ctx.roleLabels}
          />
        ) : null}
        {editable && !draftPending && step.kind !== 'decision' && step.evidence !== 'none' ? (
          <NoteField
            id={`${idBase}-note`}
            noteKey={noteKey(ctx.run.run_id, step.id)}
            step={step}
            value={editor.note}
            onChange={editor.setNote}
            onSave={() => void editor.saveNote()}
            onLeave={editor.leaveNote}
            dirty={editor.noteDirty}
            busy={ctx.busy === `${step.id}:update`}
            writing={busy}
          />
        ) : null}
        <StepNote stepId={step.id} />
        <StepActions
          step={step}
          state={state}
          editor={editor}
          variant="card"
          compact={compact}
          draftLabelId={draftPending ? draftLabelId : undefined}
          onEditDraft={onEditDraft}
        />
        {/* Reading: the draft follows the buttons that act on it. */}
        {reviewing ? draftBox : null}
        <CriteriaDisclosure item={item} withFocus={compact} />
      </div>
    </div>
  );
}

/** One list of steps left on the card, each opening its row. */
function StepsLeft({ label, steps }: { label: string; steps: NumberedStep[] }) {
  const ctx = useRunbookRun();
  if (!steps.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <ul className="space-y-0.5">
        {steps.map((s) => (
          <li key={s.step.id}>
            <button
              type="button"
              onClick={() => ctx.revealStep(s.step.id)}
              className="min-h-6 rounded-sm text-left text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{s.number}</span>
              {s.step.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The card when no required step is left to act on: every required step is done (Close
 * case, and the optional steps left), or the rest wait for approval.
 */
function NothingNext({ run, onCloseCase }: { run: RunbookRun; onCloseCase?: () => void }) {
  const open = openSteps(run);
  const waiting = open.filter((s) => isWaiting(s.state));
  const optional = open.filter((s) => !s.step.required && !isWaiting(s.state));
  // From the run itself, so the card agrees with `nextStep` (both read the same steps).
  const allRequired = runProgress(run).required_open <= 0;
  return (
    <div className="px-4 py-3 @[40rem]/run:px-5" data-next-step="none">
      <h3
        tabIndex={-1}
        data-next-step-heading=""
        className="flex items-center gap-2 rounded-sm text-md font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        <CheckCircle2 className={cn('size-4', allRequired ? 'text-success-text' : 'text-warning-text')} aria-hidden />
        {allRequired ? 'All required steps are done.' : 'The remaining required steps wait for approval.'}
      </h3>
      {allRequired && onCloseCase ? (
        <div className="mt-2.5">
          <Button size="sm" onClick={onCloseCase}>
            Close case
          </Button>
        </div>
      ) : null}
      {waiting.length || optional.length ? (
        <div className="mt-3 space-y-3">
          <StepsLeft label="Waiting for approval" steps={waiting} />
          <StepsLeft label="Optional steps left" steps={optional} />
        </div>
      ) : null}
    </div>
  );
}

/** The pinned Next step card of the runbook on the Response tab (needs the run context). */
export function NextStepCard({
  compact = false,
  onCloseCase,
  className,
}: {
  compact?: boolean;
  onCloseCase?: () => void;
  className?: string;
}) {
  const ctx = useRunbookRun();
  const run = ctx.run;
  const cardRef = React.useRef<HTMLElement | null>(null);
  // After a step finished from the card, focus lands on the NEW Next step heading (the
  // card re-renders with the next step first, so the heading is looked up after render).
  const lastTick = React.useRef(ctx.focusTick);
  React.useEffect(() => {
    if (ctx.focusTick === lastTick.current) return;
    lastTick.current = ctx.focusTick;
    focusHeading(cardRef.current?.querySelector<HTMLElement>('[data-next-step-heading]') ?? null);
  }, [ctx.focusTick]);
  // An abandoned run is read only and has nothing next; a completed one keeps the card.
  if (!runWorkable(run)) return null;
  const total = run.snapshot.steps.length;
  const item = nextStep(run);
  return (
    <CardFrame ref={cardRef} aria-label="Next step" data-next-step-card="" className={className}>
      {item ? (
        <PinnedStep key={`${item.step.id}`} item={item} total={total} compact={compact} />
      ) : (
        <NothingNext run={run} onCloseCase={onCloseCase} />
      )}
    </CardFrame>
  );
}

