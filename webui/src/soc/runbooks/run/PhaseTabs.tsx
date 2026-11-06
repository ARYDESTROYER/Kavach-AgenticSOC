/**
 * The phase tabs of a run (Round 14, SPEC §4.10.11, C10 B): one tab per phase the
 * runbook uses ("Triage 3/3", "Investigate 1/4", "Contain 0/2" with a 6px amber dot when a
 * step waits for approval), one tab stop with arrow keys (Radix Tabs), and below them only
 * the selected phase's steps.
 *
 * The dot's fact is in the tab's accessible name ("Contain, 0 of 2 done, 1 waiting"). The
 * selected tab is a neutral `bg-accent` fill with a neutral border, so only the Next step
 * card carries the primary rail; in forced colours (where fills and border colours go) it
 * keeps a 2px outline, so the selection never rests on colour alone. A bar fills with Done steps only; waiting is never drawn
 * as progress. On a narrow pane the tabs scroll sideways with a fade at the edge.
 */
import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import type { PhaseId } from '@/lib/types-runbooks';
import { PHASE_LABEL, phaseFrameworkLine, WaitingDot } from '@/soc/runbooks/shared';

import { useRunbookRun } from './context';
import { nextStep, numberedSteps, phaseCounts, phaseTabName, phaseWords } from './model';
import { focusHeading } from './NextStepCard';
import { StepRow } from './StepRow';

export interface PhaseTabsProps {
  /** The selected phase (controlled by the panel, defaulting to the Next step's). */
  phase: PhaseId;
  onPhaseChange: (phase: PhaseId) => void;
  narrow: boolean;
}

export function PhaseTabs({ phase, onPhaseChange, narrow }: PhaseTabsProps) {
  const ctx = useRunbookRun();
  const run = ctx.run;
  const counts = phaseCounts(run);
  const steps = numberedSteps(run);
  const next = nextStep(run);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // A request to open one step (from the Overview card or the "steps left" list).
  const reveal = ctx.revealRequest;
  React.useEffect(() => {
    if (!reveal) return;
    const target = steps.find((s) => s.step.id === reveal.stepId);
    if (!target) return;
    if (target.step.phase !== phase) onPhaseChange(target.step.phase);
    if (next?.step.id !== target.step.id) setExpanded(target.step.id);
    requestAnimationFrame(() => {
      const button =
        Array.from(document.querySelectorAll<HTMLElement>('[data-step-button]')).find(
          (el) => el.dataset.stepButton === target.step.id,
        ) ?? null;
      if (button) focusHeading(button);
      else focusHeading(document.querySelector<HTMLElement>('[data-next-step-heading]'));
    });
    // Only a new request moves anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.tick]);

  const showCard = () => focusHeading(document.querySelector<HTMLElement>('[data-next-step-heading]'));

  return (
    <Tabs value={phase} onValueChange={(v) => onPhaseChange(v as PhaseId)} data-runbook-phases="">
      <div className="relative">
        <TabsList
          ref={listRef}
          aria-label="Phases"
          className={cn(
            'flex h-auto w-full justify-start gap-2 overflow-x-auto rounded-none border-0 bg-transparent p-0',
            narrow && 'pr-8',
          )}
        >
          {counts.map((c) => {
            const complete = c.open === 0;
            const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
            return (
              <TabsTrigger
                key={c.phase}
                value={c.phase}
                aria-label={phaseTabName(c)}
                data-phase={c.phase}
                className={cn(
                  'group block h-auto min-w-[8.5rem] flex-1 whitespace-normal rounded-lg border border-border px-3 py-2 text-left font-normal',
                  'hover:bg-muted/60 data-[state=active]:border-border-strong data-[state=active]:bg-accent data-[state=active]:text-foreground',
                  'forced-colors:data-[state=active]:outline forced-colors:data-[state=active]:outline-2 forced-colors:data-[state=active]:-outline-offset-2',
                )}
              >
                <span className="flex items-center gap-1.5" aria-hidden>
                  {complete ? (
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-success text-success-foreground">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                  ) : null}
                  <span className="text-sm font-medium text-foreground">{PHASE_LABEL[c.phase]}</span>
                </span>
                <span className="relative mt-1.5 block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span
                    className={cn('absolute inset-y-0 left-0 rounded-full', complete ? 'bg-success' : 'bg-primary')}
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground" aria-hidden>
                  <span className="min-w-0">
                    {c.done.toLocaleString()}/{c.total.toLocaleString()} · {phaseWords(c)}
                  </span>
                  {c.waiting ? <WaitingDot /> : null}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        {narrow ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent"
          />
        ) : null}
      </div>
      {counts.map((c) => {
        const inPhase = steps.filter((s) => s.step.phase === c.phase);
        return (
          <TabsContent key={c.phase} value={c.phase} animate={false} className="mt-4 space-y-2" data-phase-panel={c.phase}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1">
              <h3 className="text-sm font-semibold text-foreground">{PHASE_LABEL[c.phase]}</h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                {c.done.toLocaleString()} of {c.total.toLocaleString()} done
                {c.na ? ` · ${c.na.toLocaleString()} not applicable` : ''}
              </span>
              {narrow ? null : <span className="ml-auto text-xs text-muted-foreground">{phaseFrameworkLine(c.phase)}</span>}
            </div>
            <ol className="rounded-lg border border-border bg-card" aria-label={`${PHASE_LABEL[c.phase]} steps`}>
              {inPhase.map((item) => (
                <StepRow
                  key={item.step.id}
                  item={item}
                  expanded={expanded === item.step.id}
                  onToggle={() => setExpanded((cur) => (cur === item.step.id ? null : item.step.id))}
                  shownAbove={next?.step.id === item.step.id}
                  onShowAbove={showCard}
                />
              ))}
            </ol>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
