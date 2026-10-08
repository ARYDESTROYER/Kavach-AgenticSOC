/**
 * Sparkline (BLOCKS.md `sparkline`) and the KPI trend columns: `MetricTrendBody`'s
 * column dialect (one 10-unit slot per bucket, a 7-unit column, a 48-unit plot), not a
 * smoothed line. A measured zero is a 1-unit hairline in the series colour, and an
 * unmeasured bucket a muted floor tick, so "nothing happened" never looks like "not
 * measured". The drawing is decorative (`aria-hidden`); first, peak and latest are text,
 * and the full series is in the sr-only table.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { token } from '@/soc/components/palette';

import { formatValue, unitLabel, xLabelFull } from '../format';
import type { ChartBlock, ValueUnit } from '../schema';
import { DataTableFallback, srValue } from './DataTableFallback';
import { seriesStyles } from './series';

const SLOT = 10;
const BAR = 7;
const PLOT_H = 48;

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export interface TrendFacts {
  first: number | null;
  peak: number | null;
  latest: number | null;
  measured: number;
  total: number;
}

export function trendFacts(points: ReadonlyArray<number | null>): TrendFacts {
  const measured = points.filter(isNum);
  return {
    first: measured.length ? measured[0] : null,
    peak: measured.length ? Math.max(...measured) : null,
    latest: measured.length ? measured[measured.length - 1] : null,
    measured: measured.length,
    total: points.length,
  };
}

/** The columns alone (decorative). */
export function TrendColumns({
  points,
  color,
  pointed,
  onPoint,
  className,
}: {
  points: ReadonlyArray<number | null>;
  color: string;
  pointed?: number | null;
  onPoint?: (i: number | null) => void;
  className?: string;
}) {
  const width = Math.max(points.length, 1) * SLOT;
  const peak = Math.max(0, ...points.filter(isNum));
  const scaleMax = peak > 0 ? peak : 1;
  const muted = token('muted-foreground', 0.35);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onPoint) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const i = Math.floor(((e.clientX - r.left) / r.width) * points.length);
    if (Number.isFinite(i)) onPoint(Math.max(0, Math.min(points.length - 1, i)));
  };
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${width} ${PLOT_H}`}
      preserveAspectRatio="none"
      className={cn('block w-full touch-none', className)}
      onPointerMove={onPoint ? onMove : undefined}
      onPointerLeave={onPoint ? () => onPoint(null) : undefined}
      data-testid="trend-columns"
    >
      <rect x={0} y={PLOT_H - 0.5} width={width} height={0.5} fill={muted} />
      {points.map((v, i) => {
        const x = i * SLOT + (SLOT - BAR) / 2;
        if (!isNum(v)) {
          return <rect key={i} data-state="unmeasured" x={x} y={PLOT_H - 2} width={BAR} height={2} fill={muted} />;
        }
        const h = Math.max(1, (Math.max(0, v) / scaleMax) * (PLOT_H - 2));
        return (
          <rect
            key={i}
            data-state={v === 0 ? 'zero' : 'measured'}
            x={x}
            y={PLOT_H - h}
            width={BAR}
            height={h}
            fill={color}
            opacity={pointed == null || pointed === i ? 1 : 0.45}
          />
        );
      })}
    </svg>
  );
}

/** "first 3 · peak 12 · latest 9" — the text twin of a decorative trend. */
export function trendSentence(points: ReadonlyArray<number | null>, unit: ValueUnit, window?: string): string {
  const f = trendFacts(points);
  if (!f.measured) return `No measured values${window ? ` over ${window}` : ''}.`;
  const base = `first ${formatValue(f.first, unit)}, peak ${formatValue(f.peak, unit)}, latest ${formatValue(f.latest, unit)}`;
  const gaps = f.measured < f.total ? `; ${f.measured} of ${f.total} buckets measured` : '';
  return `${window ? `Over ${window}: ` : ''}${base}${gaps}.`;
}

export function SparklineChart({ block, title, staticMode = false }: { block: ChartBlock; title: string; staticMode?: boolean }) {
  const s = block.series[0];
  const values = s?.values ?? [];
  const color = seriesStyles(block)[0]?.color ?? token('primary');
  const [pointed, setPointed] = React.useState<number | null>(null);
  const f = trendFacts(values);
  const shownIndex = pointed ?? (() => {
    for (let i = values.length - 1; i >= 0; i -= 1) if (isNum(values[i])) return i;
    return -1;
  })();
  const shown = shownIndex >= 0 ? values[shownIndex] : null;
  return (
    <div className="min-w-0 max-w-md" data-testid="chart-sparkline">
      <div className="flex items-baseline justify-between gap-3 text-2xs tabular-nums" aria-hidden>
        <span className="min-w-0 truncate text-muted-foreground">
          {shownIndex >= 0 ? xLabelFull(block.x.values[shownIndex] ?? '', block.x.kind, block.x.bucket) : ''}
        </span>
        <span className={cn('shrink-0 font-semibold', isNum(shown) ? 'text-foreground' : 'text-muted-foreground')}>
          {isNum(shown) ? formatValue(shown, block.unit) : 'not measured'}
        </span>
      </div>
      <TrendColumns points={values} color={color} pointed={pointed} onPoint={setPointed} className="mt-1 h-12" />
      <p className="mt-1.5 flex items-center justify-between gap-3 text-2xs tabular-nums text-muted-foreground">
        <span>first {formatValue(f.first, block.unit)}</span>
        <span>peak {formatValue(f.peak, block.unit)}</span>
        <span className="font-medium text-foreground">latest {formatValue(f.latest, block.unit)}</span>
      </p>
      {f.measured < f.total ? (
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {f.measured} of {f.total} buckets measured.
        </p>
      ) : null}
      <DataTableFallback
        caption={`${title} (${unitLabel(block.unit)})`}
        rowHeader={block.x.kind === 'time' ? 'Time (UTC)' : 'Category'}
        columns={[s?.label ?? 'Value']}
        rows={block.x.values.map((x, i) => ({
          key: String(i),
          header: xLabelFull(x, block.x.kind, block.x.bucket),
          cells: [srValue(formatValue(values[i] ?? null, block.unit), values[i] ?? null)],
        }))}
        visible={staticMode}
      />
    </div>
  );
}
