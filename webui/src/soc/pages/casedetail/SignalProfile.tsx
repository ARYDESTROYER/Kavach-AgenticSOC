/**
 * SignalProfile — the case's deterministic risk score, the AI confidence and the five
 * recorded risk factors, each with a text equivalent (Round 12: moved out of the
 * Overview into the facts rail so it is visible on every tab, CM-6).
 *
 * The risk meter and every factor bar are coloured by VALUE (the one `scoreBand`
 * ladder), never by what kind of thing they are, so a Risk 7 case is never painted red.
 * After a human classified the case the confidence meter is relabelled "AI confidence
 * (at assessment)" so it is not read as the analyst's certainty.
 *
 * SECURITY (#9): factor reasons are composed from numbers and fixed copy; the entity
 * value they may mention is rendered as a plain text node.
 */
import * as React from 'react';
import { Gauge, Info } from 'lucide-react';

import type { Case } from '@/lib/types';
import { humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { scoreBand, type ScoreBand } from '@/soc/components/palette';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';

const FIELD_LABEL = 'text-xs font-medium text-muted-foreground';

/** Clamp an arbitrary score-like value into the visible 0..100 range. */
export function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

const METER_FILL: Record<ScoreBand | 'primary', string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  primary: 'bg-primary',
};

/**
 * A compact score visual with a complete textual equivalent. The visible value and
 * the labelled progressbar expose the same fact; colour is never the only signal.
 */
export const SignalMeter: React.FC<{
  label: string;
  value: number;
  display: string;
  tone: ScoreBand | 'primary';
  description: string;
}> = ({ label, value, display, tone, description }) => {
  const bounded = boundedScore(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="shrink-0 text-lg font-semibold tabular-nums text-foreground">
          {display}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}: ${display}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(bounded)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          aria-hidden="true"
          className={cn('h-full rounded-full', METER_FILL[tone])}
          style={{ width: `${bounded}%` }}
        />
      </div>
    </div>
  );
};


/**
 * The severity-token bar color for a 0-100 risk FACTOR. Uses the ONE palette ladder
 * (`scoreBand` — 74/48/22) so a factor bar shares cut-points with every other
 * risk-coloured element. Literal class strings so the Tailwind JIT emits them.
 */
const FACTOR_BAR_COLOR: Record<ScoreBand, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
};

export function riskFactorBarColor(value: number): string {
  return FACTOR_BAR_COLOR[scoreBand(value)];
}

export const RISK_FACTOR_META = [
  {
    key: 'volume',
    label: 'Volume',
    definition:
      'Cluster event count, log-normalized against a 50-event reference so very large clusters level off.',
  },
  {
    key: 'velocity',
    label: 'Velocity',
    definition:
      'Events per minute across the observed cluster span; it saturates near 10 per minute and contributes zero below 3 events.',
  },
  {
    key: 'reputation',
    label: 'Reputation',
    definition:
      'The clamped 0–100 enrichment reputation signal supplied to deterministic scoring.',
  },
  {
    key: 'diversity',
    label: 'Diversity',
    definition: 'Distinct rule types normalized against a five-rule-type reference.',
  },
  {
    key: 'asset_criticality',
    label: 'Asset criticality',
    definition:
      'The configured exact-entity or network-policy value for the affected asset.',
  },
] as const;

type RiskFactorKey = (typeof RISK_FACTOR_META)[number]['key'];
export type RiskFactor = {
  key: RiskFactorKey;
  label: string;
  value: number;
  definition: string;
  caseReason: string;
};

export type RiskFactorContext = {
  eventCount: number | null;
  ruleTypeCount: number | null;
  reputationInput: number | null;
  entityType: string | null;
  entityValue: string;
};

/** Case-specific half of a factor tooltip; never reverse-engineers missing inputs. */
export function riskFactorCaseReason(
  key: RiskFactorKey,
  value: number,
  context: RiskFactorContext,
): string {
  const score = Math.round(boundedScore(value));
  if (key === 'volume') {
    return context.eventCount !== null
      ? `The case records ${context.eventCount} correlated event${context.eventCount === 1 ? '' : 's'}; its stored Volume factor is ${score}/100.`
      : `The deterministic breakdown stores Volume at ${score}/100; the underlying event count is not retained in this view.`;
  }
  if (key === 'velocity') {
    if (context.eventCount !== null && context.eventCount < 3 && score === 0) {
      return `The case records ${context.eventCount} event${context.eventCount === 1 ? '' : 's'}; Velocity is 0/100 because this factor does not contribute below 3 events.`;
    }
    return `The deterministic breakdown stores Velocity at ${score}/100. This view does not retain the exact observed span, so it does not infer an event rate.`;
  }
  if (key === 'reputation') {
    if (context.reputationInput !== null) {
      return `The case enrichment record reports ${Math.round(boundedScore(context.reputationInput))}/100; the stored Reputation factor is ${score}/100.`;
    }
    return `The deterministic breakdown stores Reputation at ${score}/100; no provider-level reputation input is retained in this view${score === 0 ? ', which does not by itself prove the indicator safe' : ''}.`;
  }
  if (key === 'diversity') {
    return context.ruleTypeCount !== null
      ? `The case records ${context.ruleTypeCount} distinct rule type${context.ruleTypeCount === 1 ? '' : 's'}; its stored Diversity factor is ${score}/100.`
      : `The deterministic breakdown stores Diversity at ${score}/100; the contributing rule-type list is not retained in this view.`;
  }
  const entity = context.entityValue
    ? `${context.entityType ? `${humanizeToken(context.entityType)} ` : ''}${context.entityValue}`
    : 'the affected entity';
  return `For ${entity}, the deterministic breakdown stores Asset criticality at ${score}/100; the configured policy entry itself is not exposed here.`;
}

/**
 * Five recorded deterministic risk inputs. Each label is a real focusable Tooltip
 * trigger: hover and keyboard focus explain both the engine meaning and the exact
 * case fact we possess. The rows never infer a missing event span/provider/policy.
 */
export const RiskFactorProfile: React.FC<{ factors: RiskFactor[] }> = ({ factors }) => {
  if (!factors.length) return null;
  return (
    <TooltipProvider delayDuration={0}>
      <div
        className="pt-1"
        role="group"
        aria-label="Recorded risk factors"
      >
        <div className="mb-2">
          <span className={FIELD_LABEL}>Recorded risk factors</span>
        </div>
        <div
          data-testid="risk-factor-grid"
          className="grid min-w-0 grid-cols-[max-content_minmax(2.5rem,1fr)_2rem] items-center gap-x-2 gap-y-2"
        >
          {factors.map((factor) => {
            const value = boundedScore(factor.value);
            const rounded = Math.round(value);
            return (
              <React.Fragment key={factor.key}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Explain ${factor.label} risk factor, recorded ${rounded} out of 100`}
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {factor.label}
                      <Info className="h-3 w-3 shrink-0" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-xs space-y-2 p-3">
                    <p className="font-semibold text-popover-foreground">
                      What {factor.label.toLowerCase()} measures
                    </p>
                    <p>{factor.definition}</p>
                    <p className="border-t border-border pt-2">
                      <span className="font-semibold text-popover-foreground">This case: </span>
                      {factor.caseReason}
                    </p>
                  </TooltipContent>
                </Tooltip>
                <div
                  role="progressbar"
                  aria-label={`${factor.label} risk factor: ${rounded} out of 100`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={rounded}
                  className="h-1.5 min-w-0 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    aria-hidden="true"
                    className={cn('h-full rounded-full', riskFactorBarColor(value))}
                    style={{ width: `${value}%` }}
                  />
                </div>
                <span className="text-right text-xs tabular-nums text-foreground">
                  {rounded}
                </span>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
};


/** Build the recorded risk-factor rows for a case (never infers a missing input). */
export function caseRiskFactors(c: Case, triage: TriageChips | null): RiskFactor[] {
  const trigger = c.trigger_reason as
    | { observed_count?: number; rule_values?: unknown[]; entity?: string }
    | undefined;
  const ruleIds = (c.rule_ids || []).filter((r) => typeof r === 'string' && r.trim());
  const caseEnrichment =
    c.enrichment && typeof c.enrichment === 'object'
      ? (c.enrichment as Record<string, unknown>)
      : null;
  const caseRiskBreakdown =
    c.risk_breakdown && typeof c.risk_breakdown === 'object'
      ? (c.risk_breakdown as Record<string, unknown>)
      : null;
  const recorded = triage?.risk?.breakdown ?? caseRiskBreakdown;
  if (!recorded) return [];
  const memberEventCount = c.member_event_keys?.length || c.member_event_ids?.length || 0;
  const observedCount =
    typeof trigger?.observed_count === 'number' && Number.isFinite(trigger.observed_count)
      ? Math.max(0, Math.round(trigger.observed_count))
      : null;
  const triggerRuleValues = Array.isArray(trigger?.rule_values)
    ? trigger.rule_values.filter((value): value is string => typeof value === 'string' && !!value)
    : [];
  const distinctRuleCount = new Set(triggerRuleValues.length ? triggerRuleValues : ruleIds).size;
  const reputationInput =
    typeof caseEnrichment?.reputation_score === 'number' &&
    Number.isFinite(caseEnrichment.reputation_score)
      ? caseEnrichment.reputation_score
      : null;
  const context: RiskFactorContext = {
    eventCount: memberEventCount > 0 ? memberEventCount : observedCount,
    ruleTypeCount: distinctRuleCount > 0 ? distinctRuleCount : null,
    reputationInput,
    entityType: c.entity?.type || c.entity_type || null,
    entityValue: c.entity?.value || trigger?.entity || '',
  };
  return RISK_FACTOR_META.flatMap(({ key, label, definition }) => {
    const raw = (recorded as Record<string, unknown>)[key];
    return typeof raw === 'number' && Number.isFinite(raw)
      ? [{ key, label, value: raw, definition, caseReason: riskFactorCaseReason(key, raw, context) }]
      : [];
  });
}

export interface SignalProfileProps {
  c: Case;
  triage: TriageChips | null;
  /** True once a person classified the case: the confidence is then the AI's, at assessment. */
  humanSettled?: boolean;
  /** The FP auto-close bar the confidence is read against (from the policy). */
  calibration?: { threshold?: number; note?: string };
  className?: string;
}

/** The labelled signal-profile block (risk, confidence, recorded factors). */
export const SignalProfile: React.FC<SignalProfileProps> = ({
  c,
  triage,
  humanSettled = false,
  calibration,
  className,
}) => {
  const bar =
    typeof calibration?.threshold === 'number'
      ? Math.round(calibration.threshold <= 1 ? calibration.threshold * 100 : calibration.threshold)
      : null;
  const riskVal = typeof triage?.risk?.value === 'number' ? triage.risk.value : c.risk_score;
  const ourRiskBand: ScoreBand | null = typeof riskVal === 'number' ? scoreBand(riskVal) : null;
  const confidencePercent =
    typeof c.confidence === 'number'
      ? boundedScore(c.confidence <= 1 ? c.confidence * 100 : c.confidence)
      : null;
  const factors = caseRiskFactors(c, triage);
  return (
    <section
      aria-label="Case signal profile"
      data-testid="case-signal-profile"
      className={cn('space-y-4', className)}
    >
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">Signal profile</h3>
      </div>
      {typeof riskVal === 'number' && ourRiskBand ? (
        <SignalMeter
          label="Risk score"
          value={riskVal}
          display={`${Math.round(boundedScore(riskVal))}/100`}
          tone={ourRiskBand}
          description="Deterministic case input"
        />
      ) : null}
      {confidencePercent !== null ? (
        <SignalMeter
          label={humanSettled ? 'AI confidence (at assessment)' : 'Confidence'}
          value={confidencePercent}
          display={`${Math.round(confidencePercent)}%`}
          tone="primary"
          description={
            bar !== null
              ? `Agent assessment · auto-close bar ${bar}%${calibration?.note ? ` (${calibration.note})` : ''}`
              : 'Agent assessment'
          }
        />
      ) : null}
      <RiskFactorProfile factors={factors} />
      {typeof riskVal !== 'number' && confidencePercent === null && !factors.length ? (
        <p className="text-sm text-muted-foreground">No scored signals recorded.</p>
      ) : null}
    </section>
  );
};
