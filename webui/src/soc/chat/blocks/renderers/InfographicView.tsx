/**
 * The Brief's `infographic` layout (Round 12 SPEC §3.4, SYNTHESIS-chat P0-8): the same
 * sections and leaves as the document layout, arranged to be read at a glance —
 *
 *   1. a HERO row: the Brief's first KPI group that carries trends (else its first KPI
 *      group) as large numerals, each with its trend columns when it carries one (and
 *      its change, when it compares periods). The hero keeps every disclosure the same
 *      group has as a card: its caption and "as of", "Showing N of M", "Downsampled for
 *      saved history", the baseline of a comparison and its small-sample note (G4);
 *   2. HIGHLIGHTS: the Brief's callouts as a row of short, tone-marked notes;
 *   3. the sections, their charts and KPI groups two to a row, while tables, lists,
 *      timelines and prose take the whole width (an odd chart out also spans the row, so
 *      no grid track is ever left empty).
 *
 * Nothing is dropped or invented: every leaf of every section is drawn exactly once,
 * through the same leaf renderer as the document layout. The grid follows the CARD's
 * width (a container query), so it is two-up in a wide lane and one column in a narrow
 * one. Print / static mode keeps the hero row and the highlights but stacks the charts
 * one per row: a printed chart is drawn at the fixed page width with its data table
 * under it, which two columns of an A4 page cannot hold (so no leaf spans columns there
 * either: a span would create the second column again).
 *
 * A section whose first card is titled like the section ("Response times" over a card
 * titled "Response times") does not say it twice in a row: the card's title stays and
 * takes the heading's place, and the section heading is kept for assistive tech and the
 * section anchor only. A section summary between the two keeps the heading visible, and
 * so does a leaf that carries the title without drawing it (prose renders text only).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { KpiTile, KpiTileGrid, type KpiDelta } from '@/soc/components/KpiTile';
import { token } from '@/soc/components/palette';

import { sectionAnchorId, useBlocks } from '../context';
import { DASH, captionStatesCount, formatUtc, formatValue, truncationNote } from '../format';
import type { KpiGroupBlock, KpiItem, LeafBlock, ReportBlock } from '../schema';
import { TrendColumns, trendSentence } from '../charts/SparklineChart';
import { SmallSampleNote, comparisonFacts, comparisonSecondary, smallSamplePlan } from './ComparisonView';
import { kpiDelta } from './KpiGroupView';
import { headingRepeatsLeaf } from '../report-headings';

/** Leaves that take the whole row of the 2-up grid (reading width or many columns). */
const WIDE_TYPES: ReadonlyArray<LeafBlock['type']> = [
  'markdown',
  'table',
  'case_list',
  'timeline',
  'entity',
  'heatmap',
  'citations',
  'guide',
  'query',
  'mitre',
];

/**
 * Highlight columns that follow the COUNT (like `kpiGridColumns`): three notes make three
 * columns once each can hold a short sentence, never two plus an orphan with an empty
 * track beside it. Literal class strings, so Tailwind's compiler sees every one.
 */
export function highlightColumns(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-1 @[32rem]:grid-cols-2';
  if (count === 3) return 'grid-cols-1 @[48rem]:grid-cols-3';
  if (count === 4) return 'grid-cols-1 @[32rem]:grid-cols-2 @[64rem]:grid-cols-4';
  return 'grid-cols-1 @[32rem]:grid-cols-2 @[48rem]:grid-cols-3';
}

export function isWideLeaf(leaf: LeafBlock): boolean {
  return WIDE_TYPES.includes(leaf.type);
}

export interface InfographicParts {
  /**
   * Section and leaf index of the hero KPI group, or null: the first KPI group whose
   * items carry trend points (the hero's sparklines), else the first KPI group.
   */
  hero: { section: number; leaf: number; block: KpiGroupBlock } | null;
  /** Section and leaf indexes of the highlight callouts, in document order. */
  highlights: Array<{ section: number; leaf: number; block: LeafBlock }>;
}

/** Where the hero row and the highlights come from (pure; exported for tests). */
export function infographicParts(block: ReportBlock): InfographicParts {
  const groups: Array<NonNullable<InfographicParts['hero']>> = [];
  const highlights: InfographicParts['highlights'] = [];
  block.sections.forEach((s, si) =>
    s.blocks.forEach((leaf, li) => {
      if (leaf.type === 'kpi_group') groups.push({ section: si, leaf: li, block: leaf });
      else if (leaf.type === 'callout' && !leaf.expired) highlights.push({ section: si, leaf: li, block: leaf });
    }),
  );
  const hero = groups.find((g) => g.block.items.some((it) => (it.trend?.points.length ?? 0) >= 2)) ?? groups[0] ?? null;
  return { hero, highlights };
}

// The heading rule is shared with the document layout and every export (pure module).
export { headingRepeatsLeaf, leafVisibleTitle } from '../report-headings';

/**
 * The disclosures the hero's KPI group carries as a card (BlockCard): its caption and
 * "as of" line, and its truncation / storage note. Pure; exported for tests.
 */
export function heroDisclosures(group: KpiGroupBlock): { caption: string | null; note: string | null } {
  const caption = [group.caption, group.as_of ? `as of ${formatUtc(group.as_of)}` : null].filter(Boolean).join(' · ') || null;
  const shown = group.items.length;
  const trunc = group.truncated && !captionStatesCount(group.caption, shown, group.total) ? truncationNote(shown, group.total) : null;
  const note = [trunc, group.downsampled_for_storage ? 'Downsampled for saved history' : null].filter(Boolean).join(' · ') || null;
  return { caption, note };
}

/**
 * Lay a section's leaves into 2-up rows: wide leaves span the row; in each run of
 * half-width leaves, an odd last one spans the row too. Returns, per leaf, whether it
 * spans both columns.
 */
export function spanPlan(leaves: readonly LeafBlock[]): boolean[] {
  const out = leaves.map(isWideLeaf);
  let run: number[] = [];
  const flush = () => {
    if (run.length % 2 === 1) out[run[run.length - 1]] = true;
    run = [];
  };
  leaves.forEach((_, i) => {
    if (out[i]) flush();
    else run.push(i);
  });
  flush();
  return out;
}

function heroDelta(group: KpiGroupBlock, item: KpiItem): KpiDelta | undefined {
  const d = item.delta;
  if (!d) return undefined;
  if (group.artifact_kind === 'comparison') {
    // The baseline period and value read under the figure (comparisonSecondary), as on a tile.
    const f = comparisonFacts(item);
    if (f.measured) return { value: d.value, label: `${f.abs} (${f.pct})` };
  }
  // The signed figure in the chip, the comparison as words beside it (as on a KPI tile).
  return kpiDelta(item);
}

function HeroRow({ group, idPrefix, staticMode }: { group: KpiGroupBlock; idPrefix: string; staticMode: boolean }) {
  const comparison = group.artifact_kind === 'comparison';
  const plan = comparison ? smallSamplePlan(group.items) : null;
  const { caption, note } = heroDisclosures(group);
  return (
    <div className="min-w-0" data-testid="infographic-hero">
      {group.title || caption ? (
        <div className="mb-1.5 min-w-0">
          {group.title ? <p className="text-xs font-medium text-muted-foreground">{group.title}</p> : null}
          {caption ? (
            <p className="break-words text-xs text-muted-foreground" data-testid="infographic-hero-caption">
              {caption}
            </p>
          ) : null}
        </div>
      ) : null}
      {group.provenance === 'ai' ? (
        <p className="mb-1.5 text-xs italic text-muted-foreground">Values stated by the model, not measured</p>
      ) : null}
      <KpiTileGrid count={group.items.length} framed role="list">
        {group.items.map((item, i) => {
          const trend = item.trend && item.trend.points.length >= 2 ? item.trend : null;
          const delta = heroDelta(group, item);
          return (
            <div key={`${item.key}-${i}`} role="listitem" className="flex min-w-0 flex-col">
              <KpiTile
                label={item.label}
                value={
                  item.value === null ? (
                    <>
                      <span aria-hidden>{DASH}</span>
                      <span className="sr-only">not measured</span>
                    </>
                  ) : item.bound === 'lower' ? (
                    // A scan-bounded floor says "at least" to assistive tech, like the KPI tiles (G4).
                    <>
                      <span className="sr-only">at least </span>
                      <span aria-hidden>≥</span>
                      {formatValue(item.value, item.unit)}
                    </>
                  ) : (
                    formatValue(item.value, item.unit)
                  )
                }
                variant="strip"
                density="comfortable"
                size="fluid"
                roll={false}
                secondary={
                  comparison ? (
                    // The baseline ("vs Sep 2026: 16.3%") and, on a flagged change, its
                    // small-sample badge — exactly as the comparison tiles read.
                    comparisonSecondary(item, !plan?.every) ?? (item.value === null ? <span className="font-sans font-normal">Not measured</span> : undefined)
                  ) : item.value === null ? (
                    <span className="font-sans font-normal">Not measured</span>
                  ) : item.context ? (
                    <span className="font-sans font-normal">{item.context}</span>
                  ) : undefined
                }
                delta={delta}
                goodDirection={item.delta?.good_direction ?? 'none'}
                testId={`${idPrefix}-hero-${i}`}
                className={staticMode ? '[&_div:has(>[role=img])]:flex-col [&_div:has(>[role=img])]:items-start' : undefined}
              />
              {trend ? (
                <div className="px-4 pb-3">
                  <TrendColumns points={trend.points} color={token('primary')} className="h-8" />
                  <span className="sr-only">{trendSentence(trend.points, item.unit, trend.window_label)}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </KpiTileGrid>
      {note ? (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="infographic-hero-note">
          {note}
        </p>
      ) : null}
      {plan ? <SmallSampleNote plan={plan} className="mt-1.5" /> : null}
    </div>
  );
}

export interface InfographicViewProps {
  block: ReportBlock;
  blockIndex: number;
  renderLeaf: (leaf: LeafBlock, key: string) => React.ReactNode;
  staticMode?: boolean;
}

export function InfographicView({ block, blockIndex, renderLeaf, staticMode = false }: InfographicViewProps) {
  const { domId } = useBlocks();
  const { hero, highlights } = infographicParts(block);
  const taken = new Set<string>([
    ...(hero ? [`${hero.section}-${hero.leaf}`] : []),
    ...highlights.map((h) => `${h.section}-${h.leaf}`),
  ]);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="infographic">
      {hero ? <HeroRow group={hero.block} idPrefix={`brief-${blockIndex}`} staticMode={staticMode} /> : null}
      {highlights.length ? (
        <div className="@container min-w-0" data-testid="infographic-highlights">
          <ul className={cn('grid gap-2', highlightColumns(highlights.length))} aria-label="Highlights">
            {highlights.map((h) => (
              <li key={`${h.section}-${h.leaf}`} className="min-w-0 [&_[role=note]]:h-full">
                {renderLeaf(h.block, `${h.section}-${h.leaf}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {block.sections.map((s, si) => {
        const leaves = s.blocks.map((leaf, li) => ({ leaf, li })).filter(({ li }) => !taken.has(`${si}-${li}`));
        if (!leaves.length && !s.summary) return null;
        const spans = spanPlan(leaves.map((l) => l.leaf));
        const headingId = sectionAnchorId(domId, blockIndex, si);
        // "Response times" over a card titled "Response times": the card's title says it.
        const repeats = headingRepeatsLeaf(s.heading, leaves.map((l) => l.leaf), s.summary);
        return (
          <div key={s.id} role="group" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2" data-testid="infographic-section">
            <h5
              id={headingId}
              tabIndex={staticMode ? undefined : -1}
              className={cn('scroll-mt-16 text-sm font-semibold text-foreground outline-none', repeats && 'sr-only')}
              data-repeats-leaf={repeats || undefined}
            >
              {s.heading}
            </h5>
            {s.summary ? <p className="whitespace-pre-line break-words text-sm text-muted-foreground">{s.summary}</p> : null}
            {leaves.length ? (
              <div className="@container min-w-0">
                <div className={cn('grid grid-cols-1 gap-x-5 gap-y-4', !staticMode && '@[44rem]:grid-cols-2')} data-testid="infographic-grid">
                  {leaves.map(({ leaf, li }, k) => (
                    <div
                      key={`${leaf.id}-${li}`}
                      // On paper the grid is one column: a span would add a second track
                      // (an implicit column) and seat two fixed-width charts side by side.
                      className={cn('min-w-0', !staticMode && spans[k] && '@[44rem]:col-span-2')}
                      data-span={spans[k] ? 'row' : 'half'}
                    >
                      {renderLeaf(leaf, `${si}-${li}`)}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
