/**
 * `kpi_group` block (BLOCKS.md `kpi_group`, amendment 2): a row of compact strip tiles
 * (`KpiTile variant="strip" density="compact"`) in the shared `KpiTileGrid`.
 *
 * Round 12 (diagnosis/layout.md (c), screenshot 4):
 * - The columns FOLLOW THE ITEM COUNT (`kpiGridColumns`): three figures make three equal
 *   columns that fill the card, six make six from ~60rem, and a narrow container steps
 *   down to a balanced count. No empty track is ever drawn.
 * - The grid sits inside a framed block card, so it draws only its inner hairlines
 *   (`framed={false}`): no card-border-plus-grid-border double frame.
 * - A caption ("in the returned page", "of 22 acknowledged cases") is the tile's
 *   `secondary` line, on its own line UNDER the numeral, wrapping; the numeral and the
 *   caption can never truncate each other ("≥…" / "in the returned …").
 * - Static and print mode: the delta chip always takes its own line under the numeral
 *   (a fixed-width page never squeezes it beside a long value), and no tile is a button.
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
import { KpiTile, KpiTileGrid, type KpiAccent } from '@/soc/components/KpiTile';
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
  // A zero change has no direction: say so in words (no "0" with an arrow).
  if (d.value === 0) return `no change ${d.period_label}`.trim();
  const sign = d.value > 0 ? '+' : d.value < 0 ? '−' : '';
  return `${sign}${formatDelta(Math.abs(d.value), item.unit)} ${d.period_label}`;
}

/**
 * Static / print: the numeral row (the row that holds the delta chip, `role="img"`) is a
 * column, so the chip sits on its own line. Selected by what it contains rather than by
 * its position, so KpiTile's markup order is free to change. Literal for Tailwind.
 */
const STATIC_DELTA_OWN_LINE = '[&_div:has(>[role=img])]:flex-col [&_div:has(>[role=img])]:items-start';

export function KpiItemCell({ item, testId, staticMode = false }: { item: KpiItem; testId: string; staticMode?: boolean }) {
  const { navigate } = useBlocks();
  const ref = item.ref;
  const accent = item.semantic ? ACCENT[item.semantic] ?? 'primary' : 'primary';
  const icon = item.semantic ? SEMANTIC_ICON[item.semantic] : undefined;
  const trend = item.trend && item.trend.points.length >= 2 ? item.trend : null;

  if (item.display === 'gauge' && item.value !== null) {
    return (
      <div role="listitem" className="flex min-w-0 flex-col gap-1 px-3 py-2" data-testid={`kpi-${testId}`}>
        {/* Wrap, never truncate: a cut label or caption hides what the figure means. */}
        <span className="break-words text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</span>
        <RiskGauge score={item.value} size={96} />
        {item.context ? <span className="break-words text-xs text-muted-foreground">{item.context}</span> : null}
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
        // The caption ("not windowed", "of 1 queried") is prose: the sans muted caption
        // style (browser-QA D7), on its own wrapping line under the numeral.
        secondary={item.context ? <span className="font-sans font-normal">{item.context}</span> : undefined}
        delta={item.delta ? { value: item.delta.value, label: deltaLabel(item) } : undefined}
        goodDirection={item.delta?.good_direction ?? 'none'}
        // Paper has nothing to press: a static tile is never a button.
        onClick={ref && !staticMode ? () => navigate(ref) : undefined}
        testId={testId}
        className={staticMode ? STATIC_DELTA_OWN_LINE : undefined}
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

export interface KpiGroupViewProps {
  items: KpiItem[];
  idPrefix: string;
  /** Print / static export: delta chips on their own line, no tile buttons. */
  staticMode?: boolean;
  /**
   * Draw the grid's own closed frame. Default `false`: a `kpi_group` always renders
   * inside a framed block card (or an entity card), whose border is the frame.
   */
  framed?: boolean;
  className?: string;
}

export function KpiGroupView({ items, idPrefix, staticMode = false, framed = false, className }: KpiGroupViewProps) {
  return (
    <div className={cn('min-w-0', className)} data-testid="block-kpis" data-static={staticMode || undefined}>
      <KpiTileGrid count={items.length} framed={framed} role="list">
        {items.map((item, i) => (
          <KpiItemCell key={`${item.key}-${i}`} item={item} testId={`${idPrefix}-${i}`} staticMode={staticMode} />
        ))}
      </KpiTileGrid>
    </div>
  );
}
