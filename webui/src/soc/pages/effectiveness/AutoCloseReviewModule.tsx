/**
 * Agent effectiveness: the "Auto-close review" module (Round 15 SPEC D6.12).
 *
 * A small random sample of the cases the AI agent closed automatically goes to a person
 * to classify. This module shows that sample over the page's range: how many cases were
 * sampled, reviewed, pending and expired; how often the reviewers agreed with the AI
 * (a rate and its Wilson 95% interval only from 30 reviews, otherwise "Not enough
 * reviews yet"); the threats the reviewers found (they said true positive on an
 * automatic false positive close); the rules sampled most; the median time spent
 * reviewing; and the eligible automatic closes per day beside the sampled ones. Never a
 * composite score, and always the statement that agreement describes the sampled cases
 * only. Lazy: the page loads it on demand, so none of it is in the entry chunk.
 */
import * as React from 'react';

import { getAutoCloseReviewMetrics } from '@/lib/api-reviews';
import type { AutoCloseReviewMetrics, ReviewDuration } from '@/lib/types-reviews';
import { fmtDuration, fmtNumber } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { LoadingState, Panel } from '@/design-system';
import { LoadError } from '@/soc/components/LoadError';
import { pageHash } from '@/soc/router';
import { useRouteLinkClick } from '@/soc/route-link';
import { ExplainTrigger } from '@/design-system/explain';
import { explainWilson } from '@/lib/explain/stats';

/** The module's window token for the page's range in hours (`now-30d`, `now-24h`). */
export function reviewWindowToken(hours: number): string {
  const whole = Math.max(1, Math.round(hours));
  return whole % 24 === 0 ? `now-${whole / 24}d` : `now-${whole}h`;
}

/**
 * "45s", "3m 20s", "2d 23h" for a duration in milliseconds: the shared `fmtDuration`
 * from ten minutes up ("6d 21h", never "165h"), and the same seconds and minutes wording
 * as Team activity's `fmtSeconds`, so both review surfaces print one style.
 */
export function durationWords(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'Not measured';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  return fmtDuration(seconds / 60);
}

function percent(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Math.round(value * 1000) / 10}%` : 'Not measured';
}

function median(d: ReviewDuration): string {
  return d.reviews ? durationWords(d.median) : 'No reviews yet';
}

function CaseLink({ caseId, label }: { caseId: string; label: string }) {
  const href = pageHash('case_manager', { caseId });
  const onClick = useRouteLinkClick(href);
  return (
    <a
      href={href}
      onClick={onClick}
      className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
    </a>
  );
}

/** The module's body for one loaded answer (exported for tests). */
export function AutoCloseReviewBody({ data }: { data: AutoCloseReviewMetrics }) {
  const agreement = data.agreement;
  const enough = agreement.status === 'ok';
  const missed = data.missed_threats.cases ?? [];
  const counts: Array<[string, number]> = [
    ['Sampled', data.sampled],
    ['Reviewed', data.reviewed],
    ['Pending', data.pending],
    ['Expired', data.expired],
  ];
  return (
    <div className="space-y-4">
      {!data.enabled ? (
        <p className="text-sm text-muted-foreground" data-testid="review-module-off">
          Auto-close review is off. Turn it on in Settings, Detection, Auto-close review.
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {counts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums text-foreground">{fmtNumber(value)}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1" data-testid="review-agreement">
        <p className="text-sm font-medium text-foreground">
          {enough ? (
            <>
              Agreement {percent(agreement.rate)}, 95% interval{' '}
              {/* The Wilson arithmetic with the real counts (research explainability R10):
                  the reviews that agreed of the reviews that rated, unsure ones excluded. */}
              <ExplainTrigger explanation={explainWilson(agreement.agreed, agreement.reviews)}>
                {percent(agreement.interval?.low)} to {percent(agreement.interval?.high)}
              </ExplainTrigger>
            </>
          ) : (
            'Not enough reviews yet'
          )}
        </p>
        <p className="text-sm tabular-nums text-muted-foreground">
          {fmtNumber(agreement.agreed)} of {fmtNumber(agreement.reviews)} agreed
          {data.unsure ? `, ${fmtNumber(data.unsure)} unsure` : ''}
          {enough ? '' : `. An agreement rate needs at least ${fmtNumber(agreement.minimum)} reviews.`}
        </p>
        <p className="text-sm text-muted-foreground" data-testid="review-statement">
          {data.statement}
        </p>
      </div>
      <div className="space-y-1" data-testid="review-missed-threats">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          Threats found by reviewers
          <Badge variant={data.missed_threats.count ? 'warning' : 'secondary'}>
            {fmtNumber(data.missed_threats.count)}
          </Badge>
        </div>
        {missed.length ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {missed.map((item) => (
              <li key={item.case_id}>
                <CaseLink caseId={item.case_id} label={item.case_number || item.case_id} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No reviewer has said true positive on an automatic false positive close in this range.
          </p>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Time spent reviewing (median)</dt>
          <dd className="text-sm tabular-nums text-foreground">{median(data.time_spent_ms)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Time to review, sampled to reviewed (median)</dt>
          <dd className="text-sm tabular-nums text-foreground">{median(data.time_to_review_ms)}</dd>
        </div>
      </dl>
      {data.by_rule.length ? (
        <Table aria-label="Auto-close review by rule" containerClassName="pb-1">
          <TableHeader>
            <TableRow>
              <TableHead density="compact">Rule</TableHead>
              <TableHead density="compact" className="text-right">Sampled</TableHead>
              <TableHead density="compact" className="text-right">Reviewed</TableHead>
              <TableHead density="compact" className="text-right">Agreed</TableHead>
              <TableHead density="compact" className="text-right">Disagreed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.by_rule.map((row) => (
              <TableRow key={row.rule || '(no rule)'}>
                <TableCell density="compact" className="max-w-xs truncate" title={row.rule}>
                  {row.rule || 'No rule'}
                </TableCell>
                <TableCell density="compact" numeric className="text-right">{fmtNumber(row.sampled)}</TableCell>
                <TableCell density="compact" numeric className="text-right">{fmtNumber(row.reviewed)}</TableCell>
                <TableCell density="compact" numeric className="text-right">{fmtNumber(row.agreed)}</TableCell>
                <TableCell density="compact" numeric className="text-right">{fmtNumber(row.disagreed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <p className="text-sm tabular-nums text-muted-foreground" data-testid="review-eligible">
        {fmtNumber(data.eligible.count)} automatic closes in this range, by the day of their first decision
        {data.eligible.complete ? '' : ' (at least: not every case could be read)'}.
        {data.ledger_complete ? '' : ' The oldest samples in this range are no longer kept, so the counts are at least these.'}
      </p>
    </div>
  );
}

/** The module: loads `GET /api/metrics/auto-close-review` for the page's range. */
export default function AutoCloseReviewModule({ hours, refreshKey = 0 }: { hours: number; refreshKey?: number }) {
  const window = reviewWindowToken(hours);
  const [state, setState] = React.useState<{ data: AutoCloseReviewMetrics | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const load = React.useCallback(
    (signal?: AbortSignal) => {
      setState((s) => ({ ...s, loading: true }));
      getAutoCloseReviewMetrics(window, signal)
        .then((data) => setState({ data, error: null, loading: false }))
        .catch((error: unknown) => {
          if (signal?.aborted) return;
          setState((s) => ({ ...s, error, loading: false }));
        });
    },
    [window],
  );
  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  return (
    <Panel title="Auto-close review" caption={state.data?.window.label ?? 'the selected range'} data-testid="auto-close-review-module">
      {state.loading && !state.data ? (
        <LoadingState label="Loading the auto-close review" layout="inline" />
      ) : state.error && !state.data ? (
        <LoadError
          error={state.error}
          title="Could not load the auto-close review"
          fallback="The auto-close review figures could not be reached."
          onRetry={() => load()}
        />
      ) : state.data ? (
        <AutoCloseReviewBody data={state.data} />
      ) : null}
    </Panel>
  );
}
