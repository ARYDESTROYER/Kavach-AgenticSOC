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
 * measured shows the server's own baseline line in the same "vs <period>: …" words.
 *
 * The small-sample flag qualifies a CHANGE ("fewer than 20 behind either compared
 * value"), so it is drawn only on a tile that shows one; when every change shown is
 * flagged, one note under the row says so instead of a badge on each tile. Tiles are
 * display only.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { KpiTile, KpiTileGrid, keepDatesTogether, type KpiAccent } from '@/soc/components/KpiTile';
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
  /** The tile shows a change (both compared values were measured). */
  measured: boolean;
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
    return { period, baseline: null, abs: DASH, pct: DASH, isNew: false, smallSample, measured: false };
  }
  const baseline = Math.round((item.value - d.value) * 1e6) / 1e6;
  const change = changeParts(item.value, baseline, item.unit);
  const pct = serverPct ? (serverPct === 'new' ? 'new' : serverPct.replace(/^-/, MINUS)) : change.pct;
  return { period, baseline, abs: change.abs, pct, isNew: pct === 'new', smallSample, measured: true };
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

export function SmallSampleBadge({ n }: { n: number }) {
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

/** The server's context line without its small-sample part (that one is a badge or the row note). */
function contextWithoutFlag(context: string): string {
  return context
    .split(' · ')
    .filter((p) => !/^n\s*<\s*\d+$/.test(p.trim()))
    .join(' · ');
}

/**
 * "Sep 2026: 1,188", "Sep 2026 to date: —", "26 Jul 20:45 – 3 Sep 2026 05:30: —": the
 * server's baseline line names its period first (a period name may hold clock times,
 * so the period ends at the first colon followed by a space).
 */
const PERIOD_FIRST = /^[^·]+?:\s/;

/** How a row of comparison tiles discloses small samples (pure; exported for tests). */
export interface SmallSamplePlan {
  /** The threshold of the note under the row, or null for no note. */
  n: number | null;
  /** Every change shown is flagged: the note says so and no tile carries a badge. */
  every: boolean;
}

export function smallSamplePlan(items: readonly KpiItem[]): SmallSamplePlan {
  const facts = items.map(comparisonFacts).filter((f) => f.measured);
  const flagged = facts.filter((f) => f.smallSample !== null);
  if (!flagged.length) return { n: null, every: false };
  return { n: flagged[0].smallSample, every: flagged.length === facts.length && facts.length >= 2 };
}

/**
 * The line under a comparison tile's figure: the baseline period and its value
 * ("vs Sep 2026: 1,188"), with the small-sample badge when the tile's change is flagged
 * and `badge` allows it. A change that could not be measured reads the server's own
 * baseline line in the same words ("vs Sep 2026 to date: —"), never a badge: there is no
 * change on it to read with care. Shared by the tile row and the infographic hero.
 */
export function comparisonSecondary(item: KpiItem, badge = true): React.ReactNode {
  const facts = comparisonFacts(item);
  if (facts.measured) {
    return (
      <span className="font-sans font-normal" data-testid="comparison-baseline">
        vs {keepDatesTogether(facts.period ?? 'the previous period')}: {formatValue(facts.baseline, item.unit)}
        {badge && facts.smallSample !== null ? <SmallSampleBadge n={facts.smallSample} /> : null}
      </span>
    );
  }
  const line = item.context ? contextWithoutFlag(item.context) : '';
  if (!line) return undefined;
  return (
    <span className="font-sans font-normal" data-testid="comparison-baseline">
      {keepDatesTogether(PERIOD_FIRST.test(line) ? `vs ${line}` : line)}
    </span>
  );
}

/** The note under a row of comparison figures that carries small-sample changes. */
export function SmallSampleNote({ plan, className }: { plan: SmallSamplePlan; className?: string }) {
  if (plan.n === null) return null;
  return (
    <p className={cn('text-xs text-muted-foreground', className)} data-testid="comparison-small-sample-note">
      {plan.every
        ? `n < ${plan.n} for every change here: fewer than ${plan.n} in a compared period, so each change can swing widely. Read them with care.`
        : `n < ${plan.n}: fewer than ${plan.n} in a compared period, so the change can swing widely. Read it with care.`}
    </p>
  );
}

function ComparisonTile({ item, testId, staticMode, badge }: { item: KpiItem; testId: string; staticMode: boolean; badge: boolean }) {
  const facts = comparisonFacts(item);
  const accent = item.semantic ? ACCENT[item.semantic] ?? 'primary' : 'primary';
  const icon = item.semantic ? SEMANTIC_ICON[item.semantic] : undefined;
  const trend = item.trend && item.trend.points.length >= 3 ? item.trend : null;
  const measured = facts.measured && item.delta;
  const change = measured ? `${facts.abs} (${facts.pct})` : '';
  return (
    <div role="listitem" className="flex min-w-0 flex-col" data-testid={`comparison-${testId}`}>
      <KpiTile
        label={item.label}
        value={valueNode(item)}
        variant="strip"
        density="compact"
        accent={accent}
        icon={icon}
        secondary={comparisonSecondary(item, badge)}
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
  const plan = smallSamplePlan(items);
  return (
    <div className={cn('min-w-0', className)} data-testid="block-comparison">
      <KpiTileGrid count={items.length} framed={framed} containerClassName={framed ? undefined : KPI_HANG} role="list">
        {items.map((item, i) => (
          <ComparisonTile key={`${item.key}-${i}`} item={item} testId={`${idPrefix}-${i}`} staticMode={staticMode} badge={!plan.every} />
        ))}
      </KpiTileGrid>
      <SmallSampleNote plan={plan} className="mt-1.5" />
    </div>
  );
}
