/**
 * What each widget reads, as pure functions of its options and the board (Round 14,
 * SPEC §4.4.3). The registry uses these to name every request up front (so the reads
 * start while the lazy widget bodies load), and the bodies use the same functions, so
 * the two can never ask for different data.
 *
 * Pure: no React, no network, no widget body. Gating (a widget or cell the viewer's role
 * cannot read, a case-derived read while row-level scope is on) is applied here too, so
 * a gated request is never named and never fetched.
 */
import type { BreakdownCaseField } from '@/lib/types-dashboards';

import { KPI_STRIP_BINDINGS, kpiStripCells, type KpiStripBinding, type KpiStripPreset } from '../kpi-bindings';
import { bindingRequests } from './kpi-eval';
import type { DashboardRequest } from './requests';

type Options = Record<string, unknown> | undefined;
export type PermissionCheck = (resource: string, action: string) => boolean;

export interface RequestEnv {
  can: PermissionCheck;
  /** `undefined` while not yet known: case-derived reads wait. */
  objectScoped: boolean | undefined;
  /** The board window in hours (some reads pick their bucket from it). */
  windowHours: number;
}

function choice<T extends string>(options: Options, key: string, allowed: readonly T[], fallback: T): T {
  const v = options?.[key];
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function int(options: Options, key: string, min: number, max: number, fallback: number): number {
  const raw = options?.[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** May case-derived data be read now? (scope known and off) */
export function caseReadsAllowed(env: Pick<RequestEnv, 'objectScoped'>): boolean {
  return env.objectScoped === false;
}

// --------------------------------------------------------------------------- //
// Per widget
// --------------------------------------------------------------------------- //

export const BREAKDOWN_FIELDS: readonly BreakdownCaseField[] = [
  'status',
  'verdict',
  'severity',
  'source',
  'rule',
  'closed_by',
  'assignee',
  'mitre_tactic',
  'mitre_technique',
];

/** The noun a breakdown field reads as in a title ("Cases by detection rule"). */
export const BREAKDOWN_FIELD_NOUN: Readonly<Record<BreakdownCaseField, string>> = {
  status: 'status',
  verdict: 'AI verdict',
  severity: 'severity',
  source: 'source',
  rule: 'detection rule',
  closed_by: 'who closed them',
  assignee: 'assignee',
  mitre_tactic: 'ATT&CK tactic',
  mitre_technique: 'ATT&CK technique',
};

/**
 * `chart.case_breakdown`'s own title for its options ("Open cases by status"). The body
 * and a gated panel (No access, row-level scope) both use it, so a hidden panel is named
 * as the reader would know it.
 */
export function caseBreakdownTitle(options: Options): string {
  const by = choice(options, 'by', BREAKDOWN_FIELDS, 'status');
  const open = choice(options, 'population', ['window', 'open'] as const, 'window') === 'open';
  return `${open ? 'Open cases' : 'Cases'} by ${BREAKDOWN_FIELD_NOUN[by]}`;
}

/** `chart.case_breakdown`: one field, the window or the open stock. */
export function caseBreakdownRequest(options: Options): DashboardRequest {
  const by = choice(options, 'by', BREAKDOWN_FIELDS, 'status');
  const top = int(options, 'top', 1, 50, 10);
  const open = choice(options, 'population', ['window', 'open'] as const, 'window') === 'open';
  return open
    ? { key: 'breakdown', window: 'all', query: { by, top, status_group: 'open' } }
    : { key: 'breakdown', query: { by, top } };
}

/** The sources health list a source breakdown names its rows from (never case data). */
export const SOURCE_NAMES_REQUEST: DashboardRequest = { key: 'sourcesHealth' };

/**
 * Everything `chart.case_breakdown` reads: its breakdown and, for a source breakdown and a
 * viewer who may read sources, the sources health list that names each source.
 */
export function caseBreakdownRequests(options: Options, env: Pick<RequestEnv, 'can'>): DashboardRequest[] {
  const req = caseBreakdownRequest(options);
  return req.query?.by === 'source' && env.can('sources', 'read') ? [req, SOURCE_NAMES_REQUEST] : [req];
}

/** `table.top_rules`: the rules behind the most cases in the window. */
export function topRulesRequest(options: Options): DashboardRequest {
  return { key: 'breakdown', query: { by: 'rule', top: int(options, 'top', 1, 50, 10) } };
}

/** The breakdown bucket a board window reads outcomes in: hourly in a day, daily in a week, else weekly. */
export function outcomeBucket(windowHours: number): 'hour' | 'day' | 'week' {
  if (windowHours <= 24) return 'hour';
  if (windowHours <= 168) return 'day';
  return 'week';
}

export type CaseTrendSeries = 'flow' | 'alerts' | 'outcomes';
export const CASE_TREND_SERIES: readonly CaseTrendSeries[] = ['flow', 'alerts', 'outcomes'];

const CASE_TREND_TITLE: Readonly<Record<CaseTrendSeries, string>> = {
  flow: 'Arrivals and closures',
  alerts: 'Alerts and cases over time',
  outcomes: 'Outcomes over time',
};

/** `chart.case_trend`'s own title for its series (see {@link caseBreakdownTitle}). */
export function caseTrendTitle(options: Options): string {
  return CASE_TREND_TITLE[choice(options, 'series', CASE_TREND_SERIES, 'flow')];
}

/** `chart.case_trend`: trends for the flow and alert series, the verdict breakdown for outcomes. */
export function caseTrendRequest(options: Options, windowHours: number): DashboardRequest {
  const series = choice(options, 'series', CASE_TREND_SERIES, 'flow');
  if (series === 'outcomes') {
    return { key: 'breakdown', query: { by: 'verdict', bucket: outcomeBucket(windowHours) } };
  }
  return { key: 'trends' };
}

export type SeverityBucket = 'hour' | 'day' | 'week';

/**
 * The bucket `chart.severity_trend` reads in: the operator's choice (day or week), else
 * one that suits the board window, hourly within a day (as Outcomes over time is), so a
 * 24-hour board never draws two daily bars in an empty plot.
 */
export function severityBucket(options: Options, windowHours: number): SeverityBucket {
  const chosen = options?.bucket;
  if (chosen === 'day' || chosen === 'week') return chosen;
  return windowHours <= 24 ? 'hour' : 'day';
}

/** `chart.severity_trend`: cases by severity, bucketed by hour, day or week. */
export function severityTrendRequest(options: Options, windowHours: number): DashboardRequest {
  return { key: 'breakdown', query: { by: 'severity', bucket: severityBucket(options, windowHours) } };
}

function bindingOf(group: string, cell: string): KpiStripBinding {
  const found = KPI_STRIP_BINDINGS.find((b) => b.group === group && b.cell === cell);
  if (!found) throw new Error(`KPI binding ${group}.${cell} is missing`);
  return found;
}

/** The F4 binding: open cases by AI verdict, group Needs human (never the status count). */
export const NEEDS_HUMAN_BINDING = bindingOf('operations', 'awaiting_decision');
/** Investigation spend divided by the cases the agent investigated. */
export const SPEND_PER_CASE_BINDING = bindingOf('cost_budget', 'spend_per_case');

export const STRIP_PRESETS: readonly KpiStripPreset[] = ['operations', 'detection', 'executive'];

/** Whether one strip cell may be read: its own grant, then row-level scope for a case-derived cell. */
export function stripCellReadable(binding: KpiStripBinding, env: Pick<RequestEnv, 'can' | 'objectScoped'>): boolean {
  if (!env.can(binding.grant.resource, binding.grant.action)) return false;
  return !binding.caseDerived || caseReadsAllowed(env);
}

/** `kpi.strip`: every readable cell's requests. */
export function stripRequests(options: Options, env: RequestEnv): DashboardRequest[] {
  const preset = choice(options, 'preset', STRIP_PRESETS, 'operations');
  return kpiStripCells(preset)
    .filter((b) => stripCellReadable(b, env))
    .flatMap((b) => bindingRequests(b));
}

/** `kpi.cost_budget`: spend, the budget (with `models:read`) and the per-case ratio (case-derived). */
export function costBudgetRequests(env: RequestEnv): DashboardRequest[] {
  const out: DashboardRequest[] = [{ key: 'usage' }];
  if (env.can('models', 'read')) out.push({ key: 'budget' });
  if (env.can('metrics', 'view') && caseReadsAllowed(env)) out.push(...bindingRequests(SPEND_PER_CASE_BINDING));
  return out;
}
