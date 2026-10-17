/**
 * RunLog — the per-turn record of lookups (chat revamp SPEC §10.3, §10.9).
 *
 * One row per tool call, or one framed row per parallel batch (steps sharing a
 * `group`). A row reads (Round 13, SPEC-chat T20): a leading 16 px status icon, the
 * engine label, then the muted duration ("· 61 ms"); a status WORD only when the lookup
 * did not simply finish (Failed, Timed out, Denied, Skipped, Stopped), while Done is the
 * check icon with an sr-only "Done" (status is never colour alone). Under it the
 * whitelisted parameter chips (verdicts, statuses and kinds in the console's words; a
 * chip naming several sources reads "3 sources" with the names in its tooltip, T14), the
 * engine summary, rows / basis / coverage, and the exact query behind an expandable
 * "Query" disclosure rendered as untrusted code.
 *
 * Before any lookup has run the live log says what is happening instead of "No lookups
 * yet." (which read like an empty result): "Reading your question…", then "Choosing
 * lookups…" while the first model call decides.
 *
 * Model steps add no rows of their own (their tokens tick on the header). The
 * exceptions are the step the turn is waiting on — "Thinking", or "Writing the answer"
 * for the final-only step — a failed model call, which must stay visible, and the quiet
 * Round 12 notes (SPEC D2-D4): "Continued the answer (part 2)", "Earlier messages were
 * summarised to keep going", "Wrapped up after a very long investigation", plus the
 * notes a host adds (`notes`, e.g. "Stopped repeating the same lookup"). A long lookup
 * that reports progress (`step.progress`) reads "Counted 42,000 of 118,402 cases…"
 * while it runs. A settled lookup offers "Inspect" (the step inspector).
 *
 * #9: every string here was display-sanitised by `stream-events.ts` and is rendered as
 * a React text node; the query renders through `CodeBlock` (text children only).
 */
import * as React from 'react';
import {
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleSlash,
  CircleX,
  Clock3,
  Flag,
  ListCollapse,
  Repeat2,
  ScanSearch,
  Square,
  TextCursorInput,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatStep, ChatStepProgress } from '@/lib/types';
import { LoadingGlyph } from '@/design-system';
import { CodeBlock } from '@/soc/components/CodeBlock';
import type { ChatLiveTurn } from '../useChatEngine';
import { sourcesChip } from '../display';
import {
  BASIS_LABEL,
  STEP_STATUS_LABEL,
  compactTokens,
  formatCost,
  formatDuration,
  lookupsLabel,
  paramKeyLabel,
  paramValue,
  type RunStepStatus,
} from './format';

/** One run-log step, live (`step.start` → `step.end`) or saved (`ChatStep`). */
export interface RunLogStep {
  index: number;
  kind: ChatStep['kind'];
  tool: string | null;
  label: string;
  params: ChatStep['params'];
  group: number | null;
  status: RunStepStatus;
  /** The final step once it ended (summary, coverage, query, duration). */
  result: ChatStep | null;
  /** The latest progress of a long lookup (`step.progress`, Round 12). */
  progress?: ChatStepProgress | null;
}

/** A quiet run-log row (Round 12): what the engine did to keep an answer going. */
export interface RunLogNote {
  key: string;
  text: string;
  kind: RunNoteKind;
}

export type RunNoteKind = 'continued' | 'compacted' | 'wrapped' | 'repeat';

/** The quiet notes' copy (SPEC D2, D4). */
export const NOTE_TEXT = {
  compacted: 'Earlier messages were summarised to keep going',
  wrapped: 'Wrapped up after a very long investigation',
  repeat: 'Stopped repeating the same lookup',
} as const;

const CONTINUED_RE = /^Continued the answer \(part \d{1,4}\)$/;
const SUMMARY_LABEL = 'Summarised earlier messages';

/** The quiet note a model step stands for (by its engine label), else null. */
export function quietModelNote(step: Pick<RunLogStep, 'kind' | 'label'>): RunNoteKind | null {
  if (step.kind !== 'model') return null;
  if (CONTINUED_RE.test(step.label)) return 'continued';
  if (step.label === SUMMARY_LABEL) return 'compacted';
  if (step.label === NOTE_TEXT.wrapped) return 'wrapped';
  return null;
}

/** "Counted 42,000 of 118,402 cases…" (or without a total when the store cannot say). */
export function progressLine(progress: ChatStepProgress): string {
  const unit = progress.unit || 'items';
  const done = progress.done.toLocaleString();
  return typeof progress.total === 'number'
    ? `Counted ${done} of ${progress.total.toLocaleString()} ${unit}…`
    : `Counted ${done} ${unit}…`;
}

export function stepsFromLive(live: ChatLiveTurn): RunLogStep[] {
  return live.steps.map((step) => ({
    index: step.index,
    kind: step.kind,
    tool: step.tool,
    label: step.label,
    params: step.params,
    group: step.group ?? null,
    status: step.status,
    result: step.result,
    progress: step.progress ?? null,
  }));
}

export function stepsFromResponse(steps: readonly ChatStep[] | undefined): RunLogStep[] {
  return (steps ?? []).map((step) => ({
    index: step.index,
    kind: step.kind,
    tool: step.tool ?? null,
    label: step.label,
    params: step.params,
    group: step.group ?? null,
    status: step.status,
    result: step,
    progress: step.progress ?? null,
  }));
}

type Row =
  | { kind: 'step'; step: RunLogStep }
  | { kind: 'group'; group: number; steps: RunLogStep[] }
  | { kind: 'note'; note: RunLogNote; step: RunLogStep | null };

/**
 * The rows to draw. Tool steps sharing a `group` collapse into one framed row; a model
 * step is kept only while it runs (the turn is waiting on it), when it failed, or when
 * it is the last step of the turn (the "Wrote the answer" row). A model step that is a
 * Round 12 quiet note (continuation, summary, wrap-up) is a note row.
 */
export function buildRunRows(steps: readonly RunLogStep[]): Row[] {
  const rows: Row[] = [];
  const last = steps[steps.length - 1];
  steps.forEach((step) => {
    const note = quietModelNote(step);
    if (note && step.status !== 'error' && step.status !== 'timeout') {
      const text = note === 'continued' ? step.label : NOTE_TEXT[note];
      rows.push({ kind: 'note', note: { key: `m${step.index}`, text, kind: note }, step });
      return;
    }
    if (step.kind === 'model') {
      const keep = step.status === 'running' || (step.status !== 'ok' && step.status !== 'cancelled') || step === last;
      if (keep) rows.push({ kind: 'step', step });
      return;
    }
    const previous = rows[rows.length - 1];
    if (step.group !== null && previous?.kind === 'group' && previous.group === step.group) {
      previous.steps.push(step);
      return;
    }
    if (step.group !== null && previous?.kind === 'step' && previous.step.kind === 'tool' && previous.step.group === step.group) {
      rows[rows.length - 1] = { kind: 'group', group: step.group, steps: [previous.step, step] };
      return;
    }
    rows.push({ kind: 'step', step });
  });
  return rows;
}

const STATUS_ICON: Record<Exclude<RunStepStatus, 'running'>, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  ok: { icon: CircleCheck, tone: 'text-success-text' },
  error: { icon: CircleX, tone: 'text-critical-text' },
  timeout: { icon: Clock3, tone: 'text-warning-text' },
  denied: { icon: CircleSlash, tone: 'text-warning-text' },
  skipped: { icon: CircleMinus, tone: 'text-muted-foreground' },
  cancelled: { icon: Square, tone: 'text-muted-foreground' },
};

function StatusIcon({ status }: { status: RunStepStatus }) {
  if (status === 'running') {
    return <LoadingGlyph size="sm" className="size-4" aria-hidden />;
  }
  const { icon: Icon, tone } = STATUS_ICON[status];
  return <Icon className={cn('size-4 shrink-0', tone)} aria-hidden />;
}

/** Statuses whose word shows beside the label; Done and Running are the icon (sr-only word). */
const SPOKEN_ONLY: ReadonlySet<RunStepStatus> = new Set<RunStepStatus>(['ok', 'running']);

function Chip({ name, value, mono = false, title }: { name: string; value: string; mono?: boolean; title?: string }) {
  return (
    <span className="inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-sm border border-border bg-surface px-1.5 text-2xs">
      <span className="shrink-0 text-muted-foreground">{name}</span>
      {/* The whole value is the tooltip: a long one may be cut on a narrow row. */}
      <span className={cn('min-w-0 truncate text-foreground', mono && 'font-mono')} title={title ?? value}>
        {value}
      </span>
    </span>
  );
}

/**
 * The sources a lookup read (SPEC-chat T14): one source is a plain chip ("Source Wazuh");
 * several read "3 sources", a disclosure button whose names show inline when pressed (and
 * in its tooltip for a pointer), so a keyboard or touch reader can see them too.
 */
function SourcesChip({ names, id }: { names: readonly string[]; id: string }) {
  const [open, setOpen] = React.useState(false);
  const chip = sourcesChip(names);
  if (names.length <= 1 || chip.title === chip.text) return <Chip name="Source" value={chip.text} />;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        title={chip.title}
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-border bg-surface px-1.5 text-2xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="run-log-sources"
      >
        {chip.text}
        <ChevronRight className={cn('size-3 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
      </button>
      <span id={id} hidden={!open} className="min-w-0 break-words text-2xs text-foreground" data-testid="run-log-source-names">
        {chip.title}
      </span>
    </>
  );
}

/** The exact query behind a lookup, collapsed by default (untrusted code). */
function QueryDisclosure({ query, id }: { query: string; id: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cn('size-3 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
        Query
      </button>
      <div id={id} hidden={!open} className="mt-1">
        {open ? <CodeBlock value={query} caption="Query as run · untrusted text" wrap maxHeightClassName="max-h-48" /> : null}
      </div>
    </div>
  );
}

function scopeLine(result: ChatStep | null): string {
  if (!result) return '';
  if (result.coverage) return result.coverage;
  const parts: string[] = [];
  if (typeof result.rows === 'number') parts.push(`${result.rows.toLocaleString()} ${result.rows === 1 ? 'row' : 'rows'}`);
  if (result.basis) parts.push(BASIS_LABEL[result.basis]);
  return parts.join(' · ');
}

/** The inspector opener of one settled lookup ("Inspect step 2: Counted cases"). */
function InspectButton({ step, onInspect }: { step: RunLogStep; onInspect: (step: RunLogStep, opener: HTMLElement) => void }) {
  return (
    <button
      type="button"
      onClick={(event) => onInspect(step, event.currentTarget)}
      aria-label={`Inspect step ${step.index}: ${step.label}`}
      title="Inspect this lookup"
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="run-log-inspect"
    >
      <ScanSearch className="size-3" aria-hidden />
      Inspect
    </button>
  );
}

interface StepRowProps {
  step: RunLogStep;
  idPrefix: string;
  onInspect?: ((step: RunLogStep, opener: HTMLElement) => void) | null;
}

function StepRow({ step, idPrefix, onInspect = null }: StepRowProps) {
  const result = step.result;
  const summary = result?.summary ?? '';
  const scope = scopeLine(result);
  const untrustedMap = result?.untrusted_params ?? {};
  const untrusted = Object.entries(untrustedMap);
  // Most tools put the same input in both maps: a key shown as untrusted text (mono) is
  // shown ONCE, never also as a plain chip (it read as if applied twice).
  const params = Object.entries(result?.params ?? step.params).filter(
    ([key]) => !Object.prototype.hasOwnProperty.call(untrustedMap, key),
  );
  const sources = result?.sources ?? [];
  const sourceInParams = [...params, ...untrusted].some(
    ([key]) => key === 'source' || key === 'sources' || key === 'source_id',
  );
  const sourceChip = !sourceInParams && sources.length ? sources : null;
  const duration = result && step.status !== 'running' ? formatDuration(result.duration_ms) : null;
  // A long lookup's count while it runs ("Counted 42,000 of 118,402 cases…").
  const progress = step.status === 'running' && step.progress ? progressLine(step.progress) : null;
  const inspectable = !!onInspect && step.kind === 'tool' && step.status !== 'running' && !!result;
  const word = STEP_STATUS_LABEL[step.status];
  const chips = params.length || untrusted.length || sourceChip;
  return (
    <div className="flex min-w-0 items-start gap-2" data-step-status={step.status}>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <StatusIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="text-sm text-foreground">{step.label}</span>
          {SPOKEN_ONLY.has(step.status) ? (
            <span className="sr-only">{word}</span>
          ) : (
            <span className="text-xs font-medium text-foreground" data-testid="run-log-status">
              {word}
            </span>
          )}
          {duration ? (
            <span className="text-xs tabular-nums text-muted-foreground" data-testid="run-log-duration">
              · {duration}
            </span>
          ) : null}
          {inspectable && onInspect ? (
            <span className="ml-auto self-center">
              <InspectButton step={step} onInspect={onInspect} />
            </span>
          ) : null}
        </div>
        {chips ? (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1" data-testid="run-log-chips">
            {params.map(([key, value]) => (
              <Chip key={key} name={paramKeyLabel(key)} value={paramValue(value, key)} />
            ))}
            {sourceChip ? <SourcesChip names={sourceChip} id={`${idPrefix}-s${step.index}-sources`} /> : null}
            {untrusted.map(([key, value]) => (
              <Chip key={`u-${key}`} name={paramKeyLabel(key)} value={value} mono />
            ))}
          </div>
        ) : null}
        {progress ? (
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground" data-testid="run-log-progress">
            {progress}
          </p>
        ) : null}
        {summary || scope ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {summary}
            {summary && scope ? ' · ' : ''}
            {scope}
          </p>
        ) : null}
        {result?.query ? <QueryDisclosure query={result.query} id={`${idPrefix}-q${step.index}`} /> : null}
      </div>
    </div>
  );
}

const NOTE_ICON: Record<RunNoteKind, React.ComponentType<{ className?: string }>> = {
  continued: TextCursorInput,
  compacted: ListCollapse,
  wrapped: Flag,
  repeat: Repeat2,
};

/** One quiet note row: a muted line, no status word (it describes the engine, not data). */
function NoteRow({ note, step }: { note: RunLogNote; step: RunLogStep | null }) {
  const Icon = NOTE_ICON[note.kind];
  const running = step?.status === 'running';
  const duration = step?.result && !running ? formatDuration(step.result.duration_ms) : null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" data-run-note={note.kind}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {running ? <LoadingGlyph size="sm" className="size-3.5" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
      </span>
      <span className="min-w-0">{note.text}</span>
      {duration ? <span className="ml-auto shrink-0 text-2xs tabular-nums">{duration}</span> : null}
    </div>
  );
}

export interface RunLogListProps {
  steps: readonly RunLogStep[];
  /** DOM id (the disclosure's `aria-controls` target). */
  id: string;
  hidden?: boolean;
  /** Quiet notes the host adds after the steps (e.g. "Stopped repeating the same lookup"). */
  notes?: readonly RunLogNote[];
  /** Open the step inspector for a settled lookup (Round 12, P1-1). */
  onInspect?: ((step: RunLogStep, opener: HTMLElement) => void) | null;
  className?: string;
}

/** The live log before any lookup ran (T20): what the assistant is doing, never "No lookups yet." */
export const PENDING_TEXT = {
  reading: 'Reading your question…',
  choosing: 'Choosing lookups…',
} as const;

/** The engine's label of a model call that is still deciding what to look up. */
const THINKING_LABEL = 'Thinking';

/**
 * What the live log says while no lookup has run yet, or null once it has one to show:
 * "Reading your question…" before the first model call, "Choosing lookups…" while that
 * call decides. A model step that writes the answer straight away keeps its own row.
 */
export function pendingLine(steps: readonly RunLogStep[], notes: readonly RunLogNote[] = []): string | null {
  if (notes.length || steps.some((step) => step.kind === 'tool')) return null;
  if (!steps.length) return PENDING_TEXT.reading;
  const last = steps[steps.length - 1];
  if (steps.every((step) => step.kind === 'model' && quietModelNote(step) === null) && last.status === 'running' && last.label === THINKING_LABEL) {
    return PENDING_TEXT.choosing;
  }
  return null;
}

/** The rows themselves; the host owns the disclosure that shows or hides them. */
export function RunLogList({ steps, id, hidden = false, notes = [], onInspect = null, className }: RunLogListProps) {
  const rows = React.useMemo(() => buildRunRows(steps), [steps]);
  const pending = pendingLine(steps, notes);
  const empty = pending !== null || (!rows.length && !notes.length);
  return (
    <div id={id} hidden={hidden} className={className}>
      {!empty ? (
        <ol className="space-y-2 border-l border-border pl-3" aria-label="Lookups">
          {rows.map((row) =>
            row.kind === 'step' ? (
              <li key={`s${row.step.index}`}>
                <StepRow step={row.step} idPrefix={id} onInspect={onInspect} />
              </li>
            ) : row.kind === 'note' ? (
              <li key={row.note.key}>
                <NoteRow note={row.note} step={row.step} />
              </li>
            ) : (
              <li key={`g${row.group}-${row.steps[0].index}`}>
                <p className="mb-1 text-2xs text-muted-foreground">In parallel · {lookupsLabel(row.steps.length)}</p>
                <ol className="space-y-2 rounded-md border border-border/70 px-2 py-1.5">
                  {row.steps.map((step) => (
                    <li key={`s${step.index}`}>
                      <StepRow step={step} idPrefix={id} onInspect={onInspect} />
                    </li>
                  ))}
                </ol>
              </li>
            ),
          )}
          {notes.map((note) => (
            <li key={note.key}>
              <NoteRow note={note} step={null} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="run-log-pending">
          <LoadingGlyph size="sm" className="size-4" aria-hidden />
          {pending ?? PENDING_TEXT.reading}
        </p>
      )}
    </div>
  );
}

export interface RunLogHeaderProps {
  live: ChatLiveTurn;
  open: boolean;
  onToggle: () => void;
  /** The list's DOM id. */
  controls: string;
}

/**
 * The live header (Round 13, SPEC-chat T20): "Working · 3 lookups" on the left, the live
 * usage "1.2k tokens · $0.002" on the right, muted and `tabular-nums` (the live cost stays,
 * Round 12 D5), plus an output estimate (≈) while answer text streams. The left part is
 * the run log's disclosure button (`aria-expanded` / `aria-controls`).
 */
export function RunLogHeader({ live, open, onToggle, controls }: RunLogHeaderProps) {
  const lookups = live.steps.filter((step) => step.kind === 'tool').length;
  const state =
    live.connection === 'recovering'
      ? 'Connection lost. Checking whether the answer was saved'
      : live.stopping
        ? 'Stopping after the current step'
        : live.waiting
          ? 'Waiting for another answer to finish'
          : 'Working';
  const counts = lookups ? [lookupsLabel(lookups)] : [];
  const usage: string[] = [];
  if (live.usage) {
    const approx = live.usage.estimated ? '≈ ' : '';
    usage.push(`${approx}${compactTokens(live.usage.total_tokens)} tokens`);
    usage.push(`${approx}${formatCost(live.usage.cost)}`);
    if (live.usage.simulated) usage.push('simulated');
  }
  if (live.text) usage.push(`≈ ${compactTokens(Math.ceil(live.text.length / 4))} output tokens`);
  // Each figure group stays whole ("· 4 lookups", "≈ 1.2k tokens", "· $0.04"): a line
  // breaks only BETWEEN groups, so a count is never split from its unit. The state is a
  // sentence and wraps between its words like any prose ("Connection lost. Checking
  // whether the answer was saved" is wider than a phone's header row). The row wraps
  // too, so on a narrow column the usage drops under the progress instead of squeezing it.
  const groups = (parts: readonly string[], after = false) =>
    parts.map((part, i) => (
      <React.Fragment key={`${i}-${part}`}>
        {i || after ? ' ' : null}
        <span className="whitespace-nowrap" data-figure-group="">
          {i || after ? `· ${part}` : part}
        </span>
      </React.Fragment>
    ));
  return (
    <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground" data-testid="run-log-header-row">
      <button
        type="button"
        className="inline-flex min-h-7 min-w-0 items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
        data-testid="run-log-header"
      >
        <LoadingGlyph size="sm" className="size-4" aria-hidden />
        <span className="min-w-0 tabular-nums" data-testid="run-log-progress-label">
          <span data-run-state="">{state}</span>
          {groups(counts, true)}
        </span>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
      </button>
      {usage.length ? (
        <span className="ml-auto min-w-0 text-right tabular-nums" data-testid="run-log-usage">
          {groups(usage)}
        </span>
      ) : null}
    </div>
  );
}
