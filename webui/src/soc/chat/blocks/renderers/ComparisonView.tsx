/**
 * A period comparison as a row of tiles (Round 12 SPEC §3.4, SYNTHESIS-chat P0-6): the
 * `kpi_group` view of a `comparison` artifact. Each tile reads, top to bottom:
 *
 *   LABEL
 *   1,284                         ← the subject (latest) period
 *   ▲ +96 (+8.1%)                 ← absolute AND relative change, coloured by whether
 *                                   that direction is good for this metric
 *   vs Sep 2026: 1,188  n < 20    ← the baseline period and value, and a small-sample flag
 *   ▂▃▅▆█                         ← the compared periods, when there are three or more
 *
 * Every number comes from the block: the subject value, and the change the SERVER
 * computed (`delta`, its `vs <period>` label, and the relative change and small-sample
 * flag it wrote into the tile's context). The baseline value is the subject minus the
 * change. A zero baseline reads "new" — never ∞ or NaN — and a change that could not be
 * measured shows the server's own context line instead. Tiles are display only.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { KpiTile, KpiTileGrid, type KpiAccent } from '@/soc/components/KpiTile';
import { SEMANTIC_ICON, token } from '@/soc/components/palette';

import { DASH, MINUS, changeParts, formatValue, unitWord } from '../format';
import type { KpiItem, SemanticKey } from '../schema';
import { TrendColumns, trendSentence } from '../charts/SparklineChart';
import { KPI_HANG } from './KpiGroupView';

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

/** The relative-change token the server wrote into a tile's context ("+8.3%", "0%", "new"). */
const PCT_TOKEN = /^(?:[+-]\d+(?:\.\d+)?%|0%|new)$/;
/** The server's small-sample flag ("n < 20"). */
const SMALL_SAMPLE = /(?:^|·)\s*n\s*<\s*(\d+)\s*(?:·|$)/;

export interface ComparisonFacts {
  /** The baseline period's name ("Sep 2026"), from the change's `vs …` label. */
  period: string | null;
  baseline: number | null;
  /** "+96", "−2.1 pp", "0", "—". */
  abs: string;
  /** "+8.1%", "0%", "new", "—" — the server's figure when it wrote one. */
  pct: string;
  isNew: boolean;
  /** The small-sample threshold the server flagged ("n < 20"), else null. */
  smallSample: number | null;
}

/** What a comparison tile shows, derived only from the item's own fields. */
export function comparisonFacts(item: KpiItem): ComparisonFacts {
  const context = item.context ?? '';
  const parts = context.split(' · ').map((p) => p.trim());
  const serverPct = parts.find((p) => PCT_TOKEN.test(p));
  const small = SMALL_SAMPLE.exec(context);
  const smallSample = small ? Number(small[1]) : null;
  const d = item.delta;
  const period = d ? d.period_label.replace(/^vs\.?\s+/i, '').trim() || null : null;
  if (!d || item.value === null) {
    return { period, baseline: null, abs: DASH, pct: DASH, isNew: false, smallSample };
  }
  const baseline = Math.round((item.value - d.value) * 1e6) / 1e6;
  const change = changeParts(item.value, baseline, item.unit);
  const pct = serverPct ? (serverPct === 'new' ? 'new' : serverPct.replace(/^-/, MINUS)) : change.pct;
  return { period, baseline, abs: change.abs, pct, isNew: pct === 'new', smallSample };
}

function valueNode(item: KpiItem): React.ReactNode {
  if (item.value === null) {
    return (
      <>
        <span aria-hidden>{DASH}</span>
        <span className="sr-only">not measured</span>
      </>
    );
  }
  const word = unitWord(item.unit);
  return (
    <>
      {formatValue(item.value, item.unit)}
      {word ? <span className="sr-only"> {word}</span> : null}
    </>
  );
}

function SmallSampleBadge({ n }: { n: number }) {
  return (
    <span
      className="ml-1.5 inline-flex items-center rounded-sm border border-warning/40 bg-warning/10 px-1 text-2xs font-medium text-warning-text"
      data-testid="comparison-small-sample"
    >
      <span aria-hidden>n &lt; {n}</span>
      <span className="sr-only">, fewer than {n} in a compared period</span>
    </span>
  );
}

/** The server's context line without its small-sample part (that one is a badge). */
function contextWithoutFlag(context: string): string {
  return context
    .split(' · ')
    .filter((p) => !/^n\s*<\s*\d+$/.test(p.trim()))
    .join(' · ');
}

function ComparisonTile({ item, testId, staticMode }: { item: KpiItem; testId: string; staticMode: boolean }) {
  const facts = comparisonFacts(item);
  const accent = item.semantic ? ACCENT[item.semantic] ?? 'primary' : 'primary';
  const icon = item.semantic ? SEMANTIC_ICON[item.semantic] : undefined;
  const trend = item.trend && item.trend.points.length >= 3 ? item.trend : null;
  const measured = item.delta && facts.baseline !== null;
  const change = measured ? `${facts.abs} (${facts.pct})` : '';
  const secondary = measured ? (
    <span className="font-sans font-normal" data-testid="comparison-baseline">
      vs {facts.period ?? 'the previous period'}: {formatValue(facts.baseline, item.unit)}
      {facts.smallSample !== null ? <SmallSampleBadge n={facts.smallSample} /> : null}
    </span>
  ) : item.context ? (
    <span className="font-sans font-normal">
      {contextWithoutFlag(item.context)}
      {facts.smallSample !== null ? <SmallSampleBadge n={facts.smallSample} /> : null}
    </span>
  ) : undefined;
  return (
    <div role="listitem" className="flex min-w-0 flex-col" data-testid={`comparison-${testId}`}>
      <KpiTile
        label={item.label}
        value={valueNode(item)}
        variant="strip"
        density="compact"
        accent={accent}
        icon={icon}
        secondary={secondary}
        delta={measured && item.delta ? { value: item.delta.value, label: change } : undefined}
        goodDirection={item.delta?.good_direction ?? 'none'}
        testId={testId}
        className={staticMode ? '[&_div:has(>[role=img])]:flex-col [&_div:has(>[role=img])]:items-start' : undefined}
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

export interface ComparisonTilesProps {
  items: KpiItem[];
  idPrefix: string;
  staticMode?: boolean;
  /**
   * The same host-frame rule as `KpiGroupView.framed`. Default `false`: inside a framed
   * host (a top-level block card, 0.75rem side padding) the grid draws only its inner
   * hairlines and hangs by the tiles' own `px-3` (`KPI_HANG`), so tile text, the trend
   * row and the small-sample note all start on the card's content edge, with the title
   * and the prose. `true` when nothing frames it (a report leaf, the expanded sheet, a
   * report panel item): its own closed frame, no hang.
   */
  framed?: boolean;
  className?: string;
}

export function ComparisonTiles({ items, idPrefix, staticMode = false, framed = false, className }: ComparisonTilesProps) {
  const small = items.map((it) => comparisonFacts(it).smallSample).find((n): n is number => n !== null);
  return (
    <div className={cn('min-w-0', className)} data-testid="block-comparison">
      <KpiTileGrid count={items.length} framed={framed} containerClassName={framed ? undefined : KPI_HANG} role="list">
        {items.map((item, i) => (
          <ComparisonTile key={`${item.key}-${i}`} item={item} testId={`${idPrefix}-${i}`} staticMode={staticMode} />
        ))}
      </KpiTileGrid>
      {small !== undefined ? (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="comparison-small-sample-note">
          n &lt; {small}: fewer than {small} in a compared period, so the change can swing widely. Read it with care.
        </p>
      ) : null}
    </div>
  );
}
