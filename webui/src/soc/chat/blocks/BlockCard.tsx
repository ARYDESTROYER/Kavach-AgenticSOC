/**
 * ONE card chrome for every visual answer block (SPEC §10.3, BLOCKS.md §6 `BlockFigure`):
 * title, scope caption, and at rest ONE control: the ⋯ menu (Round 13, SPEC-chat T9). Its
 * first line says who produced the values ("Measured by a lookup", "Computed by code",
 * "Stated by the model"; a line, not a control), then Add to report, Expand (wide
 * sheet), Show as <view> (client-side, same data), the chart's Series (when its lines
 * are labelled at their ends), Show table / chart, Copy data (TSV, formula-defused, IOCs
 * defanged by default), Download CSV / JSON, Copy query, and Open in <page> only when an
 * EXACT filter target exists. The Add to report icon shows beside the menu on hover or
 * focus within the card (opacity, so it stays focusable), and always while the block is
 * in the report.
 *
 * Every action is a read, a copy or a download (G10). Disclosures that change how a
 * number must be read are never hidden in the menu: a truncated block always captions
 * "top N of M" (G4) and a model-stated block says so (G5).
 *
 * Structure: a card is a `<figure>` named by its heading, whose `<figcaption>` holds the
 * title, caption and controls (BLOCKS.md "Accessibility"). Deliberately NOT a
 * `<section aria-labelledby>`: that is a named region LANDMARK, and a transcript with
 * dozens of blocks (two untitled "Key figures", the same block asked again) would flood
 * the landmark list and fail axe `landmark-unique`. Report sections are labelled groups
 * for the same reason.
 *
 * Long transcripts: each card is `content-visibility: auto` with an intrinsic size, so
 * off-screen charts skip layout and paint but stay in the accessibility tree.
 *
 * Static mode (print and static exports, Round 12 WP-REP R6/R7/R13): no menu, no Add to
 * report, no provenance line (an AI block still says "Values stated by the model"), every
 * caption whole (never shortened by an answer's shared scope line), no
 * `content-visibility` (a skipped
 * subtree can print blank), a title that wraps instead of truncating, and every control
 * that could still render is marked `data-print-hide`.
 *
 * Round 12 chart and block upgrades (WP-BLK, SYNTHESIS-chat P0-6/P0-8), all client-side
 * and read-only (never a re-query, never a model call):
 *   - "Group by" re-bins a calendar series into a coarser unit the server allowed; the
 *     table, Copy data and the downloads follow the grouping shown, and the caption, the
 *     image subtitle and the CSV / image file names say "grouped by month" (the server's
 *     title still names its own bucket);
 *   - Download PNG / SVG draws the chart AS SHOWN (grouping, zoom, hidden series) in the
 *     card's theme (`charts/export-image.ts`);
 *   - Full width takes a card out of the conversation lane to the conversation's gutters
 *     (`renderers/full-bleed.ts`), offered only inside a chat lane with room to gain;
 *   - a comparison's tile view reads absolute and relative change per metric
 *     (`renderers/ComparisonView.tsx`).
 */
import * as React from 'react';
import {
  Binary,
  Bot,
  Braces,
  ClipboardCopy,
  Database,
  Code2,
  Download,
  ExternalLink,
  FileCheck2,
  FilePlus2,
  ImageDown,
  Maximize2,
  MoreHorizontal,
  Table2,
  BarChart3,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { UTF8_BOM } from '@/lib/download';
import { focusRing } from '@/lib/ui-recipes';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { useAnnouncer } from '@/soc/components/announcer';
import { isSafeCaseId } from '@/soc/case-result-route';
import { navLabel } from '@/soc/nav';

import { BlockBoundary } from './BlockBoundary';
import { ChartBlockView } from './charts/ChartBlockView';
import { ChartControlsContext, ChartViewContext, type ChartControls, type ChartSeriesMenu, type ChartView } from './charts/export-context';
import { downloadChartPng, downloadChartSvg } from './charts/export-image';
import { RebinControl } from './charts/RebinControl';
import { rebinChart, rebinChoices } from './charts/rebin';
import { CARTESIAN_KINDS } from './charts/kinds';
import { BlocksContext, leafAnchorKey, useBlocks } from './context';
import { blockTabular, downloadText, toCSV, toJSON, toTSV } from './export-helpers';
import { captionStatesCount, fileStamp, formatUtc, slug, truncationNote } from './format';
import { CAPTION_SEPARATOR, ownCaptionParts, type BlockWidth, type SharedScope } from './layout';
import { CaseListView } from './renderers/CaseListView';
import { ComparisonTiles } from './renderers/ComparisonView';
import { EntityView } from './renderers/EntityView';
import { HeatmapView } from './renderers/HeatmapView';
import { KpiGroupView } from './renderers/KpiGroupView';
import { MitreView } from './renderers/MitreView';
import { ReportView, briefHeading, reportLeafScope, reportScopeLine } from './renderers/ReportView';
import { CalloutView, CitationsView, GuideView, MarkdownView, QueryView } from './renderers/SimpleViews';
import { TableView } from './renderers/TableView';
import { TimelineView } from './renderers/TimelineView';
import { useFullBleed } from './renderers/full-bleed';
import type { AnswerBlock, BlockView, InternalRef, LeafBlock, TimeBucket } from './schema';
import { AI_AUTHORED_TYPES, blockView } from './schema';
import { VIEW_LABEL, canShowTable, honestBlock, honestChart, switchableViews, tableBlockOf, viewAs } from './views';

/* -------------------------------------------------------------------------- */
/* Labels and derived facts.                                                   */
/* -------------------------------------------------------------------------- */
const TYPE_TITLE: Record<AnswerBlock['type'], string> = {
  markdown: 'Note',
  kpi_group: 'Key figures',
  chart: 'Chart',
  heatmap: 'Heatmap',
  table: 'Table',
  case_list: 'Cases',
  timeline: 'Timeline',
  entity: 'Indicator',
  mitre: 'ATT&CK techniques',
  query: 'Query',
  callout: 'Note',
  citations: 'Sources',
  guide: 'How to',
  report: 'Brief',
};

/** The card's plain-text title (accessible names, menus, file names, the sheet). */
export function blockTitle(block: AnswerBlock): string {
  if (block.type === 'report') return block.title;
  if (block.title) return block.title;
  if (block.type === 'entity') return `${TYPE_TITLE.entity}: ${block.entity.value}`;
  return TYPE_TITLE[block.type];
}

/**
 * The visible title. Identical text to {@link blockTitle}, except that an untitled
 * entity's indicator is attacker-influenced and so renders mono (G7), like everywhere
 * else it appears.
 */
function titleNode(block: AnswerBlock, title: string): React.ReactNode {
  if (block.type === 'entity' && !block.title) {
    return (
      <>
        {TYPE_TITLE.entity}: <span className="font-mono">{block.entity.value}</span>
      </>
    );
  }
  return title;
}

/** How many items the block shows (for the "top N of M" disclosure). */
export function shownCount(block: AnswerBlock): number {
  switch (block.type) {
    case 'chart':
      return block.x.values.length;
    case 'heatmap':
      return block.y.values.length;
    case 'table':
      return block.rows.length;
    case 'case_list':
    case 'kpi_group':
      return block.items.length;
    case 'timeline':
      return block.events.length;
    case 'mitre':
      return block.techniques.length;
    case 'citations':
      return block.items.length;
    case 'report':
      return block.sections.length;
    default:
      return 0;
  }
}

/** Blocks that carry DATA (G5 applies); prose and notes do not. */
function isDataBlock(block: AnswerBlock): boolean {
  return !AI_AUTHORED_TYPES.includes(block.type) && block.type !== 'guide' && block.type !== 'citations';
}

/**
 * An EXACT in-app target for "Open in …" (SPEC §10.3, §10.7): only when the destination
 * shows precisely this block's data, never an approximation of it:
 *
 * - the server's `open_in` view — "Open in Logs" for a query-backed block whose tool
 *   call used only the free text, window and source the Logs page can express (built
 *   from the call's own input, re-validated by `parseBlocks`; absent on `ai` blocks);
 * - a single case, by its id.
 *
 * A block with any other filter gets no "Open in" (Copy query remains): the client
 * never reconstructs a filter from a query string or a label.
 */
export function openTargetFor(block: AnswerBlock): InternalRef | null {
  if (block.open_in && block.provenance !== 'ai') return block.open_in;
  if (block.type === 'case_list' && block.items.length === 1 && isSafeCaseId(block.items[0].case_id)) {
    return { page: 'case_manager', opts: { caseId: block.items[0].case_id } };
  }
  if (block.type === 'table' && block.rows.length === 1) {
    const col = block.columns.findIndex((c) => c.type === 'case');
    const v = col >= 0 ? block.rows[0][col] : null;
    if (typeof v === 'string' && isSafeCaseId(v)) return { page: 'case_manager', opts: { caseId: v } };
  }
  return null;
}

const TOGGLE_BACK: Partial<Record<AnswerBlock['type'], string>> = {
  chart: 'Show chart',
  heatmap: 'Show heatmap',
  kpi_group: 'Show tiles',
  case_list: 'Show list',
  timeline: 'Show timeline',
};

/* -------------------------------------------------------------------------- */
/* Body dispatch.                                                              */
/* -------------------------------------------------------------------------- */
export interface BlockBodyProps {
  block: AnswerBlock;
  title: string;
  index: number;
  showTable?: boolean;
  expanded?: boolean;
  /**
   * The print / static path (WP-K): fixed 680 px charts with no interaction and their
   * data tables VISIBLE under them, and every table row shown (no "View all" button).
   */
  staticMode?: boolean;
  /** A leaf inside a report section. */
  nested?: boolean;
  /** The card dropped its frame for a host that frames it (see {@link BlockCardProps.bare}). */
  bare?: boolean;
  /** `"<section>-<leaf>"` for a report leaf (see `leafAnchorKey`). */
  leafKey?: string;
}

export function BlockBody({
  block,
  title,
  index,
  showTable = false,
  expanded = false,
  staticMode = false,
  nested = false,
  bare = false,
  leafKey,
}: BlockBodyProps) {
  const { compact, citationOwner } = useBlocks();
  // The body sits inside the card's own frame (border + 0.75rem padding) only in a
  // top-level card. A report leaf, a bare card and the expanded sheet have no frame
  // around the body, so KPI tiles draw their own closed frame there (KpiGroupView).
  const inCardFrame = !nested && !bare && !expanded;
  if (showTable) {
    const t = tableBlockOf(block);
    // A case list's table names each case by number and links by its id (`caseRefs`).
    if (t) {
      return (
        <TableView
          block={t}
          title={title}
          paged={expanded}
          staticMode={staticMode}
          caseRefs={block.type === 'case_list' ? block.items : undefined}
        />
      );
    }
  }
  switch (block.type) {
    case 'markdown':
      return <MarkdownView block={block} />;
    case 'kpi_group':
      // A period comparison's tiles read absolute AND relative change (Round 12 P0-6),
      // and follow the same host-frame rule as any other KPI group.
      if (block.artifact_kind === 'comparison') {
        return <ComparisonTiles items={block.items} idPrefix={`chat-${index}`} staticMode={staticMode} framed={!inCardFrame} />;
      }
      return <KpiGroupView items={block.items} idPrefix={`chat-${index}`} staticMode={staticMode} framed={!inCardFrame} />;
    case 'chart':
      return <ChartBlockView block={block} title={title} compact={compact} expanded={expanded} staticMode={staticMode} />;
    case 'heatmap':
      return <HeatmapView block={block} title={title} staticMode={staticMode} />;
    case 'table':
      return <TableView block={block} title={title} paged={expanded} staticMode={staticMode} />;
    case 'case_list':
      return <CaseListView block={block} />;
    case 'timeline':
      return <TimelineView block={block} />;
    case 'entity':
      return (
        <EntityView
          block={block}
          idPrefix={`chat-${index}`}
          framed={nested}
          // Its count tiles: framed by the entity's own frame (a leaf) or the card's.
          countsFramed={!nested && !inCardFrame}
          staticMode={staticMode}
        />
      );
    case 'mitre':
      return <MitreView block={block} title={title} />;
    case 'query':
      return <QueryView block={block} />;
    case 'callout':
      return <CalloutView block={block} />;
    case 'citations': {
      // Exactly one citations block per message carries the `[n]` anchors (no duplicate ids).
      const anchored = citationOwner === undefined ? !nested : leafAnchorKey(index, leafKey) === citationOwner;
      return <CitationsView block={block} anchored={anchored} />;
    }
    case 'guide':
      return <GuideView block={block} />;
    case 'report': {
      // The Brief states its window and time once, in its scope line: a leaf's caption
      // leaves out what that line says (SPEC-chat T29); print keeps every caption whole.
      const leafScope = staticMode ? null : reportLeafScope(block);
      return (
        <ReportView
          block={block}
          blockIndex={index}
          staticMode={staticMode}
          inFrame={inCardFrame}
          renderLeaf={(leaf: LeafBlock, key: string) => (
            // One boundary per leaf: a leaf that cannot render degrades alone (G9).
            <BlockBoundary key={key} id={leaf.id} fallbackText={leaf.fallback_text}>
              <BlockCard block={leaf} index={index} headingLevel={6} nested leafKey={key} staticMode={staticMode} sharedScope={leafScope} />
            </BlockBoundary>
          )}
        />
      );
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The card.                                                                   */
/* -------------------------------------------------------------------------- */
export interface BlockCardProps {
  block: AnswerBlock;
  /** Position in the message (DOM ids and anchors derive from it, never from block.id). */
  index: number;
  headingLevel?: 4 | 5 | 6;
  /** Inside a report: no frame and no Add to report (a leaf is not addressable alone). */
  nested?: boolean;
  inReport?: boolean;
  canAddToReport?: boolean;
  onAddToReport?: () => void;
  /**
   * Why adding is refused right now (e.g. "Report is full (40 items)"). The toggle stays
   * visible and focusable (a block already in the report must stay removable), turns
   * `aria-disabled` when the block is not in the report, and says why in its tooltip.
   */
  addDisabledReason?: string | null;
  /** Report leaf position (`"<section>-<leaf>"`). */
  leafKey?: string;
  /** Print / static rendering (see {@link BlockBodyProps.staticMode}). */
  staticMode?: boolean;
  /**
   * Drop the card's own frame (border, rounding, padding) and nothing else: for a host
   * that already frames the block (a report panel item), so cards never nest.
   */
  bare?: boolean;
  /**
   * The card's width in the lane (`data-block-width`, SPEC-chat §5.1): a compact card stays
   * in the 42rem reading column. Set by AnswerBlocks from the block's type and size.
   */
  width?: BlockWidth;
  /**
   * The scope line its answer (or its Brief) already states: the visible caption leaves
   * those parts out, its accessible description keeps them (SPEC-chat T8, T29). Ignored
   * in static mode, and by the expanded sheet, which always show the whole caption.
   */
  sharedScope?: SharedScope | null;
}

const HEADINGS = { 4: 'h4', 5: 'h5', 6: 'h6' } as const;

/**
 * Who produced a block's values, as the ⋯ menu's first line says it (SPEC-chat T9). It
 * used to be an icon in the header that read as a stray control ("01/10").
 */
export const PROVENANCE_LINE: Readonly<Record<AnswerBlock['provenance'], { text: string; Icon: React.ComponentType<{ className?: string }> }>> = {
  source: { text: 'Measured by a lookup', Icon: Database },
  code: { text: 'Computed by code', Icon: Binary },
  ai: { text: 'Stated by the model', Icon: Bot },
};

/** Blocks that may break out of the conversation lane ("Full width"). */
const BLEED_TYPES: ReadonlyArray<AnswerBlock['type']> = ['chart', 'table', 'heatmap', 'timeline', 'case_list', 'kpi_group', 'mitre', 'report'];
const BUCKET_NAME: Partial<Record<TimeBucket, string>> = { '1h': 'hour', '1d': 'day', '1w': 'week', '1M': 'month', '1q': 'quarter', '1y': 'year' };

/**
 * A block's Add to report toggle. ONE stable name (an APG toggle must not also flip its
 * name); `aria-pressed` says whether the block is in the report. When adding is refused
 * (a full report) and the block is not in it, the toggle is `aria-disabled`, never
 * `disabled`: it stays focusable so the tooltip can say why on hover AND focus, and the
 * reason is its accessible description. A click still reaches the host, which answers a
 * refused add with the same reason. Its own provider keeps the card renderable outside
 * the app shell (reports, tests); nesting one is supported.
 */
function BlockReportToggle({
  title,
  inReport,
  disabledReason,
  onToggle,
}: {
  title: string;
  inReport: boolean;
  disabledReason: string | null;
  onToggle: () => void;
}) {
  const reasonId = `${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}-why`;
  const unavailable = !inReport && !!disabledReason;
  const hint = inReport ? 'In report ✓ (click to remove)' : unavailable ? disabledReason : 'Add to report';
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-pressed={inReport}
            aria-label={`Add ${title} to report`}
            aria-disabled={unavailable || undefined}
            aria-describedby={unavailable ? reasonId : undefined}
            onClick={onToggle}
            data-testid="block-add-to-report"
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-md',
              inReport
                ? 'text-primary hover:bg-muted'
                : unavailable
                  ? 'cursor-not-allowed text-muted-foreground opacity-50'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              focusRing,
            )}
          >
            {inReport ? <FileCheck2 className="size-4" aria-hidden /> : <FilePlus2 className="size-4" aria-hidden />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{hint}</TooltipContent>
      </Tooltip>
      {unavailable ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </TooltipProvider>
  );
}

/**
 * The Add to report icon's resting state (SPEC-chat T9): hidden until the pointer is over
 * the card or focus is inside it. Opacity, never `visibility`, so it stays focusable; no
 * pointer events while hidden, so an invisible target is never tapped. Literal classes.
 */
const REVEAL_ON_CARD =
  'pointer-events-none opacity-0 transition-opacity motion-reduce:transition-none group-hover/block:pointer-events-auto group-hover/block:opacity-100 group-focus-within/block:pointer-events-auto group-focus-within/block:opacity-100';

export function BlockCard({
  block,
  index,
  headingLevel = 4,
  nested = false,
  inReport = false,
  canAddToReport = false,
  onAddToReport,
  addDisabledReason = null,
  leafKey,
  staticMode = false,
  bare = false,
  width,
  sharedScope = null,
}: BlockCardProps) {
  const ctx = useBlocks();
  const { navigate, queryForStep } = ctx;
  // The expanded sheet renders the same block again; its anchors get their own prefix so
  // no DOM id is ever duplicated while the sheet is open.
  const expandedCtx = React.useMemo(() => ({ ...ctx, domId: `${ctx.domId}x` }), [ctx]);
  const announce = useAnnouncer();
  const rawId = React.useId();
  const titleId = `blk-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [view, setView] = React.useState<BlockView | null>(null);
  const [showTable, setShowTable] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [defangCopy, setDefangCopy] = React.useState(true);
  // Round 12 (P0-8): the client-side grouping, the chart as shown (for its image), and
  // the full-width breakout. All display only; the block's data never changes.
  const [rebin, setRebin] = React.useState<TimeBucket | null>(null);
  // Round 13 (T16): the series a line chart named at its line ends hands to this menu.
  const [seriesMenu, setSeriesMenu] = React.useState<ChartSeriesMenu | null>(null);
  const publishSeries = React.useCallback((menu: ChartSeriesMenu | null) => setSeriesMenu(menu), []);
  const figureRef = React.useRef<HTMLElement>(null);
  const chartView = React.useRef<ChartView | null>(null);
  const bleed = useFullBleed(figureRef, !nested && !staticMode && !bare && !ctx.compact && BLEED_TYPES.includes(block.type));
  const rebinOptions = React.useMemo(() => (block.type === 'chart' && !staticMode ? rebinChoices(block) : []), [block, staticMode]);
  const grouped = React.useMemo(
    () => (block.type === 'chart' && rebin && rebinOptions.includes(rebin) ? rebinChart(block, rebin) : block),
    [block, rebin, rebinOptions],
  );

  // Bare blocks: prose and notes carry no chrome of their own. Inside a Brief (a wide
  // block) they keep the measures the answer's own prose keeps (`lane.ts`): 38rem for
  // prose, 42rem for a note, so "Next steps" no longer ran 178 characters a line at 1920
  // (PW4-7). The lane caps top-level ones; print keeps the page's width.
  if (block.type === 'markdown' || block.type === 'callout') {
    return (
      <div
        className={cn(
          'min-w-0',
          !staticMode && '[contain-intrinsic-size:auto_80px] [content-visibility:auto]',
          nested && !staticMode && (block.type === 'markdown' ? 'max-w-[38rem]' : 'max-w-[42rem]'),
        )}
        data-block-type={block.type}
        data-block-width={width}
      >
        <BlockBody block={block} title={blockTitle(block)} index={index} nested={nested} leafKey={leafKey} staticMode={staticMode} />
      </div>
    );
  }

  // Charts are always drawn in a kind their data can honestly support (views.ts).
  const displayed = view ? viewAs(grouped, view) : honestBlock(grouped);
  const title = blockTitle(block);
  const isBrief = block.type === 'report';
  // SPEC §10.6 vocabulary: an in-chat report is a "Brief", and its title says so (T29;
  // the "BRIEF" eyebrow above it is gone). The window it names is in the scope line.
  const shownTitle = block.type === 'report' ? briefHeading(block) : title;
  const Heading = HEADINGS[headingLevel];
  const views = switchableViews(block);
  const currentView = blockView(displayed) as BlockView;
  const tabular = blockTabular(displayed);
  const tableToggle = canShowTable(block);
  const stepQuery = block.from_step && queryForStep ? queryForStep(block.from_step) : null;
  const query = block.type === 'query' ? block.query : stepQuery || null;
  const openTarget = openTargetFor(block);
  // A client-side grouping is named wherever the grouped numbers go: the caption, the
  // image subtitle and the file names (the server's title still names its own bucket).
  const groupedBy = block.type === 'chart' && rebin && rebin !== rebinOptions[0] && rebinOptions.includes(rebin) ? BUCKET_NAME[rebin] ?? null : null;
  const stamp = (grouping: string | null = null) => `agentic-soc-${slug(title)}${grouping ? `-by-${slug(grouping)}` : ''}-${fileStamp()}Z`;

  // "Showing top 5 of 20" under the body, unless the caption above already says it.
  const shown = block.truncated ? shownCount(block) : 0;
  const truncNote =
    block.truncated && !captionStatesCount(block.caption, shown, block.total) ? truncationNote(shown, block.total) : null;

  // The WHOLE caption: the expanded sheet, the image subtitle and assistive tech read it.
  const asOfText = block.as_of ? `as of ${formatUtc(block.as_of)}` : null;
  const captionParts: string[] = [];
  if (block.type === 'report') captionParts.push(reportScopeLine(block));
  if (block.caption) captionParts.push(block.caption);
  if (asOfText) captionParts.push(asOfText);
  const grouping = groupedBy ? `grouped by ${groupedBy}` : null;
  const viewCaption = grouping ? [...captionParts, grouping] : captionParts;
  // What the card SHOWS once its answer's scope line states the shared parts (T8): its
  // own parts only. Print and static exports always show the whole caption.
  const scoped = sharedScope && !staticMode ? sharedScope : null;
  const shownCaption = scoped
    ? [
        ...(block.type === 'report' ? [reportScopeLine(block)] : []),
        ...ownCaptionParts(block.caption, scoped),
        ...(asOfText && asOfText !== scoped.asOf ? [asOfText] : []),
        ...(grouping ? [grouping] : []),
      ]
    : viewCaption;
  const captionShortened = scoped !== null && shownCaption.join(CAPTION_SEPARATOR) !== viewCaption.join(CAPTION_SEPARATOR);

  // Group by joins the chart's ONE control row when a Cartesian chart is drawn (T16);
  // otherwise (the table view, another kind) the card draws it above the body.
  const drawnKind = displayed.type === 'chart' && !showTable && displayed.x.values.length ? honestChart(displayed).kind : null;
  const groupByInChart = drawnKind !== null && CARTESIAN_KINDS.has(drawnKind);
  const groupBy = rebinOptions.length ? (
    <RebinControl
      choices={rebinOptions}
      value={rebin && rebinOptions.includes(rebin) ? rebin : rebinOptions[0]}
      onChange={(b) => {
        setRebin(b === rebinOptions[0] ? null : b);
        announce(`Grouped by ${BUCKET_NAME[b] ?? b}`);
      }}
      title={title}
    />
  ) : null;
  const chartControls: ChartControls = {
    groupBy: groupByInChart ? groupBy : null,
    publishSeries: staticMode ? null : publishSeries,
  };
  const series = seriesMenu && drawnKind !== null ? seriesMenu : null;
  const toggleSeries = (k: number) => {
    if (!series) return;
    const visible = series.hidden.filter((h) => !h).length;
    const hiding = !series.hidden[k];
    if (hiding && visible <= 1) {
      announce('At least one series must stay visible');
      return;
    }
    series.toggle(k);
    announce(`Showing ${visible + (hiding ? -1 : 1)} of ${series.labels.length} series`);
  };

  const onCopyData = () => {
    if (!tabular) return;
    void copyText(toTSV(tabular, { defang: defangCopy })).then((ok) => {
      announce(ok ? `Copied ${tabular.rows.length} rows${defangCopy ? ', indicators defanged' : ''}` : 'Copy failed');
    });
  };
  const onDownloadImage = async (format: 'png' | 'svg') => {
    if (displayed.type !== 'chart') return;
    // The chart as SHOWN: its grouping, its zoom and the series its legend shows.
    const shownView = chartView.current;
    const req = {
      block: shownView?.block ?? displayed,
      hidden: shownView?.hidden,
      title,
      subtitle: captionParts.join(' · ') || undefined,
      grouping: groupedBy ?? undefined,
      zoom: shownView?.zoom ?? null,
      host: figureRef.current,
    };
    const ok = format === 'svg' ? downloadChartSvg(req) : await downloadChartPng(req);
    announce(ok ? `${format.toUpperCase()} downloaded` : 'Could not create the image');
  };
  const onCopyQuery = () => {
    if (!query) return;
    void copyText(query).then((ok) => announce(ok ? 'Query copied' : 'Copy failed'));
  };

  const showAddToReport = !nested && !staticMode && canAddToReport && Boolean(onAddToReport);
  const reportUnavailable = !inReport && !!addDisabledReason;
  const provenance = PROVENANCE_LINE[block.provenance];
  const ProvenanceIcon = provenance.Icon;

  const menu = (
    <DropdownMenu onOpenChange={(open) => (open ? bleed.check() : undefined)}>
      <DropdownMenuTrigger
        aria-label={`More actions for ${title}`}
        className={cn('inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}
        data-testid="block-menu-trigger"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* Who produced the values: a line, not an action (it was the header glyph). */}
        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground" data-testid="block-provenance">
          <ProvenanceIcon className="size-3.5 shrink-0" aria-hidden />
          {provenance.text}
        </DropdownMenuLabel>
        {showAddToReport && onAddToReport ? (
          // A full report keeps the item FOCUSABLE (`aria-disabled`, never Radix
          // `disabled`), so its reason stays in the reading order; the host answers a
          // refused add with the same reason. Touch screens reach Add to report here.
          <DropdownMenuItem
            aria-disabled={reportUnavailable || undefined}
            onSelect={onAddToReport}
            className={cn(reportUnavailable && 'text-muted-foreground')}
            data-testid="block-menu-report"
          >
            {inReport ? <FileCheck2 className="size-3.5" aria-hidden /> : <FilePlus2 className="size-3.5" aria-hidden />}
            <span className="min-w-0">
              {inReport ? 'Remove from report' : 'Add to report'}
              {reportUnavailable ? <span className="block text-2xs text-muted-foreground">{addDisabledReason}</span> : null}
            </span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setExpanded(true)}>
          <Maximize2 className="size-3.5" aria-hidden />
          Expand
        </DropdownMenuItem>
        {bleed.available || bleed.on ? (
          <DropdownMenuCheckboxItem
            checked={bleed.on}
            onCheckedChange={() => {
              bleed.toggle();
              announce(bleed.on ? 'Back to the conversation width' : 'Showing full width');
            }}
            data-testid="block-full-width"
          >
            Full width
          </DropdownMenuCheckboxItem>
        ) : null}
        {views.length >= 2 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">Show as</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={currentView}
              onValueChange={(v) => {
                setView(v as BlockView);
                setShowTable(false);
                announce(`Showing as ${VIEW_LABEL[v as BlockView]}`);
              }}
            >
              {views.map((v) => (
                <DropdownMenuRadioItem key={v} value={v}>
                  {VIEW_LABEL[v]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        {series ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">Series</DropdownMenuLabel>
            {series.labels.map((label, k) => (
              <DropdownMenuCheckboxItem
                key={`${k}-${label}`}
                checked={!series.hidden[k]}
                onCheckedChange={() => toggleSeries(k)}
                // Keep the menu open: several series are usually toggled in a row.
                onSelect={(e) => e.preventDefault()}
                className="gap-2"
                data-testid="block-series-toggle"
              >
                {series.colors?.[k] ? (
                  // The line's colour, so the name ties to its line (the label carries the meaning).
                  <span
                    className="h-0.5 w-3 shrink-0 rounded-full forced-colors:border"
                    style={{ backgroundColor: series.colors[k] }}
                    data-series-key={k}
                    aria-hidden
                  />
                ) : null}
                <span className={cn('min-w-0 break-words', block.untrusted && 'font-mono')}>{label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        ) : null}
        {tableToggle ? (
          <DropdownMenuItem
            onSelect={() => {
              setShowTable((s) => !s);
              announce(showTable ? 'Showing the chart view' : 'Showing the data as a table');
            }}
          >
            {showTable ? <BarChart3 className="size-3.5" aria-hidden /> : <Table2 className="size-3.5" aria-hidden />}
            {showTable ? TOGGLE_BACK[block.type] ?? 'Show chart' : 'Show table'}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {tabular ? (
          <>
            <DropdownMenuItem onSelect={onCopyData}>
              <ClipboardCopy className="size-3.5" aria-hidden />
              Copy data
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={defangCopy}
              onCheckedChange={(c) => setDefangCopy(c === true)}
              onSelect={(e) => e.preventDefault()}
            >
              Defang indicators when copying
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onSelect={() => {
                // The BOM makes Excel read the file as UTF-8 (Round 12 WP-REP R15).
                if (downloadText(`${stamp(groupedBy)}.csv`, 'text/csv;charset=utf-8', `${UTF8_BOM}${toCSV(tabular)}`)) announce('CSV downloaded');
              }}
            >
              <Download className="size-3.5" aria-hidden />
              Download CSV
            </DropdownMenuItem>
          </>
        ) : null}
        {displayed.type === 'chart' && !showTable ? (
          <>
            <DropdownMenuItem onSelect={() => void onDownloadImage('png')}>
              <ImageDown className="size-3.5" aria-hidden />
              Download PNG
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void onDownloadImage('svg')}>
              <ImageDown className="size-3.5" aria-hidden />
              Download SVG
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            if (downloadText(`${stamp()}.json`, 'application/json', toJSON(block))) announce('JSON downloaded');
          }}
        >
          <Braces className="size-3.5" aria-hidden />
          Download JSON
        </DropdownMenuItem>
        {query ? (
          <DropdownMenuItem onSelect={onCopyQuery}>
            <Code2 className="size-3.5" aria-hidden />
            Copy query
          </DropdownMenuItem>
        ) : null}
        {openTarget ? (
          <DropdownMenuItem onSelect={() => navigate(openTarget)}>
            <ExternalLink className="size-3.5" aria-hidden />
            Open in {navLabel(openTarget.page)}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <figure
      ref={figureRef}
      aria-labelledby={titleId}
      data-block-type={block.type}
      data-block-width={width}
      data-full-bleed={bleed.on || undefined}
      style={bleed.style}
      className={cn(
        'group/block min-w-0',
        !staticMode && '[contain-intrinsic-size:auto_320px] [content-visibility:auto]',
        nested || bare ? 'pt-1' : 'rounded-lg border border-border/70 px-3 pb-3 pt-2',
      )}
    >
      <figcaption className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* Title and caption are prose: proportional numerals, so Inter's tabular hyphen
              does not read "Highest - risk" under the answer (re-shoot PW3-3). */}
          <Heading
            id={titleId}
            className={cn('text-sm font-semibold text-foreground proportional-nums', staticMode ? 'break-words' : 'truncate')}
            title={staticMode ? undefined : shownTitle}
            data-brief={isBrief || undefined}
          >
            {isBrief ? shownTitle : titleNode(block, title)}
          </Heading>
          {viewCaption.length ? (
            captionShortened ? (
              // The answer's scope line says the rest once: the card shows its own parts,
              // while assistive tech still reads the whole caption with the card.
              <p
                className={cn('break-words text-xs text-muted-foreground proportional-nums', !shownCaption.length && 'sr-only')}
                data-testid="block-caption"
                data-scoped=""
              >
                {shownCaption.length ? <span aria-hidden>{shownCaption.join(CAPTION_SEPARATOR)}</span> : null}
                <span className="sr-only">{viewCaption.join(CAPTION_SEPARATOR)}</span>
              </p>
            ) : (
              <p className="break-words text-xs text-muted-foreground proportional-nums" data-testid="block-caption">
                {viewCaption.join(CAPTION_SEPARATOR)}
              </p>
            )
          ) : null}
        </div>
        {staticMode ? null : (
          <div className="flex shrink-0 items-center gap-0.5" data-print-hide>
            {showAddToReport && onAddToReport ? (
              <div
                className={cn('flex', !inReport && REVEAL_ON_CARD)}
                data-testid="block-report-slot"
                data-visibility={inReport ? 'always' : 'hover'}
              >
                <BlockReportToggle title={title} inReport={inReport} disabledReason={addDisabledReason} onToggle={onAddToReport} />
              </div>
            ) : null}
            {menu}
          </div>
        )}
      </figcaption>

      {block.provenance === 'ai' && isDataBlock(block) ? (
        <p className="mb-1.5 text-xs italic text-muted-foreground" data-testid="block-ai-caption">
          Values stated by the model, not measured
        </p>
      ) : null}

      {groupBy && !groupByInChart ? <div className="mb-1.5 flex h-7 items-center">{groupBy}</div> : null}

      <ChartViewContext.Provider value={chartView}>
        <ChartControlsContext.Provider value={chartControls}>
          <BlockBody
            block={displayed}
            title={title}
            index={index}
            showTable={showTable}
            nested={nested}
            bare={bare}
            leafKey={leafKey}
            staticMode={staticMode}
          />
        </ChartControlsContext.Provider>
      </ChartViewContext.Provider>

      {truncNote || block.downsampled_for_storage ? (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="block-truncation">
          {truncNote}
          {truncNote && block.downsampled_for_storage ? ' · ' : null}
          {block.downsampled_for_storage ? 'Downsampled for saved history' : null}
        </p>
      ) : null}

      {expanded ? (
        <Sheet open onOpenChange={(o) => setExpanded(o)}>
          <SheetContent side="right" size="full" className="max-w-[min(98vw,1400px)] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{shownTitle}</SheetTitle>
              <SheetDescription>{viewCaption.join(CAPTION_SEPARATOR) || 'Expanded view'}</SheetDescription>
            </SheetHeader>
            <div className="min-w-0 px-6 pb-6">
              {/* The sheet's copy of the chart owns its own legend and controls. */}
              <ChartControlsContext.Provider value={null}>
                <BlocksContext.Provider value={expandedCtx}>
                  <BlockBody block={displayed} title={title} index={index} showTable={showTable} expanded />
                </BlocksContext.Provider>
              </ChartControlsContext.Provider>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </figure>
  );
}
