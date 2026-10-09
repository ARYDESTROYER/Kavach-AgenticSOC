/**
 * Columns, stacked columns, lines and areas over one x axis (BLOCKS.md chart table).
 *
 * - `bar`: ⅔-slot columns capped at 22 px, square at the baseline with a 2 px top radius;
 *   grouped when ≥ 2 series. The whole x slot is the hit target.
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
 * lighter (0.6, the house value that still clears 3:1) or dashed while `last_in_progress`.
 */
import * as React from 'react';

import { navLabel } from '@/soc/nav';
import { token } from '@/soc/components/palette';

import { useBlocks } from '../context';
import { clipText, formatTick, formatValue, instantOf, shortTimeLabel, unitLabel, xLabelFull } from '../format';
import type { ChartBlock } from '../schema';
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

export interface CartesianChartProps {
  block: ChartBlock & { kind: 'bar' | 'stacked_bar' | 'line' | 'area' };
  title: string;
  height: number;
  staticMode?: boolean;
}

const KIND_WORD: Record<CartesianChartProps['block']['kind'], string> = {
  bar: 'Column chart',
  stacked_bar: 'Stacked column chart',
  line: 'Line chart',
  area: 'Area chart',
};

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function CartesianChart({ block, title, height, staticMode = false }: CartesianChartProps) {
  const { navigate } = useBlocks();
  const boxRef = React.useRef<HTMLDivElement>(null);
  const width = useChartSize(boxRef, { staticMode });
  const hatchId = useSvgId('hatch');
  const kind = block.kind;
  const isLine = kind === 'line' || kind === 'area';
  const stacked = kind === 'stacked_bar';
  const styles = React.useMemo(() => seriesStyles(block), [block]);
  const catStyles = React.useMemo(() => (kind === 'bar' ? categoryStyles(block, false) : null), [block, kind]);
  const [hidden, toggle] = useSeriesVisibility(block.series.length);
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
  const x0 = Math.ceil(Math.max(...tickTexts.map((t) => t.length)) * CHAR_W) + Y_GAP;
  const endLabels = isLine && visibleIdx.length >= 2 && visibleIdx.length <= 4;
  const padRight = endLabels
    ? Math.ceil(Math.min(END_LABEL_CHARS, Math.max(...visibleIdx.map((k) => block.series[k].label.length))) * CHAR_W) + 14
    : 8;
  const plotTop = PAD_TOP;
  const baseline = Math.max(plotTop + 24, height - X_AXIS_H);
  const plotW = Math.max(1, width - x0 - padRight);
  const slot = plotW / Math.max(1, n);
  const yOf = (v: number) => baseline - ((v - scale.min) / (scale.max - scale.min)) * (baseline - plotTop);
  const zeroY = yOf(0);
  const xOf = (i: number) => x0 + (i + 0.5) * slot;
  const lastIdx = n - 1;
  const opacityAt = (i: number) => (block.last_in_progress && i === lastIdx ? IN_PROGRESS_OPACITY : 1);

  /* ---- x labels ---- */
  const isTime = block.x.kind === 'time';
  const shortX = block.x.values.map((v) => (isTime ? shortTimeLabel(v, block.x.bucket) : clipText(v, 12)));
  const instants = isTime ? block.x.values.map((v) => instantOf(v)) : undefined;
  const xLabels = placeXLabels(pickXLabels(shortX, plotW, instants), shortX, xOf, width);

  /* ---- interaction ---- */
  const secondary = visibleIdx.length > 1 ? visibleIdx.length : 0;
  const fullX = (i: number) => xLabelFull(block.x.values[i] ?? '', block.x.kind, block.x.bucket);
  const valueAt = (k: number, i: number) => block.series[k].values[i] ?? null;
  const summarize = React.useCallback(
    (c: ChartCursor) => {
      const head = `${fullX(c.i)}${block.last_in_progress && c.i === lastIdx ? ', in progress' : ''}`;
      const ks = c.j >= 0 ? [visibleIdx[c.j]] : visibleIdx;
      const parts = ks.map((k) => `${block.series[k].label} ${srValue(formatValue(valueAt(k, c.i), unit), valueAt(k, c.i))}`);
      if (stacked && c.j < 0 && totals) parts.unshift(`${totalWord} ${srValue(formatValue(totals[c.i], unit), totals[c.i])}`);
      return `${head}: ${parts.join(', ')}.`;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [block, visibleIdx.join(','), stacked, totals?.join(','), unit, totalWord],
  );
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
  });
  const active = nav.cursor;

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
    if (block.last_in_progress && i === lastIdx) notes.push('In progress: this bucket is still filling.');
    const ref = drillAt(i);
    if (ref) notes.push(`Open in ${navLabel(ref.page)} ›`);
    tooltip = (
      <TooltipBody
        heading={<span className={block.untrusted && !isTime ? 'font-mono' : undefined}>{fullX(i)}</span>}
        rows={rows}
        notes={notes}
      />
    );
  }

  const ariaLabel = `${title}. ${KIND_WORD[kind]}, ${unitLabel(unit)}${block.x.kind === 'time' ? ', UTC' : ''}.`;
  const instructions =
    'Use the left and right arrow keys to read each position' +
    (secondary ? ', up and down to pick a series' : '') +
    '; Home and End jump to the first and last. ' +
    (block.drill ? 'Enter opens the linked page. ' : '') +
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

  return (
    <div ref={boxRef} className="min-w-0">
      {block.y_label ? (
        // The y axis title (BLOCKS.md `y_label`), above the plot where it never rotates.
        <p className="mb-1 truncate text-2xs text-muted-foreground" data-testid="chart-y-label">
          {block.y_label}
        </p>
      ) : null}
      <ChartShell
        nav={nav}
        ariaLabel={ariaLabel}
        instructions={instructions}
        height={height}
        onPointerAt={onPointerAt}
        onClick={() => {
          if (active && drillAt(active.i)) navigate(drillAt(active.i)!);
        }}
        clickable={Boolean(block.drill)}
        tooltip={tooltip}
        anchorFor={anchorFor}
        anchorKey={active ? `${active.i}:${active.j}` : ''}
        legend={legend}
        staticMode={staticMode}
        testId={`chart-${kind}`}
        fallback={{
          caption: `${title} (${unitLabel(unit)})`,
          rowHeader: block.x.label ?? (isTime ? 'Time (UTC)' : 'Category'),
          columns: [...(stacked ? ['Total'] : []), ...block.series.map((s) => s.label)],
          rows: block.x.values.map((_, i) => {
            const t = allTotals ? allTotals[i] : null;
            const shares = allTotals && isNum(t) ? reconcilingShares(block.series.map((s) => s.values[i] ?? null), t) : null;
            return {
              key: String(i),
              header: `${fullX(i)}${block.last_in_progress && i === lastIdx ? ' (in progress)' : ''}`,
              cells: [
                ...(stacked ? [srValue(formatValue(t, unit), t)] : []),
                ...block.series.map((s, k) => {
                  const text = srValue(formatValue(s.values[i] ?? null, unit), s.values[i] ?? null);
                  return shares ? `${text} (${shares[k]}%)` : text;
                }),
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
