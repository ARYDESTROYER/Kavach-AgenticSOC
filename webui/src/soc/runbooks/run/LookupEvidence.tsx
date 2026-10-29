/**
 * A Lookup step's evidence inside a case (Round 14, SPEC §4.10.8, §4.10.11): the result
 * "Collected automatically" (or run by a person), its resolved parameters and window, the
 * facts and the table, or a "Run lookup" box when nothing ran yet.
 *
 * Every value in a result came from logs, cases or intelligence: untrusted data, rendered
 * as plain text nodes and never as markup or links (#9). A result the viewer may not see
 * arrives redacted from the server (`not_applicable` with the access sentence); it is
 * shown as that sentence and nothing is inferred from its status. A `rows` table holds raw
 * log rows that are shown to people only and never reach a model (#7). Running a lookup
 * is read-only (#1) and never changes the case (#3).
 */
import * as React from 'react';
import { ChevronDown, Lock, Play, RotateCcw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import type { LookupResult, LookupTool, RunbookStep } from '@/lib/types-runbooks';
import { Mono, ProvenanceChip, TemplateChip, templateValueOf, TEMPLATE_VALUE_LABEL, windowLabel } from '@/soc/runbooks/shared';

import { actorName, utcRange, utcTime, type NameOf } from './model';
import { keepNoteFocus } from './StepParts';
import { ARIA_DISABLED_LOOK } from './ui';

/** The short name of each lookup tool in a run. */
export const LOOKUP_TOOL_SHORT: Readonly<Record<LookupTool, string>> = {
  log_stats: 'Log counts',
  log_search: 'Log search',
  enrich: 'Indicator reputation',
  related_cases: 'Related cases',
  campaign: 'Campaign membership',
  mitre: 'ATT&CK context',
};

/** What a viewer without the tool's grant reads in place of the evidence (SPEC §4.10.8). */
export const NO_ACCESS_SENTENCE: Readonly<Record<LookupTool, string>> = {
  log_stats: 'You do not have access to log data.',
  log_search: 'You do not have access to log data.',
  enrich: 'You do not have access to enrichment results.',
  related_cases: 'You do not have access to cases.',
  campaign: 'You do not have access to cases.',
  mitre: 'You do not have access to runbooks.',
};

export const LOOKUP_UNTRUSTED_NOTE = 'Read-only. Log values are shown as untrusted data.';

function toolName(tool: string): string {
  return LOOKUP_TOOL_SHORT[tool as LookupTool] ?? tool;
}

/**
 * True for a cell that reads as one number ("412", "1,204", "≥ 37", "-3.5", "12%"), never
 * for an identifier made of digits and dots (an IPv4 address, a version), which stays in
 * the monospace face like every other identifier.
 */
export function isNumeric(value: string): boolean {
  const text = value.trim();
  if (!text || (text.match(/\./g) ?? []).length > 1) return false;
  return /^[<>≥≤=]?\s*-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/.test(text);
}

/** Facts longer than this take the whole row instead of one column. */
const LONG_FACT_CHARS = 24;

/** The lookup as written, before it ran: its filters (case values as chips) and window. */
export function LookupPlan({ step, className }: { step: RunbookStep; className?: string }) {
  const lookup = step.lookup;
  if (!lookup) return null;
  const filters = Object.entries(lookup.filter ?? {});
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs', className)} aria-label="What it looks up">
      {filters.map(([field, value]) => {
        const template = templateValueOf(value);
        return (
          <li key={field} className="inline-flex min-w-0 items-center gap-1.5">
            <Mono>{field}</Mono>
            <span className="text-muted-foreground">=</span>
            {template ? (
              <TemplateChip>
                <span title={TEMPLATE_VALUE_LABEL[template]}>{`{{${template}}}`}</span>
              </TemplateChip>
            ) : (
              <Mono>{value}</Mono>
            )}
          </li>
        );
      })}
      {lookup.indicator ? (
        <li className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">Indicator</span>
          <TemplateChip>{lookup.indicator}</TemplateChip>
        </li>
      ) : null}
      {lookup.group_by?.length ? (
        <li className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">Grouped by</span>
          {lookup.group_by.map((g) => (
            <Mono key={g}>{g}</Mono>
          ))}
        </li>
      ) : null}
      <li className="text-muted-foreground">{windowLabel(lookup.window)}</li>
    </ul>
  );
}

export interface LookupEvidenceProps {
  step: RunbookStep;
  result: LookupResult | null;
  /** The viewer may run lookups (runbooks:run and the tool's grant). */
  canRunLookup: boolean;
  /** The viewer holds the tool's grant (else the access sentence is shown). */
  canSeeTool: boolean;
  /** The run is not abandoned (an abandoned run's lookups are never run again). */
  runWorkable: boolean;
  busy: boolean;
  onRun: () => void;
  nameOf?: NameOf;
  /** "Ran again at 14:31 UTC; the earlier result was replaced." after a re-run. */
  ranAgainNote?: string | null;
  /** The step is Done or Not applicable already (a result may never have been attached). */
  stepFinished?: boolean;
  /** When the run attached: an automatic lookup is still expected for a short while. */
  attachedAt?: string | null;
  /**
   * A narrow pane: a lookup that has not run shows its name and Run lookup, with what it
   * looks up one click away, so the step's primary action stays above the fold.
   */
  compact?: boolean;
  now?: Date;
}

/** How long after attachment an automatic lookup's result is still expected. */
const AUTO_LOOKUP_WINDOW_MS = 120_000;

/** The sentence under a lookup that has no result yet. */
function pendingWords(step: RunbookStep, stepFinished: boolean, attachedAt: string | null | undefined, offerRun: boolean, now: Date): string | null {
  if (stepFinished) return 'No lookup result is attached to this step.';
  if (step.lookup?.run === 'on_attach') {
    const since = attachedAt ? now.getTime() - Date.parse(attachedAt) : Number.POSITIVE_INFINITY;
    if (since >= 0 && since < AUTO_LOOKUP_WINDOW_MS) return 'This lookup runs on its own when the runbook starts. Its result appears here.';
    return offerRun ? 'No result was attached when the runbook started. Run the lookup to collect one.' : 'No result was attached when the runbook started.';
  }
  return offerRun ? 'Run the lookup to collect the result.' : null;
}

export function LookupEvidence({
  step,
  result,
  canRunLookup,
  canSeeTool,
  runWorkable,
  busy,
  onRun,
  nameOf,
  ranAgainNote = null,
  stepFinished = false,
  attachedAt = null,
  compact = false,
  now = new Date(),
}: LookupEvidenceProps) {
  const tool = (step.lookup?.tool ?? result?.tool ?? 'log_search') as LookupTool;
  const offerRun = canRunLookup && runWorkable;
  const [planOpen, setPlanOpen] = React.useState(false);
  const planId = React.useId();
  const runButton = (label: string, icon: React.ReactNode) => (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={cn('h-7 px-2.5', ARIA_DISABLED_LOOK)}
      onMouseDown={keepNoteFocus}
      onClick={busy ? undefined : onRun}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
    >
      {icon}
      {busy ? 'Running' : label}
    </Button>
  );

  if (!result) {
    const pending = pendingWords(step, stepFinished, attachedAt, offerRun, now);
    return (
      <section aria-label="Lookup" data-lookup-state="pending" className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground">{toolName(tool)}</span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" aria-hidden />
            Read-only · filled from the case
          </span>
          {offerRun ? <span className="ml-auto">{runButton('Run lookup', <Play aria-hidden />)}</span> : null}
        </div>
        {compact && step.lookup ? (
          <div className="mt-1.5">
            <button
              type="button"
              aria-expanded={planOpen}
              aria-controls={planId}
              onClick={() => setPlanOpen((v) => !v)}
              className="inline-flex min-h-6 items-center gap-1 rounded-sm text-xs font-medium text-secondary-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown className={cn('size-3.5 transition-transform duration-fast', planOpen && 'rotate-180')} aria-hidden />
              What it looks up
            </button>
            <div id={planId} hidden={!planOpen}>
              <LookupPlan step={step} className="mt-1.5" />
            </div>
          </div>
        ) : (
          <LookupPlan step={step} className="mt-2" />
        )}
        {!canSeeTool ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{NO_ACCESS_SENTENCE[tool] ?? NO_ACCESS_SENTENCE.log_search}</p>
        ) : runWorkable && pending ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{pending}</p>
        ) : null}
      </section>
    );
  }

  const byPerson = result.ran_by && result.ran_by !== 'agentic_soc';
  const facts = (result.facts ?? []).filter((f) => f && typeof f.label === 'string');
  const table = result.table && Array.isArray(result.table.columns) && Array.isArray(result.table.rows) ? result.table : null;
  const params = Object.entries(result.params ?? {});
  const windowText = result.window_clamped
    ? `Searched up to collection, ${utcTime(result.window_to, now)}`
    : result.window_from && result.window_to
      ? utcRange(result.window_from, result.window_to, now)
      : '';
  const redactedOrSkipped = result.status === 'not_applicable';
  // A column is numeric (right-aligned, tabular figures, header too) only when every
  // filled cell in it reads as a number.
  const numericColumn = table
    ? table.columns.map((_, c) => {
        const cells = table.rows
          .map((row) => row[c])
          .filter((cell) => cell !== null && cell !== undefined && String(cell).trim() !== '')
          .map((cell) => String(cell));
        return cells.length > 0 && cells.every(isNumeric);
      })
    : [];
  return (
    <section aria-label="Lookup result" data-lookup-state={result.status} className="overflow-hidden rounded-md border border-border">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 bg-muted/30 px-3 py-2">
        {byPerson ? (
          <ProvenanceChip kind="person">
            Run by {actorName(result.ran_by, nameOf)} at {utcTime(result.ran_at, now)}
          </ProvenanceChip>
        ) : (
          <ProvenanceChip kind="auto">Collected automatically at {utcTime(result.ran_at, now)}</ProvenanceChip>
        )}
        <span className="text-xs text-muted-foreground">{toolName(String(result.tool || tool))}</span>
        {offerRun && !redactedOrSkipped ? <span className="ml-auto">{runButton('Run again', <RotateCcw aria-hidden />)}</span> : null}
        {offerRun && redactedOrSkipped && canSeeTool ? (
          <span className="ml-auto">{runButton('Run again', <RotateCcw aria-hidden />)}</span>
        ) : null}
      </header>

      {params.length || windowText ? (
        <p className="flex flex-wrap gap-x-1.5 gap-y-0.5 border-b border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
          {params.map(([k, v], i) => (
            <React.Fragment key={k}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              <span className="font-mono [overflow-wrap:anywhere]">
                {k} = {v}
              </span>
            </React.Fragment>
          ))}
          {windowText ? (
            <>
              {params.length ? <span aria-hidden>·</span> : null}
              <span className="whitespace-nowrap tabular-nums">{windowText}</span>
            </>
          ) : null}
        </p>
      ) : null}

      {redactedOrSkipped ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">{result.reason || 'This lookup does not apply to this case.'}</p>
      ) : result.status === 'error' ? (
        <p role="status" className="px-3 py-2 text-sm text-critical-text">
          {result.reason || 'The lookup could not run.'}
        </p>
      ) : (
        <>
          {facts.length ? (
            <dl className="grid grid-cols-1 divide-y divide-border/70 border-b border-border/70 @[30rem]/run:grid-cols-3 @[30rem]/run:divide-x @[30rem]/run:divide-y-0">
              {facts.map((f, i) => {
                const value = String(f.value ?? '');
                const figure = isNumeric(value);
                return (
                  <div
                    key={`${f.label}-${i}`}
                    className={cn(
                      'flex min-w-0 items-baseline gap-x-3 px-3 py-2 @[30rem]/run:block',
                      !figure && value.length > LONG_FACT_CHARS && '@[30rem]/run:col-span-full @[30rem]/run:border-t @[30rem]/run:border-border/70',
                    )}
                  >
                    <dt className="w-28 shrink-0 text-xs text-muted-foreground @[30rem]/run:w-auto">{f.label}</dt>
                    <dd
                      className={cn(
                        'min-w-0 text-foreground [overflow-wrap:anywhere]',
                        figure ? 'text-md font-semibold leading-6 tabular-nums' : 'text-sm',
                      )}
                    >
                      {value}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
          {result.status === 'empty' ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              {result.window_clamped
                ? 'Nothing matched up to the time it ran. Events collected later are not counted yet.'
                : 'Nothing matched in this window.'}
            </p>
          ) : null}
          {table && table.rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <caption className="sr-only">
                  {result.table_kind === 'rows' ? 'Raw log rows, shown to you only' : 'Counts per value'}
                </caption>
                <thead>
                  <tr className="text-left text-muted-foreground">
                    {table.columns.map((col, i) => (
                      <th
                        key={`${col}-${i}`}
                        scope="col"
                        className={cn('whitespace-nowrap px-3 py-1.5 font-medium', numericColumn[i] && 'text-right')}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {table.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => {
                        const text = cell === null || cell === undefined ? '' : String(cell);
                        return (
                          <td
                            key={c}
                            className={cn(
                              'max-w-[18rem] px-3 py-1.5 align-top text-foreground [overflow-wrap:anywhere]',
                              numericColumn[c] ? 'text-right tabular-nums' : 'font-mono',
                            )}
                          >
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {result.reason ? <p className="border-t border-border/70 px-3 py-1.5 text-xs text-muted-foreground">{result.reason}</p> : null}
        </>
      )}

      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
        <span>{result.table_kind === 'rows' ? `${LOOKUP_UNTRUSTED_NOTE} Raw rows are shown to you only.` : LOOKUP_UNTRUSTED_NOTE}</span>
        {ranAgainNote ? <span className="text-foreground">{ranAgainNote}</span> : null}
      </footer>
    </section>
  );
}
