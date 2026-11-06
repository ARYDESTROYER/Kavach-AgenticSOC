/**
 * The "Runbook" section of the case facts rail (Round 14, SPEC §4.10.11): the runbook on
 * the case, its pinned version, the progress, and its phases in a two-column grid with
 * counts, never truncated. A phase opens the Runbook tab on that phase.
 *
 * Read only; titles are Published operator text (#9). Nothing here changes the case (#3).
 */
import { Check } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { CaseRunbooks, PhaseId } from '@/lib/types-runbooks';
import { PHASE_LABEL, WaitingDot } from '@/soc/runbooks/shared';

import { caseProgress, phaseCounts, phaseTabName, primaryRun, runStatusWords } from './model';
import { ProgressLine } from './RunbookStrip';

export interface RunbookRailProps {
  data: CaseRunbooks | null;
  loading?: boolean;
  /** The runbooks could not be read (the section says so, briefly). */
  failed?: boolean;
  onOpenPhase?: (phase: PhaseId | null) => void;
}

export function RunbookRail({ data, loading = false, failed = false, onOpenPhase }: RunbookRailProps) {
  const run = primaryRun(data);
  if (!run) {
    return (
      <p className="text-xs text-muted-foreground" data-runbook-rail="empty">
        {loading && !data
          ? 'Loading the runbook.'
          : failed
            ? 'The runbook could not be read.'
            : 'No runbook is attached to this case.'}
      </p>
    );
  }
  const counts = phaseCounts(run);
  const progress = caseProgress(data);
  const others = (data?.runs.length ?? 1) - 1;
  return (
    <div className="space-y-2" data-runbook-rail="">
      <p className="text-sm text-foreground [overflow-wrap:anywhere]">
        {run.title}
        <span className="text-muted-foreground">
          {' '}
          · v{run.version.toLocaleString()}
          {run.status !== 'active' ? ` · ${runStatusWords(run)}` : ''}
        </span>
      </p>
      {others > 0 ? (
        <p className="text-xs text-muted-foreground">
          And {others.toLocaleString()} more {others === 1 ? 'runbook' : 'runbooks'} on this case
        </p>
      ) : null}
      {progress ? <ProgressLine progress={progress} short /> : null}
      <ul className="grid grid-cols-2 gap-1.5" aria-label="Runbook phases">
        {counts.map((c) => {
          const complete = c.open === 0;
          const body = (
            <>
              <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                {complete ? <Check className="size-3 shrink-0 text-success-text" aria-hidden /> : null}
                <span className="[overflow-wrap:anywhere]">{PHASE_LABEL[c.phase]}</span>
              </span>
              <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                {c.done.toLocaleString()}/{c.total.toLocaleString()}
                {c.waiting ? <WaitingDot /> : null}
              </span>
            </>
          );
          return (
            <li key={c.phase}>
              {onOpenPhase ? (
                <button
                  type="button"
                  onClick={() => onOpenPhase(c.phase)}
                  aria-label={`${phaseTabName(c)}. Open the Runbook tab on this phase`}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-md border border-border px-2 py-1.5 text-left hover:bg-muted/60',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  {body}
                </button>
              ) : (
                <div className="flex flex-col gap-0.5 rounded-md border border-border px-2 py-1.5" aria-label={phaseTabName(c)}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
