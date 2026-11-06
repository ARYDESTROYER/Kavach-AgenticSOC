/**
 * Breakdown widgets (Round 14, SPEC §4.4.3), both from the exact breakdown engine the
 * chat's `case_stats` uses, so a board and an answer agree on every number:
 *
 * - `chart.case_breakdown`: cases in the window (or open now) by one field, as ranked
 *   bars, with the exact remainder as one "Other" row.
 * - `table.top_rules` "Top detection rules": the rules behind the most cases, each name a
 *   `RuleLink` that opens the rule's picture.
 *
 * A rule, technique or tactic breakdown is multi-valued (a case with two rules counts in
 * both rows), so its rows never claim to add up to the total. A source breakdown groups on
 * the source id; each row is named as Connector health names it (the source's name, read
 * from the sources health list when the viewer may read sources, else the id). Keys (rule
 * ids, source and technique names) are untrusted and shown as plain text (#9).
 */
import { cn } from '@/lib/cn';
import { fmtNumber, humanizeToken } from '@/lib/format';
import type { NavOpts } from '@/lib/types';
import type { BreakdownCaseField, MetricsBreakdown, MetricsBreakdownGroup } from '@/lib/types-dashboards';
import { RuleLink } from '@/soc/components/RuleLink';
import type { PageId } from '@/soc/router';

import { useDashboardData, useDashboardRequest, type SourcesHealthResponse } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import {
  BarRow,
  BoundCount,
  PHONE_ROW_TARGET,
  PanelList,
  PanelListItem,
  PanelRow,
  PanelTable,
  RankedBars,
  panelFit,
  type PanelColumn,
  type RankedBarItem,
} from './panel-table';
import { WidgetShell, countOf, requestState, resolveTitle, shareText, staleOf, type WidgetExitTarget, type WidgetProps } from './common';
import { SOURCE_NAMES_REQUEST, caseBreakdownRequest, caseBreakdownTitle, topRulesRequest } from './widget-requests';

const VERDICT_LABEL: Readonly<Record<string, string>> = {
  TRUE_POSITIVE: 'True positive',
  FALSE_POSITIVE: 'False positive',
  NEEDS_HUMAN: 'Needs human',
};

const CLOSED_BY_LABEL: Readonly<Record<string, string>> = {
  agent: 'AI agent',
  analyst: 'Analyst',
  analyst_policy: 'Analyst policy',
  system: 'System',
};

/** The label of a breakdown key, in plain words; keys stay verbatim where they are names. */
export function breakdownKeyLabel(by: BreakdownCaseField, key: string | null): string {
  if (key == null || key === '' || key === 'none') {
    switch (by) {
      case 'assignee':
        return 'Unassigned';
      case 'verdict':
        return 'No verdict yet';
      case 'closed_by':
        return 'Not closed';
      default:
        return 'Not set';
    }
  }
  switch (by) {
    case 'verdict':
      return VERDICT_LABEL[key] ?? humanizeToken(key);
    case 'closed_by':
      return CLOSED_BY_LABEL[key] ?? humanizeToken(key);
    case 'status':
    case 'severity':
      return humanizeToken(key);
    default:
      // Names (rules, sources, techniques, analysts) are shown exactly as stored.
      return key;
  }
}

/**
 * Where a breakdown's population is listed: always the cases (a breakdown counts cases,
 * whatever field it groups them by, sources included), open ones for the open stock.
 */
export function breakdownExit(open: boolean): WidgetExitTarget {
  const opts: NavOpts | undefined = open ? { status: '__active__' } : undefined;
  return { label: 'View cases', page: 'cases' as PageId, opts };
}

/**
 * The names Connector health shows for each source, by source id, from the sources health
 * list (plain text, #9). A row with no name keeps its id.
 */
export function sourceNames(health: SourcesHealthResponse | null | undefined): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const row of health?.sources ?? []) {
    const id = typeof row?.source_id === 'string' ? row.source_id : '';
    const name = typeof row?.source_name === 'string' ? row.source_name.trim() : '';
    if (id && name) names.set(id, name);
  }
  return names;
}

/**
 * The bar rows of a breakdown, with the exact remainder as one "Other" row. A group that
 * counts no case of the population (the engine can return one whose only non-zero figure
 * is another metric) is not a row of it. A source row takes the source's name when one is
 * known (`names`), else its id.
 */
export function breakdownBarItems(
  b: MetricsBreakdown,
  by: BreakdownCaseField,
  names?: ReadonlyMap<string, string>,
): RankedBarItem[] {
  const rows: RankedBarItem[] = b.groups
    .filter((g) => g.then_key == null && g.bucket == null && g.count > 0)
    .map((g) => {
      const named = by === 'source' && g.key ? names?.get(g.key) : undefined;
      return { label: named ?? breakdownKeyLabel(by, g.key), value: g.count };
    });
  const other = b.other;
  if (other && other.count > 0) {
    rows.push({
      label: `Other (${fmtNumber(other.groups)} more)`,
      value: other.count,
      color: 'bg-muted-foreground/40',
    });
  }
  return rows;
}

export function CaseBreakdownWidget(props: WidgetProps) {
  const req = caseBreakdownRequest(props.options);
  const by = (req.query?.by ?? 'status') as BreakdownCaseField;
  const open = req.query?.status_group === 'open';
  const title = resolveTitle(props, caseBreakdownTitle(props.options));
  const { windowInfo, retry, can } = useDashboardData();
  const answer = useDashboardRequest(req as DashboardRequest & { key: 'breakdown' });
  // Source rows are named as Connector health names them, for a viewer who may read
  // sources; without the grant (or before the list arrives) a row keeps its id.
  const health = useDashboardRequest(SOURCE_NAMES_REQUEST as DashboardRequest & { key: 'sourcesHealth' }, {
    enabled: by === 'source' && can('sources', 'read'),
  });
  const b = answer.data;
  const onRetry = () => retry(req);
  let state = requestState(answer, onRetry);
  if (!state && b && b.total === 0) {
    state = { kind: 'empty', title: open ? 'No open cases right now' : `No cases in the ${windowInfo.phrase}` };
  }
  const items = b ? breakdownBarItems(b, by, by === 'source' ? sourceNames(health.data) : undefined) : [];
  const population = b ? `${b.partial ? 'at least ' : ''}${countOf(b.total, 'case')}` : null;
  const caption = `${open ? 'Open now' : windowInfo.label}${population ? ` · ${population}` : ''}`;
  const notes = [
    b?.multi_valued ? 'A case with more than one value counts in each of its rows.' : null,
    b?.partial ? `Part of the cases could not be read${b.partial_reason ? `: ${b.partial_reason.replace(/\.$/, '')}` : ''}.` : null,
  ].filter(Boolean);
  return (
    <WidgetShell
      title={title}
      caption={caption}
      exit={breakdownExit(open)}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={notes.length ? notes.join(' ') : undefined}
    >
      <RankedBars label={title} items={items} format={fmtNumber} />
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Top detection rules
// --------------------------------------------------------------------------- //

/** The AI false-positive share of a rule's verdicted cases, or null with none verdicted. */
export function aiFalsePositiveShare(g: MetricsBreakdownGroup): number | null {
  const verdicted = g.verdicted ?? 0;
  if (!verdicted || g.verdict_fp == null) return null;
  return g.verdict_fp / verdicted;
}

/** The AI false-positive share in words (an AI-verdict figure, never an analyst grade). */
export function aiFpText(share: number | null): string {
  return share == null ? 'No AI verdict yet' : shareText(share);
}

/**
 * The rules of a top-rules breakdown that opened a case in the window. The engine also
 * returns rules whose only non-zero figure is `open_now` (open cases of ANY arrival
 * date), which are not part of "cases per rule in the window".
 */
export function topRuleRows(b: MetricsBreakdown): MetricsBreakdownGroup[] {
  return b.groups.filter((g) => g.key && g.then_key == null && g.bucket == null && g.count > 0);
}

const TOP_RULE_COLUMNS: readonly PanelColumn[] = [
  { label: 'Rule' },
  { label: 'Cases', width: '9rem' },
  { label: 'Open now', width: '5.5rem', align: 'right' },
  { label: 'AI FP rate', width: '7rem', align: 'right' },
];

export function TopRulesWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Top detection rules');
  const req = topRulesRequest(props.options);
  const { windowInfo, retry } = useDashboardData();
  const answer = useDashboardRequest(req as DashboardRequest & { key: 'breakdown' });
  const b = answer.data;
  const onRetry = () => retry(req);
  let state = requestState(answer, onRetry);
  const rows = b ? topRuleRows(b) : [];
  if (!state && b && rows.length === 0) state = { kind: 'empty', title: `No rule opened a case in the ${windowInfo.phrase}` };
  const max = rows.reduce((m, g) => Math.max(m, g.count), 0);
  // A store read that stopped partway makes every count a lower bound (never exact).
  const partial = b?.partial === true;
  const ruleWindow =
    b?.window_from && b?.window_to ? { from: b.window_from, to: b.window_to, label: windowInfo.label } : undefined;
  const link = (rule: string, phone = false) => (
    // `leading-6`: a 24 px pointer target per line (SPEC §3.3); the row's primary action
    // in the phone list is 44 px tall.
    <RuleLink
      rule={rule}
      window={ruleWindow}
      origin={title}
      className={cn('text-sm leading-6 text-foreground', phone && PHONE_ROW_TARGET)}
      title={rule}
    />
  );
  const footer = [
    'A case with two rules counts in both rows. Open now counts the rule\'s open cases of any arrival date.',
    'Select a rule to see its alerts, cases and settings.',
    b?.other && b.other.count > 0
      ? `${countOf(b.other.groups, 'more rule')} ${b.other.groups === 1 ? 'accounts' : 'account'} for ${countOf(b.other.count, 'more case row')}.`
      : null,
    partial ? `Part of the cases could not be read${b?.partial_reason ? `: ${b.partial_reason.replace(/\.$/, '')}` : ''}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <WidgetShell
      title={title}
      caption={`${windowInfo.label} · cases per rule${partial ? ' (lower bounds)' : ''}`}
      exit={{ label: 'View cases', page: 'cases' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={footer}
    >
      <PanelList label={title} fit={panelFit(TOP_RULE_COLUMNS)}>
        {rows.map((g) => {
          const share = aiFalsePositiveShare(g);
          return (
            <PanelListItem
              key={g.key as string}
              primary={link(g.key as string, true)}
              trailing={<BoundCount value={g.count} bound={partial} />}
              secondary={`${fmtNumber(g.open_now ?? 0)} open now · AI FP rate ${share == null ? 'no AI verdict yet' : shareText(share)}`}
            />
          );
        })}
      </PanelList>
      <PanelTable
        label={title}
        columns={TOP_RULE_COLUMNS}
      >
        {rows.map((g) => {
          const share = aiFalsePositiveShare(g);
          return (
            <PanelRow
              key={g.key as string}
              cells={[
                { content: <span className="line-clamp-2 break-words">{link(g.key as string)}</span> },
                {
                  content: (
                    <ul className="list-none">
                      <BarRow
                        label={<span className="sr-only">Cases</span>}
                        value={g.count}
                        max={max}
                        right={<BoundCount value={g.count} bound={partial} className="font-semibold" />}
                      />
                    </ul>
                  ),
                },
                { content: fmtNumber(g.open_now ?? 0), align: 'right', numeric: true },
                {
                  content: share == null ? <span className="text-muted-foreground">{aiFpText(share)}</span> : shareText(share),
                  align: 'right',
                  numeric: true,
                },
              ]}
            />
          );
        })}
      </PanelTable>
    </WidgetShell>
  );
}
