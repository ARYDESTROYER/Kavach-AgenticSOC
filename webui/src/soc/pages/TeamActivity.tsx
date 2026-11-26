/**
 * Team activity (Round 15 SPEC D3): what each person did, per day, counted from the
 * audit log. Analytics > Team activity, `#/team`.
 *
 * A SOC manager tracks the team here; an auditor may read it; analysts do not
 * (`team:view`). While role-based access is off every signed-in account holds every
 * grant, so the server also asks for a stored role of Super admin, SOC manager or Auditor
 * and the page says so in a warning (SPEC D3.3). The operator can turn the page off
 * (Settings, Security & access, Single sign-on & policy, Team activity); with sign-in
 * off nothing can be attributed to a person and the page says that instead.
 *
 * Layout, in the Console's grammar: the header (title, help tip naming the time zone,
 * the range control, refresh, freshness), one KPI strip (people active, cases closed by
 * people, acknowledged, reviews completed, median time to acknowledge), the work per day
 * stacked by kind, and the people table (sortable, ordered by name; never a ranking or a
 * score, SPEC D3.5) with a CSV download. A row opens the person sheet.
 *
 * Honest states: a read that stopped at a limit shows a caveat and the counts as lower
 * bounds; a window with no work shows no data; a median the server could not measure is
 * "Not measured", never zero. No IP address, user agent or session is ever on this page.
 *
 * SECURITY (#9): names are plain text nodes; the CSV defuses formula leads (`lib/csv.ts`).
 */
import * as React from 'react';
import { Download } from 'lucide-react';

import { fmtNumber, humanizeAge } from '@/lib/format';
import { EXPORT_MIME, UTF8_BOM, downloadText, exportFileName } from '@/lib/download';
import { getTeamActivity, teamErrorCode, teamErrorMessage } from '@/lib/api-team';
import type { PersonActivity, TeamActivity as TeamActivityData, TeamKind } from '@/lib/types-team';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Callout, LoadingState, Panel } from '@/design-system';
import { ExplainTrigger } from '@/design-system/explain';
import { useOptionalAuth } from '@/soc/auth';
import { Unauthorized } from '@/soc/components/Can';
import { ChartCard } from '@/soc/components/ChartCard';
import { DataTable, TruncatedText, type DataTableColumn, type SortState } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { KpiTile } from '@/soc/components/KpiTile';
import { explainTeamAckMedian } from '@/soc/components/metrics-explain/builders';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { useReturnFocus } from '@/soc/hooks/useReturnFocus';
import { settingsSectionHash } from '@/soc/router';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';

import { PageAccess, usePermission } from './PageAccess';
import { UpdatedStamp } from './analytics-shared';
import { PersonSheet } from './team/PersonSheet';
import { TeamDailyChart } from './team/TeamDailyChart';
import { TeamRangeControl } from './team/TeamRangeControl';
import {
  CHART_WORDS,
  DEFAULT_TEAM_RANGE,
  OTHER_KINDS_TEXT,
  PERSON_KIND_WORDS,
  fmtSeconds,
  otherCount,
  peopleCsv,
  personName,
  personRole,
  rangeCaption,
  rangeLabel,
  rangeWindow,
  reviewsText,
  windowHasWork,
  type TeamRange,
} from './team/team-format';

const PAGE_TITLE = 'Team activity';

/** The name of a person's row action, which opens their sheet. */
function personActionLabel(person: PersonActivity): string {
  return `Open the activity of ${personName(person)}`;
}

/**
 * The row action that opened a person's sheet, looked up when the sheet closes: the table
 * may have re-rendered while it was open, and a row click by mouse never focused it.
 */
function personRowAction(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('button[aria-label]')).find(
    (el) => el.getAttribute('aria-label') === label,
  );
}

function pageHelp(timezone: string | null): string {
  const zone = timezone ? ` Days are calendar days in ${timezone}.` : '';
  return `What each person did, counted from the audit log.${zone} Counts come with their context only, never as a ranking or a score.`;
}

/** Off-page wording for the server's refusals. */
const OFF_DESCRIPTION =
  'An administrator can turn it on in Settings, Security & access, Single sign-on & policy, Team activity.';
const ROLE_FLOOR_WARNING =
  'Role-based access is off. Only Super admins, SOC managers and Auditors can open this page until it is on.';

function RouteAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = safeRouteHref(href);
  const onClick = useRouteLinkClick(safe);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} onClick={onClick} className="font-medium text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

interface Loaded {
  data: TeamActivityData | null;
  error: unknown;
  loading: boolean;
  /** The window the shown answer was read for. */
  readFor: string | null;
}

function useTeamActivityData(windowToken: string, nonce: number): Loaded {
  const [state, setState] = React.useState<Loaded>({ data: null, error: null, loading: true, readFor: null });
  React.useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true }));
    getTeamActivity(windowToken, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false, readFor: windowToken });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ data: null, error, loading: false, readFor: windowToken });
      },
    );
    return () => controller.abort();
  }, [windowToken, nonce]);
  return state;
}

/** A person's row as words: the name, the role and the kind of account. */
function personLine(person: PersonActivity): string {
  const kind = person.kind === 'unattributed' ? '' : PERSON_KIND_WORDS[person.kind];
  return [personName(person), personRole(person), kind].filter(Boolean).join(', ');
}

/** Last active for a person with nothing counted in the window. */
const NOT_IN_WINDOW = 'Not in window';

/**
 * The people table's columns. Sortable; the default order is by name.
 *
 * They fit a 1440px window with the navigation rail open, so nothing scrolls sideways
 * there: the role sits under the name, the case work uses the chart's kinds (so "Other"
 * is the chart's "Other case work"), every count column is as wide as its header (sort
 * icon included, in Inter) and Last active as "Not in window". The minimum leaves room
 * for a classic scrollbar. Sign-ins, each kind inside "Other" and the time to acknowledge
 * are on the person sheet and in the CSV. Narrower, the table scrolls with the person
 * kept in view.
 */
function peopleColumns(): DataTableColumn<PersonActivity>[] {
  const count = (
    id: string,
    header: string,
    width: number,
    value: (p: PersonActivity) => number,
    extra: Partial<DataTableColumn<PersonActivity>> = {},
  ): DataTableColumn<PersonActivity> => ({
    id,
    header,
    kind: 'number',
    width,
    sortable: true,
    cell: (p) => fmtNumber(value(p)),
    text: (p) => fmtNumber(value(p)),
    ...extra,
  });
  const kindCount = (id: TeamKind, header: string, width: number) => count(id, header, width, (p) => p.counts[id] ?? 0);
  return [
    {
      id: 'person',
      header: 'Person',
      minWidth: 220,
      sortable: true,
      text: personLine,
      // The name keeps the whole first line; the role and the kind of account sit under
      // it, the badge moving to a line of its own when both do not fit. A cut name or
      // role shows its full text as its title (`TruncatedText`).
      cell: (p) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <TruncatedText className="font-medium text-foreground">{personName(p)}</TruncatedText>
          {personRole(p) || PERSON_KIND_WORDS[p.kind] ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {personRole(p) ? <TruncatedText>{personRole(p)}</TruncatedText> : null}
              {PERSON_KIND_WORDS[p.kind] ? (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-2xs font-normal">
                  {PERSON_KIND_WORDS[p.kind]}
                </Badge>
              ) : null}
            </span>
          ) : null}
        </span>
      ),
    },
    kindCount('closed', 'Closed', 90),
    // Review counts sit beside close counts (SPEC D3.5): closes read with the reviews
    // beside them, so speed alone never reads as the work. A count like every other
    // column; how many agreed is its hover title and on the person sheet.
    count('reviewed', 'Reviews', 98, (p) => p.reviews.completed, {
      cell: (p) =>
        p.reviews.completed ? (
          <span title={reviewsText(p.reviews)}>{fmtNumber(p.reviews.completed)}</span>
        ) : (
          fmtNumber(0)
        ),
    }),
    kindCount('acknowledged', 'Acknowledged', 136),
    kindCount('commented', 'Commented', 120),
    kindCount('escalated', 'Escalated', 106),
    kindCount('reopened', 'Reopened', 108),
    count('other', 'Other', 84, otherCount, {
      header: <span title={`${CHART_WORDS.other}: ${OTHER_KINDS_TEXT}`}>Other</span>,
      menuLabel: CHART_WORDS.other,
    }),
    {
      id: 'last_active',
      header: 'Last active',
      kind: 'time',
      width: 120,
      sortable: true,
      text: (p) => (p.last_active ? humanizeAge(p.last_active) : NOT_IN_WINDOW),
      cell: (p) =>
        p.last_active ? (
          <span title={new Date(p.last_active).toLocaleString()}>{humanizeAge(p.last_active)}</span>
        ) : (
          <span className="text-muted-foreground">{NOT_IN_WINDOW}</span>
        ),
    },
  ];
}

function sortValue(person: PersonActivity, id: string): number | string {
  if (id === 'person') return personName(person).toLowerCase();
  if (id === 'reviewed') return person.reviews.completed;
  if (id === 'other') return otherCount(person);
  if (id === 'last_active') return person.last_active ? Date.parse(person.last_active) : 0;
  return person.counts[id as keyof PersonActivity['counts']] ?? 0;
}

/** Sorted people; Not attributed always last; ties by name. */
export function sortPeople(people: PersonActivity[], sort: SortState | null): PersonActivity[] {
  const named = people.filter((p) => p.kind !== 'unattributed');
  const rest = people.filter((p) => p.kind === 'unattributed');
  if (!sort) return [...named, ...rest];
  const dir = sort.dir === 'asc' ? 1 : -1;
  const sorted = [...named].sort((a, b) => {
    const av = sortValue(a, sort.id);
    const bv = sortValue(b, sort.id);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return personName(a).localeCompare(personName(b));
  });
  return [...sorted, ...rest];
}

/** Why the medians and the agreement rate are missing from a partial read. */
const PARTIAL_MEDIANS = 'The medians and the agreement rate are not measured from part of the window.';

function partialLine(data: TeamActivityData): string {
  const counts = data.partial_reason === 'row_limit'
    ? `This window holds more audit rows than one read counts (${fmtNumber(data.scanned_rows)} were read), so the counts are at least these. Choose a shorter window for exact counts.`
    : 'The audit log could only be read in part, so the counts are at least these.';
  return `${counts} ${PARTIAL_MEDIANS}`;
}

/**
 * A lifecycle tile's context: how many of its actions came from bulk actions, "one at a
 * time" when none did, and the range alone when there is nothing to qualify.
 */
function bulkContext(count: number, bulk: number, range: TeamRange): string {
  if (!count) return rangeCaption(range);
  return bulk ? `${fmtNumber(bulk)} in bulk actions` : 'one at a time';
}

/** The median's explanation on hover and click (numbers review); none when not measured. */
function ackExplainSlot(
  medianSeconds: number | null,
  samples: number,
  window: string,
): ((numeral: React.ReactNode) => React.ReactNode) | undefined {
  const shown = fmtSeconds(medianSeconds);
  const explanation = shown ? explainTeamAckMedian({ medianSeconds, samples, shown, window }) : null;
  if (!explanation) return undefined;
  return (numeral) => <ExplainTrigger explanation={explanation}>{numeral}</ExplainTrigger>;
}

function ackContext(data: TeamActivityData): string {
  const team = data.team;
  if (team.ack_status === 'too_many_cases') return 'too many cases to measure';
  if (team.ack_status === 'unavailable') return 'cases could not be read';
  if (team.ack_status === 'partial') return 'not measured from a partial read';
  if (!team.ack_samples) return 'no first acknowledgement';
  return `over ${fmtNumber(team.ack_samples)} ${team.ack_samples === 1 ? 'case' : 'cases'}`;
}

function TeamView() {
  const auth = useOptionalAuth();
  const can = usePermission();
  const [range, setRange] = React.useState<TeamRange>(DEFAULT_TEAM_RANGE);
  const [nonce, setNonce] = React.useState(0);
  const windowToken = rangeWindow(range);
  const loaded = useTeamActivityData(windowToken, nonce);
  // An answer read for another window is never shown under this one: the range control
  // and every caption already name the new window while its counts load.
  const fresh = loaded.readFor === windowToken;
  const data = fresh ? loaded.data : null;
  const error = fresh ? loaded.error : null;
  const loading = loaded.loading || !fresh;
  const [sort, setSort] = React.useState<SortState | null>(null);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  // The sheet opens from state (no Radix trigger), so Escape or Close hands focus back to
  // the row's action here rather than to the page body (WCAG 2.4.3).
  const personOpener = useReturnFocus();
  const columns = React.useMemo(() => peopleColumns(), []);
  const people = React.useMemo(() => sortPeople(data?.people ?? [], sort), [data, sort]);
  const openPerson = openKey === null ? null : (data?.people.find((p) => p.key === openKey) ?? null);
  const timezone = data?.timezone ?? null;
  const rbacOff = Boolean(auth?.authEnabled && !auth.rbacEnabled);

  const download = () => {
    if (!data) return;
    downloadText(
      exportFileName('team-activity', rangeLabel(range), 'csv'),
      EXPORT_MIME.csv,
      UTF8_BOM + peopleCsv(data),
    );
  };

  const header = (
    <PageHeader
      title={PAGE_TITLE}
      help={pageHelp(timezone)}
      controls={
        <>
          <TeamRangeControl value={range} onChange={setRange} timezone={timezone} />
          <RefreshButton
            display="icon"
            label="Refresh team activity"
            refreshing={loading && data !== null}
            disabled={loading}
            onClick={() => setNonce((n) => n + 1)}
          />
        </>
      }
      actions={<UpdatedStamp at={data?.generated_at} />}
    />
  );

  const code = teamErrorCode(error);
  let body: React.ReactNode;
  if (loading && !data && !error) {
    body = <LoadingState label="Loading team activity" description="Counting the window's audit rows." layout="panel" shape="panel" />;
  } else if (code === 'team_activity_off') {
    body = (
      <Panel as="div">
        <EmptyState state="unavailable" title="Team activity is turned off" description={OFF_DESCRIPTION} />
      </Panel>
    );
  } else if ((error as { status?: number } | null)?.status === 403) {
    body = <Unauthorized message={teamErrorMessage(error) ?? 'You do not have access to Team activity.'} />;
  } else if (error && !data) {
    body = (
      <LoadError
        error={error}
        title="Could not load team activity"
        fallback={teamErrorMessage(error) ?? 'The audit log could not be read.'}
        onRetry={() => setNonce((n) => n + 1)}
      />
    );
  } else if (data && !data.auth_enabled) {
    body = (
      <Panel as="div">
        <EmptyState
          state="unavailable"
          title="Sign-in is off"
          description="Sign-in is off, so work cannot be attributed to people."
        />
      </Panel>
    );
  } else if (data) {
    const team = data.team;
    const hasWork = windowHasWork(data);
    body = (
      <>
        {!data.exact ? (
          <Callout intent="warning" title="Counts are lower bounds" data-testid="team-partial">
            {partialLine(data)}
          </Callout>
        ) : null}
        {data.demo ? (
          <p className="text-sm text-muted-foreground" data-testid="team-demo-note">
            Demo Mode: showing Demo work.
          </p>
        ) : null}
        <KpiStrip label="Team summary" data-testid="team-kpis">
          <KpiTile label="People active" value={fmtNumber(team.people_active)} context={rangeCaption(range)} />
          <KpiTile label="Cases closed by people" value={fmtNumber(team.counts.closed)} context={bulkContext(team.counts.closed, team.bulk.closed, range)} />
          <KpiTile label="Acknowledged" value={fmtNumber(team.counts.acknowledged)} context={bulkContext(team.counts.acknowledged, team.bulk.acknowledged, range)} />
          <KpiTile label="Reviews completed" value={fmtNumber(team.reviews.completed)} context={team.reviews.completed ? reviewsText(team.reviews) : 'auto-close reviews'} />
          <KpiTile
            label="Median time to acknowledge"
            value={team.median_ack_seconds === null ? 'Not measured' : (fmtSeconds(team.median_ack_seconds) ?? 'Not measured')}
            context={ackContext(data)}
            explain={ackExplainSlot(team.median_ack_seconds, team.ack_samples, rangeCaption(range))}
          />
        </KpiStrip>
        <ChartCard title="Work per day" caption={`${rangeCaption(range)}, days in ${data.timezone}`}>
          {hasWork ? (
            <TeamDailyChart days={team.daily} />
          ) : (
            <EmptyState
              compact
              state="no-data"
              title="No case work in this window"
              description="Nobody acknowledged, closed, commented on or reviewed a case in this window."
            />
          )}
        </ChartCard>
        <Panel
          title="People"
          count={people.filter((p) => p.kind !== 'unattributed').length}
          caption="ordered by name"
          padding="none"
          actions={
            <Button variant="outline" size="sm" className="gap-1.5" onClick={download} disabled={people.length === 0}>
              <Download className="size-4" aria-hidden />
              Download CSV
            </Button>
          }
        >
          <DataTable
            columns={columns}
            rows={people}
            getRowId={(p) => p.key || '__unattributed__'}
            getRowLabel={(p) => personName(p)}
            getRowActionLabel={personActionLabel}
            onRowClick={(p) => {
              const label = personActionLabel(p);
              personOpener.remember(() => personRowAction(label));
              setOpenKey(p.key);
            }}
            sort={sort}
            onSortChange={setSort}
            surface="panel"
            stickyFirstColumn
            ariaLabel="People"
            rowNoun={{ one: 'person', other: 'people' }}
            emptyState={
              <EmptyState state="no-data" title="Nobody to show" description="No accounts and no recorded work in this window." />
            }
          />
        </Panel>
        <PersonSheet
          person={openPerson}
          window={windowToken}
          windowLabel={rangeLabel(range)}
          timezone={data.timezone}
          canViewAudit={can('audit', 'view')}
          windowStart={data.window.start}
          windowEnd={data.window.end}
          onCloseAutoFocus={personOpener.onCloseAutoFocus}
          onOpenChange={(open) => {
            if (!open) setOpenKey(null);
          }}
        />
      </>
    );
  }

  return (
    <PageContainer variant="wide">
      {header}
      {rbacOff ? (
        <Callout
          intent="warning"
          data-testid="team-rbac-off"
          action={<RouteAnchor href={settingsSectionHash('roles')}>Open Roles &amp; permissions</RouteAnchor>}
        >
          {ROLE_FLOOR_WARNING}
        </Callout>
      ) : null}
      {body}
    </PageContainer>
  );
}

export default function TeamActivityPage() {
  return (
    <PageAccess resource="team" action="view" title={PAGE_TITLE} message="You do not have access to Team activity.">
      <TeamView />
    </PageAccess>
  );
}
