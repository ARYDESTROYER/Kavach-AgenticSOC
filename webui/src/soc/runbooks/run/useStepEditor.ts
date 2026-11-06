/**
 * The editable half of one runbook step inside a case (Round 14, SPEC §4.10.11): the
 * note being written, the decision being picked, the action being recorded and the AI
 * draft being edited, plus the writes that finish the step.
 *
 * Used by the Next step card and by an opened step row (one of them shows a given step at
 * a time). What a person typed survives a stale save: the server's latest step is shown
 * and the field keeps the text, so nothing typed is lost (§4.10.11 States). The unsaved
 * text is also kept in the run context, so it survives this editor unmounting (the Next
 * step card moving on to another step) and the step's row opens with it. Every write
 * names the step revision as the person read it (`StepState.revision`, never the case
 * document's revision), so a background lookup never conflicts with an edit.
 */
import * as React from 'react';

import type { RunbookStep, StepState } from '@/lib/types-runbooks';

import { useRunbookRun, type FinishOptions, type WriteOutcome } from './context';

export interface ActionDraft {
  where: string;
  outcome: string;
  /** `datetime-local` text, empty for "now". */
  performedAt: string;
}

const EMPTY_ACTION: ActionDraft = { where: '', outcome: '', performedAt: '' };

/** A `datetime-local` value (the viewer's zone) as a UTC ISO string, or undefined. */
export function localInputToIso(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

export interface StepEditor {
  note: string;
  setNote: (value: string) => void;
  noteDirty: boolean;
  /** Save the note on its own (Save note). */
  saveNote: () => Promise<WriteOutcome | null>;
  /**
   * Focus left the note (its field, Save note, or a press that carries it) for something
   * else: save the note on its own when it changed, unless a write of this step is already
   * in flight (it carries the note, or it is the note's own save).
   */
  leaveNote: () => void;
  choice: string;
  setChoice: (optionId: string) => void;
  action: ActionDraft;
  setAction: (patch: Partial<ActionDraft>) => void;
  editingDraft: boolean;
  setEditingDraft: (on: boolean) => void;
  draftText: string;
  setDraftText: (value: string) => void;
  /** Mark done (sending the note in the same write when it changed). */
  markDone: (opts?: FinishOptions) => Promise<WriteOutcome>;
  recordDecision: (opts?: FinishOptions) => Promise<WriteOutcome | null>;
  recordAction: (opts?: FinishOptions) => Promise<WriteOutcome | null>;
  confirmDraft: (opts?: FinishOptions) => Promise<WriteOutcome | null>;
  setStatus: (status: 'not_applicable' | 'blocked' | 'todo' | 'in_progress', reason?: string, opts?: FinishOptions) => Promise<WriteOutcome>;
  assign: (username: string | null) => Promise<WriteOutcome>;
  addLink: (value: string) => Promise<WriteOutcome | null>;
}

export function useStepEditor(step: RunbookStep, state: StepState): StepEditor {
  const ctx = useRunbookRun();
  const { keepDraft } = ctx;
  const stepId = step.id;
  // What was typed before this editor mounted (kept by the run context), else the step.
  const [kept] = React.useState(() => ctx.keptDraft(stepId));
  const keptNote = kept?.note !== undefined && kept.note !== (state.note ?? '') ? kept.note : undefined;
  const [note, setNoteRaw] = React.useState(keptNote ?? state.note ?? '');
  const [noteDirty, setNoteDirty] = React.useState(keptNote !== undefined);
  const [choice, setChoiceRaw] = React.useState(kept?.choice ?? '');
  const [action, setActionRaw] = React.useState<ActionDraft>(kept?.action ?? EMPTY_ACTION);
  const [editingDraft, setEditingDraftRaw] = React.useState(Boolean(kept?.editingDraft && state.ai_draft && !state.ai_draft.confirmed));
  const [draftText, setDraftTextRaw] = React.useState(
    kept?.editingDraft && kept.draftText !== undefined ? kept.draftText : (state.ai_draft?.text ?? ''),
  );

  // The saved note replaces the field only while the person has not changed it.
  const savedNote = state.note ?? '';
  React.useEffect(() => {
    if (!noteDirty) setNoteRaw(savedNote);
  }, [savedNote, noteDirty]);

  const savedDraft = state.ai_draft?.text ?? '';
  React.useEffect(() => {
    if (!editingDraft) setDraftTextRaw(savedDraft);
  }, [savedDraft, editingDraft]);

  const revision = state.revision ?? 0;
  const stateRef = React.useRef(state);
  stateRef.current = state;

  // The field's text as last typed, read when a save answers.
  const noteRef = React.useRef(note);
  noteRef.current = note;

  const setNote = React.useCallback(
    (value: string) => {
      const dirty = value !== (stateRef.current.note ?? '');
      noteRef.current = value;
      setNoteRaw(value);
      setNoteDirty(dirty);
      keepDraft(stepId, { note: dirty ? value : undefined });
    },
    [keepDraft, stepId],
  );

  /**
   * The note `sent` was saved (alone or with another change): nothing to keep any more,
   * unless the person typed on while it was saving, which stays unsaved.
   */
  const noteSaved = React.useCallback(
    (sent: string) => {
      if (noteRef.current !== sent) return;
      setNoteDirty(false);
      keepDraft(stepId, { note: undefined });
    },
    [keepDraft, stepId],
  );

  const setChoice = React.useCallback(
    (optionId: string) => {
      setChoiceRaw(optionId);
      keepDraft(stepId, { choice: optionId || undefined });
    },
    [keepDraft, stepId],
  );

  const setAction = React.useCallback(
    (patch: Partial<ActionDraft>) =>
      setActionRaw((prev) => {
        const next = { ...prev, ...patch };
        const empty = !next.where && !next.outcome && !next.performedAt;
        keepDraft(stepId, { action: empty ? undefined : next });
        return next;
      }),
    [keepDraft, stepId],
  );

  const setDraftText = React.useCallback(
    (value: string) => {
      setDraftTextRaw(value);
      keepDraft(stepId, { draftText: value });
    },
    [keepDraft, stepId],
  );

  const setEditingDraft = React.useCallback(
    (on: boolean) => {
      setEditingDraftRaw(on);
      if (on) {
        const text = stateRef.current.ai_draft?.text ?? '';
        setDraftTextRaw(text);
        keepDraft(stepId, { editingDraft: true, draftText: text });
      } else {
        keepDraft(stepId, { editingDraft: undefined, draftText: undefined });
      }
    },
    [keepDraft, stepId],
  );

  const saveNote = React.useCallback(async () => {
    if (!noteDirty || !ctx.canRun) return null;
    const result = await ctx.updateStep(step.id, revision, { note });
    if (result.ok) noteSaved(note);
    return result;
  }, [ctx, note, noteDirty, noteSaved, revision, step.id]);

  // Leaving the note while another write is in flight saves it once that write is done,
  // rather than being refused (one write at a time per run).
  const saveWhenFree = React.useRef(false);
  const busy = ctx.busy;
  const leaveNote = React.useCallback(() => {
    if (!noteDirty || !ctx.canRun) return;
    // A write of this step is in flight: it carries the note, or it is the note's own save.
    if (busy === `${stepId}:update`) return;
    if (busy) {
      saveWhenFree.current = true;
      return;
    }
    void saveNote();
  }, [busy, ctx.canRun, noteDirty, saveNote, stepId]);
  React.useEffect(() => {
    if (busy || !saveWhenFree.current) return;
    saveWhenFree.current = false;
    if (noteDirty) void saveNote();
  }, [busy, noteDirty, saveNote]);

  const markDone = React.useCallback(
    async (opts?: FinishOptions) => {
      const body = noteDirty ? { note, status: 'done' as const } : { status: 'done' as const };
      const result = await ctx.updateStep(step.id, revision, body, opts ?? { announce: true });
      if (result.ok && noteDirty) noteSaved(note);
      return result;
    },
    [ctx, note, noteDirty, noteSaved, revision, step.id],
  );

  const recordDecision = React.useCallback(
    async (opts?: FinishOptions) => {
      if (!choice) return null;
      const body = noteDirty ? { note, decision: { option_id: choice } } : { decision: { option_id: choice } };
      const result = await ctx.updateStep(step.id, revision, body, opts ?? { announce: true });
      if (result.ok) {
        if (noteDirty) noteSaved(note);
        setChoice('');
      }
      return result;
    },
    [choice, ctx, note, noteDirty, noteSaved, revision, setChoice, step.id],
  );

  const recordAction = React.useCallback(
    async (opts?: FinishOptions) => {
      const where = action.where.trim();
      const outcome = action.outcome.trim();
      if (!where && !outcome) return null;
      const performedAt = localInputToIso(action.performedAt);
      const record = { where, outcome, ...(performedAt ? { performed_at: performedAt } : {}) };
      const body = noteDirty ? { note, action_record: record } : { action_record: record };
      const result = await ctx.updateStep(step.id, revision, body, opts ?? { announce: true });
      if (result.ok) {
        if (noteDirty) noteSaved(note);
        setActionRaw(EMPTY_ACTION);
        keepDraft(stepId, { action: undefined });
      }
      return result;
    },
    [action, ctx, keepDraft, note, noteDirty, noteSaved, revision, step.id, stepId],
  );

  const confirmDraft = React.useCallback(
    async (opts?: FinishOptions) => {
      const text = (editingDraft ? draftText : savedDraft).trim();
      if (!text) return null;
      const result = await ctx.confirmDraft(step.id, text, opts ?? { announce: true });
      if (result.ok) {
        setEditingDraftRaw(false);
        keepDraft(stepId, { editingDraft: undefined, draftText: undefined });
      }
      return result;
    },
    [ctx, draftText, editingDraft, keepDraft, savedDraft, step.id, stepId],
  );

  // A status change carries the unsaved note in the same write, so leaving the note field
  // for Not applicable or Blocked never loses what was typed.
  const setStatus = React.useCallback(
    async (status: 'not_applicable' | 'blocked' | 'todo' | 'in_progress', reason?: string, opts?: FinishOptions) => {
      const body = {
        status,
        ...(reason ? { reason } : {}),
        ...(noteDirty ? { note } : {}),
      };
      const result = await ctx.updateStep(step.id, revision, body, opts ?? { announce: status === 'not_applicable' });
      if (result.ok && noteDirty) noteSaved(note);
      return result;
    },
    [ctx, note, noteDirty, noteSaved, revision, step.id],
  );

  const assign = React.useCallback(
    (username: string | null) => ctx.updateStep(step.id, revision, { assignee: username }),
    [ctx, revision, step.id],
  );

  const addLink = React.useCallback(
    async (value: string) => {
      const text = value.trim();
      if (!text) return null;
      const isLink = /^https:\/\//i.test(text);
      const evidence_link = isLink ? { kind: 'link' as const, url: text } : { kind: 'ticket' as const, label: text.slice(0, 120) };
      return ctx.updateStep(step.id, revision, { evidence_link });
    },
    [ctx, revision, step.id],
  );

  return {
    note,
    setNote,
    noteDirty,
    saveNote,
    leaveNote,
    choice,
    setChoice,
    action,
    setAction,
    editingDraft,
    setEditingDraft,
    draftText,
    setDraftText,
    markDone,
    recordDecision,
    recordAction,
    confirmDraft,
    setStatus,
    assign,
    addLink,
  };
}
