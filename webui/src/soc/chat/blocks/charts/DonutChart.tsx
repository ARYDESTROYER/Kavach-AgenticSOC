/**
 * Donut (BLOCKS.md `donut`): ≤ 6 segments of ONE series (part-to-whole). Gaps come from
 * pad-angle geometry, never a stroke in a guessed surface colour (the transcript sits on
 * `--background`, not `--card`). The centre shows the total only when every part was
 * measured; the legend beside it is ALWAYS present and is the direct label — value plus a
 * reconciling share (largest remainder, summing to exactly 100 %), or "—" for a part that
 * was not measured (G3). ←/→ walk the segments.
 */
import * as React from 'react';

import { token } from '@/soc/components/palette';

import { DASH, formatValue, unitLabel } from '../format';
import type { ChartBlock } from '../schema';
import { MARK_FORCED, ChartShell } from './ChartShell';
import type { AnchorRect } from './ChartTooltipPortal';
import { TooltipBody } from './ChartTooltipPortal';
import { srValue } from './DataTableFallback';
import { donutArcs, reconcilingShares } from './geometry';
import { Legend } from './Legend';
import { categoryStyles } from './series';
import { useChartNavigator, type ChartCursor } from './useChartNavigator';

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export interface DonutChartProps {
  block: ChartBlock;
  title: string;
  size?: number;
  staticMode?: boolean;
}

export function DonutChart({ block, title, size = 160, staticMode = false }: DonutChartProps) {
  const values = React.useMemo(() => block.series[0]?.values ?? [], [block]);
  const labels = block.x.values;
  const n = labels.length;
  const unit = block.unit;
  const styles = React.useMemo(() => categoryStyles(block, true) ?? [], [block]);
  const measured = values.every(isNum);
  const total = measured ? (values as number[]).reduce((a, b) => a + Math.max(0, b), 0) : null;
  const shares = total !== null ? reconcilingShares(values as number[], total) : null;
  const outer = size / 2 - 2;
  const inner = Math.round(outer * 0.62);
  const c = size / 2;
  const arcs = React.useMemo(() => donutArcs(values, c, c, outer, inner), [values, c, outer, inner]);
  const shareText = (i: number) => (shares ? `${shares[i]}%` : DASH);

  const summarize = React.useCallback(
    (cur: ChartCursor) => {
      const v = values[cur.i] ?? null;
      return `${labels[cur.i]}: ${srValue(formatValue(v, unit), v)}${isNum(v) && shares ? `, ${shares[cur.i]}% of the total` : ''}.`;
    },
    [labels, shares, unit, values],
  );
  const nav = useChartNavigator({ count: n, orientation: 'horizontal', summarize, initial: { i: 0, j: -1 }, disabled: staticMode });
  const active = nav.cursor;
  const anchorFor = React.useCallback(
    (plot: DOMRect): AnchorRect | null => (active ? { left: plot.left, right: plot.left + size, top: plot.top, bottom: plot.top + size } : null),
    [active, size],
  );

  const tooltip = active ? (
    <TooltipBody
      heading={<span className={block.untrusted ? 'font-mono' : undefined}>{labels[active.i]}</span>}
      rows={[
        {
          key: 'v',
          color: styles[active.i]?.color,
          value: formatValue(values[active.i] ?? null, unit),
          label: isNum(values[active.i]) ? block.series[0].label : 'not measured',
        },
        { key: 's', value: shareText(active.i), label: 'of the total' },
      ]}
    />
  ) : null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
      <div className="shrink-0" style={{ width: size }}>
        <ChartShell
          nav={nav}
          ariaLabel={`${title}. Donut of ${n} parts, ${unitLabel(unit)}.`}
          instructions="Use the left and right arrow keys to read each part; Home and End jump to the first and last. A data table follows the chart."
          height={size}
          tooltip={tooltip}
          anchorFor={anchorFor}
          anchorKey={active ? String(active.i) : ''}
          staticMode={staticMode}
          testId="chart-donut"
          fallback={{
            caption: `${title} (${unitLabel(unit)})`,
            rowHeader: block.x.label ?? 'Part',
            columns: [block.series[0]?.label ?? 'Value', 'Share'],
            rows: labels.map((l, i) => ({
              key: String(i),
              header: l,
              cells: [srValue(formatValue(values[i] ?? null, unit), values[i] ?? null), shares ? `${shares[i]}%` : 'not computed'],
            })),
          }}
        >
          <svg width={size} height={size} className="block" aria-hidden>
            {arcs.map((a) => (
              <path
                key={a.index}
                d={a.path}
                fill={styles[a.index]?.color ?? token('chart-1')}
                fillRule="evenodd"
                opacity={active && nav.open && active.i !== a.index ? 0.45 : 1}
                onMouseEnter={() => nav.hover({ i: a.index, j: -1 })}
                onMouseLeave={() => nav.hover(null)}
                data-index={a.index}
                className={MARK_FORCED}
              />
            ))}
            {arcs.length === 0 ? (
              <circle cx={c} cy={c} r={(outer + inner) / 2} fill="none" stroke={token('border')} strokeWidth={outer - inner} />
            ) : null}
            {nav.focusRing && active ? (
              <circle cx={c} cy={c} r={outer + 1} fill="none" stroke={token('ring')} strokeWidth={2} data-testid="chart-focus-ring" />
            ) : null}
            <text x={c} y={c - 4} textAnchor="middle" className="text-sm font-semibold tabular-nums" style={{ fill: token('foreground') }}>
              {total !== null ? formatValue(total, unit) : DASH}
            </text>
            <text x={c} y={c + 12} textAnchor="middle" className="text-2xs" style={{ fill: token('muted-foreground') }}>
              {total !== null ? 'total' : 'not all measured'}
            </text>
          </svg>
        </ChartShell>
      </div>
      <Legend
        items={styles}
        shape="rect"
        untrusted={block.untrusted}
        values={labels.map((_, i) => `${formatValue(values[i] ?? null, unit)} · ${shareText(i)}`)}
        className="min-w-0 flex-1 flex-col items-start"
        ariaLabel="Parts"
      />
    </div>
  );
}
