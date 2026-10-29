/**
 * The pieces a runbook step is made of inside a case (Round 14, SPEC §4.10.3, §4.10.11),
 * shared by the Next step card and the step rows: the Escalate if and Benign if pair, the
 * AI draft, the decision options, the action record form and its record, the approval,
 * the note field and the evidence links.
 *
 * Runbook text (titles, focus lines, options) is Published, trusted operator text; notes,
 * reasons, names, drafts and links are run data. All of it is rendered as plain text nodes
 * (#9); a link only through the https-only helper. A decision steers the runbook only and
 * never changes the verdict or closes the case; an action is done by a person elsewhere
 * and Agentic SOC keeps the record (#3).
 */
import * as React from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';

import { cn } from '@/lib/cn';
import { humanizeToken } from '@/lib/format';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import type { RunbookRun, RunbookStep, StepState } from '@/lib/types-runbooks';
import { KIND_STEP_NOTE, ProvenanceChip, RunbookExternalLink, StatusMark } from '@/soc/runbooks/shared';

import { actorName, evidenceLinks, numberedSteps, utcTime, type NameOf } from './model';
import type { ActionDraft } from './useStepEditor';
import { ARIA_DISABLED_LOOK } from './ui';

/** The longest note a step keeps (`StepState.note`). */
export const NOTE_MAX_CHARS = 4_000;
/** The longest "where" and "outcome" of a recorded action. */
export const WHERE_MAX_CHARS = 200;
export const OUTCOME_MAX_CHARS = 500;

/** "incident lead", with its article: "an incident lead", "a responder". */
export function roleWords(role: string | null | undefined): { noun: string; withArticle: string } {
  const noun = humanizeToken(role || 'approver').toLowerCase();
  const article = /^[aeiou]/.test(noun) ? 'an' : 'a';
  return { noun, withArticle: `${article} ${noun}` };
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** Ties one step's note field to the presses whose own write carries its unsaved note. */
export function noteKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

/**
 * True when `target` belongs to the note of `key`: its field, its Save note button, or a
 * press that carries it (Mark done, Record action, Record decision of the same step).
 */
export function holdsNote(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  const holder = target.closest('[data-note-for], [data-carries-note]');
  if (!holder) return false;
  return holder.getAttribute('data-note-for') === key || holder.getAttribute('data-carries-note') === key;
}

/**
 * `onMouseDown` for a run button that writes on its own (Run lookup, Draft note, Approve,
 * a status mark): a mouse press leaves focus in a note being written. Otherwise the note
 * would be saved on the way out of its field, and the press would land while that save is
 * in flight (one write at a time per run) and be lost. The note stays in its field and is
 * saved when focus leaves it.
 */
export function keepNoteFocus(event: React.MouseEvent<HTMLElement>): void {
  const active = document.activeElement;
  if (event.button === 0 && active instanceof Element && active.closest('[data-note-for]')) event.preventDefault();
}

/** What `carriesNote` adds to a press that can act. */
export interface CarriesNoteProps {
  'data-carries-note'?: string;
  onMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
  onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
}

/**
 * Props for a press whose own write carries the step's unsaved note (Mark done, Record
 * action, Record decision), only while it can act; a press that cannot act is an ordinary
 * button, so leaving the note for it saves the note.
 *
 * A mouse press keeps focus where it is when that is a note being written (any step's
 * field or Save note) or this press itself. Safari and Firefox on macOS never focus a
 * clicked button: without this the field would lose focus to nothing on mousedown, start a
 * save of its own, and the click would land while that save is in flight and be refused.
 * This step's note goes in the press's own write; another step's note stays in its field
 * and is saved when focus leaves it. Leaving the press for anything but this step's note
 * saves the note, as leaving the field does (`onLeave`).
 */
export function carriesNote(key: string, actionable: boolean, onLeave: () => void): CarriesNoteProps {
  if (!actionable) return {};
  return {
    'data-carries-note': key,
    onMouseDown: (event) => {
      if (event.button === 0 && holdsNote(document.activeElement, key)) event.preventDefault();
      else keepNoteFocus(event);
    },
    onBlur: (event) => {
      if (!holdsNote(event.relatedTarget, key)) onLeave();
    },
  };
}

/** "Escalate if" and "Benign if", side by side from 34rem of the run's width. */
export function Implications({ step, className }: { step: RunbookStep; className?: string }) {
  if (!step.escalate_if && !step.benign_if) return null;
  return (
    <div className={cn('grid gap-2 @[34rem]/run:grid-cols-2', className)}>
      {step.escalate_if ? (
        <div className="flex gap-2 rounded-md border border-border/80 px-3 py-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-high-text" aria-hidden />
          <p className="text-sm text-foreground">
            <span className="font-medium">Escalate if </span>
            <span className="text-secondary-foreground">{lowerFirst(step.escalate_if)}</span>
          </p>
        </div>
      ) : null}
      {step.benign_if ? (
        <div className="flex gap-2 rounded-md border border-border/80 px-3 py-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden />
          <p className="text-sm text-foreground">
            <span className="font-medium">Benign if </span>
            <span className="text-secondary-foreground">{lowerFirst(step.benign_if)}</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** "Focus: which fields to look at". */
export function FocusLine({ step, className }: { step: RunbookStep; className?: string }) {
  if (!step.focus) return null;
  return (
    <p className={cn('text-sm text-muted-foreground', className)}>
      <span className="font-medium text-secondary-foreground">Focus </span>
      {step.focus}
    </p>
  );
}

/** RE&CT and D3FEND references of a step, when it names them. */
export function FrameworkRefs({ step }: { step: RunbookStep }) {
  if (!step.react && !step.d3fend) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {step.react ? <>RE&amp;CT {step.react}</> : null}
      {step.react && step.d3fend ? ' · ' : null}
      {step.d3fend ? <>D3FEND {step.d3fend}</> : null}
    </p>
  );
}

/** The AI's draft note: labelled, and not part of the case until a person confirms it. */
export function AiDraftBox({
  state,
  editing,
  text,
  onText,
  large = false,
  fieldId,
}: {
  state: StepState;
  editing: boolean;
  text: string;
  onText: (value: string) => void;
  large?: boolean;
  fieldId: string;
}) {
  const draft = state.ai_draft;
  if (!draft || draft.confirmed) return null;
  return (
    <section aria-label="AI draft note" data-ai-draft="" className="rounded-md border border-primary/25 bg-primary/[0.05] px-3 py-2.5">
      <p className="text-xs leading-[1.125rem] text-muted-foreground">
        {/* Reads as one sentence: "AI draft · not part of the case until you confirm it". */}
        <ProvenanceChip kind="ai" className="mr-1 align-middle">
          AI draft
        </ProvenanceChip>{' '}
        · not part of the case until you confirm it
      </p>
      {editing ? (
        <div className="mt-1.5 space-y-1">
          <Label htmlFor={fieldId} className="sr-only">
            Edit the draft note
          </Label>
          <Textarea
            id={fieldId}
            rows={4}
            value={text}
            maxLength={2_000}
            onChange={(event) => onText(event.target.value)}
            className="text-sm"
          />
        </div>
      ) : (
        <p className={cn('mt-1.5 whitespace-pre-wrap text-foreground', large ? 'text-md' : 'text-sm')}>{draft.text}</p>
      )}
    </section>
  );
}

/** The options of a Decision step, the Record decision button and its hint. */
export function DecisionPicker({
  run,
  step,
  value,
  onChange,
  onRecord,
  onLeaveNote,
  busy,
  disabled,
}: {
  run: RunbookRun;
  step: RunbookStep;
  value: string;
  onChange: (optionId: string) => void;
  onRecord: () => void;
  /** Focus left Record decision for something other than the step's note (`carriesNote`). */
  onLeaveNote: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  const hintId = React.useId();
  const canRecord = Boolean(value) && !busy && !disabled;
  const numbers = React.useMemo(() => new Map(numberedSteps(run).map((s) => [s.step.id, s] as const)), [run]);
  const effect = (marks: string[]): string => {
    const later = marks
      .map((id) => numbers.get(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => s.number)
      .sort((a, b) => a - b);
    if (!later.length) return 'Continue with the next steps.';
    const list = later.length === 1 ? `step ${later[0]}` : `steps ${later.slice(0, -1).join(', ')} and ${later[later.length - 1]}`;
    return `Marks ${list} Not applicable if still to do. A recorded action stays as it is.`;
  };
  return (
    <div className="space-y-2" data-decision-picker="">
      {/* Picking an option writes nothing, so a save in flight never disables the choice. */}
      <RadioGroup value={value} onValueChange={onChange} aria-label={step.title} className="gap-1.5">
        {step.options.map((option) => {
          const id = `decision-${run.run_id}-${step.id}-${option.id}`;
          return (
            <label
              key={option.id}
              htmlFor={id}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors',
                value === option.id ? 'border-primary bg-primary/[0.06]' : 'border-border hover:bg-muted/60',
              )}
            >
              <RadioGroupItem id={id} value={option.id} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{effect(option.marks_not_applicable)}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="space-y-1">
          <Button
            size="sm"
            className={ARIA_DISABLED_LOOK}
            onClick={canRecord ? onRecord : undefined}
            aria-disabled={!canRecord || undefined}
            aria-busy={busy || undefined}
            aria-describedby={value ? undefined : hintId}
            {...carriesNote(noteKey(run.run_id, step.id), canRecord, onLeaveNote)}
          >
            Record decision
          </Button>
          {value ? null : (
            <p id={hintId} className="text-xs text-muted-foreground">
              Pick an option to record the decision.
            </p>
          )}
        </div>
        <p className="min-w-0 flex-1 pt-1.5 text-xs text-muted-foreground">{KIND_STEP_NOTE.decision}</p>
      </div>
    </div>
  );
}

/** Where and how an Action or Record step was done, entered by the person who did it. */
export function ActionRecordForm({
  step,
  draft,
  onChange,
  disabled,
  idBase,
}: {
  step: RunbookStep;
  draft: ActionDraft;
  onChange: (patch: Partial<ActionDraft>) => void;
  disabled: boolean;
  idBase: string;
}) {
  const role = step.approval_role ? roleWords(step.approval_role) : null;
  return (
    <div className="space-y-2" data-action-form="">
      <div className="grid gap-2 @[34rem]/run:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idBase}-where`} className="text-xs">
            Where (system or ticket)
          </Label>
          <Input
            id={`${idBase}-where`}
            value={draft.where}
            maxLength={WHERE_MAX_CHARS}
            disabled={disabled}
            placeholder="For example Okta, change CHG-4830"
            className="h-8 text-sm"
            onChange={(event) => onChange({ where: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idBase}-outcome`} className="text-xs">
            Outcome
          </Label>
          <Input
            id={`${idBase}-outcome`}
            value={draft.outcome}
            maxLength={OUTCOME_MAX_CHARS}
            disabled={disabled}
            placeholder="What changed"
            className="h-8 text-sm"
            onChange={(event) => onChange({ outcome: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idBase}-when`} className="text-xs">
          When it was done (optional, your time zone)
        </Label>
        <Input
          id={`${idBase}-when`}
          type="datetime-local"
          value={draft.performedAt}
          disabled={disabled}
          className="h-8 w-auto text-sm"
          onChange={(event) => onChange({ performedAt: event.target.value })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {KIND_STEP_NOTE[step.kind === 'record' ? 'record' : 'action']}
        {role ? ` After you record it, a different ${role.noun} may need to approve it.` : ''}
      </p>
    </div>
  );
}

/** The recorded action, and its approval when one is needed. */
export function ActionRecordView({
  step,
  state,
  nameOf,
  currentUser,
  canApprove,
  busy,
  onApprove,
  onReject,
  now = new Date(),
}: {
  step: RunbookStep;
  state: StepState;
  nameOf?: NameOf;
  currentUser: string | null;
  canApprove: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  now?: Date;
}) {
  const record = state.action_record;
  const hintId = React.useId();
  if (!record) return null;
  const recorder = actorName(record.performed_by, nameOf);
  const approval = state.approval;
  const role = roleWords(approval?.required_role ?? step.approval_role);
  const isRecorder = Boolean(currentUser && record.performed_by === currentUser);
  return (
    <div className="space-y-2">
      <dl className="grid gap-x-4 gap-y-1.5 rounded-md bg-muted/50 px-3 py-2 text-sm @[34rem]/run:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-xs text-muted-foreground">Recorded by</dt>
        <dd className="text-foreground">
          {recorder} at {utcTime(record.performed_at, now)}
        </dd>
        {record.where ? (
          <>
            <dt className="text-xs text-muted-foreground">Where</dt>
            <dd className="text-foreground [overflow-wrap:anywhere]">{record.where}</dd>
          </>
        ) : null}
        {record.outcome ? (
          <>
            <dt className="text-xs text-muted-foreground">Outcome</dt>
            <dd className="whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{record.outcome}</dd>
          </>
        ) : null}
      </dl>
      {approval?.status === 'pending' ? (
        <div
          data-approval="pending"
          className="flex flex-wrap items-start gap-x-2 gap-y-2 rounded-md border border-warning/40 bg-warning/[0.08] px-3 py-2"
        >
          <StatusMark status="waiting" size="sm" className="mt-0.5" />
          <p className="min-w-0 flex-1 text-sm text-foreground">
            Waiting for approval from {role.withArticle}
            <span className="block text-xs text-muted-foreground">
              {recorder} recorded this action, so a different {role.noun} approves it.
            </span>
          </p>
          <div className="space-y-1 text-right">
            <div className="flex flex-wrap justify-end gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className={ARIA_DISABLED_LOOK}
                onMouseDown={keepNoteFocus}
                onClick={isRecorder || !canApprove || busy ? undefined : onApprove}
                aria-disabled={isRecorder || !canApprove || busy || undefined}
                aria-busy={busy || undefined}
                aria-describedby={isRecorder || !canApprove ? hintId : undefined}
              >
                Approve
              </Button>
              {canApprove && !isRecorder ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className={ARIA_DISABLED_LOOK}
                  onMouseDown={keepNoteFocus}
                  onClick={busy ? undefined : onReject}
                  aria-disabled={busy || undefined}
                >
                  Reject
                </Button>
              ) : null}
            </div>
            {isRecorder || !canApprove ? (
              <p id={hintId} className="max-w-[16rem] text-xs text-muted-foreground">
                {isRecorder
                  ? `Only ${role.withArticle} other than ${recorder} can approve.`
                  : `Only ${role.withArticle} can approve this step.`}
              </p>
            ) : null}
          </div>
        </div>
      ) : approval?.status === 'approved' ? (
        <p className="text-xs text-muted-foreground">
          Approved by {actorName(approval.by, nameOf)}
          {approval.at ? ` at ${utcTime(approval.at, now)}` : ''}.
        </p>
      ) : approval?.status === 'rejected' ? (
        <p className="text-xs text-muted-foreground">
          Rejected by {actorName(approval.by, nameOf)}
          {approval.at ? ` at ${utcTime(approval.at, now)}` : ''}
          {approval.reason ? `: ${approval.reason}` : '.'}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{KIND_STEP_NOTE[step.kind === 'record' ? 'record' : 'action']}</p>
    </div>
  );
}

/**
 * "Your note", saved when focus leaves the note (the field and its Save note button) and
 * with Save note. Leaving it for a press of the same step whose own write carries the note
 * (`carriesNote`: Mark done, Record action, Record decision) saves nothing on the way, so
 * the note and the step change go in one write and the press is never refused by a save
 * still in flight; leaving that press for anything else saves the note then.
 *
 * Save note stays where it is while it holds focus, reading "Saved" once the note is
 * saved, so a keyboard or screen reader user is never dropped to the page when it would
 * otherwise disappear (SPEC §3.3). The field itself is never disabled by a write in
 * flight, so it never loses focus under the person typing in it.
 */
export function NoteField({
  id,
  noteKey: key,
  step,
  value,
  onChange,
  onSave,
  onLeave,
  dirty,
  busy,
  writing,
}: {
  id: string;
  /** `noteKey(run id, step id)`: the presses that carry this note name the same key. */
  noteKey: string;
  step: RunbookStep;
  value: string;
  onChange: (value: string) => void;
  /** Save note was pressed. */
  onSave: () => void;
  /** Focus left the note for something that does not carry it: save it if it changed. */
  onLeave: () => void;
  dirty: boolean;
  /** A write of this step is in flight (it carries the note, or is the note's own save). */
  busy: boolean;
  /** Any write to the run is in flight (one at a time): Save note waits for it. */
  writing: boolean;
}) {
  const helpId = `${id}-help`;
  const [saveFocused, setSaveFocused] = React.useState(false);
  const needed = step.evidence === 'note' ? ' (needed before Done)' : step.evidence === 'note_or_attachment' ? ' (or a link, needed before Done)' : '';
  // Focus moving between the field and Save note stays within the note.
  const leave = (event: React.FocusEvent<HTMLElement>) => {
    if (!holdsNote(event.relatedTarget, key)) onLeave();
  };
  return (
    <div className="space-y-1.5" data-note-for={key}>
      <Label htmlFor={id} className="text-xs font-medium text-foreground">
        Your note{needed}
      </Label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        maxLength={NOTE_MAX_CHARS}
        placeholder="What did you find?"
        aria-describedby={helpId}
        className="text-sm"
        onChange={(event) => onChange(event.target.value)}
        onBlur={leave}
      />
      <div className="flex flex-wrap items-center gap-2">
        <p id={helpId} className="text-xs text-muted-foreground">
          {dirty ? 'Not saved yet. It is saved when you leave the field.' : 'Saved with the step, in plain text.'}
        </p>
        {dirty || saveFocused ? (
          <Button
            size="sm"
            variant="ghost"
            className={cn('h-7 px-2 text-xs', ARIA_DISABLED_LOOK)}
            onClick={!dirty || writing ? undefined : onSave}
            aria-busy={busy || undefined}
            aria-disabled={!dirty || writing || undefined}
            onFocus={() => setSaveFocused(true)}
            onBlur={(event) => {
              setSaveFocused(false);
              leave(event);
            }}
          >
            {dirty ? 'Save note' : 'Saved'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A saved note shown read only (a finished step, or a viewer who cannot update it). */
export function SavedNote({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <p className="text-xs text-muted-foreground">Note</p>
      <p className="whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}

/** Links and ticket references a person attached to the step. */
export function EvidenceLinks({ state }: { state: StepState }) {
  const links = evidenceLinks(state);
  if (!links.length) return null;
  return (
    <ul className="space-y-1 text-sm" aria-label="Evidence links">
      {links.map((item, i) => (
        <li key={i} className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">{item.kind === 'ticket' ? 'Ticket' : 'Link'}</span>
          {item.url ? (
            <RunbookExternalLink href={item.url}>{item.label || item.url}</RunbookExternalLink>
          ) : (
            <span className="[overflow-wrap:anywhere]">{item.label}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "Add a link or ticket" for a step that accepts one as evidence. */
export function AddEvidenceLink({
  idBase,
  disabled,
  busy,
  onAdd,
}: {
  idBase: string;
  disabled: boolean;
  busy: boolean;
  onAdd: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = React.useState('');
  const id = `${idBase}-link`;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim() || busy) return;
        void onAdd(value).then((ok) => {
          if (ok) setValue('');
        });
      }}
    >
      <div className="min-w-[12rem] flex-1 space-y-1">
        <Label htmlFor={id} className="text-xs">
          Add a link or ticket reference
        </Label>
        <Input
          id={id}
          value={value}
          maxLength={500}
          disabled={disabled}
          placeholder="https://… or INC-1234"
          className="h-8 text-sm"
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className={ARIA_DISABLED_LOOK}
        aria-disabled={!value.trim() || busy || disabled || undefined}
        aria-busy={busy || undefined}
      >
        Add
      </Button>
    </form>
  );
}
