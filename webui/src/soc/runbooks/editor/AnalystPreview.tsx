/**
 * "Preview as analyst" (Round 14, SPEC §4.10.12): the run view as an analyst will see it
 * before anyone starts, phase by phase, every step To do. "Fill with CASE-000214" resolves
 * the lookup template values from one case the match preview found (its primary entity, rule
 * and source); a value the case does not have stays a template chip with a note. The
 * investigator guidance meter shows the server's measured length against the budget
 * (§4.10.9): "Investigator guidance: 2,140 of 3,000 characters".
 *
 * Every case value is shown as plain text (#9); nothing here writes anything.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import type { PhaseId, RunbookDefinition, RunbookStep, RunbookTemplateValue } from '@/lib/types-runbooks';
import { Button } from '@/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

import { KindChip, StatusMark, TemplateChip } from '../shared/chips';
import {
  LOOKUP_TOOL_LABEL,
  PHASE_LABEL,
  PHASE_ORDER,
  phaseFrameworkLine,
  templateToken,
  templateValueOf,
  windowLabel,
} from '../shared/labels';

/** The case values a preview fills, keyed by template value. */
export type CaseValues = Partial<Record<RunbookTemplateValue, string>>;

export interface PreviewCase {
  case_id: string;
  case_number: string;
  title: string;
}

export interface AnalystPreviewProps {
  defn: RunbookDefinition;
  /** Cases to fill from (the match preview's "Gets it" list first). */
  cases: PreviewCase[];
  /** Resolves one case's values; the editor reads the case once and caches it. */
  loadCaseValues?: (caseId: string) => Promise<CaseValues>;
  /** The server's measured investigator guidance length and budget, when validated. */
  guidance: { chars: number; budget: number } | null;
  className?: string;
}

function phasesOf(defn: RunbookDefinition): PhaseId[] {
  const used = new Set(defn.steps.map((s) => s.phase));
  return PHASE_ORDER.filter((p) => used.has(p));
}

/** One filter value, filled from the case when it can be. */
function FilterValue({ value, values }: { value: string; values: CaseValues | null }) {
  const template = templateValueOf(value);
  if (!template) return <span className="font-mono text-xs text-foreground">{value}</span>;
  const filled = values?.[template];
  if (filled) {
    return (
      <span className="font-mono text-xs text-foreground" data-filled-from={template}>
        {filled}
      </span>
    );
  }
  return <TemplateChip>{templateToken(template)}</TemplateChip>;
}

function LookupLine({ step, values }: { step: RunbookStep; values: CaseValues | null }) {
  const l = step.lookup;
  if (!l) return null;
  const entries = Object.entries(l.filter);
  return (
    <div className="mt-1.5 space-y-1 text-xs text-muted-foreground" data-preview-lookup="">
      <span className="block">
        {LOOKUP_TOOL_LABEL[l.tool]}
        {l.tool === 'log_stats' || l.tool === 'log_search' || l.tool === 'related_cases' ? ` · ${windowLabel(l.window)}` : ''}
      </span>
      {entries.map(([k, v]) => (
        <span key={k} className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono">{k}</span>
          <span>equals</span>
          <FilterValue value={v} values={values} />
        </span>
      ))}
      {l.indicator ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>Enriches</span>
          <FilterValue value={l.indicator} values={values} />
        </span>
      ) : null}
      {l.group_by.length ? <span className="block">Grouped by {l.group_by.join(', ')}</span> : null}
    </div>
  );
}

export function GuidanceMeter({ guidance }: { guidance: { chars: number; budget: number } | null }) {
  if (!guidance) {
    return <p className="text-sm text-muted-foreground">Investigator guidance is measured once the runbook checks out.</p>;
  }
  const over = guidance.chars > guidance.budget;
  const pct = Math.min(100, Math.round((guidance.chars / Math.max(1, guidance.budget)) * 100));
  return (
    <div className="space-y-1.5" data-guidance-meter={over ? 'over' : 'ok'}>
      <p className={cn('text-sm', over ? 'font-medium text-critical-text' : 'text-foreground')}>
        Investigator guidance: {guidance.chars.toLocaleString()} of {guidance.budget.toLocaleString()} characters
      </p>
      <div
        role="meter"
        aria-label="Investigator guidance length"
        aria-valuemin={0}
        aria-valuemax={guidance.budget}
        aria-valuenow={Math.min(guidance.chars, guidance.budget)}
        aria-valuetext={`${guidance.chars.toLocaleString()} of ${guidance.budget.toLocaleString()} characters`}
        className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full', over ? 'bg-critical' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {over
          ? 'Over the budget: shorten the focus, escalate and benign lines of the Triage and Investigate steps before publishing.'
          : 'The investigator reads the title, summary, use when, and the focus, escalate and benign lines of the Triage and Investigate steps. Instructions are for people only.'}
      </p>
    </div>
  );
}

export function AnalystPreview({ defn, cases, loadCaseValues, guidance, className }: AnalystPreviewProps) {
  const [caseId, setCaseId] = React.useState<string>('');
  // The values shown and the case they were read from, kept together: choosing another case
  // in the list does not change whose values the lookups show until "Fill" reads it.
  const [filled, setFilled] = React.useState<{ caseId: string; values: CaseValues } | null>(null);
  const [state, setState] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const chosen = cases.find((c) => c.case_id === caseId) ?? cases[0] ?? null;
  const values = filled?.values ?? null;
  const filledCase = filled ? cases.find((c) => c.case_id === filled.caseId) ?? { case_id: filled.caseId, case_number: '', title: '' } : null;

  const fill = async () => {
    if (!chosen || !loadCaseValues) return;
    const target = chosen.case_id;
    setState('loading');
    try {
      const next = await loadCaseValues(target);
      setFilled({ caseId: target, values: next });
      setState('idle');
    } catch {
      setState('error');
    }
  };

  const templatesUsed = defn.steps.flatMap((s) =>
    s.lookup ? [...Object.values(s.lookup.filter), s.lookup.indicator ?? ''].map(templateValueOf).filter(Boolean) : [],
  ) as RunbookTemplateValue[];
  const unfilled = values ? Array.from(new Set(templatesUsed.filter((t) => !values[t]))) : [];

  let number = 0;
  return (
    <section aria-label="Preview as analyst" className={cn('min-w-0 space-y-4', className)} data-analyst-preview="">
      <div className="surface-panel space-y-4 p-4 xl:p-5">
        <GuidanceMeter guidance={guidance} />
        {cases.length && loadCaseValues ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
            <Select value={chosen?.case_id ?? ''} onValueChange={(v) => setCaseId(v)}>
              <SelectTrigger aria-label="Case to fill from" className="h-8 w-auto min-w-[12rem] max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cases.slice(0, 20).map((c) => (
                  <SelectItem key={c.case_id} value={c.case_id}>
                    {c.case_number || c.case_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="sm" onClick={() => void fill()} disabled={state === 'loading'}>
              {`Fill with ${chosen?.case_number || chosen?.case_id || 'a case'}`}
            </Button>
            {filledCase ? (
              <span className="text-sm text-muted-foreground">Values from {filledCase.case_number || filledCase.case_id}.</span>
            ) : null}
            {state === 'error' ? (
              <span role="alert" className="text-sm text-critical-text">
                Could not read that case. Try again.
              </span>
            ) : null}
          </div>
        ) : (
          <p className="border-t border-border/70 pt-3 text-sm text-muted-foreground">
            No recent case matches yet, so the lookups show their case values as placeholders.
          </p>
        )}
        {unfilled.length ? (
          <p className="text-sm text-muted-foreground">
            This case has no value for {unfilled.map(templateToken).join(', ')}; those lookups would say so on the case.
          </p>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">How the Runbook tab of a matching case will look before anyone starts.</p>
      {phasesOf(defn).map((phase) => {
        const steps = defn.steps.filter((s) => s.phase === phase);
        return (
          <section key={phase} aria-label={PHASE_LABEL[phase]} className="space-y-1.5" data-preview-phase={phase}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <h3 className="text-sm font-semibold text-foreground">
                {PHASE_LABEL[phase]}{' '}
                <span className="font-normal text-muted-foreground">
                  {steps.length.toLocaleString()} {steps.length === 1 ? 'step' : 'steps'}
                </span>
              </h3>
              <span className="text-xs text-muted-foreground">{phaseFrameworkLine(phase)}</span>
            </div>
            <ol className="divide-y divide-border/70 rounded-lg border border-border bg-card">
              {steps.map((step) => {
                number += 1;
                return (
                  <li key={step.id} className="flex gap-3 px-3 py-2.5" data-preview-step={step.id}>
                    <StatusMark status="todo" className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
                        <span className="tabular-nums text-muted-foreground">{number.toLocaleString()}</span>
                        <span className="font-medium [overflow-wrap:anywhere]">{step.title || 'Untitled step'}</span>
                        {!step.required ? <span className="text-xs text-muted-foreground">Optional</span> : null}
                      </p>
                      {step.focus ? (
                        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{step.focus}</p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <KindChip kind={step.kind} />
                        {step.kind === 'decision' && step.options.length ? (
                          <span className="text-xs text-muted-foreground">
                            {step.options.map((o) => o.label || o.id).join(' · ')}
                          </span>
                        ) : null}
                      </div>
                      <LookupLine step={step} values={values} />
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </section>
  );
}
