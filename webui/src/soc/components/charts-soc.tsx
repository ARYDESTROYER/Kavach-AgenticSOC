/**
 * SOC-domain chart primitives — theme-aware (palette.ts), accessible, no new deps.
 *
 * These complement the generic wrappers in `charts.tsx` with SOC-shaped views:
 *   - `MitreHeatmap`     — re-exported from `./MitreHeatmap` (ATT&CK coverage grid, no recharts).
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
import { semanticColor, semanticIcon, token } from './palette';

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
/* MitreHeatmap — moved to ./MitreHeatmap (no recharts); re-exported here.    */
/* ========================================================================= */

export { MitreHeatmap } from './MitreHeatmap';
export type { MitreCell, MitreTacticColumn, MitreHeatmapProps } from './MitreHeatmap';

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
