/**
 * The run's working context inside a case (Round 14, SPEC §4.10.11): who may do what, the
 * writes to one run, the conflict and error notes per step, the live announcements and
 * the "focus the new Next step" signal. One provider per shown run; the Next step card,
 * the phase tabs and the step rows read it, so a write from any of them updates all.
 *
 * Every write goes through `routes_case_runbooks.py` (audited before it is visible, #2).
 * A stale step revision is never retried (`409 runbook_conflict`): the latest run the
 * server returned is shown at once with "This step changed since you opened it. Showing
 * the latest.", and what the person typed stays in its field: unsaved text is kept here,
 * per step, so it survives the Next step card moving on to another step (the stale step's
 * row then opens with the text and the note). Nothing here can change the verdict, the
 * status or the close decision (#3).
 */
import * as React from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import {
  confirmRunbookStepDraft,
  decideRunbookApproval,
  draftRunbookStep,
  runRunbookLookup,
  updateRunbookStep,
} from '@/lib/api-runbooks';
import type {
  AiCallEstimate,
  CaseRunbooks,
  LookupTool,
  RunbookRun,
  RunbookRunUpdate,
  RunbookStepUpdate,
} from '@/lib/types-runbooks';
import { runbookFailure } from '@/soc/runbooks/shared/errors';
import type { PickableUser } from '@/soc/pages/CaseDetail.api';

import {
  advanceSentence,
  holdsApprovalRole,
  isWaiting,
  nextStep,
  numberedSteps,
  plainName,
  runProgress,
  type NameOf,
  type ViewerRoles,
} from './model';

/** The grant each lookup tool needs to run and to be seen (SPEC §4.10.8). */
export const LOOKUP_TOOL_PERMISSION: Readonly<Record<LookupTool, [string, string]>> = {
  log_stats: ['sources', 'read'],
  log_search: ['sources', 'read'],
  enrich: ['enrichment', 'read'],
  related_cases: ['cases', 'read'],
  campaign: ['cases', 'read'],
  mitre: ['runbooks', 'read'],
};

/** The line a stale save shows next to its step. */
export const CONFLICT_NOTE = 'This step changed since you opened it. Showing the latest.';

/** What a write refused because another one is still being saved says. */
export const BUSY_NOTE = 'Another change to this runbook is still being saved. Try again in a moment.';

/** What a person typed into one step and has not saved yet (kept across remounts). */
export interface StepDraft {
  note?: string;
  draftText?: string;
  editingDraft?: boolean;
  action?: { where: string; outcome: string; performedAt: string };
  choice?: string;
}

/** What a write that can finish a step does once it succeeds. */
export interface FinishOptions {
  announce?: boolean;
  focusNext?: boolean;
}

export interface WriteOutcome {
  ok: boolean;
  conflict?: boolean;
  /** The plain sentence of a refusal, for the step to show. */
  message?: string;
  code?: string | null;
  update?: RunbookRunUpdate;
}

export interface RunbookRunContextValue {
  caseId: string;
  /** "CASE-000214", for dialog titles. */
  caseLabel: string;
  data: CaseRunbooks;
  run: RunbookRun;
  /** The viewer holds runbooks:run and runbooks are on (else every row is read only). */
  canRun: boolean;
  /**
   * Whether the viewer holds `role` for an approval: true, false, or null while it cannot
   * be told (the server decides then).
   */
  holdsRole: (role: string | null | undefined) => boolean | null;
  /** The viewer holds the grant `tool` needs. */
  canUseTool: (tool: LookupTool | string) => boolean;
  /** "Draft note" is offered (runbooks.ai_step_drafts). */
  aiDrafts: boolean;
  currentUser: string | null;
  nameOf: NameOf;
  users: PickableUser[];
  /** The write in flight, as `<step id>:<what>`, or null. */
  busy: string | null;
  /** The note a step shows after a refused or stale write. */
  stepNote: (stepId: string) => { text: string; tone: 'conflict' | 'error' } | null;
  clearStepNote: (stepId: string) => void;
  /**
   * PATCH one step. `announce` says the result in the live region when the step finishes
   * ("Step 5 done. Next, step 6: ..."); `focusNext` also moves focus to the new Next step
   * heading (the card's own actions, whose controls leave with the step).
   */
  updateStep: (
    stepId: string,
    expectedRevision: number,
    body: Omit<RunbookStepUpdate, 'expected_revision'>,
    opts?: FinishOptions,
  ) => Promise<WriteOutcome>;
  runLookup: (stepId: string) => Promise<WriteOutcome>;
  decideApproval: (stepId: string, decision: 'approve' | 'reject', reason?: string) => Promise<WriteOutcome>;
  draftNote: (stepId: string) => Promise<WriteOutcome>;
  estimateDraft: (stepId: string) => Promise<AiCallEstimate | null>;
  confirmDraft: (stepId: string, text: string, opts?: FinishOptions) => Promise<WriteOutcome>;
  /** Say something in the tab's polite live region. */
  announce: (text: string) => void;
  /** Bumped when the Next step heading should take focus (after a step finished). */
  focusTick: number;
  /** Open a step in the phase list (switch to its phase, expand it). */
  revealStep: (stepId: string) => void;
  /** The step the list should open, set by `revealStep`. */
  revealRequest: { stepId: string; tick: number } | null;
  /** Unsaved text for a step of this run (null when none is kept). */
  keptDraft: (stepId: string) => StepDraft | null;
  /** Keep (or, with `undefined` values, forget) unsaved text for a step of this run. */
  keepDraft: (stepId: string, patch: Partial<StepDraft>) => void;
}

const RunbookRunContext = React.createContext<RunbookRunContextValue | null>(null);

export function useRunbookRun(): RunbookRunContextValue {
  const ctx = React.useContext(RunbookRunContext);
  if (!ctx) throw new Error('useRunbookRun must be used inside <RunbookRunProvider>');
  return ctx;
}

/** The run context when one is shown, else null (a case with no run). */
export function useRunbookRunOptional(): RunbookRunContextValue | null {
  return React.useContext(RunbookRunContext);
}

/** The latest run a `409 runbook_conflict` carried, when it carried one. */
export function conflictLatest(error: unknown): RunbookRunUpdate | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== 'object') return null;
  const detail = (error.body as { detail?: unknown }).detail;
  const latest = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).latest : null;
  if (!latest || typeof latest !== 'object') return null;
  const value = latest as Record<string, unknown>;
  if (!value.run || typeof value.run !== 'object' || !value.progress || typeof value.revision !== 'number') return null;
  return latest as RunbookRunUpdate;
}

export interface RunbookRunProviderProps {
  caseId: string;
  caseLabel: string;
  data: CaseRunbooks;
  run: RunbookRun;
  canRun: boolean;
  hasPermission: (resource: string, action: string) => boolean;
  /** The viewer's roles, for the approval hint (unknown when absent). */
  viewer?: ViewerRoles | null;
  aiDrafts?: boolean;
  currentUser?: string | null;
  nameOf?: NameOf;
  users?: PickableUser[];
  applyUpdate: (update: RunbookRunUpdate) => void;
  announce: (text: string) => void;
  children: React.ReactNode;
}

export function RunbookRunProvider({
  caseId,
  caseLabel,
  data,
  run,
  canRun,
  hasPermission,
  viewer = null,
  aiDrafts = true,
  currentUser = null,
  nameOf = plainName,
  users = [],
  applyUpdate,
  announce,
  children,
}: RunbookRunProviderProps) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState<Record<string, { text: string; tone: 'conflict' | 'error' }>>({});
  const [focusTick, setFocusTick] = React.useState(0);
  const [revealRequest, setRevealRequest] = React.useState<{ stepId: string; tick: number } | null>(null);
  const runRef = React.useRef(run);
  runRef.current = run;
  const busyRef = React.useRef<string | null>(null);
  // Steps whose write was refused while the write in flight ran: its answer leaves their
  // "still being saved" sentence in place, so the refusal is seen, never silently lost.
  const refusedRef = React.useRef<Set<string>>(new Set());
  // Unsaved text per `<run id>:<step id>`; a ref, since keeping it never needs a render.
  const draftsRef = React.useRef<Map<string, StepDraft>>(new Map());
  const runId = run.run_id;
  const keptDraft = React.useCallback((stepId: string) => draftsRef.current.get(`${runId}:${stepId}`) ?? null, [runId]);
  const keepDraft = React.useCallback(
    (stepId: string, patch: Partial<StepDraft>) => {
      const key = `${runId}:${stepId}`;
      const next: StepDraft = { ...(draftsRef.current.get(key) ?? {}), ...patch };
      for (const k of Object.keys(next) as Array<keyof StepDraft>) {
        if (next[k] === undefined) delete next[k];
      }
      if (Object.keys(next).length) draftsRef.current.set(key, next);
      else draftsRef.current.delete(key);
    },
    [runId],
  );
  const holdsRole = React.useCallback((role: string | null | undefined) => holdsApprovalRole(role, viewer), [viewer]);

  const canUseTool = React.useCallback(
    (tool: LookupTool | string) => {
      const grant = LOOKUP_TOOL_PERMISSION[tool as LookupTool] ?? ['runbooks', 'read'];
      return hasPermission(grant[0], grant[1]);
    },
    [hasPermission],
  );

  const setNote = React.useCallback((stepId: string, note: { text: string; tone: 'conflict' | 'error' } | null) => {
    setNotes((prev) => {
      if (!note) {
        if (!(stepId in prev)) return prev;
        const next = { ...prev };
        delete next[stepId];
        return next;
      }
      return { ...prev, [stepId]: note };
    });
  }, []);

  /**
   * One write: mark it busy, merge the answer, and say what changed. A stale revision
   * shows the latest run and keeps what was typed; any other refusal is the server's own
   * sentence, next to the step.
   */
  const perform = React.useCallback(
    async (stepId: string, what: string, call: () => Promise<RunbookRunUpdate>, finish: FinishOptions = {}): Promise<WriteOutcome> => {
      // One write at a time per run: a second one is refused with a sentence next to its
      // step (and its live region), never silently.
      if (busyRef.current) {
        refusedRef.current.add(stepId);
        setNote(stepId, { text: BUSY_NOTE, tone: 'error' });
        return { ok: false, message: BUSY_NOTE, code: 'runbook_busy' };
      }
      const key = `${stepId}:${what}`;
      busyRef.current = key;
      refusedRef.current.clear();
      setBusy(key);
      const before = runRef.current;
      const beforeNumber = numberedSteps(before).find((s) => s.step.id === stepId)?.number ?? null;
      const wasNext = nextStep(before)?.step.id === stepId;
      try {
        const update = await call();
        applyUpdate(update);
        if (!refusedRef.current.has(stepId)) setNote(stepId, null);
        if ((finish.announce || finish.focusNext) && update.run) {
          const after = update.run;
          const st = after.steps?.[stepId];
          // A recorded action that now waits for approval leaves the card too.
          const verb =
            st?.status === 'not_applicable'
              ? 'not applicable'
              : st?.status === 'done'
                ? 'done'
                : st && isWaiting(st) && wasNext
                  ? 'recorded'
                  : null;
          if (verb && beforeNumber !== null) {
            const progress = update.progress ?? runProgress(after);
            announce(advanceSentence({ number: beforeNumber, verb }, nextStep(after), progress.required_open <= 0));
            if (finish.focusNext) setFocusTick((t) => t + 1);
          }
        }
        return { ok: true, update };
      } catch (error) {
        const failure = runbookFailure(error, 'The step could not be saved. Try again.');
        if (failure.code === 'runbook_conflict') {
          const latest = conflictLatest(error);
          if (latest) applyUpdate(latest);
          setNote(stepId, { text: CONFLICT_NOTE, tone: 'conflict' });
          announce(CONFLICT_NOTE);
          // The Next step card moved on (someone else finished this step): open the step's
          // row, where the kept text and the note are shown.
          if (latest?.run && wasNext && nextStep(latest.run)?.step.id !== stepId) {
            setRevealRequest((prev) => ({ stepId, tick: (prev?.tick ?? 0) + 1 }));
          }
          return { ok: false, conflict: true, message: CONFLICT_NOTE, code: failure.code };
        }
        setNote(stepId, { text: failure.message, tone: 'error' });
        return { ok: false, message: failure.message, code: failure.code };
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [announce, applyUpdate, setNote],
  );

  const value = React.useMemo<RunbookRunContextValue>(
    () => ({
      caseId,
      caseLabel,
      data,
      run,
      canRun,
      holdsRole,
      canUseTool,
      aiDrafts,
      currentUser,
      nameOf,
      users,
      busy,
      stepNote: (stepId) => notes[stepId] ?? null,
      clearStepNote: (stepId) => setNote(stepId, null),
      updateStep: (stepId, expectedRevision, body, opts) =>
        perform(
          stepId,
          'update',
          () => updateRunbookStep(caseId, run.run_id, stepId, { ...body, expected_revision: expectedRevision }),
          opts,
        ),
      runLookup: (stepId) => perform(stepId, 'lookup', () => runRunbookLookup(caseId, run.run_id, stepId)),
      decideApproval: (stepId, decision, reason) =>
        perform(stepId, 'approval', () =>
          decideRunbookApproval(caseId, run.run_id, stepId, reason ? { decision, reason } : { decision }),
        ),
      draftNote: (stepId) =>
        perform(stepId, 'draft', async () => {
          const result = await draftRunbookStep(caseId, run.run_id, stepId);
          if (!result.update) throw new Error('The AI returned no draft. Try again.');
          return result.update;
        }),
      estimateDraft: async (stepId) => {
        try {
          const result = await draftRunbookStep(caseId, run.run_id, stepId, { dryRun: true });
          return result.estimate ?? null;
        } catch {
          return null;
        }
      },
      confirmDraft: (stepId, text, opts) =>
        perform(stepId, 'confirm', () => confirmRunbookStepDraft(caseId, run.run_id, stepId, { text }), opts ?? { announce: true }),
      announce,
      focusTick,
      revealStep: (stepId) => setRevealRequest((prev) => ({ stepId, tick: (prev?.tick ?? 0) + 1 })),
      revealRequest,
      keptDraft,
      keepDraft,
    }),
    [
      caseId,
      caseLabel,
      data,
      run,
      canRun,
      holdsRole,
      canUseTool,
      aiDrafts,
      currentUser,
      nameOf,
      users,
      busy,
      notes,
      setNote,
      perform,
      announce,
      focusTick,
      revealRequest,
      keptDraft,
      keepDraft,
    ],
  );

  return <RunbookRunContext.Provider value={value}>{children}</RunbookRunContext.Provider>;
}

/** A run-level refusal (switch, abandon, attach) as a toast with the server's sentence. */
export function toastRunbookFailure(error: unknown, fallback: string): void {
  toast.error(runbookFailure(error, fallback).message);
}
