/**
 * `kpi_group` block (BLOCKS.md `kpi_group`, amendment 2): a row of compact strip tiles
 * (`KpiTile variant="strip" density="compact"`) in the shared `KpiTileGrid`.
 *
 * Round 12 (diagnosis/layout.md (c), screenshot 4):
 * - The columns FOLLOW THE ITEM COUNT (`kpiGridColumns`): three figures make three equal
 *   columns that fill the card, six make six from ~60rem, and a narrow container steps
 *   down to a balanced count. No empty track is ever drawn.
 * - Inside a framed host (a block card, an entity's own frame: 0.75rem padding each) the
 *   grid draws only its inner hairlines (`framed={false}`, no card-border-plus-grid-border
 *   double frame) and HANGS by the tiles' own padding (`-mx-3` = KpiTile's `px-3`), so
 *   every label and numeral starts on the host's content edge, the same edge as the card
 *   title and the prose above it; the frame's clip still hides the outermost rules. A
 *   group with no frame around it (a report leaf, the expanded sheet, a report panel
 *   item) passes `framed`, keeps its own closed frame and does not hang.
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
 * - `display: gauge` draws a 0-100 index as a 56 by 28 px arc (decorative) BESIDE its
 *   numeral, with the band word stacked over "/100" in the numeral's line, so the tile
 *   has exactly the lines of the figures beside it (label, figure, context) and is no
 *   taller at any width (Round 13, SPEC-chat T19). Stacked, the band word costs no width
 *   of its own: on a phone a 169 px tile could hold neither "High · 20 active cases now"
 *   on one context line nor "48/100 High" on one figure line. On the narrowest tile with
 *   the widest figure ("100" and "Critical") the decorative arc yields the few pixels
 *   needed rather than push the figure onto a second line. The shared `RiskGauge` is not
 *   used here: at 56 px its in-bowl value overlay sits under the arc. A missing gauge
 *   value is a dash, never an empty arc that would read as zero.
 * - A tile's context reads in plain words: the engine's "not windowed" (a figure that is
 *   a count of right now, not of the chosen window) reads "Right now" (`kpiContext`).
 * - A trend is decorative columns; first, peak and latest are in sr-only text.
 * - A tile with a validated `ref` is a keyboard button that navigates; there is no hover
 *   card in the transcript.
 * - A delta reads in the change's own terms: percentage points for a rate, plain points
 *   for a score (`formatDelta`). The chip holds only the signed figure, on one line; the
 *   comparison ("vs previous 90 days") is plain muted words beside it that drop under
 *   the numeral and wrap between words on a narrow tile (`kpiDelta`).
 * - The strip is a list of tiles (one item per figure). BLOCKS.md asks for a `<dl>`, but
 *   `KpiTile` owns its label/value markup and has no `dt`/`dd` mode; a list keeps the
 *   grouping and count without reading every label twice.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { KpiTile, KpiTileGrid, type KpiAccent, type KpiDelta } from '@/soc/components/KpiTile';
import { SEMANTIC_ICON, scoreBand, token, type ScoreBand } from '@/soc/components/palette';

import { useBlocks } from '../context';
import { kpiContext } from '../labels';
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

/** The gauge's width in a KPI row: as tall as the figures beside it (T19). */
export const KPI_GAUGE_SIZE = 56;
/** The arc's stroke at that size. */
const KPI_GAUGE_STROKE = 6;

/** The band words and their AA text colours (the shared ladder, `scoreBand`, as RiskGauge). */
const BAND_WORD: Record<ScoreBand, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const BAND_TEXT: Record<ScoreBand, string> = {
  critical: 'text-critical-text',
  high: 'text-high-text',
  medium: 'text-medium-text',
  low: 'text-low-text',
};
/** The arc's fill colours (`stroke="currentColor"`), literals for Tailwind. */
const BAND_ARC: Record<ScoreBand, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
};

/**
 * The 56 px half-circle of a 0-100 index: a muted track and the band-coloured share,
 * decorative (the numeral and the band word beside it carry the meaning). Butt caps end
 * the arc on its baseline, so it is exactly half its width tall (28 px) and sits in the
 * numeral's line without making the tile taller than the figures beside it. It is the
 * one part of the row that may give way: on a tile too narrow for the whole figure it
 * narrows (`min-w-0`, scaled from its bottom-left corner so it stays on the baseline)
 * instead of the figure wrapping onto a line of its own.
 */
function KpiArc({ score }: { score: number }) {
  const w = KPI_GAUGE_SIZE;
  const r = (w - KPI_GAUGE_STROKE) / 2;
  const h = w / 2;
  const d = `M ${KPI_GAUGE_STROKE / 2} ${h} A ${r} ${r} 0 0 1 ${w - KPI_GAUGE_STROKE / 2} ${h}`;
  const band = scoreBand(score);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMinYMax meet"
      className="min-w-0 shrink"
      aria-hidden
      focusable="false"
      data-testid="kpi-gauge-arc"
    >
      <path d={d} fill="none" className="stroke-muted" strokeWidth={KPI_GAUGE_STROKE} strokeLinecap="butt" />
      {score > 0 ? (
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={KPI_GAUGE_STROKE}
          strokeLinecap="butt"
          pathLength={100}
          strokeDasharray={`${score} 100`}
          className={BAND_ARC[band]}
        />
      ) : null}
    </svg>
  );
}

// The tile's context words live with the block vocabulary (exports say them too).
export { kpiContext } from '../labels';

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

/**
 * A KPI's change as the tile shows it: the signed figure in the chip ("+87", or "no
 * change" for a zero, which has no direction), and the comparison ("vs previous 90
 * days") as the chip's `period`, plain words beside it. Kept apart so the chip never
 * wraps; the words are the same ones the report export writes (export/walker.ts).
 */
export function kpiDelta(item: KpiItem): KpiDelta | undefined {
  const d = item.delta;
  if (!d) return undefined;
  const period = d.period_label.trim() || undefined;
  // A zero change has no direction: say so in words (no "0" with an arrow).
  if (d.value === 0) return { value: 0, label: 'no change', period };
  const sign = d.value > 0 ? '+' : d.value < 0 ? '−' : '';
  return { value: d.value, label: `${sign}${formatDelta(Math.abs(d.value), item.unit)}`, period };
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
    const score = Math.max(0, Math.min(100, Math.round(item.value)));
    const band = scoreBand(score);
    // The tile keeps its neighbours' lines (T19): label, the figure, and the context when
    // there is one, worded and styled as a figure's caption. The band word never takes a
    // line or a width of its own: it is stacked over "/100" beside the numeral.
    return (
      <div role="listitem" className="flex min-w-0 flex-col px-3 py-2" data-testid={`kpi-${testId}`}>
        {/* Wrap, never truncate: a cut label or caption hides what the figure means. */}
        <span className="break-words text-2xs font-semibold uppercase tracking-wide text-muted-foreground proportional-nums">{item.label}</span>
        {/* The figure as text beside a decorative arc: never drawn under the arc. One line
            (no wrap): only the arc may narrow. 2 px less above than a figure, so the 28 px
            arc keeps the 26 px numeral line's height. */}
        <div className="mt-0.5 flex min-w-0 items-end gap-x-2" data-testid="kpi-gauge-row">
          <KpiArc score={score} />
          {/* Read as "48 of 100 High". The stack is an inline block, whose baseline is its
              LAST line's: "/100" sits on the numeral's baseline and the band word above it,
              inside the arc's 28 px. */}
          <span className="shrink-0 whitespace-nowrap text-2xl font-semibold tabular-nums text-foreground" data-testid="kpi-gauge-value">
            <span className={BAND_TEXT[band]}>{score}</span>
            <span className="sr-only"> of 100 </span>
            <span className="ml-1 inline-block text-xs leading-none" data-testid="kpi-gauge-unit">
              <span className={cn('block font-semibold', BAND_TEXT[band])} data-testid="kpi-gauge-band-word">
                {BAND_WORD[band]}
              </span>
              <span className="block font-medium text-muted-foreground" aria-hidden>
                /100
              </span>
            </span>
          </span>
        </div>
        {item.context ? (
          <span className="mt-1 block min-w-0 break-words text-xs text-muted-foreground" data-testid="kpi-gauge-context">
            {kpiContext(item.context)}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    // Proportional numerals for what the tile inherits: its label is prose, set like the
    // gauge label beside it (tabular figures set its hyphens wide, "FALSE-POSITIVE RATE").
    // The numeral, the delta chip and the caption set their own tabular figures in
    // `KpiTile`, which the Overview shares and which is not changed here.
    <div role="listitem" className="flex min-w-0 flex-col proportional-nums">
      <KpiTile
        label={item.label}
        value={valueNode(item)}
        variant="strip"
        density="compact"
        accent={accent}
        icon={icon}
        // The caption ("Right now", "of 1 queried") is prose: the sans muted caption
        // style (browser-QA D7), on its own wrapping line under the numeral.
        secondary={item.context ? <span className="font-sans font-normal">{kpiContext(item.context)}</span> : undefined}
        delta={kpiDelta(item)}
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

/**
 * The unframed grid's hang: out by the tiles' side padding (KpiTile `strip`/`compact`
 * `px-3`, the gauge cell's `px-3`), so tile text sits on the host's content edge.
 */
export const KPI_HANG = '-mx-3';

export interface KpiGroupViewProps {
  items: KpiItem[];
  idPrefix: string;
  /** Print / static export: delta chips on their own line, no tile buttons. */
  staticMode?: boolean;
  /**
   * Draw the grid's own closed frame. Default `false`, for a group inside a framed host
   * with 0.75rem side padding (a top-level block card, an entity's own frame): the host's
   * border is the frame and the grid hangs into that padding (see the module note). The
   * host passes `true` when nothing frames the group (a report leaf, the expanded sheet,
   * a report panel item), so a bare group still reads as one closed box.
   */
  framed?: boolean;
  className?: string;
}

export function KpiGroupView({ items, idPrefix, staticMode = false, framed = false, className }: KpiGroupViewProps) {
  return (
    <div className={cn('min-w-0', className)} data-testid="block-kpis" data-static={staticMode || undefined}>
      <KpiTileGrid count={items.length} framed={framed} containerClassName={framed ? undefined : KPI_HANG} role="list">
        {items.map((item, i) => (
          <KpiItemCell key={`${item.key}-${i}`} item={item} testId={`${idPrefix}-${i}`} staticMode={staticMode} />
        ))}
      </KpiTileGrid>
    </div>
  );
}
