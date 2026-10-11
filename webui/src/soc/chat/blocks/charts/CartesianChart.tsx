/**
 * Columns, grouped columns, stacked columns, lines and areas over one x axis (BLOCKS.md
 * chart table).
 *
 * - `bar`: ⅔-slot columns capped at 22 px, square at the baseline with a 2 px top radius;
 *   grouped when ≥ 2 series. The whole x slot is the hit target.
 * - `grouped_bar` (Round 12, P0-6): the same grouped columns, one series per compared
 *   period side by side per category; the tooltip, the keyboard announcement and the
 *   sr-only table add the change from the previous period to the latest ("new" for a
 *   zero baseline, never ∞).
 * - `stacked_bar`: the CloseAttributionChart stack — 1 px inset gap, 2 px minimum
 *   segment, top-segment radius — and a HATCHED slot when any visible part is `null`
 *   (a partial stack would read as a smaller total). Each segment carries its share of
 *   the slot via `reconcilingShares()` (withheld when a part is missing). The drawn stack
 *   and its tooltip total cover the SHOWN series and say so once one is hidden; the
 *   sr-only table lists every series, so its Total always covers every series.
 * - `line` / `area`: 2 px round-joined lines that BREAK at `null` (never interpolated),
 *   a flat ~12 % area wash, an end dot with a surface ring, selective end labels for
 *   2–4 series, and a crosshair snapping to the nearest x.
 *
 * One unit, one y axis (G6). Ticks are clean steps from zero. The newest bucket is drawn
 * lighter (0.6, the house value that still clears 3:1) or dashed while `last_in_progress`,
 * and says "(in progress)" under its slot.
 *
 * Calendar axes (Round 12, P0-5): ticks, tooltips and the data table read the server's
 * period labels ("Mar 2026", "W14 2026") and name the axis's time zone; a plain time axis
 * keeps its UTC labels. Brush zoom (P0-8, line/area): drag across the plot, click a point
 * then Shift+click another, or Shift+←/→ then Enter, to zoom; "Reset zoom" restores the
 * whole series. Zoom is a client-side view of the same numbers (never a re-query). The
 * zoom row always exists on a zoomable chart (a hint until a zoom, then the zoomed range
 * and Reset), so the plot never moves under the pointer that just made the selection; a
 * zoom belongs to the data it was made on and is dropped when the view changes (Group
 * by, Show as); the keyboard cursor stays on the same period through a zoom and a reset.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { navLabel } from '@/soc/nav';
import { token } from '@/soc/components/palette';
import { useAnnouncer } from '@/soc/components/announcer';

import { useBlocks } from '../context';
import {
  IN_PROGRESS_SUFFIX,
  axisZone,
  changeParts,
  clipText,
  formatTick,
  formatValue,
  hasCalendarLabels,
  instantOf,
  unitLabel,
  xAxisHeader,
  xPositionLabel,
  xRangeLabel,
  xTickLabel,
} from '../format';
import type { ChartBlock } from '../schema';
import { usePublishChartView } from './export-context';
import { HatchPattern, MARK_FORCED, ChartShell, useSvgId } from './ChartShell';
import type { AnchorRect } from './ChartTooltipPortal';
import { TooltipBody, type TooltipRow } from './ChartTooltipPortal';
import { srValue } from './DataTableFallback';
import {
  BAR_MAX,
  CHAR_W,
  areaPath,
  barWidth,
  extent,
  lastMeasured,
  lineRuns,
  niceScale,
  pickXLabels,
  placeXLabels,
  reconcilingShares,
  roundedTopPath,
  stackSegments,
  stackTotals,
} from './geometry';
import { Legend, useSeriesVisibility } from './Legend';
import { categoryStyles, seriesStyles } from './series';
import { useChartNavigator, type ChartCursor } from './useChartNavigator';
import { useChartSize } from './useChartSize';

const PAD_TOP = 10;
const X_AXIS_H = 20;
const Y_GAP = 8;
const IN_PROGRESS_OPACITY = 0.6;
const GROUP_GAP = 2;
const END_LABEL_CHARS = 14;
/** Extra room for tick glyphs wider than a digit (see `x0`). */
const TICK_SLACK = 4;
/** Extra x-axis room for the "(in progress)" line under the newest slot. */
const IN_PROGRESS_LINE_H = 12;
/** A line/area chart with fewer points has nothing to zoom into. */
export const MIN_ZOOM_POINTS = 4;

export type CartesianKind = 'bar' | 'stacked_bar' | 'line' | 'area' | 'grouped_bar';

export interface CartesianChartProps {
  block: ChartBlock & { kind: CartesianKind };
  title: string;
  height: number;
  staticMode?: boolean;
}

const KIND_WORD: Record<CartesianKind, string> = {
  bar: 'Column chart',
  grouped_bar: 'Grouped column chart',
  stacked_bar: 'Stacked column chart',
  line: 'Line chart',
  area: 'Area chart',
};

/** Identifies a chart's DATA (not the object), so a re-render keeps its zoom and a new series drops it. */
function dataKey(block: ChartBlock): string {
  const n = block.x.values.length;
  return [block.id, block.kind, block.x.bucket ?? '', n, block.x.values[0] ?? '', block.x.values[n - 1] ?? ''].join('|');
}

/** The block cut to x positions `[from, to]` (inclusive): the zoomed view of the same numbers. */
export function sliceChart(block: ChartBlock, [from, to]: [number, number]): ChartBlock {
  const n = block.x.values.length;
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(n - 1, Math.max(from, to));
  if (a === 0 && b === n - 1) return block;
  const cut = <T,>(list: readonly T[]) => list.slice(a, b + 1);
  const out: ChartBlock = {
    ...block,
    x: { ...block.x, values: cut(block.x.values), ...(block.x.labels ? { labels: cut(block.x.labels) } : {}) },
    series: block.series.map((s) => ({ ...s, values: cut(s.values) })),
    // Only the newest bucket is in progress; a zoom that ends earlier ends on whole buckets.
    last_in_progress: block.last_in_progress && b === n - 1,
  };
  if (block.drill) out.drill = cut(block.drill);
  if (block.reference?.axis === 'x' && !out.x.values.includes(block.reference.value)) delete out.reference;
  return out;
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function CartesianChart({ block: full, title, height, staticMode = false }: CartesianChartProps) {
  const { navigate } = useBlocks();
  const announce = useAnnouncer();
  const zoomable = !staticMode && (full.kind === 'line' || full.kind === 'area') && full.x.values.length >= MIN_ZOOM_POINTS;
  const key = dataKey(full);
  const [zoom, setZoom] = React.useState<{ key: string; range: [number, number] } | null>(null);
  // A zoom belongs to the data it was made on: a new grouping or kind drops it for good,
  // so going back (Quarter → Month, bar → line) never silently restores an old zoom.
  if (zoom && zoom.key !== key) setZoom(null);
  const range = zoomable && zoom && zoom.key === key ? zoom.range : null;
  const block = React.useMemo(() => (range ? (sliceChart(full, range) as typeof full) : full), [full, range]);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const width = useChartSize(boxRef, { staticMode });
  const hatchId = useSvgId('hatch');
  const kind = block.kind;
  const isLine = kind === 'line' || kind === 'area';
  const stacked = kind === 'stacked_bar';
  const styles = React.useMemo(() => seriesStyles(block), [block]);
  const catStyles = React.useMemo(() => (kind === 'bar' ? categoryStyles(block, false) : null), [block, kind]);
  const [hidden, toggle] = useSeriesVisibility(block.series.length);
  // The card's image download draws what is shown: this zoom, these series — and says so.
  const zoomView = range
    ? {
        first: xPositionLabel(block.x, 0),
        last: xPositionLabel(block.x, block.x.values.length - 1),
        shown: block.x.values.length,
        total: full.x.values.length,
      }
    : null;
  usePublishChartView(block, hidden, zoomView);
  const visibleIdx = block.series.map((_, k) => k).filter((k) => !hidden[k]);
  const visibleSeries = visibleIdx.map((k) => block.series[k].values);
  const n = block.x.values.length;
  const unit = block.unit;

  /* ---- scale ---- */
  // Visible totals size the stack; ALL-series totals feed the sr-only table, whose row
  // lists every series (a Total over fewer series than its row shows would not add up).
  const totals = stacked ? stackTotals(visibleSeries, n) : null;
  const allTotals = stacked ? stackTotals(block.series.map((s) => s.values), n) : null;
  const anyHidden = visibleIdx.length < block.series.length;
  const totalWord = anyHidden ? 'total of shown series' : 'total';
  const [lo, hi] = stacked ? extent([totals ?? []]) : extent(visibleSeries);
  const refY = block.reference?.axis === 'y' ? block.reference.value : null;
  const integer =
    (unit === 'count' || unit === 'tokens' || unit === 'bytes') &&
    visibleSeries.every((vs) => vs.every((v) => v === null || Number.isInteger(v)));
  const scale = niceScale(Math.min(lo, refY ?? lo), Math.max(hi, refY ?? hi), 4, integer);
  const tickTexts = scale.ticks.map((t) => formatTick(t, unit));
  // CHAR_W is a digit's advance; "%", "$", "k" and "h" run wider, so the tick column
  // keeps a few pixels of slack: a card without side padding (a Brief leaf) clips any
  // tick that starts left of the plot.
  const x0 = Math.ceil(Math.max(...tickTexts.map((t) => t.length)) * CHAR_W) + Y_GAP + TICK_SLACK;
  const endLabels = isLine && visibleIdx.length >= 2 && visibleIdx.length <= 4;
  const padRight = endLabels
    ? Math.ceil(Math.min(END_LABEL_CHARS, Math.max(...visibleIdx.map((k) => block.series[k].label.length))) * CHAR_W) + 14
    : 8;
  const plotTop = PAD_TOP;
  const baseline = Math.max(plotTop + 24, height - X_AXIS_H - (block.last_in_progress ? IN_PROGRESS_LINE_H : 0));
  const plotW = Math.max(1, width - x0 - padRight);
  const slot = plotW / Math.max(1, n);
  const yOf = (v: number) => baseline - ((v - scale.min) / (scale.max - scale.min)) * (baseline - plotTop);
  const zeroY = yOf(0);
  const xOf = (i: number) => x0 + (i + 0.5) * slot;
  const lastIdx = n - 1;
  const opacityAt = (i: number) => (block.last_in_progress && i === lastIdx ? IN_PROGRESS_OPACITY : 1);

  /* ---- x labels ---- */
  const isTime = block.x.kind === 'time';
  const calendar = hasCalendarLabels(block.x);
  const zoneNote = calendar && axisZone(block.x) !== 'UTC' ? `Times in ${axisZone(block.x)}` : null;
  const shortX = block.x.values.map((_, i) => xTickLabel(block.x, i));
  // Calendar periods (months, local days) are not regular UTC steps: they step evenly.
  const instants = isTime && !calendar ? block.x.values.map((v) => instantOf(v)) : undefined;
  const xLabels = placeXLabels(pickXLabels(shortX, plotW, instants), shortX, xOf, width);

  /* ---- interaction ---- */
  const secondary = visibleIdx.length > 1 ? visibleIdx.length : 0;
  const fullX = (i: number) => xPositionLabel(block.x, i);
  const offset = range ? range[0] : 0;
  const valueAt = (k: number, i: number) => block.series[k].values[i] ?? null;
  /** A comparison's change at slot i: the latest period against the one before it (P0-6). */
  const compared = kind === 'grouped_bar' && block.series.length >= 2;
  const changeAt = (i: number) => {
    const base = block.series[block.series.length - 2];
    const c = changeParts(block.series[block.series.length - 1].values[i], base.values[i], unit);
    return { base: base.label, ...c };
  };
  const summarize = React.useCallback(
    (c: ChartCursor) => {
      const head = `${fullX(c.i)}${block.last_in_progress && c.i === lastIdx ? ', in progress' : ''}`;
      const ks = c.j >= 0 ? [visibleIdx[c.j]] : visibleIdx;
      const parts = ks.map((k) => `${block.series[k].label} ${srValue(formatValue(valueAt(k, c.i), unit), valueAt(k, c.i))}`);
      if (stacked && c.j < 0 && totals) parts.unshift(`${totalWord} ${srValue(formatValue(totals[c.i], unit), totals[c.i])}`);
      // The whole slot of a comparison reads its change too: the tooltip's note is
      // aria-hidden, so this is where assistive tech hears it.
      const change = compared && c.j < 0 ? changeAt(c.i) : null;
      const tail = change && change.delta !== null ? `; change vs ${change.base} ${change.abs} (${change.pct})` : '';
      return `${head}: ${parts.join(', ')}${tail}.`;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [block, visibleIdx.join(','), stacked, totals?.join(','), unit, totalWord, compared],
  );
  /** The navigator, once it exists (the zoom handlers below run after it is created). */
  const navRef = React.useRef<ReturnType<typeof useChartNavigator> | null>(null);
  /**
   * The point a plain click picked (Shift+click another to zoom between them), with the
   * view it was picked on: its index numbers THAT view's slots, so a zoom, a reset or a
   * new grouping in between makes it meaningless and a lone Shift+click must not use it.
   */
  const clickAnchor = React.useRef<{ view: string; i: number } | null>(null);
  const viewId = range ? `${key}@${range[0]}-${range[1]}` : key;
  const applyZoom = (sel: [number, number]) => {
    const a = Math.min(sel[0], sel[1]);
    const b = Math.max(sel[0], sel[1]);
    if (!zoomable || b - a < 1 || (a === 0 && b === n - 1)) return;
    clickAnchor.current = null;
    setZoom({ key, range: [offset + a, offset + b] });
    // Keep the cursor on the same period, now numbered from the zoom's first point (a
    // cursor outside the range moves to its nearest edge), and read it after the zoom.
    const nav = navRef.current;
    const cur = nav?.cursor ?? null;
    let point = '';
    if (nav && cur) {
      const i = Math.max(a, Math.min(b, cur.i));
      nav.moveTo({ i: i - a, j: cur.j });
      if (nav.focusRing) point = ` ${summarize({ i, j: cur.j })}`;
    }
    announce(`Zoomed to ${fullX(a)} – ${fullX(b)}, ${b - a + 1} of ${full.x.values.length} points.${point}`);
  };
  const drillAt = (i: number) => block.drill?.[i] ?? null;
  const nav = useChartNavigator({
    count: n,
    secondary,
    orientation: 'horizontal',
    summarize,
    onActivate: (c) => {
      const ref = drillAt(c.i);
      if (ref) navigate(ref);
    },
    disabled: staticMode,
    onRange: zoomable ? applyZoom : undefined,
    summarizeRange: ([a, b]) => `Selected ${fullX(a)} to ${fullX(b)}, ${b - a + 1} points. Press Enter to zoom, Escape to clear.`,
  });
  navRef.current = nav;
  const active = nav.cursor;

  /* ---- brush zoom (pointer) ---- */
  const [drag, setDrag] = React.useState<{ from: number; to: number } | null>(null);
  /** A click right after a brush release is the release itself, not a click. */
  const brushed = React.useRef(false);
  const nearestSlot = (x: number) => Math.max(0, Math.min(n - 1, Math.floor((x - x0) / slot)));
  const brush = zoomable
    ? {
        start: (x: number) => {
          brushed.current = false;
          setDrag({ from: nearestSlot(x), to: nearestSlot(x) });
        },
        move: (x: number) => setDrag((d) => (d ? { ...d, to: nearestSlot(x) } : d)),
        end: (x: number) => {
          const d = drag;
          setDrag(null);
          if (!d) return;
          const to = nearestSlot(x);
          if (to !== d.from) {
            brushed.current = true;
            applyZoom([d.from, to]);
          }
        },
        cancel: () => setDrag(null),
      }
    : undefined;
  const onPlotClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (brushed.current) {
      brushed.current = false;
      return;
    }
    if (!active) return;
    // An anchor picked on another view (before a zoom, a reset or a regroup) is stale.
    const anchor = clickAnchor.current && clickAnchor.current.view === viewId ? clickAnchor.current.i : null;
    if (zoomable && e.shiftKey && anchor !== null && anchor !== active.i) {
      applyZoom([anchor, active.i]);
      clickAnchor.current = null;
      return;
    }
    clickAnchor.current = { view: viewId, i: active.i };
    const ref = drillAt(active.i);
    if (ref) navigate(ref);
  };
  const selection: [number, number] | null = drag ? [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] : nav.range;

  const slotAt = (x: number): number | null => {
    if (x < x0 || x > x0 + plotW) return null;
    const i = Math.floor((x - x0) / slot);
    return i >= 0 && i < n ? i : null;
  };
  const onPointerAt = (x: number) => {
    const i = slotAt(x);
    nav.hover(i === null ? null : { i, j: -1 });
  };
  const anchorFor = React.useCallback(
    (plot: DOMRect): AnchorRect | null => {
      if (!active) return null;
      const left = plot.left + x0 + active.i * slot;
      return { left, right: left + slot, top: plot.top + plotTop, bottom: plot.top + baseline };
    },
    [active, x0, slot, plotTop, baseline],
  );

  /* ---- marks ---- */
  const groupCount = Math.max(1, visibleIdx.length);
  const groupW = stacked || groupCount === 1 ? barWidth(slot) : Math.min((slot * 2) / 3, groupCount * BAR_MAX + (groupCount - 1) * GROUP_GAP);
  const memberW = stacked || groupCount === 1 ? groupW : Math.max(1, (groupW - (groupCount - 1) * GROUP_GAP) / groupCount);

  const bars: React.ReactNode[] = [];
  if (!isLine) {
    for (let i = 0; i < n; i += 1) {
      const left = xOf(i) - groupW / 2;
      if (stacked) {
        const segs = stackSegments(
          block.series.map((s) => s.values[i] ?? null),
          zeroY,
          (baseline - plotTop) / (scale.max - scale.min),
          block.series.map((_, k) => !hidden[k]),
        );
        if (segs === null) {
          bars.push(
            <rect
              key={`h${i}`}
              x={Math.round(x0 + i * slot) + 1}
              y={plotTop}
              width={Math.max(1, Math.round(slot) - 2)}
              height={zeroY - plotTop}
              fill={`url(#${hatchId})`}
              data-state="unmeasured"
              data-index={i}
            />,
          );
          continue;
        }
        segs.forEach((seg) => {
          const color = styles[seg.series].color;
          const common = { fill: color, opacity: opacityAt(i), 'data-series': seg.series, 'data-index': i, className: MARK_FORCED };
          bars.push(
            seg.top ? (
              <path key={`s${i}-${seg.series}`} d={roundedTopPath(Math.round(left), seg.y, Math.round(groupW), seg.h)} {...common} />
            ) : (
              <rect key={`s${i}-${seg.series}`} x={Math.round(left)} y={seg.y} width={Math.round(groupW)} height={seg.h} {...common} />
            ),
          );
        });
        continue;
      }
      visibleIdx.forEach((k, m) => {
        const v = valueAt(k, i);
        const x = left + m * (memberW + GROUP_GAP);
        if (!isNum(v)) {
          bars.push(
            <rect
              key={`h${i}-${k}`}
              x={x}
              y={plotTop}
              width={Math.max(1, memberW)}
              height={zeroY - plotTop}
              fill={`url(#${hatchId})`}
              data-state="unmeasured"
              data-index={i}
            />,
          );
          return;
        }
        if (v === 0) return;
        const color = catStyles ? catStyles[i].color : styles[k].color;
        const yTop = v > 0 ? Math.min(yOf(v), zeroY - 2) : zeroY;
        const h = v > 0 ? zeroY - yTop : Math.max(2, yOf(v) - zeroY);
        bars.push(
          v > 0 ? (
            <path
              key={`b${i}-${k}`}
              d={roundedTopPath(x, yTop, memberW, h)}
              fill={color}
              opacity={opacityAt(i)}
              data-series={k}
              data-index={i}
              className={MARK_FORCED}
            />
          ) : (
            <rect key={`b${i}-${k}`} x={x} y={yTop} width={memberW} height={h} fill={color} opacity={opacityAt(i)} data-series={k} data-index={i} className={MARK_FORCED} />
          ),
        );
      });
    }
  }

  const lines: React.ReactNode[] = [];
  const labels: Array<{ k: number; y: number; text: string }> = [];
  if (isLine) {
    visibleIdx.forEach((k) => {
      const values = block.series[k].values;
      const solid = block.last_in_progress && n > 1 ? values.slice(0, n - 1) : values;
      const runs = lineRuns(solid, xOf, yOf);
      const color = styles[k].color;
      runs.forEach((run, r) => {
        if (kind === 'area' && run.indices.length > 1) {
          lines.push(<path key={`a${k}-${r}`} d={areaPath(run, values, xOf, yOf, zeroY)} fill={color} opacity={0.12} />);
        }
        if (run.indices.length > 1) {
          lines.push(
            <path key={`l${k}-${r}`} d={run.path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" data-series={k} />,
          );
        } else {
          const i = run.indices[0];
          lines.push(<circle key={`p${k}-${r}`} cx={xOf(i)} cy={yOf(values[i] as number)} r={2.5} fill={color} data-series={k} className={MARK_FORCED} />);
        }
      });
      if (block.last_in_progress && n > 1 && isNum(values[n - 1]) && isNum(values[n - 2])) {
        lines.push(
          <path
            key={`ip${k}`}
            d={`M${xOf(n - 2)},${yOf(values[n - 2] as number)}L${xOf(n - 1)},${yOf(values[n - 1] as number)}`}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="3 3"
            data-in-progress="true"
          />,
        );
      }
      const end = lastMeasured(values);
      if (end >= 0) {
        lines.push(
          <circle
            key={`e${k}`}
            cx={xOf(end)}
            cy={yOf(values[end] as number)}
            r={4}
            fill={color}
            stroke={token('background')}
            strokeWidth={2}
            data-end-dot={k}
            className={MARK_FORCED}
          />,
        );
        if (endLabels) labels.push({ k, y: yOf(values[end] as number), text: clipText(block.series[k].label, END_LABEL_CHARS) });
      }
    });
    // De-collide end labels vertically (12 px apart), keeping their order.
    labels.sort((a, b) => a.y - b.y);
    for (let q = 1; q < labels.length; q += 1) {
      if (labels[q].y - labels[q - 1].y < 12) labels[q].y = labels[q - 1].y + 12;
    }
  }

  /* ---- reference ---- */
  let reference: React.ReactNode = null;
  if (block.reference?.axis === 'y') {
    const y = Math.round(yOf(block.reference.value));
    reference = (
      <g data-testid="chart-reference">
        <rect x={x0} y={y} width={plotW} height={1} fill={token('muted-foreground', 0.7)} />
        <text x={x0 + plotW} y={y - 4} textAnchor="end" className="text-2xs" style={{ fill: token('muted-foreground') }}>
          {block.reference.label}
        </text>
      </g>
    );
  } else if (block.reference?.axis === 'x') {
    const idx = block.x.values.indexOf(block.reference.value);
    if (idx >= 0) {
      const x = Math.round(xOf(idx));
      reference = (
        <g data-testid="chart-reference">
          <rect x={x} y={plotTop} width={1} height={zeroY - plotTop} fill={token('muted-foreground', 0.7)} />
          <text x={x + 4} y={plotTop + 8} className="text-2xs" style={{ fill: token('muted-foreground') }}>
            {block.reference.label}
          </text>
        </g>
      );
    }
  }

  /* ---- tooltip ---- */
  let tooltip: React.ReactNode = null;
  if (active) {
    const i = active.i;
    const order = stacked ? [...visibleIdx].reverse() : visibleIdx;
    // Shares of the SHOWN stack (the total this tooltip reads out), null when a part is missing.
    const slotShares = stacked && totals && isNum(totals[i]) ? reconcilingShares(visibleIdx.map((k) => valueAt(k, i)), totals[i] as number) : null;
    const rows: TooltipRow[] = order.map((k) => {
      const v = valueAt(k, i);
      const sel = active.j >= 0 ? visibleIdx[active.j] === k : true;
      const share = slotShares ? slotShares[visibleIdx.indexOf(k)] : null;
      return {
        key: block.series[k].key,
        color: catStyles ? catStyles[i].color : styles[k].color,
        shape: isLine ? 'line' : 'rect',
        value: share === null ? formatValue(v, unit) : `${formatValue(v, unit)} · ${share}%`,
        label: isNum(v) ? block.series[k].label : `${block.series[k].label}, not measured`,
        muted: !sel,
        untrusted: block.untrusted,
      };
    });
    if (stacked && totals) {
      rows.unshift({ key: '__total', value: formatValue(totals[i], unit), label: isNum(totals[i]) ? totalWord : `${totalWord}, not measured` });
    }
    const notes: React.ReactNode[] = [];
    if (compared) {
      // The comparison's change, latest period against the one before it (P0-6).
      const c = changeAt(i);
      if (c.delta !== null) notes.push(`Change vs ${c.base}: ${c.abs} (${c.pct})`);
    }
    if (block.last_in_progress && i === lastIdx) notes.push('In progress: this period is still filling.');
    const ref = drillAt(i);
    if (ref) notes.push(`Open in ${navLabel(ref.page)} ›`);
    tooltip = (
      <TooltipBody
        heading={
          <>
            <span className={block.untrusted && !isTime ? 'font-mono' : undefined}>{fullX(i)}</span>
            {zoneNote ? <span className="font-normal text-muted-foreground"> · {axisZone(block.x)}</span> : null}
          </>
        }
        rows={rows}
        notes={notes}
      />
    );
  }

  const ariaLabel = `${title}. ${KIND_WORD[kind]}, ${unitLabel(unit)}${isTime ? `, ${axisZone(block.x)}` : ''}${range ? `, zoomed to ${n} of ${full.x.values.length} points` : ''}.`;
  const instructions =
    'Use the left and right arrow keys to read each position' +
    (secondary ? ', up and down to pick a series' : '') +
    '; Home and End jump to the first and last. ' +
    (block.drill ? 'Enter opens the linked page. ' : '') +
    (zoomable ? 'To zoom, hold Shift with the left or right arrow key to select a range, then press Enter. ' : '') +
    'A data table follows the chart.';

  const legend =
    block.series.length >= 2 ? (
      <Legend
        items={styles}
        hidden={staticMode ? undefined : hidden}
        onToggle={staticMode ? undefined : toggle}
        shape={isLine ? 'line' : 'rect'}
        untrusted={block.untrusted}
        className="mt-1.5"
      />
    ) : null;

  const activeLeft = active ? Math.round(x0 + active.i * slot) : 0;
  const plotRef = nav.plotRef;
  const resetZoom = () => {
    clickAnchor.current = null;
    setZoom(null);
    // Back to the whole series' numbering, on the same period.
    if (active) nav.moveTo({ i: active.i + offset, j: active.j });
    announce(`Zoom reset: showing all ${full.x.values.length} points.`);
    plotRef.current?.focus({ preventScroll: true });
  };
  const zoomText = range ? `Zoomed to ${fullX(0)} – ${fullX(n - 1)} (${n} of ${full.x.values.length} points)` : '';
  const zoomRange = range ? xRangeLabel(block.x, 0, n - 1) : '';

  return (
    <div ref={boxRef} className="min-w-0">
      {zoomable ? (
        // ONE row that always exists on a zoomable chart, at a fixed height: a quiet hint
        // until a zoom, then the zoomed range and Reset. A row that appeared on release
        // would push the plot down under the pointer that just made the selection.
        // The row is its own size container: on a phone-width card "Zoomed to" and
        // "points" are left to assistive tech, and only the range may truncate; the
        // count ("15 of 30") always shows, since it is what says the chart is a slice.
        <div
          className="@container mb-1 flex h-6 min-w-0 items-center justify-end gap-x-2 text-2xs text-muted-foreground"
          data-print-hide
          data-testid="chart-zoom-row"
        >
          {range ? (
            <>
              <span className="flex min-w-0 items-baseline gap-x-1 tabular-nums" title={zoomText} data-testid="chart-zoom-bar">
                <span className="min-w-0 truncate" data-testid="chart-zoom-range">
                  <span className="sr-only @[28rem]:not-sr-only @[28rem]:whitespace-nowrap">Zoomed to </span>
                  {zoomRange}
                </span>{' '}
                <span className="shrink-0 whitespace-nowrap" data-testid="chart-zoom-count">
                  ({n} of {full.x.values.length}
                  <span className="sr-only @[28rem]:not-sr-only"> points</span>)
                </span>
              </span>
              <button
                type="button"
                onClick={resetZoom}
                className={cn('inline-flex h-6 shrink-0 items-center rounded-sm px-1.5 font-medium text-primary hover:bg-muted', focusRing)}
                data-testid="chart-zoom-reset"
              >
                Reset zoom
              </button>
            </>
          ) : (
            // The plot's sr-only instructions already say how to zoom from the keyboard.
            <span className="min-w-0 truncate" aria-hidden data-testid="chart-zoom-hint">
              Drag across the chart to zoom
            </span>
          )}
        </div>
      ) : null}
      {block.y_label || zoneNote ? (
        <div className="mb-1 flex items-baseline justify-between gap-3 text-2xs text-muted-foreground">
          {/* The y axis title (BLOCKS.md `y_label`), above the plot where it never rotates. */}
          {block.y_label ? (
            <p className="min-w-0 truncate" data-testid="chart-y-label">
              {block.y_label}
            </p>
          ) : (
            <span aria-hidden />
          )}
          {/* A calendar axis cut in another zone than UTC says which (the table header too). */}
          {zoneNote ? (
            <p className="shrink-0" data-testid="chart-zone">
              {zoneNote}
            </p>
          ) : null}
        </div>
      ) : null}
      <ChartShell
        nav={nav}
        ariaLabel={ariaLabel}
        instructions={instructions}
        height={height}
        onPointerAt={onPointerAt}
        onClick={onPlotClick}
        clickable={Boolean(block.drill)}
        brush={brush}
        tooltip={tooltip}
        anchorFor={anchorFor}
        anchorKey={active ? `${active.i}:${active.j}` : ''}
        legend={legend}
        staticMode={staticMode}
        testId={`chart-${kind}`}
        fallback={{
          caption: `${title} (${unitLabel(unit)})${range ? `, zoomed to ${n} of ${full.x.values.length} points` : ''}`,
          rowHeader: xAxisHeader(block.x),
          columns: [
            ...(stacked ? ['Total'] : []),
            ...block.series.map((s) => s.label),
            // A comparison's table carries its change, like the server's delta table.
            ...(compared ? [`Change vs ${block.series[block.series.length - 2].label}`] : []),
          ],
          rows: block.x.values.map((_, i) => {
            const t = allTotals ? allTotals[i] : null;
            const shares = allTotals && isNum(t) ? reconcilingShares(block.series.map((s) => s.values[i] ?? null), t) : null;
            const change = compared ? changeAt(i) : null;
            return {
              key: String(i),
              header: `${fullX(i)}${block.last_in_progress && i === lastIdx ? IN_PROGRESS_SUFFIX : ''}`,
              cells: [
                ...(stacked ? [srValue(formatValue(t, unit), t)] : []),
                ...block.series.map((s, k) => {
                  const text = srValue(formatValue(s.values[i] ?? null, unit), s.values[i] ?? null);
                  return shares ? `${text} (${shares[k]}%)` : text;
                }),
                ...(change ? [change.delta === null ? 'not measured' : `${change.abs} (${change.pct})`] : []),
              ],
            };
          }),
        }}
      >
        <svg width={width} height={height} className="block overflow-visible" aria-hidden data-baseline={Math.round(zeroY)}>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          {scale.ticks
            .filter((t) => t !== 0)
            .map((t) => (
              <rect key={`g${t}`} x={x0} y={Math.round(yOf(t))} width={plotW} height={1} fill={token('border')} data-testid="chart-gridline" />
            ))}
          {selection ? (
            <rect
              x={Math.round(x0 + selection[0] * slot)}
              y={plotTop - 4}
              width={Math.max(1, Math.round((selection[1] - selection[0] + 1) * slot))}
              height={zeroY - plotTop + 4}
              fill={token('primary', 0.12)}
              stroke={token('primary', 0.5)}
              strokeWidth={1}
              data-testid="chart-zoom-selection"
            />
          ) : null}
          {nav.open && active && !isLine ? (
            <rect x={activeLeft} y={plotTop - 4} width={Math.max(1, Math.round(slot))} height={zeroY - plotTop + 4} fill={token('muted-foreground', 0.1)} />
          ) : null}
          {bars}
          {lines}
          {nav.open && active && isLine ? (
            <rect x={Math.round(xOf(active.i))} y={plotTop} width={1} height={zeroY - plotTop} fill={token('muted-foreground', 0.5)} data-testid="chart-crosshair" />
          ) : null}
          <rect x={x0} y={Math.round(zeroY)} width={plotW} height={1} fill={token('border')} data-testid="chart-baseline" />
          {reference}
          {nav.focusRing && active ? (
            <rect
              x={activeLeft + 1}
              y={plotTop - 3}
              width={Math.max(2, Math.round(slot) - 2)}
              height={zeroY - plotTop + 5}
              rx={2}
              fill="none"
              stroke={token('ring')}
              strokeWidth={2}
              data-testid="chart-focus-ring"
            />
          ) : null}
          {scale.ticks.map((t, q) => (
            <text key={`t${t}`} x={x0 - Y_GAP} y={yOf(t)} dy="0.32em" textAnchor="end" className="text-2xs tabular-nums" style={{ fill: token('muted-foreground') }}>
              {tickTexts[q]}
            </text>
          ))}
          {xLabels.map((l) => (
            <text
              key={`x${l.index}`}
              x={l.x}
              y={baseline + 15}
              textAnchor="middle"
              className={block.untrusted && !isTime ? 'font-mono text-2xs' : 'text-2xs tabular-nums'}
              style={{ fill: token('muted-foreground') }}
            >
              {l.text}
            </text>
          ))}
          {block.last_in_progress && n > 0 ? (
            // The newest period is still filling: say so in words under its slot, not
            // only by the lighter / dashed mark (WCAG 1.4.1).
            <text
              x={Math.min(xOf(lastIdx), width - (IN_PROGRESS_SUFFIX.length * CHAR_W) / 2)}
              y={baseline + 15 + IN_PROGRESS_LINE_H}
              textAnchor="middle"
              className="text-2xs"
              style={{ fill: token('muted-foreground') }}
              data-testid="chart-in-progress"
            >
              {IN_PROGRESS_SUFFIX.trim()}
            </text>
          ) : null}
          {labels.map((l) => (
            <text
              key={`el${l.k}`}
              x={x0 + plotW + 8}
              y={l.y}
              dy="0.32em"
              className={block.untrusted ? 'font-mono text-2xs' : 'text-2xs'}
              style={{ fill: token('foreground') }}
            >
              {l.text}
            </text>
          ))}
        </svg>
      </ChartShell>
    </div>
  );
}
