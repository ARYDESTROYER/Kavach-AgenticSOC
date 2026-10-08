/**
 * MitreHeatmap — the ATT&CK tactic × technique coverage grid (+ data-table fallback).
 *
 * Extracted from `charts-soc.tsx` (chat revamp SPEC §10.10) so a consumer can draw the
 * grid WITHOUT importing recharts: `charts-soc.tsx` pulls the whole recharts vendor
 * chunk, and the lazy chat answer-blocks chunk must never depend on it. `charts-soc.tsx`
 * re-exports everything here, so existing imports keep working unchanged.
 *
 * Pure DOM (no SVG paths, no recharts). The ramp is ALWAYS the colorblind-safe viridis
 * `sequential()` scale — a coverage COUNT is a magnitude, never a severity hue.
 *
 * UNTRUSTED-data note (#9): every value is numeric or a caller-supplied label rendered as
 * plain DOM text — never HTML.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { sequential } from './palette';

export interface MitreCell {
  /** Technique id (e.g. "T1059"). Plain text. */
  technique: string;
  /** Optional technique name (plain text). */
  name?: string;
  /** Coverage/observation count for this technique in this tactic column. */
  value: number;
}

export interface MitreTacticColumn {
  /** Tactic id/key (e.g. "TA0002"). */
  tactic: string;
  /** Tactic display label (plain text, e.g. "Execution"). */
  label: string;
  /** The technique cells under this tactic (top-N already chosen by the caller). */
  cells: MitreCell[];
}

export interface MitreHeatmapProps {
  columns: MitreTacticColumn[];
  /** Max value used to scale the colour ramp (defaults to the data max). */
  maxValue?: number;
  /**
   * @deprecated Ignored. A coverage COUNT is a quantitative magnitude, not a severity,
   * so the ramp is ALWAYS the colorblind-safe viridis `sequential()` scale — never a
   * semantic hue like `critical` (DESIGN_STANDARD §1.4). Kept only so existing callers
   * still type-check; it has no effect.
   */
  colorToken?: string;
  /** Accessible name. */
  ariaLabel?: string;
  className?: string;
}

/** Quantise a 0..1 intensity into 5 alpha steps so empty cells read distinctly. */
function intensityAlpha(v: number, max: number): number {
  if (max <= 0 || v <= 0) return 0;
  const r = Math.min(1, v / max);
  // 5 visible buckets (0.18 → 1.0) so low counts are still legible on a card.
  return 0.18 + Math.round(r * 4) * (0.82 / 4);
}

/**
 * ATT&CK tactic × technique coverage grid. Each tactic is a column; each technique
 * a tinted cell whose alpha encodes its count. Includes a legend and a visually
 * hidden `<table>` data fallback for screen readers / no-CSS. Pure DOM (no SVG
 * paths), so it's robust under jsdom and fully token-themed.
 */
export const MitreHeatmap = React.forwardRef<HTMLDivElement, MitreHeatmapProps>(
    // `colorToken` is intentionally NOT destructured: the ramp is always viridis
    // (a magnitude scale must not be read as a severity hue — DESIGN_STANDARD §1.4).
  ({ columns, maxValue, ariaLabel, className }, ref) => {
    const cols = columns ?? [];
    const dataMax =
      maxValue ?? cols.reduce((m, c) => Math.max(m, ...c.cells.map((x) => x.value || 0)), 0);
    const label =
      ariaLabel ?? `MITRE ATT&CK coverage heatmap across ${cols.length} tactic(s)`;

    if (cols.length === 0) {
      return (
        <div
          ref={ref}
          role="img"
          aria-label={`${label} (no data)`}
          className={cn('flex items-center justify-center rounded-md border border-dashed border-border py-10 text-sm text-muted-foreground', className)}
        >
          No coverage data
        </div>
      );
    }

    const maxRows = cols.reduce((m, c) => Math.max(m, c.cells.length), 0);

    return (
      <div ref={ref} className={cn('w-full', className)}>
        {/* Visible grid (decorative; the table below is the accessible source). */}
        <div role="presentation" className="overflow-x-auto">
          <div
            className="grid min-w-max gap-1"
            style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(72px, 1fr))` }}
          >
            {/* Header row */}
            {cols.map((c) => (
              <div
                key={`h-${c.tactic}`}
                className="truncate px-1 pb-1 text-center text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
                title={c.label}
              >
                {c.label}
              </div>
            ))}
            {/* Cells, row-major across the tallest column. */}
            {Array.from({ length: maxRows }).map((_, row) =>
              cols.map((c) => {
                const cell = c.cells[row];
                if (!cell) {
                  return <div key={`${c.tactic}-${row}`} className="h-9 rounded-sm bg-muted/20" aria-hidden />;
                }
                const a = intensityAlpha(cell.value, dataMax);
                return (
                  <div
                    key={`${c.tactic}-${row}`}
                    className="flex h-9 items-center justify-center rounded-sm border border-border/40 text-2xs font-medium"
                    style={{ backgroundColor: a > 0 ? sequential(a) : 'hsl(var(--muted) / 0.2)' }}
                    title={`${cell.technique}${cell.name ? ` · ${cell.name}` : ''}: ${cell.value}`}
                  >
                    {/* Contrast scrim (#5 — WCAG 1.4.3): the 10px label sits in a
                        near-opaque surface chip so `text-foreground` always meets AA
                        (≥4.5:1) regardless of how saturated the underlying ramp band
                        is. Without the chip, white/foreground text over the critical/
                        high fill measured ~3.0:1.

                        Non-color signaling (§6.1): the ramp intensity is quantitative
                        (a sequential scale, not a categorical shape vocabulary), so the
                        redundant channel here is the printed COUNT beside the technique
                        id — the magnitude the color encodes is now readable without any
                        color perception (the sr-only table below carries the full data).*/}
                    <span className="flex max-w-[calc(100%-0.25rem)] items-baseline gap-0.5 rounded-sm bg-background/85 px-1 py-0.5 text-foreground supports-[backdrop-filter]:bg-background/70 supports-[backdrop-filter]:backdrop-blur-[1px]">
                      <span className="truncate">{cell.technique}</span>
                      <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                        {cell.value.toLocaleString()}
                      </span>
                    </span>
                  </div>
                );
              }),
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="mt-3 flex items-center gap-2 text-2xs text-muted-foreground">
          <span>Low</span>
          {[0.18, 0.38, 0.59, 0.79, 1].map((a) => (
            <span key={a} className="h-3 w-5 rounded-sm border border-border/40" style={{ backgroundColor: sequential(a) }} aria-hidden />
          ))}
          <span>High</span>
          <span className="ml-auto">max {dataMax.toLocaleString()}</span>
        </div>

        {/* Accessible data-table fallback (visually hidden, screen-reader source).
            One ROW PER TACTIC; each cell is the `technique: value` pair under that
            tactic. This keeps every value bound to its OWN technique + tactic — the
            grid is jagged (each tactic has its own technique list), so a single
            positional matrix would MISATTRIBUTE a value to the wrong technique. The
            column headers index the technique SLOT within a tactic (1..N). */}
        <table className="sr-only">
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Tactic</th>
              {Array.from({ length: maxRows }).map((_, i) => (
                <th key={i} scope="col">{`Technique ${i + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => (
              <tr key={c.tactic}>
                <th scope="row">{c.label}</th>
                {Array.from({ length: maxRows }).map((_, slot) => {
                  const cell = c.cells[slot];
                  return (
                    <td key={slot}>
                      {cell
                        ? `${cell.technique}${cell.name ? ` (${cell.name})` : ''}: ${cell.value}`
                        : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
);
MitreHeatmap.displayName = 'MitreHeatmap';

export default MitreHeatmap;
