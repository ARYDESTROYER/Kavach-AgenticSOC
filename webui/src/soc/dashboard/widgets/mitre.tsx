/**
 * ATT&CK widgets (Round 5 / G7; Round 14, SPEC §4.4.3), both from the technique coverage
 * of the cases in the board window (`GET /api/mitre/coverage?window_hours=`):
 *
 * - `mitre.heatmap` "Techniques seen in cases": tactic by technique, every tactic that
 *   has a technique, with a list instead of the grid on a phone. It shows techniques
 *   observed on cases, never "detection coverage": the source SIEM's rule catalogue is
 *   not read.
 * - `table.top_techniques` "Top techniques": the techniques seen on the most cases.
 *
 * Technique ids and names are framework-canonical plain text (#9); advisory (#3).
 */
import * as React from 'react';

import { fmtNumber } from '@/lib/format';
import { MitreHeatmap, type MitreTacticColumn } from '@/soc/components/charts-soc';
import type { MitreCoverageResponse } from '@/soc/pages/Metrics.posture.api';

import { useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import { RankedBars } from './panel-table';
import {
  WidgetShell,
  countOf,
  optionInt,
  requestState,
  resolveTitle,
  staleOf,
  type WidgetExitTarget,
  type WidgetProps,
} from './common';

/**
 * The Enterprise ATT&CK tactics in kill-chain order (the matrix's own column order),
 * with "Defense Evasion" where older corpora still name it, before its split into
 * Stealth and Defense Impairment. A tactic not listed sorts after these, by name.
 */
export const ATTACK_TACTIC_ORDER: readonly string[] = [
  'Reconnaissance',
  'Resource Development',
  'Initial Access',
  'Execution',
  'Persistence',
  'Privilege Escalation',
  'Defense Evasion',
  'Stealth',
  'Defense Impairment',
  'Credential Access',
  'Discovery',
  'Lateral Movement',
  'Collection',
  'Command and Control',
  'Exfiltration',
  'Impact',
];

const TACTIC_RANK = new Map(ATTACK_TACTIC_ORDER.map((t, i) => [t.toLowerCase(), i]));

function tacticRank(tactic: string): number {
  return TACTIC_RANK.get(tactic.trim().toLowerCase()) ?? ATTACK_TACTIC_ORDER.length;
}

/**
 * Each tactic with at least one technique, in kill-chain order (stable across windows
 * and refreshes, as the matrix reads), its techniques by case count.
 */
export function heatmapColumns(data: MitreCoverageResponse): MitreTacticColumn[] {
  if (!data || !(data.covered_techniques > 0)) return [];
  return Object.values(data.by_tactic ?? {})
    .filter((t) => t.techniques.length > 0)
    .sort((a, b) => tacticRank(a.tactic) - tacticRank(b.tactic) || a.tactic.localeCompare(b.tactic))
    .map((t) => ({
      tactic: t.tactic,
      label: t.tactic,
      cells: [...t.techniques]
        .sort((a, b) => b.case_count - a.case_count)
        .slice(0, 8)
        .map((tech) => ({ technique: tech.id, name: tech.name, value: tech.case_count })),
    }));
}

const COVERAGE_REQ: DashboardRequest = { key: 'coverage' };

/**
 * The technique coverage is listed on Analytics' Posture tab. Short, so it stays on the
 * title row of a four-column panel beside a title such as "Top ATT&CK techniques".
 */
const COVERAGE_EXIT: WidgetExitTarget = { label: 'View coverage', page: 'metrics', opts: { tab: 'posture' } };

/** The coverage answer with the population fields the windowed read adds. */
type WindowedCoverage = MitreCoverageResponse & { store_total?: number; truncated?: boolean };

function caption(data: WindowedCoverage | null, label: string): string {
  if (!data) return label;
  const cases = typeof data.store_total === 'number' ? data.store_total : null;
  return `${label} · ${countOf(data.covered_techniques, 'technique')}${cases != null ? ` in ${countOf(cases, 'case')}` : ''}`;
}

export function MitreHeatmapWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Techniques seen in cases');
  const { windowInfo, retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'coverage' });
  const data = answer.data as WindowedCoverage | null;
  const onRetry = () => retry(COVERAGE_REQ);
  let state = requestState(answer, onRetry);
  const columns = React.useMemo(() => (data ? heatmapColumns(data) : []), [data]);
  if (!state && data && columns.length === 0) state = { kind: 'empty', title: `No technique on a case in the ${windowInfo.phrase}` };
  const list = columns
    .flatMap((c) => c.cells.map((cell) => ({ ...cell, tactic: c.label })))
    .sort((a, b) => b.value - a.value);
  const seen = new Set<string>();
  const unique = list.filter((cell) => (seen.has(cell.technique) ? false : (seen.add(cell.technique), true)));
  return (
    <WidgetShell
      title={title}
      caption={caption(data, windowInfo.label)}
      exit={COVERAGE_EXIT}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={`Techniques observed on cases, not what the detections could catch.${data?.truncated ? ' Counted from part of the cases in the window.' : ''}`}
    >
      <div className="hidden min-w-0 sm:block">
        <MitreHeatmap columns={columns} ariaLabel={title} />
      </div>
      <ul className="flex flex-col divide-y divide-border/60 sm:hidden" aria-label={title}>
        {unique.map((cell) => (
          <li key={cell.technique} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="font-mono text-xs text-muted-foreground">{cell.technique}</span>{' '}
              <span className="text-foreground">{cell.name}</span>
              <span className="block text-xs text-muted-foreground">{cell.tactic}</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-foreground">{fmtNumber(cell.value)}</span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}

export function TopTechniquesWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Top techniques');
  const top = optionInt(props.options, 'top', 1, 25, 10);
  const { windowInfo, retry } = useDashboardData();
  const answer = useDashboardRequest({ key: 'coverage' });
  const data = answer.data;
  const onRetry = () => retry(COVERAGE_REQ);
  let state = requestState(answer, onRetry);
  const items = (data?.top_techniques ?? [])
    .slice(0, top)
    .map((t) => ({ label: `${t.id} ${t.name}`, value: t.case_count }));
  if (!state && data && items.length === 0) state = { kind: 'empty', title: `No technique on a case in the ${windowInfo.phrase}` };
  return (
    <WidgetShell
      title={title}
      caption={`${windowInfo.label} · cases per technique`}
      exit={COVERAGE_EXIT}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer="A case with two techniques counts in both rows."
    >
      <RankedBars label={title} items={items} format={fmtNumber} />
    </WidgetShell>
  );
}
