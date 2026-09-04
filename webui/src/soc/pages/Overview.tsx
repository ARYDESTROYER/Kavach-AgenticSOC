/**
 * Overview — the Cyber Defence Center (default landing surface).
 *
 * A dense command-center dashboard adapted from the operator-provided Stitch concept:
 *
 *   ┌ MASTHEAD ─── a PLAIN, dense <PageHeader> (no card / no glow — the big title sits
 *   │             flush on the page background, like the Sources page) carrying the
 *   │             <TimeRangePicker> + auto-refresh + a manual refresh pulse in its actions.
 *   ├ KPI STRIP ── five borderless, SERVER-FED telemetry cells separated by hairlines:
 *   │             Total Cases · Total Critical · Open Cases · False Positive Rate ·
 *   │             Resolved / Closed. Four are cohort numbers scoped to the selected
 *   │             window; "Open Cases" is a window-EXEMPT stock and says so, so it is
 *   │             never read as a fifth summand. Each cell DISCLOSES its own drill-down
 *   │             panel below the strip (see "Drill-down" further down).
 *   ├ INSTRUMENT ── one integrated 12-column band: the Human-vs-AI close-attribution
 *   │             instrument, resolved/open donut snapshots, and the latest-case queue.
 *   ├ OPERATIONS ── the Noise-Reduction flow plus a compact burndown/timing rail.
 *   └ DEEPER ───── a COLLAPSED "Deeper analytics" group folding the secondary bands
 *                  (spend tripwire, full response timing, autonomy split, connectors,
 *                  case-volume, workload, top signatures/entities).
 *
 * Data: `usePosture(hours, 'prev')` is the AUTHORITATIVE server-side lifecycle rollup
 * (MTTA/MTTR/dwell/MTTD p50 + SLA + quality rates + period-over-period deltas). It is
 * STALE-WHILE-REVALIDATE: a window change keeps the last successful snapshot mounted
 * (marked by the tiles' "Loading Nh" sub) instead of blanking every posture consumer.
 * `listCases` (current + previous window), `getMetrics` (burndown + timing_trend +
 * by_status), `usageSummary`, `noiseReduction`, and `metricsTrends` (the hover-trend
 * bucket series) are fetched with allSettled so one failing call degrades a single
 * widget, never the page; a superseded window's late-settling batch is discarded.
 * Usage and Noise Reduction keep independent availability/error state: a failed refresh
 * retains the last usable value, names the unavailable slice, and offers a slice-only
 * Retry. `noiseReduction`/`sourcesCoverage`/`metricsTrends` are typeof-guarded so a
 * minimal test/mock surface can still omit the optional contracts.
 *
 * Drill-down: every strip tile is a WAI DISCLOSURE trigger. Activating one opens a
 * docked, non-modal `<section>` under the strip — a sibling of the grid, never a sixth
 * child of it — carrying that tile's own population with filtering, sorting and its own
 * time range, so the detail is read ALONGSIDE the five numerals instead of replacing
 * them. The full-list deep link survives as the panel's drill-through, and the panel is
 * where a touch device now reaches the tile's trend, since the hover card is force-closed
 * for as long as the panel is up. One panel at a time; Escape closes it and returns focus
 * to the tile.
 *
 * Hover trendlines: every landing metric with an HONEST server series reveals it on
 * hover/focus via `MetricHoverTrend` (metrics/trends buckets, `timing_trend`, or the
 * usage `cost_over_time` ledger series). A metric with no genuine series — the Critical
 * tile (no per-severity bucket series) and the Open Cases stock (no open-count-over-time
 * series) — deliberately carries no affordance at all rather than an invented
 * decorative trend, and the strip carries no in-tile sparklines: every numeral on it
 * comes from the posture rollup, so a spark derived from the bounded case page would
 * chart a different population than the number above it.
 *
 * Scale context: every KPI numeral is paired with the denominator it is a share of,
 * and each pair comes from ONE payload so numerator and denominator always describe
 * the same population. A share whose evidence is incomplete, whose denominator is
 * missing, or whose denominator does not describe this window renders an em dash with
 * the reason NAMED in the tile's sub — never a synthetic 0%, and never a rounded-down
 * 0% beside a non-zero numeral ("<1%"). Two tiles are share-less by construction:
 * Total Cases IS the cohort denominator, and Open Cases is a window-exempt stock that
 * no window population reconciles with.
 *
 * Coverage: the posture-fed tiles gate on `#103`'s `window_covered`, NOT on
 * `truncated`. Truncation is permanent above the route's fetch bound, so the old gate
 * withheld every share forever on any sizeable deployment; coverage is the narrower,
 * checkable claim that every row which could satisfy the SELECTED window was read.
 * `postureCovered` is computed once for the whole page, so the strip, the Human-vs-AI
 * card and the Noise-Reduction funnel cannot gate the same evidence three ways. An
 * uncovered window keeps its COUNTS (a floor is still a number an operator can act on)
 * and withholds only the shares, naming the bound in each tile's sub.
 *
 * Security (#9): every label/value here is a humanized enum, a formatted number, or
 * backend-derived text rendered as PLAIN text. No untrusted string is injected as markup.
 *
 * Advisory (#3): NOTHING on this dashboard feeds `decide()` — it reads the outcome of
 * triage; it never influences close/escalate.
 */
import * as React from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Gauge,
  Inbox,
  Percent,
  Plug,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import { useNavigateOptional, type Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import type {
  Case,
  CasesResponse,
  Metrics,
  MetricsTrends,
  MetricsTrendBucket,
  NoiseReduction,
  SourceCoverage,
  UsageSummary,
} from '@/lib/types';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtTokens,
  humanizeAge,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { LoadingState } from '@/design-system';
import {
  TimeRangePicker,
  DEFAULT_RANGE,
  resolveRange,
  type TimeRange,
  type RefreshValue,
} from '@/soc/components/TimeRangePicker';
import { DashboardGroup } from '@/soc/components/DashboardGroup';
import { KpiTile, type KpiAccent, type KpiBreakdownRow } from '@/soc/components/KpiTile';
import {
  MetricHoverTrend,
  type MetricTrendPoint,
  type MetricTrendSeries,
} from '@/soc/components/MetricHoverTrend';
import {
  KpiDrilldownPanel,
  type KpiDrilldownSpec,
} from '@/soc/components/KpiDrilldownPanel';
import { useAnnouncer } from '@/soc/components/announcer';
import { CaseHoverCard } from '@/soc/components/CaseHoverCard';
import {
  CLOSE_ATTRIBUTION_BANDS,
  HumanVsAiCard,
  type HumanVsAiPoint,
  type HumanVsAiTotals,
} from '@/soc/components/HumanVsAiCard';
import { NoiseFunnel } from '@/soc/components/NoiseFunnel';
import { Reveal } from '@/soc/components/Reveal';
import { CountUp } from '@/soc/components/CountUp';
import { Stagger } from '@/soc/components/Stagger';
import { DonutChart, TrendArea, type DonutSegment } from '@/soc/components/charts';
import { BurnDownChart } from '@/soc/components/charts-soc';
import { token, VERDICT_COLOR, type VerdictKey } from '@/soc/components/palette';
import {
  SEVERITY_BAND_ORDER,
  severityBand,
  severityBandFromNumber,
} from '@/soc/components/badges';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { AutomationNudge } from './AutomationNudge';
import { HealthDegradationIndicator } from '@/soc/components/HealthDegradationIndicator';
import { StartDemoButton } from '@/soc/components/StartDemoButton';
import { usePosture } from '@/soc/hooks/usePosture';
import { Card, CardContent } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';

import {
  humanizeMinutes as humanizeMins,
  LIFECYCLE_METRICS,
  type LifecycleMetricKey,
} from './posture.format';
import type { PostureResponse, StatBlock } from './Metrics.posture.api';

/**
 * The Overview hero title — the app's white-screen boot guard anchors on it (the
 * smoke test asserts the whole console boots to this string). Exported as a single
 * constant so the title can be reworded here WITHOUT breaking the tests that check
 * "the app booted" (they import this constant rather than hardcoding the copy).
 */
export const PAGE_TITLE = 'Cyber Defence Center';

interface OverviewProps {
  /**
   * Optional drill-through navigation. When omitted (App renders it without a nav
   * prop), it resolves from the router context via `useNavigateOptional()`.
   */
  onNavigate?: Navigate;
}

type SliceAvailability = 'loading' | 'available' | 'unavailable' | 'unsupported';

interface SliceLoadState {
  availability: SliceAvailability;
  error: unknown | null;
}

/**
 * The backend's complete non-terminal lifecycle taxonomy
 * (`constants.OPEN_CASE_STATUSES`). Keep this byte-for-byte aligned: a case awaiting
 * human review or marked Escalated is still OPEN until it reaches resolved/closed.
 */
const OPEN_STATUSES = new Set([
  'new',
  'open',
  'needs_human',
  'investigating',
  'escalated',
  'on_hold',
]);
const CLOSED_STATUSES = new Set(['closed', 'resolved']);

/**
 * Cases.tsx's virtual status for the complete non-terminal lifecycle set above.
 * Keep this lightweight local contract here rather than importing the Cases page.
 */
const ACTIVE_CASES_FILTER = '__active__';
/**
 * Cases.tsx's virtual status for the TERMINAL set (`CLOSED_STATUSES` above). Terminal
 * is two statuses, and the Cases status filter applies exactly one, so before this
 * facet existed a `status: 'closed'` deep link silently dropped every RESOLVED case
 * from a tile that counts both. Same lightweight local-contract rule as the sentinel
 * above — the string is the wire, not an import.
 */
const TERMINAL_CASES_FILTER = '__terminal__';

/**
 * `stores.base.CASE_STATUS_GROUPS` — the SERVER's scalar names for the same two
 * multi-status lifecycle sets, resolved there from `constants.OPEN_CASE_STATUSES` /
 * `TERMINAL_CASE_STATUSES`. Sending one of these makes the drill-down's fetched page the
 * tile's population instead of an undifferentiated page the browser then carves up, so
 * its facet menus and its paging describe the population rather than the page. A status
 * LIST can never be sent instead: the query helper stringifies an array into one
 * comma-joined term that matches nothing, silently, at every layer.
 *
 * Same lightweight local-contract rule as the two sentinels above — the string is the
 * wire, not an import. Note the deliberate difference from the Cases-page sentinels:
 * these are the wire names of a SERVER-side group, those are virtual facets the Cases
 * page resolves itself.
 */
const ACTIVE_STATUS_GROUP = 'active';
const TERMINAL_STATUS_GROUP = 'terminal';

/**
 * `constants.DecisionBy.ANALYST_POLICY` — an operator's audited per-rule declaration,
 * applied deterministically with NO model call.
 */
const ANALYST_POLICY_DECISION = 'analyst_policy';

/**
 * Client mirror of `engine.precedent.is_policy_closed`, the ONE predicate every server
 * statistic uses to exclude a policy close from the agent's measured performance.
 *
 * It matters here because the False Positive Rate tile's numeral and its drill-down list
 * must count the SAME population. The server's rate strips these cases before it counts
 * anything — no model ran, so no verdict of the agent's exists — while a listing that
 * matched on `verdict` alone would happily show a policy-closed case as part of "the
 * rate's numerator". Both halves of the server predicate are on the wire, so this is the
 * same test, not an approximation: `decision_by` alone is erasable by any later analyst
 * action, which is why the durable `analyst_policy` payload is checked too.
 */
function isPolicyClosed(c: Case): boolean {
  return (
    (c.decision_by || '').toLowerCase() === ANALYST_POLICY_DECISION ||
    (c.analyst_policy ?? null) != null
  );
}

/**
 * The most severe band on the product's ONE severity ladder. `SEVERITY_BAND_ORDER`
 * (badges.tsx) is ASCENDING, so the last entry is the top band — derived rather than
 * retyped, so a future ladder change cannot leave a stale literal behind (§4).
 */
const TOP_SEVERITY_BAND = SEVERITY_BAND_ORDER[SEVERITY_BAND_ORDER.length - 1];

/**
 * The false-positive member of the product's closed verdict vocabulary
 * (`palette.VerdictKey`). Typed against that union so a rename is a compile error, not
 * a silently-empty drill-down.
 */
const FALSE_POSITIVE_VERDICT: VerdictKey = 'false_positive';

/**
 * The KPI drill-down disclosure's DOM ids. One panel is open at a time — the strip is a
 * comparison surface, and five stacked panels would push the instrument band off the
 * fold — so a single pair of static ids is correct and keeps `aria-controls` stable.
 */
const KPI_PANEL_ID = 'kpi-drilldown-panel';
const KPI_PANEL_HEADING_ID = 'kpi-drilldown-panel-heading';

/** Per-browser dismissal flag for the recommended-automation nudge (onboarding). */
const NUDGE_KEY = 'tlsoc.overview.automationNudge';
/** Per-browser hide flag for the Noise-Reduction funnel band (the per-user hide toggle). */
const NOISE_HIDE_KEY = 'tlsoc.overview.noiseFunnelHidden';

/**
 * The ONE sentence every bounded-evidence tile uses to name why its share is an em
 * dash. Shared so the 200-row case-sample cap and a truncated posture scan read
 * identically, and so the strip's language matches the Human-vs-AI card's
 * "bounded sample, shares unavailable".
 */
const BOUNDED_SAMPLE_SUB = 'Bounded sample · share unavailable';

/**
 * The sub for a posture-fed COUNT whose window could not be fully read. The count is
 * still a count — it is just a floor — so the tile keeps the numeral and names the
 * bound, instead of blanking a number the operator can act on.
 */
const PARTIAL_WINDOW_SUB = 'Partial window · lower bound';

/**
 * Is this posture rollup COMPLETE for the selected window?
 *
 * `#103` added `window_covered`, the narrower and far more useful claim than
 * `truncated`: a store above the route's fetch bound is truncated permanently, so
 * gating on truncation alone withholds every share forever even when the operator
 * asked for the last hour and the fetched rows reach back a month. Cases are read
 * newest-first, so a truncated fetch can only have dropped rows OLDER than the oldest
 * one read — a cutoff at or after that floor means the window WAS fully read.
 *
 * A server that predates the flag falls back to the old truncation rule, and a missing
 * rollup is never "covered" (an outage must not certify a window it never read).
 */
function postureWindowCovered(posture: PostureResponse | null): boolean {
  if (!posture) return false;
  if (typeof posture.window_covered === 'boolean') return posture.window_covered;
  return posture.truncated !== true;
}

/**
 * Was this rollup MEASURED at all — or is it the shape of a case-store OUTAGE?
 *
 * `routes_metrics` soft-fails an unreadable case store and still answers HTTP 200 with
 * `load_ok=False`, which `posture_metrics` turns into a payload of structural zeros:
 * `case_count` 0, every severity band 0, `terminal_cases` 0, `open_now.count` 0. None
 * of those is a count of anything, and the request SUCCEEDED, so neither the loading
 * nor the error arm fires. Published unqualified they read as a quiet, healthy, empty
 * SOC — the exact substitution `#103` added `load_ok` to prevent.
 *
 * The discriminator needs no string matching: with `load_ok=True`, `_window_coverage`
 * returns covered unconditionally whenever the fetch was not truncated. So
 * `truncated !== true && window_covered === false` is reachable ONLY through the
 * outage arm, and is unambiguous against truncation (which keeps its own honest
 * "lower bound" wording). Returns the server's own plain-text reason, so the page
 * states the backend's account of the gap rather than inventing one; a server
 * predating `window_covered` cannot signal the outage at all and returns null.
 */
function postureUnmeasuredReason(posture: PostureResponse | null): string | null {
  if (!posture) return null;
  if (posture.truncated === true) return null;
  if (posture.window_covered !== false) return null;
  const reason = (posture.window_coverage_reason || posture.open_now?.reason || '').trim();
  return reason || 'This window was not measured.';
}

/** Format an integer count for a count-up tile (thousands-separated). */
const fmtInt = (n: number): string => fmtNumber(n);

/**
 * Format the SnapshotCard donut CENTER number only. The center hole is pinned to
 * ~71px (innerPct=52% of the 136px ring) with `overflow-hidden` as a
 * deliberate anti-overlap guardrail — a 4+ digit total in `fmtInt`'s
 * thousands-separated form (e.g. "1,234") is wider than the hole and gets
 * clipped rather than overlapping the ring. Abbreviate >=1000 (e.g. "1.2K") so
 * the center always fits; the legend rows beside it keep their exact,
 * unabbreviated counts via `fmtNumber`.
 */
const fmtSnapshotCenter = (n: number): string => fmtTokens(n);

/** Round a resolved range down to whole hours (min 1) for the window-scoped fetches. */
function rangeHours(range: TimeRange): number {
  const { fromMs, toMs } = resolveRange(range);
  const h = Math.round((toMs - fromMs) / 3_600_000);
  return h > 0 ? h : 1;
}

// --------------------------------------------------------------------------- //
// Severity bands
// --------------------------------------------------------------------------- //
const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
type SevKey = (typeof SEV_ORDER)[number];
type SevCounts = Record<SevKey, number>;
const SEV_LABEL: Record<SevKey, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Informational',
};

const emptySev = (): SevCounts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/** Normalise a CASE into a severity band, using the SAME preference order as the Cases
 *  severity FILTER: prefer the source-asserted advisory `severity_band`, then fall back
 *  to the deterministic `risk_score` on the ONE SEVERITY authority (badges.ts). */
function bandOfCase(k: Case): SevKey {
  const explicit = severityBand(k.severity_band);
  if (explicit) return explicit;
  const s = typeof k.risk_score === 'number' && Number.isFinite(k.risk_score) ? k.risk_score : 0;
  return severityBandFromNumber(s);
}

/** Severity-band donut segments (highest → lowest), coloured from the severity axis. */
function sevSegments(counts: SevCounts): DonutSegment[] {
  return SEV_ORDER.map((s) => ({ label: SEV_LABEL[s], value: counts[s], color: token(s) })).filter(
    (seg) => seg.value > 0,
  );
}

/** Workload-status → bar color token. */
function statusBar(status: string): string {
  const t = status.toLowerCase();
  // Preserve the higher-attention visual treatment while these statuses still count
  // as open in every lifecycle aggregate.
  if (t === 'needs_human' || t === 'escalated') return 'bg-high';
  if (OPEN_STATUSES.has(t)) return 'bg-info';
  if (CLOSED_STATUSES.has(t)) return 'bg-success';
  if (t === 'reopened') return 'bg-warning';
  return 'bg-accent-bar';
}

/** A compact, honest label for the selected window ("24 hours" / "7 days"). */
function windowLabel(hours: number): string {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** A period-over-period percent delta from two raw counts, or null when there is no
 *  honest baseline (no previous window, prev == 0, or an exactly-flat move). */
function countDelta(cur: number, prev: number | null): { value: number; label: string } | null {
  if (prev == null || prev <= 0) return null;
  const rounded = Math.round(((cur - prev) / prev) * 1000) / 10;
  if (rounded === 0) return null;
  const sign = rounded > 0 ? '+' : '';
  return { value: rounded, label: `${sign}${rounded}%` };
}

function formatWholePercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** A finite number, or null — keeps a malformed trend bucket honest (never a fake 0). */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Trend disclosures state sub-2-day windows in hours ("24 hours", never "1 day"). */
function trendSpanLabel(hours: number): string {
  return hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'}` : windowLabel(hours);
}

/** The hover-trend window disclosure, e.g. "last 24 hours · 1h buckets". */
function trendWindowLabel(t: MetricsTrends): string {
  const mins = finiteOrNull(t.bucket_minutes);
  const bucket =
    mins == null || mins <= 0 ? null : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
  return bucket
    ? `last ${trendSpanLabel(t.window_hours)} · ${bucket} buckets`
    : `last ${trendSpanLabel(t.window_hours)}`;
}

/**
 * A short, deterministic UTC axis label for one trend bucket. Day-sized buckets read
 * as `MM-DD`, anything finer as `HH:mm` — but ONLY while the window itself fits inside
 * one day. A multi-day window with sub-day buckets (the 7-day preset is 6h buckets, the
 * 72h preset 3h) would otherwise repeat the same four `HH:mm` ticks once per day and
 * leave a hovered spike unlocatable, so those read `MM-DD HH:mm`. An unparseable
 * instant falls back to the raw value so the axis never silently renames a bucket. UTC
 * on purpose — the buckets are UTC-aligned server-side, so a local-time label would
 * misplace them.
 */
function bucketAxisLabel(
  t: unknown,
  bucketMinutes: number | null | undefined,
  windowHours?: number | null,
): string {
  const raw = String(t ?? '');
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  const iso = new Date(ms).toISOString();
  const daily = typeof bucketMinutes === 'number' && bucketMinutes >= 1440;
  if (daily) return iso.slice(5, 10);
  const spansDays =
    typeof windowHours === 'number' && Number.isFinite(windowHours) && windowHours > 24;
  return spansDays ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16);
}

/**
 * A whole-percent share rendered as scale context for a KPI numeral, or `undefined`
 * when there is no honest denominator. The caller renders an em dash for `undefined`
 * — never a synthetic 0%.
 */
function shareContext(value: number | undefined, denominator: number | undefined | null): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator <= 0) {
    return undefined;
  }
  // A real but tiny band reads "<1%", never a rounded-down "0%" beside a non-zero
  // numeral — the same rule the Noise-Reduction funnel applies to its stage shares.
  const rounded = Math.round((value / denominator) * 100);
  const pct = value > 0 && rounded === 0 ? '<1%' : `${rounded}%`;
  return `${pct} of ${fmtNumber(denominator)}`;
}

/** One KPI-strip tile descriptor (built in a memo, rendered as a <KpiTile>). */
interface KpiItem {
  label: string;
  /**
   * Explicit, STABLE `data-testid` anchor. Pinned per tile so re-wording a label can
   * never silently rename the tile's testid (KpiTile derives it from the label when
   * this is omitted).
   */
  testId: string;
  value: React.ReactNode;
  sub?: string;
  /**
   * Scale context beside the numeral ("N (P%)"-style): the denominator this count is
   * a share of, or `DASH` when that denominator is missing/bounded. Never a `delta`
   * — see `KpiTileProps.secondary`.
   */
  secondary?: React.ReactNode;
  /**
   * An in-place PARTITION of the numeral (the "of which" rows). Whole partition or
   * none — see `KpiTileProps.breakdown`.
   */
  breakdown?: KpiBreakdownRow[];
  icon: LucideIcon;
  accent: KpiAccent;
  goodDirection: 'up' | 'down' | 'none';
  /**
   * The tile's IN-PAGE drill-down. Activating a tile no longer navigates: it opens the
   * docked disclosure beneath the strip, where the population can be filtered, sorted
   * and re-ranged without losing sight of the five numerals it came from. The full-list
   * deep link survives as the panel's `target`, so nothing that used to be one click
   * away is now unreachable — it is one click further, behind context.
   *
   * `windowHours` is filled in by the memo, so a tile only declares what is specific to
   * its own population.
   */
  drilldown: Omit<KpiDrilldownSpec, 'windowHours' | 'trend'>;
  countTo?: number;
  format?: (n: number) => string;
  /**
   * The honest hover/focus trendline for this metric (server series only). Omitted
   * when NO genuine series exists for the tile — the Critical band (no per-severity
   * bucket series) and the open-case stock (no open-count-over-time series) both go
   * without, rather than borrowing a cohort line that charts a different population.
   */
  trend?: MetricTrendSeries;
}

/* ------------------------------------------------------------------------- */
/* Small presentation helpers (module-level, pure).                           */
/* ------------------------------------------------------------------------- */

/** A signed trend chip: the ARROW follows the true direction of change, the COLOR
 *  follows judgement (`goodDirection`). Plain text; the accessible label announces both. */
function TrendChip({
  delta,
  goodDirection,
}: {
  delta: { value: number; label: string } | null;
  goodDirection: 'up' | 'down';
}) {
  if (!delta) return null;
  const rising = delta.value >= 0;
  const improved = goodDirection === 'up' ? rising : !rising;
  const Arrow = rising ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      role="img"
      aria-label={`changed ${rising ? 'up' : 'down'} by ${delta.label}, ${
        improved ? 'improved' : 'worse'
      }`}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-2xs font-semibold tabular-nums',
        improved
          ? 'border-success/30 bg-success/10 text-success-text'
          : 'border-critical/30 bg-critical/10 text-critical-text',
      )}
    >
      <Arrow className="h-3 w-3" aria-hidden />
      <span aria-hidden>{delta.label}</span>
    </span>
  );
}

/**
 * A compact donut snapshot inside the shared resolved/open instrument column. The parent
 * supplies the panel boundary; this helper intentionally has no card chrome so both states
 * read as one instrument, matching the supplied command-center prototype.
 */
function SnapshotCard({
  title,
  caption,
  total,
  delta,
  goodDirection,
  counts,
  ariaLabel,
  ctaLabel,
  onClick,
  trend,
}: {
  title: string;
  caption: string;
  total: number;
  delta: { value: number; label: string } | null;
  goodDirection: 'up' | 'down';
  counts: SevCounts;
  ariaLabel: string;
  ctaLabel: string;
  onClick?: () => void;
  /** Optional honest hover trendline for the snapshot total. */
  trend?: MetricTrendSeries;
}) {
  const segments = sevSegments(counts);
  const legend = SEV_ORDER.map((s) => ({ key: s, value: counts[s] })).filter((r) => r.value > 0);
  const content = (
    <>
      {segments.length ? (
        <DonutChart
          segments={segments}
          height={136}
          thickness={0.26}
          showTooltip={false}
          className="w-36 shrink-0"
          ariaLabel={ariaLabel}
          center={
            <CountUp
              value={total}
              format={fmtSnapshotCenter}
              className={cn(
                'font-mono font-semibold tabular-nums text-foreground',
                total >= 1000 ? 'text-2xl' : 'text-3xl',
                'leading-none',
              )}
            />
          }
        />
      ) : (
        <div
          role="img"
          aria-label={`${ariaLabel} (none)`}
          className="flex h-[136px] w-36 shrink-0 items-center justify-center"
        >
          <span className="font-mono text-2xl font-semibold tabular-nums text-muted-foreground">
            0
          </span>
        </div>
      )}
      <ul className="min-w-0 flex-1 space-y-1">
        {legend.length ? (
          legend.map((r) => {
            const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
            return (
              <li key={r.key} className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: token(r.key) }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                  {SEV_LABEL[r.key]}
                </span>
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                  {fmtNumber(r.value)}
                </span>
                <span className="w-8 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                  {pct}%
                </span>
              </li>
            );
          })
        ) : (
          <li className="text-xs text-muted-foreground">No cases in this window.</li>
        )}
      </ul>
      {onClick ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </>
  );

  const body = onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={ctaLabel}
      className="mt-1.5 flex w-full min-w-0 items-center gap-3 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </button>
  ) : (
    <div className="mt-1.5 flex items-center gap-3 p-0.5">{content}</div>
  );

  return (
    <section className="min-w-0 border-b border-border/70 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">{title}</h2>
          <p className="text-2xs text-muted-foreground">{caption}</p>
        </div>
        <TrendChip delta={delta} goodDirection={goodDirection} />
      </div>
      {trend ? (
        // The CTA button (when present) is the focus stop; the wrapper only adds the
        // hover/focus-reachable trend card (WCAG 1.4.13 via MetricHoverTrend).
        <MetricHoverTrend {...trend} focusable={!onClick} side="top">
          {body}
        </MetricHoverTrend>
      ) : (
        body
      )}
    </section>
  );
}

/** One p50 lifecycle-timing stat block: value or an honest "not measured" DASH + reason. */
function TimingStat({
  label,
  sub,
  block,
  dotClass,
  help,
  compact = false,
}: {
  label: string;
  sub: string;
  block: StatBlock | undefined;
  dotClass: string;
  help?: string;
  compact?: boolean;
}) {
  const available = block?.available === true;
  const value = available ? humanizeMins(block!.p50) : DASH;
  const detail = available
    ? `p50 · ${fmtNumber(block!.count)} sample${block!.count === 1 ? '' : 's'}`
    : block?.reason || 'not measured (n/a)';
  return (
    <div
      className={cn(
        compact ? 'min-w-0 py-1' : 'rounded-md border border-border bg-muted/20 px-3 py-2.5',
      )}
      title={help}
    >
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} aria-hidden />
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono font-semibold leading-none tabular-nums text-foreground',
          compact ? 'text-3xl' : 'text-2xl',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-2xs text-muted-foreground">{sub}</div>
      <div className="text-2xs text-muted-foreground">{detail}</div>
    </div>
  );
}

type LatestCaseBadgeVariant = NonNullable<React.ComponentProps<typeof Badge>['variant']>;

/** Prototype status vocabulary: compact, operational, and semantically tokenised. */
function latestCaseStatus(status: string | null | undefined): {
  label: string;
  variant: LatestCaseBadgeVariant;
} {
  const key = (status || 'open').trim().toLowerCase();
  if (key === 'open' || key === 'new') return { label: 'Open', variant: 'critical' };
  if (key === 'needs_human' || key === 'escalated') {
    return { label: 'Escalated', variant: 'high' };
  }
  if (key === 'investigating' || key === 'in_progress') {
    return { label: 'Investigating', variant: 'low' };
  }
  if (key === 'closed' || key === 'resolved') return { label: 'Resolved', variant: 'success' };
  return { label: humanizeToken(key), variant: 'secondary' };
}

/** Compact real-time work queue adapted directly from the supplied Stitch prototype. */
function TopCasesPanel({
  cases,
  navigate,
  navWindow,
}: {
  cases: Case[];
  navigate?: Navigate;
  navWindow: number;
}) {
  return (
    <section aria-label="Latest cases" className="flex h-full min-w-0 flex-col p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">
            Latest cases
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">Real-time triage queue</p>
        </div>
        {navigate ? (
          <button
            type="button"
            className="shrink-0 rounded-sm px-1 py-0.5 text-2xs font-semibold uppercase tracking-widest text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => navigate('cases', { window: navWindow })}
          >
            View all
          </button>
        ) : null}
      </div>

      {cases.length ? (
        <ul className="mt-2 flex min-h-0 flex-1 flex-col gap-1.5">
          {cases.map((k) => {
            const displayId = (k.case_number || k.case_id || DASH).trim() || DASH;
            const displayTitle =
              (k.title || k.cluster_signature || k.rule_ids?.[0] || '').trim() ||
              'Untitled case';
            const age = humanizeAge(k.updated_at || k.created_at);
            const status = latestCaseStatus(k.status);
            return (
              <li key={k.case_id} className="min-w-0">
                <CaseHoverCard
                  case={k}
                  openDelay={320}
                  closeDelay={220}
                  side="left"
                  align="start"
                  sideOffset={12}
                  collisionPadding={12}
                  className="w-80 max-w-[calc(100vw-2rem)]"
                >
                  <button
                    type="button"
                    onClick={
                      navigate
                        ? () => navigate('cases', { caseId: k.case_id, window: navWindow })
                        : undefined
                    }
                    aria-disabled={!navigate}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-sm border border-border/70 bg-card/30 px-2 py-1.5 text-left',
                      navigate
                        ? 'transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                        : 'cursor-default',
                    )}
                    aria-label={navigate ? `Open case ${displayTitle}` : `Preview case ${displayTitle}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
                        <span className="max-w-28 shrink-0 truncate text-primary" title={displayId}>
                          {displayId}
                        </span>
                        <span className="truncate text-foreground" title={displayTitle}>
                          {displayTitle}
                        </span>
                      </span>
                      <span className="block font-mono text-2xs text-muted-foreground">
                        {age || 'Just now'}
                      </span>
                    </span>
                    <Badge
                      variant={status.variant}
                      className="shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide"
                    >
                      {status.label}
                    </Badge>
                  </button>
                </CaseHoverCard>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-1 items-center justify-center py-6">
          <EmptyState compact icon={Inbox} title="Queue clear" description="No recent cases in this window." />
        </div>
      )}
    </section>
  );
}

/** One big-number signal inside the {@link CoverageTile}. */
const CoverageMetric: React.FC<{
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}> = ({ icon: Icon, label, value, tone = 'default' }) => (
  <div
    className={cn(
      'rounded-md border px-2.5 py-2',
      tone === 'warning' ? 'border-warning/30 bg-warning/5' : 'border-border bg-muted/20',
    )}
  >
    <div className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </div>
    <div
      className={cn(
        'mt-1 font-mono text-xl font-semibold leading-none tabular-nums',
        tone === 'warning' ? 'text-warning-text' : 'text-foreground',
      )}
    >
      {value}
    </div>
  </div>
);

/**
 * The Overview "am I seeing everything?" coverage tile — the Google SecOps Health-Hub
 * big-number model over `GET /api/sources/coverage`. Reports how many enabled sources are
 * actually REPORTING (enabled − silent), the live event throughput, alerts triaged in the
 * last day, and — loudly, when nonzero — how many sources have gone SILENT (with a jump to
 * the Sources page to fix them). This REPLACES the old cases-per-source "Connector health"
 * bar list, which was blind to a source that stopped sending or was suppressed before a
 * case ever formed. Advisory only (#3); every value is a server aggregate rendered as plain
 * text (#9); no secrets (#10).
 */
function CoverageTile({
  coverage,
  onNavigate,
}: {
  coverage: SourceCoverage;
  onNavigate?: Navigate;
}) {
  const reporting = Math.max(0, coverage.sources_enabled - coverage.sources_silent);
  const pctReporting =
    coverage.sources_enabled > 0 ? Math.round((reporting / coverage.sources_enabled) * 100) : 0;
  const hasSilent = coverage.sources_silent > 0;
  const worstMins = Math.round((coverage.worst_last_event_seconds || 0) / 60);

  return (
    <div className="space-y-4" data-testid="coverage-tile">
      {/* Hero — enabled sources actually reporting. */}
      <div>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-4xl font-semibold leading-none tabular-nums text-foreground">
            <CountUp value={reporting} />
          </span>
          <span className="text-lg tabular-nums text-muted-foreground">
            / {fmtNumber(coverage.sources_enabled)}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          sources reporting
          {coverage.sources_total !== coverage.sources_enabled
            ? ` · ${fmtNumber(coverage.sources_total)} configured`
            : ''}
        </p>
      </div>

      {/* Completeness bar (green reporting · amber silent remainder). */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full bg-success" style={{ width: `${pctReporting}%` }} />
        {hasSilent ? <div className="h-full flex-1 bg-warning" /> : null}
      </div>

      {/* Three big signals. */}
      <div className="grid grid-cols-3 gap-2">
        <CoverageMetric
          icon={Gauge}
          label="Events / min"
          value={fmtNumber(Math.round(coverage.events_per_min))}
        />
        <CoverageMetric
          icon={ShieldCheck}
          label="Triaged 24h"
          value={fmtNumber(coverage.alerts_triaged_24h)}
        />
        <CoverageMetric
          icon={ShieldAlert}
          label="Silent"
          value={fmtNumber(coverage.sources_silent)}
          tone={hasSilent ? 'warning' : 'default'}
        />
      </div>

      {/* Honest footer — the silent-source alarm, or an all-clear. */}
      {hasSilent ? (
        <button
          type="button"
          disabled={!onNavigate}
          onClick={onNavigate ? () => onNavigate('sources') : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-left text-xs text-warning-text',
            onNavigate &&
              'transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {fmtNumber(coverage.sources_silent)} source
            {coverage.sources_silent === 1 ? '' : 's'} stopped reporting — review coverage
          </span>
          {onNavigate ? <ChevronRight className="h-4 w-4 shrink-0" aria-hidden /> : null}
        </button>
      ) : (
        <p className="text-2xs text-muted-foreground">
          All enabled sources are reporting
          {worstMins > 0 ? ` · oldest last event ${humanizeMins(worstMins)} ago` : ''}.
        </p>
      )}
    </div>
  );
}

export default function Overview({ onNavigate }: OverviewProps) {
  // Navigation seam: an explicit prop (host/test) wins; otherwise resolve from the
  // router context (no-op when rendered provider-less in a unit test).
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;

  // ----- Time range + auto-refresh (the CONTROL BAR state) ---------------- //
  const [range, setRange] = React.useState<TimeRange>(DEFAULT_RANGE);
  const [refresh, setRefresh] = React.useState<RefreshValue>('live');
  const hours = React.useMemo(() => rangeHours(range), [range]);
  /** The `window` (hours) carried on every drill-through so the case list matches. */
  const navWindow = hours;

  // ----- Dashboard data loads --------------------------------------------- //
  const [cases, setCases] = React.useState<Case[]>([]);
  /**
   * `GET /api/cases` windows at the STORE since `#103`, and reports whether the
   * `total` it returned is the PROVEN count of rows matching the requested window
   * (`window_total_exact`). That flag is the ONE authority on whether the fetched page
   * is the whole window — it replaced two disagreeing client heuristics that both
   * inferred truncation from `cases.length >= 200`, which is wrong in both directions
   * (a window holding exactly 200 rows read as truncated; a store-side fallback that
   * silently widened the window read as complete).
   */
  const [caseWindow, setCaseWindow] = React.useState<{ total: number; exact: boolean } | null>(
    null,
  );
  const [prevCases, setPrevCases] = React.useState<Case[] | null>(null);
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [noise, setNoise] = React.useState<NoiseReduction | null>(null);
  const [coverage, setCoverage] = React.useState<SourceCoverage | null>(null);
  const [trends, setTrends] = React.useState<MetricsTrends | null>(null);
  const noiseSupported = typeof api.noiseReduction === 'function';
  const trendsSupported = typeof api.metricsTrends === 'function';
  const [usageLoad, setUsageLoad] = React.useState<SliceLoadState>({
    availability: 'loading',
    error: null,
  });
  const [noiseLoad, setNoiseLoad] = React.useState<SliceLoadState>(() => ({
    availability: noiseSupported ? 'loading' : 'unsupported',
    error: null,
  }));
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  // Monotonic batch token: a window change (or manual refresh) supersedes any batch
  // still in flight, so a late-settling previous-window response can never repaint
  // the dashboard beneath the newly selected range (the stale-window guard). The
  // paired AbortController actually cancels the superseded transport where the
  // client method accepts a signal (`metricsTrends` today); every other slice is
  // covered by the seq check alone.
  const loadSeqRef = React.useRef(0);
  const loadAbortRef = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async () => {
    const seq = (loadSeqRef.current += 1);
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      // The Noise-Reduction funnel is typeof-guarded so a minimal test/mock surface
      // (no `noiseReduction`) simply resolves null and the funnel band self-omits.
      const noiseP: Promise<NoiseReduction | null> =
        noiseSupported
          ? api.noiseReduction(hours)
          : Promise.resolve(null);
      // The aggregate coverage rollup (A5.5). typeof-guarded exactly like `noiseReduction`
      // so a minimal test/mock surface simply resolves null and the coverage tile self-omits.
      const coverageP: Promise<SourceCoverage | null> =
        typeof api.sourcesCoverage === 'function'
          ? api.sourcesCoverage()
          : Promise.resolve(null);
      // The hover-trend bucket series — typeof-guarded exactly like the two above so a
      // minimal test/mock surface simply resolves null and every hover card degrades to
      // its quiet "No trend data yet." line.
      const trendsP: Promise<MetricsTrends | null> =
        trendsSupported ? api.metricsTrends(hours, controller.signal) : Promise.resolve(null);
      const [c, m, u, n, pc, cov, t] = await Promise.allSettled([
        // #37: window the current case sample by created-at so the case-derived widgets
        // honour the range (backend caps at 200 by created-desc).
        api.listCases({ limit: 200, from: `now-${hours}h` }),
        api.getMetrics(hours),
        api.usageSummary(hours),
        noiseP,
        // The immediately-preceding equal window — powers the honest open/resolved
        // snapshot trend deltas (omitted gracefully when the fetch fails).
        api.listCases({ limit: 200, from: `now-${2 * hours}h`, to: `now-${hours}h` }),
        coverageP,
        trendsP,
      ]);
      // Superseded by a newer window/refresh — that batch owns the state now.
      if (seq !== loadSeqRef.current) return;
      if (c.status === 'fulfilled') {
        const envelope = c.value as CasesResponse;
        setCases(envelope.cases ?? []);
        setCaseWindow({
          total: typeof envelope.total === 'number' ? envelope.total : 0,
          // Absent (an older backend, or no window requested) is NOT proof: it means
          // the server did not answer the question that was asked.
          exact: envelope.window_total_exact === true,
        });
      }
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (u.status === 'fulfilled') {
        setUsage(u.value);
        setUsageLoad({ availability: 'available', error: null });
      } else {
        // Preserve the last valid summary, but make the failed current read explicit.
        setUsageLoad({
          availability: 'unavailable',
          error: u.reason ?? new Error('Failed to load LLM spend.'),
        });
      }
      if (!noiseSupported) {
        setNoiseLoad({ availability: 'unsupported', error: null });
      } else if (n.status === 'fulfilled') {
        setNoise(n.value ?? null);
        setNoiseLoad({ availability: 'available', error: null });
      } else {
        // Keep the last valid funnel mounted while reporting the failed refresh.
        setNoiseLoad({
          availability: 'unavailable',
          error: n.reason ?? new Error('Failed to load noise reduction.'),
        });
      }
      if (cov.status === 'fulfilled') setCoverage(cov.value ?? null);
      // Trends degrade quietly: a failed/omitted read clears the series (the hover
      // cards show "No trend data yet.") rather than showing another window's trend.
      setTrends(t.status === 'fulfilled' ? t.value ?? null : null);
      setPrevCases(pc.status === 'fulfilled' ? pc.value.cases ?? [] : null);
      // Only surface a page-level error if the load is wholly empty.
      if (c.status === 'rejected' && m.status === 'rejected') {
        setError(c.reason ?? m.reason ?? new Error('Failed to load dashboard data.'));
      }
    } catch (e) {
      if (seq === loadSeqRef.current) setError(e);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [hours, noiseSupported, trendsSupported]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Unmount: cancel whatever batch is still in flight (the seq guard already
  // discards its result; this releases the transport too).
  React.useEffect(() => () => loadAbortRef.current?.abort(), []);

  // Server-side posture rollup — the AUTHORITATIVE lifecycle (MTTA/MTTR/dwell/MTTD p50 +
  // SLA + quality rates). `'prev'` also asks for the period-over-period `compare` block.
  const {
    data: postureResponse,
    loading: postureLoading,
    error: postureError,
    stale: postureStale,
    reload: reloadPosture,
  } = usePosture(hours, 'prev');
  // Defensive echo check at the rendering boundary. The hook already rejects a
  // mismatched payload; keeping this projection here makes every posture consumer
  // visibly tied to the selected window and prevents a future hook regression from
  // reintroducing cross-window tiles. The ONE deliberate exception is the hook's
  // stale-while-revalidate snapshot: while the new window is in flight the previous
  // snapshot stays mounted, explicitly marked by the tiles' "Loading Nh" sub, so a
  // range change never blanks the dashboard.
  const posture =
    postureResponse && (postureResponse.window_hours === hours || postureStale)
      ? postureResponse
      : null;
  /**
   * ONE coverage verdict for every posture consumer on this page (`#103`). Computed
   * once here so the KPI strip, the Human-vs-AI card and the Noise-Reduction funnel
   * cannot end up gating the same evidence on three different rules — the exact drift
   * that let the strip publish a share the card had just declared unmeasurable.
   */
  const postureCovered = postureWindowCovered(posture);
  /**
   * Non-null when the rollup is an OUTAGE rather than a measurement (see
   * {@link postureUnmeasuredReason}). Computed beside `postureCovered` so every
   * posture consumer on the page reads one verdict: a not-measured window is not a
   * partially-covered one, and its zeros are not lower bounds.
   */
  const postureUnmeasured = postureUnmeasuredReason(posture);

  /** Retry only the LLM spend slice; healthy dashboard siblings never reload or blank. */
  const retryUsage = React.useCallback(async () => {
    try {
      const next = await api.usageSummary(hours);
      setUsage(next);
      setUsageLoad({ availability: 'available', error: null });
    } catch (nextError) {
      setUsageLoad({ availability: 'unavailable', error: nextError });
    }
  }, [hours]);

  /** Retry only the Noise Reduction slice; retain any last usable funnel on failure. */
  const retryNoise = React.useCallback(async () => {
    if (!noiseSupported) return;
    try {
      const next = await api.noiseReduction(hours);
      setNoise(next ?? null);
      setNoiseLoad({ availability: 'available', error: null });
    } catch (nextError) {
      setNoiseLoad({ availability: 'unavailable', error: nextError });
    }
  }, [hours, noiseSupported]);

  /** One refresh pulse for the whole dashboard (control-bar button + auto-refresh tick). */
  const refreshAll = React.useCallback(() => {
    void load();
    void reloadPosture();
  }, [load, reloadPosture]);

  // ----- Noise-Reduction funnel: per-user hide toggle (persisted) --------- //
  const [noiseHidden, setNoiseHidden] = React.useState<boolean>(() => {
    try {
      return localStorage.getItem(NOISE_HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleNoiseHidden = React.useCallback(() => {
    setNoiseHidden((h) => {
      const next = !h;
      try {
        localStorage.setItem(NOISE_HIDE_KEY, next ? '1' : '0');
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }, []);

  // The diagnostics band only mounts when the client actually exposes at least one of
  // the two health endpoints (mirrors the AutomationNudge/noiseReduction guard) — a
  // trimmed mock surface must never see a call it cannot answer.
  const healthAvailable =
    typeof api.diagnosticsHealth === 'function' || typeof api.autoCloseHealth === 'function';

  // ----- Recommended-automation nudge (onboarding-beginner) --------------- //
  const [showNudge, setShowNudge] = React.useState(false);
  React.useEffect(() => {
    const canFetch = typeof api.listSources === 'function' && typeof api.get === 'function';
    if (!canFetch) return undefined;
    try {
      if (localStorage.getItem(NUDGE_KEY) === 'dismissed') return undefined;
    } catch {
      /* no storage → treat as not dismissed */
    }
    let alive = true;
    void (async () => {
      try {
        const [srcRes, tuning] = await Promise.all([
          api.listSources(),
          api.get<{ config?: { enabled?: boolean } }>('tuning/config'),
        ]);
        const hasEnabledSource = (srcRes.sources ?? []).some((s) => s.enabled !== false);
        const tuningOff = tuning?.config?.enabled === false;
        if (alive) setShowNudge(Boolean(hasEnabledSource && tuningOff));
      } catch {
        /* best-effort — no nudge on failure */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dismissNudge = React.useCallback(() => {
    try {
      localStorage.setItem(NUDGE_KEY, 'dismissed');
    } catch {
      /* ignore storage errors */
    }
    setShowNudge(false);
  }, []);

  // ----- Derived case-shape breakdowns ------------------------------------ //
  const derived = React.useMemo(() => {
    let open = 0;
    let resolved = 0;
    const sevCounts = emptySev();
    const openSev = emptySev();
    const resolvedSev = emptySev();

    for (const k of cases) {
      const st = (k.status || '').toLowerCase();
      const isOpen = OPEN_STATUSES.has(st);
      const isClosed = CLOSED_STATUSES.has(st);
      if (isOpen) open += 1;
      if (isClosed) resolved += 1;

      // Banding here feeds the two SEVERITY DONUTS only — a per-band split of the
      // rows this page actually holds. The Critical KPI no longer derives its count
      // this way: a band tallied over a bounded page silently reports a sample as a
      // total, so it now reads the server's `posture.severity_counts`, which
      // partitions the whole windowed population.
      const band = bandOfCase(k);
      sevCounts[band] += 1;
      if (isOpen) openSev[band] += 1;
      if (isClosed) resolvedSev[band] += 1;
    }

    return { open, resolved, sevCounts, openSev, resolvedSev };
  }, [cases]);

  // Previous-window open/resolved counts (for the snapshot trend deltas). null when the
  // prev-window fetch was unavailable → the snapshots simply omit their delta chips.
  const prev = React.useMemo(() => {
    if (!prevCases) return null;
    let open = 0;
    let resolved = 0;
    for (const k of prevCases) {
      const st = (k.status || '').toLowerCase();
      if (OPEN_STATUSES.has(st)) open += 1;
      else if (CLOSED_STATUSES.has(st)) resolved += 1;
    }
    return { open, resolved };
  }, [prevCases]);

  /*
   * (The former "Autonomous vs human" fold-out card was removed here: the landing
   * page now states close attribution ONCE, in the Human-vs-AI instrument, over the
   * server's reconciling agent/human/system partition. The card told a third,
   * differently-denominated version of the same story. The Resolved / Closed KPI
   * tile's in-place breakdown reads that SAME `humanVsAi` partition rather than
   * re-deriving it — see the `kpis` memo.)
   *
   * (The bounded-sample "Escalated to human" fallback was removed with the tile it
   * served. Its count came off `GET /api/metrics`, an all-time cap-2,000 fetch that no
   * window-scoped denominator reconciles with, so it could never carry a share; the
   * strip's third cell now states the open-case STOCK the server measures directly.)
   */

  // ----- Full response-timing trio (server posture) — Deeper analytics ---- //
  const timing = React.useMemo(() => {
    const life = posture?.lifecycle;
    const block = (
      metric: LifecycleMetricKey,
      statKey: 'dwell_minutes' | 'mtta_minutes' | 'mttr_minutes',
      accent: KpiAccent,
    ) => {
      const b = life?.[statKey];
      const copy = LIFECYCLE_METRICS[metric];
      return {
        key: metric,
        label: copy.label,
        help: copy.help,
        value: b && b.available ? humanizeMins(b.p50) : DASH,
        sub:
          b && b.available
            ? `p50 · ${fmtNumber(b.count)} sample${b.count === 1 ? '' : 's'}`
            : b?.reason || 'no samples yet',
        accent,
      };
    };
    return [
      block('mtta', 'mtta_minutes', 'medium'),
      block('mttr', 'mttr_minutes', 'success'),
      block('dwell', 'dwell_minutes', 'info'),
    ];
  }, [posture]);

  // Detect / first-response headline stat blocks (the compact operations timing rail).
  // "Respond" = the first HUMAN response, so it reads the ACK clock (mtta_minutes) — NOT
  // dwell_minutes, whose _RESPONSE_STATUSES includes RESOLVED/CLOSED and would count an AI
  // auto-close as a human response (the dashboard must stay honest). The `respond` trend
  // series is likewise ACK-based server-side.
  const mttdBlock = posture?.lifecycle?.mttd_minutes;
  const respondBlock = posture?.lifecycle?.mtta_minutes;

  // Burn-down (opened vs resolved) series for the compact operations rail.
  const burndownData = React.useMemo(
    () => (metrics?.burndown ?? []).map((p) => ({ x: p.date, open: p.opened, closed: p.resolved })),
    [metrics],
  );


  // ----- Exactly four most-recent cases — compact live instrument queue ----- //
  const latestCases = React.useMemo(
    () =>
      [...cases]
        .sort((a, b) => {
          const bTime = Date.parse(b.updated_at || b.created_at || '') || 0;
          const aTime = Date.parse(a.updated_at || a.created_at || '') || 0;
          return bTime - aTime || (b.risk_score ?? 0) - (a.risk_score ?? 0);
        })
        .slice(0, 4),
    [cases],
  );

  // ----- BarList datasets (Deeper analytics) ------------------------------ //
  const signatureItems: BarListItem[] = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of cases) {
      const label =
        (k.title || k.cluster_signature || k.rule_ids?.[0] || 'Uncategorized').trim() ||
        'Uncategorized';
      counts[label] = (counts[label] ?? 0) + 1;
    }
    const total = cases.length || 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value, sub: `${Math.round((value / total) * 100)}% of cases` }));
  }, [cases]);

  const entityItems: BarListItem[] = React.useMemo(() => {
    const counts: Record<string, { value: number; type: string }> = {};
    for (const k of cases) {
      const v = k.entity?.value;
      if (!v) continue;
      const type = k.entity?.type || k.entity_type || 'entity';
      const key = String(v);
      if (!counts[key]) counts[key] = { value: 0, type };
      counts[key].value += 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 8)
      .map(([label, info]) => ({ label, value: info.value, sub: humanizeToken(info.type) }));
  }, [cases]);

  // ----- Case outcomes (verdict mix) — Deeper analytics ------------------- //
  const verdictMix = React.useMemo<{ segments: DonutSegment[]; total: number }>(() => {
    const bv = metrics?.by_verdict;
    const src: Record<string, number> = bv
      ? {
          TRUE_POSITIVE: bv.TRUE_POSITIVE ?? 0,
          NEEDS_HUMAN: bv.NEEDS_HUMAN ?? 0,
          FALSE_POSITIVE: bv.FALSE_POSITIVE ?? 0,
          none: bv.none ?? 0,
        }
      : cases.reduce<Record<string, number>>((acc, k) => {
          const v = (k.verdict || 'none').toUpperCase();
          const key =
            v === 'TRUE_POSITIVE' || v === 'FALSE_POSITIVE' || v === 'NEEDS_HUMAN' ? v : 'none';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
    const defs: Array<{ key: string; label: string; colorName: string }> = [
      { key: 'TRUE_POSITIVE', label: 'True positive', colorName: VERDICT_COLOR.true_positive },
      { key: 'NEEDS_HUMAN', label: 'Needs human', colorName: VERDICT_COLOR.needs_human },
      { key: 'FALSE_POSITIVE', label: 'False positive', colorName: VERDICT_COLOR.false_positive },
      { key: 'none', label: 'Unverdicted', colorName: 'muted' },
    ];
    const segments = defs
      .map((d) => ({ label: d.label, value: src[d.key] ?? 0, color: token(d.colorName) }))
      .filter((s) => s.value > 0);
    const total = segments.reduce((a, s) => a + s.value, 0);
    return { segments, total };
  }, [metrics, cases]);

  const caseVolume = React.useMemo(
    () => (metrics?.cases_per_day ?? []).map((d) => ({ x: d.date, y: d.count })),
    [metrics],
  );

  const workloadItems = React.useMemo(() => {
    const byStatus = metrics?.by_status ?? {};
    const entries = Object.entries(byStatus);
    const source = entries.length
      ? entries
      : Object.entries(
          cases.reduce<Record<string, number>>((acc, k) => {
            const s = (k.status || 'unknown').toLowerCase();
            acc[s] = (acc[s] ?? 0) + 1;
            return acc;
          }, {}),
        );
    return source.sort((a, b) => b[1] - a[1]).map(([status, value]) => ({ status, value }));
  }, [metrics, cases]);

  // ----- Hover trendlines — honest server series only ---------------------- //
  // The bucket payload echoes its measured window; mirror the posture projection's
  // render-boundary check so a previous window's buckets can never sit beneath the
  // newly selected range while a refresh is in flight.
  const trendsForWindow = trends && trends.window_hours === hours ? trends : null;
  const bucketTrends = React.useMemo(() => {
    if (!trendsForWindow?.buckets?.length) return null;
    const buckets = trendsForWindow.buckets;
    const series = (pick: (b: MetricsTrendBucket) => number | null): MetricTrendPoint[] =>
      buckets.map((b) => ({ label: String(b.t ?? ''), value: pick(b) }));
    // Only the series a tile or card actually charts. `auto_closed` / `sent_to_human`
    // are deliberately absent: the strip no longer carries a tile whose population
    // they describe, and the Human-vs-AI chart builds its own three-band series
    // straight off the buckets.
    return {
      label: trendWindowLabel(trendsForWindow),
      newCases: series((b) => finiteOrNull(b.new_cases)),
      closed: series((b) => finiteOrNull(b.closed)),
      // Nulls (no verdicted denominator in the bucket) stay nulls — the hover card
      // renders measured points only and discloses the measured/total bucket count.
      fpRate: series((b) => finiteOrNull(b.fp_rate)),
    };
  }, [trendsForWindow]);
  /** Window disclosure when no bucket payload is available (quiet no-data card). */
  const trendFallbackLabel = `last ${trendSpanLabel(hours)}`;

  // ----- Human vs AI — close attribution (the instrument band's first cell) ---- //
  /**
   * The server's three-way LAST-WRITER partition of the window's CLOSED cases:
   * agent / analyst / system-or-unattributed residual. Operator "declared benign"
   * policy closes are excluded upstream (no model ran on them).
   *
   * Totals prefer the authoritative posture rollup; when posture is unavailable the
   * SAME partition is summed from the (non-truncated) trend buckets, which the
   * backend guarantees reconciles with it bucket-for-bucket. Either way the three
   * counts must add up to the closed total — a partition that does not reconcile is
   * reported as unavailable (em dashes) rather than shown as three plausible numbers.
   */
  const humanVsAi = React.useMemo<{
    totals: HumanVsAiTotals | null;
    reason: string;
    series: HumanVsAiPoint[] | null;
    truncated: boolean;
    /**
     * True when `totals` came from the STALE posture snapshot — i.e. it describes the
     * PREVIOUS window while `windowLabel` already names the newly selected one. The
     * KPI tiles mark that state with a "Loading Nh" sub; the card has no such sub, so
     * it withholds the counts rather than publishing them under the wrong label.
     */
    stale: boolean;
    alerts: number | null;
  }>(() => {
    const partition = (
      ai: unknown,
      human: unknown,
      system: unknown,
      closed: unknown,
    ): HumanVsAiTotals | null => {
      const nums = [ai, human, system, closed];
      if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || (n as number) < 0)) {
        return null;
      }
      const [a, h, y, c] = nums as number[];
      // The invariant the backend documents. If it does not hold here, the payload is
      // not a partition and must not be rendered as one.
      if (a + h + y !== c) return null;
      return { ai: a, human: h, system: y, closed: c };
    };

    const buckets = trendsForWindow?.buckets ?? [];
    // The posture half of this flag is now the COVERAGE verdict, the same one the KPI
    // strip gates on — a truncated fetch whose selected window was nonetheless read in
    // full is not a bounded sample. A missing posture rollup contributes nothing here
    // (the bucket branch answers instead); it is not evidence of a bound.
    const truncated =
      trendsForWindow?.truncated === true || (posture != null && !postureCovered);

    // The bucket series: charted only when EVERY bucket carries the partition, so an
    // older backend can never render a lone agent line that reads as "humans closed
    // nothing". Buckets are server zero-filled, so a 0 here is a measured zero.
    const supported =
      buckets.length > 0 &&
      buckets.every(
        (b) =>
          typeof b.human_closed === 'number' &&
          Number.isFinite(b.human_closed) &&
          typeof b.system_closed === 'number' &&
          Number.isFinite(b.system_closed),
      );
    const series: HumanVsAiPoint[] | null = supported
      ? buckets.map((b) => ({
          x: bucketAxisLabel(b.t, trendsForWindow?.bucket_minutes, trendsForWindow?.window_hours),
          ai: finiteOrNull(b.auto_closed),
          human: finiteOrNull(b.human_closed),
          system: finiteOrNull(b.system_closed),
        }))
      : null;

    const q = posture?.quality;
    let totals = partition(
      q?.auto_closed_cases,
      q?.human_closed_cases,
      q?.system_closed_cases,
      q?.terminal_cases,
    );
    // An OUTAGE is not a partition of zero. `posture_metrics(load_ok=False)` answers
    // HTTP 200 with structural zeros and a reason attached, and 0 + 0 + 0 === 0 passes
    // the reconciliation guard above — so without this the card would publish
    // "AI agent 0 · Human 0 · System 0" as a measurement of a window it never read,
    // in the same render where the KPI strip dashes the identical payload.
    if (postureUnmeasured) totals = null;
    // Whether the partition below is the previous window's (see `stale` above). Only
    // the posture branch can be stale — the bucket branch is rejected outright on a
    // window mismatch, so anything it produces already matches the selected window.
    const staleTotals = totals != null && postureStale;
    let reason =
      postureUnmeasured ??
      (q
        ? 'This backend does not report how closed cases were attributed.'
        : 'Close attribution is unavailable for this window.');
    if (!totals && supported && !truncated) {
      const sum = (pick: (b: MetricsTrendBucket) => number | null | undefined): number =>
        buckets.reduce((a, b) => a + (finiteOrNull(pick(b)) ?? 0), 0);
      totals = partition(
        sum((b) => b.auto_closed),
        sum((b) => b.human_closed),
        sum((b) => b.system_closed),
        sum((b) => b.closed),
      );
      if (!totals) reason = 'Close attribution did not reconcile for this window.';
    }

    // Raw ingest volume is a DIFFERENT population (ingest-hour tally vs case cohort),
    // so it is only ever shown as labelled context — and only when every bucket
    // actually reported it. One null bucket means the counters were warming up.
    const alertsMeasured =
      buckets.length > 0 &&
      buckets.every((b) => typeof b.alerts === 'number' && Number.isFinite(b.alerts));
    const alerts = alertsMeasured
      ? buckets.reduce((a, b) => a + (b.alerts as number), 0)
      : null;

    return { totals, reason, series, truncated, stale: staleTotals, alerts };
  }, [posture, postureCovered, postureUnmeasured, postureStale, trendsForWindow]);

  // Per-UTC-day lifecycle timing series (GET /api/metrics `timing_trend`) — genuinely
  // MTTD/respond/resolve, so the timing stats reuse it instead of the case sample.
  const timingTrends = React.useMemo(() => {
    const rows = metrics?.timing_trend ?? [];
    if (!rows.length) return null;
    const series = (pick: (r: (typeof rows)[number]) => number | null): MetricTrendPoint[] =>
      rows.map((r) => ({ label: String(r.date ?? ''), value: finiteOrNull(pick(r)) }));
    return {
      label: `per UTC day · ${rows.length} day${rows.length === 1 ? '' : 's'}`,
      mttd: series((r) => r.mttd),
      respond: series((r) => r.respond),
      resolve: series((r) => r.resolve),
    };
  }, [metrics]);

  // The ledger's own spend-over-time series (usage summary `cost_over_time`).
  const spendTrend = React.useMemo<MetricTrendPoint[] | undefined>(() => {
    const rows = usage?.cost_over_time ?? [];
    const pts = rows.map((r) => ({ label: String(r.ts ?? ''), value: finiteOrNull(r.cost) }));
    return pts.length ? pts : undefined;
  }, [usage]);

  // ----- KPI micro-strip — 5 alert/case signal tiles --------------------- //
  /**
   * Every tile on this strip is now fed by the SERVER, and each names the population
   * it measures — because four of the five are cohort numbers scoped to the selected
   * window and one deliberately is not:
   *
   *   Total Cases       arrivals in the window, policy-closed INCLUDED. Deliberately
   *                     `posture.case_count`, never `quality.total_cases`:
   *                     `quality_metrics` strips policy-closed rows first, so that
   *                     field answers a narrower question than the tile's label.
   *   Total Critical    the server's per-band tally (`severity_counts`), a partition
   *                     of the same `case_count`. It replaced a client band-count over
   *                     a 200-row page, which reported a sample as a total.
   *   Open Cases        the window-EXEMPT open STOCK (`open_now`). It does NOT sum
   *                     with the four cohort tiles and its sub says so.
   *   FP Rate           unchanged: the server rate over the VERDICTED denominator.
   *   Resolved / Closed terminal cases, carrying the three-way close partition inside.
   */
  const kpis: KpiItem[] = React.useMemo(() => {
    const quality = posture?.quality;
    /**
     * Can this window's posture numbers be published as measurements?
     *
     * Gated on `#103`'s `window_covered`, not on `truncated`: truncation is permanent
     * above the fetch bound, so the old gate withheld every share forever on any
     * sizeable deployment. Coverage is the narrower claim — "every row that could
     * satisfy the SELECTED window was read" — and it is what a share is allowed to
     * depend on. The Human-vs-AI instrument withholds the same evidence in the same
     * render, so the strip can never publish a share the card just declared
     * unmeasurable.
     */
    const covered = postureCovered;
    /**
     * An OUTAGE is not a measurement. When the case store could not be read the rollup
     * still arrives HTTP 200, full of structural zeros; every posture-fed numeral on
     * this strip therefore reads as absent (`undefined` → em dash) and every sub
     * states the server's own reason. A zero published here would be four confident
     * lies at once, and the "partial window · lower bound" caption would compound them
     * by calling those zeros a floor of a real population.
     */
    const unmeasured = postureUnmeasured;
    /** Read a posture number only when the rollup measured anything at all. */
    const measured = (n: unknown): number | undefined =>
      !unmeasured && typeof n === 'number' && Number.isFinite(n) ? n : undefined;

    // --- Total Cases: the window's arrival cohort (policy-closed included). ---
    const caseCount = measured(posture?.case_count);

    // --- Total Critical: the server-side per-band tally, not a client sample count. ---
    // Keyed by the backend's own closed SEVERITY_BANDS vocabulary and indexed with the
    // ladder's OWN top band (`TOP_SEVERITY_BAND`), never the literal `critical`: the
    // tile's population sentence, its drill-down predicate and its Cases deep link all
    // derive that band already, so a literal here would let the numeral and its own
    // panel name different bands the moment the ladder's top entry is renamed (§4).
    // An older server omits the block entirely, and that absence is "not reported".
    const criticalCount = measured(posture?.severity_counts?.[TOP_SEVERITY_BAND]);
    const topBandLabel = humanizeToken(TOP_SEVERITY_BAND);

    // The same server-side per-band tally, handed whole to every drill-down so its
    // severity MENU can offer the bands this window actually contains instead of the
    // bands that happen to land on the rows it read. The band is derived at read time
    // and stored nowhere, so it can never be a query filter — this rollup is the only
    // whole-population view of it there is. The panel uses it ONLY while it is on the
    // dashboard's own window, because outside that range the tally answers a different
    // question, and it says which source the menu came from either way. Absent when
    // posture did not report it, which is "not reported", never "no bands".
    const bandHistogram = posture?.severity_counts ?? null;

    // --- Open Cases: a STOCK measured at `generated_at`, deliberately window-exempt. ---
    const openNow = posture?.open_now;
    const openNowCount = measured(openNow?.count);
    // `complete: false` marks a lower bound (truncated fetch) or a failed read. An
    // older server omits the flag; the count itself is then all we can claim. The
    // failed-read arm is handled above, where the count is withheld entirely.
    const openNowComplete = openNow?.complete !== false;

    // --- False Positive Rate: unchanged population, re-gated on coverage. ---
    const fpRate = quality?.false_positive_rate;
    const fpPercent =
      !unmeasured && covered && typeof fpRate === 'number' ? Math.round(fpRate * 100) : undefined;

    /**
     * --- Resolved / Closed: every case that reached a terminal state. ---
     *
     * `quality.terminal_cases` is NOT that population. `quality_metrics` strips
     * operator "declared benign" policy closes before it counts anything (they never
     * reached the agent, so they must not distort its performance rates), and reports
     * them separately as `policy_closed_cases`. Dividing that narrowed numerator by the
     * policy-INCLUSIVE `case_count` put numerator and denominator on two different
     * populations — and this tile's own drill-down panel (`CLOSED_STATUSES`) and its
     * `__terminal__` deep link are both policy-INCLUSIVE, so the numeral disagreed with
     * everything it opened onto.
     *
     * So the numeral is the policy-inclusive sum, matching the label, the sub, the
     * panel, the deep link and the denominator. A server that omits
     * `policy_closed_cases` is a server that does not strip them either — the exclusion
     * and the field shipped in the same change — so absent means the count already
     * includes them, and adding 0 is exact rather than a guess.
     */
    const strippedTerminal = measured(quality?.terminal_cases);
    const policyClosed = quality?.policy_closed_cases;
    const policyClosedReported = !unmeasured && typeof policyClosed === 'number';
    const terminalCases =
      strippedTerminal === undefined
        ? undefined
        : strippedTerminal + (policyClosedReported ? (policyClosed as number) : 0);
    /**
     * The close breakdown is THREE numbers, never two. `engine/metrics.py` is explicit
     * that human work is NOT `terminal - auto_closed`: that difference over-states the
     * analyst share by absorbing the system/legacy residual. So this renders agent,
     * analyst AND residual — with the residual visible even at zero — or nothing at
     * all.
     *
     * It reads the very same `humanVsAi.totals` the instrument card below states, so
     * the two surfaces cannot drift, and it inherits that memo's reconciliation guard
     * (a partition whose bands do not sum to the closed total is not rendered as a
     * partition). It is additionally required to reconcile with the numeral printed
     * ABOVE it, and is withheld while the totals are the previous window's — the card
     * withholds then too.
     */
    const closeTotals = humanVsAi.stale ? null : humanVsAi.totals;
    const closeBreakdown: KpiBreakdownRow[] | undefined =
      closeTotals && closeTotals.closed === strippedTerminal
        ? [
            ...CLOSE_ATTRIBUTION_BANDS.map((band) => ({
              label: band.label,
              value: fmtNumber(closeTotals[band.key]),
              title: band.title,
            })),
            // The fourth disjoint band of the numeral above. Rendered only when the
            // server REPORTS it (absence is "this backend does not separate them",
            // not zero) and kept visible at zero, exactly like the system residual —
            // so the four rows always sum to the numeral they sit under.
            ...(policyClosedReported
              ? [
                  {
                    label: 'Declared benign',
                    value: fmtNumber(policyClosed as number),
                    title:
                      'Closed deterministically by an operator analyst rule policy \u2014 no model ran',
                  },
                ]
              : []),
          ]
        : undefined;

    const postureSub = postureLoading
      ? `Loading ${windowLabel(hours)}`
      : postureError
        ? 'Posture unavailable'
        : // A successful read of an unreadable store: say so on every tile it feeds,
          // in the server's own words, instead of captioning zeros as a lower bound.
          (unmeasured ?? undefined);
    const bucketLabel = bucketTrends?.label ?? trendFallbackLabel;
    /** A cohort sub: the honest caption when covered, the named bound when not. */
    const cohortSub = (caption: string, bounded = PARTIAL_WINDOW_SUB): string =>
      postureSub ?? (covered ? caption : bounded);

    return [
      {
        label: 'Total Cases',
        // Re-keyed WITH the label. `KpiTile` derives its anchor from `testId` when one
        // is pinned, so renaming only the label would leave `kpi-open-cases` on the
        // tile that now carries the TOTAL — an anchor naming the wrong metric, which
        // a presence/class assertion would never catch.
        testId: 'total-cases',
        value: typeof caseCount === 'number' ? fmtNumber(caseCount) : DASH,
        countTo: caseCount,
        format: fmtInt,
        // No `secondary`: this IS the denominator the cohort tiles are shares of, so
        // it has none of its own. An em dash here would read as "a denominator we
        // could not measure", which is the opposite of true.
        sub: cohortSub('Arrivals in this window · policy-closed included'),
        icon: Inbox,
        accent: 'primary',
        goodDirection: 'down',
        trend: {
          metric: 'New cases opened',
          points: bucketTrends?.newCases,
          windowLabel: bucketLabel,
          caption: 'case arrivals per bucket',
          format: fmtInt,
          colorToken: 'primary',
        },
        drilldown: {
          key: 'total-cases',
          title: 'Total Cases',
          population: 'Every case that arrived in this window, policy-closed included.',
          // The whole cohort — no population predicate at all, so the rows the store
          // returns ARE the population and nothing about it is decided in the browser.
          match: () => true,
          populationResolvedBy: 'store',
          defaultRange: 'window',
          severityHistogram: bandHistogram,
          target: navigate
            ? {
                label: 'Open in Cases',
                honours: ['band', 'status', 'windowHours'],
                // NO status facet by default: the list must show the same undivided
                // cohort the numeral counts, so the Cases page's default active filter
                // is dropped. An operator's OWN facets travel, because every one of them
                // narrows the list they were already reading.
                onSelect: (ctx) =>
                  navigate('cases', {
                    ...(ctx.band ? { severity: ctx.band } : {}),
                    ...(ctx.status ? { status: ctx.status } : {}),
                    ...(ctx.windowHours != null ? { window: ctx.windowHours } : {}),
                  }),
              }
            : undefined,
        },
      },
      {
        label: 'Total Critical',
        testId: 'total-critical',
        value: typeof criticalCount === 'number' ? fmtNumber(criticalCount) : DASH,
        countTo: criticalCount,
        format: fmtInt,
        // `severity_counts` partitions `case_count` exactly, so numerator and
        // denominator come off ONE payload and describe one population.
        secondary: (covered ? shareContext(criticalCount, caseCount) : undefined) ?? DASH,
        sub: cohortSub(`${topBandLabel} band \u00b7 counted server-side`, BOUNDED_SAMPLE_SUB),
        icon: ShieldAlert,
        accent: 'critical',
        // No trend and no spark: there is no per-severity bucket series, and the Cases
        // severity filter applies exactly one band — an invented line here could not
        // be corroborated by anything the operator can open.
        goodDirection: 'down',
        drilldown: {
          key: 'total-critical',
          title: 'Total Critical',
          population: `Cases in the ${topBandLabel} band of this window's arrivals.`,
          match: (c) => bandOfCase(c) === TOP_SEVERITY_BAND,
          // The band is derived at READ time after paging and is stored, mapped and
          // materialised nowhere, so no store can filter or order by it. This predicate
          // can only run over the rows that were read, and the panel says so.
          populationResolvedBy: 'rows-read',
          defaultRange: 'window',
          severityHistogram: bandHistogram,
          target: navigate
            ? {
                label: 'Open in Cases',
                honours: ['band', 'status', 'windowHours'],
                onSelect: (ctx) =>
                  navigate('cases', {
                    severity: ctx.band ?? TOP_SEVERITY_BAND,
                    ...(ctx.status ? { status: ctx.status } : {}),
                    ...(ctx.windowHours != null ? { window: ctx.windowHours } : {}),
                  }),
              }
            : undefined,
        },
      },
      {
        label: 'Open Cases',
        testId: 'open-cases',
        value: typeof openNowCount === 'number' ? fmtNumber(openNowCount) : DASH,
        countTo: openNowCount,
        format: fmtInt,
        // A stock has no window denominator, and inventing one would invite reading it
        // as a fifth summand of the cohort tiles. The em dash plus the sub below say
        // exactly why there is none.
        secondary: DASH,
        sub:
          // `postureSub` already carries loading / error / NOT-MEASURED; only a real
          // measurement reaches the truncation wording below.
          postureSub ??
          (openNowComplete
            ? 'Open now · not window-filtered'
            : 'Open now · not window-filtered · lower bound'),
        icon: Workflow,
        accent: 'low',
        goodDirection: 'down',
        drilldown: {
          key: 'open-cases',
          title: 'Open Cases',
          population: 'Cases in a non-terminal state right now — not filtered by the window.',
          match: (c) => OPEN_STATUSES.has((c.status || '').toLowerCase()),
          // The SAME lifecycle set, resolved by the store instead of carved out of a
          // mixed page. The predicate above still runs, and now selects nothing the
          // request has not already selected.
          statusGroup: ACTIVE_STATUS_GROUP,
          populationResolvedBy: 'store',
          // A window-EXEMPT stock opens on an ALL-TIME page: scoping the list to the
          // dashboard window would hand the operator a shorter list than the number
          // they just clicked.
          defaultRange: 'all',
          severityHistogram: bandHistogram,
          target: navigate
            ? {
                label: 'Open in Cases',
                honours: ['band', 'status', 'windowHours'],
                // Deliberately carries NO `window` by default, for the same reason
                // (Cases defaults to the all-time horizon). It opens every non-terminal
                // status — the same lifecycle set the count is taken over — unless the
                // operator has already narrowed to ONE of those statuses, which is a
                // narrowing of their own and travels with them.
                onSelect: (ctx) =>
                  navigate('cases', {
                    status: ctx.status ?? ACTIVE_CASES_FILTER,
                    ...(ctx.band ? { severity: ctx.band } : {}),
                    ...(ctx.windowHours != null ? { window: ctx.windowHours } : {}),
                  }),
              }
            : undefined,
        },
      },
      {
        label: 'False Positive Rate',
        testId: 'false-positive-rate',
        value: typeof fpPercent === 'number' ? `${fpPercent}%` : DASH,
        countTo: fpPercent,
        format: formatWholePercent,
        // This numeral is ALREADY a percentage, so the missing half is its sample
        // size: the server's exact fp / verdicted counts behind the rate. Both halves
        // — and the rate above them — come off the same scan, so an uncovered window
        // withholds all of them rather than quoting a bounded ratio as fact.
        secondary:
          covered &&
          typeof quality?.false_positive_cases === 'number' &&
          typeof quality?.verdicted_cases === 'number' &&
          quality.verdicted_cases > 0
            ? `${fmtNumber(quality.false_positive_cases)} of ${fmtNumber(quality.verdicted_cases)} verdicted`
            : DASH,
        sub: cohortSub('Closed as false positive', BOUNDED_SAMPLE_SUB),
        icon: Percent,
        accent: 'medium',
        // The former two-point prev→cur spark drew a straight line that read as a
        // trend but was a single comparison, and the chip that explained it was
        // removed in Round 11. The honest per-bucket series is the hover card's.
        goodDirection: 'down',
        trend: {
          metric: 'False positive rate',
          points: bucketTrends?.fpRate,
          windowLabel: bucketLabel,
          caption: 'per case-arrival bucket · unverdicted buckets not measured',
          format: formatWholePercent,
          colorToken: 'medium',
        },
        drilldown: {
          key: 'false-positive-rate',
          title: 'False Positive Rate',
          // A RATE has no list. What a list can honestly show is its NUMERATOR, so the
          // panel says which half of the ratio it is showing rather than implying the
          // rows below add up to a percentage.
          population:
            'The rate\u2019s numerator: cases the agent verdicted false positive, ' +
            'excluding operator policy closes exactly as the rate itself does.',
          // The SAME population the server's rate counts. Its numerator and denominator
          // are both taken AFTER policy-closed cases are stripped — a case closed by an
          // operator's rule declaration never reached the agent, so no verdict of the
          // agent's exists for it — and listing such a case as part of "the rate's
          // numerator" would count a different population than the numeral above it.
          // Both fields the server predicate reads are on the wire, so this is the same
          // test rather than a disclosure that the two disagree.
          match: (c) =>
            (c.verdict || '').toLowerCase() === FALSE_POSITIVE_VERDICT && !isPolicyClosed(c),
          // `verdict` is not a query parameter on the case list and is deliberately not
          // becoming one, so this predicate runs over the rows that were read.
          populationResolvedBy: 'rows-read',
          defaultRange: 'window',
          severityHistogram: bandHistogram,
          target: navigate
            ? {
                // The rate itself, with its denominator, lives in the posture rollup —
                // the Cases list cannot state a rate. That rollup answers over its own
                // window, so it can honour none of the panel's narrowings.
                label: 'Open in Analytics',
                honours: [],
                onSelect: () => navigate('metrics', { tab: 'posture' }),
              }
            : undefined,
        },
      },
      {
        label: 'Resolved / Closed',
        testId: 'resolved-closed',
        value: typeof terminalCases === 'number' ? fmtNumber(terminalCases) : DASH,
        countTo: terminalCases,
        format: fmtInt,
        secondary: (covered ? shareContext(terminalCases, caseCount) : undefined) ?? DASH,
        sub: cohortSub('Reached a terminal state', BOUNDED_SAMPLE_SUB),
        breakdown: closeBreakdown,
        icon: ShieldCheck,
        accent: 'success',
        goodDirection: 'up',
        trend: {
          metric: 'Cases now closed',
          points: bucketTrends?.closed,
          windowLabel: bucketLabel,
          caption: 'by case-arrival bucket',
          format: fmtInt,
          colorToken: 'success',
        },
        drilldown: {
          key: 'resolved-closed',
          title: 'Resolved / Closed',
          population:
            'Cases from this window that reached a terminal state, declared-benign policy closes included.',
          match: (c) => CLOSED_STATUSES.has((c.status || '').toLowerCase()),
          // The SAME terminal set, resolved by the store. The predicate above still
          // runs, and now selects nothing the request has not already selected.
          statusGroup: TERMINAL_STATUS_GROUP,
          populationResolvedBy: 'store',
          defaultRange: 'window',
          severityHistogram: bandHistogram,
          target: navigate
            ? {
                label: 'Open in Cases',
                honours: ['band', 'status', 'windowHours'],
                // Terminal is TWO statuses and the Cases status filter applies exactly
                // one, so this used to have to settle for the posture view. It now uses
                // the `__terminal__` virtual facet Cases gained alongside this panel —
                // the same set `CLOSED_STATUSES` names here — unless the operator has
                // already narrowed to one of those two, which travels with them.
                onSelect: (ctx) =>
                  navigate('cases', {
                    status: ctx.status ?? TERMINAL_CASES_FILTER,
                    ...(ctx.band ? { severity: ctx.band } : {}),
                    ...(ctx.windowHours != null ? { window: ctx.windowHours } : {}),
                  }),
              }
            : undefined,
        },
      },
    ];
  }, [
    posture,
    postureCovered,
    postureUnmeasured,
    postureLoading,
    postureError,
    humanVsAi,
    hours,
    navigate,
    bucketTrends,
    trendFallbackLabel,
  ]);

  // ----- KPI drill-down disclosure ---------------------------------------- //
  /**
   * ONE panel at a time, docked under the strip. This is a DISCLOSURE, not a dialog:
   * the tile stays visible and comparable while its detail is open, Tab walks straight
   * out of the panel into the rest of the page, and nothing is inerted.
   *
   * The parent owns the open key (only it can render a sibling of the grid) and the
   * trigger refs (only it renders the tiles), so it also owns focus RETURN on close.
   */
  const announce = useAnnouncer();
  const [openKpi, setOpenKpi] = React.useState<string | null>(null);
  const tileEls = React.useRef(new Map<string, HTMLElement | null>());
  const tileRefSetters = React.useRef(new Map<string, (el: HTMLElement | null) => void>());
  /** A STABLE ref callback per tile id, so a re-render never detaches the trigger. */
  const tileRef = React.useCallback((key: string) => {
    let fn = tileRefSetters.current.get(key);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        tileEls.current.set(key, el);
      };
      tileRefSetters.current.set(key, fn);
    }
    return fn;
  }, []);

  const kpiLabel = React.useCallback(
    (key: string) => kpis.find((k) => k.testId === key)?.label ?? key,
    [kpis],
  );

  const closeKpiPanel = React.useCallback(() => {
    if (openKpi === null) return;
    setOpenKpi(null);
    announce(`${kpiLabel(openKpi)} details closed`);
    // Focus RETURN, WCAG 2.4.3. The tile's hover card opens on FOCUS, so this return
    // would otherwise pop it straight back over the strip — and not synchronously,
    // where `forceClosed` could still catch it, but on Radix's `openDelay` timer,
    // ~160ms later, when the panel is long gone. `MetricHoverTrend` therefore keeps
    // refusing opens for one `openDelay` after `forceClosed` falls; the ordering here
    // is not what makes this safe.
    tileEls.current.get(openKpi)?.focus();
  }, [openKpi, announce, kpiLabel]);

  const toggleKpiPanel = React.useCallback(
    (key: string) => {
      if (openKpi === key) {
        closeKpiPanel();
        return;
      }
      setOpenKpi(key);
      announce(`${kpiLabel(key)} details opened`);
    },
    [openKpi, closeKpiPanel, announce, kpiLabel],
  );

  /**
   * The open tile's full panel contract: what the tile declared, plus the two things
   * only the page knows — the selected window and the tile's honest server trend. The
   * trend is restated INSIDE the panel because the tile's hover card is suppressed
   * while the panel is open (and is unreachable by touch on a clickable tile at all),
   * so this is the surface that keeps the series available to every input mode.
   */
  const openKpiSpec = React.useMemo<KpiDrilldownSpec | null>(() => {
    if (!openKpi) return null;
    const item = kpis.find((k) => k.testId === openKpi);
    if (!item) return null;
    return {
      ...item.drilldown,
      windowHours: hours,
      trend: item.trend,
      // Opening one listed case carries NO window: the panel's own range can be wider
      // than the dashboard's (the open-case stock is all-time), and a window narrower
      // than the row the operator just clicked would hide the very case being opened.
      onOpenCase: navigate ? (caseId: string) => navigate('cases', { caseId }) : undefined,
    };
  }, [openKpi, kpis, hours, navigate]);

  // ----- Noise-Reduction funnel drill-through ----------------------------- //
  const onStageClick = React.useCallback(
    (key: string) => {
      if (!navigate) return;
      switch (key) {
        case 'escalated':
          navigate('cases', { noiseOutcome: 'escalated', window: navWindow });
          break;
        case 'auto_cleared':
          navigate('cases', { noiseOutcome: 'auto_cleared', window: navWindow });
          break;
        case 'closed':
          navigate('cases', { noiseOutcome: 'closed', window: navWindow });
          break;
        default:
          navigate('cases', { window: navWindow });
      }
    },
    [navigate, navWindow],
  );

  const onOpenCasesClick = React.useCallback(() => {
    if (!navigate) return;
    navigate('cases', { status: ACTIVE_CASES_FILTER, window: navWindow });
  }, [navigate, navWindow]);

  // ----- The header control cluster --------------------------------------- //
  const headerControls = (
    <>
      <TimeRangePicker
        value={range}
        onChange={setRange}
        refresh={refresh}
        onRefreshChange={setRefresh}
        onRefreshTick={refreshAll}
        size="sm"
        chrome="command"
      />
      <Button
        variant="outline"
        size="icon"
        onClick={refreshAll}
        aria-label="Refresh dashboard"
        title="Refresh"
        className={cn(
          'h-8 w-8 rounded-[3px] border-border/70 bg-transparent text-muted-foreground shadow-none hover:border-border-strong hover:bg-hover hover:text-foreground',
          refresh === 'live' && 'text-success-text hover:text-success-text',
        )}
      >
        <RefreshCw
          className={cn('h-4 w-4', (loading || refresh === 'live') && 'animate-spin')}
          aria-hidden
        />
      </Button>
    </>
  );

  // ----- Blocking load uses the Console's one centered motion grammar. ---- //
  if (loading && !cases.length && !metrics) {
    return (
      <PageContainer variant="wide">
        <LoadingState label="Loading dashboard" layout="page" shape="page" />
      </PageContainer>
    );
  }

  const empty = !loading && !error && cases.length === 0 && !metrics?.total_cases;
  const noiseUnavailable = noiseLoad.availability === 'unavailable';
  const noiseCellVisible = Boolean(noise) || noiseUnavailable;
  const usageUnavailable = usageLoad.availability === 'unavailable';
  const usageFailureSub = usage
    ? `Last loaded ${fmtMoney(usage.total_cost, usage.currency)} · Retry spend telemetry`
    : 'Retry spend telemetry';

  return (
    <PageContainer variant="wide" className="space-y-4">
      {/* ---- MASTHEAD: a PLAIN, dense header (the big title sits flush on the page
             background, like the Sources page) with the time-range + refresh controls in
             its `actions` slot. ---- */}
      <PageHeader
        data-testid="page-hero"
        title={PAGE_TITLE}
        actions={
          <div
            role="group"
            aria-label="Dashboard controls"
            className="flex flex-wrap items-center gap-2"
          >
            {headerControls}
          </div>
        }
      />

      {/* Recommended-automation nudge — only in the non-empty state, only for a
          principal who can act (AutomationNudge self-hides otherwise). */}
      {showNudge && !empty ? (
        <AutomationNudge
          onEnabled={() => {
            setShowNudge(false);
            refreshAll();
          }}
          onReview={() => navigate?.('tuning')}
          onDismiss={dismissNudge}
        />
      ) : null}

      {/* Healthy diagnostics cost no Overview space. A positively detected failure
          becomes one compact strip and one canonical Analytics drill-through. The
          component retains the independent RBAC and older-proxy guards. */}
      {healthAvailable ? (
        <HealthDegradationIndicator windowHours={hours} onNavigate={navigate} />
      ) : null}

      {error ? (
        <LoadError error={error} title="Could not load the dashboard" onRetry={refreshAll} />
      ) : null}

      {empty ? (
        <EmptyState
          icon={Gauge}
          title="No triage activity yet"
          description="Once sources are connected and cases start flowing, your posture, risk index, and timing metrics will appear here."
          action={
            <>
              {navigate ? (
                <Button onClick={() => navigate('sources')}>Connect a source</Button>
              ) : null}
              <StartDemoButton onStarted={refreshAll} />
            </>
          }
        />
      ) : (
        <div className="space-y-4">
          {/* ---- KPI STRIP — flat, un-nested, responsive by COLUMN COUNT ---- */}
          <div className="space-y-1.5">
            <Stagger
              data-testid="kpi-strip"
              className="grid grid-cols-1 border-y border-border sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
              /*
               * Exact divider math for FIVE tiles at 1 / 2 / 3 / 5 columns. A cell may
               * never draw a hairline into empty space or lose the rule that separates
               * it from the next row (ui-standard, operational metric surfaces):
               *   - column rule: on for every cell that HAS a right-hand neighbour, so
               *     it is off at 1 column, off for cells 2·4 at 2 columns, off for
               *     cell 3 at 3 columns, and always off for the last cell;
               *   - row rule: off for the cells in the final row — cell 5 at 1/2
               *     columns, cells 4·5 at 3 columns, all of them at 5 columns.
               * `:last-child` / `:nth-child()` outrank the plain utilities, so the
               * per-breakpoint overrides resolve deterministically.
               */
              itemClassName={cn(
                'h-full min-w-0 border-b border-r-0 border-border/70 last:border-b-0 last:border-r-0',
                'sm:border-r sm:[&:nth-child(2n)]:border-r-0',
                'md:[&:nth-child(2n)]:border-r md:[&:nth-child(3n)]:border-r-0 md:[&:nth-child(n+4)]:border-b-0',
                'xl:border-b-0 xl:[&:nth-child(2n)]:border-r xl:[&:nth-child(3n)]:border-r',
              )}
            >
              {kpis.map((kpi) => {
                const expanded = openKpi === kpi.testId;
                const tile = (
                  <KpiTile
                    ref={tileRef(kpi.testId)}
                    label={kpi.label}
                    testId={kpi.testId}
                    value={kpi.value}
                    secondary={kpi.secondary}
                    sub={kpi.sub}
                    icon={kpi.icon}
                    accent={kpi.accent}
                    variant="strip"
                    goodDirection={kpi.goodDirection}
                    countTo={kpi.countTo}
                    format={kpi.format}
                    breakdown={kpi.breakdown}
                    onClick={() => toggleKpiPanel(kpi.testId)}
                    // The tile is now a DISCLOSURE trigger, so it states its expanded
                    // state. `aria-controls` is emitted only while the panel is really
                    // in the DOM — a dangling id is an invalid attribute value.
                    ariaExpanded={expanded}
                    ariaControls={expanded ? KPI_PANEL_ID : undefined}
                  />
                );
                // Hover/focus reveals the metric's honest trend; the tile is itself the
                // focus stop, so the wrapper adds no second tab stop. While this tile's
                // panel is open the card is FORCED closed: it opens on focus (so the
                // focus return on close would pop it straight back), it renders over the
                // docked panel, and its dismissable layer would eat the Escape the panel
                // needs. The panel restates the same series, so nothing is lost.
                return kpi.trend ? (
                  <MetricHoverTrend
                    key={kpi.testId}
                    {...kpi.trend}
                    focusable={false}
                    forceClosed={expanded}
                    side="bottom"
                  >
                    {tile}
                  </MetricHoverTrend>
                ) : (
                  <React.Fragment key={kpi.testId}>{tile}</React.Fragment>
                );
              })}
            </Stagger>
            {bucketTrends ? (
              <p className="px-0.5 text-2xs text-muted-foreground">
                {/* Device-honest affordance copy: hover-capable inputs get the
                    hover/focus instruction; touch-only devices (hover: none) are
                    told to tap — the trend card toggles on tap there. Both spans
                    ship; the CSS media variant picks exactly one. */}
                <span className="hidden [@media(hover:hover)]:inline">
                  Hover or focus a metric for its {bucketTrends.label} trend.
                </span>
                <span className="[@media(hover:hover)]:hidden">
                  Tap a metric for its {bucketTrends.label} trend.
                </span>
              </p>
            ) : null}

            {/* The drill-down disclosure. A SIBLING of the grid, never a sixth child of
                it: the strip carries hand-tuned `nth-child` divider math for exactly
                five cells, and a sixth would silently redraw every hairline. */}
            {openKpiSpec ? (
              <KpiDrilldownPanel
                spec={openKpiSpec}
                panelId={KPI_PANEL_ID}
                headingId={KPI_PANEL_HEADING_ID}
                onClose={closeKpiPanel}
              />
            ) : null}
          </div>

          {/* ---- INSTRUMENT BAND: close attribution · case state · live queue ---- */}
          <Reveal
            variant="rise"
            delay={40}
            data-testid="hero-row"
            className="grid min-w-0 items-stretch border-y border-border lg:grid-cols-12"
          >
            {/* Close attribution — the band's lead instrument (it replaced the Active
                Risk Index, whose gauge duplicated risk the page already states in the
                severity donuts, the risk-ordered queue, and every case row). */}
            <div className="min-w-0 border-b border-border/70 lg:col-span-4 lg:border-b-0 lg:border-r">
              <HumanVsAiCard
                totals={humanVsAi.totals}
                unavailableReason={humanVsAi.reason}
                series={humanVsAi.series}
                windowLabel={bucketTrends?.label ?? trendFallbackLabel}
                truncated={humanVsAi.truncated}
                stale={humanVsAi.stale}
                alertsIngested={humanVsAi.alerts}
                className="h-full w-full"
              />
            </div>

            <section
              aria-label="Resolved and open cases"
              className="min-w-0 border-b border-border/70 px-3 lg:col-span-4 lg:border-b-0 lg:border-r"
            >
              <SnapshotCard
                title="Open cases"
                caption={`Still open from the last ${windowLabel(hours)}`}
                total={derived.open}
                delta={countDelta(derived.open, prev?.open ?? null)}
                goodDirection="down"
                counts={derived.openSev}
                ariaLabel="Open cases by severity"
                ctaLabel="View open cases"
                trend={{
                  metric: 'New cases opened',
                  points: bucketTrends?.newCases,
                  windowLabel: bucketTrends?.label ?? trendFallbackLabel,
                  caption: 'case arrivals per bucket',
                  format: fmtInt,
                  colorToken: 'primary',
                }}
                onClick={navigate
                  ? () => navigate('cases', { status: ACTIVE_CASES_FILTER, window: navWindow })
                  : undefined}
              />
              <SnapshotCard
                title="Cases resolved"
                caption={`Closed in the last ${windowLabel(hours)}`}
                total={derived.resolved}
                delta={countDelta(derived.resolved, prev?.resolved ?? null)}
                goodDirection="up"
                counts={derived.resolvedSev}
                ariaLabel="Resolved cases by severity"
                ctaLabel="View resolved cases"
                trend={{
                  metric: 'Cases now closed',
                  points: bucketTrends?.closed,
                  windowLabel: bucketTrends?.label ?? trendFallbackLabel,
                  caption: 'by case-arrival bucket',
                  format: fmtInt,
                  colorToken: 'success',
                }}
                // `derived.resolved` counts BOTH terminal statuses (`CLOSED_STATUSES`),
                // so the deep link must too: the Cases status filter applies exactly
                // one status, and `status: 'closed'` silently dropped every RESOLVED
                // case — a card reading 1 landing on an empty list. Same `__terminal__`
                // facet the Resolved / Closed KPI drill-through uses.
                onClick={
                  navigate
                    ? () =>
                        navigate('cases', { status: TERMINAL_CASES_FILTER, window: navWindow })
                    : undefined
                }
              />
            </section>

            <div className="min-w-0 lg:col-span-4">
              <TopCasesPanel
                cases={latestCases}
                navigate={navigate}
                navWindow={navWindow}
              />
            </div>
          </Reveal>

          {/* ---- OPERATIONS BAND: wide noise flow + compact burndown/timing rail ---- */}
          <Reveal
            variant="rise"
            delay={70}
            className="grid min-w-0 border-y border-border xl:grid-cols-12"
          >
            {noiseCellVisible ? (
              <div className="min-w-0 border-b border-border/70 p-4 xl:col-span-8 xl:border-b-0 xl:border-r">
                {noiseUnavailable ? (
                  <EmptyState
                    data-testid="noise-reduction-unavailable"
                    icon={Workflow}
                    variant="error"
                    compact
                    title="Noise reduction unavailable"
                    description={
                      noise
                        ? 'Refresh failed. Showing the last loaded flow.'
                        : "The selected window's noise-reduction flow could not be loaded."
                    }
                    action={
                      <Button size="sm" variant="outline" onClick={() => void retryNoise()}>
                        <RefreshCw aria-hidden />
                        Retry noise reduction
                      </Button>
                    }
                    className={cn(
                      'rounded-md border border-critical/30 bg-transparent',
                      noise && 'mb-3',
                    )}
                  />
                ) : null}
                {noise ? (
                  <NoiseFunnel
                    data={noise}
                    onStageClick={onStageClick}
                    openCases={{
                      count: posture?.aging.queue_depth ?? derived.open,
                      // `queue_depth` is COHORT-scoped (open cases that arrived in the
                      // window), so its completeness is the window's: `#103`'s
                      // `window_covered`, not the permanent `truncated` flag. Without a
                      // posture rollup the fallback count is the fetched page, whose
                      // completeness the store now proves via `window_total_exact` —
                      // replacing a `cases.length >= 200` guess that disagreed with the
                      // posture branch a few lines up.
                      partial: posture
                        ? !postureCovered
                        : !(caseWindow?.exact === true && caseWindow.total <= cases.length),
                    }}
                    onOpenCasesClick={onOpenCasesClick}
                    hidden={noiseHidden}
                    onToggleHidden={toggleNoiseHidden}
                    expandable
                    variant="flat"
                    className="w-full"
                  />
                ) : null}
              </div>
            ) : null}

            <div
              className={cn(
                'min-w-0',
                noiseCellVisible ? 'xl:col-span-4' : 'md:grid md:grid-cols-2 xl:col-span-12',
              )}
            >
              <section aria-label="Cases burndown" className="border-b border-border/70 p-4 md:border-r xl:border-r-0">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">
                      Cases burndown
                    </h2>
                    <p className="mt-0.5 text-2xs text-muted-foreground">opened vs resolved over time</p>
                  </div>
                  {/* A real legend keyed to the chart's status-axis tokens (was "opn vs res"). */}
                  <span className="flex shrink-0 items-center gap-3 text-2xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden />
                      Opened
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
                      Resolved
                    </span>
                  </span>
                </div>
                <div className="mt-3">
                  <BurnDownChart
                    data={burndownData}
                    height={126}
                    openLabel="Opened"
                    closedLabel="Resolved"
                    format={fmtInt}
                    ariaLabel="Cases opened vs resolved over time"
                  />
                </div>
              </section>

              <section aria-label="Mean time to detect / respond" className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">
                      MTTD / response
                    </h2>
                    <p className="mt-0.5 text-2xs text-muted-foreground">p50 · server-computed</p>
                  </div>
                  {navigate ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-2xs"
                      onClick={() => navigate('metrics', { tab: 'posture' })}
                    >
                      Detail →
                    </Button>
                  ) : null}
                </div>
                <div className="mt-3 grid grid-cols-2 divide-x divide-border/70">
                  <div className="pr-4">
                    <MetricHoverTrend
                      metric="MTTD · daily mean"
                      points={timingTrends?.mttd}
                      windowLabel={timingTrends?.label ?? trendFallbackLabel}
                      format={humanizeMins}
                      colorToken="info"
                      side="top"
                    >
                      <TimingStat
                        label="MTTD"
                        sub="Detect · log arrival → case"
                        block={mttdBlock}
                        dotClass="bg-info"
                        compact
                        help="Mean time to detect: the cluster's first event → case-open. Shown as an honest n/a when no case carries a first-event instant."
                      />
                    </MetricHoverTrend>
                  </div>
                  <div className="pl-4">
                    <MetricHoverTrend
                      metric="Respond · daily mean"
                      points={timingTrends?.respond}
                      windowLabel={timingTrends?.label ?? trendFallbackLabel}
                      format={humanizeMins}
                      colorToken="success"
                      side="top"
                    >
                      <TimingStat
                        label="Respond"
                        sub="First human action e.g. assignment / ack"
                        block={respondBlock}
                        dotClass="bg-success"
                        compact
                        help="Mean time to respond — the first active human response (investigating / escalated / assignment / ack)."
                      />
                    </MetricHoverTrend>
                  </div>
                </div>
              </section>
            </div>
          </Reveal>

          {/* ---- DEEPER ANALYTICS (collapsed by default) ---- */}
          <DashboardGroup
            title="Deeper analytics"
            defaultOpen={false}
            description="timing, autonomy, cost, volume, connectors & workload"
            contentClassName="space-y-4"
          >
            {/* Full response timing (MTTA · MTTR · Dwell) + spend tripwire */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {timing.map((s) => {
                // Honest per-metric series: MTTA reuses the ACK-based `respond` daily
                // series, MTTR the `resolve` series. Dwell has NO server series at all,
                // so its tile carries no trend affordance — never a borrowed trend.
                const timingSeries =
                  s.key === 'mtta'
                    ? timingTrends?.respond
                    : s.key === 'mttr'
                      ? timingTrends?.resolve
                      : undefined;
                const tile = (
                  <KpiTile
                    variant="bar"
                    label={s.label}
                    value={s.value}
                    sub={s.sub}
                    accent={s.accent}
                    icon={Clock3}
                    goodDirection="down"
                    help={s.help}
                  />
                );
                if (s.key === 'dwell') {
                  return <React.Fragment key={s.label}>{tile}</React.Fragment>;
                }
                return (
                  <MetricHoverTrend
                    key={s.label}
                    metric={`${s.label} · daily mean`}
                    points={timingSeries}
                    windowLabel={timingTrends?.label ?? trendFallbackLabel}
                    format={humanizeMins}
                    colorToken={s.accent}
                    side="top"
                    // The tile's HelpTip (?) button is already a tab stop and focus
                    // bubbles to the trigger (Radix opens the card on trigger focus),
                    // so the wrapper must not add a second stop; the tile itself is
                    // not clickable, so a press explicitly toggles the card (touch).
                    focusable={false}
                    toggleOnClick={true}
                  >
                    {tile}
                  </MetricHoverTrend>
                );
              })}
              <MetricHoverTrend
                metric="LLM spend"
                points={spendTrend}
                windowLabel={trendFallbackLabel}
                format={(n) => fmtMoney(n, usage?.currency)}
                colorToken="primary"
                // The tile is itself a button (retry / drill-through) whenever an
                // action exists; only a nav-less static tile needs the wrapper stop.
                focusable={!(usageUnavailable || Boolean(navigate))}
                side="top"
              >
                <KpiTile
                  variant="bar"
                  testId="llm-spend-detail"
                  label="LLM spend"
                  value={usageUnavailable ? 'Unavailable' : fmtMoney(usage?.total_cost, usage?.currency)}
                  sub={
                    usageUnavailable
                      ? usageFailureSub
                      : typeof usage?.total_tokens === 'number'
                      ? `${fmtTokens(usage.total_tokens)} tokens · ${fmtNumber(usage.call_count)} calls`
                      : 'No spend recorded'
                  }
                  icon={CircleDollarSign}
                  accent={usageUnavailable ? 'critical' : 'primary'}
                  goodDirection="down"
                  onClick={
                    usageUnavailable
                      ? () => void retryUsage()
                      : navigate
                        ? () => navigate('metrics', { tab: 'cost' })
                        : undefined
                  }
                  className={usageUnavailable ? 'border-critical/30' : undefined}
                />
              </MetricHoverTrend>
            </div>

            {/* Connector health. The former "Autonomous vs human" card that sat beside
                it was REMOVED: it re-stated the Human-vs-AI instrument's story with a
                third denominator (auto / (auto + escalated)) that matched neither the
                server's `automation_rate` nor the closed-case partition. Its #3
                advisory now lives on that one instrument. */}
            <Reveal variant="rise" className="grid gap-4">
              <DashboardGroup title="Ingest coverage" description="am I seeing everything?">
                <Card>
                  <CardContent className="py-4">
                    {coverage ? (
                      <CoverageTile coverage={coverage} onNavigate={navigate} />
                    ) : (
                      <EmptyState
                        compact
                        icon={Plug}
                        title="Coverage not yet reported"
                        description="Per-source ingest coverage appears once the poller reports its first tick."
                      />
                    )}
                  </CardContent>
                </Card>
              </DashboardGroup>
            </Reveal>

            {/* Case-volume trend · workload state */}
            <Reveal variant="rise" className="grid gap-4 xl:grid-cols-2">
              <DashboardGroup title="Case volume" description="cases opened over time">
                <Card>
                  <CardContent className="py-4">
                    <TrendArea
                      data={caseVolume}
                      height={180}
                      colorToken="primary"
                      format={(n) => fmtNumber(n)}
                      ariaLabel="Case volume over time"
                    />
                  </CardContent>
                </Card>
              </DashboardGroup>

              <DashboardGroup title="Case workload state" count={workloadItems.length}>
                <Card>
                  <CardContent className="py-4">
                    {workloadItems.length ? (
                      <ul className="flex flex-col gap-3.5">
                        {workloadItems.map(({ status, value }) => {
                          const total = workloadItems.reduce((a, w) => a + w.value, 0) || 1;
                          const pct = Math.round((value / total) * 100);
                          const clickable = !!navigate;
                          return (
                            <li key={status}>
                              <button
                                type="button"
                                disabled={!clickable}
                                onClick={
                                  clickable
                                    ? () => navigate?.('cases', { status, window: navWindow })
                                    : undefined
                                }
                                className={cn(
                                  'block w-full rounded-md text-left',
                                  clickable &&
                                    '-mx-1 px-1 py-0.5 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                )}
                                aria-label={clickable ? `View ${humanizeToken(status)} cases` : undefined}
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <span className="truncate text-sm font-medium text-foreground">
                                    {humanizeToken(status)}
                                  </span>
                                  <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                    {fmtNumber(value)}
                                  </span>
                                </div>
                                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                  <div
                                    className={cn('h-full rounded-full', statusBar(status))}
                                    style={{ width: `${Math.min(100, pct)}%` }}
                                    role="progressbar"
                                    aria-valuenow={pct}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-label={humanizeToken(status)}
                                  />
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <EmptyState
                        compact
                        icon={Workflow}
                        title="No workload"
                        description="Case lifecycle distribution will appear here."
                      />
                    )}
                  </CardContent>
                </Card>
              </DashboardGroup>
            </Reveal>

            {/* Case outcomes (verdict mix) · top signatures · top entities */}
            <Reveal variant="rise" className="grid gap-4 xl:grid-cols-3">
              <DashboardGroup title="Case outcomes" count={verdictMix.total} description="verdict mix">
                <Card>
                  <CardContent className="py-4">
                    {verdictMix.total > 0 ? (
                      <div className="flex flex-col items-center gap-4 sm:flex-row">
                        <DonutChart
                          segments={verdictMix.segments}
                          height={150}
                          className="w-full shrink-0 sm:w-36"
                          ariaLabel="Case outcomes by verdict"
                          center={
                            <>
                              <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
                                {fmtNumber(verdictMix.total)}
                              </span>
                              <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                                verdicts
                              </span>
                            </>
                          }
                        />
                        <ul className="w-full space-y-2">
                          {verdictMix.segments.map((s) => {
                            const pct = Math.round((s.value / verdictMix.total) * 100);
                            return (
                              <li key={s.label} className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: s.color }}
                                  aria-hidden
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                  {s.label}
                                </span>
                                <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                  {fmtNumber(s.value)}
                                </span>
                                <span className="w-9 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                                  {pct}%
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : (
                      <EmptyState
                        compact
                        icon={ShieldCheck}
                        title="No verdicts yet"
                        description="The agent's verdict mix will appear here as cases are triaged."
                      />
                    )}
                  </CardContent>
                </Card>
              </DashboardGroup>

              <DashboardGroup
                title="Top signatures"
                count={signatureItems.length}
                description="most frequent detections"
              >
                <Card>
                  <CardContent className="py-4">
                    <BarList items={signatureItems} showRank showPercent emptyLabel="No signatures yet" />
                  </CardContent>
                </Card>
              </DashboardGroup>

              <DashboardGroup
                title="Top entities"
                count={entityItems.length}
                description="most-implicated assets"
              >
                <Card>
                  <CardContent className="py-4">
                    <BarList items={entityItems} showRank showPercent emptyLabel="No entities yet" />
                  </CardContent>
                </Card>
              </DashboardGroup>
            </Reveal>
          </DashboardGroup>
        </div>
      )}
    </PageContainer>
  );
}
