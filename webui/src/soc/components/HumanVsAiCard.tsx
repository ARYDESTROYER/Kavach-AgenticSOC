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
 *   - A STALE partition (the previous window's payload, while the newly selected
 *     window is still in flight) is withheld entirely: `windowLabel` already names the
 *     new window, so printing last window's counts beneath it would be a mislabel.
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
  /**
   * True while `totals` still describes the PREVIOUS window (stale-while-revalidate)
   * and `windowLabel` already names the NEWLY selected one. The card then withholds
   * every count/share rather than publishing last window's numbers under this
   * window's label — a mislabel is worse than a moment of em dashes.
   */
  stale?: boolean;
  /** Raw alerts ingested in the window (labelled ingest tally), or null/undefined. */
  alertsIngested?: number | null;
  className?: string;
}

/**
 * The (?) disclosure. Rendered as a POPOVER unconditionally — the call site passes
 * `alwaysPopover`, so this string's length is not what decides the presentation. That
 * matters because the closing sentence is the AGENTS.md §3 advisory and no longer appears
 * anywhere on the card face: trimming this text under HelpTip's 80-character threshold
 * must not silently demote a §3 statement to a tooltip a touch operator cannot open.
 */
export const HUMAN_VS_AI_HELP =
  // Relocated from the card FACE, where they were two static lines of prose above a chart
  // that had no room. Neither was already stated here — the overlap with the sentence
  // below is only semantic — so removing them from the face without adding them here
  // would have deleted them outright rather than moved them.
  'How this window’s cases were closed, as a share of closed cases. ' +
  'Attribution records the LAST decider on a case, not proof of who did the work: an ' +
  'agent-closed case that a human later acknowledges or re-tags moves into the human ' +
  'share. System covers deterministic routing plus older cases that recorded no ' +
  'decider, and operator "declared benign" policy closes are excluded entirely. ' +
  'Shares are of closed cases in this window and always add up to 100%. ' +
  // Relocated from the share line, where it was competing with the bucket granularity.
  'Trend buckets are keyed by case ARRIVAL time, not close time. ' +
  // Relocated from under the alerts numeral, which keeps only its population word.
  'The alerts-ingested figure is an ingest-hour tally, not this case cohort. ' +
  // POPOVER-ONLY since the operator asked (twice) for the face copy to go. This is the
  // AGENTS.md §3 separation of recommendation from the deterministic close authority, so
  // it must stay reachable by click/Enter/Space/tap — which is exactly what the
  // `alwaysPopover` on the call site below guarantees, rather than relying on this string
  // happening to stay over HelpTip's 80-character tooltip/popover threshold.
  'Advisory only — the agent recommends; the deterministic case manager decides. This ' +
  'dashboard never influences that.';

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

/**
 * The close-attribution partition's BAND IDENTITY, exported so any other surface that
 * states the same partition (the Resolved / Closed KPI tile's drill-down partition)
 * borrows these labels instead of minting its own. Two surfaces naming the same three
 * server keys differently is how a page ends up telling two stories about one number.
 * Order is fixed: agent, analyst, then the residual — which is always present.
 */
export const CLOSE_ATTRIBUTION_BANDS: ReadonlyArray<{
  key: 'ai' | 'human' | 'system';
  label: string;
  title: string;
}> = BANDS.map(({ key, label, title }) => ({ key, label, title }));

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
  stale = false,
  alertsIngested,
  className,
}: HumanVsAiCardProps) {
  // A stale partition belongs to the previous window; `windowLabel` already names the
  // new one, so the counts are withheld until the fresh payload lands.
  const shown = stale ? null : totals;
  // Truncated evidence cannot support a share: a bounded scan under-counts every
  // band, so the percentages are suppressed rather than quietly understated.
  const shares = React.useMemo(
    () =>
      shown && !truncated
        ? reconcilingShares([shown.ai, shown.human, shown.system], shown.closed)
        : null,
    [shown, truncated],
  );

  const describedById = React.useId();

  return (
    <section
      aria-label="Human vs AI"
      data-testid="human-vs-ai"
      // The relocated subtitle still describes this region to assistive tech. It points at
      // an `sr-only` node INSIDE the section, never at the help popover: that popover is a
      // Radix portal with no `forceMount`, so while it is closed the IDREF would dangle.
      aria-describedby={describedById}
      className={cn('flex h-full min-w-0 flex-col p-3', className)}
    >
      <p id={describedById} className="sr-only">
        How this window&rsquo;s cases were closed.
      </p>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">
            Human vs AI
          </h2>
        </div>
        <HelpTip
          text={HUMAN_VS_AI_HELP}
          label="About Human vs AI attribution"
          // The §3 advisory now lives ONLY here, so the popover presentation is a
          // requirement rather than a side effect of the help text's current length: a
          // Radix tooltip never opens on touch, and a later copy trim under 80 characters
          // would silently demote this to one a tablet operator could not reach.
          alwaysPopover
          className="-my-1 shrink-0 text-muted-foreground/70"
        />
      </div>

      <ul className="mt-2.5 grid grid-cols-3 gap-2" data-testid="human-vs-ai-totals">
        {BANDS.map((band, i) => {
          const count = shown ? fmtNumber(shown[band.key]) : DASH;
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
        /*
         * `relative` and the `min-h-` floor are BOTH required by `fill` and neither is
         * decorative. The chart is `absolute inset-0`, so it needs this box as its
         * positioned ancestor; and a flex item with no free space to take would collapse
         * to zero height without a floor — which is the real case on every load tick where
         * this card is the row's only child, when the funnel is unsupported and the card
         * takes the whole row, and at every width below `xl` where the row stacks. The
         * floor is the height the chart used to be pinned to, so it can only ever GROW
         * into space that was previously dead.
         */
        <div
          // Both numbers are FLOORS, not the usual height: beside the flow diagram this
          // card is stretched by the lattice row and `flex-1` hands the chart ~277px
          // (MEASURED at 1280/1440/1920), which is 38px more than before only because the
          // two prose lines above it went to the help popover. The floors bind in the cases
          // where nothing stretches the card — the loading tick, and a backend that cannot
          // serve the funnel at all, where this card takes the whole row — and `xl:` raises
          // the one that used to leave a narrow column's chart barely taller than its own
          // legend.
          className="relative mt-2 min-h-[122px] min-w-0 flex-1 xl:min-h-[160px]"
          data-testid="human-vs-ai-chart"
        >
          <MultiSeriesTrend
            data={series}
            series={CHART_SERIES}
            xKey="x"
            fill
            showYAxis={false}
            showLegend={false}
            format={fmtNumber}
            ariaLabel="Cases closed by the agent versus by a human, per case-arrival bucket"
          />
        </div>
      ) : (
        /* No `flex-1` here: one line of text stretched to fill the cell opened a gap three
           times the size of the one the chart used to leave. The footer below closes the
           card instead. */
        <p className="mt-2 text-2xs text-muted-foreground" data-testid="human-vs-ai-no-series">
          No close-attribution trend for this window yet.
        </p>
      )}

      <div className="mt-1.5 space-y-0.5">
        {shown ? null : stale ? (
          <p className="text-2xs text-muted-foreground" data-testid="human-vs-ai-stale">
            Loading this window — the previous window&rsquo;s counts are withheld.
          </p>
        ) : (
          <p className="text-2xs text-muted-foreground" data-testid="human-vs-ai-unavailable">
            {unavailableReason}
          </p>
        )}
        {/* `Share of closed cases ·` moved to the help popover; `{windowLabel}` did NOT.
            It is this chart's ONLY axis caption — it names the bucket granularity ("last
            24 hours · 1h buckets"), which is stated nowhere else on the card and cannot be
            inferred from the bars. Deleting it with the prose around it would have left the
            series unlabelled.

            The truncation clause stays on the FACE too, and is not prose: it is a
            conditional bound, true exactly when it renders. The band COUNTS above still
            print while it is up — only the shares read `—` — so without it those counts
            would be read as totals when they are lower bounds. */}
        <p className="text-2xs text-muted-foreground">
          {windowLabel}
          {truncated && !stale ? ' · bounded sample, shares unavailable' : ''}
        </p>
        {typeof alertsIngested === 'number' && Number.isFinite(alertsIngested) ? (
          // The numeral keeps a POPULATION word ("alerts"), because a bare count beside a
          // case cohort would be read as part of it. The rest of the disclaimer — that this
          // is an ingest-hour tally rather than a slice of these cases — is in the help.
          <p className="text-2xs text-muted-foreground" data-testid="human-vs-ai-alerts">
            {fmtNumber(alertsIngested)} alerts ingested
          </p>
        ) : null}
        {/* The §3 advisory line that used to sit here was removed at the operator's
            request. It is not gone: it is the closing sentence of HUMAN_VS_AI_HELP, on the
            (?) above, which `alwaysPopover` keeps reachable by click, Enter, Space and
            tap. Do not restate it here — that duplication is what was removed. */}
      </div>
    </section>
  );
}

export default HumanVsAiCard;
