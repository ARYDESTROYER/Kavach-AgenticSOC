/**
 * `heatmap` block (BLOCKS.md `heatmap`): a DOM grid in MitreHeatmap's style (hour-of-week,
 * entity × time, rule × severity). Magnitude uses the viridis `sequential()` ramp in five
 * quantised steps; a measured 0 is an empty muted cell and a `null` cell is HATCHED with a
 * dashed hairline, so "not measured" never reads as zero (G3). Values sit on a scrim chip
 * only where a cell is at least 28 px wide; otherwise they are in the tooltip and table.
 * ONE tab stop with 2-D arrow navigation; an sr-only table carries every value.
 *
 * Column labels are thinned to every `xEvery`-th column, and each label spans the
 * columns up to the next one, so a 2-character hour survives 48 columns at 390 px.
 * `x.label` / `y.label` are drawn as axis titles. In `forced-colors: active` the colour
 * ramp is gone (backgrounds are forced), so each measured cell shows its step number
 * (1–5, matching the legend) and "not measured" keeps its dashed border.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { sequential, token } from '@/soc/components/palette';

import { clipText, formatValue, unitLabel } from '../format';
import type { HeatmapBlock } from '../schema';
import { ChartShell } from '../charts/ChartShell';
import type { AnchorRect } from '../charts/ChartTooltipPortal';
import { TooltipBody } from '../charts/ChartTooltipPortal';
import { srValue } from '../charts/DataTableFallback';
import { CHAR_W, INTENSITY_STEPS, intensityStep } from '../charts/geometry';
import { useChartNavigator, type ChartCursor } from '../charts/useChartNavigator';
import { useChartSize } from '../charts/useChartSize';

const CELL_H = 22;
const HEADER_H = 18;
const LABEL_MAX = 140;
/** Narrowest cell that can still carry a forced-colors step digit. */
const STEP_DIGIT_MIN_W = 10;

/** The legend step (1–5) of a positive value; 0 for zero or less. */
export function intensityLevel(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.round(Math.min(1, value / max) * 4) + 1;
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function HeatmapView({ block, title, staticMode = false }: { block: HeatmapBlock; title: string; staticMode?: boolean }) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const width = useChartSize(boxRef, { staticMode });
  const cols = block.x.values.length;
  const rows = block.y.values.length;
  const max = Math.max(0, ...block.cells.flat().filter(isNum));
  const longest = Math.max(1, ...block.y.values.map((v) => v.length));
  const labelW = Math.min(LABEL_MAX, Math.ceil(longest * CHAR_W) + 8);
  const cellW = Math.max(4, (width - labelW) / Math.max(1, cols));
  const showValues = cellW >= 28;
  const height = HEADER_H + rows * CELL_H;
  const labelChars = Math.max(3, Math.floor(labelW / CHAR_W));
  const hatch = `repeating-linear-gradient(45deg, ${token('muted-foreground', 0.3)} 0 1px, transparent 1px 6px)`;

  const summarize = React.useCallback(
    (c: ChartCursor) => {
      const v = block.cells[c.j]?.[c.i] ?? null;
      return `${block.y.values[c.j]}, ${block.x.values[c.i]}: ${srValue(formatValue(v, block.unit), v)}.`;
    },
    [block],
  );
  const nav = useChartNavigator({
    count: cols,
    secondary: rows,
    orientation: 'grid',
    summarize,
    initial: { i: 0, j: 0 },
    disabled: staticMode,
  });
  const active = nav.cursor;
  const anchorFor = React.useCallback(
    (plot: DOMRect): AnchorRect | null => {
      if (!active) return null;
      const left = plot.left + labelW + active.i * cellW;
      const top = plot.top + HEADER_H + active.j * CELL_H;
      return { left, right: left + cellW, top, bottom: top + CELL_H };
    },
    [active, cellW, labelW],
  );

  const tooltip = active ? (
    <TooltipBody
      heading={
        <span className={block.untrusted ? 'font-mono' : undefined}>{`${block.y.values[active.j]} · ${block.x.values[active.i]}`}</span>
      }
      rows={[
        {
          key: 'v',
          value: formatValue(block.cells[active.j]?.[active.i] ?? null, block.unit),
          label: isNum(block.cells[active.j]?.[active.i]) ? unitLabel(block.unit) : 'not measured',
        },
      ]}
    />
  ) : null;

  // Every xEvery-th column is labelled, and the label owns the span up to the next one.
  const longestX = Math.max(1, ...block.x.values.map((v) => v.length));
  const xLabelPx = Math.min(96, Math.max(24, Math.ceil(longestX * CHAR_W) + 6));
  const xEvery = Math.max(1, Math.ceil(xLabelPx / cellW));
  const stepDigits = !showValues && cellW >= STEP_DIGIT_MIN_W;

  return (
    <div ref={boxRef} className="min-w-0" data-testid="block-heatmap">
      {block.x.label ? (
        <p className="mb-0.5 truncate text-2xs font-medium text-muted-foreground" style={{ paddingLeft: labelW }} data-testid="heatmap-x-label">
          {block.x.label}
        </p>
      ) : null}
      <ChartShell
        nav={nav}
        ariaLabel={`${title}. Heatmap of ${rows} rows by ${cols} columns, ${unitLabel(block.unit)}.`}
        instructions="Use the arrow keys to move between cells; Home and End jump along the row. A data table follows the grid."
        height={height}
        onPointerAt={(x, y) => {
          const i = Math.floor((x - labelW) / cellW);
          const j = Math.floor((y - HEADER_H) / CELL_H);
          nav.hover(i >= 0 && i < cols && j >= 0 && j < rows ? { i, j } : null);
        }}
        tooltip={tooltip}
        anchorFor={anchorFor}
        anchorKey={active ? `${active.i}:${active.j}` : ''}
        staticMode={staticMode}
        testId="chart-heatmap"
        footer={
          <div className="mt-2 flex items-center gap-1.5 text-2xs text-muted-foreground" aria-hidden>
            <span>Low</span>
            {INTENSITY_STEPS.map((a, k) => (
              <span
                key={a}
                className="inline-flex h-3 w-5 items-center justify-center rounded-sm border border-border/40 text-2xs leading-none"
                style={{ backgroundColor: sequential(a) }}
              >
                <span className="hidden forced-colors:inline">{k + 1}</span>
              </span>
            ))}
            <span>High</span>
            <span className="ml-3 inline-block h-3 w-5 rounded-sm border border-dashed border-border" style={{ backgroundImage: hatch }} />
            <span>not measured</span>
            <span className="ml-auto tabular-nums">max {formatValue(max, block.unit)}</span>
          </div>
        }
        fallback={{
          caption: `${title} (${unitLabel(block.unit)})`,
          rowHeader: block.y.label ?? 'Row',
          columns: block.x.values,
          rows: block.y.values.map((y, r) => ({
            key: String(r),
            header: y,
            cells: block.x.values.map((_, c) => srValue(formatValue(block.cells[r]?.[c] ?? null, block.unit), block.cells[r]?.[c] ?? null)),
          })),
        }}
      >
        <div aria-hidden className="relative" style={{ height }}>
          {block.y.label ? (
            <span
              className="absolute left-0 top-0 truncate pr-2 text-right text-2xs font-medium text-muted-foreground"
              style={{ width: labelW, height: HEADER_H }}
              data-testid="heatmap-y-label"
            >
              {block.y.label}
            </span>
          ) : null}
          <div className="absolute" style={{ left: labelW, top: 0, height: HEADER_H, width: cols * cellW }}>
            {block.x.values.map((x, i) =>
              i % xEvery === 0 ? (
                <span
                  key={i}
                  className={cn('absolute top-0 truncate text-left text-2xs text-muted-foreground', block.untrusted && 'font-mono')}
                  style={{ left: i * cellW, width: Math.min(xEvery, cols - i) * cellW }}
                  data-testid="heatmap-x-tick"
                >
                  {x}
                </span>
              ) : null,
            )}
          </div>
          {block.y.values.map((y, r) => (
            <div key={r} className="absolute left-0 flex items-center" style={{ top: HEADER_H + r * CELL_H, height: CELL_H }}>
              <span
                className={cn('truncate pr-2 text-right text-2xs text-foreground', block.untrusted && 'font-mono')}
                style={{ width: labelW }}
              >
                {clipText(y, labelChars)}
              </span>
              {block.x.values.map((_, c) => {
                const v = block.cells[r]?.[c] ?? null;
                const isActive = active && nav.open && active.i === c && active.j === r;
                const step = isNum(v) ? intensityStep(v, max) : 0;
                return (
                  <span
                    key={c}
                    data-state={isNum(v) ? (v === 0 ? 'zero' : 'measured') : 'unmeasured'}
                    className={cn(
                      'flex h-full items-center justify-center border border-background',
                      !isNum(v) && 'border-dashed border-border',
                      isActive && 'outline outline-2 outline-ring',
                      nav.focusRing && active?.i === c && active?.j === r && 'outline outline-2 outline-ring',
                    )}
                    style={{
                      width: cellW,
                      backgroundColor: isNum(v) ? (step > 0 ? sequential(step) : token('muted', 0.4)) : token('muted', 0.2),
                      backgroundImage: isNum(v) ? undefined : hatch,
                    }}
                  >
                    {showValues && isNum(v) ? (
                      <span className="rounded-sm bg-background/85 px-1 text-2xs tabular-nums text-foreground">{formatValue(v, block.unit)}</span>
                    ) : stepDigits && isNum(v) && v > 0 ? (
                      <span className="hidden text-2xs leading-none forced-colors:inline">{intensityLevel(v, max)}</span>
                    ) : null}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </ChartShell>
    </div>
  );
}
