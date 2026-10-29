/**
 * BaselineGauge: the anomaly-baseline WARM-UP gauge (Round 4 / Wave 4).
 *
 * Makes the "improves over time" story AUDITABLE: an operator can see, per cluster
 * signature and per seasonal bucket, how many observations a bucket has (`n`) vs the
 * warm-up target it needs before its percentiles are trusted (`target`), whether it
 * is WARM yet, and the live p50/p95/p99 percentiles from the persisted t-digest.
 *
 * Exports (all pure/presentational — the data comes from `Baseline.api.ts`):
 *   - `BaselineWarmupGauge` — a single bucket's n/target progress bar + warm badge.
 *   - `BaselinePercentileSparkline` — a p50/p95/p99 sparkline across buckets.
 *   - `BaselineSignatureCard` — the per-signature panel (gauge + percentiles). Pass
 *      `embedded` to drop the outer card chrome + shrink for embedding in a host panel.
 *      Mounted `embedded` in the CaseDetail Overview (`casedetail/OverviewPanel.tsx`)
 *      when the case's cluster signature has baseline data, and standalone as the
 *      per-signature drill-in on the Baseline page.
 *   - `BaselineStatsOverview` — the tenant-wide overview (signature/bucket counts,
 *      warm buckets, seasonality, config knobs). Round 14 (BL2, BL4): a `KpiStrip` of
 *      three counts, then the overall warm-up in a `Panel` (its progress track takes the
 *      panel's muted step, so an empty track stays visible in dark); seasonality and the
 *      detector knobs are one line of context text, never a numeral. The standalone
 *      signature card is a `Panel` (no nested card), and every label is 12px or larger in
 *      sentence case (F13).
 *
 * SECURITY (#9): a `signature` is source-derived (it can embed rule/entity text). It
 * is rendered ONLY as a plain React text node (never HTML, never a prompt input).
 * Numbers are numbers. #3/#4: this is a READ-ONLY advisory view — nothing here closes,
 * escalates, or mutates a signature.
 */
import * as React from 'react';
import { Gauge, ThermometerSun, Timer } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fmtNumber, humanizeToken, DASH } from '@/lib/format';
import { Panel } from '@/design-system/panel';
import { Badge } from '@/ui/badge';
import { Progress } from '@/ui/progress';
import { Sparkline } from '@/soc/components/charts';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { KpiTile } from '@/soc/components/KpiTile';
import { HelpTip } from '@/soc/components/HelpTip';
import type {
  BaselineBucketRow,
  BaselineSignature,
  BaselineStats,
} from '@/soc/Baseline.api';

/** Clamp a 0..1 progress into a 0..100 percentage for the <Progress> bar. */
function pctOf(progress: number): number {
  const p = Number.isFinite(progress) ? progress : 0;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

/** The warm-up help, shared by the embedded and standalone signature views. */
const SIGNATURE_HELP =
  'The baseline learns how much event volume each signature sees in each seasonal bucket. ' +
  'A bucket needs a target number of observations before it is warm and its percentiles ' +
  'are trusted, so detection improves over time. The baseline is advisory: a warm-up ' +
  'state never closes or escalates a case.';

/** A short warm-up label the gauge caption reuses. */
function warmupLabel(n: number, target: number): string {
  return `${fmtNumber(n)} / ${fmtNumber(target)}`;
}

// --------------------------------------------------------------------------- //
// BaselineWarmupGauge — one bucket's n/target progress + warm state.          //
// --------------------------------------------------------------------------- //
export interface BaselineWarmupGaugeProps {
  /** Observations seen so far. */
  n: number;
  /** Observations needed to be WARM. */
  target: number;
  /** Explicit warm flag (defaults to `n >= target`). */
  warm?: boolean;
  /** Pre-computed 0..1 progress (defaults to n/target). */
  progress?: number;
  /** Optional caption above the bar (e.g. "Bucket 14 (Mon 14:00)"). Plain text. */
  label?: string;
  /**
   * Unit noun for the caption + aria-label (default 'obs'). The signature-level card
   * aggregates WARM BUCKETS (not observations), so it passes 'buckets warm' to avoid
   * mislabelling bucket counts as observations. Plain text.
   */
  unit?: string;
  className?: string;
}

/**
 * A single warm-up gauge: an n/target progress bar + a "warm" / "warming up" badge.
 * This is the load-bearing "baseline warming up (n/target)" affordance.
 */
export const BaselineWarmupGauge = React.forwardRef<HTMLDivElement, BaselineWarmupGaugeProps>(
  ({ n, target, warm, progress, label, unit = 'obs', className }, ref) => {
    const safeTarget = target > 0 ? target : 1;
    const p = progress ?? n / safeTarget;
    const isWarm = warm ?? n >= target;
    const pct = pctOf(p);
    return (
      <div ref={ref} className={cn('flex flex-col gap-1.5', className)}>
        <div className="flex items-center justify-between gap-2">
          {label ? (
            <span className="truncate text-xs font-medium text-foreground">{label}</span>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">Warm-up</span>
          )}
          {isWarm ? (
            <Badge variant="success" className="shrink-0 gap-1">
              <ThermometerSun className="h-3 w-3" aria-hidden />
              Warm
            </Badge>
          ) : (
            <Badge variant="warning" className="shrink-0 gap-1">
              <Timer className="h-3 w-3" aria-hidden />
              Warming up
            </Badge>
          )}
        </div>
        <Progress
          value={pct}
          variant={isWarm ? 'success' : 'default'}
          aria-label={`Warm-up ${warmupLabel(n, target)} ${unit}`}
          className="h-2"
        />
        <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>
            {warmupLabel(n, target)} {unit}
          </span>
          <span>{pct}%</span>
        </div>
      </div>
    );
  },
);
BaselineWarmupGauge.displayName = 'BaselineWarmupGauge';

// --------------------------------------------------------------------------- //
// BaselinePercentileSparkline — p50/p95/p99 across a signature's buckets.     //
// --------------------------------------------------------------------------- //
export interface BaselinePercentileSparklineProps {
  series: BaselineBucketRow[];
  /** Which percentile to draw. Defaults to p95. */
  percentile?: 'p50' | 'p95' | 'p99';
  height?: number;
  className?: string;
}

/**
 * A compact sparkline of one percentile (default p95) across a signature's seasonal
 * buckets — a quick visual of the learned distribution shape over the season.
 */
export const BaselinePercentileSparkline = React.forwardRef<
  HTMLDivElement,
  BaselinePercentileSparklineProps
>(({ series, percentile = 'p95', height = 40, className }, ref) => {
  const values = (series ?? []).map((r) => {
    const v = r[percentile];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
  return (
    <Sparkline
      ref={ref}
      data={values}
      height={height}
      colorToken="primary"
      ariaLabel={`${percentile.toUpperCase()} across ${values.length} bucket(s)`}
      className={className}
    />
  );
});
BaselinePercentileSparkline.displayName = 'BaselinePercentileSparkline';

/** A tiny p50/p95/p99 read-out from a signature's warmest / representative buckets. */
function PercentileReadout({ series }: { series: BaselineBucketRow[] }) {
  // Prefer the warmest bucket (most observations) for a representative read-out.
  const rep = React.useMemo(() => {
    if (!series || series.length === 0) return null;
    return [...series].sort((a, b) => (b.n || 0) - (a.n || 0))[0];
  }, [series]);
  const fmt = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(v >= 100 ? 0 : 2) : DASH;
  return (
    <dl className="grid grid-cols-3 gap-2 text-center">
      {(['p50', 'p95', 'p99'] as const).map((k) => (
        <div key={k} className="rounded-md bg-muted px-2 py-1.5">
          <dt className="text-xs font-medium text-muted-foreground">{k}</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {rep ? fmt(rep[k]) : DASH}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// --------------------------------------------------------------------------- //
// BaselineSignatureCard — the per-signature panel (gauge + percentiles).      //
// --------------------------------------------------------------------------- //
export interface BaselineSignatureCardProps {
  data: BaselineSignature;
  /** Drop the outer card chrome + shrink for embedding (e.g. on CaseDetail). */
  embedded?: boolean;
  /** Percentile drawn in the sparkline (default p95). */
  percentile?: 'p50' | 'p95' | 'p99';
  className?: string;
}

/**
 * The per-signature warm-up panel. Aggregates every bucket's warm-up into one
 * "N of M buckets warm" gauge + a representative percentile read-out + a sparkline.
 * Usable standalone (a baseline stats page) or embedded on CaseDetail.
 */
export const BaselineSignatureCard = React.forwardRef<HTMLDivElement, BaselineSignatureCardProps>(
  ({ data, embedded = false, percentile = 'p95', className }, ref) => {
    const buckets = data?.buckets ?? 0;
    const warm = data?.warm_buckets ?? 0;
    const series = data?.series ?? [];
    // Aggregate warm-up: fraction of buckets that are warm (the signature is "ready"
    // when all its seasonal buckets have warmed).
    const progress = buckets > 0 ? warm / buckets : 0;
    const fullyWarm = buckets > 0 && warm === buckets;
    // Total observations gathered so far across all buckets, vs the aggregate target.
    const totalN = series.reduce((a, r) => a + (r.n || 0), 0);
    const aggTarget = buckets > 0 ? buckets * (data.warmup_target || 1) : data.warmup_target || 1;

    const body = (
      <div className="flex flex-col gap-4">
        {!data.found ? (
          <p className="text-xs text-muted-foreground">
            No baseline recorded for this signature yet. It begins warming up as matching
            events arrive.
          </p>
        ) : (
          <>
            <BaselineWarmupGauge
              n={warm}
              target={buckets}
              warm={fullyWarm}
              progress={progress}
              label={`${fmtNumber(warm)} of ${fmtNumber(buckets)} buckets warm`}
              unit="buckets warm"
            />
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md bg-muted px-2.5 py-1.5">
                <dt className="text-xs font-medium text-muted-foreground">Observations</dt>
                <dd className="mt-0.5 font-semibold tabular-nums text-foreground">
                  {fmtNumber(totalN)}{' '}
                  <span className="font-normal text-muted-foreground">
                    of {fmtNumber(aggTarget)}
                  </span>
                </dd>
              </div>
              <div className="rounded-md bg-muted px-2.5 py-1.5">
                <dt className="text-xs font-medium text-muted-foreground">Seasonality</dt>
                <dd className="mt-0.5 font-medium text-foreground">
                  {humanizeToken(data.seasonality) || DASH}
                </dd>
              </div>
            </dl>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {percentile} over the season
              </p>
              <BaselinePercentileSparkline series={series} percentile={percentile} />
            </div>
            <PercentileReadout series={series} />
          </>
        )}
      </div>
    );

    if (embedded) {
      // Embedded in a host panel (CaseDetail Overview): a compact title row, no chrome.
      return (
        <div ref={ref} className={cn('flex flex-col gap-3', className)}>
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="text-sm font-semibold text-foreground">Anomaly baseline</span>
            <HelpTip
              label="What the baseline warm-up means"
              text={SIGNATURE_HELP}
            />
          </div>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{data.signature}</p>
          {body}
        </div>
      );
    }

    return (
      <Panel
        ref={ref}
        title="Signature baseline"
        className={className}
        actions={
          <span className="flex items-center gap-2">
            <HelpTip label="What the baseline warm-up means" text={SIGNATURE_HELP} />
            {fullyWarm ? (
              <Badge variant="success" className="shrink-0">
                Ready
              </Badge>
            ) : (
              <Badge variant="warning" className="shrink-0">
                Warming
              </Badge>
            )}
          </span>
        }
      >
        {/* #9: signature is source-derived → plain, monospaced text node. */}
        <p className="-mt-1 mb-3 break-all font-mono text-xs text-muted-foreground">
          {data.signature}
        </p>
        {body}
      </Panel>
    );
  },
);
BaselineSignatureCard.displayName = 'BaselineSignatureCard';

// --------------------------------------------------------------------------- //
// BaselineStatsOverview — the tenant-wide warm-up + coverage overview.        //
// --------------------------------------------------------------------------- //
export interface BaselineStatsOverviewProps {
  stats: BaselineStats;
  className?: string;
}

/**
 * The tenant-wide overview: how many signatures have a baseline, how many buckets are
 * warm vs still warming, the warm-up target, and the config knobs (seasonality,
 * half-life, z-threshold). All read-only advisory.
 */
export const BaselineStatsOverview = React.forwardRef<HTMLDivElement, BaselineStatsOverviewProps>(
  ({ stats, className }, ref) => {
    const totalBuckets = stats?.total_buckets ?? 0;
    const warmBuckets = stats?.warm_buckets ?? 0;
    const warmPct = totalBuckets > 0 ? Math.round((warmBuckets / totalBuckets) * 100) : 0;
    const seasonality = humanizeToken(stats.seasonality) || DASH;
    return (
      <div ref={ref} className={cn('flex flex-col gap-4 xl:gap-5 3xl:gap-6', className)}>
        <KpiStrip label="Baseline summary" density="compact" data-testid="baseline-summary">
          <KpiTile
            label="Signatures"
            value={fmtNumber(stats.signature_count)}
            context={stats.enabled ? 'Baseline on' : 'Baseline off'}
          />
          <KpiTile
            label="Warm buckets"
            value={fmtNumber(warmBuckets)}
            context={`of ${fmtNumber(totalBuckets)} (${warmPct}%)`}
          />
          <KpiTile
            label="Warm-up target"
            value={fmtNumber(stats.warmup_target)}
            context="observations per bucket"
          />
        </KpiStrip>
        <Panel
          title="Overall warm-up"
          aside={
            <span className="tabular-nums">
              {fmtNumber(warmBuckets)} of {fmtNumber(totalBuckets)} buckets warm
            </span>
          }
          data-testid="baseline-warmup"
        >
          <Progress
            value={warmPct}
            variant={warmPct >= 60 ? 'success' : 'default'}
            aria-label={`Overall warm-up ${warmPct}%`}
            className="h-2"
          />
          <p className="mt-3 text-sm text-muted-foreground" data-testid="baseline-context">
            Seasonality {seasonality} · deviation bar z ≥ {stats.modified_z_threshold} ·
            half-life {stats.half_life_days} days · sketch version {stats.sketch_version}
          </p>
        </Panel>
      </div>
    );
  },
);
BaselineStatsOverview.displayName = 'BaselineStatsOverview';

export default BaselineSignatureCard;
