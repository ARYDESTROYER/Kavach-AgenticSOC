/**
 * Horizontal bars (BLOCKS.md `hbar`): the categories chart for a narrow chat column,
 * because hostnames, rule names and IPs stay readable without rotation.
 *
 * - A simple single series of ≤ 10 measured, non-negative rows with no drill-through and
 *   no reference renders as the console's lighter, already-accessible `BarList`.
 * - Otherwise: labels left (ellipsised; the full label is in the tooltip and the table),
 *   bars square at the zero line with a 2 px radius at the tip, the value at the tip in
 *   text ink, `null` rows hatched across the plot, one tab stop with ↑/↓ rows (←/→
 *   series when grouped), and the whole row as the hit target. A reference line carries
 *   its plain-text label in a strip above the rows, so it never collides with a bar.
 */
import * as React from 'react';

import { BarList } from '@/soc/components/BarList';
import { token } from '@/soc/components/palette';
import { navLabel } from '@/soc/nav';

import { useBlocks } from '../context';
import { clipText, formatTick, formatValue, unitLabel, xLabelFull } from '../format';
import type { ChartBlock, SemanticKey } from '../schema';
import { HatchPattern, MARK_FORCED, ChartShell, useSvgId } from './ChartShell';
import type { AnchorRect } from './ChartTooltipPortal';
import { TooltipBody, type TooltipRow } from './ChartTooltipPortal';
import { DataTableFallback, srValue } from './DataTableFallback';
import { CHAR_W, extent, niceScale, roundedRightPath } from './geometry';
import { Legend, useSeriesVisibility } from './Legend';
import { asSemantic, categoryStyles, seriesStyles } from './series';
import { useChartNavigator, type ChartCursor } from './useChartNavigator';
import { useChartSize } from './useChartSize';

const ROW_H = 26;
const BAR_H = 14;
const AXIS_H = 18;
const LABEL_MAX = 160;
const GAP = 8;
/** Room above the rows for a reference line's label. */
const REF_LABEL_H = 14;

/** Literal Tailwind classes (JIT-visible) for BarList fills, keyed by axis token. */
const BAR_CLASS: Record<string, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground',
};
const SEMANTIC_BAR: Partial<Record<SemanticKey, string>> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
  investigating: 'primary',
  escalated: 'high',
  on_hold: 'warning',
  resolved: 'success',
  closed: 'success',
  true_positive: 'critical',
  false_positive: 'info',
  benign: 'info',
  needs_human: 'warning',
  suspicious: 'high',
};

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The simple-list shortcut applies (BLOCKS.md: single series, ≤ 10 rows, no axis needed). */
export function fitsBarList(block: ChartBlock): boolean {
  return (
    block.series.length === 1 &&
    block.x.values.length <= 10 &&
    !block.drill &&
    !block.reference &&
    block.series[0].values.every((v) => isNum(v) && v >= 0)
  );
}

export interface HBarChartProps {
  block: ChartBlock;
  title: string;
  staticMode?: boolean;
  /** Force the SVG renderer (the expanded sheet). */
  full?: boolean;
}

export function HBarChart({ block, title, staticMode = false, full = false }: HBarChartProps) {
  if (!full && fitsBarList(block)) return <BarListView block={block} title={title} staticMode={staticMode} />;
  return <HBarSvg block={block} title={title} staticMode={staticMode} />;
}

function BarListView({ block, title, staticMode }: { block: ChartBlock; title: string; staticMode: boolean }) {
  const values = block.series[0].values as number[];
  const items = block.x.values.map((label, i) => {
    const sem = asSemantic(label);
    const cls = sem && SEMANTIC_BAR[sem] ? BAR_CLASS[SEMANTIC_BAR[sem] as string] : undefined;
    return { label, value: values[i], color: cls };
  });
  return (
    <div data-testid="chart-hbar-list" className="min-w-0">
      <BarList items={items} format={(v) => formatValue(v, block.unit)} className={block.untrusted ? '[&_li_span:first-child]:font-mono' : undefined} />
      <DataTableFallback
        caption={`${title} (${unitLabel(block.unit)})`}
        rowHeader={block.x.label ?? 'Category'}
        columns={[block.series[0].label]}
        rows={block.x.values.map((x, i) => ({ key: String(i), header: x, cells: [formatValue(values[i], block.unit)] }))}
        visible={staticMode}
      />
    </div>
  );
}

function HBarSvg({ block, title, staticMode }: { block: ChartBlock; title: string; staticMode: boolean }) {
  const { navigate } = useBlocks();
  const boxRef = React.useRef<HTMLDivElement>(null);
  const width = useChartSize(boxRef, { staticMode });
  const hatchId = useSvgId('hatch');
  const styles = React.useMemo(() => seriesStyles(block), [block]);
  const catStyles = React.useMemo(() => categoryStyles(block, false), [block]);
  const [hidden, toggle] = useSeriesVisibility(block.series.length);
  const visibleIdx = block.series.map((_, k) => k).filter((k) => !hidden[k]);
  const n = block.x.values.length;
  const unit = block.unit;
  const m = Math.max(1, visibleIdx.length);
  const rowH = m > 1 ? Math.max(ROW_H, m * 8 + 10) : ROW_H;
  const barH = m > 1 ? Math.max(4, Math.floor((rowH - 10 - (m - 1)) / m)) : BAR_H;
  const padTop = block.reference?.axis === 'y' ? REF_LABEL_H : 0;
  const height = padTop + n * rowH + AXIS_H;

  const [lo, hi] = extent(visibleIdx.map((k) => block.series[k].values));
  const refX = block.reference?.axis === 'y' ? block.reference.value : null;
  const scale = niceScale(Math.min(lo, refX ?? lo), Math.max(hi, refX ?? hi), 4);
  const valueTexts = visibleIdx.flatMap((k) => block.series[k].values.map((v) => formatValue(v, unit)));
  const valueW = Math.ceil(Math.max(3, ...valueTexts.map((t) => t.length)) * CHAR_W) + GAP;
  const labelW = Math.min(LABEL_MAX, Math.max(48, Math.round(width * 0.32)));
  const x0 = labelW + GAP;
  const plotW = Math.max(1, width - x0 - valueW);
  const xOf = (v: number) => x0 + ((v - scale.min) / (scale.max - scale.min)) * plotW;
  const zeroX = xOf(0);
  const labelChars = Math.max(4, Math.floor(labelW / CHAR_W));
  const fullX = (i: number) => xLabelFull(block.x.values[i] ?? '', block.x.kind, block.x.bucket);
  const drillAt = (i: number) => block.drill?.[i] ?? null;

  const summarize = React.useCallback(
    (c: ChartCursor) => {
      const ks = c.j >= 0 ? [visibleIdx[c.j]] : visibleIdx;
      const parts = ks.map((k) => {
        const v = block.series[k].values[c.i] ?? null;
        return `${visibleIdx.length > 1 ? `${block.series[k].label} ` : ''}${srValue(formatValue(v, unit), v)}`;
      });
      return `${fullX(c.i)}: ${parts.join(', ')}.`;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [block, visibleIdx.join(','), unit],
  );
  const nav = useChartNavigator({
    count: n,
    secondary: visibleIdx.length > 1 ? visibleIdx.length : 0,
    orientation: 'vertical',
    summarize,
    initial: { i: 0, j: -1 },
    onActivate: (c) => {
      const ref = drillAt(c.i);
      if (ref) navigate(ref);
    },
    disabled: staticMode,
  });
  const active = nav.cursor;
  const anchorFor = React.useCallback(
    (plot: DOMRect): AnchorRect | null =>
      active
        ? { left: plot.left, right: plot.right, top: plot.top + padTop + active.i * rowH, bottom: plot.top + padTop + (active.i + 1) * rowH }
        : null,
    [active, rowH, padTop],
  );

  let tooltip: React.ReactNode = null;
  if (active) {
    const rows: TooltipRow[] = visibleIdx.map((k) => {
      const v = block.series[k].values[active.i] ?? null;
      return {
        key: block.series[k].key,
        color: catStyles ? catStyles[active.i].color : styles[k].color,
        value: formatValue(v, unit),
        label: isNum(v) ? block.series[k].label : `${block.series[k].label}, not measured`,
        muted: active.j >= 0 && visibleIdx[active.j] !== k,
      };
    });
    const ref = drillAt(active.i);
    tooltip = (
      <TooltipBody
        heading={<span className={block.untrusted ? 'font-mono' : undefined}>{fullX(active.i)}</span>}
        rows={rows}
        notes={ref ? [`Open in ${navLabel(ref.page)} ›`] : []}
      />
    );
  }

  const marks: React.ReactNode[] = [];
  for (let i = 0; i < n; i += 1) {
    const rowTop = i * rowH;
    const groupTop = rowTop + (rowH - (m * barH + (m - 1))) / 2;
    visibleIdx.forEach((k, q) => {
      const v = block.series[k].values[i] ?? null;
      const y = Math.round(groupTop + q * (barH + 1));
      if (!isNum(v)) {
        marks.push(
          <rect key={`h${i}-${k}`} x={x0} y={y} width={plotW} height={barH} fill={`url(#${hatchId})`} data-state="unmeasured" data-index={i} />,
        );
        return;
      }
      const color = catStyles ? catStyles[i].color : styles[k].color;
      if (v !== 0) {
        const w = Math.max(2, Math.abs(xOf(v) - zeroX));
        marks.push(
          v > 0 ? (
            <path key={`b${i}-${k}`} d={roundedRightPath(zeroX, y, w, barH)} fill={color} data-index={i} data-series={k} className={MARK_FORCED} />
          ) : (
            <rect key={`b${i}-${k}`} x={zeroX - w} y={y} width={w} height={barH} fill={color} data-index={i} data-series={k} className={MARK_FORCED} />
          ),
        );
      }
      marks.push(
        <text
          key={`v${i}-${k}`}
          x={Math.max(zeroX, xOf(v)) + 4}
          y={y + barH / 2}
          dy="0.32em"
          className="text-2xs font-medium tabular-nums"
          style={{ fill: token('foreground') }}
        >
          {formatValue(v, unit)}
        </text>,
      );
    });
    const label = block.x.values[i] ?? '';
    marks.push(
      <text
        key={`l${i}`}
        x={labelW}
        y={rowTop + rowH / 2}
        dy="0.32em"
        textAnchor="end"
        className={block.untrusted ? 'font-mono text-2xs' : 'text-xs'}
        style={{ fill: token('foreground') }}
      >
        {clipText(label, labelChars)}
      </text>,
    );
  }

  const ariaLabel = `${title}. Horizontal bar chart, ${unitLabel(unit)}.`;
  const legend =
    block.series.length >= 2 ? (
      <Legend items={styles} hidden={staticMode ? undefined : hidden} onToggle={staticMode ? undefined : toggle} shape="rect" className="mt-1.5" />
    ) : null;

  return (
    <div ref={boxRef} className="min-w-0">
      <ChartShell
        nav={nav}
        ariaLabel={ariaLabel}
        instructions={`Use the up and down arrow keys to read each row${visibleIdx.length > 1 ? ', left and right to pick a series' : ''}; Home and End jump to the first and last. ${block.drill ? 'Enter opens the linked page. ' : ''}A data table follows the chart.`}
        height={height}
        onPointerAt={(_x, y) => {
          const i = Math.floor((y - padTop) / rowH);
          nav.hover(i >= 0 && i < n ? { i, j: -1 } : null);
        }}
        onClick={() => {
          if (active && drillAt(active.i)) navigate(drillAt(active.i)!);
        }}
        clickable={Boolean(block.drill)}
        tooltip={tooltip}
        anchorFor={anchorFor}
        anchorKey={active ? `${active.i}:${active.j}` : ''}
        legend={legend}
        staticMode={staticMode}
        testId="chart-hbar"
        fallback={{
          caption: `${title} (${unitLabel(unit)})`,
          rowHeader: block.x.label ?? 'Category',
          columns: block.series.map((s) => s.label),
          rows: block.x.values.map((_, i) => ({
            key: String(i),
            header: fullX(i),
            cells: block.series.map((s) => srValue(formatValue(s.values[i] ?? null, unit), s.values[i] ?? null)),
          })),
        }}
      >
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          {block.reference?.axis === 'y' ? (
            <text
              x={Math.round(xOf(block.reference.value))}
              y={10}
              textAnchor={xOf(block.reference.value) > x0 + plotW * 0.6 ? 'end' : 'start'}
              className="text-2xs"
              style={{ fill: token('muted-foreground') }}
              data-testid="chart-reference-label"
            >
              {block.reference.label}
            </text>
          ) : null}
          <g transform={padTop ? `translate(0,${padTop})` : undefined}>
            {nav.open && active ? (
              <rect x={0} y={active.i * rowH} width={width} height={rowH} fill={token('muted-foreground', 0.1)} />
            ) : null}
            {scale.ticks
              .filter((t) => t !== 0)
              .map((t) => (
                <rect key={`g${t}`} x={Math.round(xOf(t))} y={0} width={1} height={n * rowH} fill={token('border')} />
              ))}
            <rect x={Math.round(zeroX)} y={0} width={1} height={n * rowH} fill={token('border')} data-testid="chart-baseline" />
            {marks}
            {block.reference?.axis === 'y' ? (
              <g data-testid="chart-reference">
                <rect x={Math.round(xOf(block.reference.value))} y={0} width={1} height={n * rowH} fill={token('muted-foreground', 0.7)} />
            </g>
          ) : null}
          {nav.focusRing && active ? (
            <rect x={1} y={active.i * rowH + 1} width={width - 2} height={rowH - 2} rx={2} fill="none" stroke={token('ring')} strokeWidth={2} data-testid="chart-focus-ring" />
          ) : null}
          {scale.ticks.map((t) => (
            <text key={`t${t}`} x={xOf(t)} y={n * rowH + 13} textAnchor="middle" className="text-2xs tabular-nums" style={{ fill: token('muted-foreground') }}>
              {formatTick(t, unit)}
            </text>
          ))}
          </g>
        </svg>
      </ChartShell>
    </div>
  );
}
