/**
 * Overview — the Security Command Center (default landing surface).
 *
 * A dense command-center dashboard adapted from the operator-provided Stitch concept:
 *
 *   ┌ MASTHEAD ─── a PLAIN, dense <PageHeader> (no card / no glow — the big title sits
 *   │             flush on the page background, like the Sources page) carrying the
 *   │             <TimeRangePicker> + auto-refresh + a manual refresh pulse in its actions.
 *   ├ KPI STRIP ── five borderless alert/case telemetry cells separated by hairlines.
 *   ├ INSTRUMENT ── one integrated 12-column band: Active Risk Index (#1 — the ONE risk
 *   │             instrument), resolved/open donut snapshots, and the latest-case queue.
 *   ├ OPERATIONS ── the Noise-Reduction flow plus a compact burndown/timing rail.
 *   └ DEEPER ───── a COLLAPSED "Deeper analytics" group folding the secondary bands
 *                  (spend tripwire, full response timing, autonomy split, connectors,
 *                  case-volume, workload, top signatures/entities).
 *
 * Data: `usePosture(hours, 'prev')` is the AUTHORITATIVE server-side lifecycle rollup
 * (MTTA/MTTR/dwell/MTTD p50 + SLA + quality rates + period-over-period deltas).
 * `listCases` (current + previous window), `getMetrics` (burndown + timing_trend +
 * by_status), `usageSummary`, and `noiseReduction` are fetched with allSettled so one
 * failing call degrades a single widget, never the page. Usage and Noise Reduction keep
 * independent availability/error state: a failed refresh retains the last usable value,
 * names the unavailable slice, and offers a slice-only Retry. `noiseReduction` is typeof-
 * guarded so a minimal test/mock surface can still omit the optional funnel contract.
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
import type { Case, Metrics, NoiseReduction, SourceCoverage, UsageSummary } from '@/lib/types';
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
import { KpiTile, type KpiAccent, type KpiDelta } from '@/soc/components/KpiTile';
import { ActiveRiskIndex } from '@/soc/components/ActiveRiskIndex';
import { CaseHoverCard } from '@/soc/components/CaseHoverCard';
import { NoiseFunnel } from '@/soc/components/NoiseFunnel';
import { Reveal } from '@/soc/components/Reveal';
import { CountUp } from '@/soc/components/CountUp';
import { Stagger } from '@/soc/components/Stagger';
import { DonutChart, TrendArea, type DonutSegment } from '@/soc/components/charts';
import { BurnDownChart } from '@/soc/components/charts-soc';
import { token, VERDICT_COLOR } from '@/soc/components/palette';
import { isAutoClosedByAI, severityBand, severityBandFromNumber } from '@/soc/components/badges';
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
  ratioPct,
  deltaView,
  LIFECYCLE_METRICS,
  type LifecycleMetricKey,
} from './posture.format';
import type { StatBlock } from './Metrics.posture.api';

/**
 * The Overview hero title — the app's white-screen boot guard anchors on it (the
 * smoke test asserts the whole console boots to this string). Exported as a single
 * constant so the title can be reworded here WITHOUT breaking the tests that check
 * "the app booted" (they import this constant rather than hardcoding the copy).
 */
export const PAGE_TITLE = 'Security Command Center';

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

/** Per-browser dismissal flag for the recommended-automation nudge (onboarding). */
const NUDGE_KEY = 'tlsoc.overview.automationNudge';
/** Per-browser hide flag for the Noise-Reduction funnel band (the per-user hide toggle). */
const NOISE_HIDE_KEY = 'tlsoc.overview.noiseFunnelHidden';

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

/**
 * Adapt a `deltaView()` result to the KpiTile `delta` prop. Only render a delta when a
 * real comparison exists; the "new growth" case carries a 0 so the tile draws a neutral
 * marker with the "new" label.
 */
function toKpiDelta(dv: ReturnType<typeof deltaView>): KpiDelta | undefined {
  return dv.show ? { value: dv.value ?? 0, label: dv.label } : undefined;
}

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

/**
 * Six real arrival buckets for a KPI micro-trend. Omit the series when the response
 * carries no usable timestamps, so the strip never invents a decorative trend.
 */
function caseArrivalTrend(
  rows: Case[],
  fromMs: number,
  toMs: number,
  include: (row: Case) => boolean,
): number[] | undefined {
  const bucketCount = 6;
  const span = Math.max(1, toMs - fromMs);
  const buckets = Array.from({ length: bucketCount }, () => 0);
  let observed = 0;
  for (const row of rows) {
    if (!include(row)) continue;
    const ts = Date.parse(row.created_at || row.updated_at || '');
    if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
    const index = Math.min(bucketCount - 1, Math.floor(((ts - fromMs) / span) * bucketCount));
    buckets[index] += 1;
    observed += 1;
  }
  return observed > 0 ? buckets : undefined;
}

function formatWholePercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** One KPI-strip tile descriptor (built in a memo, rendered as a <KpiTile>). */
interface KpiItem {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon: LucideIcon;
  accent: KpiAccent;
  goodDirection: 'up' | 'down' | 'none';
  onClick?: () => void;
  delta?: KpiDelta;
  countTo?: number;
  format?: (n: number) => string;
  spark?: number[];
  sparkMinPoints?: number;
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

  return (
    <section className="min-w-0 border-b border-border/70 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">{title}</h2>
          <p className="text-2xs text-muted-foreground">{caption}</p>
        </div>
        <TrendChip delta={delta} goodDirection={goodDirection} />
      </div>
      {onClick ? (
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
      <div className="text-2xs text-muted-foreground/80">{detail}</div>
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
                      <span className="block font-mono text-2xs text-muted-foreground/70">
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
  const [prevCases, setPrevCases] = React.useState<Case[] | null>(null);
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [noise, setNoise] = React.useState<NoiseReduction | null>(null);
  const [coverage, setCoverage] = React.useState<SourceCoverage | null>(null);
  const noiseSupported = typeof api.noiseReduction === 'function';
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

  const load = React.useCallback(async () => {
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
      const [c, m, u, n, pc, cov] = await Promise.allSettled([
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
      ]);
      if (c.status === 'fulfilled') setCases(c.value.cases ?? []);
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
      setPrevCases(pc.status === 'fulfilled' ? pc.value.cases ?? [] : null);
      // Only surface a page-level error if the load is wholly empty.
      if (c.status === 'rejected' && m.status === 'rejected') {
        setError(c.reason ?? m.reason ?? new Error('Failed to load dashboard data.'));
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [hours, noiseSupported]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Server-side posture rollup — the AUTHORITATIVE lifecycle (MTTA/MTTR/dwell/MTTD p50 +
  // SLA + quality rates). `'prev'` also asks for the period-over-period `compare` block.
  const {
    data: postureResponse,
    loading: postureLoading,
    error: postureError,
    reload: reloadPosture,
  } = usePosture(hours, 'prev');
  // Defensive echo check at the rendering boundary. The hook already rejects a
  // mismatched payload; keeping this projection here makes every posture consumer
  // visibly tied to the selected window and prevents a future hook regression from
  // reintroducing cross-window tiles.
  const posture = postureResponse?.window_hours === hours ? postureResponse : null;

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
    let criticalHighAlerts = 0;
    let openCriticalHigh = 0;
    let resolvedCriticalHigh = 0;
    const sevCounts = emptySev();
    const openSev = emptySev();
    const resolvedSev = emptySev();

    for (const k of cases) {
      const st = (k.status || '').toLowerCase();
      const isOpen = OPEN_STATUSES.has(st);
      const isClosed = CLOSED_STATUSES.has(st);
      if (isOpen) open += 1;
      if (isClosed) resolved += 1;

      const band = bandOfCase(k);
      sevCounts[band] += 1;
      if (isOpen) openSev[band] += 1;
      if (isClosed) resolvedSev[band] += 1;
      if (band === 'critical' || band === 'high') {
        // Critical / High is intentionally ALL lifecycle work in the selected
        // dashboard window: still-open pressure + terminal cases. Unknown legacy
        // statuses are excluded rather than silently inflating a reconciliable KPI.
        if (isOpen) {
          criticalHighAlerts += 1;
          openCriticalHigh += 1;
        } else if (isClosed) {
          criticalHighAlerts += 1;
          resolvedCriticalHigh += 1;
        }
      }
    }

    return {
      open,
      resolved,
      criticalHighAlerts,
      openCriticalHigh,
      resolvedCriticalHigh,
      sevCounts,
      openSev,
      resolvedSev,
    };
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

  // ----- Autonomous-vs-human split (#3 trust surface) --------------------- //
  const autonomy = React.useMemo(() => {
    const q = posture?.quality;
    if (q && q.terminal_cases >= 0) {
      const autoClosed = q.auto_closed_cases ?? 0;
      const escalated = (q.escalated_cases ?? 0) + (q.needs_human_cases ?? 0);
      const total = autoClosed + escalated;
      return {
        autoClosed,
        escalated,
        automationPct: q.automation_rate ?? (total ? autoClosed / total : 0),
      };
    }
    let autoClosed = 0;
    let escalated = 0;
    for (const k of cases) {
      const st = (k.status || '').toLowerCase();
      if (st === 'needs_human' || st === 'escalated') escalated += 1;
      else if (isAutoClosedByAI(k.status, k.decision_by)) autoClosed += 1;
    }
    const total = autoClosed + escalated;
    return { autoClosed, escalated, automationPct: total ? autoClosed / total : 0 };
  }, [posture, cases]);

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

  // ----- Active Risk Index (#1) ------------------------------------------- //
  const activeRisk = React.useMemo<{ score: number | null; count: number }>(() => {
    if (
      typeof metrics?.active_risk_index === 'number' &&
      Number.isFinite(metrics.active_risk_index)
    ) {
      return {
        score: Math.round(metrics.active_risk_index),
        count: metrics.active_risk_case_count ?? derived.open,
      };
    }
    const openCases = cases.filter((k) => OPEN_STATUSES.has((k.status || '').toLowerCase()));
    if (openCases.length) {
      const mean = openCases.reduce((a, k) => a + (k.risk_score ?? 0), 0) / openCases.length;
      return { score: Math.round(mean), count: openCases.length };
    }
    const avg = metrics?.avg_risk_score;
    return {
      score: typeof avg === 'number' && Number.isFinite(avg) ? Math.round(avg) : null,
      count: 0,
    };
  }, [metrics, cases, derived.open]);

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

  // ----- KPI micro-strip — 5 alert/case signal tiles --------------------- //
  const kpis: KpiItem[] = React.useMemo(() => {
    const compare = posture?.compare;
    const fpRate = posture?.quality?.false_positive_rate;
    const fpPercent = typeof fpRate === 'number' ? Math.round(fpRate * 100) : undefined;
    const autoResolved = posture?.quality?.auto_closed_cases;
    const escalated = metrics?.needs_human_cases ?? autonomy.escalated;
    const { fromMs, toMs } = resolveRange(range);
    const openTrend = caseArrivalTrend(cases, fromMs, toMs, (row) =>
      OPEN_STATUSES.has((row.status || '').toLowerCase()),
    );
    const criticalTrend = caseArrivalTrend(cases, fromMs, toMs, (row) => {
      const band = bandOfCase(row);
      const status = (row.status || '').toLowerCase();
      const isKnownLifecycle = OPEN_STATUSES.has(status) || CLOSED_STATUSES.has(status);
      return isKnownLifecycle && (band === 'critical' || band === 'high');
    });
    const escalatedTrend = caseArrivalTrend(cases, fromMs, toMs, (row) => {
      const status = (row.status || '').toLowerCase();
      return status === 'needs_human' || status === 'escalated';
    });
    const resolvedTrend = caseArrivalTrend(cases, fromMs, toMs, (row) =>
      isAutoClosedByAI(row.status, row.decision_by),
    );
    const previousFpRate = compare?.false_positive_rate?.prev;
    // Both spark points come from the same authoritative server comparison as the
    // numeral and delta. Never mix the bounded case sample into this tile.
    const falsePositiveTrend =
      typeof fpRate === 'number' && typeof previousFpRate === 'number'
        ? [previousFpRate * 100, fpRate * 100]
        : undefined;
    const postureSub = postureLoading
      ? `Loading ${windowLabel(hours)}`
      : postureError
        ? 'Posture unavailable'
        : undefined;
    return [
      {
        label: 'Open Cases',
        value: fmtNumber(derived.open),
        countTo: derived.open,
        format: fmtInt,
        sub: `${fmtNumber(cases.length)} cases tracked`,
        icon: Inbox,
        accent: 'primary',
        spark: openTrend,
        goodDirection: 'down',
        onClick: navigate
          ? () => navigate('cases', { status: ACTIVE_CASES_FILTER, window: navWindow })
          : undefined,
      },
      {
        label: 'Critical / High',
        value: fmtNumber(derived.criticalHighAlerts),
        countTo: derived.criticalHighAlerts,
        format: fmtInt,
        // Visible arithmetic explains why this all-lifecycle number can be larger
        // than the terminal-only resolved snapshot immediately below it.
        sub: `${fmtNumber(derived.openCriticalHigh)} open + ${fmtNumber(derived.resolvedCriticalHigh)} resolved`,
        icon: ShieldAlert,
        accent: 'critical',
        spark: criticalTrend,
        goodDirection: 'down',
        // Cases currently supports one severity at a time. Applying only Critical
        // (or only High) would falsely claim to drill into this combined total, so
        // preserve only the honest selected-window scope.
        onClick: navigate ? () => navigate('cases', { window: navWindow }) : undefined,
      },
      {
        label: 'Escalated To Human',
        value: fmtNumber(escalated),
        countTo: escalated,
        format: fmtInt,
        sub: 'Awaiting review',
        icon: Workflow,
        accent: 'low',
        spark: escalatedTrend,
        goodDirection: 'down',
        onClick: navigate
          ? () => navigate('cases', { status: 'needs_human', window: navWindow })
          : undefined,
      },
      {
        label: 'False Positive Rate',
        value: typeof fpPercent === 'number' ? `${fpPercent}%` : DASH,
        countTo: fpPercent,
        format: formatWholePercent,
        sub: postureSub ?? 'Closed as false pos.',
        icon: Percent,
        accent: 'medium',
        spark: falsePositiveTrend,
        sparkMinPoints: 2,
        goodDirection: 'down',
        delta: toKpiDelta(deltaView(compare?.false_positive_rate)),
        onClick: navigate ? () => navigate('metrics', { tab: 'posture' }) : undefined,
      },
      {
        label: 'Auto-Resolved',
        value: fmtNumber(autoResolved),
        countTo: typeof autoResolved === 'number' ? autoResolved : undefined,
        format: fmtInt,
        sub: postureSub ?? 'Closed by agent',
        icon: ShieldCheck,
        accent: 'success',
        spark: resolvedTrend,
        goodDirection: 'up',
        onClick: navigate
          ? () => navigate('cases', { status: 'closed', window: navWindow })
          : undefined,
      },
    ];
  }, [
    derived,
    metrics,
    cases,
    range,
    navWindow,
    autonomy.escalated,
    posture,
    postureLoading,
    postureError,
    hours,
    navigate,
  ]);

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
        description="Live operational posture across triage, risk, and response."
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
              className="grid grid-cols-1 border-y border-border/70 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
              itemClassName="h-full min-w-0 border-b border-border/70 sm:border-r xl:border-b-0 xl:last:border-r-0"
            >
              {kpis.map((kpi) => (
                <KpiTile
                  key={kpi.label}
                  label={kpi.label}
                  value={kpi.value}
                  sub={kpi.sub}
                  icon={kpi.icon}
                  accent={kpi.accent}
                  variant="strip"
                  goodDirection={kpi.goodDirection}
                  delta={kpi.delta}
                  countTo={kpi.countTo}
                  format={kpi.format}
                  spark={kpi.spark}
                  sparkMinPoints={kpi.sparkMinPoints}
                  onClick={kpi.onClick}
                />
              ))}
            </Stagger>
            {posture?.compare ? (
              <p className="px-0.5 text-2xs text-muted-foreground">
                Deltas compare the previous {windowLabel(hours)}.
              </p>
            ) : null}
          </div>

          {/* ---- INSTRUMENT BAND: integrated risk · case state · live queue ---- */}
          <Reveal
            variant="rise"
            delay={40}
            data-testid="hero-row"
            className="grid min-w-0 items-stretch border-b border-border/70 lg:grid-cols-12"
          >
            <div className="min-w-0 border-b border-border/70 lg:col-span-4 lg:border-b-0 lg:border-r">
              <ActiveRiskIndex
                score={activeRisk.score}
                count={activeRisk.count}
                variant="flat"
                size={280}
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
                onClick={navigate ? () => navigate('cases', { status: 'closed', window: navWindow }) : undefined}
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
            className="grid min-w-0 border-b border-border/70 xl:grid-cols-12"
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
                      partial: posture ? posture.truncated === true : cases.length >= 200,
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
                  <span className="font-mono text-2xs text-muted-foreground">opn vs res</span>
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
                    <TimingStat
                      label="MTTD"
                      sub="Detect · log arrival → case"
                      block={mttdBlock}
                      dotClass="bg-info"
                      compact
                      help="Mean time to detect: the cluster's first event → case-open. Shown as an honest n/a when no case carries a first-event instant."
                    />
                  </div>
                  <div className="pl-4">
                    <TimingStat
                      label="Respond"
                      sub="First human action e.g. assignment / ack"
                      block={respondBlock}
                      dotClass="bg-success"
                      compact
                      help="Mean time to respond — the first active human response (investigating / escalated / assignment / ack)."
                    />
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
              {timing.map((s) => (
                <KpiTile
                  key={s.label}
                  variant="bar"
                  label={s.label}
                  value={s.value}
                  sub={s.sub}
                  accent={s.accent}
                  icon={Clock3}
                  goodDirection="down"
                  help={s.help}
                />
              ))}
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
            </div>

            {/* Autonomy split (#3) · connector health */}
            <Reveal variant="rise" className="grid gap-4 xl:grid-cols-2">
              <DashboardGroup title="Autonomous vs human" description="how cases were resolved">
                <Card>
                  <CardContent className="space-y-4 py-4">
                    <div className="flex items-center justify-center gap-2 text-4xl font-semibold tabular-nums">
                      <ShieldCheck className="h-7 w-7 text-success" aria-hidden />
                      <span className="text-foreground">{ratioPct(autonomy.automationPct)}</span>
                    </div>
                    <p className="text-center text-xs text-muted-foreground">
                      resolved autonomously by the agent
                    </p>
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-success"
                        style={{
                          width: `${Math.round(
                            (autonomy.autoClosed / (autonomy.autoClosed + autonomy.escalated || 1)) * 100,
                          )}%`,
                        }}
                        aria-hidden
                      />
                      <div className="h-full flex-1 bg-high" aria-hidden />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2">
                        <div className="font-mono text-lg font-semibold tabular-nums text-success-text">
                          {fmtNumber(autonomy.autoClosed)}
                        </div>
                        <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                          Auto-resolved
                        </div>
                      </div>
                      <div className="rounded-md border border-high/30 bg-high/5 px-3 py-2">
                        <div className="font-mono text-lg font-semibold tabular-nums text-high-text">
                          {fmtNumber(autonomy.escalated)}
                        </div>
                        <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                          Sent to human
                        </div>
                      </div>
                    </div>
                    <p className="text-2xs text-muted-foreground">
                      Advisory only — the agent recommends; the deterministic case manager
                      decides. This dashboard never influences that.
                    </p>
                  </CardContent>
                </Card>
              </DashboardGroup>

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
