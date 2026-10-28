/**
 * Custom-dashboard WIDGET REGISTRY (Round 5 / G7, CD1).
 *
 * The registry SEPARATES "what a widget IS" (code-defined here — component, default
 * size, config schema, RBAC) from "where it SITS" (per-user layout data persisted in
 * `UserPrefs.dashboards`). This is Grafana's panel-type/gridPos split: a stale user
 * layout must never break when a widget is renamed or removed.
 *
 * KEY PROPERTIES
 *   - `WidgetType` is a compile-time string enum. Layouts reference a widget by this
 *     id. An unknown/legacy id is DROPPED by {@link reconcileWidgets} at load time.
 *   - Each `Component` is `React.lazy`, so a dashboard only pulls the code for the
 *     widgets it actually renders (bundle discipline — the RGL EDIT surface is the
 *     only heavy import and it is lazy-loaded edit-mode only, elsewhere).
 *   - Widget bodies REUSE existing primitives (`KpiTile` / `BarList` /
 *     `charts.tsx` / `DataTable` / `MitreHeatmap` / `RiskGauge`) — no new charting dep.
 *   - `requires` optionally gates a widget behind a `resource:action` grant (the same
 *     matrix `<Can>` uses). {@link reconcileWidgets} RBAC-filters on load; the server
 *     also validates the widget-type allowlist on PUT (defense-in-depth, #9).
 *
 * NON-NEGOTIABLES: a dashboard layout is ADVISORY presentation only — it NEVER feeds
 * `case_manager.decide()` (#3). Widget `title`s / labels are UNTRUSTED → the widget
 * bodies render them as plain text / SVG `<text>`, never `dangerouslySetInnerHTML` (#9).
 * The read-only default stays calm (#10); breadth degrades gracefully (#11).
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  UserCheck,
  CircleDollarSign,
  BarChart3,
  Bot,
  Timer,
  Plug,
  ListChecks,
  Crosshair,
  Gauge,
  AlarmClock,
  BadgeCheck,
  ChartArea,
  Filter,
  Hourglass,
  LayoutDashboard,
  ListOrdered,
  ListTodo,
  Megaphone,
  Network,
  RadioTower,
  TrendingUp,
  Users,
} from 'lucide-react';

import type { DashboardWidget } from '@/lib/types';
import type { WidgetProps } from './widgets/common';
import type { DashboardSourceKey } from './DashboardDataProvider';

// --------------------------------------------------------------------------- //
// Widget type enum
// --------------------------------------------------------------------------- //

/**
 * The curated, SOC-relevant widget set (MVP). Adding a widget = one `WidgetType`
 * value + one registry entry + one lazy body. A layout referencing an id NOT in this
 * union is dropped on load (reconcile-on-load).
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

/** A declarative config field → rendered in the per-widget config Sheet (CD4). */
export interface WidgetConfigField {
  /** Option key written into `DashboardWidget.options`. */
  key: string;
  /** Field label (plain text). */
  label: string;
  /** Control kind — MVP supports a plain-text title + a select. */
  kind: 'text' | 'select';
  /** For `select`: the choices. */
  choices?: { value: string; label: string }[];
  /** Placeholder / helper (plain text). */
  placeholder?: string;
}

export interface WidgetDef {
  type: WidgetType;
  /** Default title (operator can override; PLAIN text #9). */
  title: string;
  /** One-line gallery description (plain text). */
  description: string;
  /** Gallery + toolbar icon. */
  icon: LucideIcon;
  /** Coarse category for the gallery filter. */
  category: 'kpi' | 'chart' | 'table' | 'coverage';
  /** Lazy body — a dashboard only pulls the code for widgets it renders. */
  Component: React.LazyExoticComponent<React.ComponentType<WidgetProps>>;
  /** Default grid size + minimums (react-grid-layout units). */
  defaultSize: { w: number; h: number; minW: number; minH: number };
  /** Which shared data sources this widget reads (drives fetch pre-warm). */
  sources: DashboardSourceKey[];
  /** Optional RBAC gate; when set the widget shows/persists only for grant-holders. */
  requires?: WidgetPermission;
  /** Declarative config fields (rendered in the config Sheet, CD4). */
  configFields?: WidgetConfigField[];
}

// --------------------------------------------------------------------------- //
// Lazy widget components — each body reuses an existing primitive.
// --------------------------------------------------------------------------- //
// One dynamic import per body file, selecting the named export. React.lazy needs a
// default export, so we adapt named exports with `.then(m => ({ default: m.X }))`.

const NeedsHumanQueueWidget = React.lazy(() =>
  import('./widgets/kpi').then((m) => ({ default: m.NeedsHumanQueueWidget })),
);
const CostBudgetWidget = React.lazy(() =>
  import('./widgets/kpi').then((m) => ({ default: m.CostBudgetWidget })),
);
const OpenBySeverityWidget = React.lazy(() =>
  import('./widgets/mix').then((m) => ({ default: m.OpenBySeverityWidget })),
);
const AutonomousVsHumanWidget = React.lazy(() =>
  import('./widgets/mix').then((m) => ({ default: m.AutonomousVsHumanWidget })),
);
const LifecycleTimingWidget = React.lazy(() =>
  import('./widgets/lifecycle').then((m) => ({ default: m.LifecycleTimingWidget })),
);
const ConnectorHealthWidget = React.lazy(() =>
  import('./widgets/tables').then((m) => ({ default: m.ConnectorHealthWidget })),
);
const RecentCasesWidget = React.lazy(() =>
  import('./widgets/tables').then((m) => ({ default: m.RecentCasesWidget })),
);
const MitreHeatmapWidget = React.lazy(() =>
  import('./widgets/mitre').then((m) => ({ default: m.MitreHeatmapWidget })),
);
const RiskGaugeWidget = React.lazy(() =>
  import('./widgets/risk').then((m) => ({ default: m.RiskGaugeWidget })),
);

// A single reusable "title override" config field — every widget accepts one.
const TITLE_FIELD: WidgetConfigField = {
  key: 'title',
  label: 'Title',
  kind: 'text',
  placeholder: 'Override the widget title (plain text)',
};

// --------------------------------------------------------------------------- //
// Round 14 stub bodies (SPEC §4.4.1). Every new widget type is registered now so the
// client union, this registry and the server allowlist move together with the
// contract file; until WP-W4c replaces each stub with its real lazy body, a stub reads
// nothing and renders the shared "Not available yet" state inside the standard frame.
// --------------------------------------------------------------------------- //
const PendingWidget = React.lazy(async () => {
  const [{ WidgetShell }, { EmptyState }] = await Promise.all([
    import('./widgets/common'),
    import('@/soc/components/EmptyState'),
  ]);
  function PendingWidgetBody({ title }: WidgetProps) {
    return React.createElement(WidgetShell, {
      title: title || 'Widget',
      icon: Hourglass,
      emptyMessage: React.createElement(EmptyState, {
        state: 'unavailable',
        title: 'Not available yet',
        compact: true,
      }),
      children: null,
    });
  }
  return { default: PendingWidgetBody };
});

const METRICS_VIEW: WidgetPermission = { resource: 'metrics', action: 'view' };
const CASES_READ: WidgetPermission = { resource: 'cases', action: 'read' };

/**
 * A "Rows" select over whole-number choices. `fallback` is the number of rows the body
 * shows while the option is not set (SPEC §4.4.3 names it per widget), so the sheet
 * states it rather than leaving an empty select unexplained.
 */
const ROWS_FIELD = (key: 'top' | 'limit', choices: number[], fallback: number): WidgetConfigField => ({
  key,
  label: 'Rows',
  kind: 'select',
  choices: choices.map((n) => ({ value: String(n), label: String(n) })),
  placeholder: `Default ${fallback}`,
});

const TOP_FIELD = (choices: number[]): WidgetConfigField => ROWS_FIELD('top', choices, 10);

// --------------------------------------------------------------------------- //
// The registry
// --------------------------------------------------------------------------- //

const DEFS: WidgetDef[] = [
  {
    type: 'kpi.needs_human',
    title: 'Needs-human queue',
    description: 'How many cases are awaiting a human decision.',
    icon: UserCheck,
    category: 'kpi',
    Component: NeedsHumanQueueWidget,
    defaultSize: { w: 3, h: 3, minW: 2, minH: 2 },
    sources: ['metrics'],
    requires: { resource: 'cases', action: 'read' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'kpi.cost_budget',
    title: 'LLM cost (window)',
    description: 'LLM spend and call volume in the active window.',
    icon: CircleDollarSign,
    category: 'kpi',
    Component: CostBudgetWidget,
    defaultSize: { w: 3, h: 3, minW: 2, minH: 2 },
    sources: ['metrics'],
    // The canonical cost grant is `cost:view` (rbac/policy.py). `cost:read` is not a
    // real action, so it can NEVER be granted (custom roles strip it) — the widget
    // would be permanently hidden/dropped for every non-super_admin role that in fact
    // holds `cost:view`. Pin to the real action.
    requires: { resource: 'cost', action: 'view' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'chart.verdict_mix',
    title: 'Cases by verdict',
    description: 'A ranked breakdown of cases by verdict class.',
    icon: BarChart3,
    category: 'chart',
    Component: OpenBySeverityWidget,
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    sources: ['metrics'],
    requires: { resource: 'cases', action: 'read' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'chart.autonomous_vs_human',
    title: 'Autonomous vs human',
    description: 'The split of auto-resolved vs human-handled cases.',
    icon: Bot,
    category: 'chart',
    Component: AutonomousVsHumanWidget,
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    sources: ['posture'],
    requires: { resource: 'metrics', action: 'view' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'kpi.lifecycle_timing',
    title: 'Response timing (p50)',
    description: 'MTTA, MTTR and dwell (median) from the server rollup.',
    icon: Timer,
    category: 'kpi',
    Component: LifecycleTimingWidget,
    defaultSize: { w: 6, h: 3, minW: 4, minH: 3 },
    sources: ['posture'],
    requires: { resource: 'metrics', action: 'view' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.connector_health',
    title: 'Connector health',
    description: 'Per-source enabled state, kind and last poll / buffer depth.',
    icon: Plug,
    category: 'table',
    Component: ConnectorHealthWidget,
    defaultSize: { w: 5, h: 5, minW: 4, minH: 3 },
    sources: ['sourcesHealth'],
    requires: { resource: 'sources', action: 'read' },
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
    requires: { resource: 'cases', action: 'read' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'mitre.heatmap',
    title: 'MITRE ATT&CK coverage',
    description: 'Tactic × technique coverage across all cases.',
    icon: Crosshair,
    category: 'coverage',
    Component: MitreHeatmapWidget,
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    sources: ['mitre'],
    requires: { resource: 'metrics', action: 'view' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'gauge.active_risk',
    title: 'Active risk index',
    description: 'The mean case risk score as a gauge.',
    icon: Gauge,
    category: 'kpi',
    Component: RiskGaugeWidget,
    defaultSize: { w: 3, h: 4, minW: 2, minH: 3 },
    sources: ['metrics'],
    requires: { resource: 'cases', action: 'read' },
    configFields: [TITLE_FIELD],
  },
  // ---- Round 14 stubs (SPEC §4.4.3; WP-W4c replaces each Component) ---- //
  {
    type: 'kpi.strip',
    title: 'KPI strip',
    description: 'Six headline figures for operations, detection or executive reporting.',
    icon: LayoutDashboard,
    category: 'kpi',
    Component: PendingWidget,
    defaultSize: { w: 12, h: 2, minW: 6, minH: 2 },
    // A stub reads nothing. WP-W4c's body reads: posture, breakdown, shift, sourcesHealth, noise, coverage, autoClose.
    sources: [],
    // No widget-level grant: each cell has its own and a denied cell shows "No access".
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
    description: 'Arrivals and closures, alerts and cases, or outcomes per day.',
    icon: TrendingUp,
    category: 'chart',
    Component: PendingWidget,
    defaultSize: { w: 8, h: 5, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: trends.
    sources: [],
    requires: METRICS_VIEW,
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
    ],
  },
  {
    type: 'chart.case_breakdown',
    title: 'Case breakdown',
    description: 'Cases in the window broken down by one field, as ranked bars.',
    icon: BarChart3,
    category: 'chart',
    Component: PendingWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: metrics, breakdown.
    sources: [],
    requires: METRICS_VIEW,
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
      TOP_FIELD([5, 10]),
    ],
  },
  {
    type: 'chart.severity_trend',
    title: 'Cases by severity over time',
    description: 'Daily or weekly case counts stacked by severity level.',
    icon: ChartArea,
    category: 'chart',
    Component: PendingWidget,
    defaultSize: { w: 8, h: 5, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: breakdown.
    sources: [],
    requires: METRICS_VIEW,
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
      },
    ],
  },
  {
    type: 'chart.backlog_aging',
    title: 'Backlog aging',
    description: 'Open cases by how long they have been open.',
    icon: Hourglass,
    category: 'chart',
    Component: PendingWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: posture.
    sources: [],
    requires: CASES_READ,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'chart.noise_funnel',
    title: 'Noise reduction',
    description: 'Raw alerts reduced to cases and outcomes over the window.',
    icon: Filter,
    category: 'chart',
    Component: PendingWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: noise.
    sources: [],
    requires: METRICS_VIEW,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.attention_queue',
    title: 'Needs attention now',
    description: 'Open cases ranked by breached targets, then by urgency.',
    icon: ListTodo,
    category: 'table',
    Component: PendingWidget,
    defaultSize: { w: 8, h: 6, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: shift.
    sources: [],
    requires: CASES_READ,
    configFields: [TITLE_FIELD, ROWS_FIELD('limit', [5, 8, 10], 8)],
  },
  {
    type: 'table.workload',
    title: 'Analyst workload',
    description: 'Open cases per analyst, with the unassigned queue.',
    icon: Users,
    category: 'table',
    Component: PendingWidget,
    defaultSize: { w: 4, h: 6, minW: 3, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: shift.
    sources: [],
    requires: CASES_READ,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.sla_breaches',
    title: 'SLA breaches and at risk',
    description: 'Open cases past or near their response and resolve targets.',
    icon: AlarmClock,
    category: 'table',
    Component: PendingWidget,
    defaultSize: { w: 4, h: 5, minW: 3, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: posture.
    sources: [],
    requires: CASES_READ,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.top_rules',
    title: 'Top detection rules',
    description: 'The rules behind the most cases in the window.',
    icon: ListOrdered,
    category: 'table',
    Component: PendingWidget,
    defaultSize: { w: 6, h: 6, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: breakdown.
    sources: [],
    requires: METRICS_VIEW,
    configFields: [TITLE_FIELD, TOP_FIELD([5, 10])],
  },
  {
    type: 'table.noisy_rules',
    title: 'Noisiest rules',
    description: 'Rules with the highest false-positive load and their tuning state.',
    icon: Megaphone,
    category: 'table',
    Component: PendingWidget,
    defaultSize: { w: 6, h: 6, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: tuning.
    sources: [],
    requires: { resource: 'automation', action: 'read' },
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.top_techniques',
    title: 'Top techniques',
    description: 'The ATT&CK techniques seen on the most cases.',
    icon: Crosshair,
    category: 'coverage',
    Component: PendingWidget,
    defaultSize: { w: 4, h: 6, minW: 3, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: mitre.
    sources: [],
    requires: METRICS_VIEW,
    configFields: [TITLE_FIELD, TOP_FIELD([5, 10])],
  },
  {
    type: 'kpi.auto_close_health',
    title: 'Auto-close health',
    description: 'How many cases the agent closed on its first decision, and whether that holds.',
    icon: Bot,
    category: 'kpi',
    Component: PendingWidget,
    defaultSize: { w: 4, h: 4, minW: 3, minH: 3 },
    // A stub reads nothing. WP-W4c's body reads: autoClose.
    sources: [],
    requires: METRICS_VIEW,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.campaigns',
    title: 'Active campaigns',
    description: 'Groups of related cases that share entities.',
    icon: Network,
    category: 'table',
    Component: PendingWidget,
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: campaigns.
    sources: [],
    requires: CASES_READ,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'table.telemetry_gaps',
    title: 'Telemetry gaps',
    description: 'Data the detections need that no source is sending.',
    icon: RadioTower,
    category: 'coverage',
    Component: PendingWidget,
    defaultSize: { w: 8, h: 5, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: telemetry.
    sources: [],
    requires: CASES_READ,
    configFields: [TITLE_FIELD],
  },
  {
    type: 'kpi.agent_quality',
    title: 'Agent quality',
    description: 'How often analysts agreed with the agent, against the previous weeks.',
    icon: BadgeCheck,
    category: 'kpi',
    Component: PendingWidget,
    defaultSize: { w: 6, h: 5, minW: 4, minH: 4 },
    // A stub reads nothing. WP-W4c's body reads: agentImprovement.
    sources: [],
    requires: METRICS_VIEW,
    configFields: [TITLE_FIELD],
  },
];

/** The widget registry — a `type → WidgetDef` map (read-only). */
export const WIDGET_REGISTRY: ReadonlyMap<WidgetType, WidgetDef> = new Map(
  DEFS.map((d) => [d.type, d]),
);

/** All registered widget types (stable order — powers the server allowlist mirror). */
export const WIDGET_TYPES: readonly WidgetType[] = DEFS.map((d) => d.type);

/**
 * The Round 14 types whose body is still the shared "Not available yet" stub (SPEC
 * §4.4.1). A stub reads no data source; every other widget reads at least one. Derived
 * from the registry, so replacing a stub's `Component` with its real body (WP-W4c)
 * takes the type out of this set without a second list to keep in step.
 */
export const PENDING_WIDGET_TYPES: ReadonlySet<WidgetType> = new Set(
  DEFS.filter((d) => d.Component === PendingWidget).map((d) => d.type),
);

/** True when `type` is a currently-registered widget. */
export function isKnownWidgetType(type: string): type is WidgetType {
  return WIDGET_REGISTRY.has(type as WidgetType);
}

/** Look up a widget definition by type (undefined for an unknown/legacy type). */
export function getWidgetDef(type: string): WidgetDef | undefined {
  return WIDGET_REGISTRY.get(type as WidgetType);
}

// --------------------------------------------------------------------------- //
// RBAC helper
// --------------------------------------------------------------------------- //

/** `(resource, action) => boolean` — pass `useAuth().hasPermission`. */
export type PermissionCheck = (resource: string, action: string) => boolean;

/** A permit-all check (auth/RBAC off, or tests) — every widget is allowed. */
export const ALLOW_ALL: PermissionCheck = () => true;

/** True when the caller may use this widget (no `requires` = always allowed). */
export function canUseWidget(def: WidgetDef, can: PermissionCheck): boolean {
  if (!def.requires) return true;
  return can(def.requires.resource, def.requires.action);
}

// --------------------------------------------------------------------------- //
// Reconcile-on-load — the anti-corruption step (§3.2)
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
 *   3. APPEND any `appendDefaults` types not already present (auto-packed by RGL) —
 *      themselves RBAC-filtered + dropped if unknown.
 *
 * Zero-migration + forward-compatible: a stale layout never renders a hole and never
 * shows a widget the user can't access (defense-in-depth; the server also validates
 * on PUT). Pure function — no side effects beyond the injected id factory.
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
// Per-role default dashboards (§5.3 — clone-to-customize on first edit)
// --------------------------------------------------------------------------- //

/**
 * Code-defined, immutable per-role default widget SETS. The builder UX (CD4) clones
 * one of these into the user's bucket on first edit. A single all-purpose dashboard
 * fails — analysts, managers, auditors and admins need different landing widgets.
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
 * compaction. Pure — reconcile is what runs on subsequent loads.
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
