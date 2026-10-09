/**
 * Funnel (BLOCKS.md amendment 2): one series whose categories are the stages IN ORDER.
 * Each stage is a horizontal bar scaled to the largest stage, with its value at the tip;
 * between stages a step-down line reads "42% kept · −58%" (this stage ÷ the previous
 * one). A `null` stage is hatched and both steps around it read "—": a conversion
 * cannot be computed from a stage that was not measured (G3).
 */
import * as React from 'react';

import { token } from '@/soc/components/palette';

import { clipText, DASH, formatValue, unitLabel } from '../format';
import type { ChartBlock } from '../schema';
import { HatchPattern, MARK_FORCED, ChartShell, useSvgId } from './ChartShell';
import type { AnchorRect } from './ChartTooltipPortal';
import { TooltipBody } from './ChartTooltipPortal';
import { srValue } from './DataTableFallback';
import { CHAR_W, roundedRightPath } from './geometry';
import { seriesStyles } from './series';
import { useChartNavigator, type ChartCursor } from './useChartNavigator';
import { useChartSize } from './useChartSize';

const STAGE_H = 22;
const STEP_H = 16;
const LABEL_MAX = 160;

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Conversion from the previous stage, as whole percents kept and dropped; null when unknown. */
export function stepDown(prev: number | null | undefined, cur: number | null | undefined): { kept: number; drop: number } | null {
  if (!isNum(prev) || !isNum(cur) || prev <= 0 || cur < 0) return null;
  const kept = (cur / prev) * 100;
  return { kept, drop: kept - 100 };
}

function pct(v: number): string {
  if (v > 0 && v < 1) return '<1%';
  return `${Math.round(v)}%`;
}

export function stepText(step: { kept: number; drop: number } | null): string {
  if (!step) return DASH;
  const drop = Math.round(step.drop);
  return `${pct(step.kept)} kept · ${drop > 0 ? '+' : drop < 0 ? '−' : ''}${Math.abs(drop)}%`;
}

export interface FunnelChartProps {
  block: ChartBlock;
  title: string;
  staticMode?: boolean;
}

export function FunnelChart({ block, title, staticMode = false }: FunnelChartProps) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const width = useChartSize(boxRef, { staticMode });
  const hatchId = useSvgId('hatch');
  const color = seriesStyles(block)[0]?.color ?? token('chart-1');
  const values = React.useMemo(() => block.series[0]?.values ?? [], [block]);
  const stages = block.x.values;
  const n = stages.length;
  const unit = block.unit;
  const max = Math.max(0, ...values.filter(isNum));
  const rowTop = (i: number) => i * (STAGE_H + STEP_H);
  const height = Math.max(STAGE_H, n * STAGE_H + Math.max(0, n - 1) * STEP_H);
  const labelW = Math.min(LABEL_MAX, Math.max(56, Math.round(width * 0.3)));
  const valueW = Math.ceil(Math.max(3, ...values.map((v) => formatValue(v, unit).length)) * CHAR_W) + 8;
  const x0 = labelW + 8;
  const plotW = Math.max(1, width - x0 - valueW);
  const labelChars = Math.max(4, Math.floor(labelW / CHAR_W));

  const summarize = React.useCallback(
    (c: ChartCursor) => {
      const v = values[c.i] ?? null;
      const step = c.i > 0 ? `, ${stepText(stepDown(values[c.i - 1], v))} from the previous stage` : '';
      return `Stage ${c.i + 1}, ${stages[c.i]}: ${srValue(formatValue(v, unit), v)}${step}.`;
    },
    [stages, unit, values],
  );
  const nav = useChartNavigator({ count: n, orientation: 'vertical', summarize, initial: { i: 0, j: -1 }, disabled: staticMode });
  const active = nav.cursor;
  const anchorFor = React.useCallback(
    (plot: DOMRect): AnchorRect | null =>
      active ? { left: plot.left, right: plot.right, top: plot.top + rowTop(active.i), bottom: plot.top + rowTop(active.i) + STAGE_H } : null,
    [active],
  );

  let tooltip: React.ReactNode = null;
  if (active) {
    const v = values[active.i] ?? null;
    const ofFirst = stepDown(values[0] ?? null, v);
    tooltip = (
      <TooltipBody
        heading={<span className={block.untrusted ? 'font-mono' : undefined}>{`Stage ${active.i + 1}: ${stages[active.i]}`}</span>}
        rows={[
          { key: 'v', color, value: formatValue(v, unit), label: isNum(v) ? block.series[0].label : 'not measured' },
          ...(active.i > 0
            ? [{ key: 'step', value: stepText(stepDown(values[active.i - 1], v)), label: 'from the previous stage' }]
            : []),
          ...(active.i > 0 ? [{ key: 'first', value: ofFirst ? pct(ofFirst.kept) : DASH, label: 'of the first stage' }] : []),
        ]}
      />
    );
  }

  return (
    <div ref={boxRef} className="min-w-0">
      <ChartShell
        nav={nav}
        ariaLabel={`${title}. Funnel of ${n} stages, ${unitLabel(unit)}.`}
        instructions="Use the up and down arrow keys to read each stage and its step-down from the previous one; Home and End jump to the first and last. A data table follows the chart."
        height={height}
        onPointerAt={(_x, y) => {
          const i = Math.floor(y / (STAGE_H + STEP_H));
          nav.hover(i >= 0 && i < n && y - rowTop(i) <= STAGE_H ? { i, j: -1 } : null);
        }}
        tooltip={tooltip}
        anchorFor={anchorFor}
        anchorKey={active ? String(active.i) : ''}
        staticMode={staticMode}
        testId="chart-funnel"
        fallback={{
          caption: `${title} (${unitLabel(unit)})`,
          rowHeader: 'Stage',
          columns: [block.series[0]?.label ?? 'Value', 'Step-down from previous stage'],
          rows: stages.map((s, i) => ({
            key: String(i),
            header: `${i + 1}. ${s}`,
            cells: [srValue(formatValue(values[i] ?? null, unit), values[i] ?? null), i === 0 ? '' : stepText(stepDown(values[i - 1], values[i]))],
          })),
        }}
      >
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          <defs>
            <HatchPattern id={hatchId} />
          </defs>
          {stages.map((stage, i) => {
            const v = values[i] ?? null;
            const y = rowTop(i);
            const w = isNum(v) && max > 0 ? Math.max(v > 0 ? 2 : 0, (Math.max(0, v) / max) * plotW) : 0;
            return (
              <g key={i} data-index={i} data-state={isNum(v) ? 'measured' : 'unmeasured'}>
                {nav.open && active?.i === i ? (
                  <rect x={0} y={y} width={width} height={STAGE_H} fill={token('muted-foreground', 0.1)} />
                ) : null}
                <text x={labelW} y={y + STAGE_H / 2} dy="0.32em" textAnchor="end" className={block.untrusted ? 'font-mono text-2xs' : 'text-xs'} style={{ fill: token('foreground') }}>
                  {clipText(stage, labelChars)}
                </text>
                {isNum(v) ? (
                  w > 0 ? <path d={roundedRightPath(x0, y + 3, w, STAGE_H - 6)} fill={color} className={MARK_FORCED} /> : null
                ) : (
                  <rect x={x0} y={y + 3} width={plotW} height={STAGE_H - 6} fill={`url(#${hatchId})`} />
                )}
                <text x={x0 + (isNum(v) ? w : 0) + 4} y={y + STAGE_H / 2} dy="0.32em" className="text-2xs font-medium tabular-nums" style={{ fill: token('foreground') }}>
                  {isNum(v) ? formatValue(v, unit) : 'not measured'}
                </text>
                {i > 0 ? (
                  <text x={x0} y={y - STEP_H / 2} dy="0.32em" className="text-2xs tabular-nums" style={{ fill: token('muted-foreground') }} data-testid="funnel-step">
                    {`↓ ${stepText(stepDown(values[i - 1], v))}`}
                  </text>
                ) : null}
                {nav.focusRing && active?.i === i ? (
                  <rect x={1} y={y + 1} width={width - 2} height={STAGE_H - 2} rx={2} fill="none" stroke={token('ring')} strokeWidth={2} data-testid="chart-focus-ring" />
                ) : null}
              </g>
            );
          })}
        </svg>
      </ChartShell>
    </div>
  );
}
