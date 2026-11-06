/**
 * MitreHeatmap: the ATT&CK tactic × technique coverage grid (+ data-table fallback).
 *
 * Extracted from `charts-soc.tsx` (chat revamp SPEC §10.10) so a consumer can draw the
 * grid WITHOUT importing recharts: `charts-soc.tsx` pulls the whole recharts vendor
 * chunk, and the lazy chat answer-blocks chunk must never depend on it. `charts-soc.tsx`
 * re-exports everything here, so existing imports keep working unchanged.
 *
 * Pure DOM (no SVG paths, no recharts). The ramp is ALWAYS the colorblind-safe viridis
 * `sequential()` scale: a coverage COUNT is a magnitude, never a severity hue.
 *
 * UNTRUSTED-data note (#9): every value is numeric or a caller-supplied label rendered as
 * plain DOM text, never HTML.
 *
 * Layout (Round 14, SPEC §4.4.4 "fits all tactics"): the tactic columns share the width
 * equally and shrink, before the grid scrolls, to what their own content needs and never
 * below 4.5rem ({@link MITRE_COLUMN_TRACK}): the longest word of the tactic name (a name
 * wraps at its spaces, never mid-word) and the widest technique id, whose count wraps
 * under it rather than cutting it. So seven tactics fit an 8-of-12 board panel at 1440 px
 * (each column then wider than 96 px) and chat's 42rem reading column, and nothing is
 * ever cut. Where
 * more tactics than fit still scroll sideways, the scroller is a named, focusable region
 * (WCAG 2.1.1), so a keyboard user can reach the hidden columns. The visible grid is
 * hidden from assistive technology in both states: the screen-reader table below is the
 * one accessible reading, one row per tactic.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { sequential } from './palette';

/**
 * One tactic column's track: an equal share of the width, and never narrower than its own
 * content (its tactic name's longest word, its widest technique id) or the 4.5rem its
 * header holds open (so a short id and its count stay on one line), so the grid scrolls
 * sideways only when the content itself cannot fit.
 */
export const MITRE_COLUMN_TRACK = 'minmax(min-content, 1fr)';

/**
 * Whether `el` is wider inside than it shows (its content scrolls sideways), re-measured
 * when it or its content resizes and whenever `deps` change.
 */
function useOverflowsX(el: HTMLElement | null, deps: readonly unknown[]): boolean {
  const [overflows, setOverflows] = React.useState(false);
  const measure = React.useCallback(() => {
    setOverflows(el ? el.scrollWidth - el.clientWidth > 1 : false);
  }, [el]);
  React.useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's re-measure list
  }, [measure, ...deps]);
  React.useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [el, measure]);
  return overflows;
}

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
   * so the ramp is ALWAYS the colorblind-safe viridis `sequential()` scale, never a
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
    // (a magnitude scale must not be read as a severity hue, DESIGN_STANDARD §1.4).
  ({ columns, maxValue, ariaLabel, className }, ref) => {
    const cols = columns ?? [];
    const dataMax =
      maxValue ?? cols.reduce((m, c) => Math.max(m, ...c.cells.map((x) => x.value || 0)), 0);
    const label =
      ariaLabel ?? `MITRE ATT&CK coverage heatmap across ${cols.length} tactic(s)`;
    const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);
    const overflows = useOverflowsX(scroller, [cols.length]);

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
      // `relative`: the screen-reader table below is absolutely positioned (`sr-only`);
      // without a positioned ancestor of its own it is placed against the page and, being
      // as wide as its content, widens the whole document on a narrow screen.
      <div ref={ref} className={cn('relative w-full', className)}>
        {/* Visible grid (the table below is the accessible source). The columns shrink to
            their content before anything scrolls; when the tactics still do not fit, the
            scroller becomes a named region in the Tab order, so the hidden columns can be
            reached from the keyboard (arrow keys scroll a focused region). */}
        <div
          ref={setScroller}
          role={overflows ? 'region' : 'presentation'}
          aria-label={overflows ? `${label}, scrolls sideways` : undefined}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a named scroller is the documented exception (WCAG 2.1.1)
          tabIndex={overflows ? 0 : undefined}
          className={cn('overflow-x-auto', overflows && cn('rounded-sm', focusRing))}
          data-mitre-scroll={overflows ? 'overflow' : 'fit'}
        >
          {/* Hidden from assistive technology: read cell by cell it would be one flat run
              of headers and counts that ties no count to its tactic, and the table below
              reads the same data in tactic rows. It holds nothing focusable. */}
          <div
            className="grid w-full min-w-0 gap-1"
            style={{ gridTemplateColumns: `repeat(${cols.length}, ${MITRE_COLUMN_TRACK})` }}
            aria-hidden
            data-mitre-grid=""
          >
            {/* Header row: a long tactic name wraps onto a second line rather than being cut. */}
            {cols.map((c) => (
              <div
                key={`h-${c.tactic}`}
                className="flex min-w-[4.5rem] items-end justify-center break-words px-1 pb-1 text-center text-2xs font-medium leading-tight text-muted-foreground"
                title={c.label}
                data-mitre-header=""
              >
                {c.label}
              </div>
            ))}
            {/* Cells, row-major across the tallest column. */}
            {Array.from({ length: maxRows }).map((_, row) =>
              cols.map((c) => {
                const cell = c.cells[row];
                if (!cell) {
                  return <div key={`${c.tactic}-${row}`} className="min-h-9 rounded-sm bg-muted/20" />;
                }
                const a = intensityAlpha(cell.value, dataMax);
                return (
                  <div
                    key={`${c.tactic}-${row}`}
                    className="flex min-h-9 items-center justify-center rounded-sm border border-border/40 px-0.5 text-2xs font-medium"
                    style={{ backgroundColor: a > 0 ? sequential(a) : 'hsl(var(--muted) / 0.2)' }}
                    title={`${cell.technique}${cell.name ? ` · ${cell.name}` : ''}: ${cell.value}`}
                  >
                    {/* Contrast scrim (#5, WCAG 1.4.3): the 11px label sits in a
                        near-opaque surface chip so `text-foreground` always meets AA
                        (≥4.5:1) regardless of how saturated the underlying ramp band
                        is. Without the chip, white/foreground text over the critical/
                        high fill measured ~3.0:1.

                        Non-color signaling (§6.1): the ramp intensity is quantitative
                        (a sequential scale, not a categorical shape vocabulary), so the
                        redundant channel here is the printed COUNT beside the technique
                        id: the magnitude the color encodes is now readable without any
                        color perception (the sr-only table below carries the full data).

                        Neither is ever cut: where the id and its count do not fit one line
                        (a sub-technique id beside a four-digit count), the count wraps under
                        the id, and the cell grows to hold both. */}
                    <span
                      className="flex max-w-full flex-wrap items-baseline justify-center gap-x-0.5 rounded-sm bg-background/85 px-1 py-0.5 text-foreground supports-[backdrop-filter]:bg-background/70 supports-[backdrop-filter]:backdrop-blur-[1px]"
                      data-mitre-chip=""
                    >
                      <span data-mitre-technique="">{cell.technique}</span>
                      <span className="tabular-nums text-muted-foreground">
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
            tactic. This keeps every value bound to its OWN technique + tactic: the
            grid is jagged (each tactic has its own technique list), so a single
            positional matrix would MISATTRIBUTE a value to the wrong technique. The
            column headers index the technique SLOT within a tactic (1..N). The table sits
            in a visually hidden box: a table is never narrower than its content, so
            `sr-only` on the table alone could not clip it, while the box (1px, overflow
            hidden) does. The table keeps `sr-only` as well: it is the marker the report
            print stylesheets key on (`table.sr-only`) to leave a screen-reader table out
            of the printed layout instead of stretching it to the column. */}
        <div className="sr-only" data-mitre-table="">
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
      </div>
    );
  },
);
MitreHeatmap.displayName = 'MitreHeatmap';

export default MitreHeatmap;
