/**
 * Case Manager — concise, case-specific investigation-input provenance.
 *
 * Every item comes from the latest run's append-only audit projection.  Nothing is
 * inferred from feature enablement or mutable current settings.  Log/model/operator
 * text is rendered as text only (#9), and the authority note keeps these advisory
 * inputs separate from the deterministic close/escalate decision (#3).
 */
import * as React from 'react';
import {
  BookMarked,
  BookOpen,
  Brain,
  RefreshCw,
  SlidersHorizontal,
  UserRound,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { CaseRationale, RationalePlatformTuning } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';

type InputItem = {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
  detail: string;
  informed: boolean;
};

function plural(count: number, singular: string, multiple = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : multiple}`;
}

export function isRunbookSource(source?: string): boolean {
  const normalized = (source || '').trim().toLowerCase();
  return /(^|[-_:])runbook($|[-_:])/.test(normalized);
}

export function tuningSummary(records: RationalePlatformTuning[]): string {
  if (records.length !== 1) return plural(records.length, 'tuned threshold');
  const record = records[0];
  const before = typeof record.before === 'number' ? record.before : null;
  const after = typeof record.after === 'number' ? record.after : null;
  const values = before !== null && after !== null ? ` ${before} → ${after}` : '';
  if (record.target === 'correlation_n') return `Correlation threshold${values}`;
  if (record.target === 'severity_floor') return `Severity floor${values}`;
  return `Tuned threshold${values}`;
}

export const InvestigationInputs: React.FC<{
  rationale: CaseRationale | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onReview?: () => void;
  /** Investigation view only: disclose selections that were not actually consulted. */
  showSelectionStatus?: boolean;
  className?: string;
}> = ({
  rationale,
  loading = false,
  error,
  onRetry,
  onReview,
  showSelectionStatus = false,
  className,
}) => {
  const knowledge = rationale?.knowledge || [];
  const runbooks = knowledge.filter((item) => isRunbookSource(item.source));
  const otherKnowledge = knowledge.filter((item) => !isRunbookSource(item.source));
  const memories = (rationale?.memory_used || []).filter((item) => item.trim());
  const playbook = rationale?.playbook;
  const procedure = rationale?.procedure_provenance;
  const retrievalStatus = procedure?.retrieval_status ?? 'unavailable';
  const selectedPersona = procedure?.persona?.selected_id?.trim() || '';
  const personaConsulted = Boolean(selectedPersona && procedure?.persona?.consulted === true);
  const selectedPlaybook = procedure?.playbook?.selected_id?.trim() || playbook?.id?.trim() || '';
  const playbookConsulted = Boolean(
    selectedPlaybook &&
      (procedure?.playbook?.consulted === true || playbook?.consulted === true),
  );
  const tuning = rationale?.platform_tuning || [];
  const tuningUnavailable = rationale?.platform_tuning_status === 'unavailable';

  const items: InputItem[] = [];
  if (memories.length) {
    items.push({
      key: 'memory',
      label: 'Memory',
      value: plural(memories.length, 'approved operator fact'),
      icon: Brain,
      detail: 'Approved operator facts actually supplied to the latest investigation run.',
      informed: true,
    });
  }
  if (otherKnowledge.length) {
    items.push({
      key: 'knowledge',
      label: 'Knowledge',
      value: plural(otherKnowledge.length, 'retrieved reference'),
      icon: BookOpen,
      detail: 'Knowledge references retrieved through RAG for the latest investigation run.',
      informed: true,
    });
  }
  if (runbooks.length) {
    items.push({
      key: 'runbook',
      label: 'Runbook',
      value: plural(runbooks.length, 'retrieved reference'),
      icon: BookMarked,
      detail: 'Runbook references retrieved through RAG for the latest investigation run.',
      informed: true,
    });
  }
  if (rationale && !knowledge.length && retrievalStatus === 'unavailable') {
    items.push({
      key: 'knowledge-provenance-unavailable',
      label: 'Knowledge',
      value: 'Provenance unavailable',
      icon: BookOpen,
      detail:
        'Reliable latest-run retrieval telemetry was not recorded. Missing history is not a measured zero and did not count as an input.',
      informed: false,
    });
  } else if (
    rationale &&
    !knowledge.length &&
    retrievalStatus === 'not_attempted' &&
    showSelectionStatus
  ) {
    items.push({
      key: 'knowledge-not-attempted',
      label: 'Knowledge',
      value: 'Not run',
      icon: BookOpen,
      detail: 'Knowledge retrieval did not run on the latest investigation path.',
      informed: false,
    });
  }
  if (personaConsulted || (showSelectionStatus && selectedPersona)) {
    const reason = procedure?.persona?.selection_reason?.trim();
    items.push({
      key: 'persona',
      label: 'Persona',
      value: personaConsulted ? `${selectedPersona} · Consulted` : `${selectedPersona} · Selected only`,
      icon: UserRound,
      detail: personaConsulted
        ? `The latest run actually consulted this persona.${reason ? ` Selected because: ${reason}` : ''}`
        : `The latest run selected this persona but did not consult it.${reason ? ` Selected because: ${reason}` : ''}`,
      informed: personaConsulted,
    });
  }
  if (playbookConsulted || (showSelectionStatus && selectedPlaybook)) {
    const version = playbookConsulted && playbook?.version ? ` · v${playbook.version}` : '';
    const reason = procedure?.playbook?.selection_reason?.trim() || playbook?.reason?.trim();
    items.push({
      key: 'playbook',
      label: 'Playbook',
      value: playbookConsulted
        ? `${selectedPlaybook}${version} · Consulted`
        : `${selectedPlaybook} · Selected only`,
      icon: Workflow,
      detail: playbookConsulted
        ? `The latest run injected and consulted this playbook.${reason ? ` Selected because: ${reason}` : ''}`
        : `The latest run selected this playbook but did not inject or consult it.${reason ? ` Selected because: ${reason}` : ''}`,
      informed: playbookConsulted,
    });
  }
  if (tuning.length) {
    items.push({
      key: 'platform-tuning',
      label: 'Threshold tuning',
      value: tuningSummary(tuning),
      icon: SlidersHorizontal,
      detail: 'Immutable threshold values recorded on this case processing path. This is not model fine-tuning.',
      informed: true,
    });
  } else if (tuningUnavailable) {
    items.push({
      key: 'platform-tuning-unavailable',
      label: 'Threshold tuning',
      value: 'Provenance unavailable',
      icon: SlidersHorizontal,
      detail: 'The latest run could not determine whether an adjusted threshold was on this case path.',
      informed: false,
    });
  }
  const informedItemCount = items.filter((item) => item.informed).length;
  const reviewableItemCount = items.filter(
    (item) =>
      item.key !== 'platform-tuning-unavailable' &&
      item.key !== 'knowledge-provenance-unavailable' &&
      item.key !== 'knowledge-not-attempted',
  ).length;

  if (!loading && !error && items.length === 0) return null;

  return (
    <section
      className={cn('space-y-4 border-t border-border/60 pt-6', className)}
      data-case-manager-section="investigation-inputs"
      aria-labelledby="investigation-inputs-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            id="investigation-inputs-heading"
            className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
          >
            Investigation inputs
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {showSelectionStatus
              ? 'Latest-run selections and the inputs actually consulted.'
              : 'Only latest-run inputs actually consulted or applied to this case path.'}
          </p>
        </div>
        {onReview && reviewableItemCount ? (
          <Button type="button" variant="outline" size="sm" onClick={onReview}>
            Review inputs
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex flex-wrap gap-x-8 gap-y-3" aria-label="Loading investigation inputs">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-10 w-44" />
          <Skeleton className="h-10 w-36" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground" role="status">
          <span>Inputs unavailable.</span>
          {onRetry ? (
            <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Retry
            </Button>
          ) : null}
        </div>
      ) : (
        <TooltipProvider delayDuration={220}>
          <ul className="flex list-none flex-wrap gap-x-8 gap-y-4" aria-label="Recorded investigation inputs">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.key} className="min-w-[10rem]">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex w-full items-start gap-2.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`${item.label}: ${item.value}. ${item.detail}`}
                      >
                        <Icon
                          className={cn(
                            'mt-0.5 h-4 w-4 shrink-0',
                            item.informed ? 'text-primary' : 'text-muted-foreground',
                          )}
                          aria-hidden
                        />
                        <div className="min-w-0">
                          <div className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                            {item.label}
                          </div>
                          <div className="mt-0.5 break-words text-sm font-medium text-foreground">
                            {item.value}
                          </div>
                        </div>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm">{item.detail}</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </TooltipProvider>
      )}

      {!loading && !error && informedItemCount ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            These inputs informed preprocessing or the agent assessment. Deterministic policy
            still made the final route.
          </span>
        </p>
      ) : null}
    </section>
  );
};

export default InvestigationInputs;
