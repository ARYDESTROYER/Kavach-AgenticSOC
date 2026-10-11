/**
 * Redacted, deterministic alert → correlation cluster → opened case explanation.
 *
 * Every string is backend/operator derived and rendered as plain text (#9). Input
 * references are already one-way hashes; this component never receives raw alerts.
 */
import * as React from 'react';
import { ArrowRight, Bell, GitMerge, Link2, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { middleEllipsis } from './caseFacts';
import { humanizeToken } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ui/hover-card';

type ClusterCorrelation = {
  mode?: string;
  threshold?: number;
  window_seconds?: number;
  group_by?: string;
  observed_count?: number;
  matched_rule?: string;
  rule_values?: string[];
  reason?: string;
};

type RelatedClusterCase = {
  case_id?: string;
  relationship?: string;
  reason?: string;
  verdict?: string;
};

export type ClusterExplanation = {
  available?: boolean;
  cluster_id?: string;
  input_count?: number;
  input_refs?: string[];
  input_refs_truncated?: number;
  source_count?: number;
  source_breakdown?: Record<string, number>;
  correlation?: ClusterCorrelation;
  opened_case?: {
    case_id?: string;
    display_id?: string;
    status?: string;
    verdict?: string;
  };
  cross_source_cluster_id?: string;
  related_cases?: RelatedClusterCase[];
  limitations?: string;
};

function secondsLabel(seconds: number): string {
  if (seconds <= 0) return 'No persisted window';
  if (seconds % 60 === 0) return `${seconds / 60} min window`;
  return `${seconds} sec window`;
}

function NodeCard({
  icon: Icon,
  eyebrow,
  title,
  summary,
  tone = 'default',
  children,
  hover,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  summary: string;
  tone?: 'default' | 'primary' | 'success';
  children?: React.ReactNode;
  hover: React.ReactNode;
}) {
  return (
    <HoverCard openDelay={140} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            'group min-h-32 w-full min-w-0 rounded-[4px] border bg-surface-sunken p-4 text-left',
            'transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            tone === 'primary' && 'border-primary/35',
            tone === 'success' && 'border-success/35',
            tone === 'default' && 'border-border',
          )}
        >
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background text-muted-foreground',
                tone === 'primary' && 'border-primary/30 text-primary',
                tone === 'success' && 'border-success/30 text-success-text',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-muted-foreground">
                {eyebrow}
              </span>
              {/* Wraps instead of clipping: an already middle-ellipsised id must not be
                  cut a second time by CSS (CM-8). */}
              <span className="mt-1 line-clamp-2 block text-base font-semibold text-foreground [overflow-wrap:anywhere]">
                {title}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {summary}
              </span>
            </span>
          </div>
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="center" className="w-80 space-y-2">
        {hover}
      </HoverCardContent>
    </HoverCard>
  );
}

export function ClusterFormationDiagram({ data }: { data: ClusterExplanation | null | undefined }) {
  if (!data?.available) return null;

  const correlation = data.correlation || {};
  const inputs = (data.input_refs || []).filter(Boolean);
  const inputCount = Math.max(0, Number(data.input_count || 0));
  const observed = Math.max(0, Number(correlation.observed_count || 0));
  const threshold = Math.max(0, Number(correlation.threshold || 0));
  const sources = Object.entries(data.source_breakdown || {}).filter(([, count]) => count > 0);
  const related = (data.related_cases || []).filter((row) => row.case_id);
  const clusterLabel = data.cluster_id ? `cluster-${data.cluster_id.slice(0, 12)}` : 'Cluster details unavailable';
  const caseFullLabel = data.opened_case?.display_id || data.opened_case?.case_id || '';
  // Middle-ellipsis keeps the distinguishing tail of a long id visible (CM-8); the full
  // id stays in the hover detail.
  const caseLabel = caseFullLabel ? middleEllipsis(caseFullLabel, 12, 6) : 'Opened case';
  const correlationSummary = correlation.reason || [
    correlation.group_by ? `Grouped by ${humanizeToken(correlation.group_by)}` : '',
    correlation.window_seconds ? secondsLabel(correlation.window_seconds) : '',
  ].filter(Boolean).join(' · ') || 'Persisted correlation details are limited for this older case.';

  return (
    <section
      aria-labelledby="cluster-formation-heading"
      className="border-y border-border py-5"
      data-testid="cluster-formation-diagram"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="cluster-formation-heading" className="text-base font-semibold text-foreground">
            How this case was clustered
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            A redacted view of the persisted alert inputs, deterministic correlation rule, and case created from the cluster.
          </p>
        </div>
        <Badge variant="outline" className="font-mono">
          {inputCount} input{inputCount === 1 ? '' : 's'}
        </Badge>
      </div>

      <div className="grid min-w-0 items-center gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.1fr)_auto_minmax(0,1fr)]">
        <NodeCard
          icon={Bell}
          eyebrow="Input alerts"
          title={`${inputCount || observed} matched signal${(inputCount || observed) === 1 ? '' : 's'}`}
          summary={sources.length ? `${sources.length} contributing source${sources.length === 1 ? '' : 's'}` : 'Source detail was not persisted for this case.'}
          hover={(
            <>
              <p className="text-sm font-semibold text-foreground">Persisted cluster inputs</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                References are stable one-way hashes. Raw source identifiers and payloads are intentionally excluded.
              </p>
              {sources.length ? (
                <ul className="space-y-1 border-t border-border pt-2 text-xs">
                  {sources.map(([source, count]) => (
                    <li key={source} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate font-mono text-muted-foreground">{source}</span>
                      <span className="font-mono text-foreground">{count}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        >
          {inputs.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {inputs.slice(0, 3).map((ref) => (
                <Badge key={ref} variant="secondary" className="max-w-full truncate font-mono text-2xs">
                  {ref}
                </Badge>
              ))}
              {inputCount > 3 ? <Badge variant="outline">+{inputCount - 3}</Badge> : null}
            </div>
          ) : null}
        </NodeCard>

        <ArrowRight className="mx-auto hidden h-5 w-5 text-muted-foreground lg:block" aria-hidden />

        <NodeCard
          icon={GitMerge}
          eyebrow="Correlation cluster"
          title={clusterLabel}
          summary={correlationSummary}
          tone="primary"
          hover={(
            <>
              <p className="text-sm font-semibold text-foreground">Why these alerts clustered</p>
              <dl className="space-y-1.5 border-t border-border pt-2 text-xs">
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Mode</dt><dd className="font-mono text-foreground">{humanizeToken(correlation.mode || 'Unavailable')}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Observed / threshold</dt><dd className="font-mono text-foreground">{observed || inputCount} / {threshold || '—'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Window</dt><dd className="font-mono text-foreground">{secondsLabel(Number(correlation.window_seconds || 0))}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Group</dt><dd className="font-mono text-foreground">{humanizeToken(correlation.group_by || 'Unavailable')}</dd></div>
              </dl>
              {correlation.matched_rule ? (
                <p className="break-words border-t border-border pt-2 font-mono text-xs text-foreground">
                  {correlation.matched_rule}
                </p>
              ) : null}
            </>
          )}
        >
          <div className="mt-3 flex flex-wrap gap-1.5">
            {correlation.window_seconds ? <Badge variant="outline">{secondsLabel(correlation.window_seconds)}</Badge> : null}
            {threshold ? <Badge variant="outline">threshold {threshold}</Badge> : null}
          </div>
        </NodeCard>

        <ArrowRight className="mx-auto hidden h-5 w-5 text-muted-foreground lg:block" aria-hidden />

        <NodeCard
          icon={ShieldCheck}
          eyebrow="Opened case"
          title={caseLabel}
          summary="One case preserves the cluster identity so repeated polling attaches instead of duplicating it."
          tone="success"
          hover={(
            <>
              <p className="text-sm font-semibold text-foreground">Case created from this cluster</p>
              <dl className="space-y-1.5 border-t border-border pt-2 text-xs">
                {caseFullLabel ? (
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Case</dt><dd className="break-all text-right font-mono text-foreground">{caseFullLabel}</dd></div>
                ) : null}
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Status</dt><dd className="text-foreground">{humanizeToken(data.opened_case?.status || 'Unavailable')}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">AI verdict</dt><dd className="text-foreground">{humanizeToken(data.opened_case?.verdict || 'Pending')}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Related cases</dt><dd className="font-mono text-foreground">{related.length}</dd></div>
              </dl>
            </>
          )}
        />
      </div>

      {related.length ? (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" aria-hidden /> Related cases
            <span className="tabular-nums">{related.length}</span>
          </h3>
          {/* Readable rows instead of raw 32-hex chips: the id is middle-ellipsised (the
              full id stays in the tooltip and the accessible name), with the relationship,
              the AI verdict and the reason beside it. Plain text only (#9). */}
          <ul className="mt-2 divide-y divide-border/70" data-testid="cluster-related-cases">
            {related.map((row) => {
              const id = String(row.case_id);
              return (
                <li
                  key={`${row.relationship}-${id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-xs"
                >
                  <span className="font-mono text-foreground" title={id} aria-label={`Case ${id}`}>
                    {middleEllipsis(id, 10, 6)}
                  </span>
                  {row.relationship ? (
                    <span className="text-muted-foreground">{humanizeToken(row.relationship)}</span>
                  ) : null}
                  {row.verdict ? (
                    <span className="text-muted-foreground">AI verdict: {humanizeToken(row.verdict)}</span>
                  ) : null}
                  {row.reason ? (
                    <span className="min-w-0 basis-full text-muted-foreground">{row.reason}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {data.limitations ? (
        <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">{data.limitations}</p>
      ) : null}
    </section>
  );
}

export default ClusterFormationDiagram;
