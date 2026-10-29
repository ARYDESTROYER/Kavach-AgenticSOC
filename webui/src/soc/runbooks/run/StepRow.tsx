/**
 * One runbook step in a phase list (Round 14, SPEC §4.10.11): a status mark, the number
 * and title, the kind, who has it and "Optional" for a step that is not required. The row
 * is a disclosure button; opened, it shows Instructions, Focus, Escalate if and Benign if,
 * the evidence, the AI draft, Your note, the recorded decision or action with its approval,
 * and the step's buttons, with Reopen step in the footer once it is finished.
 *
 * Two tab stops at most per row: the status mark, when it can act on its own (Mark step N
 * done, Reopen step N), and the row. The step the Next step card shows is one quiet line,
 * "Shown above". Runbook text is Published operator text; run data (notes, reasons, lookup
 * values) is rendered as text (#9). Nothing here changes the case (#3).
 */
import * as React from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Markdown } from '@/soc/components/Markdown';
import { KindChip, PersonMark, ProvenanceChip, StatusMark } from '@/soc/runbooks/shared';

import { useRunbookRun } from './context';
import { LookupEvidence } from './LookupEvidence';
import {
  actorName,
  displayStatus,
  isFinished,
  isWaiting,
  lookupResultOf,
  needsNoteBeforeDone,
  runWorkable,
  statusLine,
  utcTime,
  type NumberedStep,
} from './model';
import { ReasonDialog } from './ReasonDialog';
import { StepActions } from './StepActions';
import {
  ActionRecordForm,
  ActionRecordView,
  AddEvidenceLink,
  AiDraftBox,
  DecisionPicker,
  EvidenceLinks,
  FocusLine,
  FrameworkRefs,
  Implications,
  NoteField,
  SavedNote,
  keepNoteFocus,
  noteKey,
} from './StepParts';
import { useStepEditor } from './useStepEditor';

/** The note a step shows after a refused or stale write. */
export function StepNote({ stepId }: { stepId: string }) {
  const ctx = useRunbookRun();
  const note = ctx.stepNote(stepId);
  if (!note) return null;
  return (
    <p
      role={note.tone === 'error' ? 'alert' : 'status'}
      data-step-note={note.tone}
      className={cn('text-xs', note.tone === 'error' ? 'text-critical-text' : 'font-medium text-warning-text')}
    >
      {note.text}
    </p>
  );
}

/**
 * A recorded action with its approval (Approve, and Reject asking a reason), shared by the
 * Next step card and an opened row. Approve is offered to a holder of `runbooks:run` who
 * holds the step's approval role (or whose roles are not known yet: the server decides)
 * and who did not record the action.
 */
export function ActionRecordBlock({ step, state }: { step: NumberedStep['step']; state: NumberedStep['state'] }) {
  const ctx = useRunbookRun();
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectError, setRejectError] = React.useState<string | null>(null);
  const approveRef = React.useRef<HTMLDivElement | null>(null);
  const role = state.approval?.required_role ?? step.approval_role;
  const canApprove = ctx.canRun && runWorkable(ctx.run) && ctx.holdsRole(role) !== false;
  return (
    <div ref={approveRef}>
      <ActionRecordView
        step={step}
        state={state}
        nameOf={ctx.nameOf}
        currentUser={ctx.currentUser}
        canApprove={canApprove}
        busy={ctx.busy === `${step.id}:approval`}
        onApprove={() => void ctx.decideApproval(step.id, 'approve')}
        onReject={() => setRejectOpen(true)}
      />
      <ReasonDialog
        open={rejectOpen}
        onOpenChange={(open) => {
          setRejectOpen(open);
          if (!open) setRejectError(null);
        }}
        title="Reject this action?"
        description={step.title}
        label="Why are you rejecting it?"
        submitLabel="Reject"
        error={rejectError}
        // After a reject the buttons are gone: the form to record it again, or (when the
        // step is now the Next step) the card's heading.
        returnFocusTo={() =>
          approveRef.current?.parentElement?.querySelector<HTMLElement>('[data-approval] button, [data-action-form] input') ??
          document.querySelector<HTMLElement>('[data-next-step-heading]')
        }
        onSubmit={async (reason) => {
          const outcome = await ctx.decideApproval(step.id, 'reject', reason);
          if (!outcome.ok && !outcome.conflict) {
            setRejectError(outcome.message ?? 'The approval could not be saved.');
            return false;
          }
          return true;
        }}
      />
    </div>
  );
}

/** The opened content of a step (the card shows its own subset). */
export function StepDetail({ item, onFinished }: { item: NumberedStep; onFinished?: () => void }) {
  const ctx = useRunbookRun();
  const { step, state } = item;
  const editor = useStepEditor(step, state);
  const idBase = `rb-${ctx.run.run_id}-${step.id}`;
  const finished = isFinished(state);
  const waiting = isWaiting(state);
  // Only an abandoned run is read only; a completed run keeps its steps workable.
  const workable = ctx.canRun && runWorkable(ctx.run);
  const editable = workable && !finished && !waiting;
  const isAction = step.kind === 'action' || step.kind === 'record';
  const rejected = state.approval?.status === 'rejected';
  const busy = Boolean(ctx.busy);
  const result = lookupResultOf(state);
  const lookupTool = step.lookup?.tool ?? result?.tool ?? null;
  const canSeeTool = lookupTool ? ctx.canUseTool(lookupTool) : true;
  const lookup = useLookupRun(step.id, Boolean(result));
  const draftPending = Boolean(state.ai_draft && !state.ai_draft.confirmed);
  // Text typed before the step changed under it (a stale save) stays editable here, even
  // on a step someone else finished, so it can be saved or cleared, never lost.
  const showNoteField = !draftPending && (editable || (workable && editor.noteDirty));

  return (
    <div className="space-y-3" data-step-detail={step.id}>
      {step.instructions ? (
        <div className="text-sm text-foreground">
          <Markdown text={step.instructions} className="space-y-1" />
        </div>
      ) : null}
      <FocusLine step={step} />
      <Implications step={step} />

      {step.kind === 'lookup' ? (
        <LookupEvidence
          step={step}
          result={result}
          canRunLookup={ctx.canRun && canSeeTool}
          canSeeTool={canSeeTool}
          runWorkable={runWorkable(ctx.run)}
          busy={ctx.busy === `${step.id}:lookup`}
          nameOf={ctx.nameOf}
          ranAgainNote={lookup.ranAgain}
          stepFinished={finished}
          attachedAt={ctx.run.attached_at}
          onRun={lookup.run}
        />
      ) : null}

      <EvidenceLinks state={state} />
      {editable && step.evidence === 'note_or_attachment' ? (
        <AddEvidenceLink
          idBase={idBase}
          disabled={!editable}
          busy={busy}
          onAdd={async (value) => Boolean((await editor.addLink(value))?.ok)}
        />
      ) : null}

      <AiDraftBox
        state={state}
        editing={editor.editingDraft}
        text={editor.draftText}
        onText={editor.setDraftText}
        fieldId={`${idBase}-draft`}
      />

      {step.kind === 'decision' && state.decision ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-sm text-foreground">
          Decided <span className="font-medium">{state.decision.label}</span>
          <span className="text-muted-foreground"> · {statusLine(step, state, ctx.nameOf).replace(/^Decided "[^"]*" · /, '')}</span>
        </p>
      ) : null}
      {step.kind === 'decision' && editable ? (
        <DecisionPicker
          run={ctx.run}
          step={step}
          value={editor.choice}
          onChange={editor.setChoice}
          onRecord={() => void editor.recordDecision({ announce: true }).then((r) => r?.ok && onFinished?.())}
          onLeaveNote={editor.leaveNote}
          busy={ctx.busy === `${step.id}:update`}
          disabled={busy}
        />
      ) : null}

      {isAction && state.action_record ? <ActionRecordBlock step={step} state={state} /> : null}
      {isAction && (!state.action_record || rejected) && editable ? (
        <ActionRecordForm step={step} draft={editor.action} onChange={editor.setAction} disabled={busy} idBase={idBase} />
      ) : null}

      {showNoteField ? (
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
      ) : (
        <SavedNote text={state.note} />
      )}

      <FrameworkRefs step={step} />
      <StepNote stepId={step.id} />

      {finished || waiting ? (
        <div className="flex flex-wrap items-center gap-x-2 rounded-md bg-muted/40 px-3 py-1.5">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{statusLine(step, state, ctx.nameOf)}</p>
          <StepActions step={step} state={state} editor={editor} variant="row" />
        </div>
      ) : (
        <StepActions step={step} state={state} editor={editor} variant="row" onFinished={onFinished} />
      )}
    </div>
  );
}

/** "Ran again at 14:31 UTC; the earlier result was replaced." */
export function ranAgainSentence(ranAt: string | null | undefined, now: Date = new Date()): string {
  const when = utcTime(ranAt, now);
  return when ? `Ran again at ${when}; the earlier result was replaced.` : 'Ran again; the earlier result was replaced.';
}

/**
 * Run a Lookup step's lookup (Run lookup, Run again), for the Next step card and an opened
 * row alike. A run that replaced an earlier result says so next to the result and in the
 * live region: "Ran again at 14:31 UTC; the earlier result was replaced." (SPEC §4.10.8).
 */
export function useLookupRun(stepId: string, hasResult: boolean): { ranAgain: string | null; run: () => void } {
  const ctx = useRunbookRun();
  const [ranAgain, setRanAgain] = React.useState<string | null>(null);
  const run = () => {
    const hadResult = hasResult;
    void ctx.runLookup(stepId).then((outcome) => {
      if (!outcome.ok || !hadResult) return;
      const fresh = outcome.update?.run.steps?.[stepId];
      const ranAt = (fresh ? lookupResultOf(fresh) : null)?.ran_at ?? new Date().toISOString();
      const text = ranAgainSentence(ranAt);
      setRanAgain(text);
      ctx.announce(text);
    });
  };
  return { ranAgain, run };
}

export interface StepRowProps {
  item: NumberedStep;
  expanded: boolean;
  onToggle: () => void;
  /** The step is the Next step card above: one quiet line. */
  shownAbove?: boolean;
  onShowAbove?: () => void;
}

export function StepRow({ item, expanded, onToggle, shownAbove = false, onShowAbove }: StepRowProps) {
  const ctx = useRunbookRun();
  const { step, state, number } = item;
  const display = displayStatus(state);
  const finished = isFinished(state);
  const detailId = `rb-step-${ctx.run.run_id}-${step.id}`;
  const rowRef = React.useRef<HTMLButtonElement | null>(null);
  const markRef = React.useRef<HTMLButtonElement | null>(null);

  if (shownAbove) {
    return (
      <li data-step={step.id} data-step-status={display} data-shown-above="" className="border-b border-border/70 last:border-b-0">
        <button
          type="button"
          onClick={onShowAbove}
          className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @[40rem]/run:px-4"
        >
          <StatusMark status={display} size="sm" className="mx-0.5" />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            <span className="mr-1.5 text-xs tabular-nums">{number}</span>
            {step.title}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
            <ArrowUp className="size-3" aria-hidden />
            Shown above
          </span>
        </button>
      </li>
    );
  }

  // The mark acts on its own only when one press can finish or reopen the step.
  const quickDone =
    ctx.canRun &&
    runWorkable(ctx.run) &&
    !finished &&
    display !== 'waiting' &&
    (step.kind === 'check' || step.kind === 'lookup') &&
    !(state.ai_draft && !state.ai_draft.confirmed) &&
    !needsNoteBeforeDone(step, state);
  const quickReopen = ctx.canRun && runWorkable(ctx.run) && finished;
  const busy = Boolean(ctx.busy);
  const quick = (status: 'done' | 'todo') => {
    if (busy) return;
    void ctx
      .updateStep(step.id, state.revision ?? 0, { status }, status === 'done' ? { announce: true } : {})
      .then(() => markRef.current?.focus());
  };

  return (
    <li data-step={step.id} data-step-status={display} className="relative border-b border-border/70 last:border-b-0">
      <div className="flex items-start gap-3 px-3 py-3 @[40rem]/run:px-4">
        {quickDone || quickReopen ? (
          <button
            ref={markRef}
            type="button"
            className="mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            aria-label={quickReopen ? `Reopen step ${number}` : `Mark step ${number} done`}
            aria-busy={busy || undefined}
            onMouseDown={keepNoteFocus}
            onClick={() => quick(quickReopen ? 'todo' : 'done')}
          >
            <StatusMark status={display} />
          </button>
        ) : (
          <span className="mt-px inline-flex size-6 shrink-0 items-center justify-center">
            <StatusMark status={display} />
          </span>
        )}
        <button
          ref={rowRef}
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={detailId}
          data-step-button={step.id}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={cn('min-w-0 text-sm font-medium', finished ? 'text-muted-foreground' : 'text-foreground')}>
                <span className="mr-1.5 text-xs font-normal tabular-nums text-muted-foreground">{number}</span>
                {step.title}
              </span>
              {step.required ? null : <span className="text-xs text-muted-foreground">Optional</span>}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <KindChip kind={step.kind} />
              <span
                className={cn(
                  'min-w-0 [overflow-wrap:anywhere]',
                  display === 'waiting' && 'font-medium text-warning-text',
                  display === 'blocked' && 'font-medium text-critical-text',
                )}
              >
                {statusLine(step, state, ctx.nameOf)}
              </span>
              {state.ai_draft && !state.ai_draft.confirmed ? <ProvenanceChip kind="ai" /> : null}
            </span>
          </span>
          {state.assignee && !finished ? (
            <span className="hidden shrink-0 items-center gap-1.5 pt-0.5 text-xs text-muted-foreground @[34rem]/run:inline-flex">
              <PersonMark name={actorName(state.assignee, ctx.nameOf)} />
              {actorName(state.assignee, ctx.nameOf)}
            </span>
          ) : null}
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground" aria-hidden>
            <ChevronDown className={cn('size-4 transition-transform duration-fast', expanded && 'rotate-180')} />
          </span>
        </button>
      </div>
      {expanded ? (
        <div id={detailId} className="pb-4 pl-12 pr-3 @[40rem]/run:pl-[3.25rem] @[40rem]/run:pr-4">
          <StepDetail item={item} onFinished={() => rowRef.current?.focus()} />
        </div>
      ) : null}
    </li>
  );
}


