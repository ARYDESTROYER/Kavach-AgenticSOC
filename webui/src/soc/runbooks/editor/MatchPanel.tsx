/**
 * "Which cases would this match?" (Round 14, SPEC §4.10.12): the working definition tested
 * against the last 500 cases of the last 30 days through `POST /api/runbooks/match-preview`.
 * Three groups: Gets it (this runbook would win), Another wins (it matches, but another
 * runbook wins by the selection order of §4.10.4; the winner is named, the reason is in the
 * Help Center) and Near misses (the criterion that failed).
 * "Nothing is attached and no metric changes."
 *
 * A summary line ("Gets it 6 · Another wins 3 · Near misses 5") opens the results in a sheet
 * below 1680px; from 1680px the results are a side column. Case titles are untrusted text,
 * rendered as plain text (#9).
 */
import * as React from 'react';
import { Circle, CircleCheck, CircleMinus, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { MatchPreview } from '@/lib/types-runbooks';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';
import { pageHash } from '@/soc/router';
import { Button } from '@/ui/button';

import { describeExplanation, missedSentence } from '../shared/explain';

export type MatchPanelState = 'idle' | 'loading' | 'ready' | 'error' | 'forbidden' | 'scope' | 'invalid';

export interface MatchPanelProps {
  state: MatchPanelState;
  preview: MatchPreview | null;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
}

const SHOWN = 5;

export function matchSummaryText(preview: MatchPreview): string {
  const c = preview.counts;
  return `Gets it ${c.gets_it.toLocaleString()} · Another wins ${c.another_wins.toLocaleString()} · Near misses ${c.near_misses.toLocaleString()}`;
}

/**
 * A case in the results: its number links to the case. A plain click goes through the router,
 * so the editor's "Discard your changes?" guard is asked first; a modified click opens a tab.
 */
function CaseLabel({ number, id, title }: { number: string; id: string; title: string }) {
  const href = safeRouteHref(pageHash('case_manager', { caseId: id }));
  const onClick = useRouteLinkClick(href);
  return (
    <>
      <a
        href={href}
        onClick={onClick}
        className="font-mono text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {number || id}
      </a>
      <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{title}</span>
    </>
  );
}

function Group({
  title,
  icon: Icon,
  tone,
  count,
  children,
  listed,
  testId,
}: {
  title: string;
  icon: typeof Circle;
  tone: string;
  count: number;
  listed: number;
  children: (limit: number) => React.ReactNode;
  testId: string;
}) {
  const [all, setAll] = React.useState(false);
  const limit = all ? listed : Math.min(SHOWN, listed);
  return (
    <section aria-label={title} className="space-y-1.5" data-match-group={testId}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Icon className={cn('size-4', tone)} aria-hidden />
        {title} <span className="font-normal tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
      </h3>
      {listed ? (
        <ul className="divide-y divide-border/70">{children(limit)}</ul>
      ) : (
        <p className="text-sm text-muted-foreground">None.</p>
      )}
      {listed > SHOWN && !all ? (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => setAll(true)}>
          {`Show all ${(count > listed ? listed : count).toLocaleString()}`}
        </Button>
      ) : null}
      {all && count > listed ? (
        <p className="text-xs text-muted-foreground">{`Showing the first ${listed.toLocaleString()} of ${count.toLocaleString()}.`}</p>
      ) : null}
    </section>
  );
}

export function MatchResults({ state, preview, error, onRetry, className }: MatchPanelProps) {
  if (state === 'forbidden') {
    return <p className={cn('text-sm text-muted-foreground', className)}>You do not have access to cases.</p>;
  }
  if (state === 'scope') {
    return <p className={cn('text-sm text-muted-foreground', className)}>Hidden while row-level scope is on.</p>;
  }
  if (state === 'invalid') {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        Fix the problems in this runbook to test it against recent cases.
      </p>
    );
  }
  if (state === 'error') {
    return (
      <div className={cn('space-y-2', className)}>
        <p role="alert" className="text-sm text-critical-text">
          {error || 'Could not test this runbook against recent cases.'}
        </p>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden />
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  if (!preview) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)} aria-busy={state === 'loading'}>
        Testing against recent cases.
      </p>
    );
  }
  const c = preview.counts;
  return (
    <div className={cn('space-y-4', className)} aria-busy={state === 'loading'} data-match-results="">
      <p className="text-sm text-muted-foreground">
        {`${preview.window_label}, ${preview.considered.toLocaleString()} ${preview.considered === 1 ? 'case' : 'cases'} checked against this version.`}
        {preview.truncated ? ' Only the most recent cases were checked.' : ''}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        <li className="inline-flex items-center gap-1">
          <CircleCheck className="size-3.5 text-success-text" aria-hidden />
          Gets this runbook
        </li>
        <li className="inline-flex items-center gap-1">
          <Circle className="size-3.5 text-muted-foreground" aria-hidden />
          Matches, but another wins
        </li>
        <li className="inline-flex items-center gap-1">
          <CircleMinus className="size-3.5 text-warning-text" aria-hidden />
          Almost matches
        </li>
      </ul>
      <Group title="Gets it" icon={CircleCheck} tone="text-success-text" count={c.gets_it} listed={preview.gets_it.length} testId="gets_it">
        {(limit) =>
          preview.gets_it.slice(0, limit).map((row) => (
            <li key={row.case_id} className="py-2">
              <CaseLabel number={row.case_number} id={row.case_id} title={row.title} />
              <span className="block text-xs text-muted-foreground">{describeExplanation(row.explanation)}</span>
            </li>
          ))
        }
      </Group>
      <Group title="Another wins" icon={Circle} tone="text-muted-foreground" count={c.another_wins} listed={preview.another_wins.length} testId="another_wins">
        {(limit) =>
          preview.another_wins.slice(0, limit).map((row) => (
            <li key={row.case_id} className="py-2">
              <CaseLabel number={row.case_number} id={row.case_id} title={row.title} />
              <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {`${row.winner_title || row.winner_id} wins this case.`}
              </span>
            </li>
          ))
        }
      </Group>
      <Group title="Near misses" icon={CircleMinus} tone="text-warning-text" count={c.near_misses} listed={preview.near_misses.length} testId="near_misses">
        {(limit) =>
          preview.near_misses.slice(0, limit).map((row) => (
            <li key={row.case_id} className="py-2">
              <CaseLabel number={row.case_number} id={row.case_id} title={row.title} />
              {row.failed.map((f, i) => (
                <span key={i} className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {missedSentence(f)}
                </span>
              ))}
            </li>
          ))
        }
      </Group>
      <p className="border-t border-border/70 pt-3 text-sm text-muted-foreground">Nothing is attached and no metric changes.</p>
    </div>
  );
}

/** The side column (from 1680px). */
export function MatchColumn(props: MatchPanelProps) {
  return (
    <aside aria-labelledby="match-panel-title" className="surface-panel min-w-0 space-y-3 p-4 xl:p-5" data-match-panel="column">
      <h2 id="match-panel-title" className="text-md font-semibold text-foreground">
        Which cases would this match?
      </h2>
      <MatchResults {...props} />
    </aside>
  );
}

/** The summary line that opens the sheet (below 1680px). */
export function MatchSummaryButton({
  state,
  preview,
  onOpen,
  buttonRef,
}: {
  state: MatchPanelState;
  preview: MatchPreview | null;
  onOpen: () => void;
  /** The button, so focus can return to it when the sheet closes. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const text =
    state === 'forbidden'
      ? 'You do not have access to cases.'
      : state === 'scope'
        ? 'Hidden while row-level scope is on.'
        : preview
          ? matchSummaryText(preview)
          : state === 'invalid'
            ? 'Fix the problems to test it'
            : state === 'error'
              ? 'Could not test it'
              : 'Testing';
  const usable = state !== 'forbidden' && state !== 'scope';
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      size="sm"
      className="h-auto min-h-8 max-w-full justify-start whitespace-normal py-1 text-left"
      onClick={onOpen}
      disabled={!usable}
      data-match-summary=""
    >
      <span className="font-medium">Which cases would this match?</span>
      <span className="text-muted-foreground">{text}</span>
    </Button>
  );
}
