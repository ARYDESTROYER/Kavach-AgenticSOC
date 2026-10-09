/**
 * ActiveRiskIndex — the ONE Command-Center risk instrument (#1).
 *
 * Renders, inside its OWN bordered soc <Card>, a compact "ACTIVE RISK INDEX" caption + a
 * (?) HelpTip explaining the exact math, and a RiskGauge showing the mean deterministic
 * risk score across the currently OPEN cases. When there are no open cases it degrades to
 * an honest DASH placeholder ("no open cases") rather than drawing a misleading zero gauge.
 *
 * The canonical value is computed server-side (`Metrics.active_risk_index`, W0.5) as the
 * mean deterministic `risk_score` over non-terminal cases; this component is presentation
 * only. It shares `ACTIVE_RISK_HELP_TEXT` (which folds in the per-factor `RISK_HELP_TEXT`)
 * with the per-case triage header so the two never disagree. The full band-cut ladder is
 * spelled out in the HelpTip copy (Critical ≥74 · High ≥48 · Medium ≥22 · Low <22).
 *
 * SECURITY (#9): the score is a code-derived number and the help copy is
 * author-controlled — both render as plain text only. #3: the Active Risk Index is
 * ranking-only and was never fed to the deterministic decide().
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { DASH, fmtNumber } from '@/lib/format';

import { Card } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { HelpTip } from '@/soc/components/HelpTip';
import { AskAboutThis } from './AskAboutThis';
import { KPI_TOPICS } from './ask-topics';
import { ACTIVE_RISK_HELP_TEXT } from '@/soc/components/riskCopy';

/** Comfortable instrument-size bounds for the responsive gauge (bug #5). */
export const MIN_GAUGE_SIZE = 140;
export const MAX_GAUGE_SIZE = 320;

export interface ActiveRiskIndexProps {
  /** Mean deterministic risk (0-100) over the open cases; null when unknown/loading. */
  score: number | null;
  /** Number of currently OPEN cases the mean was taken over. */
  count?: number;
  /** Show a placeholder while the metric is loading. */
  loading?: boolean;
  /**
   * Fallback/floor gauge width in px (default 180), used only before the container is
   * measured (e.g. jsdom tests, first paint with no ResizeObserver). The rendered
   * gauge otherwise scales responsively to the card's content width, clamped to
   * [MIN_GAUGE_SIZE, MAX_GAUGE_SIZE].
   */
  size?: number;
  /** `flat` removes card chrome for the integrated command-center instrument band. */
  variant?: 'card' | 'flat';
  className?: string;
}

/**
 * A compact caption + HelpTip that heads both states, so the affordance stays put
 * whether or not there are open cases to gauge.
 */
const Caption: React.FC = () => (
  <div className="flex items-center gap-1">
    <h2 className="text-2xs font-semibold uppercase tracking-widest text-foreground">
      Active Risk Index
    </h2>
    <HelpTip
      text={ACTIVE_RISK_HELP_TEXT}
      label="What the Active Risk Index means"
      footer={<AskAboutThis topic={KPI_TOPICS['active-risk-index']} subject="Active Risk Index" className="pt-1" />}
    />
  </div>
);

export const ActiveRiskIndex: React.FC<ActiveRiskIndexProps> = ({
  score,
  count,
  loading,
  size = 180,
  variant = 'card',
  className,
}) => {
  const hasOpen = (count ?? 0) > 0 && score != null && Number.isFinite(score);
  const flat = variant === 'flat';
  const Root: React.ElementType = flat ? 'section' : Card;

  // Bug #5 fix (1/2) — the gauge SCALES TO THE CARD WIDTH instead of a fixed 160/180px.
  // Measure the padded content area via ResizeObserver (identical pattern to
  // BrandingEditor's LoginPreview) and clamp to a comfortable instrument range;
  // jsdom (no RO / zero width in tests) simply falls back to `size`, which is harmless
  // for the non-visual test env — every existing test renders unchanged.
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setMeasuredWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const gaugeSize = Math.max(
    MIN_GAUGE_SIZE,
    Math.min(MAX_GAUGE_SIZE, measuredWidth || size),
  );

  return (
    <Root
      data-testid="active-risk-index"
      aria-label={flat ? 'Active Risk Index' : undefined}
      className={cn(
        'flex min-w-0 flex-col items-center gap-1.5',
        flat ? 'bg-transparent p-3' : 'p-5',
        className,
      )}
    >
      <Caption />
      {/* Bug #5 fix (2/2) — `flex-1` + `justify-center` so any EXTRA height the grid's
          `items-stretch` hands this card (to match the taller SnapshotCard siblings) is
          used to vertically CENTER the instrument, instead of collapsing into dead space
          below it (the old `flex-start` default). This div is also the ResizeObserver
          measurement target for `gaugeSize` above. */}
      <div
        ref={wrapRef}
        data-testid="active-risk-content"
        className="flex w-full flex-1 flex-col items-center justify-center gap-1.5"
      >
        {loading ? (
          <Skeleton
            className="rounded-lg"
            style={{ width: gaugeSize, height: Math.round(gaugeSize * 0.72) }}
            data-testid="active-risk-loading"
          />
        ) : hasOpen ? (
          <>
            {/* `notch={74}` marks the critical auto-escalate boundary on the track so
                the gauge reads active pressure AGAINST the escalation threshold, not in
                a vacuum. */}
            <RiskGauge score={score as number} size={gaugeSize} notch={74} />
            {/* Bug #5 — a small mini-legend using the freed card space: names the sample
                size + the escalation threshold the notch marks (both already known to the
                component, previously unused/undisplayed here). */}
            <p className="text-2xs text-muted-foreground">
              {fmtNumber(count as number)} open case{count === 1 ? '' : 's'} · escalates ≥74
            </p>
          </>
        ) : (
          <div
            data-testid="active-risk-empty"
            className="flex flex-col items-center justify-center gap-0.5 py-2"
            style={{ minWidth: gaugeSize }}
          >
            <span
              aria-hidden
              className="text-3xl font-semibold leading-none tabular-nums text-muted-foreground"
            >
              {DASH}
            </span>
            <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
              no open cases
            </span>
          </div>
        )}
      </div>
    </Root>
  );
};

export default ActiveRiskIndex;
