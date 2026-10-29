/**
 * The dashboard WIDGET REGISTRY (Round 5 / G7, CD1; Round 14, SPEC §4.4.3).
 *
 * The registry separates what a widget IS (code-defined here: its body, default size,
 * config fields, grants, what it reads) from where it SITS (per-user layout data in the
 * `DashboardStore`). This is Grafana's panel-type and gridPos split: a stale saved layout
 * never breaks when a widget is renamed or removed.
 *
 * KEY PROPERTIES
 *   - `WidgetType` is a compile-time string union, mirrored by
 *     `widget-types.contract.json` and the server's allowlist (the two contract tests pin
 *     all three). A layout naming an unknown type is DROPPED on load
 *     ({@link reconcileWidgets}).
 *   - Each `Component` is `React.lazy`, so a board pulls only the code of the widgets it
 *     renders. The react-grid-layout edit surface is the one heavy import and loads only
 *     in Edit mode, elsewhere.
 *   - `requests` names the data a widget reads as pure functions of its options and the
 *     board (`widgets/widget-requests.ts`), so the one data provider starts every read up
 *     front and two widgets reading the same thing share one fetch. A widget the viewer's
 *     role cannot read, and a case-derived read while row-level data scope is on (D16),
 *     are never named.
 *   - `requires` (and `requiresAll`) gate a widget behind `resource:action` grants (the
 *     matrix `<Can>` uses): the gallery, reconcile-on-load and the board all honour them,
 *     and the server checks every read again (#9).
 *   - `caseDerived` marks a widget whose figures come from case data: `true` hides it
 *     while row-level scope is on ("Hidden while row-level scope is on."); `'partial'`
 *     hides only its case parts (the KPI strip's case cells, the funnel's case stages,
 *     the per-case spend line).
 *
 * NON-NEGOTIABLES: a layout is ADVISORY presentation only and never feeds
 * `case_manager.decide()` (#3). Every source is a non-billing read of aggregates or case
 * rows (#6, #7). Titles and labels are UNTRUSTED and rendered as plain text, never markup
 * (#9). The default stays calm (#10); breadth degrades gracefully (#11).
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlarmClock,
  BadgeCheck,
  BarChart3,
  Bot,
  ChartArea,
  CircleDollarSign,
  Crosshair,
  Filter,
  Gauge,
  Hourglass,
  LayoutDashboard,
  ListChecks,
  ListOrdered,
  ListTodo,
  Megaphone,
  Network,
  Plug,
  RadioTower,
  Timer,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react';

import type { DashboardWidget } from '@/lib/types';
import type { WidgetProps } from './widgets/common';
import type { DashboardRequest, DashboardSourceKey } from './widgets/requests';
import {
  caseBreakdownRequests,
  caseBreakdownTitle,
  caseTrendRequest,
  caseTrendTitle,
  costBudgetRequests,
  NEEDS_HUMAN_BINDING,
  severityTrendRequest,
  stripRequests,
  topRulesRequest,
  type RequestEnv,
} from './widgets/widget-requests';
import { bindingRequests } from './widgets/kpi-eval';

// --------------------------------------------------------------------------- //
// Widget type enum
// --------------------------------------------------------------------------- //

/**
 * Every widget type. Adding one = one value here, one registry entry, one lazy body, one
 * value in `widget-types.contract.json` and the server allowlist.
 */
export type WidgetType =
  | 'kpi.needs_human'
  | 'kpi.cost_budget'
  | 'chart.verdict_mix'
  | 'chart.autonomous_vs_human'
  | 'kpi.lifecycle_timing'
  | 'table.connector_health'
  | 'table.recent_cases'
  | 'mitre.heatmap'
  | 'gauge.active_risk'
  // Round 14 (SPEC §4.4.3): the built-in boards' modules, also offered in the builder.
  | 'kpi.strip'
  | 'chart.case_trend'
  | 'chart.case_breakdown'
  | 'chart.severity_trend'
  | 'chart.backlog_aging'
  | 'chart.noise_funnel'
  | 'table.attention_queue'
  | 'table.workload'
  | 'table.sla_breaches'
  | 'table.top_rules'
  | 'table.noisy_rules'
  | 'table.top_techniques'
  | 'kpi.auto_close_health'
  | 'table.campaigns'
  | 'table.telemetry_gaps'
  | 'kpi.agent_quality';

/** A single `resource:action` RBAC requirement (mirrors the `<Can>` matrix). */
export interface WidgetPermission {
  resource: string;
  action: string;
}

/** A declarative config field, rendered in the per-widget config sheet. */
export interface WidgetConfigField {
  /** Option key written into `DashboardWidget.options`. */
  key: string;
  /** Field label (plain text). */
  label: string;
  /** Control kind: a plain-text field or a select. */
  kind: 'text' | 'select';
  /** For `select`: the choices. */
  choices?: { value: string; label: string }[];
  /** Placeholder or helper (plain text). */
  placeholder?: string;
}

/** `(resource, action) => boolean`: pass `useAuth().hasPermission`. */
export type PermissionCheck = (resource: string, action: string) => boolean;

export interface WidgetDef {
  type: WidgetType;
  /** Default title (an operator can override it; PLAIN text #9). */
  title: string;
  /**
   * The title a widget derives from its options, where it names its own population
   * ("Open cases by status", "Arrivals and closures"). The body and a gated panel use the
   * same function, so a panel hidden by a role or by row-level scope is named as the
   * reader would know it. Falls back to `title`.
   */
  titleFor?: (options: Record<string, unknown> | undefined) => string;
  /** One-line gallery description (plain text). */
  description: string;
  /** Gallery and toolbar icon. */
  icon: LucideIcon;
  /** Coarse category for the gallery filter. */
  category: 'kpi' | 'chart' | 'table' | 'coverage';
  /** Lazy body: a board only pulls the code of the widgets it renders. */
  Component: React.LazyExoticComponent<React.ComponentType<WidgetProps>>;
  /** Default grid size and minimums (12-column grid units). */
  defaultSize: { w: number; h: number; minW: number; minH: number };
  /** The provider keys this widget reads (for the gallery and older hosts). */
  sources: DashboardSourceKey[];
  /** The requests this widget reads for its options (see the module comment). */
  requests: (options: Record<string, unknown> | undefined, env: RequestEnv) => DashboardRequest[];
  /** The grant the gallery and reconcile-on-load check (the spec's display gate). */
  requires?: WidgetPermission;
  /** Further grants the widget's reads need (the server checks each read). */
  requiresAll?: WidgetPermission[];
  /** Case-derived: hidden while row-level scope is on (`'partial'`: only its case parts). */
  caseDerived: boolean | 'partial';
  /** Declarative config fields (rendered in the config sheet). */
  configFields?: WidgetConfigField[];
}

// --------------------------------------------------------------------------- //
// Lazy widget bodies
// --------------------------------------------------------------------------- //
// One dynamic import per body file, selecting the named export.

function lazyBody(load: () => Promise<React.ComponentType<WidgetProps>>) {
  return React.lazy(() => load().then((Component) => ({ default: Component })));
}

const NeedsHumanQueueWidget = lazyBody(() => import('./widgets/kpi').then((m) => m.NeedsHumanQueueWidget));
const CostBudgetWidget = lazyBody(() => import('./widgets/kpi').then((m) => m.CostBudgetWidget));
const VerdictMixWidget = lazyBody(() => import('./widgets/mix').then((m) => m.VerdictMixWidget));
const AutonomousVsHumanWidget = lazyBody(() => import('./widgets/mix').then((m) => m.AutonomousVsHumanWidget));
const LifecycleTimingWidget = lazyBody(() => import('./widgets/lifecycle').then((m) => m.LifecycleTimingWidget));
const ConnectorHealthWidget = lazyBody(() => import('./widgets/tables').then((m) => m.ConnectorHealthWidget));
const RecentCasesWidget = lazyBody(() => import('./widgets/tables').then((m) => m.RecentCasesWidget));
const MitreHeatmapWidget = lazyBody(() => import('./widgets/mitre').then((m) => m.MitreHeatmapWidget));
const TopTechniquesWidget = lazyBody(() => import('./widgets/mitre').then((m) => m.TopTechniquesWidget));
const RiskGaugeWidget = lazyBody(() => import('./widgets/risk').then((m) => m.RiskGaugeWidget));
const KpiStripWidget = lazyBody(() => import('./widgets/strip').then((m) => m.KpiStripWidget));
const CaseTrendWidget = lazyBody(() => import('./widgets/trend').then((m) => m.CaseTrendWidget));
const SeverityTrendWidget = lazyBody(() => import('./widgets/trend').then((m) => m.SeverityTrendWidget));
const CaseBreakdownWidget = lazyBody(() => import('./widgets/breakdown').then((m) => m.CaseBreakdownWidget));
const TopRulesWidget = lazyBody(() => import('./widgets/breakdown').then((m) => m.TopRulesWidget));
const AttentionQueueWidget = lazyBody(() => import('./widgets/shift').then((m) => m.AttentionQueueWidget));
const WorkloadWidget = lazyBody(() => import('./widgets/shift').then((m) => m.WorkloadWidget));
const SlaBreachesWidget = lazyBody(() => import('./widgets/shift').then((m) => m.SlaBreachesWidget));
const BacklogAgingWidget = lazyBody(() => import('./widgets/shift').then((m) => m.BacklogAgingWidget));
const NoiseFunnelWidget = lazyBody(() => import('./widgets/detection').then((m) => m.NoiseFunnelWidget));
const NoisyRulesWidget = lazyBody(() => import('./widgets/detection').then((m) => m.NoisyRulesWidget));
const TelemetryGapsWidget = lazyBody(() => import('./widgets/detection').then((m) => m.TelemetryGapsWidget));
const AutoCloseHealthWidget = lazyBody(() => import('./widgets/detection').then((m) => m.AutoCloseHealthWidget));
const CampaignsWidget = lazyBody(() => import('./widgets/executive').then((m) => m.CampaignsWidget));
const AgentQualityWidget = lazyBody(() => import('./widgets/executive').then((m) => m.AgentQualityWidget));

// A plain-text title override every widget accepts.
const TITLE_FIELD: WidgetConfigField = {
  key: 'title',
  label: 'Title',
  kind: 'text',
  placeholder: 'Override the widget title (plain text)',
};

/**
 * A "Rows" select over whole-number choices. `fallback` is the number of rows the body
 * shows while the option is not set, so the sheet states it.
 */
const ROWS_FIELD = (key: 'top' | 'limit', choices: number[], fallback: number): WidgetConfigField => ({
  key,
  label: 'Rows',
  kind: 'select',
  choices: choices.map((n) => ({ value: String(n), label: String(n) })),
  placeholder: `Default ${fallback}`,
});

const TOP_FIELD = (choices: number[]): WidgetConfigField => ROWS_FIELD('top', choices, 10);

const METRICS_VIEW: WidgetPermission = { resource: 'metrics', action: 'view' };
const CASES_READ: WidgetPermission = { resource: 'cases', action: 'read' };

/** A widget that reads one fixed request. */
const reads =
  (...requests: DashboardRequest[]) =>
  (): DashboardRequest[] =>
    requests;

// --------------------------------------------------------------------------- //
// The registry
// --------------------------------------------------------------------------- //

const DEFS: WidgetDef[] = [
  {
    type: 'kpi.needs_human',
    title: 'Awaiting a decision',
    description: 'Open cases whose AI verdict is Needs human, counted over every open case.',
    icon: UserCheck,
    category: 'kpi',
    Component: NeedsHumanQueueWidget,
    defaultSize: { w: 3, h: 3, minW: 2, minH: 2 },
    sources: ['breakdown'],
    // F4: counted by verdict (`breakdown?by=verdict&status_group=open&window=all`).
    requests: () => bindingRequests(NEEDS_HUMAN_BINDING),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'kpi.cost_budget',
    title: 'AI spend',
    description: 'Model spend in the window, chat spend outside the budget, the budget used and the spend per investigated case.',
    icon: CircleDollarSign,
    category: 'kpi',
    Component: CostBudgetWidget,
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    sources: ['usage', 'budget', 'breakdown'],
    requests: (_options, env) => costBudgetRequests(env),
    // The cost grant is `cost:view` (rbac/policy.py); `cost:read` is not a real action.
    requires: { resource: 'cost', action: 'view' },
    caseDerived: 'partial',
    configFields: [TITLE_FIELD],
  },
  {
    type: 'chart.verdict_mix',
    title: 'Cases by verdict',
    description: 'The window\'s cases by AI verdict, as ranked bars.',
    icon: BarChart3,
    category: 'chart',
    Component: VerdictMixWidget,
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    // The board window's cases by AI verdict (`/api/metrics` counts are all time).
    sources: ['breakdown'],
    requests: reads({ key: 'breakdown', query: { by: 'verdict' } }),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'chart.autonomous_vs_human',
    title: 'Human vs AI',
    description: 'Closed cases split by who closed them, the AI agent, a person or the system.',
    icon: Bot,
    category: 'chart',
    Component: AutonomousVsHumanWidget,
    defaultSize: { w: 4, h: 6, minW: 3, minH: 4 },
    sources: ['posture', 'trends'],
    requests: reads({ key: 'posture' }, { key: 'trends' }),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [],
  },
  {
    type: 'kpi.lifecycle_timing',
    title: 'Response timing',
    description: 'Time to detect, acknowledge and resolve, and dwell time: p50 and p90.',
    icon: Timer,
    category: 'kpi',
    Component: LifecycleTimingWidget,
    defaultSize: { w: 12, h: 3, minW: 6, minH: 3 },
    sources: ['posture'],
    requests: reads({ key: 'posture' }),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.connector_health',
    title: 'Connector health',
    description: 'Each source with its events per minute, last event and state.',
    icon: Plug,
    category: 'table',
    Component: ConnectorHealthWidget,
    defaultSize: { w: 6, h: 5, minW: 4, minH: 3 },
    sources: ['sourcesHealth'],
    requests: reads({ key: 'sourcesHealth' }),
    requires: { resource: 'sources', action: 'read' },
    caseDerived: false,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.recent_cases',
    title: 'Recent cases',
    description: 'The newest cases with entity, verdict and age.',
    icon: ListChecks,
    category: 'table',
    Component: RecentCasesWidget,
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    sources: ['cases'],
    requests: reads({ key: 'cases' }),
    requires: CASES_READ,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'mitre.heatmap',
    title: 'Techniques seen in cases',
    description: 'ATT&CK tactic by technique for the cases in the window (not detection coverage).',
    icon: Crosshair,
    category: 'coverage',
    Component: MitreHeatmapWidget,
    defaultSize: { w: 8, h: 5, minW: 4, minH: 4 },
    sources: ['coverage'],
    requests: reads({ key: 'coverage' }),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'gauge.active_risk',
    title: 'Active risk index',
    description: 'The mean risk of the open cases, with the critical threshold marked.',
    icon: Gauge,
    category: 'kpi',
    Component: RiskGaugeWidget,
    defaultSize: { w: 4, h: 4, minW: 2, minH: 3 },
    sources: ['metrics'],
    requests: reads({ key: 'metrics' }),
    requires: CASES_READ,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'kpi.strip',
    title: 'KPI strip',
    description: 'Six headline figures for operations, detection or executive reporting.',
    icon: LayoutDashboard,
    category: 'kpi',
    Component: KpiStripWidget,
    // Three rows: the strip's labels, numerals and context lines fit a fixed edit-mode
    // cell under the edit toolbar without being cut.
    defaultSize: { w: 12, h: 3, minW: 6, minH: 3 },
    sources: ['posture', 'breakdown', 'shift', 'sourcesHealth', 'noise', 'coverage', 'autoClose'],
    requests: (options, env) => stripRequests(options, env),
    // No widget-level grant: each cell has its own and a denied cell reads "No access".
    caseDerived: 'partial',
    configFields: [
      TITLE_FIELD,
      {
        key: 'preset',
        label: 'Figures',
        kind: 'select',
        choices: [
          { value: 'operations', label: 'Operations' },
          { value: 'detection', label: 'Detection' },
          { value: 'executive', label: 'Executive' },
        ],
      },
    ],
  },
  {
    type: 'chart.case_trend',
    title: 'Cases over time',
    titleFor: caseTrendTitle,
    description: 'Arrivals and closures, alerts and cases, or outcomes over the window.',
    icon: TrendingUp,
    category: 'chart',
    Component: CaseTrendWidget,
    defaultSize: { w: 8, h: 5, minW: 4, minH: 4 },
    sources: ['trends', 'breakdown'],
    requests: (options, env) => [caseTrendRequest(options, env.windowHours)],
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [
      TITLE_FIELD,
      {
        key: 'series',
        label: 'Series',
        kind: 'select',
        choices: [
          { value: 'flow', label: 'Arrivals and closures' },
          { value: 'alerts', label: 'Alerts and cases' },
          { value: 'outcomes', label: 'Outcomes' },
        ],
      },
      {
        key: 'family',
        label: 'Outcomes from',
        kind: 'select',
        choices: [
          { value: 'ai', label: 'AI verdicts' },
          { value: 'analyst', label: 'Analyst outcome' },
        ],
        placeholder: 'For the outcomes series',
      },
    ],
  },
  {
    type: 'chart.case_breakdown',
    title: 'Case breakdown',
    titleFor: caseBreakdownTitle,
    description: 'Cases in the window, or open now, by one field as ranked bars.',
    icon: BarChart3,
    category: 'chart',
    Component: CaseBreakdownWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    sources: ['breakdown'],
    requests: (options, env) => caseBreakdownRequests(options, env),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [
      TITLE_FIELD,
      {
        key: 'by',
        label: 'Break down by',
        kind: 'select',
        choices: [
          { value: 'status', label: 'Status' },
          { value: 'verdict', label: 'AI verdict' },
          { value: 'severity', label: 'Severity' },
          { value: 'source', label: 'Source' },
          { value: 'rule', label: 'Detection rule' },
          { value: 'closed_by', label: 'Closed by' },
          { value: 'assignee', label: 'Assignee' },
          { value: 'mitre_tactic', label: 'ATT&CK tactic' },
          { value: 'mitre_technique', label: 'ATT&CK technique' },
        ],
      },
      {
        key: 'population',
        label: 'Cases',
        kind: 'select',
        choices: [
          { value: 'window', label: 'Created in the window' },
          { value: 'open', label: 'Open now' },
        ],
      },
      TOP_FIELD([5, 10]),
    ],
  },
  {
    type: 'chart.severity_trend',
    title: 'Cases by severity over time',
    description: 'Case counts stacked by severity level: hourly within a day, else daily or weekly.',
    icon: ChartArea,
    category: 'chart',
    Component: SeverityTrendWidget,
    defaultSize: { w: 8, h: 5, minW: 4, minH: 4 },
    sources: ['breakdown'],
    requests: (options, env) => [severityTrendRequest(options, env.windowHours)],
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [
      TITLE_FIELD,
      {
        key: 'bucket',
        label: 'Bucket',
        kind: 'select',
        choices: [
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week' },
        ],
        placeholder: 'Fits the window',
      },
    ],
  },
  {
    type: 'chart.backlog_aging',
    title: 'Backlog aging',
    description: 'Open cases by how long they have been open.',
    icon: Hourglass,
    category: 'chart',
    Component: BacklogAgingWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    sources: ['posture'],
    requests: reads({ key: 'posture', window: 'all' }),
    requires: CASES_READ,
    requiresAll: [METRICS_VIEW],
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'chart.noise_funnel',
    title: 'Noise reduction',
    description: 'Raw alerts reduced to cases and outcomes over the window.',
    icon: Filter,
    category: 'chart',
    Component: NoiseFunnelWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    sources: ['noise'],
    requests: reads({ key: 'noise' }),
    requires: METRICS_VIEW,
    caseDerived: 'partial',
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.attention_queue',
    title: 'Needs attention now',
    description: 'Open cases ranked by breached targets, then by urgency.',
    icon: ListTodo,
    category: 'table',
    Component: AttentionQueueWidget,
    defaultSize: { w: 8, h: 6, minW: 4, minH: 4 },
    sources: ['shift'],
    requests: reads({ key: 'shift' }),
    requires: CASES_READ,
    caseDerived: true,
    configFields: [TITLE_FIELD, ROWS_FIELD('limit', [5, 8, 10], 8)],
  },
  {
    type: 'table.workload',
    title: 'Analyst workload',
    description: 'Open cases per analyst, with the unassigned queue.',
    icon: Users,
    category: 'table',
    Component: WorkloadWidget,
    defaultSize: { w: 4, h: 6, minW: 3, minH: 4 },
    sources: ['shift'],
    requests: reads({ key: 'shift' }),
    requires: CASES_READ,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.sla_breaches',
    title: 'SLA breaches and at risk',
    description: 'Cases of the window past or near their response and resolve targets.',
    icon: AlarmClock,
    category: 'table',
    Component: SlaBreachesWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    sources: ['posture'],
    requests: reads({ key: 'posture' }),
    requires: CASES_READ,
    requiresAll: [METRICS_VIEW],
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.top_rules',
    title: 'Top detection rules',
    description: 'The rules behind the most cases in the window.',
    icon: ListOrdered,
    category: 'table',
    Component: TopRulesWidget,
    defaultSize: { w: 6, h: 6, minW: 4, minH: 4 },
    sources: ['breakdown'],
    requests: (options) => [topRulesRequest(options)],
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD, TOP_FIELD([5, 10])],
  },
  {
    type: 'table.noisy_rules',
    title: 'Noisiest rules',
    description: 'Rules over the false-positive target, with their tuning state.',
    icon: Megaphone,
    category: 'table',
    Component: NoisyRulesWidget,
    defaultSize: { w: 6, h: 6, minW: 4, minH: 4 },
    sources: ['tuning'],
    requests: reads({ key: 'tuning' }),
    requires: { resource: 'automation', action: 'read' },
    caseDerived: false,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.top_techniques',
    title: 'Top techniques',
    description: 'The ATT&CK techniques seen on the most cases in the window.',
    icon: Crosshair,
    category: 'coverage',
    Component: TopTechniquesWidget,
    defaultSize: { w: 4, h: 6, minW: 3, minH: 4 },
    sources: ['coverage'],
    requests: reads({ key: 'coverage' }),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD, TOP_FIELD([5, 10])],
  },
  {
    type: 'kpi.auto_close_health',
    title: 'Auto-close health',
    description: 'How many cases the agent closed on its first decision, against the window before.',
    icon: Bot,
    category: 'kpi',
    Component: AutoCloseHealthWidget,
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    sources: ['autoClose'],
    requests: reads({ key: 'autoClose' }),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.campaigns',
    title: 'Active campaigns',
    description: 'Groups of related cases that share entities.',
    icon: Network,
    category: 'table',
    Component: CampaignsWidget,
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    sources: ['campaigns'],
    requests: reads({ key: 'campaigns' }),
    requires: CASES_READ,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.telemetry_gaps',
    title: 'Telemetry gaps',
    description: 'Data the detections asked for that no source sent, from query evidence.',
    icon: RadioTower,
    category: 'coverage',
    Component: TelemetryGapsWidget,
    defaultSize: { w: 8, h: 5, minW: 4, minH: 4 },
    sources: ['telemetry'],
    requests: reads({ key: 'telemetry' }),
    requires: CASES_READ,
    caseDerived: false,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'kpi.agent_quality',
    title: 'Agent quality',
    description: 'How often analysts agreed with the agent, against the weeks before.',
    icon: BadgeCheck,
    category: 'kpi',
    Component: AgentQualityWidget,
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    sources: ['agentImprovement'],
    requests: reads({ key: 'agentImprovement' }),
    requires: METRICS_VIEW,
    caseDerived: true,
    configFields: [TITLE_FIELD],
  },
];

/** The widget registry: a `type -> WidgetDef` map (read-only). */
export const WIDGET_REGISTRY: ReadonlyMap<WidgetType, WidgetDef> = new Map(DEFS.map((d) => [d.type, d]));

/** All registered widget types (stable order; powers the server allowlist mirror). */
export const WIDGET_TYPES: readonly WidgetType[] = DEFS.map((d) => d.type);

/**
 * Types whose body is still a placeholder (SPEC §4.4.1). Every Round 14 body has landed,
 * so the set is empty; the registry test keeps it that way.
 */
export const PENDING_WIDGET_TYPES: ReadonlySet<WidgetType> = new Set<WidgetType>();

/** True when `type` is a currently-registered widget. */
export function isKnownWidgetType(type: string): type is WidgetType {
  return WIDGET_REGISTRY.has(type as WidgetType);
}

/** The title a placed widget shows when the operator set none (its own, else the default). */
export function defaultWidgetTitle(def: WidgetDef, options: Record<string, unknown> | undefined): string {
  return def.titleFor?.(options) ?? def.title;
}

/** Look up a widget definition by type (undefined for an unknown/legacy type). */
export function getWidgetDef(type: string): WidgetDef | undefined {
  return WIDGET_REGISTRY.get(type as WidgetType);
}

// --------------------------------------------------------------------------- //
// RBAC and row-level scope
// --------------------------------------------------------------------------- //

/** A permit-all check (auth or RBAC off, or tests): every widget is allowed. */
export const ALLOW_ALL: PermissionCheck = () => true;

/** True when the caller may use this widget (every grant it names). */
export function canUseWidget(def: WidgetDef, can: PermissionCheck): boolean {
  if (def.requires && !can(def.requires.resource, def.requires.action)) return false;
  return (def.requiresAll ?? []).every((p) => can(p.resource, p.action));
}

/** True when the widget is hidden whole while row-level scope is on (D16). */
export function isScopeHidden(def: WidgetDef, objectScoped: boolean | undefined): boolean {
  return def.caseDerived === true && objectScoped === true;
}

/** The widget types whose figures come from case data (wholly or in part). */
export const CASE_DERIVED_WIDGET_TYPES: ReadonlySet<WidgetType> = new Set(
  DEFS.filter((d) => d.caseDerived !== false).map((d) => d.type),
);

/**
 * How many of `widgets` the viewer cannot see whole: a missing grant, or a case-derived
 * panel while row-level scope is on. For the library card's "N panels need permissions
 * your role does not have." note.
 */
export function unavailableWidgetCount(
  widgets: readonly DashboardWidget[],
  opts: { can?: PermissionCheck; objectScoped?: boolean } = {},
): number {
  const can = opts.can ?? ALLOW_ALL;
  let n = 0;
  for (const w of widgets) {
    const def = getWidgetDef(w?.type ?? '');
    if (!def) continue;
    if (!canUseWidget(def, can) || isScopeHidden(def, opts.objectScoped)) n += 1;
  }
  return n;
}

/**
 * Every request the given widgets read, gated: a widget the viewer cannot use names
 * nothing; a case-derived widget names nothing while row-level scope is on (a `'partial'`
 * widget filters its own case reads). While scope is not yet known a case-derived widget
 * still names its reads, so the board reads as loading, but the provider fetches none of
 * them until scope is known to be off. Deduplicated by the provider.
 */
export function dashboardRequestsFor(
  widgets: readonly DashboardWidget[],
  env: { can?: PermissionCheck; objectScoped: boolean | undefined; windowHours?: number },
): DashboardRequest[] {
  const full: RequestEnv = {
    can: env.can ?? ALLOW_ALL,
    objectScoped: env.objectScoped,
    windowHours: env.windowHours ?? 24,
  };
  const out: DashboardRequest[] = [];
  for (const w of widgets) {
    const def = getWidgetDef(w?.type ?? '');
    if (!def || !canUseWidget(def, full.can)) continue;
    if (def.caseDerived === true && full.objectScoped === true) continue;
    const options = (w as { options?: unknown }).options;
    out.push(...def.requests(options && typeof options === 'object' ? (options as Record<string, unknown>) : undefined, full));
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Reconcile-on-load: the anti-corruption step (§3.2)
// --------------------------------------------------------------------------- //

export interface ReconcileOptions {
  /** Permission check (defaults to permit-all so no-auth is transparent). */
  can?: PermissionCheck;
  /**
   * Widget types to APPEND at the bottom if the dashboard doesn't already have them
   * (new role-default widgets shipped after the user saved). Unknown/RBAC-denied ids
   * in this list are ignored. Appended widgets get their registry `defaultSize` and a
   * fresh instance id.
   */
  appendDefaults?: WidgetType[];
  /** Factory for a fresh widget-instance id (injectable for deterministic tests). */
  makeId?: (type: WidgetType, index: number) => string;
}

let _idSeq = 0;
function defaultMakeId(type: WidgetType): string {
  _idSeq += 1;
  return `w-${type.replace(/[^a-z0-9]+/gi, '-')}-${_idSeq}`;
}

/**
 * Reconcile a persisted widget list against the CURRENT registry (Grafana's
 * read-time schema philosophy). In order:
 *   1. DROP any instance whose `type` is no longer registered (and drop its geometry).
 *   2. RBAC-FILTER: drop instances the caller lacks the `requires` grant for.
 *   3. APPEND any `appendDefaults` types not already present (auto-packed by RGL);
 *      themselves RBAC-filtered + dropped if unknown.
 *
 * Zero-migration + forward-compatible: a stale layout never renders a hole and never
 * shows a widget the user can't access (defense-in-depth; the server also validates
 * on PUT). Pure function: no side effects beyond the injected id factory.
 */
export function reconcileWidgets(
  widgets: DashboardWidget[] | null | undefined,
  opts: ReconcileOptions = {},
): DashboardWidget[] {
  const can = opts.can ?? ALLOW_ALL;
  const makeId = opts.makeId ?? defaultMakeId;

  const kept: DashboardWidget[] = [];
  const present = new Set<WidgetType>();

  for (const w of widgets ?? []) {
    const def = getWidgetDef(w?.type ?? '');
    if (!def) continue; // (1) unknown/legacy type → drop, geometry goes with it
    if (!canUseWidget(def, can)) continue; // (2) RBAC-denied → drop
    kept.push(w);
    present.add(def.type);
  }

  // (3) append new role-default widgets not already present
  const toAppend = opts.appendDefaults ?? [];
  let idx = 0;
  for (const type of toAppend) {
    if (present.has(type)) continue;
    const def = getWidgetDef(type);
    if (!def) continue; // unknown default id → ignore
    if (!canUseWidget(def, can)) continue; // RBAC-denied default → skip
    kept.push({
      id: makeId(type, idx),
      type,
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      minW: def.defaultSize.minW,
      minH: def.defaultSize.minH,
      // x/y left at 0 → RGL's negative-gravity compaction auto-packs the new widget.
      x: 0,
      y: 0,
      options: {},
    } as DashboardWidget);
    present.add(type);
    idx += 1;
  }

  return kept;
}

// --------------------------------------------------------------------------- //
// Per-role default dashboards (§5.3, clone-to-customize on first edit)
// --------------------------------------------------------------------------- //

/**
 * Code-defined, immutable per-role default widget SETS. The builder UX (CD4) clones
 * one of these into the user's bucket on first edit. A single all-purpose dashboard
 * fails: analysts, managers, auditors and admins need different landing widgets.
 * Every role falls back to `default` when its role has no bespoke set.
 */
export const ROLE_DEFAULT_WIDGETS: Record<string, WidgetType[]> = {
  // Analysts land on "what to investigate first".
  analyst_tier1: ['kpi.needs_human', 'gauge.active_risk', 'table.recent_cases', 'chart.verdict_mix'],
  analyst_tier2: ['kpi.needs_human', 'gauge.active_risk', 'table.recent_cases', 'chart.verdict_mix'],
  responder: ['kpi.needs_human', 'table.recent_cases', 'chart.verdict_mix'],
  // Managers land on lifecycle timing + autonomy.
  soc_manager: ['kpi.lifecycle_timing', 'chart.autonomous_vs_human', 'kpi.needs_human', 'table.recent_cases'],
  // Auditors land on posture/coverage.
  auditor: ['mitre.heatmap', 'kpi.lifecycle_timing', 'chart.verdict_mix'],
  // Admins land on cost + source health.
  super_admin: ['kpi.cost_budget', 'table.connector_health', 'kpi.needs_human', 'kpi.lifecycle_timing'],
  // The universal fallback (also used when auth/RBAC is off).
  default: ['kpi.needs_human', 'gauge.active_risk', 'chart.verdict_mix', 'table.recent_cases'],
};

/** The default widget types for a role (RBAC-filtered against the caller's grants). */
export function defaultWidgetTypesForRole(
  role: string | null | undefined,
  can: PermissionCheck = ALLOW_ALL,
): WidgetType[] {
  const set = ROLE_DEFAULT_WIDGETS[role ?? 'default'] ?? ROLE_DEFAULT_WIDGETS.default;
  return set.filter((t) => {
    const def = getWidgetDef(t);
    return def ? canUseWidget(def, can) : false;
  });
}

/**
 * Build a fresh default dashboard widget list for a role, ready to seed a new/cloned
 * dashboard. Each widget gets its registry `defaultSize`; positions are left for RGL
 * compaction. Pure; reconcile is what runs on subsequent loads.
 */
export function buildDefaultWidgets(
  role: string | null | undefined,
  opts: { can?: PermissionCheck; makeId?: (type: WidgetType, index: number) => string } = {},
): DashboardWidget[] {
  const can = opts.can ?? ALLOW_ALL;
  const makeId = opts.makeId ?? defaultMakeId;
  return defaultWidgetTypesForRole(role, can).map((type, i) => {
    const def = getWidgetDef(type)!;
    return {
      id: makeId(type, i),
      type,
      x: 0,
      y: 0,
      w: def.defaultSize.w,
      h: def.defaultSize.h,
      minW: def.defaultSize.minW,
      minH: def.defaultSize.minH,
      options: {},
    } as DashboardWidget;
  });
}
