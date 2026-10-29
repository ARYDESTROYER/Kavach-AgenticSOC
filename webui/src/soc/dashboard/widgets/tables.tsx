/**
 * Table widgets (Round 5 / G7; Round 14, SPEC §4.4.3):
 *
 * - `table.connector_health` "Connector health": each source, its events per minute,
 *   when it last sent an event and its state (healthy, silent, turned off), right now.
 *   Two-line rows on a phone.
 * - `table.recent_cases` "Recent cases": the newest cases with entity, verdict and age
 *   (the Round 5 widget, kept for saved boards), on the same bleeding panel table, each
 *   case number a link to Case Manager, two-line rows on a phone.
 *
 * Source names, case numbers and entities are source- or operator-derived and shown as
 * PLAIN text (#9). Read-only; advisory (#3).
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { DASH, caseLabel, fmtNumber, humanizeAge, humanizeToken } from '@/lib/format';
import type { Case } from '@/lib/types';
import { VerdictBadge } from '@/soc/components/badges';

import { useDashboardData, useDashboardRequest, type SourceHealthRow } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import { CaseNumberLink, PanelList, PanelListItem, PanelRow, PanelTable, panelFit, type PanelColumn } from './panel-table';
import { WidgetShell, requestState, resolveTitle, staleOf, type WidgetProps } from './common';

/** A relative age from epoch ms; a dash for an unusable value (never a throw). */
export function ageFromMillis(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || Math.abs(ms) > 8.64e15) return DASH;
  return humanizeAge(new Date(ms).toISOString());
}

export type ConnectorState = 'healthy' | 'silent' | 'off';

/** A source's state in plain words: turned off, silent (the detector flagged it), else healthy. */
export function connectorState(row: SourceHealthRow): ConnectorState {
  if (!row.enabled) return 'off';
  if (row.silent === true) return 'silent';
  return 'healthy';
}

function StateWord({ state }: { state: ConnectorState }) {
  if (state === 'healthy') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success-text">
        <CheckCircle2 className="size-3.5" aria-hidden />
        Healthy
      </span>
    );
  }
  if (state === 'silent') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-high-text">
        <AlertTriangle className="size-3.5" aria-hidden />
        Silent
      </span>
    );
  }
  return <span className="shrink-0 text-xs text-muted-foreground">Turned off</span>;
}

function rate(row: SourceHealthRow): string {
  if (!row.enabled) return 'Off';
  return typeof row.events_per_min === 'number' && Number.isFinite(row.events_per_min)
    ? row.events_per_min.toLocaleString(undefined, { maximumFractionDigits: row.events_per_min < 10 ? 1 : 0 })
    : DASH;
}

function lastEvent(row: SourceHealthRow): string {
  const age = ageFromMillis(row.last_event_millis);
  return age === DASH ? 'No event yet' : age;
}

const SOURCES_REQ: DashboardRequest = { key: 'sourcesHealth' };

const CONNECTOR_COLUMNS: readonly PanelColumn[] = [
  { label: 'Source' },
  { label: 'Events/min', width: '6.5rem', align: 'right' },
  { label: 'Last event', width: '7.5rem', align: 'right' },
  { label: 'State', width: '6.5rem' },
];

export function ConnectorHealthWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Connector health');
  const { retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'sourcesHealth' });
  const data = answer.data;
  const onRetry = () => retry(SOURCES_REQ);
  let state = requestState(answer, onRetry);
  const rows: SourceHealthRow[] = React.useMemo(() => {
    const order: Record<ConnectorState, number> = { silent: 0, healthy: 1, off: 2 };
    return [...(data?.sources ?? [])].sort(
      (a, b) => order[connectorState(a)] - order[connectorState(b)] || (a.source_name || '').localeCompare(b.source_name || ''),
    );
  }, [data]);
  if (!state && data && rows.length === 0) state = { kind: 'empty', title: 'No sources are connected' };
  const enabled = rows.filter((r) => r.enabled).length;
  const silent = rows.filter((r) => connectorState(r) === 'silent').length;
  return (
    <WidgetShell
      title={title}
      caption={`Right now · ${fmtNumber(enabled)} enabled${silent ? `, ${fmtNumber(silent)} silent` : ''}`}
      exit={{ label: 'View sources', page: 'sources' }}
      state={state}
      stale={staleOf(answer, onRetry)}
    >
      <PanelList label={title} fit={panelFit(CONNECTOR_COLUMNS)}>
        {rows.map((r) => (
          <PanelListItem
            key={r.source_id}
            primary={r.source_name || r.source_id}
            trailing={<StateWord state={connectorState(r)} />}
            secondary={`${humanizeToken(r.kind)} · ${r.enabled ? `${rate(r)} events a minute` : 'turned off'} · last event ${lastEvent(r)}`}
          />
        ))}
      </PanelList>
      <PanelTable
        label={title}
        columns={CONNECTOR_COLUMNS}
      >
        {rows.map((r) => {
          const st = connectorState(r);
          return (
            <PanelRow
              key={r.source_id}
              cells={[
                {
                  content: (
                    <span className="block min-w-0">
                      <span className="block truncate text-sm text-foreground" title={r.source_name || r.source_id}>
                        {r.source_name || r.source_id}
                      </span>
                      <span className="text-xs text-muted-foreground">{humanizeToken(r.kind)}</span>
                    </span>
                  ),
                },
                { content: rate(r), align: 'right', numeric: true },
                {
                  content: <span className={st === 'silent' ? 'text-high-text' : 'text-muted-foreground'}>{lastEvent(r)}</span>,
                  align: 'right',
                  numeric: true,
                  className: 'text-xs',
                },
                { content: <StateWord state={st} /> },
              ]}
            />
          );
        })}
      </PanelTable>
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Recent cases (Round 5, kept for saved boards)
// --------------------------------------------------------------------------- //

const CASES_REQ: DashboardRequest = { key: 'cases' };

/** The newest cases first (at most 12), from a `GET /api/cases` page. */
export function recentCaseRows(cases: readonly Case[] | undefined): Case[] {
  return [...(cases ?? [])].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 12);
}

const RECENT_CASE_COLUMNS: readonly PanelColumn[] = [
  { label: 'Case', width: '9rem' },
  { label: 'Entity' },
  { label: 'Verdict', width: '9rem' },
  { label: 'Age', width: '6rem', align: 'right' },
];

export function RecentCasesWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Recent cases');
  const { retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'cases' });
  const data = answer.data;
  const onRetry = () => retry(CASES_REQ);
  let state = requestState(answer, onRetry);
  const rows = React.useMemo(() => recentCaseRows(data?.cases), [data]);
  if (!state && data && rows.length === 0) state = { kind: 'empty', title: 'No cases yet' };
  const verdict = (c: Case) =>
    c.verdict ? <VerdictBadge verdict={c.verdict} /> : <span className="text-muted-foreground">No verdict yet</span>;
  return (
    <WidgetShell
      title={title}
      caption="All time · newest first"
      exit={{ label: 'View cases', page: 'cases' }}
      state={state}
      stale={staleOf(answer, onRetry)}
    >
      <PanelList label={title} fit={panelFit(RECENT_CASE_COLUMNS)}>
        {rows.map((c) => (
          <PanelListItem
            key={c.case_id}
            primary={<CaseNumberLink caseId={c.case_id} label={caseLabel(c)} />}
            trailing={verdict(c)}
            secondary={`${c.entity?.value || 'No entity'} · ${humanizeAge(c.created_at)}`}
          />
        ))}
      </PanelList>
      <PanelTable
        label={title}
        columns={RECENT_CASE_COLUMNS}
      >
        {rows.map((c) => (
          <PanelRow
            key={c.case_id}
            cells={[
              { content: <CaseNumberLink caseId={c.case_id} label={caseLabel(c)} /> },
              {
                content: (
                  <span className="block truncate text-sm text-muted-foreground" title={c.entity?.value || undefined}>
                    {c.entity?.value || DASH}
                  </span>
                ),
              },
              { content: verdict(c) },
              {
                content: <span className="text-xs text-muted-foreground">{humanizeAge(c.created_at)}</span>,
                align: 'right',
                numeric: true,
              },
            ]}
          />
        ))}
      </PanelTable>
    </WidgetShell>
  );
}
