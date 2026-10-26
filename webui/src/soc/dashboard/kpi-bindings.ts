/**
 * KPI strip bindings (SPEC §4.4.3, binding). One row per strip cell: where its value
 * comes from, what it means (the help tip), and the grant that gates its display.
 *
 * This is the single client copy of the spec's binding table. The `kpi.strip` and
 * `kpi.cost_budget` widgets read it; `backend/tests/test_kpi_strip_bindings.py` pins
 * every server field named here on the Demo dataset and a fixture, so the two cannot
 * drift. Lazy-only: only dashboard widgets import it, never an entry module (§3.4).
 *
 * Honesty rules every cell follows ("W" is the board window; `all` is `window=all`):
 *
 * 1. Not measured. A value that is not a finite number (`null`, absent, or the
 *    server's dash string for "no samples"), or whose `availableField` is `false`,
 *    shows "Not measured" with the text at `reasonField` when the source names one.
 *    Never 0, never the dash itself.
 * 2. Partial. When any `partialWhen` flag matches, the value is partial: a count reads
 *    "at least N", any other figure "about N", with the flag's reason.
 * 3. Shares. A `shareField` value is shown only when it is a finite number.
 * 4. Breakdowns. A response with `partial: true` is a lower bound ("at least", with
 *    `partial_reason`). An absent group reads 0 only when `other` is `null` or
 *    `other.count` is 0; absent while `other.count > 0` means the group was cut by
 *    `top`, so the cell is Not measured. A sum over every group is a lower bound while
 *    `other.count > 0`; a keyed sum is exact only when every key is in `groups` or
 *    `other.count` is 0. A ratio shows only when both sums are exact and the
 *    denominator is above 0.
 * 5. Stage reduction. See {@link KpiStageReductionSource}.
 */
import type { BreakdownField, BreakdownStatusGroup } from '@/lib/types-dashboards';

export type KpiStripPreset = 'operations' | 'detection' | 'executive';

/** The strip a cell belongs to; `cost_budget` is the AI spend widget's per-case line. */
export type KpiBindingGroup = KpiStripPreset | 'cost_budget';

const POSTURE = 'GET /api/metrics/posture';
const BREAKDOWN = 'GET /api/metrics/breakdown';
const NOISE = 'GET /api/metrics/noise-reduction';
const SHIFT = 'GET /api/standup/report';
const SOURCES_HEALTH = 'GET /api/sources/health';
const MITRE_COVERAGE = 'GET /api/mitre/coverage';
const AUTO_CLOSE = 'GET /api/metrics/auto-close-health/recorded?anchor=first';

/**
 * The provider keys of `DashboardDataProvider` a cell reads (all non-billing, #6).
 * `coverage` is the WINDOWED technique coverage, `GET /api/mitre/coverage` with the
 * board window; the existing `mitre` key reads the same endpoint over all time for the
 * heatmap, and neither is the sources coverage rollup (`GET /api/sources/coverage`).
 */
export type KpiProviderKey =
  | 'posture'
  | 'breakdown'
  | 'shift'
  | 'sourcesHealth'
  | 'noise'
  | 'coverage'
  | 'autoClose';

/** The one endpoint each provider key reads (windowed ones take the board window). */
export const KPI_PROVIDER_ENDPOINTS: Readonly<Record<KpiProviderKey, string>> = {
  posture: POSTURE,
  breakdown: BREAKDOWN,
  shift: SHIFT,
  sourcesHealth: SOURCES_HEALTH,
  noise: NOISE,
  coverage: MITRE_COVERAGE,
  autoClose: AUTO_CLOSE,
};

/** The grant that gates a cell; a denied cell shows "No access". */
export interface KpiGrant {
  resource: string;
  action: string;
}

/** Which window a cell reads: the board's, or `all` for a stock measured now. */
export type KpiWindow = 'board' | 'all';

/** A boolean in a response that qualifies a cell's value (rule 2). */
export interface KpiFlag {
  /** Dotted path of the boolean, for example `window_covered`. */
  field: string;
  /** The value of `field` that marks the condition. */
  when: boolean;
  /** Dotted path of the reason shown beside the value, when the source names one. */
  reasonField?: string;
}

/** A dotted field of one endpoint's response. */
export interface KpiFieldSource {
  type: 'field';
  endpoint: string;
  /** Dotted path in the response, for example `open_now.count`. */
  field: string;
  /** The reason shown with "Not measured" (rule 1). */
  reasonField?: string;
  /** A boolean that is `false` when the source did not measure the value (rule 1). */
  availableField?: string;
  /** Flags that make the value partial (rule 2). */
  partialWhen?: readonly KpiFlag[];
  /** A share shown beside the value, only when it is a finite number (rule 3). */
  shareField?: string;
}

/** One group of a `GET /api/metrics/breakdown` response (rule 4). */
export interface KpiBreakdownGroupSource {
  type: 'breakdown_group';
  /** `top` (1 to 50, default 10) is set wherever the group could otherwise be cut. */
  query: { by: BreakdownField; status_group?: BreakdownStatusGroup; window: KpiWindow; top?: number };
  /** The group key; `null` is the empty group (the unassigned cases). */
  group: string | null;
  metric: 'count';
}

/** The sum of one metric over every group (only for a single-valued `by`; rule 4). */
export interface KpiBreakdownSumSource {
  type: 'breakdown_sum';
  query: { kind?: 'cases' | 'usage'; by: BreakdownField; window: KpiWindow; top?: number };
  metric: 'analyst_tp' | 'verdicted' | 'cost_usd';
  /** Only these group keys are summed; absent means every group. */
  keys?: readonly string[];
}

/** Rows of `GET /api/sources/health` counted by a rule. */
export interface KpiSourcesHealthSource {
  type: 'sources_health';
  endpoint: typeof SOURCES_HEALTH;
  /** `reporting`: enabled rows whose last event is inside W; `silent`: enabled rows flagged silent. */
  count: 'reporting' | 'silent';
}

/** A ratio of two sources (spend per investigated case; rule 4). */
export interface KpiRatioSource {
  type: 'ratio';
  numerator: KpiBreakdownSumSource;
  denominator: KpiBreakdownSumSource;
}

/**
 * Alert reduction from the noise-reduction stages, as a percentage:
 * `(1 - stages[key=numerator].total / stages[key=denominator].total) * 100`. The
 * Overview's rule (`alertReductionOf` in `components/NoiseFunnel.tsx`), so the two
 * always agree; withheld as Not measured, with the reason, unless `counters.available`
 * is true and `counters.incomplete` false ("partial coverage"), `cases_meta.truncated`
 * is false, at least one alert was ingested and cases do not outnumber alerts. A real
 * but tiny reduction reads "<1%", never 0%. Never `reduction.overall_pct`, which is
 * "never reached a person", a different figure.
 */
export interface KpiStageReductionSource {
  type: 'stage_reduction';
  endpoint: typeof NOISE;
  numerator: 'cases';
  denominator: 'ingested';
}

export type KpiCellSource =
  | KpiFieldSource
  | KpiBreakdownGroupSource
  | KpiBreakdownSumSource
  | KpiSourcesHealthSource
  | KpiRatioSource
  | KpiStageReductionSource;

export type KpiFormat = 'count' | 'rate' | 'percent' | 'minutes' | 'usd';

export interface KpiStripBinding {
  group: KpiBindingGroup;
  /** Stable cell id within its group. */
  cell: string;
  /** The cell label (sentence case). */
  label: string;
  /** The definition shown in the cell's help tip (plain words). */
  definition: string;
  provider: KpiProviderKey;
  window: KpiWindow;
  source: KpiCellSource;
  format: KpiFormat;
  grant: KpiGrant;
  /** Case-derived cells are hidden while row-level data scope is on (D16). */
  caseDerived: boolean;
}

const METRICS_VIEW: KpiGrant = { resource: 'metrics', action: 'view' };
const CASES_READ: KpiGrant = { resource: 'cases', action: 'read' };
const SOURCES_READ: KpiGrant = { resource: 'sources', action: 'read' };
const COST_VIEW: KpiGrant = { resource: 'cost', action: 'view' };

/** A windowed posture figure is partial when the fetched rows did not cover W. */
const POSTURE_WINDOW_PARTIAL: readonly KpiFlag[] = [
  { field: 'window_covered', when: false, reasonField: 'window_coverage_reason' },
];
/** The durable alert counters cover only part of W (the Overview's "Partial coverage"). */
const COUNTERS_PARTIAL: readonly KpiFlag[] = [{ field: 'counters.incomplete', when: true }];

/**
 * Investigation spend: the surfaces the investigation pipeline's router and
 * investigator calls carry (`Case.source_surface`). WP-A2 confirms these against the
 * gateway's actual values in `test_kpi_strip_bindings.py`; chat, standup and report
 * spend are never counted.
 */
export const INVESTIGATION_USAGE_SURFACES: readonly string[] = ['investigate', 'automated_scan'];

export const KPI_STRIP_BINDINGS: readonly KpiStripBinding[] = [
  // ---- operations ------------------------------------------------------ //
  {
    group: 'operations',
    cell: 'open_now',
    label: 'Open now',
    definition: 'Cases not closed or resolved right now.',
    provider: 'posture',
    window: 'all',
    source: {
      type: 'field',
      endpoint: POSTURE,
      field: 'open_now.count',
      reasonField: 'open_now.reason',
      // A truncated fetch makes the stock a lower bound; a failed one is no measurement.
      partialWhen: [{ field: 'open_now.complete', when: false, reasonField: 'open_now.reason' }],
    },
    format: 'count',
    grant: CASES_READ,
    caseDerived: true,
  },
  {
    group: 'operations',
    cell: 'awaiting_decision',
    label: 'Awaiting a decision',
    definition: 'Open cases whose AI verdict is Needs human.',
    provider: 'breakdown',
    window: 'all',
    source: {
      type: 'breakdown_group',
      query: { by: 'verdict', status_group: 'open', window: 'all' },
      group: 'NEEDS_HUMAN',
      metric: 'count',
    },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'operations',
    cell: 'unassigned',
    label: 'Unassigned',
    definition: 'Open cases with no assignee.',
    provider: 'breakdown',
    window: 'all',
    source: {
      type: 'breakdown_group',
      // Fifty groups, so the unassigned group is not cut by the default ten when many
      // analysts each hold more open cases (rule 4 still covers a cut beyond fifty).
      query: { by: 'assignee', status_group: 'open', window: 'all', top: 50 },
      group: null,
      metric: 'count',
    },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'operations',
    cell: 'sla_breached',
    label: 'SLA breached',
    definition: 'Open cases past their response or resolve target.',
    provider: 'shift',
    window: 'all',
    // With no SLA policy turned on the server reports 0 breached; that is not a measurement.
    source: { type: 'field', endpoint: SHIFT, field: 'sla_aging.totals.breached', availableField: 'sla_aging.enabled' },
    format: 'count',
    grant: CASES_READ,
    caseDerived: true,
  },
  {
    group: 'operations',
    cell: 'new_cases',
    label: 'New cases',
    definition: 'Cases created in the window.',
    provider: 'posture',
    window: 'board',
    source: { type: 'field', endpoint: POSTURE, field: 'case_count', partialWhen: POSTURE_WINDOW_PARTIAL },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'operations',
    cell: 'closed',
    label: 'Closed',
    definition: 'Cases created in the window that are now closed or resolved.',
    provider: 'posture',
    window: 'board',
    source: {
      type: 'field',
      endpoint: POSTURE,
      field: 'quality.terminal_cases',
      partialWhen: POSTURE_WINDOW_PARTIAL,
    },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  // ---- detection ------------------------------------------------------- //
  {
    group: 'detection',
    cell: 'sources_reporting',
    label: 'Sources reporting',
    definition: 'Enabled sources that sent at least one event in the window.',
    provider: 'sourcesHealth',
    window: 'board',
    source: { type: 'sources_health', endpoint: SOURCES_HEALTH, count: 'reporting' },
    format: 'count',
    grant: SOURCES_READ,
    caseDerived: false,
  },
  {
    group: 'detection',
    cell: 'silent_sources',
    label: 'Silent sources',
    definition: 'Enabled sources the silent-source detector flags.',
    provider: 'sourcesHealth',
    window: 'all',
    source: { type: 'sources_health', endpoint: SOURCES_HEALTH, count: 'silent' },
    format: 'count',
    grant: SOURCES_READ,
    caseDerived: false,
  },
  {
    group: 'detection',
    cell: 'events_per_minute',
    label: 'Events per minute',
    definition: "Mean events per minute over the window, from the poller's tallies.",
    provider: 'noise',
    window: 'board',
    // New server field (WP-A2): the ingested-stage total divided by the minutes the
    // counters covered inside W, `null` while the counters are unavailable.
    source: {
      type: 'field',
      endpoint: NOISE,
      field: 'events_per_min',
      availableField: 'counters.available',
      partialWhen: COUNTERS_PARTIAL,
    },
    format: 'rate',
    grant: METRICS_VIEW,
    caseDerived: false,
  },
  {
    group: 'detection',
    cell: 'alerts_ingested',
    label: 'Alerts ingested',
    definition: 'Raw alerts counted in the window.',
    provider: 'noise',
    window: 'board',
    source: {
      type: 'field',
      endpoint: NOISE,
      field: 'stages[key=ingested].total',
      availableField: 'counters.available',
      partialWhen: COUNTERS_PARTIAL,
    },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: false,
  },
  {
    group: 'detection',
    cell: 'alert_reduction',
    label: 'Alert reduction',
    definition: 'Share of raw alerts that did not become a case.',
    provider: 'noise',
    window: 'board',
    source: { type: 'stage_reduction', endpoint: NOISE, numerator: 'cases', denominator: 'ingested' },
    format: 'percent',
    grant: METRICS_VIEW,
    // The numerator is the case tally, so row-level scope hides it like any case figure.
    caseDerived: true,
  },
  {
    group: 'detection',
    cell: 'techniques_seen',
    label: 'Techniques seen',
    definition: 'ATT&CK techniques on at least one case in the window.',
    provider: 'coverage',
    window: 'board',
    source: {
      type: 'field',
      endpoint: MITRE_COVERAGE,
      field: 'covered_techniques',
      partialWhen: [{ field: 'truncated', when: true }],
    },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  // ---- executive ------------------------------------------------------- //
  {
    group: 'executive',
    cell: 'cases',
    label: 'Cases',
    definition: 'Cases created in the window.',
    provider: 'posture',
    window: 'board',
    source: { type: 'field', endpoint: POSTURE, field: 'case_count', partialWhen: POSTURE_WINDOW_PARTIAL },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'executive',
    cell: 'confirmed_threats',
    label: 'Confirmed threats',
    definition:
      'Cases an analyst confirmed as true positives. Closes by an analyst policy are left out, and the AI verdict is never used.',
    provider: 'breakdown',
    window: 'board',
    source: { type: 'breakdown_sum', query: { by: 'severity', window: 'board' }, metric: 'analyst_tp' },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'executive',
    cell: 'mttd_p50',
    label: 'MTTD p50',
    definition: 'Median time from the first event to case creation.',
    provider: 'posture',
    window: 'board',
    source: {
      type: 'field',
      endpoint: POSTURE,
      field: 'lifecycle.mttd_minutes.p50',
      reasonField: 'lifecycle.mttd_minutes.reason',
      availableField: 'lifecycle.mttd_minutes.available',
      partialWhen: POSTURE_WINDOW_PARTIAL,
    },
    format: 'minutes',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'executive',
    cell: 'mttr_p50',
    label: 'MTTR p50',
    definition: 'Median time from case creation to resolution.',
    provider: 'posture',
    window: 'board',
    source: {
      type: 'field',
      endpoint: POSTURE,
      field: 'lifecycle.mttr_minutes.p50',
      reasonField: 'lifecycle.mttr_minutes.reason',
      availableField: 'lifecycle.mttr_minutes.available',
      partialWhen: POSTURE_WINDOW_PARTIAL,
    },
    format: 'minutes',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'executive',
    cell: 'closed_by_agent',
    label: 'Closed by the AI agent',
    definition:
      "Cases whose first terminal decision was the agent's automatic close. A later human acknowledgement does not move it.",
    provider: 'autoClose',
    window: 'board',
    source: {
      type: 'field',
      endpoint: AUTO_CLOSE,
      field: 'current.auto_closed',
      shareField: 'current.rate',
      reasonField: 'current.reason',
      // False when no case (or too few) was decided in W: never "0 closed by the agent".
      availableField: 'current.available',
    },
    format: 'count',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  {
    group: 'executive',
    cell: 'sla_attainment',
    label: 'SLA attainment',
    definition:
      'Share of scored cases that met their targets. Not measured, with the reason, when nothing was scored.',
    provider: 'posture',
    window: 'board',
    source: {
      type: 'field',
      endpoint: POSTURE,
      field: 'sla.attainment_pct',
      reasonField: 'sla.attainment_reason',
      partialWhen: POSTURE_WINDOW_PARTIAL,
    },
    format: 'percent',
    grant: METRICS_VIEW,
    caseDerived: true,
  },
  // ---- AI spend widget: spend per investigated case --------------------- //
  {
    group: 'cost_budget',
    cell: 'spend_per_case',
    label: 'Spend per case',
    definition:
      'Investigation spend divided by the cases the agent investigated in the window. Chat, standup and report spend are left out.',
    provider: 'breakdown',
    window: 'board',
    source: {
      type: 'ratio',
      numerator: {
        type: 'breakdown_sum',
        query: { kind: 'usage', by: 'surface', window: 'board', top: 50 },
        metric: 'cost_usd',
        keys: INVESTIGATION_USAGE_SURFACES,
      },
      denominator: {
        type: 'breakdown_sum',
        query: { by: 'severity', window: 'board' },
        metric: 'verdicted',
      },
    },
    format: 'usd',
    grant: COST_VIEW,
    caseDerived: true,
  },
];

/** The cells of one strip, in display order. */
export function kpiStripCells(group: KpiBindingGroup): KpiStripBinding[] {
  return KPI_STRIP_BINDINGS.filter((binding) => binding.group === group);
}
