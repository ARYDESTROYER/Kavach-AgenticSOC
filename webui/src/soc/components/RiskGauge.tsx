import * as React from 'react';
import { cn } from '@/lib/cn';
import { scoreBand, type ScoreBand } from './palette';

export interface RiskGaugeProps {
  /** Risk score 0-100 (clamped). */
  score: number;
  /** Optional label under the value (plain text). */
  label?: string;
  /** Optional pixel size of the gauge (width). Defaults to 160 (compact). */
  size?: number;
  /**
   * Round-7 W0.1 — when true, the coloured arc DRAWS IN from empty to `score` on
   * mount (via the existing `stroke-dashoffset` CSS transition). Defaults to false so
   * every current call site renders byte-identically (the arc is filled immediately).
   * Reduced motion is honoured globally (the transition collapses to ~0ms).
   */
  animateValue?: boolean;
  /**
   * Round-7 W0.1/W2.b — optional 0-100 threshold marker drawn as a small radial tick on
   * the MUTED track (e.g. the `critical` auto-escalate boundary). Drawn only when
   * provided; the Active-Risk-Index instrument passes it (W2.b, `notch={74}`) so the
   * header gauge shows how close active pressure sits to critical. It is a `<line>`,
   * never a `<path>`, so it does not affect the 2-path arc geometry other components
   * assert on, and it is decorative (`aria-hidden`) — the value/band already carry the
   * meaning for assistive tech.
   */
  notch?: number;
  className?: string;
}

/**
 * Per-band semantic tokens, written as LITERAL class strings so the Tailwind JIT
 * emits them. `text-*` sets `color` (→ `currentColor`, consumed by the progress
 * arc's `stroke="currentColor"`) and `stroke-*` is a belt-and-braces fallback so
 * the arc is coloured even if `currentColor` resolution is ever bypassed.
 *
 * These are passed LAST to `cn()` at the call sites so tailwind-merge keeps them.
 */
const TEXT_CLASS: Record<ScoreBand, string> = {
  critical: 'text-critical stroke-critical',
  high: 'text-high stroke-high',
  medium: 'text-medium stroke-medium',
  low: 'text-low stroke-low',
};

/**
 * The value and band WORD use the AA `-text` companions: the fill tokens are tuned for
 * the arc and fall short of 4.5:1 as small text on a light card (Medium 3.26:1, High
 * 3.98:1; ui-standard: small copy uses `*-text`). The swatch keeps the fill colour.
 */
const LABEL_CLASS: Record<ScoreBand, string> = {
  critical: 'text-critical-text',
  high: 'text-high-text',
  medium: 'text-medium-text',
  low: 'text-low-text',
};

/**
 * Human-readable band label for non-color signaling (a11y §6.1: the gauge shows a
 * numeric value AND a text band label, never color-only). Keyed by the canonical
 * `scoreBand` so the WORD, the arc colour, RiskBadge and posture all agree on the
 * ONE 0-100 ladder (74/48/22 — palette.ts), never a divergent gauge-only ladder.
 */
const BAND_LABEL: Record<ScoreBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Crisp half-circle risk gauge.
 *
 * The arc is a single fixed half-circle path drawn TWICE: a muted full-length
 * track and, on top, a severity-coloured progress stroke revealed left→right via
 * `stroke-dasharray` / `stroke-dashoffset`. This avoids per-score arc geometry
 * (no floating-point endpoint math, so the path is always finite) and avoids the
 * earlier defects entirely:
 *
 *  - Colour: the progress stroke is `currentColor` on the SAME element that
 *    carries the band `text-*` class — no `<defs>` gradient whose stops resolved
 *    `currentColor` against the document foreground (the old near-white sliver).
 *  - Caps: the rounded start cap rides the coloured arc (never a bare baseline),
 *    so it can't read as a stray dark half-disc / blob.
 *  - Layout: the value overlay is a height-bounded flex container inside the bowl,
 *    with the score and `/100` on ONE line, so it never overflows into the
 *    external label below the svg.
 */
export const RiskGauge = React.forwardRef<HTMLDivElement, RiskGaugeProps>(
  ({ score, label, size = 160, animateValue = false, notch, className }, ref) => {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
    const w = size;
    const stroke = Math.max(8, Math.round(size * 0.07));
    const pad = Math.max(2, Math.round(stroke / 2));
    const cx = w / 2;
    const r = w / 2 - stroke / 2 - pad;
    const cy = stroke / 2 + pad + r; // baseline sits at the bottom of the arc
    // Height bounds the rounded caps that ride the baseline.
    const h = cy + Math.ceil(stroke / 2) + pad;

    // One fixed half-circle (left baseline → over the top → right baseline),
    // rounded to 3dp so the string is deterministic + NaN-free for finite inputs.
    const d = `M ${(cx - r).toFixed(3)} ${cy.toFixed(3)} A ${r.toFixed(3)} ${r.toFixed(
      3,
    )} 0 0 1 ${(cx + r).toFixed(3)} ${cy.toFixed(3)}`;
    const len = Math.PI * r;
    const dashOffset = (1 - clamped / 100) * len;

    // Round-7 W0.1 — optional mount draw-in. `drawn` starts true when animation is off,
    // so the default render is byte-identical (offset = dashOffset immediately). When on,
    // the first paint shows the EMPTY arc (offset = len) then a rAF flips `drawn`, and the
    // element's existing `transition-[stroke-dashoffset]` animates the fill.
    const [drawn, setDrawn] = React.useState(!animateValue);
    React.useEffect(() => {
      if (!animateValue) return;
      const id = requestAnimationFrame(() => setDrawn(true));
      return () => cancelAnimationFrame(id);
    }, [animateValue]);
    const renderedOffset = animateValue && !drawn ? len : dashOffset;

    // Round-7 W0.1 — optional threshold notch geometry. The semicircle sweeps from the
    // left baseline (value 0, θ=π) over the top to the right baseline (value 100, θ=0);
    // a value maps to θ = π·(1 − f). The tick spans the stroke thickness radially.
    const notchLine =
      typeof notch === 'number' && Number.isFinite(notch)
        ? (() => {
            const f = Math.max(0, Math.min(100, notch)) / 100;
            const theta = Math.PI * (1 - f);
            const cos = Math.cos(theta);
            const sin = Math.sin(theta);
            const inner = r - stroke / 2;
            const outer = r + stroke / 2;
            return {
              x1: cx + inner * cos,
              y1: cy - inner * sin,
              x2: cx + outer * cos,
              y2: cy - outer * sin,
            };
          })()
        : null;

    const band = scoreBand(clamped);
    const titleId = `gauge-title-${React.useId().replace(/:/g, '')}`;

    // Value font caps to the bowl so it never collides with the external label.
    const valueFont = Math.min(size * 0.22, cy * 0.5);
    const suffixFont = Math.max(9, valueFont * 0.42);

    return (
      <div ref={ref} className={cn('flex flex-col items-center', className)}>
        <div className="relative" style={{ width: w, height: h }}>
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={titleId}>
            <title id={titleId}>
              {label ? `${label}: ` : 'Risk '}
              {Math.round(clamped)} of 100 ({BAND_LABEL[band]})
            </title>
            {/* Muted track — the full semicircle. */}
            <path d={d} fill="none" className="stroke-muted" strokeWidth={stroke} strokeLinecap="round" />
            {/* Severity-coloured progress, revealed left→right by the dash offset.
                `stroke="currentColor"` resolves against the band `text-*` class on
                THIS element (kept last in cn() so tailwind-merge keeps it). */}
            <path
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={len}
              strokeDashoffset={renderedOffset}
              className={cn('transition-[stroke-dashoffset] duration-500', TEXT_CLASS[band])}
            />
            {/* Optional threshold notch — a short radial tick across the track only. */}
            {notchLine ? (
              <line
                x1={notchLine.x1.toFixed(3)}
                y1={notchLine.y1.toFixed(3)}
                x2={notchLine.x2.toFixed(3)}
                y2={notchLine.y2.toFixed(3)}
                strokeWidth={2}
                strokeLinecap="round"
                className="stroke-muted-foreground"
                aria-hidden
              />
            ) : null}
          </svg>

          {/* Centred value overlay — height-bounded to the bowl, single line. */}
          <div
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end"
            style={{ height: cy, paddingBottom: pad }}
          >
            <div className="flex items-baseline">
              <span
                className={cn('font-semibold leading-none tracking-tight tabular-nums', LABEL_CLASS[band])}
                style={{ fontSize: valueFont }}
              >
                {Math.round(clamped)}
              </span>
              <span
                className="ml-1 font-medium uppercase tracking-wider text-muted-foreground"
                style={{ fontSize: suffixFont }}
              >
                /100
              </span>
            </div>
          </div>
        </div>
        {/* Text band label — non-color signaling (a11y §6.1): the WORD itself carries
            the meaning for assistive tech (plus the <title>), not only the arc/value
            colour. The beside-color swatch is a decorative <circle>-only SVG
            (`aria-hidden`) drawn WITH the band `text-*` colour; it deliberately emits
            no <path>, so the crisp 2-path donut geometry stays the only <path>s in the
            output. */}
        <div className="mt-1 flex flex-col items-center gap-0.5">
          <span
            className={cn(
              'flex items-center gap-1 text-xs font-semibold uppercase tracking-wider',
              LABEL_CLASS[band],
            )}
          >
            <svg
              width={10}
              height={10}
              viewBox="0 0 10 10"
              className={cn('shrink-0', TEXT_CLASS[band])}
              aria-hidden
              focusable="false"
            >
              <circle cx="5" cy="5" r="4" fill="currentColor" />
            </svg>
            {BAND_LABEL[band]}
          </span>
          {label ? (
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </span>
          ) : null}
        </div>
      </div>
    );
  },
);
RiskGauge.displayName = 'RiskGauge';

export default RiskGauge;
