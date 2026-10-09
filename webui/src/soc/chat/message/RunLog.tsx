/**
 * RunLog — the per-turn record of lookups (chat revamp SPEC §10.3, §10.9).
 *
 * One row per tool call, or one framed row per parallel batch (steps sharing a
 * `group`). A row reads: status icon + status WORD (never colour alone), the engine
 * label, the whitelisted parameter chips (effective window and source included),
 * the engine summary, rows / basis / coverage, the duration, and the exact query
 * behind an expandable "Query" disclosure rendered as untrusted code.
 *
 * Model steps add no rows of their own (their tokens tick on the header). The one
 * exception is the step the turn is waiting on — "Thinking", or "Writing the answer"
 * for the final-only step — and a failed model call, which must stay visible.
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
  Square,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatStep } from '@/lib/types';
import { LoadingGlyph } from '@/design-system';
import { CodeBlock } from '@/soc/components/CodeBlock';
import type { ChatLiveTurn } from '../useChatEngine';
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
  }));
}

type Row = { kind: 'step'; step: RunLogStep } | { kind: 'group'; group: number; steps: RunLogStep[] };

/**
 * The rows to draw. Tool steps sharing a `group` collapse into one framed row; a model
 * step is kept only while it runs (the turn is waiting on it), when it failed, or when
 * it is the last step of the turn (the "Wrote the answer" row).
 */
export function buildRunRows(steps: readonly RunLogStep[]): Row[] {
  const rows: Row[] = [];
  const last = steps[steps.length - 1];
  steps.forEach((step) => {
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
    return <LoadingGlyph size="sm" className="size-3.5" aria-hidden />;
  }
  const { icon: Icon, tone } = STATUS_ICON[status];
  return <Icon className={cn('size-3.5 shrink-0', tone)} aria-hidden />;
}

function Chip({ name, value, mono = false }: { name: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-sm border border-border bg-surface px-1.5 text-2xs">
      <span className="shrink-0 text-muted-foreground">{name}</span>
      <span className={cn('min-w-0 truncate text-foreground', mono && 'font-mono')}>{value}</span>
    </span>
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

function StepRow({ step, idPrefix }: { step: RunLogStep; idPrefix: string }) {
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
  const duration = result && step.status !== 'running' ? formatDuration(result.duration_ms) : null;
  return (
    <div className="flex min-w-0 items-start gap-2" data-step-status={step.status}>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        <StatusIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm text-foreground">{step.label}</span>
          {params.map(([key, value]) => (
            <Chip key={key} name={paramKeyLabel(key)} value={paramValue(value, key)} />
          ))}
          {!sourceInParams && sources.length ? <Chip name="Source" value={sources.join(', ')} /> : null}
          {untrusted.map(([key, value]) => (
            <Chip key={`u-${key}`} name={paramKeyLabel(key)} value={value} mono />
          ))}
          <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">
            {STEP_STATUS_LABEL[step.status]}
            {duration ? ` · ${duration}` : ''}
          </span>
        </div>
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

export interface RunLogListProps {
  steps: readonly RunLogStep[];
  /** DOM id (the disclosure's `aria-controls` target). */
  id: string;
  hidden?: boolean;
  className?: string;
}

/** The rows themselves; the host owns the disclosure that shows or hides them. */
export function RunLogList({ steps, id, hidden = false, className }: RunLogListProps) {
  const rows = React.useMemo(() => buildRunRows(steps), [steps]);
  return (
    <div id={id} hidden={hidden} className={className}>
      {rows.length ? (
        <ol className="space-y-2 border-l border-border pl-3" aria-label="Lookups">
          {rows.map((row) =>
            row.kind === 'step' ? (
              <li key={`s${row.step.index}`}>
                <StepRow step={row.step} idPrefix={id} />
              </li>
            ) : (
              <li key={`g${row.group}-${row.steps[0].index}`}>
                <p className="mb-1 text-2xs text-muted-foreground">In parallel · {lookupsLabel(row.steps.length)}</p>
                <ol className="space-y-2 rounded-md border border-border/70 px-2 py-1.5">
                  {row.steps.map((step) => (
                    <li key={`s${step.index}`}>
                      <StepRow step={step} idPrefix={id} />
                    </li>
                  ))}
                </ol>
              </li>
            ),
          )}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">No lookups yet.</p>
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
 * The live header: "Working · 3 lookups · 1.2k tokens · $0.002", updated on every
 * `usage` event, plus an output estimate (≈) while answer text streams. It is the
 * run log's disclosure button (`aria-expanded` / `aria-controls`).
 */
export function RunLogHeader({ live, open, onToggle, controls }: RunLogHeaderProps) {
  const lookups = live.steps.filter((step) => step.kind === 'tool').length;
  const state =
    live.connection === 'recovering'
      ? 'Connection lost — checking whether the answer was saved'
      : live.stopping
        ? 'Stopping after the current step'
        : 'Working';
  const parts = [state];
  if (lookups) parts.push(lookupsLabel(lookups));
  if (live.usage) {
    const approx = live.usage.estimated ? '≈ ' : '';
    parts.push(`${approx}${compactTokens(live.usage.total_tokens)} tokens`);
    parts.push(`${approx}${formatCost(live.usage.cost)}`);
    if (live.usage.simulated) parts.push('simulated');
  }
  if (live.text) parts.push(`≈ ${compactTokens(Math.ceil(live.text.length / 4))} output tokens`);
  return (
    <button
      type="button"
      className="inline-flex min-h-7 max-w-full items-center gap-2 rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      data-testid="run-log-header"
    >
      <LoadingGlyph size="sm" className="size-3.5" aria-hidden />
      <span className="min-w-0 truncate tabular-nums">{parts.join(' · ')}</span>
      <ChevronRight className={cn('size-3.5 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
    </button>
  );
}
