/**
 * Dispatch a `chart` block to its renderer (BLOCKS.md chart table). Heights are FIXED
 * per kind and density so a streamed or restored transcript never jumps; the expanded
 * sheet gets the tall variant.
 *
 * The kind drawn is always the HONEST one (`views.honestChart`): a stack or donut whose
 * values do not add up is drawn as grouped columns / horizontal bars, never with an
 * invented total — this path is also the print/static path, so the guard lives here.
 */

import type { ChartBlock } from '../schema';
import { honestChart } from '../views';
import { CartesianChart } from './CartesianChart';
import { DonutChart } from './DonutChart';
import { FunnelChart } from './FunnelChart';
import { HBarChart } from './HBarChart';
import { SparklineChart } from './SparklineChart';

export interface ChartBlockViewProps {
  block: ChartBlock;
  title: string;
  compact?: boolean;
  expanded?: boolean;
  staticMode?: boolean;
}

export function chartHeight(compact: boolean, expanded: boolean): number {
  if (expanded) return 360;
  return compact ? 168 : 200;
}

export function ChartBlockView({ block: raw, title, compact = false, expanded = false, staticMode = false }: ChartBlockViewProps) {
  const block = honestChart(raw);
  if (!block.x.values.length) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="chart-empty">
        No data points in this window.
      </p>
    );
  }
  switch (block.kind) {
    case 'bar':
    case 'stacked_bar':
    case 'line':
    case 'area':
      return (
        <CartesianChart
          block={block as ChartBlock & { kind: typeof block.kind }}
          title={title}
          height={chartHeight(compact, expanded)}
          staticMode={staticMode}
        />
      );
    case 'hbar':
      return <HBarChart block={block} title={title} staticMode={staticMode} full={expanded} />;
    case 'donut':
      return <DonutChart block={block} title={title} size={expanded ? 220 : compact ? 136 : 160} staticMode={staticMode} />;
    case 'funnel':
      return <FunnelChart block={block} title={title} staticMode={staticMode} />;
    case 'sparkline':
      return <SparklineChart block={block} title={title} staticMode={staticMode} />;
    default:
      return null;
  }
}
