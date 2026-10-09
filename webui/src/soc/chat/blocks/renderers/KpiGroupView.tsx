/**
 * `kpi_group` block (BLOCKS.md `kpi_group`, amendment 2): a row of compact strip tiles
 * (`KpiTile variant="strip" density="compact"`) in a hairline grid that reflows by
 * CONTAINER width — 2 columns in a Case Manager embed, 3 at ~40rem, 6 at ~60rem.
 *
 * - The value is passed PRE-FORMATTED (no `countTo`), so a restored transcript never
 *   replays a count-up animation, and `null` is an em dash (G3).
 * - A lower bound shows the console's `≥` mark and says "at least" to assistive tech
 *   (G4); the unit is spelled out in sr-only text.
 * - `display: gauge` draws a 0-100 index as `RiskGauge` with its band word; a missing
 *   gauge value is a dash, never an empty arc that would read as zero.
 * - A trend is decorative columns; first, peak and latest are in sr-only text.
 * - A tile with a validated `ref` is a keyboard button that navigates; there is no hover
 *   card in the transcript.
 * - A delta reads in the change's own terms: percentage points for a rate, plain points
 *   for a score (`formatDelta`).
 * - The strip is a list of tiles (one item per figure). BLOCKS.md asks for a `<dl>`, but
 *   `KpiTile` owns its label/value markup and has no `dt`/`dd` mode; a list keeps the
 *   grouping and count without reading every label twice.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { SEMANTIC_ICON, token } from '@/soc/components/palette';

import { useBlocks } from '../context';
import { DASH, formatDelta, formatValue, unitWord } from '../format';
import type { KpiItem, SemanticKey } from '../schema';
import { TrendColumns, trendSentence } from '../charts/SparklineChart';

const ACCENT: Partial<Record<SemanticKey, KpiAccent>> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
  true_positive: 'critical',
  suspicious: 'high',
  escalated: 'high',
  resolved: 'success',
  closed: 'success',
};

function valueNode(item: KpiItem): React.ReactNode {
  const text = formatValue(item.value, item.unit);
  const word = unitWord(item.unit);
  if (item.value === null) {
    return (
      <>
        <span aria-hidden>{DASH}</span>
        <span className="sr-only">not measured</span>
      </>
    );
  }
  return (
    <>
      {item.bound === 'lower' ? <span className="sr-only">at least </span> : null}
      {item.bound === 'lower' ? (
        <span aria-hidden className="mr-0.5">
          ≥
        </span>
      ) : null}
      {text}
      {word ? <span className="sr-only"> {word}</span> : null}
    </>
  );
}

function deltaLabel(item: KpiItem): string {
  const d = item.delta;
  if (!d) return '';
  const sign = d.value > 0 ? '+' : d.value < 0 ? '−' : '';
  return `${sign}${formatDelta(Math.abs(d.value), item.unit)} ${d.period_label}`;
}

export function KpiItemCell({ item, testId }: { item: KpiItem; testId: string }) {
  const { navigate } = useBlocks();
  const ref = item.ref;
  const accent = item.semantic ? ACCENT[item.semantic] ?? 'primary' : 'primary';
  const icon = item.semantic ? SEMANTIC_ICON[item.semantic] : undefined;
  const trend = item.trend && item.trend.points.length >= 2 ? item.trend : null;

  if (item.display === 'gauge' && item.value !== null) {
    return (
      <div role="listitem" className="flex min-w-0 flex-col gap-1 px-3 py-2" data-testid={`kpi-${testId}`}>
        <span className="truncate text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</span>
        <RiskGauge score={item.value} size={96} />
        {item.context ? <span className="truncate text-2xs text-muted-foreground">{item.context}</span> : null}
      </div>
    );
  }

  return (
    <div role="listitem" className="flex min-w-0 flex-col">
      <KpiTile
        label={item.label}
        value={valueNode(item)}
        variant="strip"
        density="compact"
        accent={accent}
        icon={icon}
        // The strip renders `secondary` in mono for numeric scale context; a chat
        // caption ("not windowed", "of 1 queried") is prose, so it is the sans muted
        // caption style (browser-QA D7). The shared tile is unchanged.
        secondary={
          item.context ? (
            <span className="font-sans font-normal" title={item.context}>
              {item.context}
            </span>
          ) : undefined
        }
        delta={item.delta ? { value: item.delta.value, label: deltaLabel(item) } : undefined}
        goodDirection={item.delta?.good_direction ?? 'none'}
        onClick={ref ? () => navigate(ref) : undefined}
        testId={testId}
      />
      {trend ? (
        <div className="px-3 pb-2">
          <TrendColumns points={trend.points} color={token(accent === 'primary' ? 'primary' : accent)} className="h-6" />
          <span className="sr-only">{trendSentence(trend.points, item.unit, trend.window_label)}</span>
        </div>
      ) : null}
    </div>
  );
}

export function KpiGroupView({ items, idPrefix, className }: { items: KpiItem[]; idPrefix: string; className?: string }) {
  return (
    <div className={cn('@container min-w-0', className)} data-testid="block-kpis">
      <div
        role="list"
        className={cn(
          'grid overflow-hidden rounded-md border-l border-t border-border/70',
          'grid-cols-2 @[40rem]:grid-cols-3 @[60rem]:grid-cols-6',
          '[&>*]:border-b [&>*]:border-r [&>*]:border-border/70',
        )}
      >
        {items.map((item, i) => (
          <KpiItemCell key={`${item.key}-${i}`} item={item} testId={`${idPrefix}-${i}`} />
        ))}
      </div>
    </div>
  );
}
