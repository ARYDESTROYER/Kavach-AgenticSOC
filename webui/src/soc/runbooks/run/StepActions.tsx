/**
 * The buttons of one runbook step inside a case (Round 14, SPEC §4.10.11): Mark done (or
 * Confirm and mark done for an AI draft, Record action for an Action), Edit note, Draft
 * note, Not applicable and Blocked (each asks a reason), Assign, and Reopen step.
 *
 * Only a holder of `runbooks:run` sees them, on a run that is not abandoned (a completed
 * run keeps its optional steps and Reopen step). The AI may draft a note; only a person marks
 * a step Done, Not applicable or Blocked (§4.10.10). A disabled-looking button keeps its
 * focus and says why (`aria-disabled` plus a hint), so a keyboard user is never stranded.
 * Nothing here changes the case (#3); every change is audited by the server (#2).
 */
import * as React from 'react';
import { Bot, CircleSlash, MoreHorizontal, OctagonPause, PencilLine, RotateCcw, UserCheck } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import type { AiCallEstimate, RunbookStep, StepState } from '@/lib/types-runbooks';

import { useRunbookRun, type FinishOptions } from './context';
import { actorName, isFinished, isWaiting, needsNoteBeforeDone, runWorkable } from './model';
import { ReasonDialog } from './ReasonDialog';
import { carriesNote, keepNoteFocus, noteKey } from './StepParts';
import type { StepEditor } from './useStepEditor';
import { ARIA_DISABLED_LOOK } from './ui';

function estimateText(estimate: AiCallEstimate | null): string {
  if (!estimate) return '';
  const parts: string[] = [];
  if (estimate.total_tokens > 0) parts.push(`≈ ${estimate.total_tokens.toLocaleString()} tokens`);
  if (typeof estimate.cost === 'number') {
    const cost = estimate.cost > 0 && estimate.cost < 0.0001 ? '<$0.0001' : `$${estimate.cost.toFixed(4)}`;
    parts.push(`≈ ${cost}${estimate.simulated ? ' simulated' : ''}`);
  }
  return parts.join(' · ');
}

export interface StepActionsProps {
  step: RunbookStep;
  state: StepState;
  editor: StepEditor;
  /** `card`: the Next step card (focus moves to the new Next step after it finishes). */
  variant: 'card' | 'row';
  /** Fold Not applicable, Blocked and Assign into a More menu (a narrow pane). */
  compact?: boolean;
  /** Called after the step finished through these buttons (the row keeps focus itself). */
  onFinished?: () => void;
  className?: string;
}

export function StepActions({ step, state, editor, variant, compact = false, onFinished, className }: StepActionsProps) {
  const ctx = useRunbookRun();
  const [reasonFor, setReasonFor] = React.useState<'not_applicable' | 'blocked' | null>(null);
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [estimate, setEstimate] = React.useState<AiCallEstimate | null>(null);
  const estimateAsked = React.useRef(false);
  const moreRef = React.useRef<HTMLButtonElement | null>(null);
  const primaryRef = React.useRef<HTMLButtonElement | null>(null);
  const hintId = React.useId();
  const estimateId = React.useId();

  if (!ctx.canRun || !runWorkable(ctx.run)) return null;

  const finished = isFinished(state);
  const waiting = isWaiting(state);
  const busyKey = ctx.busy;
  const busy = Boolean(busyKey);
  const mine = (what: string) => busyKey === `${step.id}:${what}`;
  const finish: FinishOptions = variant === 'card' ? { announce: true, focusNext: true } : { announce: true };
  const after = (ok: boolean) => {
    if (ok) onFinished?.();
  };

  const reopen = (
    <Button
      variant="ghost"
      size="sm"
      className={cn('h-7 px-2 text-xs', ARIA_DISABLED_LOOK)}
      onClick={busy ? undefined : () => void editor.setStatus('todo', undefined, {})}
      aria-busy={mine('update') || undefined}
      aria-disabled={busy || undefined}
    >
      <RotateCcw aria-hidden />
      Reopen step
    </Button>
  );

  if (finished || waiting) {
    return <div className={cn('flex flex-wrap items-center gap-2', className)}>{reopen}</div>;
  }

  const draft = state.ai_draft && !state.ai_draft.confirmed ? state.ai_draft : null;
  const isDecision = step.kind === 'decision';
  const isAction = step.kind === 'action' || step.kind === 'record';
  const noteMissing = !draft && !isDecision && !isAction && needsNoteBeforeDone(step, { ...state, note: editor.note });
  const actionEmpty = isAction && !editor.action.where.trim() && !editor.action.outcome.trim();
  const blocked = state.status === 'blocked';
  // Mark done and Record action send an unsaved note in their own write (`carriesNote`).
  const key = noteKey(ctx.run.run_id, step.id);

  let primary: React.ReactNode = null;
  if (draft) {
    primary = (
      <Button
        ref={primaryRef}
        size="sm"
        className={cn(variant === 'card' && 'w-full sm:w-auto', ARIA_DISABLED_LOOK)}
        onClick={busy ? undefined : () => void editor.confirmDraft(finish).then((r) => after(Boolean(r?.ok)))}
        aria-busy={mine('confirm') || undefined}
        aria-disabled={busy || undefined}
        data-step-primary=""
      >
        {editor.editingDraft ? 'Confirm note and mark done' : 'Confirm and mark done'}
      </Button>
    );
  } else if (isAction) {
    primary = (
      <Button
        ref={primaryRef}
        size="sm"
        className={cn(variant === 'card' && 'w-full sm:w-auto', ARIA_DISABLED_LOOK)}
        onClick={busy || actionEmpty ? undefined : () => void editor.recordAction(finish).then((r) => after(Boolean(r?.ok)))}
        aria-busy={mine('update') || undefined}
        aria-disabled={busy || actionEmpty || undefined}
        aria-describedby={actionEmpty ? hintId : undefined}
        data-step-primary=""
        {...carriesNote(key, !busy && !actionEmpty, editor.leaveNote)}
      >
        Record action
      </Button>
    );
  } else if (!isDecision) {
    primary = (
      <Button
        ref={primaryRef}
        size="sm"
        className={cn(variant === 'card' && 'w-full sm:w-auto', ARIA_DISABLED_LOOK)}
        onClick={busy || noteMissing ? undefined : () => void editor.markDone(finish).then((r) => after(r.ok))}
        aria-busy={mine('update') || undefined}
        aria-disabled={busy || noteMissing || undefined}
        aria-describedby={noteMissing ? hintId : undefined}
        data-step-primary=""
        {...carriesNote(key, !busy && !noteMissing, editor.leaveNote)}
      >
        Mark done
      </Button>
    );
  }

  const offerDraft = step.kind === 'check' && ctx.aiDrafts && !draft;
  const estimateLine = estimateText(estimate);
  const askEstimate = () => {
    if (estimateAsked.current) return;
    estimateAsked.current = true;
    void ctx.estimateDraft(step.id).then(setEstimate);
  };

  const statusButtons = compact ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={moreRef} size="sm" variant="outline" aria-label="More step actions">
          <MoreHorizontal aria-hidden />
          More
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={16} className="w-52">
        <DropdownMenuItem onSelect={() => setReasonFor('not_applicable')}>
          <CircleSlash className="h-4 w-4" />
          Not applicable
        </DropdownMenuItem>
        {blocked ? (
          <DropdownMenuItem onSelect={() => void editor.setStatus('in_progress', undefined, {})}>
            <OctagonPause className="h-4 w-4" />
            No longer blocked
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => setReasonFor('blocked')}>
            <OctagonPause className="h-4 w-4" />
            Blocked
          </DropdownMenuItem>
        )}
        {variant === 'card' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <UserCheck className="h-4 w-4" />
                {state.assignee ? `Assigned to ${actorName(state.assignee, ctx.nameOf)}` : 'Assign'}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent collisionPadding={16} className="max-h-72 w-56 overflow-y-auto">
                <AssignItems step={step} state={state} editor={editor} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <>
      {/* Not applicable and Blocked only open their reason dialog, so a save still in
          flight (the note saved on the way out of its field) never swallows the press. */}
      <Button size="sm" variant="ghost" onClick={() => setReasonFor('not_applicable')}>
        <CircleSlash aria-hidden />
        Not applicable
      </Button>
      {blocked ? (
        <Button
          size="sm"
          variant="ghost"
          className={ARIA_DISABLED_LOOK}
          onMouseDown={keepNoteFocus}
          onClick={busy ? undefined : () => void editor.setStatus('in_progress', undefined, {})}
          aria-disabled={busy || undefined}
        >
          <OctagonPause aria-hidden />
          No longer blocked
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setReasonFor('blocked')}>
          <OctagonPause aria-hidden />
          Blocked
        </Button>
      )}
    </>
  );

  return (
    <div className={cn('space-y-1.5', className)} data-step-actions={variant}>
      <div className={cn('flex flex-wrap items-center gap-2', variant === 'card' && compact && 'flex-col items-stretch')}>
        {primary}
        <div className="flex flex-wrap items-center gap-2">
          {draft ? (
            editor.editingDraft ? (
              <Button size="sm" variant="outline" onClick={() => editor.setEditingDraft(false)}>
                Cancel edit
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => editor.setEditingDraft(true)}>
                <PencilLine aria-hidden />
                Edit note
              </Button>
            )
          ) : null}
          {offerDraft ? (
            <Button
              size="sm"
              variant="outline"
              className={ARIA_DISABLED_LOOK}
              onPointerEnter={askEstimate}
              onFocus={askEstimate}
              onMouseDown={keepNoteFocus}
              onClick={busy ? undefined : () => void ctx.draftNote(step.id)}
              aria-busy={mine('draft') || undefined}
              aria-disabled={busy || undefined}
              aria-describedby={estimateLine ? estimateId : undefined}
            >
              <Bot aria-hidden />
              {mine('draft') ? 'Drafting' : 'Draft note'}
            </Button>
          ) : null}
          {statusButtons}
          {variant === 'row' || !compact ? <AssignMenu step={step} state={state} editor={editor} /> : null}
        </div>
      </div>
      {noteMissing || actionEmpty ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {actionEmpty ? 'Say where and what was done to record the action.' : 'Add a note before marking this step done.'}
        </p>
      ) : null}
      {offerDraft && estimateLine ? (
        <p id={estimateId} className="text-xs tabular-nums text-muted-foreground">
          Draft note uses the AI: {estimateLine}
        </p>
      ) : null}
      <ReasonDialog
        open={reasonFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReasonFor(null);
            setReasonError(null);
          }
        }}
        title={reasonFor === 'blocked' ? 'Why is this step blocked?' : 'Why is this step not applicable?'}
        description={step.title}
        label={reasonFor === 'blocked' ? 'What is it waiting on?' : 'Why does it not apply to this case?'}
        placeholder={reasonFor === 'blocked' ? 'For example: waiting for the network team' : 'For example: the account has no MFA'}
        submitLabel={reasonFor === 'blocked' ? 'Mark blocked' : 'Mark not applicable'}
        error={reasonError}
        // The menu item that opened it is gone: back to the More button when it came from
        // there, else to the step's primary action.
        returnFocusTo={() => (compact ? moreRef.current : null) ?? primaryRef.current ?? moreRef.current}
        onSubmit={async (reason) => {
          const status = reasonFor ?? 'not_applicable';
          const result = await editor.setStatus(status, reason, status === 'not_applicable' ? finish : {});
          if (!result.ok && !result.conflict) {
            setReasonError(result.message ?? 'The step could not be saved.');
            return false;
          }
          if (result.ok && status === 'not_applicable') after(true);
          return true;
        }}
      />
    </div>
  );
}

/** The choices of "Assign" (to me, to a teammate, or nobody), for a menu or a submenu. */
function AssignItems({ step, state, editor }: { step: RunbookStep; state: StepState; editor: StepEditor }) {
  const ctx = useRunbookRun();
  const users = ctx.users.filter((u) => u.active !== false).slice(0, 25);
  const busy = Boolean(ctx.busy);
  return (
    <>
      <DropdownMenuLabel>Assign {step.title.length > 40 ? 'this step' : `"${step.title}"`}</DropdownMenuLabel>
      {ctx.currentUser && state.assignee !== ctx.currentUser ? (
        <DropdownMenuItem disabled={busy} onSelect={() => void editor.assign(ctx.currentUser)}>
          Assign to me
        </DropdownMenuItem>
      ) : null}
      {users
        .filter((u) => u.username !== ctx.currentUser && u.username !== state.assignee)
        .map((u) => (
          <DropdownMenuItem key={u.username} disabled={busy} onSelect={() => void editor.assign(u.username)}>
            {u.display_name || u.username}
          </DropdownMenuItem>
        ))}
      {state.assignee ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onSelect={() => void editor.assign(null)}>
            Unassign
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/** "Assign": to me, to a teammate, or nobody. */
export function AssignMenu({ step, state, editor }: { step: RunbookStep; state: StepState; editor: StepEditor }) {
  const ctx = useRunbookRun();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={state.assignee ? `Assigned to ${actorName(state.assignee, ctx.nameOf)}. Change` : 'Assign'}>
          <UserCheck aria-hidden />
          {state.assignee ? actorName(state.assignee, ctx.nameOf) : 'Assign'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={16} className="max-h-72 w-56 overflow-y-auto">
        <AssignItems step={step} state={state} editor={editor} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
