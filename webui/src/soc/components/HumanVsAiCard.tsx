/**
 * HumanVsAiCard — "Human vs AI": how the selected window's cases were CLOSED.
 *
 * The landing dashboard's close-attribution instrument. It replaced the Active Risk
 * Index in the instrument band because "who actually closed this work?" is the
 * question the autonomy story turns on, and the page already carries risk everywhere
 * else (per-case gauges, the severity donuts, the risk-ordered queue).
 *
 * WHAT IT SHOWS
 *   - Three headline counts + three RECONCILING percentages: agent-closed,
 *     analyst-closed, and the system/unattributed RESIDUAL. The denominator is the
 *     window's CLOSED (terminal) cases, so the three shares sum to exactly 100% and
 *     the residual is visible instead of being folded into either side.
 *   - A two/three-series trendline over the same window's buckets.
 *
 * HONESTY CONTRACT
 *   - `decision_by` is LAST-WRITER, not proof of authorship: an agent-closed case a
 *     human later merely ACKNOWLEDGES or re-tags migrates into the human series. The
 *     card discloses this in its (?) help affordance — it never claims the chart
 *     proves who did the work.
 *   - Operator "declared benign" (analyst rule policy) closes are excluded upstream:
 *     no model ran on them, so they are neither agent nor human triage work.
 *   - The residual band is labelled and always rendered; folding it away would leave
 *     two percentages that silently fail to sum to 100.
 *   - A missing/unreconciling partition renders an em dash per band — NEVER a
 *     reassuring 0% (ui-standard "Evidence-led analytics").
 *   - A bucket with no measurement is a GAP in the line (MultiSeriesTrend renders
 *     `null` as a gap), never a fabricated zero.
 *   - Alert volume, when shown, is a plainly LABELLED ingest-hour tally. It is a
 *     different population from the case cohort (many alerts collapse into one case
 *     by cluster signature), so it is never divided into a case count.
 *
 * Advisory (#3): purely a read of triage OUTCOMES. Nothing here feeds `decide()`.
 * Security (#9): every label is a local constant and every value a formatted number,
 * rendered as PLAIN text.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { DASH, fmtNumber } from '@/lib/format';
import { HelpTip } from './HelpTip';
import { MultiSeriesTrend, type MultiSeries } from './charts-soc';
import { token } from './palette';

/** The three-way close-attribution partition for the selected window. */
export interface HumanVsAiTotals {
  /** Terminal cases whose last recorded decider was the AGENT. */
  ai: number;
  /** Terminal cases whose last recorded decider was an ANALYST. */
  human: number;
  /** The honest residual: deterministic SYSTEM routing + legacy/absent provenance. */
  system: number;
  /** Terminal (closed) cases in the window — the shared denominator. */
  closed: number;
}

/**
 * One bucket of the close-attribution trend. `null` renders as a GAP in that line,
 * never a fabricated 0. Declared as a type alias (not an interface) so it carries an
 * implicit index signature and drops straight into `MultiSeriesTrend`'s row shape
 * without a cast.
 */
export type HumanVsAiPoint = {
  /** Short plain-text bucket label for the X axis. */
  x: string;
  ai: number | null;
  human: number | null;
  system: number | null;
};

export interface HumanVsAiCardProps {
  /**
   * The reconciled window partition, or `null` when close attribution is not
   * measurable (an older backend, a failed posture read, or a partition that does
   * not add up) — every band then renders an em dash.
   */
  totals: HumanVsAiTotals | null;
  /** Why `totals` is null — shown as the card's honest unavailable line. */
  unavailableReason?: string;
  /** The bucket series, or `null` when no honest close-attribution series exists. */
  series: HumanVsAiPoint[] | null;
  /** Window/bucket disclosure, e.g. "last 24 hours · 1h buckets". */
  windowLabel: string;
  /** True when the underlying case scan was bounded (shares stay unavailable). */
  truncated?: boolean;
  /** Raw alerts ingested in the window (labelled ingest tally), or null/undefined. */
  alertsIngested?: number | null;
  className?: string;
}

/** The (?) disclosure. Long enough that HelpTip renders it as a focusable popover. */
export const HUMAN_VS_AI_HELP =
  'Attribution records the LAST decider on a case, not proof of who did the work: an ' +
  'agent-closed case that a human later acknowledges or re-tags moves into the human ' +
  'share. System covers deterministic routing plus older cases that recorded no ' +
  'decider, and operator "declared benign" policy closes are excluded entirely. ' +
  'Shares are of closed cases in this window and always add up to 100%.';

/** Band identity: key, short label, and the series colour it shares with the chart. */
interface BandDef {
  key: 'ai' | 'human' | 'system';
  label: string;
  /** Full plain-text meaning (tooltip/title) for the truncated short label. */
  title: string;
  color: string;
}

/**
 * Identity-ARBITRARY series, so the colours come from the colourblind-safe
 * categorical `--chart-*` ramp rather than the severity/status/verdict axes — an
 * "AI vs human" split must not borrow a red/green severity reading. `--chart-8` is
 * the ramp's reserved neutral, which is exactly right for the residual.
 */
const BANDS: BandDef[] = [
  { key: 'ai', label: 'AI agent', title: 'Closed by the agent', color: token('chart-1') },
  { key: 'human', label: 'Human', title: 'Closed by an analyst', color: token('chart-2') },
  {
    key: 'system',
    label: 'System',
    title: 'System routing or no recorded decider (unattributed)',
    color: token('chart-8'),
  },
];

const CHART_SERIES: MultiSeries[] = BANDS.map((b) => ({
  key: b.key,
  label: b.label,
  color: b.color,
}));

/**
 * Split `parts` into whole percentages of `total` that sum to EXACTLY 100 (largest
 * remainder), or `null` when the split cannot be trusted.
 *
 * Returns null unless every part is a finite non-negative number, `total` is a
 * positive finite number, AND the parts sum to `total` — i.e. the partition actually
 * reconciles. A set of shares that does not reconcile must render as em dashes, not
 * as three numbers massaged up to 100%.
 */
export function reconcilingShares(parts: number[], total: number): number[] | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!parts.length) return null;
  if (parts.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0)) return null;
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum !== total) return null;
  const exact = parts.map((p) => (p / total) * 100);
  const out = exact.map((v) => Math.floor(v));
  let remainder = 100 - out.reduce((a, b) => a + b, 0);
  const byFraction = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byFraction.length && remainder > 0; k += 1) {
    out[byFraction[k].i] += 1;
    remainder -= 1;
  }
  return out;
}

/**
 * Close-attribution instrument: three reconciling headline shares over one
 * two/three-series trendline. Flat (no card chrome) so it reads as one cell of the
 * dashboard's instrument band, matching its sibling cells.
 */
export function HumanVsAiCard({
  totals,
  unavailableReason = 'Close attribution is not reported for this window.',
  series,
  windowLabel,
  truncated = false,
  alertsIngested,
  className,
}: HumanVsAiCardProps) {
  // Truncated evidence cannot support a share: a bounded scan under-counts every
  // band, so the percentages are suppressed rather than quietly understated.
  const shares = React.useMemo(
    () =>
      totals && !truncated
        ? reconcilingShares([totals.ai, totals.human, totals.system], totals.closed)
        : null,
    [totals, truncated],
  );

  return (
    <section
      aria-label="Human vs AI"
      data-testid="human-vs-ai"
      className={cn('flex h-full min-w-0 flex-col p-3', className)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">
            Human vs AI
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            How this window&rsquo;s cases were closed
          </p>
        </div>
        <HelpTip
          text={HUMAN_VS_AI_HELP}
          label="About Human vs AI attribution"
          className="-my-1 shrink-0 text-muted-foreground/70"
        />
      </div>

      <ul className="mt-2.5 grid grid-cols-3 gap-2" data-testid="human-vs-ai-totals">
        {BANDS.map((band, i) => {
          const count = totals ? fmtNumber(totals[band.key]) : DASH;
          const pct = shares ? `${shares[i]}%` : DASH;
          return (
            <li key={band.key} className="min-w-0" data-testid={`human-vs-ai-${band.key}`}>
              <div className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: band.color }}
                  aria-hidden
                />
                <span className="min-w-0 truncate text-2xs text-muted-foreground" title={band.title}>
                  {band.label}
                </span>
              </div>
              <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
                <span className="font-mono text-xl font-semibold leading-none tabular-nums text-foreground">
                  {count}
                </span>
                <span className="font-mono text-2xs tabular-nums text-muted-foreground">{pct}</span>
              </div>
            </li>
          );
        })}
      </ul>

      {series && series.length ? (
        <div className="mt-2 min-w-0 flex-1" data-testid="human-vs-ai-chart">
          <MultiSeriesTrend
            data={series}
            series={CHART_SERIES}
            xKey="x"
            height={122}
            showYAxis={false}
            showLegend={false}
            format={fmtNumber}
            ariaLabel="Cases closed by the agent versus by a human, per case-arrival bucket"
          />
        </div>
      ) : (
        <p
          className="mt-2 flex-1 text-2xs text-muted-foreground"
          data-testid="human-vs-ai-no-series"
        >
          No close-attribution trend for this window yet.
        </p>
      )}

      <div className="mt-1.5 space-y-0.5">
        {totals ? null : (
          <p className="text-2xs text-muted-foreground" data-testid="human-vs-ai-unavailable">
            {unavailableReason}
          </p>
        )}
        <p className="text-2xs text-muted-foreground">
          Share of closed cases · by case-arrival bucket · {windowLabel}
          {truncated ? ' · bounded sample, shares unavailable' : ''}
        </p>
        {typeof alertsIngested === 'number' && Number.isFinite(alertsIngested) ? (
          <p className="text-2xs text-muted-foreground/80" data-testid="human-vs-ai-alerts">
            Ingest context: {fmtNumber(alertsIngested)} alerts ingested (an ingest-hour tally, not
            this case cohort).
          </p>
        ) : null}
        <p className="text-2xs text-muted-foreground/80">
          Advisory only — the agent recommends; the deterministic case manager decides. This
          dashboard never influences that.
        </p>
      </div>
    </section>
  );
}

export default HumanVsAiCard;
