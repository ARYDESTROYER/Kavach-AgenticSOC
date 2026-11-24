/**
 * One person's work in the window (Round 15 SPEC D3.11): a side sheet from the right on
 * the side-pane timings, opened from the people table.
 *
 * What it shows: the person's counts, closes by disposition and how many came from bulk
 * actions, their reviews ("N of M agreed", a rate only from 30, the time spent reviewing
 * and, separately, the time to review), a per-day table, and their counted events newest
 * first with links to the cases, paged with "Load more". A viewer who can read the Audit
 * log also gets "Open in Audit log". Not attributed has no events (SPEC D3.9).
 *
 * SECURITY (#9): names, case numbers and every server-worded line are plain text nodes.
 * An event's detail is built by the server from structured fields only.
 */
import * as React from 'react';
import { ScrollText } from 'lucide-react';

import { fmtNumber, formatTimestamp } from '@/lib/format';
import { getTeamPersonEvents, teamErrorMessage } from '@/lib/api-team';
import type { PersonActivity, TeamEvent, TeamKind } from '@/lib/types-team';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { LoadingState } from '@/design-system';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { pageHash } from '@/soc/router';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';

import {
  CLOSE_ORDER,
  CLOSE_WORDS,
  KIND_ORDER,
  KIND_WORDS,
  PERSON_KIND_WORDS,
  UNATTRIBUTED_HELP,
  dayLabel,
  eventClock,
  eventTimeLabel,
  fmtSeconds,
  personName,
  personRole,
  reviewsText,
} from './team-format';

const NOTE = 'text-sm text-muted-foreground';

/**
 * The per-day table's columns, with short headers that fit the sheet: the chart's kinds,
 * so "Other" here is the chart's "Other case work" (assigned, screenshots added and
 * runbook steps done) and the two can be read against each other. A day with any
 * counted work never reads as a row of zeros. Reviews sit beside closes (SPEC D3.5).
 */
const DAY_COLUMNS: ReadonlyArray<readonly [string, string, readonly TeamKind[]]> = [
  ['closed', 'Closed', ['closed']],
  ['reviewed', 'Reviews', ['reviewed']],
  ['acknowledged', 'Acknowledged', ['acknowledged']],
  ['commented', 'Commented', ['commented']],
  ['escalated', 'Escalated', ['escalated']],
  ['reopened', 'Reopened', ['reopened']],
  ['other', 'Other', ['assigned', 'screenshot_added', 'runbook_step_done']],
  ['signed_in', 'Sign-ins', ['signed_in']],
];
const SECTION = 'space-y-2 border-t border-border pt-4';
const HEADING = 'text-sm font-semibold text-foreground';

function RouteAnchor({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  const safe = safeRouteHref(href);
  const onClick = useRouteLinkClick(safe);
  if (!safe) return <span className={className}>{children}</span>;
  return (
    <a href={safe} onClick={onClick} className={className ?? 'font-medium text-primary underline-offset-4 hover:underline'}>
      {children}
    </a>
  );
}

interface EventsState {
  events: TeamEvent[];
  total: number;
  cursor: string | null;
  loading: boolean;
  error: unknown;
  partial: boolean;
}

const NO_EVENTS: EventsState = { events: [], total: 0, cursor: null, loading: false, error: null, partial: false };

function usePersonEvents(username: string | null, window: string): EventsState & { more: () => void; retry: () => void } {
  const [state, setState] = React.useState<EventsState>(NO_EVENTS);
  const [nonce, setNonce] = React.useState(0);
  const controllerRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    if (!username) {
      setState(NO_EVENTS);
      return undefined;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ ...NO_EVENTS, loading: true });
    getTeamPersonEvents(username, window, null, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted) {
          setState({
            events: page.events,
            total: page.total,
            cursor: page.next_cursor,
            loading: false,
            error: null,
            partial: !page.exact,
          });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ ...NO_EVENTS, error });
      },
    );
    return () => controller.abort();
  }, [username, window, nonce]);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const more = React.useCallback(() => {
    const prev = stateRef.current;
    if (!username || !prev.cursor || prev.loading) return;
    // The page's own read: a newer window or person aborts it with the first page's.
    const controller = controllerRef.current ?? new AbortController();
    setState((now) => ({ ...now, loading: true, error: null }));
    getTeamPersonEvents(username, window, prev.cursor, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setState((now) => ({
          ...now,
          events: [...now.events, ...page.events],
          cursor: page.next_cursor,
          loading: false,
        }));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState((now) => ({ ...now, loading: false, error }));
      },
    );
  }, [username, window]);
  const retry = React.useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, more, retry };
}

export interface PersonSheetProps {
  person: PersonActivity | null;
  /** The server window token the page reads. */
  window: string;
  windowLabel: string;
  timezone: string;
  canViewAudit: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes when the sheet closes (the row that opened it); see `useReturnFocus`. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function PersonSheet({
  person,
  window,
  windowLabel,
  timezone,
  canViewAudit,
  onOpenChange,
  onCloseAutoFocus,
}: PersonSheetProps) {
  const open = person !== null;
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const attributable = person !== null && person.kind !== 'unattributed';
  const events = usePersonEvents(attributable ? person.username : null, window);
  const now = React.useMemo(() => new Date(), []);
  // The server counts days in the operator zone (SPEC D3.7); event times are shown in the
  // same zone, so an event and its day agree. Both are named on the sheet.
  const timesZone = eventClock(timezone).zone;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="xl"
        className="max-w-[46rem] gap-0 overflow-y-auto p-0"
        data-testid="team-person-sheet"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {person ? (
          <div className="space-y-4 p-5 sm:p-6">
            <header className="min-w-0 space-y-1 pr-10">
              <SheetTitle ref={titleRef} tabIndex={-1} className="break-words text-lg focus:outline-none">
                {personName(person)}
              </SheetTitle>
              <SheetDescription className={NOTE}>
                {[
                  person.kind !== 'unattributed' && person.display_name ? person.username : '',
                  personRole(person),
                  PERSON_KIND_WORDS[person.kind] && person.kind !== 'unattributed' ? PERSON_KIND_WORDS[person.kind] : '',
                  windowLabel,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </SheetDescription>
              {person.kind === 'unattributed' ? <p className={NOTE}>{UNATTRIBUTED_HELP}</p> : null}
              {canViewAudit && attributable ? (
                <div className="pt-2">
                  <Button asChild variant="outline" size="sm" className="gap-1.5">
                    <RouteAnchor href={pageHash('audit', { actor: person.username })} className="">
                      <ScrollText className="size-4" aria-hidden />
                      Open in Audit log
                    </RouteAnchor>
                  </Button>
                </div>
              ) : null}
            </header>

            <section aria-labelledby="team-person-counts" className={SECTION}>
              <h3 id="team-person-counts" className={HEADING}>
                In this window
              </h3>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {KIND_ORDER.map((kind) => (
                  <div key={kind} className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{KIND_WORDS[kind]}</dt>
                    <dd className="font-medium tabular-nums text-foreground">{fmtNumber(person.counts[kind] ?? 0)}</dd>
                  </div>
                ))}
              </dl>
              {person.counts.closed > 0 ? (
                <p className={NOTE}>
                  Closed as{' '}
                  {CLOSE_ORDER.filter((g) => person.closed_by[g] > 0)
                    .map((g) => `${CLOSE_WORDS[g].toLowerCase()} ${fmtNumber(person.closed_by[g])}`)
                    .join(', ')}
                  .
                </p>
              ) : null}
              {Object.values(person.bulk).some((n) => n > 0) ? (
                <p className={NOTE}>
                  Of which in bulk actions:{' '}
                  {(['acknowledged', 'closed', 'reopened', 'escalated', 'assigned'] as const)
                    .filter((k) => person.bulk[k] > 0)
                    .map((k) => `${KIND_WORDS[k].toLowerCase()} ${fmtNumber(person.bulk[k])}`)
                    .join(', ')}
                  .
                </p>
              ) : null}
              <p className={NOTE}>
                Median time to acknowledge:{' '}
                {fmtSeconds(person.median_ack_seconds) ?? 'not measured'}
                {person.ack_samples ? ` (${fmtNumber(person.ack_samples)} ${person.ack_samples === 1 ? 'case' : 'cases'})` : ''}.
              </p>
            </section>

            <section aria-labelledby="team-person-reviews" className={SECTION}>
              <h3 id="team-person-reviews" className={HEADING}>
                Auto-close reviews
              </h3>
              <p className={NOTE}>{reviewsText(person.reviews)}.</p>
              {person.reviews.completed > 0 ? (
                <p className={NOTE}>
                  Time spent reviewing: {fmtSeconds(person.reviews.time_spent_median_ms === null ? null : person.reviews.time_spent_median_ms / 1000) ?? 'not measured'}.
                  Time to review: {fmtSeconds(person.reviews.time_to_review_median_seconds) ?? 'not measured'}.
                </p>
              ) : null}
            </section>

            <section aria-labelledby="team-person-days" className={SECTION}>
              <h3 id="team-person-days" className={HEADING}>
                Per day
              </h3>
              {person.daily.length > 0 ? <p className={NOTE}>Days in {timezone}.</p> : null}
              {person.daily.length === 0 ? (
                <p className={NOTE}>Nothing recorded in this window.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label={`Work per day, days in ${timezone}`}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Day</TableHead>
                        {DAY_COLUMNS.map(([id, header]) => (
                          <TableHead key={id} className="whitespace-nowrap text-right">
                            {header}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...person.daily].reverse().map((day) => (
                        <TableRow key={day.date}>
                          <TableCell className="whitespace-nowrap">{dayLabel(day.date, now)}</TableCell>
                          {DAY_COLUMNS.map(([id, , kinds]) => (
                            <TableCell key={id} className="text-right tabular-nums">
                              {fmtNumber(kinds.reduce((sum, k) => sum + (day.counts[k] ?? 0), 0))}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            {attributable ? (
              <section aria-labelledby="team-person-events" className={SECTION}>
                <h3 id="team-person-events" className={HEADING}>
                  Events{events.total ? ` (${fmtNumber(events.total)})` : ''}
                </h3>
                {events.partial ? <p className={NOTE}>The audit log could only be read in part, so this list may be incomplete.</p> : null}
                {events.loading && events.events.length === 0 ? (
                  <LoadingState label="Loading events" layout="inline" />
                ) : events.error && events.events.length === 0 ? (
                  <LoadError
                    error={events.error}
                    title="Could not load the events"
                    fallback={teamErrorMessage(events.error) ?? 'The audit log could not be read.'}
                    onRetry={events.retry}
                  />
                ) : events.events.length === 0 ? (
                  <EmptyState compact state="no-data" title="No events in this window" />
                ) : (
                  <>
                    <p className={NOTE}>Times in {timesZone}.</p>
                    <ol className="divide-y divide-border" aria-label={`Events of ${personName(person)}`}>
                      {events.events.map((event, index) => (
                        <li key={`${event.ts}-${index}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm">
                          <span className="w-28 shrink-0 whitespace-nowrap tabular-nums text-muted-foreground" title={formatTimestamp(event.ts)}>
                            {eventTimeLabel(event.ts, timezone)}
                          </span>
                          <span className="font-medium text-foreground">{event.label}</span>
                          {event.case_id ? (
                            <RouteAnchor href={pageHash('case_manager', { caseId: event.case_id })}>
                              {event.case_number || 'Open the case'}
                            </RouteAnchor>
                          ) : null}
                          {event.detail ? <span className="text-muted-foreground">{event.detail}</span> : null}
                        </li>
                      ))}
                    </ol>
                    {events.error ? (
                      <p className={NOTE} role="status">
                        {teamErrorMessage(events.error) ?? 'Could not load more events.'}{' '}
                        <Button variant="link" size="sm" className="h-auto p-0" onClick={events.retry}>
                          Load the events again
                        </Button>
                      </p>
                    ) : null}
                    {events.cursor ? (
                      <div className="pt-2">
                        <Button variant="outline" size="sm" onClick={events.more} disabled={events.loading}>
                          {events.loading ? 'Loading' : 'Load more'}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
