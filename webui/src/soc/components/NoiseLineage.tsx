/**
 * Wide, bounded drill-down for the expanded Noise Reduction flow.
 *
 * The aggregate counters remain the complete selected-window story. These rows
 * expose the newest persisted case-forming paths using the same one-way alert
 * references as Threat Context: redacted inputs → deterministic cluster → case →
 * current/terminal outcome. All backend strings render as plain text (#9).
 */
import * as React from 'react';
import {
  ArrowRight,
  Bell,
  CircleCheck,
  Clock3,
  GitMerge,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { fmtNumber, humanizeAge, humanizeToken } from '@/lib/format';
import type { NoiseLineage, NoiseLineageRow } from '@/lib/types';
import { LoadingState } from '@/design-system/loading';
import { Badge } from '@/ui/badge';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { triggerSentenceText } from '@/soc/components/caseActivityText';

export interface NoiseLineageProps {
  data: NoiseLineage | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function secondsLabel(seconds: number): string {
  if (seconds <= 0) return 'Window not persisted';
  if (seconds % 60 === 0) return `${seconds / 60} min window`;
  return `${seconds} sec window`;
}

function FlowNode({
  icon: Icon,
  eyebrow,
  title,
  summary,
  tone = 'default',
  href,
  children,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  summary: string;
  tone?: 'default' | 'primary' | 'success' | 'warning';
  href?: string;
  children?: React.ReactNode;
}) {
  const content = (
    <>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background text-muted-foreground',
            tone === 'primary' && 'border-primary/30 text-primary',
            tone === 'success' && 'border-success/30 text-success-text',
            tone === 'warning' && 'border-warning/30 text-warning-text',
          )}
          aria-hidden="true"
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
            {eyebrow}
          </span>
          <span className="mt-1 block truncate text-sm font-semibold text-foreground" title={title}>
            {title}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {summary}
          </span>
        </span>
      </div>
      {children}
    </>
  );
  const classes = cn(
    'block min-h-32 min-w-0 rounded-[4px] border bg-surface-sunken p-4 text-left',
    tone === 'default' && 'border-border',
    tone === 'primary' && 'border-primary/35',
    tone === 'success' && 'border-success/35',
    tone === 'warning' && 'border-warning/35',
    href &&
      'transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  );
  return href ? (
    <a href={href} className={classes}>
      {content}
    </a>
  ) : (
    <div className={classes}>{content}</div>
  );
}

function OutcomeNode({ row }: { row: NoiseLineageRow }) {
  const outcome = row.outcome;
  const success = outcome.key === 'auto_cleared' || outcome.key === 'closed_by_human';
  const Icon = outcome.terminal ? CircleCheck : Clock3;
  return (
    <FlowNode
      icon={Icon}
      eyebrow={outcome.terminal ? 'Terminal outcome' : 'Current outcome'}
      title={outcome.label || 'Outcome unavailable'}
      summary={
        outcome.terminal
          ? `Completed as ${humanizeToken(outcome.status)}.`
          : `Not terminal · represented in the ${humanizeToken(outcome.funnel_stage)} branch.`
      }
      tone={success ? 'success' : 'warning'}
    >
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant={success ? 'success' : 'warning'}>
          {outcome.terminal ? 'Terminal' : 'In progress'}
        </Badge>
        {outcome.verdict ? <Badge variant="outline">{humanizeToken(outcome.verdict)}</Badge> : null}
        {outcome.decision_by ? (
          <Badge variant="outline">by {humanizeToken(outcome.decision_by)}</Badge>
        ) : null}
      </div>
    </FlowNode>
  );
}

function LineageRow({ row }: { row: NoiseLineageRow }) {
  const clustering = row.clustering || {};
  const correlation = clustering.correlation || {};
  const refs = (clustering.input_refs || []).filter(Boolean);
  const inputCount = Math.max(0, Number(clustering.input_count || 0));
  const observed = Math.max(0, Number(correlation.observed_count || 0));
  const threshold = Math.max(0, Number(correlation.threshold || 0));
  const sources = Object.entries(clustering.source_breakdown || {}).filter(
    ([, count]) => Number(count) > 0,
  );
  const clusterLabel = clustering.cluster_id
    ? `cluster-${clustering.cluster_id.slice(0, 12)}`
    : 'Cluster details unavailable';
  // The stored trigger sentence, as the case page shows it (equal severity ends read as
  // one value; the stored sentence is unchanged).
  const correlationSummary =
    triggerSentenceText(correlation.reason) ||
    [
      correlation.group_by ? `Grouped by ${humanizeToken(correlation.group_by)}` : '',
      correlation.window_seconds ? secondsLabel(correlation.window_seconds) : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'This older case has limited persisted correlation detail.';

  return (
    <li className="border-t border-border py-4 first:border-t-0" data-testid="noise-lineage-row">
      <article aria-label={`${row.display_id || row.case_id} lineage`}>
        <div className="grid min-w-[1180px] grid-cols-[minmax(245px,1.05fr)_40px_minmax(285px,1.2fr)_40px_minmax(230px,1fr)_40px_minmax(230px,0.95fr)] items-center gap-2">
          <FlowNode
            icon={Bell}
            eyebrow="Redacted alert inputs"
            title={`${inputCount || observed} persisted signal${(inputCount || observed) === 1 ? '' : 's'}`}
            summary={
              sources.length
                ? `${sources.length} contributing source${sources.length === 1 ? '' : 's'}`
                : 'Source detail was not persisted for this case.'
            }
          >
            {refs.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {refs.slice(0, 3).map((ref) => (
                  <Badge key={ref} variant="secondary" className="max-w-full truncate font-mono text-2xs">
                    {ref}
                  </Badge>
                ))}
                {inputCount > 3 ? <Badge variant="outline">+{inputCount - 3}</Badge> : null}
              </div>
            ) : null}
          </FlowNode>

          <ArrowRight className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />

          <FlowNode
            icon={GitMerge}
            eyebrow="Deterministic cluster"
            title={clusterLabel}
            summary={correlationSummary}
            tone="primary"
          >
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge variant="info">Code</Badge>
              {correlation.window_seconds ? (
                <Badge variant="outline">{secondsLabel(correlation.window_seconds)}</Badge>
              ) : null}
              {threshold ? <Badge variant="outline">threshold {threshold}</Badge> : null}
            </div>
          </FlowNode>

          <ArrowRight className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />

          <FlowNode
            icon={ShieldCheck}
            eyebrow="Opened case"
            title={row.display_id || row.case_id}
            summary={`Opened ${humanizeAge(row.created_at)} · ${humanizeToken(row.severity || 'severity unavailable')}`}
            tone="primary"
            href={`#/case_manager?caseId=${encodeURIComponent(row.case_id)}`}
          >
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge variant="outline">{humanizeToken(row.outcome.status || 'unknown')}</Badge>
              <Badge variant="secondary">Open in Case Manager</Badge>
            </div>
          </FlowNode>

          <ArrowRight className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />

          <OutcomeNode row={row} />
        </div>

        <details className="mt-2 rounded-[4px] border border-border bg-background px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Inspect persisted clustering facts
          </summary>
          <div className="mt-3 grid min-w-[760px] gap-4 border-t border-border pt-3 text-xs md:grid-cols-3">
            <div>
              <p className="font-semibold text-foreground">Alert references</p>
              {refs.length ? (
                <ul className="mt-2 space-y-1 font-mono text-muted-foreground">
                  {refs.map((ref) => <li key={ref}>{ref}</li>)}
                </ul>
              ) : (
                <p className="mt-2 text-muted-foreground">Not persisted for this case.</p>
              )}
            </div>
            <div>
              <p className="font-semibold text-foreground">Contributing sources</p>
              {sources.length ? (
                <dl className="mt-2 space-y-1">
                  {sources.map(([source, count]) => (
                    <div key={source} className="flex justify-between gap-3">
                      <dt className="font-mono text-muted-foreground">{source}</dt>
                      <dd className="font-mono text-foreground">{fmtNumber(Number(count))}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-2 text-muted-foreground">Not persisted for this case.</p>
              )}
            </div>
            <dl className="space-y-1">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Mode</dt><dd className="font-mono text-foreground">{humanizeToken(correlation.mode || 'Unavailable')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Observed / threshold</dt><dd className="font-mono text-foreground">{observed || inputCount} / {threshold || '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Window</dt><dd className="font-mono text-foreground">{secondsLabel(Number(correlation.window_seconds || 0))}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Group by</dt><dd className="font-mono text-foreground">{humanizeToken(correlation.group_by || 'Unavailable')}</dd></div>
              {correlation.matched_rule ? <div className="pt-1"><dt className="text-muted-foreground">Matched rule</dt><dd className="mt-1 break-words font-mono text-foreground">{correlation.matched_rule}</dd></div> : null}
            </dl>
          </div>
        </details>
      </article>
    </li>
  );
}

export function NoiseLineageView({ data, loading, error, onRetry }: NoiseLineageProps) {
  const rows = data?.rows || [];
  const meta = data?.meta;
  return (
    <section className="mt-6 border-t border-border pt-5" aria-labelledby="noise-lineage-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="noise-lineage-title" className="text-base font-semibold text-foreground">
            Inspectable case lineages
          </h3>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-muted-foreground">
            Newest selected-window paths from persisted redacted alerts through the deterministic cluster and opened case to its current or terminal outcome.
          </p>
        </div>
        {meta ? (
          <Badge variant="outline" className="font-mono">
            {fmtNumber(meta.returned)} of {meta.store_truncated ? 'at least ' : ''}{fmtNumber(meta.window_cases_in_fetched_page)} cases
          </Badge>
        ) : null}
      </div>

      {loading ? (
        <LoadingState
          label="Loading case lineages"
          description="Tracing persisted alert inputs through clustering and case outcomes."
          layout="panel"
          shape="rows"
          shapeRows={3}
        />
      ) : null}
      {!loading && error ? (
        <LoadError
          title="Could not load case lineages"
          error={error}
          onRetry={onRetry}
        />
      ) : null}
      {!loading && !error && data && rows.length === 0 ? (
        <EmptyState
          compact
          icon={GitMerge}
          title="No case-forming lineages in this window"
          description="Ingested alerts remain represented by the aggregate counters above."
        />
      ) : null}
      {!loading && !error && rows.length ? (
        <ol data-testid="noise-lineage-list">
          {rows.map((row) => <LineageRow key={row.case_id} row={row} />)}
        </ol>
      ) : null}

      {data ? (
        <div className="mt-4 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          <p>{data.limitations}</p>
          {meta?.truncated ? (
            <p className="mt-1">
              This is a bounded newest-case sample; use Case Manager for the complete case queue.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default NoiseLineageView;
