/**
 * ONE card chrome for every visual answer block (SPEC §10.3, BLOCKS.md §6 `BlockFigure`):
 * title, scope caption, provenance tag, ONE visible "Add to report" icon button, and a ⋯
 * menu with Expand (wide sheet), Show as <view> (client-side, same data), Show table /
 * chart, Copy data (TSV, formula-defused, IOCs defanged by default), Download CSV / JSON,
 * Copy query, and Open in <page> only when an EXACT filter target exists.
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
 */
import * as React from 'react';
import {
  Braces,
  ClipboardCopy,
  Code2,
  Download,
  ExternalLink,
  FileCheck2,
  FilePlus2,
  Maximize2,
  MoreHorizontal,
  Table2,
  BarChart3,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
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
import { ProvenanceTag } from '@/soc/components/ProvenanceTag';
import { useAnnouncer } from '@/soc/components/announcer';
import { isSafeCaseId } from '@/soc/case-result-route';
import { navLabel } from '@/soc/nav';

import { BlockBoundary } from './BlockBoundary';
import { ChartBlockView } from './charts/ChartBlockView';
import { BlocksContext, leafAnchorKey, useBlocks } from './context';
import { blockTabular, downloadText, toCSV, toJSON, toTSV } from './export-helpers';
import { fileStamp, formatUtc, slug, truncationNote } from './format';
import { CaseListView } from './renderers/CaseListView';
import { EntityView } from './renderers/EntityView';
import { HeatmapView } from './renderers/HeatmapView';
import { KpiGroupView } from './renderers/KpiGroupView';
import { MitreView } from './renderers/MitreView';
import { ReportView, reportScopeLine } from './renderers/ReportView';
import { CalloutView, CitationsView, GuideView, MarkdownView, QueryView } from './renderers/SimpleViews';
import { TableView } from './renderers/TableView';
import { TimelineView } from './renderers/TimelineView';
import type { AnswerBlock, BlockView, InternalRef, LeafBlock } from './schema';
import { AI_AUTHORED_TYPES, blockView } from './schema';
import { VIEW_LABEL, canShowTable, honestBlock, switchableViews, tableBlockOf, viewAs } from './views';

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
  leafKey,
}: BlockBodyProps) {
  const { compact, citationOwner } = useBlocks();
  if (showTable) {
    const t = tableBlockOf(block);
    if (t) return <TableView block={t} title={title} paged={expanded} staticMode={staticMode} />;
  }
  switch (block.type) {
    case 'markdown':
      return <MarkdownView block={block} />;
    case 'kpi_group':
      return <KpiGroupView items={block.items} idPrefix={`chat-${index}`} />;
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
      return <EntityView block={block} idPrefix={`chat-${index}`} />;
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
    case 'report':
      return (
        <ReportView
          block={block}
          blockIndex={index}
          renderLeaf={(leaf: LeafBlock, key: string) => (
            // One boundary per leaf: a leaf that cannot render degrades alone (G9).
            <BlockBoundary key={key} id={leaf.id} fallbackText={leaf.fallback_text}>
              <BlockCard block={leaf} index={index} headingLevel={6} nested leafKey={key} staticMode={staticMode} />
            </BlockBoundary>
          )}
        />
      );
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
}

const HEADINGS = { 4: 'h4', 5: 'h5', 6: 'h6' } as const;

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
}: BlockCardProps) {
  const ctx = useBlocks();
  const { navigate, queryForStep } = ctx;
  // The expanded sheet renders the same block again; its anchors get their own prefix so
  // no DOM id is ever duplicated while the sheet is open.
  const expandedCtx = React.useMemo(() => ({ ...ctx, domId: `${ctx.domId}x` }), [ctx]);
  const announce = useAnnouncer();
  const rawId = React.useId();
  const titleId = `blk-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const eyebrowId = `${titleId}-kind`;
  const [view, setView] = React.useState<BlockView | null>(null);
  const [showTable, setShowTable] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [defangCopy, setDefangCopy] = React.useState(true);

  // Bare blocks: prose and notes carry no chrome of their own.
  if (block.type === 'markdown' || block.type === 'callout') {
    return (
      <div className="min-w-0 [contain-intrinsic-size:auto_80px] [content-visibility:auto]" data-block-type={block.type}>
        <BlockBody block={block} title={blockTitle(block)} index={index} nested={nested} leafKey={leafKey} staticMode={staticMode} />
      </div>
    );
  }

  // Charts are always drawn in a kind their data can honestly support (views.ts).
  const displayed = view ? viewAs(block, view) : honestBlock(block);
  const title = blockTitle(block);
  const isBrief = block.type === 'report';
  const Heading = HEADINGS[headingLevel];
  const views = switchableViews(block);
  const currentView = blockView(displayed) as BlockView;
  const tabular = blockTabular(displayed);
  const tableToggle = canShowTable(block);
  const stepQuery = block.from_step && queryForStep ? queryForStep(block.from_step) : null;
  const query = block.type === 'query' ? block.query : stepQuery || null;
  const openTarget = openTargetFor(block);
  const stamp = () => `agentic-soc-${slug(title)}-${fileStamp()}Z`;

  const captionParts: string[] = [];
  if (block.type === 'report') captionParts.push(reportScopeLine(block));
  if (block.caption) captionParts.push(block.caption);
  if (block.as_of) captionParts.push(`as of ${formatUtc(block.as_of)}`);

  const onCopyData = () => {
    if (!tabular) return;
    void copyText(toTSV(tabular, { defang: defangCopy })).then((ok) => {
      announce(ok ? `Copied ${tabular.rows.length} rows${defangCopy ? ', indicators defanged' : ''}` : 'Copy failed');
    });
  };
  const onCopyQuery = () => {
    if (!query) return;
    void copyText(query).then((ok) => announce(ok ? 'Query copied' : 'Copy failed'));
  };

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`More actions for ${title}`}
        className={cn('inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}
        data-testid="block-menu-trigger"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => setExpanded(true)}>
          <Maximize2 className="size-3.5" aria-hidden />
          Expand
        </DropdownMenuItem>
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
                if (downloadText(`${stamp()}.csv`, 'text/csv;charset=utf-8', toCSV(tabular))) announce('CSV downloaded');
              }}
            >
              <Download className="size-3.5" aria-hidden />
              Download CSV
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

  const showAddToReport = !nested && !staticMode && canAddToReport && Boolean(onAddToReport);

  return (
    <figure
      aria-labelledby={isBrief ? `${eyebrowId} ${titleId}` : titleId}
      data-block-type={block.type}
      className={cn(
        'min-w-0 [contain-intrinsic-size:auto_320px] [content-visibility:auto]',
        nested ? 'pt-1' : 'rounded-lg border border-border/70 px-3 pb-3 pt-2',
      )}
    >
      <figcaption className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {isBrief ? (
            // SPEC §10.6 vocabulary: an in-chat report is a "Brief".
            <p id={eyebrowId} className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              Brief
            </p>
          ) : null}
          <Heading id={titleId} className="truncate text-sm font-semibold text-foreground" title={title}>
            {titleNode(block, title)}
          </Heading>
          {captionParts.length ? (
            <p className="break-words text-xs text-muted-foreground" data-testid="block-caption">
              {captionParts.join(' · ')}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <ProvenanceTag kind={block.provenance} variant="icon" className="px-1" />
          {showAddToReport && onAddToReport ? (
            <BlockReportToggle title={title} inReport={inReport} disabledReason={addDisabledReason} onToggle={onAddToReport} />
          ) : null}
          {staticMode ? null : menu}
        </div>
      </figcaption>

      {block.provenance === 'ai' && isDataBlock(block) ? (
        <p className="mb-1.5 text-xs italic text-muted-foreground" data-testid="block-ai-caption">
          Values stated by the model, not measured
        </p>
      ) : null}

      <BlockBody
        block={displayed}
        title={title}
        index={index}
        showTable={showTable}
        nested={nested}
        leafKey={leafKey}
        staticMode={staticMode}
      />

      {block.truncated || block.downsampled_for_storage ? (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="block-truncation">
          {block.truncated ? truncationNote(shownCount(block), block.total) : null}
          {block.truncated && block.downsampled_for_storage ? ' · ' : null}
          {block.downsampled_for_storage ? 'Downsampled for saved history' : null}
        </p>
      ) : null}

      {expanded ? (
        <Sheet open onOpenChange={(o) => setExpanded(o)}>
          <SheetContent side="right" size="full" className="max-w-[min(98vw,1400px)] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{captionParts.join(' · ') || 'Expanded view'}</SheetDescription>
            </SheetHeader>
            <div className="min-w-0 px-6 pb-6">
              <BlocksContext.Provider value={expandedCtx}>
                <BlockBody block={displayed} title={title} index={index} showTable={showTable} expanded />
              </BlocksContext.Provider>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </figure>
  );
}
