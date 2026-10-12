/**
 * Overview — the Cyber Defence Center (default landing surface).
 *
 * A dense command-center dashboard adapted from the operator-provided Stitch concept:
 *
 *   ┌ MASTHEAD ─── a PLAIN, dense <PageHeader> (no card / no glow — the big title sits
 *   │             flush on the page background, like the Sources page) carrying the
 *   │             <TimeRangePicker> + auto-refresh + a manual refresh pulse in its `meta`
 *   │             slot, i.e. BESIDE the title on the left. The right half is deliberately
 *   │             empty: the page's search lives in the app shell's top bar, one band up.
 *   ├ KPI STRIP ── five borderless, SERVER-FED telemetry cells separated by hairlines:
 *   │             Total Cases · Total Critical · Open Cases · AI-verdict FP rate ·
 *   │             Resolved / Closed · Auto Closed, at `density="comfortable"` with fluid
 *   │             numerals (Round 12). Four are cohort numbers scoped to the
 *   │             selected window; "Open Cases" is a window-EXEMPT stock and says so, so
 *   │             it is never read as a fifth summand. Each cell OPENS its own drill-down
 *   │             modal (see "Drill-down" further down).
 *   ├ BANDS ────── Round 12: flat TITLED bands separated by whitespace (32px between,
 *   │             24px gutters; no cards, no per-cell rules):
 *   │               "Alert flow"          Noise-Reduction flow (8) · Human vs AI (4)
 *   │               "Cases and response"  case state (5) · response time (3) · queue (4)
 *   │             The flow leads because it is the page's widest instrument and its own
 *   │             container query needs 608px of cell width to draw a graph at all. At
 *   │             `4xl` (≥2200px) both bands share a main column + a 460px rail.
 *   └ DEEPER ───── ONE persisted "Deeper analytics" disclosure (flat inside: a second
 *                  strip — MTTA · MTTR · Dwell · LLM spend — then coverage, volume,
 *                  workload, outcomes, top signatures/entities), with a one-line summary
 *                  of what it holds while collapsed.
 *
 * Opening a case from the latest-case queue or from a drill-down row does NOT navigate:
 * it mounts the shared <CaseDetail> in its right-hand sheet over this page, so the
 * numerals stay on screen behind it. The mount is conditional (see the bottom of the
 * render) because CaseDetail reads auth context unconditionally.
 *
 * Data: `usePosture(hours, 'prev')` is the AUTHORITATIVE server-side lifecycle rollup
 * (MTTA/MTTR/dwell/MTTD p50 + SLA + quality rates + period-over-period deltas). It is
 * STALE-WHILE-REVALIDATE: a window change keeps the last successful snapshot mounted
 * (marked by the tiles' "Loading Nh" sub) instead of blanking every posture consumer.
 * `listCases` (current + previous window), `getMetrics` (timing_trend + by_status),
 * `usageSummary`, `noiseReduction`, and `metricsTrends` (the hover-trend
 * bucket series) are fetched with allSettled so one failing call degrades a single
 * widget, never the page; a superseded window's late-settling batch is discarded.
 * Usage and Noise Reduction keep independent availability/error state: a failed refresh
 * retains the last usable value, names the unavailable slice, and offers a slice-only
 * Retry. `noiseReduction`/`sourcesCoverage`/`metricsTrends` are typeof-guarded so a
 * minimal test/mock surface can still omit the optional contracts.
 *
 * Drill-down: every strip tile is a DIALOG trigger (`aria-haspopup="dialog"`). Activating
 * one opens a portalled MODAL over the page, carrying that tile's own population with
 * filtering, sorting and its own time range — plus, for Resolved / Closed, the
 * whole-window close-attribution partition that used to sit on the tile face. Reading it
 * alongside the other four numerals is what the panel's own metric switcher answers, not
 * the page behind the scrim. The full-list deep link survives as the panel's
 * drill-through, and the panel is where a touch device reaches the tile's trend, since the
 * hover card is force-closed for as long as the panel is up. One panel at a time; Escape
 * closes it and this page returns focus to the tile that opened it.
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
  ChevronDown,
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
import {
  KpiTile,
  KpiTileGrid,
  type KpiAccent,
  type KpiBreakdownRow,
} from '@/soc/components/KpiTile';
import { kpiTopic } from '@/soc/components/ask-topics';
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
import { useOptionalPrefs } from '@/soc/prefs';
import { Reveal } from '@/soc/components/Reveal';
import { CountUp } from '@/soc/components/CountUp';
import { Stagger } from '@/soc/components/Stagger';
import { DonutChart, type DonutSegment } from '@/soc/components/charts';
import { token, VERDICT_COLOR, type VerdictKey } from '@/soc/components/palette';
import {
  SEVERITY_BAND_ORDER,
  isAutoClosedByAI,
  severityBand,
  severityBandFromNumber,
} from '@/soc/components/badges';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { AutomationNudge } from './AutomationNudge';
import { CaseDetail } from '@/soc/pages/CaseDetail';
import { StartDemoButton } from '@/soc/components/StartDemoButton';
import { usePosture } from '@/soc/hooks/usePosture';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';
import { caseOutcome } from '@/soc/components/outcome';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
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
 * ONE containment sentence, used verbatim as the Auto Closed tile's accessible help, its
 * drill-down population, and — through both — the thing a reader arrives at from either
 * direction. It is a single constant precisely so the three can never drift into saying
 * different things about the same numeral.
 */
const AUTO_CLOSED_POPULATION =
  'A SUBSET of Resolved / Closed, not a sixth independent total. Counted over the ' +
  'agent-worked population only — cases an operator closed under a "declared benign" ' +
  'rule policy are excluded, exactly as the automation rate beside it excludes them.';

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
 * The KPI drill-down dialog's DOM ids. One panel is open at a time — the operator moves
 * between populations with the panel's own metric switcher rather than by stacking panels
 * — so a single set of static ids is correct. The panel derives its `aria-describedby`
 * target (the population sentence) from the panel id, so the two can never drift apart.
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
 * ~66px (innerPct=52% of the 128px ring) with `overflow-hidden` as a
 * deliberate anti-overlap guardrail — a 4+ digit total in `fmtInt`'s
 * thousands-separated form (e.g. "1,234") is wider than the hole and gets
 * clipped rather than overlapping the ring. Abbreviate >=1000 (e.g. "1.2K") so
 * the center always fits; the legend rows beside it keep their exact,
 * unabbreviated counts via `fmtNumber`.
 *
 * The ring is 128 (`SNAPSHOT_RING_PX`, Round 12) and the hole 0.52 × 128 ≈ 66px. The
 * widest string REACHABLE here is four characters ("1.2K") at `text-2xl` — ~48px of
 * tabular Inter — so the hard floor is ~93px (48 / 0.52) and 128 keeps a deliberate
 * margin above it.
 *
 * Two things that margin is carrying, so do not spend it:
 *   - `fmtTokens` itself is not bounded at four characters: at >= 10,000 it drops the
 *     decimal, so 1,000,000 would be "1000K" (5ch) and 12,345,678 "12346K". Those are
 *     unreachable only because `derived.open`/`derived.resolved` count a `limit: 200`
 *     page — an unrelated fetch cap, not a property of this formatter.
 *   - the hole is a PX literal (`DonutChart height`), while the numeral is sized in rem.
 *     A reader at a 150% root font scales the text and not the ring, so the margin is
 *     also the accessibility headroom (WCAG 1.4.4). The legend beside the ring always
 *     carries the exact, unabbreviated count, so a clipped centre is never the only
 *     statement of the number — but it would still be a plausible-looking wrong one,
 *     since the centre is `overflow-hidden` and centred.
 */
const fmtSnapshotCenter = (n: number): string => fmtTokens(n);

/**
 * The snapshot donut's ring, in px (Round 12: 112 → 128 now that the two snapshots sit
 * side by side wherever their cell is at least 35rem wide). The hole is 0.52 × 128 ≈ 66px,
 * which clears the widest centre string ("1.2K" at `text-2xl`) with the margin the note
 * above asks for.
 */
const SNAPSHOT_RING_PX = 128;
/**
 * The ring from 1920px up (Round 12 review): there the snapshots sit over the response
 * pair while the queue beside them holds eight rows, and a 128px ring left the snapshot row
 * short of the queue it shares the band with. 192px (hole ≈ 100px) fills the extra height
 * with the instrument itself instead of blank space; the legend spreads to match.
 */
const SNAPSHOT_RING_WIDE_PX = 192;

/**
 * The Case outcomes donut (Deeper analytics). 160px at a 0.3 ring leaves a ~78px hole —
 * room for the total over a 12px sentence-case "AI verdicts" caption, which the old
 * 150px ring with tracked uppercase "VERDICTS" overflowed onto the ring.
 */
const VERDICT_RING_PX = 160;

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

/**
 * Period-over-period change of a COUNT, stated the way an operator can check it, or null
 * when there is no honest baseline (no previous window, prev == 0, or an exactly-flat move).
 *
 * A percentage is only honest on a base big enough to carry one: 2 → 10 open cases is
 * "+400%", which reads as an emergency and says less than "+8". So below a base of 20, or
 * whenever the move is 100% or more, the chip states the absolute difference; otherwise
 * it keeps the percentage. Either way `detail` spells out both counts for the tooltip.
 */
function countDelta(
  cur: number,
  prev: number | null,
): { value: number; label: string; detail: string } | null {
  if (prev == null || prev <= 0) return null;
  const diff = cur - prev;
  if (diff === 0) return null;
  const sign = diff > 0 ? '+' : '';
  const detail = `${fmtNumber(prev)} → ${fmtNumber(cur)} vs the previous window`;
  const pct = Math.round((diff / prev) * 1000) / 10;
  if (prev < 20 || Math.abs(pct) >= 100) {
    return { value: diff, label: `${sign}${fmtNumber(diff)}`, detail };
  }
  return { value: pct, label: `${sign}${pct}%`, detail };
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
  /**
   * STATE disclosures only — "Loading 24h", "Posture unavailable", or the server's own
   * account of a window it could not measure. Descriptive captions moved to `help` and a
   * conditional bound moved to `bound`; what is left is the one kind of sentence worth
   * the strip's height, because it says the numeral above it cannot be trusted yet.
   */
  sub?: string;
  /**
   * The conditional BOUND on this numeral, when one is in force. Rendered as a mark ON
   * the number rather than as a caption under it — see `KpiTileProps.bound`. Never
   * populated in the same render as an outage `sub`: a window that measured nothing has
   * no floor to state, and calling its structural zeros a lower bound would be a lie.
   */
  bound?: string;
  /**
   * The tile's longer explanation, on a keyboard- and touch-reachable help popover. This
   * is where a descriptive caption lives once it is off the face: the sentence an
   * operator needs the first few times and never again. Conditional bounds NEVER move
   * here — they are visible exactly when they are true, which is the whole of their value.
   */
  help?: string;
  /**
   * The numeral's "compared to what?", shown on its own line under it ("18% of 43 cases",
   * "33 of 44 verdicted"). `undefined` when there is no honest denominator to state —
   * a window that was not fully covered withholds it, and then the line carries the
   * tile's `bound` instead. Never a `delta`, and never a sentence about the metric.
   */
  context?: string;
  icon: LucideIcon;
  accent: KpiAccent;
  goodDirection: 'up' | 'down' | 'none';
  /**
   * The tile's drill-down. Activating a tile no longer navigates: it opens the deep-
   * inspection MODAL, where the population can be filtered, sorted and re-ranged. The five
   * numerals travel with it — the panel's own metric switcher restates every tile's label
   * and rendered value and re-points without closing — so comparison survives the scrim.
   * The full-list deep link survives as the panel's `target`, so nothing that used to be
   * one click away is now unreachable: it is one click further, behind context.
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
  delta: { value: number; label: string; detail?: string } | null;
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
      title={delta.detail}
      // Borderless tinted text (Round 12): a bordered pill per snapshot was one of the
      // competing boxes around the case-state cell. The colour still carries judgement and
      // the accessible name still states it in words.
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums',
        improved ? 'text-success-text' : 'text-critical-text',
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
  footnote,
  bound,
  roll = true,
  ringPx = SNAPSHOT_RING_PX,
  className,
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
  /**
   * One quiet cross-reference line under the snapshot (Round 12) — plain text that ties
   * this cohort figure to the strip figure it is easily confused with.
   */
  footnote?: React.ReactNode;
  /**
   * The snapshot's BOUND, when its total and severity split are counted over a partial
   * case page ("Lower bound · counted from the newest 200 of 450"). Shown under the
   * caption exactly when it is true.
   */
  bound?: string;
  /**
   * Whether the centre numeral may COUNT UP to a new value (Round 12 review): only on the
   * first load and on a window change — a LIVE or manual refresh shows the new value
   * without motion, like the KPI strip (`KpiTile roll`).
   */
  roll?: boolean;
  /** The donut's ring in px: `SNAPSHOT_RING_PX`, or `SNAPSHOT_RING_WIDE_PX` from 1920px. */
  ringPx?: number;
  /** Layout-only overrides for the card's own root. */
  className?: string;
}) {
  const wideRing = ringPx >= SNAPSHOT_RING_WIDE_PX;
  const segments = sevSegments(counts);
  const legend = SEV_ORDER.map((s) => ({ key: s, value: counts[s] })).filter((r) => r.value > 0);
  const legendId = React.useId();
  const centerClass = cn(
    'font-semibold tabular-nums text-foreground',
    total >= 1000 ? 'text-2xl' : 'text-3xl',
    'leading-none',
  );
  /*
   * The ring and its legend WRAP (Round 12 final review). Side by side the legend had
   * whatever width the ring left: in a 228px card (768px with the navigation pinned) that
   * was 44px, every severity name collapsed to 0px and the counts ran into the chevron,
   * so severity was told by colour alone. Now the legend asks for its own max-content
   * width (`w-max`, never more than 15rem) and, when that does not fit beside the ring,
   * drops under it at full width; a name is cut only in a card narrower than the legend
   * itself. The chevron has its own column outside this row, so no count can reach it.
   */
  const content = (
    <>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-3" data-testid="snapshot-body">
        {segments.length ? (
          <DonutChart
            segments={segments}
            height={ringPx}
            thickness={0.26}
            showTooltip={false}
            className={cn('shrink-0', wideRing ? 'w-48' : 'w-32')}
            ariaLabel={ariaLabel}
            center={
              roll ? (
                <CountUp value={total} format={fmtSnapshotCenter} className={centerClass} />
              ) : (
                <span className={centerClass} data-testid="snapshot-center">
                  {fmtSnapshotCenter(total)}
                </span>
              )
            }
          />
        ) : (
          <div
            role="img"
            aria-label={`${ariaLabel} (none)`}
            className={cn(
              'flex shrink-0 items-center justify-center',
              wideRing ? 'h-48 w-48' : 'h-32 w-32',
            )}
          >
            <span className="text-3xl font-semibold tabular-nums text-muted-foreground">0</span>
          </div>
        )}
        {/*
         * The legend is CAPPED at 15rem with each count and share immediately after its
         * label (Round 12). Uncapped and `flex-1`, a 2560px viewport put "Critical" ~470px
         * from its own count, which read as two unrelated columns.
         */}
        <ul
          id={legendId}
          className={cn('w-max min-w-0 max-w-[15rem] grow', wideRing ? 'space-y-3' : 'space-y-1.5')}
          data-testid="snapshot-legend"
        >
          {legend.length ? (
            legend.map((r) => {
              const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
              return (
                <li key={r.key} className="flex items-center gap-2 text-sm">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: token(r.key) }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {SEV_LABEL[r.key]}
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {fmtNumber(r.value)}
                  </span>
                  <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                    {pct}%
                  </span>
                </li>
              );
            })
          ) : (
            <li className="text-sm text-muted-foreground">No cases in this window.</li>
          )}
        </ul>
      </div>
      {onClick ? <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </>
  );

  const body = onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={ctaLabel}
      // The button's name replaces its contents for assistive tech, so the legend is
      // attached as its description: a screen reader hears the severity split too.
      aria-describedby={legendId}
      className="-mx-1 mt-3 flex w-full min-w-0 items-center gap-4 self-start rounded-md px-1 py-1 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </button>
  ) : (
    <div className="mt-3 flex w-full min-w-0 items-center gap-4 self-start py-1">{content}</div>
  );

  /*
   * FOUR rows, always (header · bound · donut · footnote), even when the bound or the
   * footnote is absent. Side by side (`@[35rem]`, see the parent), the two snapshots share
   * those rows through `grid-rows-subgrid`, so a caption that wraps to two lines in one
   * snapshot moves BOTH donuts and BOTH footnotes down together instead of putting the
   * pair 18px out of line (measured at 1920 before this). Stacked, each card is a plain
   * block and the empty rows take no space.
   */
  return (
    <section
      className={cn(
        'min-w-0 @[35rem]:row-span-4 @[35rem]:grid @[35rem]:grid-rows-subgrid',
        className,
      )}
      data-testid="snapshot-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{caption}</p>
        </div>
        <TrendChip delta={delta} goodDirection={goodDirection} />
      </div>
      {bound ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="snapshot-bound">
          {bound}
        </p>
      ) : (
        <div aria-hidden />
      )}
      {trend ? (
        // The CTA button (when present) is the focus stop; the wrapper only adds the
        // hover/focus-reachable trend card (WCAG 1.4.13 via MetricHoverTrend).
        // `h-auto`: the wrapper's default `h-full` would take the whole (stretched) card
        // and push the footnote below it.
        <MetricHoverTrend {...trend} focusable={!onClick} side="top" className="h-auto self-start">
          {body}
        </MetricHoverTrend>
      ) : (
        body
      )}
      {footnote ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="snapshot-footnote">
          {footnote}
        </p>
      ) : (
        <div aria-hidden />
      )}
    </section>
  );
}

/**
 * The p90 of a timing block, or null when the server did not measure one. A DASH string
 * (the backend's "not measured") and a non-finite number are both "not reported".
 */
function p90Of(block: StatBlock | undefined): number | null {
  if (!block || block.available !== true) return null;
  const v = block.p90;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One p50 lifecycle-timing stat block: value or an honest "not measured" DASH + reason. */
function TimingStat({
  label,
  sub,
  block,
  dotClass,
  help,
}: {
  label: string;
  sub: string;
  block: StatBlock | undefined;
  dotClass: string;
  help?: string;
}) {
  const available = block?.available === true;
  const value = available ? humanizeMins(block!.p50) : DASH;
  // p90 beside p50 when the posture rollup reports it (Round 12, additive): the tail is
  // what an operator is paged about, and the server already computes it.
  const p90 = p90Of(block);
  const detail = available
    ? `p50 · ${fmtNumber(block!.count)} sample${block!.count === 1 ? '' : 's'}${
        p90 != null ? ` · p90 ${humanizeMins(p90)}` : ''
      }`
    : block?.reason || 'not measured (n/a)';
  return (
    <div className="min-w-0 py-0.5" title={help}>
      <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} aria-hidden />
        {label}
      </div>
      <div className="mt-1.5 text-3xl font-semibold leading-none tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1.5 text-sm text-muted-foreground">{sub}</div>
      <div className="text-xs tabular-nums text-muted-foreground" data-timing-detail="">
        {detail}
      </div>
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

/**
 * How many latest-case rows the queue shows: at least five (the count it always showed)
 * and at most eight. Between the two it FILLS the band's height — the snapshots and the
 * timing pair beside it set that height, and the queue grows into it rather than leaving
 * dead space or driving the band taller.
 */
const LATEST_MIN_ROWS = 5;
const LATEST_MAX_ROWS = 8;
/**
 * The floor from 1920px up: EIGHT rows, the spec's count for the widest screens (Round 12
 * review). There the band changes shape so the queue can hold them without leaving blank
 * space beside it: the response-time pair moves UNDER the two snapshots (one row of two
 * stats) and the queue spans both rows on the right — the 4xl rail is the same column.
 * The old six-row floor set the band's height instead, and at 1920 / 2560 left ~160 /
 * ~190px empty under the snapshots and ~120 / ~140px under Response time.
 */
const LATEST_MIN_ROWS_WIDE = 8;
const LATEST_WIDE_QUERY = '(min-width: 1920px)';
/** Pre-measurement estimate of one queue row (title 20 + 2 gap + metadata 16 + 2 × 8
 *  padding), rounded up so the in-flow floor never undershoots — in REM (Round 12
 *  review), so a larger browser text size grows the floor with the rows it reserves
 *  (WCAG 1.4.4) instead of letting them overrun the band below. 3.5rem = 56px at 16px. */
const LATEST_ROW_ESTIMATE_REM = 3.5;
/** The space between two latest-case rows (`gap-1`), in rem. */
const LATEST_ROW_GAP_REM = 0.25;
/** Fallback px estimate for the measurement before a row exists (16px root). */
const LATEST_ROW_ESTIMATE_PX = 56;
/** The space between two latest-case rows (`gap-1`), in px for the fit arithmetic. */
const LATEST_ROW_GAP_PX = 4;

/** The longest signature label the collapsed Deeper analytics summary prints. */
const SUMMARY_SIGNATURE_MAX = 40;

/**
 * A signature label capped for the collapsed Deeper analytics summary (Round 12 review):
 * detection titles run to 80+ characters, and the case COUNT after the label is the part
 * the summary exists to show. The whole label stays in the header's tooltip and in Top
 * signatures inside.
 */
export function summarySignatureLabel(label: string, max: number = SUMMARY_SIGNATURE_MAX): string {
  const clean = label.trim();
  if (clean.length <= max) return clean;
  // Cut at the limit, then drop the dangling space or separator ("Protection:…").
  return `${clean.slice(0, max - 1).replace(/[\s:;,.\-\u2013\u2014]+$/u, '')}\u2026`;
}

/** The out-of-flow list's in-flow floor for `rows` rows, in rem (never px). */
export function latestFloorCss(rows: number): string {
  if (rows <= 0) return '0rem';
  return `${rows * (LATEST_ROW_ESTIMATE_REM + LATEST_ROW_GAP_REM) - LATEST_ROW_GAP_REM}rem`;
}

/**
 * Measure how many queue rows fit the box the band gives the list (see LATEST_*).
 *
 * The list is laid out OUT OF FLOW (absolutely, inside a `flex-1` box with a five-row
 * floor), so its own length can never make the band taller — which is what would turn
 * "fill the height" into a feedback loop. jsdom lays nothing out and keeps the floor.
 */
function useFittingRows(
  boxRef: React.RefObject<HTMLElement | null>,
  listRef: React.RefObject<HTMLElement | null>,
  minRows: number = LATEST_MIN_ROWS,
): number {
  const [rows, setRows] = React.useState(minRows);
  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') {
      return undefined;
    }
    const measure = () => {
      const height = box.getBoundingClientRect().height;
      if (!(height > 0)) return;
      const first = listRef.current?.querySelector('li');
      const rowHeight = first?.getBoundingClientRect().height || LATEST_ROW_ESTIMATE_PX;
      // + the 4px gap between rows (`gap-1`): n rows need n·row + (n−1)·gap.
      const fit = Math.floor((height + LATEST_ROW_GAP_PX) / (rowHeight + LATEST_ROW_GAP_PX));
      const next = Math.max(minRows, Math.min(LATEST_MAX_ROWS, fit));
      setRows((current) => (current === next ? current : next));
    };
    measure();
    const observer = new window.ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef, listRef, minRows]);
  // The floor itself can rise (a resize across 1920px) before the next measurement.
  return Math.max(rows, minRows);
}

/** The real-time work queue: the newest cases, filling the band's height. */
function TopCasesPanel({
  cases,
  navigate,
  navWindow,
  onOpenCase,
  caseOpen = false,
}: {
  /** Newest first, at most LATEST_MAX_ROWS; the panel shows as many as fit. */
  cases: Case[];
  navigate?: Navigate;
  navWindow: number;
  /**
   * Open one case IN PLACE (the shared CaseDetail sheet over this page) rather than
   * navigating to the Cases route. "View all" still navigates — that one is a list.
   */
  onOpenCase?: (caseId: string) => void;
  /**
   * True while a case sheet is open over this page. It suppresses the row hover previews,
   * which would otherwise stack a dismissable layer above the sheet and eat the operator's
   * first Escape — see `CaseHoverCard`'s `forceClosed`.
   */
  caseOpen?: boolean;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const wide = useMediaQuery(LATEST_WIDE_QUERY);
  const minRows = wide ? LATEST_MIN_ROWS_WIDE : LATEST_MIN_ROWS;
  const fit = useFittingRows(boxRef, listRef, minRows);
  const shown = cases.slice(0, fit);
  // The out-of-flow list needs a floor in flow: the rows it will hold before measuring
  // (never more than the floor, so a short queue does not reserve empty rows).
  const floorRows = Math.min(cases.length, minRows);
  return (
    <section aria-label="Latest cases" className="flex h-full min-w-0 flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Latest cases</h2>
          <p className="text-sm text-muted-foreground">Real-time triage queue</p>
        </div>
        {navigate ? (
          <button
            type="button"
            className="shrink-0 rounded-sm px-1 py-0.5 text-sm font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => navigate('cases', { window: navWindow })}
          >
            View all
          </button>
        ) : null}
      </div>

      {cases.length ? (
        <div
          ref={boxRef}
          className="relative mt-2 min-h-0 flex-1"
          style={{ minHeight: latestFloorCss(floorRows) }}
          data-testid="latest-cases-box"
        >
          {/* A flat list: rows separated by space, not hairlines and not bordered boxes
              (Round 12 — one rule per band at most; each row's hover fill and its status
              badge already mark where one case ends and the next begins). */}
          <ul ref={listRef} className="absolute inset-x-0 top-0 -mx-2 flex flex-col gap-1">
            {shown.map((k) => {
              const displayId = (k.case_number || k.case_id || DASH).trim() || DASH;
              const displayTitle =
                (k.title || k.cluster_signature || k.rule_ids?.[0] || '').trim() ||
                'Untitled case';
              const age = humanizeAge(k.updated_at || k.created_at);
              const status = latestCaseStatus(k.status);
              // A TERMINAL row states the outcome of record (Round 12, D15): the analyst's
              // classification once a human made one, otherwise how it was closed. One
              // shared helper decides it, so this row cannot disagree with the case header.
              const outcome = caseOutcome(k);
              const outcomeWord = outcome.terminal ? outcome.shortLabel : null;
              return (
                <li key={k.case_id} className="min-w-0">
                  <CaseHoverCard
                    case={k}
                    forceClosed={caseOpen}
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
                      // Opens the case OVER this page instead of routing away to the Cases
                      // list: the operator keeps the numerals that made them click.
                      onClick={onOpenCase ? () => onOpenCase(k.case_id) : undefined}
                      aria-disabled={!onOpenCase}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-sm px-2 py-2 text-left',
                        onOpenCase
                          ? 'transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                          : 'cursor-default',
                      )}
                      // WCAG 2.5.3 (Label in Name): the row's visible label includes the
                      // case IDENTIFIER, so the accessible name has to contain it too.
                      aria-label={
                        onOpenCase
                          ? `Open case ${displayTitle} (${displayId})`
                          : `Preview case ${displayTitle} (${displayId})`
                      }
                    >
                      {/* The TITLE leads (14px), because it is what the operator scans for;
                          the identifier and age sit under it as 12px metadata. The id keeps
                          its mono face and truncates only against the real space — the old
                          160px cap cut it at every width. */}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-base text-foreground" title={displayTitle}>
                          {displayTitle}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="min-w-0 truncate font-mono text-primary" title={displayId}>
                            {displayId}
                          </span>
                          <span aria-hidden>·</span>
                          <span className="shrink-0 tabular-nums">{age || 'Just now'}</span>
                        </span>
                      </span>
                      {/* Status badge over the terminal OUTCOME (Round 12 review): on the
                          metadata line the outcome word took the identifier's room, so the
                          most common rows (auto-closed) showed the least of their id. */}
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <Badge
                          variant={status.variant}
                          className="shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium"
                        >
                          {status.label}
                        </Badge>
                        {outcomeWord ? (
                          <span
                            className="whitespace-nowrap text-xs text-muted-foreground"
                            data-testid="latest-case-outcome"
                          >
                            {outcomeWord}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </CaseHoverCard>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center py-6">
          <EmptyState compact icon={Inbox} title="Queue clear" description="No recent cases in this window." />
        </div>
      )}
    </section>
  );
}

/** One big-number signal inside the {@link CoverageTile}. Flat: no box of its own. */
const CoverageMetric: React.FC<{
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}> = ({ icon: Icon, label, value, tone = 'default' }) => (
  <div className="flex h-full min-w-0 flex-col justify-between">
    {/* Sentence case at 13px (Round 12) — tracked capitals at 11px read as chrome. The
        label WRAPS (Round 12 review): truncated at 1280 with the navigation pinned it read
        "Triaged 2…" over "48", which looks like a different figure. The value sits at the
        bottom, so the three values stay on one line when one label takes two. */}
    <div className="flex items-start gap-1.5 text-sm leading-tight text-muted-foreground">
      <Icon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0" data-testid="coverage-metric-label">
        {label}
      </span>
    </div>
    <div
      className={cn(
        'mt-1.5 text-2xl font-semibold leading-none tabular-nums',
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
 * the Sources page to fix them). Advisory only (#3); every value is a server aggregate
 * rendered as plain text (#9); no secrets (#10).
 */
function CoverageTile({
  coverage,
  onNavigate,
  roll = true,
}: {
  coverage: SourceCoverage;
  onNavigate?: Navigate;
  /** Count the hero up only on a load the operator caused, never on a LIVE refresh. */
  roll?: boolean;
}) {
  const reporting = Math.max(0, coverage.sources_enabled - coverage.sources_silent);
  const pctReporting =
    coverage.sources_enabled > 0 ? Math.round((reporting / coverage.sources_enabled) * 100) : 0;
  const hasSilent = coverage.sources_silent > 0;
  const worstMins = Math.round((coverage.worst_last_event_seconds || 0) / 60);

  return (
    <div className="flex h-full flex-col gap-4" data-testid="coverage-tile">
      {/* Hero — enabled sources actually reporting. */}
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-4xl font-semibold leading-none tabular-nums text-foreground">
            {roll ? <CountUp value={reporting} /> : fmtNumber(reporting)}
          </span>
          <span className="text-lg tabular-nums text-muted-foreground">
            / {fmtNumber(coverage.sources_enabled)}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          sources reporting
          {coverage.sources_total !== coverage.sources_enabled
            ? ` · ${fmtNumber(coverage.sources_total)} configured`
            : ''}
        </p>
      </div>

      {/* Completeness bar (green reporting · amber silent remainder). */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full bg-success" style={{ width: `${pctReporting}%` }} />
        {hasSilent ? <div className="h-full flex-1 bg-warning" /> : null}
      </div>

      {/* Three big signals, in one row. */}
      <div className="grid grid-cols-3 gap-4">
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

      {/* Honest footer — the silent-source alarm (it carries meaning, so it keeps its one
          left rule), or an all-clear. */}
      {hasSilent ? (
        <button
          type="button"
          disabled={!onNavigate}
          onClick={onNavigate ? () => onNavigate('sources') : undefined}
          className={cn(
            'mt-auto flex w-full items-center gap-2 border-l-2 border-warning py-1 pl-2.5 text-left text-sm text-warning-text',
            onNavigate &&
              'rounded-r-sm transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
        <p className="mt-auto text-sm text-muted-foreground">
          All enabled sources are reporting
          {worstMins > 0 ? ` · oldest last event ${humanizeMins(worstMins)} ago` : ''}.
        </p>
      )}
    </div>
  );
}

/**
 * Case volume as COLUMNS PER UTC DAY (Round 12), per the hover-trend rule: one column per
 * bucket in its real time slot, never a smoothed area that implies values between days.
 *
 * `cases_per_day` lists only the days that HAVE cases, so the days between its first and
 * last entry are zero-filled here as measured zeros (a floor tick, not a gap) — the case
 * population the server analysed spans them. Days outside that span are not drawn. A
 * readout names the pointed (or latest) day, and the same values ship in a visually hidden
 * table. Plain SVG, no chart dependency. Every label is a formatted date or number (#9).
 */
function VolumeColumns({ data }: { data: Array<{ x: string; y: number }> }) {
  const series = React.useMemo(() => {
    const rows = data
      .map((d) => ({ day: String(d.x ?? ''), n: Number.isFinite(d.y) ? Math.max(0, d.y) : 0 }))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))
      .sort((a, b) => a.day.localeCompare(b.day));
    if (!rows.length) return [];
    const byDay = new Map(rows.map((r) => [r.day, r.n]));
    const out: Array<{ day: string; n: number }> = [];
    const start = Date.parse(`${rows[0].day}T00:00:00Z`);
    const end = Date.parse(`${rows[rows.length - 1].day}T00:00:00Z`);
    // A hostile/huge span would allocate without bound; the server sends at most a month.
    for (let t = start, i = 0; t <= end && i < 400; t += 86_400_000, i += 1) {
      const day = new Date(t).toISOString().slice(0, 10);
      out.push({ day, n: byDay.get(day) ?? 0 });
    }
    return out;
  }, [data]);
  const [pointed, setPointed] = React.useState<number | null>(null);

  if (!series.length) {
    return (
      <div
        role="img"
        aria-label="Case volume over time (no data)"
        className="flex min-h-[180px] flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        No data
      </div>
    );
  }
  const peak = series.reduce((m, d) => Math.max(m, d.n), 0) || 1;
  const shownIdx = pointed ?? series.length - 1;
  const shown = series[shownIdx];
  const tickEvery = Math.max(1, Math.ceil(series.length / 8));
  const total = series.reduce((a, d) => a + d.n, 0);

  return (
    <div className="flex min-h-[180px] flex-1 flex-col" data-testid="case-volume-columns">
      <div className="flex items-baseline justify-between gap-3 text-sm tabular-nums">
        <span className="text-muted-foreground">{shown.day.slice(5)}</span>
        <span className="font-semibold text-foreground">
          {fmtNumber(shown.n)} case{shown.n === 1 ? '' : 's'}
        </span>
      </div>
      <div className="relative mt-2 min-h-0 flex-1">
        <svg
          role="img"
          aria-label={`Case volume over time: ${fmtNumber(total)} cases over ${series.length} day${series.length === 1 ? '' : 's'}, peak ${fmtNumber(peak)} in a day`}
          viewBox={`0 0 ${series.length * 10} 100`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (r.width <= 0) return;
            const i = Math.floor(((e.clientX - r.left) / r.width) * series.length);
            if (Number.isFinite(i)) setPointed(Math.max(0, Math.min(series.length - 1, i)));
          }}
          onPointerLeave={() => setPointed(null)}
        >
          {series.map((d, i) => {
            const h = d.n > 0 ? Math.max(2, (d.n / peak) * 96) : 0;
            return d.n > 0 ? (
              <rect
                key={d.day}
                x={i * 10 + 1.5}
                y={100 - h}
                width={7}
                height={h}
                fill={token('primary', i === shownIdx ? 1 : 0.75)}
              />
            ) : (
              // A measured zero is a floor tick, never an empty slot.
              <rect key={d.day} x={i * 10 + 1.5} y={99} width={7} height={1} fill={token('muted-foreground', 0.4)} />
            );
          })}
        </svg>
      </div>
      <div className="mt-1.5 flex justify-between text-2xs tabular-nums text-muted-foreground" aria-hidden>
        {series.map((d, i) =>
          i % tickEvery === 0 || i === series.length - 1 ? (
            <span key={d.day}>{d.day.slice(5)}</span>
          ) : null,
        )}
      </div>
      <table className="sr-only">
        <caption>Cases opened per UTC day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Cases</th>
          </tr>
        </thead>
        <tbody>
          {series.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Re-render on an interval so relative stamps ("Updated 2m ago") stay true. */
function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * A quiet per-section freshness stamp (Round 12, additive; Sentinel shows "the last
 * refresh time at the top of each section"). The slices load independently, so one
 * global stamp would claim a freshness some of them do not have.
 */
function Freshness({ at, label = 'Updated' }: { at: string | null | undefined; label?: string }) {
  useNow(15_000);
  if (!at) return null;
  const age = humanizeAge(at);
  if (!age || age === DASH) return null;
  return (
    <span className="whitespace-nowrap tabular-nums" data-testid="freshness">
      {label} {age}
    </span>
  );
}

/**
 * One titled dashboard BAND (Round 12, SYNTHESIS-ux §2.3): a flat section on the canvas
 * with a 15px sentence-case title, an optional 13px caption, and an optional right-hand
 * aside (freshness, links). No card, no rule: whitespace between bands does the grouping.
 */
function Band({
  id,
  title,
  caption,
  aside,
  className,
  children,
  'data-testid': testId,
}: {
  id: string;
  title: string;
  caption?: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  'data-testid'?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('min-w-0', className)} data-testid={testId}>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <h2
            id={id}
            className="text-md font-semibold leading-5 text-foreground"
          >
            {title}
          </h2>
          {caption ? <p className="mt-0.5 text-sm text-muted-foreground">{caption}</p> : null}
        </div>
        {aside ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {aside}
          </div>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** A sub-band title inside Deeper analytics (h3 under its h2). */
function SubBandTitle({
  id,
  caption,
  children,
}: {
  id: string;
  /** The sub-band's time span, when one span covers what sits directly under the title. */
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <h3 id={id} className="text-base font-semibold text-foreground">
        {children}
      </h3>
      {caption ? (
        <p className="mt-0.5 text-sm text-muted-foreground" data-testid="subband-caption">
          {caption}
        </p>
      ) : null}
    </div>
  );
}

/** One flat titled instrument inside a band (h3 + optional 13px caption). */
function Instrument({
  title,
  caption,
  count,
  className,
  children,
  'data-scope': scope,
}: {
  title: string;
  /**
   * The instrument's caption, which in Deeper analytics always names its time span
   * ("last 24 hours", "all time", "right now"): the band mixes window, all-time and live
   * figures, and each says which it is. It WRAPS rather than truncating — a cut span is
   * exactly the part a reader needs.
   */
  caption?: string;
  count?: number;
  className?: string;
  children: React.ReactNode;
  /** Which population the instrument reads (`window` / `all` / `sample` / `live`). */
  'data-scope'?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn('flex h-full min-w-0 flex-col', className)}
      data-scope={scope}
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {count != null ? (
          <span className="text-sm tabular-nums text-muted-foreground">{fmtNumber(count)}</span>
        ) : null}
        {caption ? (
          <span className="min-w-0 text-sm text-muted-foreground" data-testid="instrument-caption">
            {caption}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The open/closed state of the Deeper analytics disclosure (Round 12, SYNTHESIS-ux §2.6):
 * collapsed on a first visit, then the viewer's own choice. It is a presentation
 * preference stored like the chat lane width — the localStorage mirror paints first (no
 * flash), then, once the effective prefs have hydrated, the server copy in
 * `UserPrefs.misc.overview_deeper_open` wins, so the choice follows the analyst across
 * browsers unless they changed it in the meantime. Every change writes both,
 * best-effort: the page works with neither storage nor a server. The server write goes
 * through the prefs provider (`patchMisc`), so leaving the Overview and coming back in
 * the same session keeps the latest choice.
 */
const DEEPER_OPEN_KEY = 'soc.overview.deeperOpen';
/** `UserPrefs.misc` key of the server mirror. */
export const DEEPER_OPEN_PREF_KEY = 'overview_deeper_open';

function readDeeperOpen(): boolean {
  try {
    return localStorage.getItem(DEEPER_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDeeperOpen(open: boolean): void {
  try {
    localStorage.setItem(DEEPER_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* storage blocked: the choice simply lasts for this visit */
  }
}

function useDeeperOpen(): [boolean, (open: boolean) => void] {
  const prefs = useOptionalPrefs();
  const [open, setOpen] = React.useState<boolean>(readDeeperOpen);
  const touchedRef = React.useRef(false);
  const reconciledRef = React.useRef(false);
  const ready = prefs?.ready ?? false;
  const misc = prefs?.prefs.misc;
  React.useEffect(() => {
    if (!ready || reconciledRef.current) return;
    reconciledRef.current = true;
    const stored =
      misc && typeof misc === 'object'
        ? (misc as Record<string, unknown>)[DEEPER_OPEN_PREF_KEY]
        : undefined;
    // A choice made on this page before the prefs arrived is newer than the server copy.
    if (touchedRef.current || typeof stored !== 'boolean') return;
    setOpen(stored);
    writeDeeperOpen(stored);
  }, [ready, misc]);
  // The save goes through the provider's `patchMisc` (as `useChatLaneWidth` does), so the
  // provider's `prefs.misc` learns the new value at once. This page remounts on every
  // visit and reconciles from that snapshot; a snapshot still holding the value loaded at
  // app start would reopen (or re-close) the section, and rewrite the local mirror, the
  // next time the analyst came back. Without a provider it writes the server directly.
  const patchMisc = prefs?.patchMisc;
  const change = React.useCallback(
    (next: boolean) => {
      touchedRef.current = true;
      setOpen(next);
      writeDeeperOpen(next);
      if (patchMisc) {
        patchMisc({ [DEEPER_OPEN_PREF_KEY]: next });
        return;
      }
      try {
        Promise.resolve(api.prefs.putUser({ misc: { [DEEPER_OPEN_PREF_KEY]: next } })).catch(() => {
          /* best-effort: the local choice already applies */
        });
      } catch {
        /* no preferences API (an embedding without it): the local mirror still holds */
      }
    },
    [patchMisc],
  );
  return [open, change];
}

export default function Overview({ onNavigate }: OverviewProps) {
  // Navigation seam: an explicit prop (host/test) wins; otherwise resolve from the
  // router context (no-op when rendered provider-less in a unit test).
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;

  // ----- Time range + auto-refresh (the CONTROL BAR state) ---------------- //
  const [range, setRange] = React.useState<TimeRange>(DEFAULT_RANGE);
  const [refresh, setRefresh] = React.useState<RefreshValue>('live');
  /**
   * Whether the strip's numerals ROLL (count up) when their value changes (Round 12). They
   * roll on the first load and on a window change — moments the operator caused — and
   * never on a refresh: a LIVE tick that re-rolls six numbers every few seconds is motion
   * that implies something happened when nothing did.
   */
  const [rollKpis, setRollKpis] = React.useState(true);
  /** From 1920px the Cases band is two rows and the snapshot rings grow (Round 12 review). */
  const wideScreen = useMediaQuery(LATEST_WIDE_QUERY);
  const changeRange = React.useCallback((next: TimeRange) => {
    setRollKpis(true);
    setRange(next);
  }, []);
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
  /** The previous window's page is provably cut short (its delta would compare floors). */
  const [prevTruncated, setPrevTruncated] = React.useState(false);
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
  /** When the last dashboard batch settled with data (the dashbar's "Updated …"). */
  const [loadedAt, setLoadedAt] = React.useState<string | null>(null);

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
      setPrevTruncated(
        pc.status === 'fulfilled' &&
          (pc.value as CasesResponse).window_total_exact === true &&
          typeof pc.value.total === 'number' &&
          pc.value.total > (pc.value.cases?.length ?? 0),
      );
      // Only surface a page-level error if the load is wholly empty.
      if (c.status === 'rejected' && m.status === 'rejected') {
        setError(c.reason ?? m.reason ?? new Error('Failed to load dashboard data.'));
      } else {
        setLoadedAt(new Date().toISOString());
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
  /**
   * `quality.analyst_confirmed_fp` (Round 12, additive): false positives an ANALYST
   * confirmed over the window. Shown beside the AI-verdict figures it must never be read
   * as. Absent on an older server ("not reported"), and withheld on an uncovered or
   * unmeasured window like every other share-bearing figure.
   */
  const analystConfirmedFp = React.useMemo<number | undefined>(() => {
    const raw = (posture?.quality as { analyst_confirmed_fp?: unknown } | undefined)
      ?.analyst_confirmed_fp;
    return !postureUnmeasured && postureCovered && typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : undefined;
  }, [posture, postureCovered, postureUnmeasured]);

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
  /** A refresh the operator did not just ask for a new window with: numerals do not roll. */
  const refreshQuietly = React.useCallback(() => {
    setRollKpis(false);
    refreshAll();
  }, [refreshAll]);

  // ----- Deeper analytics: one persisted disclosure (Round 12) ------------- //
  const [deeperOpen, onDeeperOpenChange] = useDeeperOpen();

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

  /**
   * Is the fetched case page the WHOLE window? Only the store can say (`#103`
   * `window_total_exact`), and only when the page holds every row it counted. Everything
   * this page tallies over `cases` — the two snapshots, their severity splits, the top
   * signatures and entities — is a lower bound / a sample when it is not.
   */
  const casePageComplete = caseWindow?.exact === true && caseWindow.total <= cases.length;

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
   * tile's DRILL-DOWN partition reads that SAME `humanVsAi` partition rather than
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

  // Detect / first-response headline stat blocks (the compact detect/respond cell, the
  // middle four columns of lattice row 2).
  // "Respond" = the first HUMAN response, so it reads the ACK clock (mtta_minutes) — NOT
  // dwell_minutes, whose _RESPONSE_STATUSES includes RESOLVED/CLOSED and would count an AI
  // auto-close as a human response (the dashboard must stay honest). The `respond` trend
  // series is likewise ACK-based server-side.
  const mttdBlock = posture?.lifecycle?.mttd_minutes;
  const respondBlock = posture?.lifecycle?.mtta_minutes;

  /*
   * The newest cases for the live queue — up to LATEST_MAX_ROWS (Round 12). The panel
   * shows as many as FIT the band's height, never fewer than five: the queue is laid out
   * out of flow, so it fills the space the snapshots and the timing pair set rather than
   * driving the band taller (see `useFittingRows`). This adds rows and removes none.
   */
  const latestCases = React.useMemo(
    () =>
      [...cases]
        .sort((a, b) => {
          const bTime = Date.parse(b.updated_at || b.created_at || '') || 0;
          const aTime = Date.parse(a.updated_at || a.created_at || '') || 0;
          return bTime - aTime || (b.risk_score ?? 0) - (a.risk_score ?? 0);
        })
        .slice(0, LATEST_MAX_ROWS),
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
  /**
   * ONE population per instrument (Round 12 review). The donut, its centre, its legend and
   * the analyst-confirmed row under it must all describe the same cases, so the source is
   * chosen once:
   *
   *   'window' — `posture.quality` for the selected window (the agent-worked cohort that
   *              arrived in it; policy closes never got an AI verdict). Used whenever the
   *              rollup measured the window in full — the analyst-confirmed count comes
   *              from the very same block, so it is only shown with this source.
   *   'all'    — `GET /api/metrics` `by_verdict`, an exact store-wide count, captioned
   *              "all time" and shown WITHOUT the analyst row (a window count beside
   *              all-time verdicts was read as "analysts confirmed 30 of the 47").
   *   'sample' — the fetched case page, when neither server rollup is available.
   *
   * The centre is the VERDICTED count, so "AI verdicts" never counts a case that has no
   * verdict; the unverdicted remainder keeps its own legend row and ring segment.
   */
  const verdictMix = React.useMemo<{
    segments: DonutSegment[];
    total: number;
    verdicted: number;
    scope: 'window' | 'all' | 'sample';
  }>(() => {
    const q = posture?.quality;
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    let src: Record<string, number>;
    let scope: 'window' | 'all' | 'sample';
    if (
      q &&
      !postureUnmeasured &&
      postureCovered &&
      [q.total_cases, q.verdicted_cases, q.true_positive_cases, q.needs_human_cases, q.false_positive_cases].every(finite)
    ) {
      scope = 'window';
      src = {
        TRUE_POSITIVE: q.true_positive_cases,
        NEEDS_HUMAN: q.needs_human_cases,
        FALSE_POSITIVE: q.false_positive_cases,
        none: Math.max(0, q.total_cases - q.verdicted_cases),
      };
    } else if (metrics?.by_verdict) {
      scope = 'all';
      const bv = metrics.by_verdict;
      src = {
        TRUE_POSITIVE: bv.TRUE_POSITIVE ?? 0,
        NEEDS_HUMAN: bv.NEEDS_HUMAN ?? 0,
        FALSE_POSITIVE: bv.FALSE_POSITIVE ?? 0,
        none: bv.none ?? 0,
      };
    } else {
      scope = 'sample';
      src = cases.reduce<Record<string, number>>((acc, k) => {
        const v = (k.verdict || 'none').toUpperCase();
        const key =
          v === 'TRUE_POSITIVE' || v === 'FALSE_POSITIVE' || v === 'NEEDS_HUMAN' ? v : 'none';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
    }
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
    const verdicted = total - (src.none ?? 0);
    return { segments, total, verdicted, scope };
  }, [posture, postureCovered, postureUnmeasured, metrics, cases]);

  const caseVolume = React.useMemo(
    () => (metrics?.cases_per_day ?? []).map((d) => ({ x: d.date, y: d.count })),
    [metrics],
  );

  /**
   * Case workload state. `metrics.by_status` is an exact STORE-WIDE (all-time) count, so
   * the instrument says "all time" and each row opens the Cases list WITHOUT a window —
   * the list then holds the number the row shows. Only when that rollup is missing does
   * it fall back to the window's case page, and then the rows carry the window.
   */
  const workload = React.useMemo<{
    items: Array<{ status: string; value: number }>;
    scope: 'all' | 'sample';
  }>(() => {
    const entries = Object.entries(metrics?.by_status ?? {});
    const scope: 'all' | 'sample' = entries.length ? 'all' : 'sample';
    const source = entries.length
      ? entries
      : Object.entries(
          cases.reduce<Record<string, number>>((acc, k) => {
            const s = (k.status || 'unknown').toLowerCase();
            acc[s] = (acc[s] ?? 0) + 1;
            return acc;
          }, {}),
        );
    return {
      items: source.sort((a, b) => b[1] - a[1]).map(([status, value]) => ({ status, value })),
      scope,
    };
  }, [metrics, cases]);
  const workloadItems = workload.items;

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
    // Each column also carries its bucket's own context for the hover breakdown. The
    // payload has no end field, so the end is `t + bucket_minutes` (the backend's own
    // arithmetic). The newest bucket is the server's PARTIAL one: it is "in progress"
    // while it ends after `generated_at`, and — when either instant is unreadable — the
    // last bucket is still the partial one by contract.
    const bucketMs = (finiteOrNull(trendsForWindow?.bucket_minutes) ?? 0) * 60_000;
    const generatedMs = Date.parse(String(trendsForWindow?.generated_at ?? ''));
    const series: HumanVsAiPoint[] | null = supported
      ? buckets.map((b, i) => {
          const startMs = Date.parse(String(b.t ?? ''));
          const endMs = Number.isFinite(startMs) && bucketMs > 0 ? startMs + bucketMs : Number.NaN;
          const inProgress =
            Number.isFinite(endMs) && Number.isFinite(generatedMs)
              ? endMs > generatedMs
              : i === buckets.length - 1;
          return {
            x: bucketAxisLabel(b.t, trendsForWindow?.bucket_minutes, trendsForWindow?.window_hours),
            ai: finiteOrNull(b.auto_closed),
            human: finiteOrNull(b.human_closed),
            system: finiteOrNull(b.system_closed),
            start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
            end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
            closed: finiteOrNull(b.closed),
            newCases: finiteOrNull(b.new_cases),
            sentToHuman: finiteOrNull(b.sent_to_human),
            fpRate: finiteOrNull(b.fp_rate),
            alerts: finiteOrNull(b.alerts),
            inProgress,
          };
        })
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
     * --- Auto Closed: the agent's own share of the work, straight off the server. ---
     *
     * `quality.auto_closed_cases` is the LAST-WRITER `decision_by === AGENT` count, and
     * it is REQUIRED on the wire, so there is no legacy branch to write. Three tempting
     * alternatives are all wrong:
     *
     *   - `/api/metrics/auto-close-health/recorded` anchors on the FIRST RECORDED
     *     DECISION, a different clock from this window, and this page never fetches it;
     *   - a client tally over `list_cases` is a bounded page with no attribution filter,
     *     so it would report a SAMPLE as a total;
     *   - `humanVsAi.totals.ai` falls back to SUMMING TREND BUCKETS when the partition
     *     does not reconcile, which is a repair, not a measurement.
     *
     * The SHARE comes from the server too, and deliberately not from
     * `shareContext(autoClosed, terminalCases)`. `quality_metrics` strips policy closes
     * BEFORE counting `auto_closed_cases`, while the Resolved / Closed numeral beside it
     * is policy-INCLUSIVE; dividing one by the other is exactly the cross-population
     * defect the comment above exists to kill. `automation_rate` is the server's own
     * ratio over its own denominator, so the caption names that denominator out loud
     * rather than borrowing the neighbouring tile's.
     */
    const autoClosedCases = measured(quality?.auto_closed_cases);
    const automationRate = quality?.automation_rate;
    const automationPercent =
      !unmeasured && covered && typeof automationRate === 'number'
        ? Math.round(automationRate * 100)
        : undefined;
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
     *
     * It is handed to the tile's DRILL-DOWN (`drilldown.partition`) rather than rendered
     * on the tile face. On the face it was three rows — four where the backend reports
     * `policy_closed_cases` — that the other four tiles did not have, so one tile set the
     * height of the whole strip; in the panel it sits under the numeral it partitions,
     * with room to name each band. Nothing about the numbers or the guards above changes
     * — only where they are read.
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

    /*
     * The loading arm fires only on a FIRST load — when there is no measurement on screen
     * to caption.
     *
     * This page defaults to a LIVE refresh, and posture reloads on every tick while the
     * previous rollup stays rendered. Captioning those numerals "Loading 24h" said something
     * false about them (they are a measurement, not a placeholder), and now that it is the
     * only caption a tile carries it also made the whole strip grow and shrink by ~18px on
     * every tick, shoving the lattice below it. The refresh control already shows LIVE and
     * spins, which is the honest place for "a request is in flight".
     *
     * A real DEGRADATION still takes the face, unconditionally: an error, or a successful
     * read of a store the server could not measure, in the server's own words. Those are
     * worth a reflow, and they are the reason this slot survives at all.
     */
    const postureSub =
      postureLoading && !posture
        ? `Loading ${windowLabel(hours)}`
        : postureError
          ? 'Posture unavailable'
          : (unmeasured ?? undefined);
    const bucketLabel = bucketTrends?.label ?? trendFallbackLabel;
    /*
     * `sub` used to carry THREE different kinds of sentence at once, and only one of them
     * belongs on the face of a landing strip:
     *
     *   (a) a descriptive caption  — "Window arrivals · policy-closed included"
     *   (b) a conditional BOUND    — "Partial window · lower bound"
     *   (c) a STATE disclosure     — "Loading 24h" / "Posture unavailable" / the server's
     *                                own account of a window it could not measure
     *
     * (a) is prose about a numeral that has not changed; read once, it becomes furniture,
     * and at two mono lines it outweighed the number it qualified. It now lives in the
     * tile's help and in its drill-down's population sentence — surfaces the operator
     * opens deliberately.
     *
     * (b) may NOT be relocated the same way: it is visible exactly when it is true, so a
     * reader who never opens the help would read a floor as a fact. It becomes the tile's
     * `bound` mark, which stays ON the numeral and carries this same sentence as its
     * accessible name.
     *
     * (c) stays on the face verbatim. A degradation notice is the one caption worth the
     * strip's height, and hiding it behind a popover would be strictly worse than the
     * prose it replaced. So `sub` is now EXACTLY `postureSub`: undefined on a healthy
     * window, which is what gives the numeral its room back.
     */
    const boundSub = (bounded = PARTIAL_WINDOW_SUB): string | undefined =>
      postureSub == null && !covered ? bounded : undefined;

    /**
     * Append the tile's live SCALE CONTEXT to its help.
     *
     * The context ("43 of 59 verdicted", "22% of 59") cannot ride beside the numeral on a
     * six-column strip — flex shrinks the NUMERAL first and turns "72%" into "7…" — and the
     * drill-down's metric switcher shows values only. So it goes here, where it is one
     * click, Enter, Space or tap away, and it is still the same string the tile computed,
     * not a second derivation that could disagree with it.
     *
     * An em dash is dropped rather than appended: "Right now: —." is not a disclosure, and
     * the surrounding help already says why the denominator is missing.
     */
    const scaleAside = (help: string, context: React.ReactNode): string =>
      typeof context === 'string' && context && context !== DASH
        ? `${help} Right now: ${context}.`
        : help;

    /*
     * The four scale contexts, each computed ONCE and then read by both the tile's context
     * line and its help. One derivation, so the two can never state different denominators
     * for one numeral.
     */
    const criticalShare = (covered ? shareContext(criticalCount, caseCount) : undefined) ?? DASH;
    const fpSample =
      covered &&
      typeof quality?.false_positive_cases === 'number' &&
      typeof quality?.verdicted_cases === 'number' &&
      quality.verdicted_cases > 0
        ? `${fmtNumber(quality.false_positive_cases)} of ${fmtNumber(quality.verdicted_cases)} verdicted`
        : DASH;
    /**
     * The ANALYST-confirmed false positives over the same window (Round 12, additive;
     * `quality.analyst_confirmed_fp`). A count, never a rate: most cases are never graded,
     * so a rate over it would describe grading coverage. It sits BESIDE the AI-verdict
     * rate — in the help and at the top of the tile's drill-down — so an analyst's call
     * and the model's call are never read as one number. Absent on an older server, which
     * is "not reported", never zero; withheld with every other share on an uncovered window.
     */
    const analystFp = analystConfirmedFp;
    const fpPartition: KpiBreakdownRow[] | undefined =
      typeof analystFp === 'number' && fpSample !== DASH
        ? [
            {
              label: 'AI verdict: false positive',
              value: fmtNumber(quality!.false_positive_cases),
              title: 'Cases the agent verdicted false positive (the rate’s numerator)',
            },
            {
              label: 'Confirmed false positive by an analyst',
              value: fmtNumber(analystFp),
              title:
                'Cases an analyst independently confirmed as false positive, from graded feedback or an explicit classification',
            },
          ]
        : undefined;
    const terminalShare = (covered ? shareContext(terminalCases, caseCount) : undefined) ?? DASH;
    const automationShare =
      typeof automationPercent === 'number'
        ? `${automationPercent}% of agent-worked closes`
        : DASH;
    /** A share of the window's arrivals, named as cases on the face; nothing for a dash. */
    const ofCases = (share: string): string | undefined =>
      share === DASH ? undefined : `${share} cases`;
    /** A context string as-is, or nothing when it is the "no honest denominator" dash. */
    const orNone = (s: string): string | undefined => (s === DASH ? undefined : s);

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
        // This IS the denominator the cohort tiles are shares of, so its context line
        // names the window rather than a share: a dash here would read as "a
        // denominator we could not measure", which is the opposite of true.
        // One window wording on the whole page (Round 12): "last 24 hours" here, in the
        // snapshot captions and in the trend labels — the caption used to say "last 1 day"
        // two inches from a tile that said "24h".
        context: covered ? `arrivals, last ${trendSpanLabel(hours)}` : undefined,
        sub: postureSub,
        bound: boundSub(),
        help:
          'Window arrivals, policy-closed included. Every case that ARRIVED in this window, ' +
          'keyed on case-arrival time. Cases an operator closed under a "declared benign" ' +
          'rule policy are included in the count, so this is the denominator the cohort ' +
          'tiles beside it are shares of.',
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
        context: ofCases(criticalShare),
        sub: postureSub,
        bound: boundSub(BOUNDED_SAMPLE_SUB),
        // NEVER flatten this template literal: `topBandLabel` is DERIVED from the severity
        // ladder and is designed to disagree with the tile's own literal label — the label
        // says "Total Critical" while the band may honestly be "High". It moved off the face
        // with the rest of the captions, but it is still built, never written out.
        help: scaleAside(
          `The ${topBandLabel} band. Counted SERVER-SIDE over the whole window from the ` +
            'severity roll-up, not derived from the rows any page of this console happened ' +
            'to read. The band name is the top band the severity ladder actually declares, ' +
            'which is not always "Critical".',
          criticalShare,
        ),
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
        // as a fifth summand of the cohort tiles. The context line says what it IS
        // instead. The two cohort "open" figures below it say "from this window" /
        // "arrived in the last …", and the open snapshot links back here (Round 12).
        context: 'any arrival date',
        sub: postureSub,
        // This tile's completeness has its OWN predicate: `open_now.complete`, not the
        // window coverage every other tile is gated on. A stock is read at `generated_at`
        // and can be a lower bound while the window itself was fully covered, so the
        // bound is derived here rather than from `boundSub`.
        bound:
          postureSub == null && !openNowComplete
            ? // The qualifier FIRST, in the context's own words (Round 12 final review):
              // the longer "Open now · not window-filtered · lower bound" ran to three
              // lines on a 140px tile at 1280, and "any arrival date" already says
              // "not window-filtered".
              'Lower bound · any arrival date'
            : undefined,
        help:
          'Open now, and not window-filtered. A STOCK, not a flow: the cases open right now, ' +
          'whenever they arrived. Every other tile on this strip counts arrivals inside the ' +
          'selected window, which is why this one has no window denominator and why its ' +
          'drill-down opens on an all-time page.',
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
        // "AI-verdict" (Round 12): the rate is the AGENT's verdicts, and an analyst's
        // classification is a different, separately reported count (see `analystFp`).
        label: 'AI-verdict FP rate',
        testId: 'false-positive-rate',
        value: typeof fpPercent === 'number' ? `${fpPercent}%` : DASH,
        countTo: fpPercent,
        format: formatWholePercent,
        // This numeral is ALREADY a percentage, so the missing half is its sample
        // size: the server's exact fp / verdicted counts behind the rate. Both halves
        // — and the rate above them — come off the same scan, so an uncovered window
        // withholds all of them rather than quoting a bounded ratio as fact.
        context: orNone(fpSample),
        sub: postureSub,
        // This tile never publishes a bounded RATIO — `fpPercent` is withheld entirely
        // unless the window is covered — so its bound is the WITHHELD arm of the grammar,
        // not a floor: the mark lands on the em dash and explains why there is no number,
        // which is the one thing a bare dash cannot do for itself.
        bound: boundSub(BOUNDED_SAMPLE_SUB),
        help: scaleAside(
          'The share of VERDICTED cases the agent closed as a false positive. The ' +
            'denominator is verdicted cases, not every case in the window, so a window with ' +
            'few verdicts moves this number a long way on very little evidence. It counts ' +
            'the AI verdict only: a false positive an analyst classified is reported ' +
            'separately, beside it.' +
            (typeof analystFp === 'number'
              ? ` Analysts confirmed ${fmtNumber(analystFp)} case${analystFp === 1 ? '' : 's'} in this window as false positive.`
              : ''),
          fpSample,
        ),
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
          title: 'AI-verdict FP rate',
          // A RATE has no list. What a list can honestly show is its NUMERATOR, so the
          // panel says which half of the ratio it is showing rather than implying the
          // rows below add up to a percentage.
          population:
            'The rate\u2019s numerator: cases the agent verdicted false positive, ' +
            'excluding operator policy closes exactly as the rate itself does.',
          // The analyst-confirmed count BESIDE the AI-verdict numerator, at the top of the
          // panel — the face's one context line has no room for a second number at 1280.
          partition: fpPartition,
          partitionCaption:
            'Over the whole window, from the server rollup, not the cases listed below. ' +
            'The two are different judgements of the same cases, so they need not match and ' +
            'do not sum to anything.',
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
        context: ofCases(terminalShare),
        sub: postureSub,
        bound: boundSub(BOUNDED_SAMPLE_SUB),
        help: scaleAside(
          'Cases from this window that reached a terminal state, including the ones an ' +
          'operator closed under a "declared benign" rule policy. Where the server reports ' +
          'a reconciling split, this tile’s drill-down names who closed them — the ' +
          'agent, an analyst, system routing, or that policy.' +
          // The RECONCILIATION between this numeral and the Human-vs-AI card below it.
          // This numeral is policy-INCLUSIVE; the card's denominator is `terminal_cases`,
          // which `quality_metrics` strips policy closes out of. On a backend that
          // separates them the page states 10 here and three bands summing to 5 there, and
          // without this sentence nothing explains the gap. It says nothing at all when
          // the server reports no policy closes, because then there is no gap to explain.
            (policyClosedReported && (policyClosed as number) > 0
              ? ` This window includes ${fmtNumber(policyClosed as number)} declared benign.`
              : ''),
          terminalShare,
        ),
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
          // The close attribution used to sit under the numeral on the tile FACE, where it
          // set the height of the whole strip for the four tiles that carry no partition.
          // It is the same memo either way, so this panel, the tile it opened from and the
          // instrument card below still read ONE reconciled partition and cannot drift —
          // including when it is `undefined`, which withholds it on all three at once.
          partition: closeBreakdown,
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
      /*
       * --- Auto Closed --------------------------------------------------------
       *
       * The one tile on this strip that is NOT an independent total, and the whole of its
       * design is making that impossible to misread. Five tiles with five distinct accents
       * teach the eye that a new accent means a new population; this tile therefore sits
       * IMMEDIATELY after Resolved / Closed and carries that tile's `success` accent
       * unchanged, so adjacency plus a shared accent read as "belongs to its neighbour".
       * The containment sentence then says so in words, in all three places a reader can
       * arrive from: the accessible name, the help popover and the drill-down's population.
       *
       * That is weaker than an explicit indent or a nested rule would be, and it is the
       * strongest cue available without abandoning the flat grid the divider math is
       * written for. The row must never read as a set that SUMS: `auto_closed +
       * human_closed + system_closed === terminal` exactly, so Auto Closed is a SUBSET of
       * its neighbour, and Open Cases beside them is a window-EXEMPT stock. The fix for
       * that is this copy, never a perturbation of the borders.
       */
      {
        label: 'Auto Closed',
        testId: 'auto-closed',
        value: typeof autoClosedCases === 'number' ? fmtNumber(autoClosedCases) : DASH,
        countTo: autoClosedCases,
        format: fmtInt,
        // Names its OWN denominator. "% of Resolved / Closed" would be false: this
        // numerator is counted over the policy-STRIPPED terminal set while that numeral
        // is policy-INCLUSIVE.
        // The face says "worked closes" for the help's "agent-worked closes": the same
        // server ratio over the same denominator, in 20 characters instead of 26, which is
        // what fits a sixth of a 1280px strip without an ellipsis. Help keeps the long form.
        context:
          typeof automationPercent === 'number' ? `${automationPercent}% of worked closes` : undefined,
        sub: postureSub,
        bound: boundSub(BOUNDED_SAMPLE_SUB),
        help: scaleAside(AUTO_CLOSED_POPULATION, automationShare),
        icon: ShieldCheck,
        accent: 'success',
        goodDirection: 'up',
        drilldown: {
          key: 'auto-closed',
          title: 'Auto Closed',
          population: AUTO_CLOSED_POPULATION,
          match: (c) => isAutoClosedByAI(c.status, c.decision_by),
          statusGroup: TERMINAL_STATUS_GROUP,
          // Deliberately NO `populationResolvedBy`. There is no server-side `decision_by`
          // filter, so this population really IS resolved in the browser over the rows the
          // request read; the panel's `'rows-read'` default is therefore the truth, and it
          // surfaces that in its own caveat. Copying `'store'` from the tile above would
          // suppress a disclosure that is CORRECT.
          defaultRange: 'window',
          severityHistogram: bandHistogram,
          target: navigate
            ? {
                label: 'Open in Cases',
                // The deep link can only carry the terminal STATUS set; `decision_by` is
                // not a Cases facet, so the landing list is deliberately WIDER than this
                // tile's population. `honours` says exactly which narrowings survive.
                honours: ['band', 'status', 'windowHours'],
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
    analystConfirmedFp,
  ]);

  // ----- Cross-references for figures the page repeats (Round 12) --------- //
  /**
   * Three instruments repeat a strip figure under their own label (diagnosis/overview.md,
   * glitch 4): the flow's "Cases opened" is Total Cases, the "Cases resolved" snapshot is
   * Resolved / Closed by severity, and Human vs AI's "AI agent" is Auto Closed. Each
   * repeat gets one quiet line naming the tile it repeats, so it reads as one measurement
   * shown twice rather than as clutter or a coincidence.
   *
   * ONLY when the two numbers on screen are equal and current. The line is a statement of
   * fact about what the reader is looking at; a bounded page, a stale rollup or a fallback
   * derivation can make the pair differ, and then the line says nothing rather than
   * claiming an identity the screen contradicts. Each figure is read from the very tile
   * it names (`countTo`), not re-derived.
   */
  const crossRefs = React.useMemo(() => {
    const stripValue = (testId: string): number | undefined => {
      const v = kpis.find((k) => k.testId === testId)?.countTo;
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    if (postureStale) return { flowCases: null, resolved: false, aiAgent: false };
    const total = stripValue('total-cases');
    const terminal = stripValue('resolved-closed');
    const auto = stripValue('auto-closed');
    const flowCases = noise?.stages?.find((s) => s.key === 'cases')?.total;
    return {
      flowCases:
        total !== undefined && typeof flowCases === 'number' && flowCases === total ? total : null,
      resolved: terminal !== undefined && terminal === derived.resolved,
      aiAgent: auto !== undefined && humanVsAi.totals?.ai === auto,
    };
  }, [kpis, postureStale, noise, derived.resolved, humanVsAi.totals]);

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
  /**
   * The tile focus was just RETURNED to by a closing drill-down (Round 12 review). Its
   * trend card refuses FOCUS-driven opens until the operator moves on — focus leaves the
   * tile or the pointer leaves it — because Radix restores focus only after the dialog's
   * exit animation, after `MetricHoverTrend`'s own grace period has run out, and the card
   * then popped open over a strip the operator had just dismissed it from with Escape.
   * HOVER is not held: pointing at the tile after a mouse Close shows its trend as usual
   * (`suppressFocusOpen`, not `forceClosed`).
   */
  const [returnedKpi, setReturnedKpi] = React.useState<string | null>(null);
  /**
   * Which tile's help popover is open, if any.
   *
   * The help trigger sits INSIDE the hover-card wrapper, so by the time the operator
   * reaches it the trend card is already up — clicking would leave two floating surfaces
   * over one tile. Only the page owns both, so only the page can stand one down.
   */
  const [helpOpenKpi, setHelpOpenKpi] = React.useState<string | null>(null);
  const onHelpOpenChange = React.useCallback(
    (key: string) => (open: boolean) =>
      setHelpOpenKpi((current) => (open ? key : current === key ? null : current)),
    [],
  );
  /**
   * The case opened OVER this page, if any. Opening a case from the live queue or from a
   * drill-down row mounts the shared <CaseDetail> in its right-hand sheet rather than
   * routing to the Cases list, so the dashboard the operator was reading stays behind it.
   *
   * There is no `caseId` in this route's hash (the router allow-lists that key for the
   * `cases`/`case_manager` routes only), so an Overview sheet is deliberately NOT
   * addressable by URL — it is a peek, and "View all" is still the route.
   */
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);
  /** Where the drill-down grows from: the centre of the tile that opened it (Round 12). */
  const [kpiOrigin, setKpiOrigin] = React.useState<{ x: number; y: number } | null>(null);
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

  // The post-dialog hold ends when the operator MOVES ON from the tile focus returned to:
  // its blur (Tab away) or the pointer leaving it. Native listeners on the tile's own
  // trigger (the strip renders no element of its own around a tile to hang them on).
  React.useEffect(() => {
    if (!returnedKpi) return undefined;
    const el = tileEls.current.get(returnedKpi);
    if (!el) return undefined;
    const release = () => setReturnedKpi((k) => (k === returnedKpi ? null : k));
    el.addEventListener('blur', release);
    el.addEventListener('pointerleave', release);
    return () => {
      el.removeEventListener('blur', release);
      el.removeEventListener('pointerleave', release);
    };
  }, [returnedKpi]);

  const kpiLabel = React.useCallback(
    (key: string) => kpis.find((k) => k.testId === key)?.label ?? key,
    [kpis],
  );

  const closeKpiPanel = React.useCallback(() => {
    if (openKpi === null) return;
    setReturnedKpi(openKpi);
    setOpenKpi(null);
    announce(`${kpiLabel(openKpi)} details closed`);
    // Focus RETURN is NOT done here. It used to be, when the panel was a docked section
    // and nothing competed for focus. Behind a focus trap a synchronous `.focus()` from
    // the parent is bounced straight back into the trap, and Radix then drops focus on
    // `<body>` — measured, both on Escape and on the panel's own Close. The panel owns the
    // return instead, through `restoreFocusTo` + Radix's close-autofocus, which is the one
    // moment the trap has released. `CaseDetail` solves the identical problem the same way.
    //
    // The tile's hover card opens on FOCUS, so the return would otherwise pop it straight
    // back over the strip — not synchronously, where `forceClosed` could still catch it,
    // but on Radix's `openDelay` timer ~160ms later. `MetricHoverTrend` therefore keeps
    // refusing opens for one `openDelay` after `forceClosed` falls.
  }, [openKpi, announce, kpiLabel]);

  const toggleKpiPanel = React.useCallback(
    (key: string) => {
      if (openKpi === key) {
        closeKpiPanel();
        return;
      }
      // Read the tile's centre at the moment it is opened, so the dialog scales out of the
      // control that asked for it (spatial consistency) instead of from the screen centre.
      const rect = tileEls.current.get(key)?.getBoundingClientRect();
      setKpiOrigin(
        rect && rect.width > 0 && rect.height > 0
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : null,
      );
      setReturnedKpi(null);
      setOpenKpi(key);
      announce(`${kpiLabel(key)} details opened`);
    },
    [openKpi, closeKpiPanel, announce, kpiLabel],
  );

  /**
   * Re-point the OPEN panel at another metric, from the panel's own switcher.
   *
   * Unlike `toggleKpiPanel` this never closes: the operator is inside the panel comparing
   * populations, and closing it under them because they picked the metric they were
   * already on would lose their filters and their place. It also moves the expanded tile,
   * so `aria-expanded`/`aria-controls` remain true on exactly one trigger, and the panel
   * re-announces itself and re-focuses its heading through its own `spec.key` effect.
   */
  const selectKpiPanel = React.useCallback(
    (key: string) => {
      if (openKpi === key) return;
      setOpenKpi(key);
      announce(`${kpiLabel(key)} details opened`);
    },
    [openKpi, announce, kpiLabel],
  );

  /**
   * The switcher's entries: each tile's key, label and RENDERED numeral, taken verbatim
   * from the same `kpis` array the strip renders — never recomputed, so a tile and its
   * switcher entry can never disagree. These are the dashboard's window rollups; the
   * panel labels them as such, because the list it draws underneath reads case pages.
   */
  const kpiMetrics = React.useMemo(
    () => kpis.map((k) => ({ key: k.testId, label: k.label, value: k.value })),
    [kpis],
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
      // Opening one listed case opens it OVER the dashboard rather than routing to the
      // Cases list — the panel stays open behind the sheet, so closing the case returns
      // the operator to the exact population they were reading. This also removes the
      // old window question entirely: there is no navigation, so there is no window to
      // carry or to accidentally narrow past the row that was just clicked.
      onOpenCase: setOpenCaseId,
    };
  }, [openKpi, kpis, hours]);

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

  // ----- Collapsed Deeper analytics: an inline summary (Round 12) --------- //
  /**
   * What the fold holds, stated while it is closed, so nothing hides behind an unlabelled
   * disclosure: the timing trio, spend, silent sources and the top signature. Built only
   * from values already on the page; an unmeasured value is left out rather than shown as
   * a dash in a sentence.
   *
   * `text` is what the header shows: it WRAPS rather than truncating (Round 12 review — a
   * one-line `truncate` cut the signature and its case count off at 1280 and below), and a
   * long signature label is capped (`summarySignatureLabel`) so the count always shows.
   * `full` is the same sentence with the whole label, for the header's tooltip.
   */
  const deeperSummary = React.useMemo(() => {
    const parts: string[] = [];
    for (const t of timing) if (t.value !== DASH) parts.push(`${t.label} ${t.value}`);
    if (usageLoad.availability !== 'unavailable' && typeof usage?.total_cost === 'number') {
      parts.push(`${fmtMoney(usage.total_cost, usage.currency)} spend`);
    }
    if (coverage) {
      parts.push(
        `${fmtNumber(coverage.sources_silent)} silent source${coverage.sources_silent === 1 ? '' : 's'}`,
      );
    }
    // Only a genuine LEADER is named (Round 12 review): when every signature is tied —
    // titles are often unique per case — item 0 is just the newest case, not the top one.
    const [lead, runnerUp] = signatureItems;
    let signature: { short: string; full: string } | null = null;
    if (lead && lead.value > 1 && lead.value > (runnerUp?.value ?? 0)) {
      const count = `(${fmtNumber(lead.value)} cases)`;
      signature = {
        short: `top signature: ${summarySignatureLabel(lead.label)} ${count}`,
        full: `top signature: ${lead.label} ${count}`,
      };
    }
    return {
      text: [...parts, ...(signature ? [signature.short] : [])].join(' · '),
      full: [...parts, ...(signature ? [signature.full] : [])].join(' · '),
    };
  }, [timing, usage, usageLoad.availability, coverage, signatureItems]);

  // ----- The header control cluster --------------------------------------- //
  const headerControls = (
    <>
      <TimeRangePicker
        value={range}
        onChange={changeRange}
        refresh={refresh}
        onRefreshChange={setRefresh}
        onRefreshTick={refreshQuietly}
        size="sm"
        chrome="command"
      />
      <Button
        variant="outline"
        size="icon"
        onClick={refreshQuietly}
        aria-label="Refresh dashboard"
        title="Refresh"
        className={cn(
          // 8px like every other button and select (Round 12 concentric radii).
          'h-8 w-8 rounded-md border-border/70 bg-transparent text-muted-foreground shadow-none hover:border-border-strong hover:bg-hover hover:text-foreground',
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

  /**
   * The page's width (Round 12): `wide` — `max-w-[1760px] 2xl:max-w-[1920px]`, centred —
   * rising to 2400px at `4xl`, where the bands switch to a main column plus a 460px rail.
   * `PageContainer` has always prescribed `wide` for this page ("widen by COLUMN COUNT on
   * ultrawide, not by stretching rows"); `fluid` stretched a 7.5:1 flow strip across a
   * 2560px screen and left 30% of it empty. The blocking load uses the SAME classes, or
   * the page would change width when data lands.
   */
  const containerClass = 'space-y-8 3xl:space-y-10 4xl:max-w-[2400px]';

  // ----- Blocking load uses the Console's one centered motion grammar. ---- //
  if (loading && !cases.length && !metrics) {
    return (
      <PageContainer variant="wide" className={containerClass}>
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
  /** "last 24 hours" / "last 7 days" — the ONE window wording on this page. */
  const windowPhrase = `last ${trendSpanLabel(hours)}`;
  /**
   * The span of everything tallied over the fetched case page: the window itself when the
   * page is provably the whole window, otherwise the newest rows read out of it.
   */
  const caseSampleScope = casePageComplete
    ? windowPhrase
    : caseWindow?.exact === true
      ? `newest ${fmtNumber(cases.length)} of ${fmtNumber(caseWindow.total)}, ${windowPhrase}`
      : `newest ${fmtNumber(cases.length)} cases read, ${windowPhrase}`;
  /**
   * The snapshots' bound line when their totals are counted over a partial page (Round 12
   * review): the flow beside them states the exact cohort, so an unmarked sample here read
   * as a second, smaller count of the same cases.
   */
  const snapshotBound = casePageComplete
    ? undefined
    : caseWindow?.exact === true
      ? `Lower bound · counted from the newest ${fmtNumber(cases.length)} of ${fmtNumber(caseWindow.total)}`
      : caseWindow
        ? `Approximate · counted from the ${fmtNumber(cases.length)} newest cases read`
        : undefined;
  /** A change chip between two floors is not a change: withheld when either page is cut. */
  const snapshotDeltaHonest =
    !(caseWindow?.exact === true && caseWindow.total > cases.length) && !prevTruncated;
  // The most recent of the two independently loaded halves (case/metric batch, posture).
  const pageFreshness = [loadedAt, posture?.generated_at ?? null]
    .filter((v): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const openNowCount =
    !postureUnmeasured && typeof posture?.open_now?.count === 'number'
      ? posture.open_now.count
      : null;

  return (
    <PageContainer variant="wide" className={containerClass}>
      {/* ---- BAND 0 — MASTHEAD + DASHBAR ----------------------------------------------
          The title, the time-range and refresh controls in the `meta` slot BESIDE it, and
          the page's freshness on the right. Sticky on the Console's one translucent
          material (Round 12): the controls that scope every number stay in reach while the
          bands scroll under them, with a scroll-edge fade instead of a hard rule. It is
          NOT a card — `page-hero` carries no `bg-card` (the material is floating chrome,
          not a surface for data).

          The title steps up to the 30/36 display step at `2xl` (24/30 below; the type
          scale's nearest step to the 28px the synthesis sketched) — the page's one display
          size; band titles are 15px and instrument titles 14px under it. */}
      <PageHeader
        data-testid="page-hero"
        title={PAGE_TITLE}
        sticky
        // Pinned from `sm` up only (Round 12 review): on a phone the title, three controls
        // and the freshness stamp stack to ~108px, a fifth of a 390×844 screen held by
        // chrome while every band scrolls. There it scrolls away with the page.
        className="py-2 2xl:[&_h1]:text-4xl max-sm:static"
        meta={
          <div
            role="group"
            aria-label="Dashboard controls"
            className="flex flex-wrap items-center gap-2"
          >
            {headerControls}
          </div>
        }
        actions={
          pageFreshness ? (
            <span className="text-sm text-muted-foreground">
              <Freshness at={pageFreshness} />
            </span>
          ) : undefined
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

      {/* Agent health lives in the notification bell (AppShell -> NotificationBell), where
          a degradation is visible from EVERY route. The dashboard must not re-derive it. */}

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
        <>
          {/* ---- BAND 1 — THE KPI STRIP ---------------------------------------------
              One continuous six-cell strip (no title: the page title introduces it), its
              own outer rules, and the exact per-breakpoint divider math below. A 32px
              band gap now separates it from the flow band (Round 12): the strip's bottom
              rule used to BE the lattice's top edge, and with no gap anywhere the page
              read as one undifferentiated slab. */}
          <div>
            <Stagger
              data-testid="kpi-strip"
              // First load only, and quick: 40ms a tile, ≤200ms in all (Round 12 motion).
              step={40}
              maxDelay={200}
              className="grid grid-cols-1 border-y border-border sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6"
              /*
               * Exact divider math for SIX tiles at 1 / 2 / 3 / 6 columns. A cell may
               * never draw a hairline into empty space or lose the rule that separates
               * it from the next row (ui-standard, operational metric surfaces):
               *   - column rule: on for every cell that HAS a right-hand neighbour;
               *   - row rule: off for every cell in the final row.
               *
               * SIX is easier than five, not harder: 6 % {1,2,3,6} === 0, so every
               * breakpoint fills whole rows and "last column" coincides with "last child"
               * at each of them.
               *
               * VERIFIED, not reasoned: these classes were compiled with this repo's own
               * Tailwind and the resulting borders read back from computed styles in a real
               * browser at 500 / 700 / 900 / 1400px, against the geometric oracle
               * (`right = i mod cols ≠ 0 and i ≠ n`, `bottom = i ≤ n − cols`).
               *
               * ⚠️ Do not "simplify" the `:not()`s away. Tailwind emits arbitrary-variant
               * rules in ONE trailing block whose internal order is not by breakpoint, so
               * at `md` the `2n` ON rule beat the `3n` OFF rule on cell 6 only by emission
               * order, at equal (0,2,0) specificity. `:not()` lifts it to (0,3,0). At `xl`,
               * `:not(:nth-child(6n))` is strictly required. (jsdom's nwsapi THROWS on
               * `:not(:nth-child(3n))` — harmless here, but a future test that queries with
               * that selector will error rather than fail.)
               */
              itemClassName={cn(
                'h-full min-w-0 border-b border-r-0 border-border/70 last:border-b-0 last:border-r-0',
                'sm:border-r sm:[&:nth-child(2n)]:border-r-0 sm:[&:nth-child(n+5)]:border-b-0',
                'md:[&:nth-child(2n):not(:nth-child(3n))]:border-r md:[&:nth-child(3n)]:border-r-0 md:[&:nth-child(n+4)]:border-b-0',
                'xl:border-b-0 xl:[&:nth-child(3n):not(:nth-child(6n))]:border-r',
              )}
            >
              {kpis.map((kpi) => {
                const tile = (
                  <KpiTile
                    ref={tileRef(kpi.testId)}
                    label={kpi.label}
                    testId={kpi.testId}
                    value={kpi.value}
                    // The scale context rides on its OWN line under the numeral, never
                    // beside it (flex shrank the numeral first: "72%" read as "7…").
                    context={kpi.context}
                    sub={kpi.sub}
                    bound={kpi.bound}
                    help={kpi.help}
                    askTopic={kpiTopic(kpi.testId)}
                    onHelpOpenChange={onHelpOpenChange(kpi.testId)}
                    icon={kpi.icon}
                    accent={kpi.accent}
                    variant="strip"
                    // Round 12: the strip that HEADS this page is `comfortable` — between
                    // compact and default (~120px, 13px label and context lines) — with a
                    // FLUID numeral that grows with its own tile (24 → 44px). Compact
                    // squeezed six numerals into 90px cells at every width. Density changes
                    // padding and type only; the cell COUNT, which the divider math above
                    // is tuned to, is untouched.
                    density="comfortable"
                    size="fluid"
                    numeral="hero"
                    // Roll on the first load and on a window change; a refresh (LIVE or
                    // manual) shows the new value without motion.
                    roll={rollKpis}
                    goodDirection={kpi.goodDirection}
                    countTo={kpi.countTo}
                    format={kpi.format}
                    formatCompact={fmtSnapshotCenter}
                    onClick={() => toggleKpiPanel(kpi.testId)}
                    // The tile opens a MODAL, so it announces a popup — not an expanded
                    // state; the dialog is portalled and absent while closed.
                    ariaHasPopup="dialog"
                    // `className` lands on the tile's CELL ROOT (the help button sits beside
                    // the trigger), so the trigger's inset is reached as its child: 12px
                    // sides between xl and 2xl instead of the density's 16px. At 1280 with
                    // the navigation pinned a tile is ~165px, and 16px cost the longest
                    // context ("96% of worked closes") its last word.
                    //
                    // `ring-inset` (Round 12 review): the cell root is `overflow-hidden`, so
                    // the trigger's outset focus ring was clipped away entirely — a keyboard
                    // user saw no focus on the tile at all.
                    className="press-scale xl:max-2xl:[&>button]:px-3 [&>button:focus-visible]:ring-inset [&>button:focus-visible]:ring-offset-0"
                  />
                );
                // Hover/focus reveals the metric's honest trend; the tile is itself the
                // focus stop. Every card is FORCED closed while ANY drill-down or help
                // popover is open (two stacked explanations of one numeral is worse than
                // either alone, and the focus return would otherwise pop one back open).
                return kpi.trend ? (
                  <MetricHoverTrend
                    key={kpi.testId}
                    {...kpi.trend}
                    preview={{
                      eyebrow: kpi.label,
                      population: kpi.drilldown.population,
                      affordance: 'Select for the full population, filters and paging.',
                    }}
                    focusable={false}
                    forceClosed={openKpi !== null || helpOpenKpi !== null}
                    // The tile focus was just returned to: a late FOCUS open stays refused,
                    // but pointing at the tile still shows its trend (Round 12 review).
                    suppressFocusOpen={returnedKpi === kpi.testId}
                    side="bottom"
                  >
                    {tile}
                  </MetricHoverTrend>
                ) : (
                  <React.Fragment key={kpi.testId}>{tile}</React.Fragment>
                );
              })}
            </Stagger>

            {/* The drill-down PORTALS to `document.body` (Radix Dialog), so it is never a
                child of the strip whose `nth-child` math counts cells. It grows out of the
                tile that opened it (Round 12). */}
            {openKpiSpec ? (
              <KpiDrilldownPanel
                spec={openKpiSpec}
                panelId={KPI_PANEL_ID}
                headingId={KPI_PANEL_HEADING_ID}
                onClose={closeKpiPanel}
                metrics={kpiMetrics}
                onSelectMetric={selectKpiPanel}
                origin={kpiOrigin}
                restoreFocusTo={() => (openKpi ? (tileEls.current.get(openKpi) ?? null) : null)}
              />
            ) : null}
          </div>

          {/* ---- BANDS 2 + 3 — the instrument bands ---------------------------------
              Flat titled sections on the canvas, separated by whitespace: 32px between
              bands, 24px gutters inside one (32 / 40 from 1920px). No per-cell rules and
              no cell padding — the gutters do the separating (Round 12, replacing the
              gutterless hairline lattice that read as one slab).

              ⚠️ THE FLOW GRID IS `xl:`, NEVER `lg:`. The flow's own container query hides
              its graph below 38rem (608px) of CONTAINER width. At the tightest supported
              desktop — 1280px, sidebar pinned — the content is ~982px; with no cell padding
              and a 24px gutter the flow's eight columns are (982 − 24) × 8/12 ≈ 638px, which
              clears 608. Do NOT add padding to the flow cell at `xl`.

              At `4xl` (≥2200px) the page widens to 2400px by COLUMN COUNT: both bands share
              one track template whose last column is a 460px rail, so Human vs AI stacks
              over Latest cases beside the main column (flow; case state + timing). */}
          <Reveal
            variant="rise"
            delay={40}
            data-testid="hero-row"
            className="min-w-0 space-y-8 3xl:space-y-10"
          >
            <Band
              id="overview-band-flow"
              title="Alert flow"
              caption={
                crossRefs.flowCases != null
                  ? `How the ${windowPhrase} of alerts became cases (the ${fmtNumber(crossRefs.flowCases)} in Total Cases above), and who closed them`
                  : `How the ${windowPhrase} of alerts became cases, and who closed them`
              }
              aside={<Freshness at={noise?.generated_at ?? null} />}
            >
              <div
                className={cn(
                  'grid min-w-0 items-stretch gap-x-6 gap-y-8 xl:grid-cols-12 3xl:gap-x-8',
                  '4xl:grid-cols-[minmax(0,1fr)_460px]',
                )}
              >
                {noiseCellVisible ? (
                  <div className="min-w-0 xl:col-span-8 4xl:col-span-1">
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
                          // window), so its completeness is the window's (`#103`
                          // `window_covered`). Without a posture rollup the fallback count is
                          // the fetched page, whose completeness the store proves via
                          // `window_total_exact`.
                          partial: posture
                            ? !postureCovered
                            : !(caseWindow?.exact === true && caseWindow.total <= cases.length),
                        }}
                        onOpenCasesClick={onOpenCasesClick}
                        hidden={noiseHidden}
                        onToggleHidden={toggleNoiseHidden}
                        expandable
                        variant="flat"
                        // The stage numerals follow the strip (Round 12 review): they count
                        // up on the first load and a window change, never on a LIVE or
                        // manual refresh. `animate` stays on, because the one-shot ribbon
                        // sweep is the ONE motion a LIVE refresh replays.
                        rollNumerals={rollKpis}
                        className="w-full"
                      />
                    ) : null}
                  </div>
                ) : null}

                {/* Close attribution. The widen-fallback keys on `noiseSupported` (settled
                    on the first render), not `noiseCellVisible` (false for the loading
                    tick), so the card never paints full width and then snaps to four. */}
                <div
                  className={cn(
                    'min-w-0',
                    noiseSupported ? 'xl:col-span-4 4xl:col-span-1' : 'xl:col-span-12 4xl:col-span-2',
                  )}
                >
                  <HumanVsAiCard
                    totals={humanVsAi.totals}
                    unavailableReason={humanVsAi.reason}
                    series={humanVsAi.series}
                    windowLabel={bucketTrends?.label ?? trendFallbackLabel}
                    truncated={humanVsAi.truncated}
                    stale={humanVsAi.stale}
                    alertsIngested={humanVsAi.alerts}
                    crossReference={
                      crossRefs.aiAgent ? 'AI agent is the same count as Auto Closed above.' : undefined
                    }
                    className="h-full w-full"
                  />
                </div>
              </div>
            </Band>

            <Band
              id="overview-band-cases"
              title="Cases and response"
              caption={`Cases that arrived in the ${windowPhrase} · response timing is p50, computed on the server`}
              aside={<Freshness at={posture?.generated_at ?? null} />}
            >
              {/* Below xl the band splits into two columns by ITS OWN width, not the
                  viewport's (Round 12 final review): `md:grid-cols-2` split it at 768px even
                  with the navigation pinned, where each half was 228px and the snapshot
                  legends lost every severity name. `@[48rem]` keeps each half at least
                  ~372px, whatever the navigation takes; narrower, the cells stack full
                  width as they did before Round 12. `max-xl:` scopes the container rule
                  below the 12-column grid, so the two never compete. */}
              <div className="@container min-w-0" data-testid="cases-band-container">
                <div
                  // From 1920px the band is TWO rows (Round 12 review): the snapshots over the
                  // response-time pair on the left, the queue spanning both on the right (the
                  // 460px rail at 4xl). Row 2 is `1fr`, so the queue's eight rows set the
                  // band's height and any slack lands under the timing pair, not as a void
                  // beside a short snapshot row. DOM order — and so heading order — is
                  // unchanged: case state, response time, latest cases.
                  className={cn(
                    'grid min-w-0 items-stretch gap-x-6 gap-y-8 max-xl:@[48rem]:grid-cols-2 xl:grid-cols-12 3xl:gap-x-8',
                    '3xl:grid-rows-[auto_1fr] 4xl:grid-cols-[minmax(0,1fr)_460px]',
                  )}
                  data-testid="cases-band-grid"
                >
                  {/* Case state: ONE labelled region holding both snapshots. They sit side by
                      side whenever the cell is at least 35rem (560px) wide and stack below
                      that — a container query, so it follows the cell, not the viewport. */}
                  <section
                    aria-label="Resolved and open cases"
                    className="@container min-w-0 xl:col-span-5 3xl:col-span-8 3xl:col-start-1 3xl:row-start-1 4xl:col-span-1"
                  >
                    {/* `content-start`: the band stretches this cell, and a grid's auto rows
                        would otherwise share that stretch and push each snapshot's footnote
                        away from its own donut. */}
                    <div className="grid content-start gap-x-8 gap-y-6 @[35rem]:grid-cols-2 @[35rem]:gap-y-0">
                      <SnapshotCard
                        title="Open cases"
                        caption={`Arrived in the ${windowPhrase}, still open`}
                        total={derived.open}
                        delta={snapshotDeltaHonest ? countDelta(derived.open, prev?.open ?? null) : null}
                        bound={snapshotBound}
                        roll={rollKpis}
                        ringPx={wideScreen ? SNAPSHOT_RING_WIDE_PX : SNAPSHOT_RING_PX}
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
                        // The visual link between the three "open" figures (Round 12): this
                        // cohort is part of the strip's window-exempt Open Cases stock, and
                        // the flow's "open cases from this window" action is this same cohort.
                        footnote={
                          openNowCount != null
                            ? `Part of the ${fmtNumber(openNowCount)} open now, any arrival date (Open Cases above).`
                            : undefined
                        }
                      />
                      <SnapshotCard
                        title="Cases resolved"
                        caption={`Arrived in the ${windowPhrase}, now resolved or closed`}
                        total={derived.resolved}
                        delta={
                          snapshotDeltaHonest ? countDelta(derived.resolved, prev?.resolved ?? null) : null
                        }
                        bound={snapshotBound}
                        roll={rollKpis}
                        ringPx={wideScreen ? SNAPSHOT_RING_WIDE_PX : SNAPSHOT_RING_PX}
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
                        // `derived.resolved` counts BOTH terminal statuses, so the deep link
                        // uses the `__terminal__` facet (a `status: 'closed'` link silently
                        // dropped every RESOLVED case).
                        footnote={
                          crossRefs.resolved
                            ? 'The same cases as Resolved / Closed above, by severity.'
                            : undefined
                        }
                        onClick={
                          navigate
                            ? () =>
                                navigate('cases', { status: TERMINAL_CASES_FILTER, window: navWindow })
                            : undefined
                        }
                      />
                    </div>
                  </section>

                  {/* Response time: the detect / first-response pair, TOP-aligned with 24px
                      between them (the old `justify-center` halves left a ~110px void). */}
                  <section
                    aria-label="Mean time to detect / respond"
                    className="@container flex min-w-0 flex-col xl:col-span-3 3xl:col-span-8 3xl:col-start-1 3xl:row-start-2 4xl:col-span-1"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="text-base font-semibold text-foreground">Response time</h2>
                        <p className="text-sm text-muted-foreground">p50 · server-computed</p>
                      </div>
                      {navigate ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-mr-2 h-7 shrink-0 px-2 text-sm font-medium text-primary hover:text-primary/80"
                          onClick={() => navigate('metrics', { tab: 'posture' })}
                        >
                          Detail →
                        </Button>
                      ) : null}
                    </div>
                    {/* The detect / respond pair sits side by side whenever THIS cell is at
                        least 30rem wide (a container query, like the band above), so it
                        follows the cell through every band layout instead of a ladder of
                        viewport breakpoints that guessed the cell's width. */}
                    <div className="mt-4 grid gap-6 @[30rem]:grid-cols-2 3xl:gap-x-8">
                      <MetricHoverTrend
                        metric="MTTD · daily mean"
                        points={timingTrends?.mttd}
                        windowLabel={timingTrends?.label ?? trendFallbackLabel}
                        format={humanizeMins}
                        colorToken="info"
                        side="top"
                        className="h-auto"
                      >
                        <TimingStat
                          label="MTTD"
                          sub="Detect · log arrival → case"
                          block={mttdBlock}
                          dotClass="bg-info"
                          help="Mean time to detect: the cluster's first event → case-open. Shown as an honest n/a when no case carries a first-event instant."
                        />
                      </MetricHoverTrend>
                      <MetricHoverTrend
                        metric="Respond · daily mean"
                        points={timingTrends?.respond}
                        windowLabel={timingTrends?.label ?? trendFallbackLabel}
                        format={humanizeMins}
                        colorToken="success"
                        side="top"
                        className="h-auto"
                      >
                        {/* "Respond" is the ACK clock (`mtta_minutes`), NOT `mttr_minutes`:
                            calling it MTTR would present time-to-first-human-action as
                            time-to-resolve. True MTTR is in Deeper analytics, and the MTTA
                            there reads this same clock — said so here, so the two equal
                            figures read as one measurement shown twice, not a coincidence. */}
                        <TimingStat
                          label="Respond"
                          sub="First human action, e.g. assignment or acknowledgement · same clock as MTTA"
                          block={respondBlock}
                          dotClass="bg-success"
                          help="Mean time to respond — the first active human response (investigating / escalated / assignment / ack)."
                        />
                      </MetricHoverTrend>
                    </div>
                  </section>

                  <div className="min-w-0 max-xl:@[48rem]:col-span-2 xl:col-span-4 3xl:col-start-9 3xl:row-span-2 3xl:row-start-1 4xl:col-span-1 4xl:col-start-2">
                    <TopCasesPanel
                      cases={latestCases}
                      navigate={navigate}
                      navWindow={navWindow}
                      onOpenCase={setOpenCaseId}
                      caseOpen={openCaseId !== null}
                    />
                  </div>
                </div>
              </div>
            </Band>
          </Reveal>

          {/* ---- BAND 4 — DEEPER ANALYTICS -------------------------------------------
              ONE disclosure (Round 12): no cards, no accent bars, no nested collapsibles.
              Collapsed on a first visit; the operator's choice is remembered. While closed,
              its header states what is inside in one line. Its single top rule is the only
              hairline this band draws. */}
          <Collapsible open={deeperOpen} onOpenChange={onDeeperOpenChange} asChild>
            <section aria-label="Deeper analytics" className="min-w-0 border-t border-border pt-4">
              <h2 className="m-0">
                <CollapsibleTrigger asChild>
                  {/* The summary WRAPS (Round 12 review): beside the title from `md`, on
                      its own line under it below that — never cut to one truncated line. */}
                  <button
                    type="button"
                    aria-expanded={deeperOpen}
                    aria-controls="overview-deeper-region"
                    className="group/deeper flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        'mt-0.5 h-4 w-4 shrink-0 self-start text-muted-foreground transition-transform motion-reduce:transition-none',
                        deeperOpen ? 'rotate-0' : '-rotate-90',
                      )}
                    />
                    <span className="shrink-0 whitespace-nowrap text-md font-semibold leading-5 text-foreground">
                      Deeper analytics
                    </span>
                    <span
                      className="min-w-0 basis-full whitespace-normal pl-6 text-sm font-normal text-muted-foreground md:basis-0 md:flex-1 md:pl-0"
                      data-testid="deeper-summary"
                      title={!deeperOpen && deeperSummary.full ? deeperSummary.full : undefined}
                    >
                      {deeperOpen || !deeperSummary.text
                        ? 'Timing, spend, ingest coverage, volume, workload and outcomes'
                        : deeperSummary.text}
                    </span>
                  </button>
                </CollapsibleTrigger>
              </h2>

              <CollapsibleContent id="overview-deeper-region" className="pt-6">
                {/* From 1920px the two sub-bands sit side by side. The efficiency column is
                    capped at 38rem so its four-tile strip stays a 2 × 2 (the strip turns
                    four-across at 40rem of its own width): four-across in a 5/12 column
                    left ~165px tiles that cut "no case has been acknowledged yet" and
                    "43K tokens · 36 calls" to an ellipsis — data a reader could no longer
                    see. MEASURED at 1920 and 2560. */}
                <div
                  className={cn(
                    'grid min-w-0 items-stretch gap-x-6 gap-y-10 3xl:gap-x-10',
                    '3xl:grid-cols-[minmax(0,38rem)_minmax(0,1fr)]',
                  )}
                >
                  {/* -- Sub-band: Efficiency and cost -------------------------------- */}
                  <section
                    aria-labelledby="overview-deeper-efficiency"
                    className="flex min-w-0 flex-col"
                  >
                    <SubBandTitle
                      id="overview-deeper-efficiency"
                      caption={`Timing and spend over the ${windowPhrase}`}
                    >
                      Efficiency and cost
                    </SubBandTitle>
                    {/* A second continuous strip — the same KpiTile strip grammar as the
                        page's strip, four cells, its own dividers (KpiTileGrid draws one
                        hairline grammar at every column count, with no empty tracks). */}
                    <KpiTileGrid
                      count={4}
                      framed={false}
                      containerClassName="border-y border-border"
                      data-testid="deeper-timing-strip"
                    >
                      {timing.map((s) => {
                        // Honest per-metric series: MTTA reuses the ACK-based `respond`
                        // daily series, MTTR the `resolve` series. Dwell has NO server
                        // series, so its tile carries no trend affordance.
                        const timingSeries =
                          s.key === 'mtta'
                            ? timingTrends?.respond
                            : s.key === 'mttr'
                              ? timingTrends?.resolve
                              : undefined;
                        const measured = s.value !== DASH;
                        const tile = (
                          <KpiTile
                            variant="strip"
                            density="comfortable"
                            numeral="hero"
                            size="fluid"
                            label={s.label}
                            value={s.value}
                            context={measured ? s.sub : undefined}
                            sub={measured ? undefined : s.sub}
                            accent={s.accent}
                            icon={Clock3}
                            goodDirection="down"
                            help={
                              s.key === 'mtta'
                                ? `${s.help} The Respond figure under Cases and response reads this same clock.`
                                : s.help
                            }
                            askTopic={kpiTopic(s.key)}
                            // The context/state line wraps in its two-line slot (KpiTile,
                            // every hero strip since the final review): at 1280 with the
                            // navigation pinned these tiles are ~215px, and a server reason
                            // such as "no case has been acknowledged yet" takes two lines.
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
                            // The tile's HelpTip (?) is already a tab stop and focus bubbles
                            // to the trigger, so the wrapper adds no second stop; the tile is
                            // not clickable, so a press toggles the card (touch).
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
                          variant="strip"
                          density="comfortable"
                          numeral="hero"
                          size="fluid"
                          testId="llm-spend-detail"
                          label="LLM spend"
                          value={
                            usageUnavailable ? 'Unavailable' : fmtMoney(usage?.total_cost, usage?.currency)
                          }
                          sub={usageUnavailable ? usageFailureSub : undefined}
                          context={
                            usageUnavailable
                              ? undefined
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
                        />
                      </MetricHoverTrend>
                    </KpiTileGrid>

                    {/* Stacked in the narrow column from 1920px, coverage keeps its own
                        height and the volume chart takes whatever the taller neighbouring
                        sub-band leaves (no dead space inside the coverage block). */}
                    <div className="mt-8 grid flex-1 items-stretch gap-x-6 gap-y-8 xl:grid-cols-12 3xl:grid-cols-1 3xl:grid-rows-[auto_minmax(0,1fr)]">
                      <Instrument
                        title="Ingest coverage"
                        caption="Right now · am I seeing everything?"
                        className="xl:col-span-5 2xl:col-span-4 3xl:col-span-1"
                        data-scope="live"
                      >
                        {coverage ? (
                          <CoverageTile coverage={coverage} onNavigate={navigate} roll={rollKpis} />
                        ) : (
                          <EmptyState
                            compact
                            icon={Plug}
                            title="Coverage not yet reported"
                            description="Per-source ingest coverage appears once the poller reports its first tick."
                          />
                        )}
                      </Instrument>
                      <Instrument
                        title="Case volume"
                        caption={
                          metrics?.truncated === true &&
                          typeof metrics.fetched === 'number' &&
                          typeof metrics.store_total === 'number'
                            ? `Cases opened per UTC day · newest ${fmtNumber(metrics.fetched)} of ${fmtNumber(metrics.store_total)} cases`
                            : 'Cases opened per UTC day · all time'
                        }
                        className="xl:col-span-7 2xl:col-span-8 3xl:col-span-1"
                        data-scope="all"
                      >
                        <VolumeColumns data={caseVolume} />
                      </Instrument>
                    </div>
                  </section>

                  {/* -- Sub-band: What's driving volume ------------------------------ */}
                  <section
                    aria-labelledby="overview-deeper-volume"
                    className="flex min-w-0 flex-col"
                  >
                    <SubBandTitle
                      id="overview-deeper-volume"
                      caption="Each instrument names its own time span"
                    >
                      What&rsquo;s driving volume
                    </SubBandTitle>
                    <div className="grid flex-1 items-stretch gap-x-6 gap-y-8 md:grid-cols-2">
                      <Instrument
                        title="Case workload state"
                        count={workloadItems.length}
                        caption={
                          workload.scope === 'all'
                            ? 'All time · every case in the store'
                            : caseSampleScope
                        }
                        data-scope={workload.scope}
                      >
                        {workloadItems.length ? (
                          <ul className="flex flex-col gap-3">
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
                                        ? () =>
                                            navigate?.(
                                              'cases',
                                              // An all-time count opens an all-time list
                                              // (no window), so the list holds the number
                                              // the row shows.
                                              workload.scope === 'all'
                                                ? { status }
                                                : { status, window: navWindow },
                                            )
                                        : undefined
                                    }
                                    className={cn(
                                      'block w-full rounded-md text-left',
                                      clickable &&
                                        '-mx-1 px-1 py-0.5 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                    )}
                                    aria-label={clickable ? `View ${humanizeToken(status)} cases` : undefined}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <span className="truncate text-sm font-medium text-foreground">
                                        {humanizeToken(status)}
                                      </span>
                                      <span className="text-sm font-semibold tabular-nums text-foreground">
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
                      </Instrument>

                      <Instrument
                        title="Case outcomes"
                        count={verdictMix.total}
                        caption={
                          verdictMix.scope === 'window'
                            ? `AI-verdict mix · ${windowPhrase}`
                            : verdictMix.scope === 'all'
                              ? 'AI-verdict mix · all time, every case in the store'
                              : `AI-verdict mix · ${caseSampleScope}`
                        }
                        data-scope={verdictMix.scope}
                      >
                        {verdictMix.total > 0 ? (
                          <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
                            {/* The centre states the numeral with a sentence-case "AI verdicts"
                                at 12px BELOW it, inside a hole sized for both (Round 12): the
                                tracked uppercase "VERDICTS" ran over the ring ("ERDICTS"). */}
                            <DonutChart
                              segments={verdictMix.segments}
                              height={VERDICT_RING_PX}
                              thickness={0.3}
                              className="w-40 shrink-0"
                              ariaLabel="Case outcomes by AI verdict"
                              center={
                                <>
                                  {/* The VERDICTED count: unverdicted cases are not "AI
                                      verdicts" (they keep their own legend row). */}
                                  <span className="text-2xl font-semibold leading-none tabular-nums text-foreground">
                                    {fmtNumber(verdictMix.verdicted)}
                                  </span>
                                  <span className="text-xs leading-tight text-muted-foreground">
                                    AI verdicts
                                  </span>
                                </>
                              }
                            />
                            <ul className="w-full max-w-[15rem] space-y-2">
                              {verdictMix.segments.map((seg) => {
                                const pct = Math.round((seg.value / verdictMix.total) * 100);
                                return (
                                  <li key={seg.label} className="flex items-center gap-2 text-sm">
                                    <span
                                      className="h-2 w-2 shrink-0 rounded-full"
                                      style={{ backgroundColor: seg.color }}
                                      aria-hidden
                                    />
                                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                      {seg.label}
                                    </span>
                                    <span className="font-semibold tabular-nums text-foreground">
                                      {fmtNumber(seg.value)}
                                    </span>
                                    <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                                      {pct}%
                                    </span>
                                  </li>
                                );
                              })}
                              {/* Only beside the WINDOW mix it was counted with: never under
                                  all-time verdicts (two spans read as one population). */}
                              {verdictMix.scope === 'window' && typeof analystConfirmedFp === 'number' ? (
                                <li
                                  className="flex items-center gap-2 pt-1 text-sm"
                                  data-testid="analyst-confirmed-fp"
                                >
                                  <span className="h-2 w-2 shrink-0" aria-hidden />
                                  <span className="min-w-0 flex-1 text-muted-foreground">
                                    Confirmed false positive by an analyst
                                  </span>
                                  <span className="font-semibold tabular-nums text-foreground">
                                    {fmtNumber(analystConfirmedFp)}
                                  </span>
                                  <span className="w-9" aria-hidden />
                                </li>
                              ) : null}
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
                      </Instrument>

                      <Instrument
                        title="Top signatures"
                        count={signatureItems.length}
                        caption={`Most frequent detections · ${caseSampleScope}`}
                        data-scope={casePageComplete ? 'window' : 'sample'}
                      >
                        <BarList items={signatureItems} showRank showPercent emptyLabel="No signatures yet" />
                      </Instrument>

                      <Instrument
                        title="Top entities"
                        count={entityItems.length}
                        caption={`Most-implicated assets · ${caseSampleScope}`}
                        data-scope={casePageComplete ? 'window' : 'sample'}
                      >
                        <BarList items={entityItems} showRank showPercent emptyLabel="No entities yet" />
                      </Instrument>
                    </div>
                  </section>
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>
        </>
      )}

      {/* The case, opened OVER the dashboard: the SHARED <CaseDetail> (the same component
          the Scans and Investigate boards mount), so its RBAC gates, lifecycle actions and
          untrusted-text handling are the ones already reviewed there.

          Mounted CONDITIONALLY, which is not a style choice: CaseDetail calls `useAuth()`
          unconditionally, and `useAuth` throws outside an <AuthProvider>. This page uses no
          auth hook of its own and none of its specs supplies a provider. The honest cost
          is the sheet's exit animation: an unmount cannot play one. */}
      {openCaseId ? (
        <CaseDetail
          caseId={openCaseId}
          onClose={() => {
            setOpenCaseId(null);
            // A lifecycle action inside the sheet (close, escalate, assign) changes the
            // very numerals the strip and the bands are showing behind it.
            refreshAll();
          }}
          onNavigate={navigate}
        />
      ) : null}
    </PageContainer>
  );
}
