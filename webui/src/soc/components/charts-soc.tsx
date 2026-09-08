/**
 * SOC-domain chart primitives — theme-aware (palette.ts), accessible, no new deps.
 *
 * These complement the generic wrappers in `charts.tsx` with SOC-shaped views:
 *   - `MitreHeatmap`     — ATT&CK tactic × technique coverage grid (+ data-table fallback).
 *   - `BurnDownChart`    — open vs closed cases over time (stacked area + net line).
 *   - `AreaSpark`        — a gradient-filled area sparkline (thin stroke, no axes).
 *   - `MultiSeriesTrend` — several labelled series over time with a legend.
 *
 * UNTRUSTED-data note (#9): every value here is numeric or a caller-supplied label,
 * rendered as plain SVG `<text>` / recharts category strings / plain DOM text —
 * NEVER HTML. Attacker-influenced labels cannot inject markup. Colours resolve from
 * the live CSS tokens via palette.ts, so all four track the active theme with no hex.
 */
import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';
import { semanticColor, semanticIcon, sequential, token } from './palette';

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 } as const;

/* ------------------------------------------------------------------------- */
/* Beside-color legend/tooltip glyph (WCAG 1.4.1, §6.1).                       */
/* A recharts swatch is a colored dot — color is the ONLY channel. When a      */
/* series LABEL maps to a semantic key (verdict/severity/status), render the   */
/* SEMANTIC_ICON shape beside the swatch so the reading survives CVD/mono.     */
/* Decorative (`aria-hidden`) — the plain-text label carries the meaning.      */
/* ------------------------------------------------------------------------- */

function SeriesGlyph({ name, className }: { name?: string; className?: string }) {
  const Icon = semanticIcon(name);
  if (!Icon) return null;
  return <Icon className={cn('size-3 shrink-0', className)} aria-hidden />;
}

/* ------------------------------------------------------------------------- */
/* Shared tooltip (token-themed, plain-text).                                 */
/* ------------------------------------------------------------------------- */

interface SocTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string }>;
  label?: string | number;
  format?: (v: number) => string;
}

function SocTooltip({ active, payload, label, format }: SocTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const fmt = (v: number | string | undefined) =>
    typeof v === 'number' ? (format ? format(v) : v.toLocaleString()) : (v ?? '');
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-elev2">
      {label != null ? <div className="mb-1 font-medium text-foreground">{String(label)}</div> : null}
      <ul className="flex flex-col gap-1">
        {payload.map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <SeriesGlyph name={p.name} className="text-muted-foreground" />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">{fmt(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Custom recharts <Legend> content — swatch + beside-color SEMANTIC_ICON.     */
/* Replaces the default color-only legend so a colorblind reader can still     */
/* distinguish the series by shape (§6.1). Plain-text labels only (#9).        */
/* ------------------------------------------------------------------------- */

interface LegendEntry {
  value?: string;
  color?: string;
}

function SemanticLegend({ payload }: { payload?: LegendEntry[] }) {
  const items = payload ?? [];
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1 text-[11px] text-muted-foreground">
      {items.map((p, i) => (
        <li key={`${p.value}-${i}`} className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
          <SeriesGlyph name={p.value} />
          <span>{p.value}</span>
        </li>
      ))}
    </ul>
  );
}

/* ========================================================================= */
/* MitreHeatmap                                                              */
/* ========================================================================= */

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
                className="truncate px-1 pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
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
                    className="flex h-9 items-center justify-center rounded-sm border border-border/40 text-[10px] font-medium"
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
        <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
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

/* ========================================================================= */
/* BurnDownChart                                                             */
/* ========================================================================= */

export interface BurnDownPoint {
  /** X label (e.g. a date string). Plain text. */
  x: string;
  /** Open (or backlog) count at this point. */
  open: number;
  /** Closed/resolved count at this point. */
  closed: number;
}

export interface BurnDownChartProps {
  data: BurnDownPoint[];
  height?: number;
  format?: (v: number) => string;
  /** Series labels (for the legend + tooltip). */
  openLabel?: string;
  closedLabel?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Open-vs-closed burn-down: a stacked gradient area of the open backlog with a
 * solid closed line, over time. Tracks the theme (info=open, success=closed).
 */
export const BurnDownChart = React.forwardRef<HTMLDivElement, BurnDownChartProps>(
  ({ data, height = 240, format, openLabel = 'Open', closedLabel = 'Closed', ariaLabel, className }, ref) => {
    const rows = data ?? [];
    const gid = React.useId().replace(/:/g, '');
    const openColor = token('info');
    const closedColor = token('success');
    const label = ariaLabel ?? `Burn-down of open vs closed over ${rows.length} point(s)`;

    if (rows.length === 0) {
      return (
        <div
          ref={ref}
          role="img"
          aria-label={`${label} (no data)`}
          className={cn('flex items-center justify-center text-sm text-muted-foreground', className)}
          style={{ height }}
        >
          No data
        </div>
      );
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`bd-open-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={openColor} stopOpacity={0.32} />
                <stop offset="100%" stopColor={openColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tick={AXIS_TICK} minTickGap={24} />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              width={40}
              tickFormatter={(v) => (format ? format(Number(v)) : String(v))}
            />
            <Tooltip content={<SocTooltip format={format} />} cursor={{ stroke: openColor, strokeOpacity: 0.3 }} />
            <Legend content={<SemanticLegend />} />
            <Area
              type="monotone"
              dataKey="open"
              name={openLabel}
              stroke={openColor}
              strokeWidth={2}
              fill={`url(#bd-open-${gid})`}
              isAnimationActive={false}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="closed"
              name={closedLabel}
              stroke={closedColor}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
BurnDownChart.displayName = 'BurnDownChart';

/* ========================================================================= */
/* AreaSpark — gradient-area sparkline (thin stroke, no axes/tooltip).        */
/* ========================================================================= */

export interface AreaSparkProps {
  /** Bare numeric series. */
  data: number[];
  height?: number;
  /** Colour token name (default 'primary'). */
  colorToken?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * A compact gradient-filled area spark — like `Sparkline` but with a stronger
 * gradient floor and a thinner stroke, for inline KPI context. No axes/tooltip.
 */
export const AreaSpark = React.forwardRef<HTMLDivElement, AreaSparkProps>(
  ({ data, height = 44, colorToken = 'primary', ariaLabel, className }, ref) => {
    const rows = (data ?? []).map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }));
    const color = token(colorToken);
    const gid = React.useId().replace(/:/g, '');
    const label = ariaLabel ?? `Area sparkline of ${rows.length} value(s)`;

    if (rows.length === 0) {
      return <div ref={ref} role="img" aria-label={`${label} (no data)`} className={className} style={{ height }} />;
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`aspark-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#aspark-${gid})`}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
AreaSpark.displayName = 'AreaSpark';

/* ========================================================================= */
/* MultiSeriesTrend — several labelled series over time with a legend.        */
/* ========================================================================= */

export interface MultiSeries {
  /** Series key — must match the data-row property holding this series' value. */
  key: string;
  /** Plain-text legend label. */
  label: string;
  /** Optional explicit colour string; else a semantic/categorical colour. */
  color?: string;
}

export interface MultiSeriesTrendProps {
  /**
   * Rows of `{ x, [seriesKey]: number|null, ... }`. A `null` for a series in a row is
   * rendered as a GAP in that line (no fabricated 0) — e.g. a day with no timing sample.
   */
  data: Array<Record<string, string | number | null>>;
  series: MultiSeries[];
  /** Property name for the X axis category (default 'x'). */
  xKey?: string;
  height?: number;
  /**
   * FILL the nearest positioned ancestor instead of taking a fixed pixel height.
   *
   * `height` renders as an inline `style`, and `<ResponsiveContainer height="100%">`
   * inside it can only ever be 100% of that constant — so a chart in a stretched flex
   * cell leaves every spare pixel as dead space below itself. With `fill`, the chart is
   * `absolute inset-0` and sizes to the box it is given, which is what lets a caller hand
   * it `flex-1`.
   *
   * The caller then owns two things: a `relative` wrapper (there must be a positioned
   * ancestor) and a `min-h-*` floor (a flex item with no free space would otherwise
   * collapse to zero — which happens on every load tick where the cell is the row's only
   * child, and at widths where the row stacks).
   *
   * Default `false`, so every existing call site renders byte-identically.
   */
  fill?: boolean;
  format?: (v: number) => string;
  showXAxis?: boolean;
  showYAxis?: boolean;
  /** Show the labelled series legend (default true). */
  showLegend?: boolean;
  /** Optional explicit Y-axis domain, useful when stacked lanes must share a stable scale. */
  yDomain?: [number | 'auto', number | 'auto'];
  /**
   * Optional horizontal average/target reference line (e.g. the mean of a plotted
   * series). Rendered as a dashed muted rule when a finite number is supplied; absent
   * → no line. Advisory / decorative — the plotted series carry the meaning.
   */
  referenceY?: number;
  /** Plain-text label for the reference line (shown top-right on the rule). */
  referenceLabel?: string;
  /** Optional X-axis category to mark (for example the start of the current cohort). */
  referenceX?: string;
  /** Plain-text label for the vertical reference rule. */
  referenceXLabel?: string;
  ariaLabel?: string;
  className?: string;
}

/** Resolve a series colour: explicit → semantic(by label), else categorical(by index).
 *  `semanticColor` already falls back to `categorical(i)` on an unknown label, so no
 *  extra `|| categorical(i)` is needed (it could never fire). */
function seriesColor(s: MultiSeries, i: number): string {
  return s.color ?? semanticColor(s.label, i);
}

/**
 * Multi-series line trend with a legend. Each series is a token-coloured line; the
 * legend + tooltip carry plain-text labels. Suitable for verdict mix / per-source
 * volume / cost-by-model over time.
 */
export const MultiSeriesTrend = React.forwardRef<HTMLDivElement, MultiSeriesTrendProps>(
  (
    {
      data,
      series,
      xKey = 'x',
      height = 240,
      fill = false,
      format,
      showXAxis = true,
      showYAxis = true,
      showLegend = true,
      yDomain,
      referenceY,
      referenceLabel,
      referenceX,
      referenceXLabel,
      ariaLabel,
      className,
    },
    ref,
  ) => {
    const rows = data ?? [];
    const list = series ?? [];
    const label = ariaLabel ?? `Trend of ${list.length} series over ${rows.length} point(s)`;

    if (rows.length === 0 || list.length === 0) {
      return (
        <div
          ref={ref}
          role="img"
          aria-label={`${label} (no data)`}
          className={cn(
            'flex items-center justify-center text-sm text-muted-foreground',
            fill && 'absolute inset-0',
            className,
          )}
          style={fill ? undefined : { height }}
        >
          No data
        </div>
      );
    }

    return (
      <div
        ref={ref}
        role="img"
        aria-label={label}
        className={cn(fill && 'absolute inset-0', className)}
        style={fill ? undefined : { height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            {showXAxis ? (
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={AXIS_TICK} minTickGap={24} />
            ) : (
              <XAxis dataKey={xKey} hide />
            )}
            {showYAxis ? (
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
                width={40}
                domain={yDomain}
                tickFormatter={(v) => (format ? format(Number(v)) : String(v))}
              />
            ) : (
              <YAxis hide />
            )}
            <Tooltip content={<SocTooltip format={format} />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeOpacity: 0.25 }} />
            {showLegend ? <Legend content={<SemanticLegend />} /> : null}
            {referenceX ? (
              <ReferenceLine
                x={referenceX}
                stroke="hsl(var(--primary))"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
                label={
                  referenceXLabel
                    ? {
                        value: referenceXLabel,
                        position: 'insideTopRight',
                        fill: 'hsl(var(--primary))',
                        fontSize: 10,
                      }
                    : undefined
                }
              />
            ) : null}
            {typeof referenceY === 'number' && Number.isFinite(referenceY) ? (
              <ReferenceLine
                y={referenceY}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
                ifOverflow="extendDomain"
                label={
                  referenceLabel
                    ? {
                        value: referenceLabel,
                        position: 'insideTopRight',
                        fill: 'hsl(var(--muted-foreground))',
                        fontSize: 10,
                      }
                    : undefined
                }
              />
            ) : null}
            {list.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={seriesColor(s, i)}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
MultiSeriesTrend.displayName = 'MultiSeriesTrend';
