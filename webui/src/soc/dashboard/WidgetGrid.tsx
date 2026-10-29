/**
 * `WidgetGrid`: renders a dashboard's widgets from its `DashboardLayout` (Round 5 / G7,
 * CD3; Round 14, SPEC §4.4.5 and F3). It has TWO modes that ship very different amounts
 * of JavaScript:
 *
 *   - VIEW mode (default, read-only): a plain CSS Grid sized to its content. Widgets are
 *     flow-packed on the 12 columns from their persisted `{x,y,w,h}`, but the rows are
 *     NOT a fixed height: each distinct top or bottom edge of a widget becomes a row track
 *     sized `auto`, so a panel is as tall as its content (no clipped bodies, no fixed 56 px
 *     rows) and the panels of one band share a height. Below `xl` the grid is one column
 *     in reading order (top to bottom, then left to right). This path imports NO
 *     react-grid-layout: view mode and first paint ship zero grid JS (the
 *     `bundle-first-paint` guardrail).
 *
 *   - EDIT mode: lazily `import()`s {@link EditableGrid} (the sole RGL importer) and hands
 *     it the same widgets. RGL and its CSS load ONLY here, on demand. Cells have a fixed
 *     row height there, so a widget fills its cell and a tall body scrolls inside it.
 *     Drag is scoped to the card header grip; resize is SE-corner only; `onLayoutChange`
 *     bubbles to the builder to debounce-persist.
 *
 * Each widget body comes from the widget registry (`registry.ts`, a `React.lazy`
 * component per type). Every body draws its own panel (no card around it, so no nested
 * cards). Before a body mounts, the grid checks the gates and shows the panel's state
 * instead of mounting it, so a gated widget never asks for data: a widget the viewer's
 * role cannot read ("No access"), a case-derived widget while row-level data scope is on
 * ("Hidden while row-level scope is on.", D16), and a case-derived widget while the
 * viewer's scope could not be read ("Your data access could not be confirmed." with
 * Retry). A gated panel carries the title its body would show (`titleFor`). A title
 * override is passed only when the operator set one, so a body keeps its own default. Titles and
 * labels render as plain text (#9); a layout is advisory (#3).
 *
 * The heavy RGL chunk is behind `React.lazy(() => import('./EditableGrid'))` declared
 * at MODULE scope so it is created once, but the dynamic import only FIRES when edit
 * mode first renders it, so importing `WidgetGrid` itself pulls no grid JS.
 *
 * The whole grid is ONE rule-sheet host (`RuleSheetHost`, SPEC §4.6.5): every rule name a
 * widget shows (Top detection rules, Noisiest rules) opens the one sheet the grid holds,
 * so a board refresh (the 60 s tick, a window change) that re-ranks or drops the row that
 * opened it never closes the sheet being read. It closes when the person closes it or the
 * board goes; focus then returns to the opener, else to the same rule's link on the board.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  GripVertical,
  MoreVertical,
  Pencil,
  Copy,
  Trash2,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Maximize2,
  Minimize2,
  AlertTriangle,
} from 'lucide-react';

import { PANEL_GAP } from '@/design-system/panel';
import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { Skeleton } from '@/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/ui/dropdown-menu';
import { EmptyState } from '@/soc/components/EmptyState';
import { RuleSheetHost } from '@/soc/components/RuleLink';

import type { DashboardWidget } from '@/lib/types';
import { useOptionalDashboardData } from './DashboardDataProvider';
import { canUseWidget, defaultWidgetTitle, getWidgetDef, isScopeHidden } from './registry';
import {
  WidgetFrameContext,
  WidgetShell,
  type WidgetFrameMode,
  type WidgetProps,
  type WidgetState,
} from './widgets/common';
import {
  GRID_COLS,
  packWidgets,
  widgetId,
  widgetOptions,
  type GridItemShape,
  type MoveDir,
  type ResizeDir,
} from './layout-utils';

// The ONE lazy boundary for react-grid-layout. Declared at module scope (created once)
// but the dynamic import only executes when <EditableGrid> is first rendered, i.e.
// when the operator enters edit mode. View mode never touches it.
const EditableGrid = React.lazy(() => import('./EditableGrid'));

/** What a body is told about its cell: content-sized (view) or fixed (edit). */
const VIEW_FRAME: WidgetFrameMode = 'view';
const EDIT_FRAME: WidgetFrameMode = 'edit';

// --------------------------------------------------------------------------- //
// Per-widget card frame (shared by view + edit)
// --------------------------------------------------------------------------- //

/** Keyboard/toolbar actions a widget exposes in edit mode. */
export interface WidgetEditActions {
  onConfigure: (widget: DashboardWidget) => void;
  onDuplicate: (widget: DashboardWidget) => void;
  onRemove: (widget: DashboardWidget) => void;
  onMove: (widget: DashboardWidget, dir: MoveDir) => void;
  onResize: (widget: DashboardWidget, dir: ResizeDir) => void;
}

interface WidgetCardProps {
  widget: DashboardWidget;
  editing: boolean;
  actions?: WidgetEditActions;
  /** Roving-tabindex: is THIS widget the currently keyboard-focusable one? */
  tabbable?: boolean;
  onFocusWidget?: (id: string) => void;
}

/** The operator's title override (plain text, #9), or `undefined` when none is set. */
function titleOverride(widget: DashboardWidget): string | undefined {
  const t = widgetOptions(widget).title;
  const s = (typeof t === 'string' ? t : '').trim();
  return s || undefined;
}

/** The body's loading fallback while its lazy chunk arrives: a skeleton in a panel. */
function BodyFallback({ editing }: { editing: boolean }) {
  return (
    <div
      className={cn('surface-panel space-y-2.5 rounded-lg p-4 xl:p-5', editing && 'h-full')}
      aria-busy="true"
      data-widget-state="loading"
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/**
 * A single placed widget: the registry body (lazy, Suspense-fenced) plus, in edit mode,
 * a header with a drag grip and a move/resize/config/remove toolbar. The body is not
 * mounted (so it asks for no data) when the viewer's role cannot read the widget or when
 * row-level scope hides it; its panel shows that state instead. An unknown widget type
 * (reconciled away before render, normally) degrades to an empty state, never a throw.
 */
const WidgetCard = React.memo(function WidgetCard({
  widget,
  editing,
  actions,
  tabbable = true,
  onFocusWidget,
}: WidgetCardProps) {
  const id = widgetId(widget);
  const def = getWidgetDef(widget.type ?? '');
  const data = useOptionalDashboardData();

  if (!def) {
    return (
      <div className={cn(editing && 'h-full')} data-widget-id={id} data-widget-type={widget.type}>
        <EmptyState
          icon={AlertTriangle}
          title="Unavailable widget"
          description="This widget is no longer available."
          compact
        />
      </div>
    );
  }

  const override = titleOverride(widget);
  const options = widgetOptions(widget) as WidgetProps['options'];
  // A gated panel is named as its body would name it ("Open cases by status", not the
  // registry's generic "Case breakdown"), so a reader can tell which panel is missing.
  const title = override ?? defaultWidgetTitle(def, options);
  const can = data?.can;
  const gate: 'denied' | 'scoped' | 'unconfirmed' | null =
    can && !canUseWidget(def, can)
      ? 'denied'
      : isScopeHidden(def, data?.objectScoped)
        ? 'scoped'
        : def.caseDerived === true && data?.scopeError
          ? 'unconfirmed'
          : null;
  const Body = def.Component as React.ComponentType<WidgetProps>;
  const gateState: WidgetState | null =
    gate === 'unconfirmed' ? { kind: 'unconfirmed', onRetry: data?.retryScope } : gate ? { kind: gate } : null;

  return (
    <div
      className="relative flex h-full flex-col"
      data-widget-id={id}
      data-widget-type={widget.type}
      data-widget-gate={gate ?? undefined}
    >
      {editing && actions ? (
        <WidgetEditToolbar
          widget={widget}
          title={title}
          icon={def.icon}
          actions={actions}
          tabbable={tabbable}
          onFocusWidget={() => onFocusWidget?.(id)}
        />
      ) : null}
      {/* VIEW: the body is as tall as its content (F3), never clipped. EDIT: the fixed
          RGL cell clips it and `pt-8` reserves room for the floating toolbar. */}
      <div className={cn('flex min-w-0 flex-1 flex-col', editing && 'min-h-0 overflow-hidden pt-8')}>
        {gateState ? (
          <WidgetShell title={title} state={gateState} className="flex-1" />
        ) : (
          <React.Suspense fallback={<BodyFallback editing={editing} />}>
            {/* The body draws its OWN panel and plain-text title (#9). */}
            <Body id={id} title={override} options={options} />
          </React.Suspense>
        )}
      </div>
    </div>
  );
});

// --------------------------------------------------------------------------- //
// Edit toolbar: drag grip + keyboard-operable move/resize + config/remove.
// --------------------------------------------------------------------------- //

interface WidgetEditToolbarProps {
  widget: DashboardWidget;
  title: string;
  icon: LucideIcon;
  actions: WidgetEditActions;
  tabbable: boolean;
  /** Called when a control in this toolbar gains focus (roving-tabindex tracking). */
  onFocusWidget?: () => void;
}

function WidgetEditToolbar({
  widget,
  title,
  actions,
  tabbable,
  onFocusWidget,
}: WidgetEditToolbarProps) {
  // Roving tabindex: EVERY widget's grip stays in the tab order (tabIndex 0) so a
  // keyboard-only user can Tab to any widget's grip and operate it; focusing a grip
  // marks that widget active, which brings its move/resize/menu controls into the tab
  // order (those roving on `tabbable`). Without a tabbable grip per widget, arrow keys
  // (captured to MOVE, below) would leave every widget after the first unreachable
  // (WCAG 2.1.1). Arrow keys on the grip move the widget (WCAG 2.5.7 non-drag
  // alternative); Shift+arrows resize.
  const onGripKeyDown = (e: React.KeyboardEvent) => {
    const dirMap: Record<string, MoveDir> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    const resizeMap: Record<string, ResizeDir> = {
      ArrowLeft: 'narrower',
      ArrowRight: 'wider',
      ArrowUp: 'shorter',
      ArrowDown: 'taller',
    };
    if (e.key in dirMap) {
      e.preventDefault();
      if (e.shiftKey) actions.onResize(widget, resizeMap[e.key]);
      else actions.onMove(widget, dirMap[e.key]);
    }
  };

  return (
    // Edit chrome floating over the widget body: the ONE Console material (solid under
    // reduced transparency or increased contrast), never a page-local blur.
    <div
      className={cn(
        'absolute inset-x-0 top-0 z-10 flex items-center gap-1 rounded-t-lg border-b border-border px-2 py-1',
        materialBar,
      )}
    >
      {/* The drag grip: the ONLY drag-initiating surface (RGL `handle` selector). Also
          a real, focusable button so keyboard users can move/resize with arrow keys. */}
      <button
        type="button"
        className={cn(
          'card-drag-handle inline-flex h-6 min-h-6 w-6 min-w-6 cursor-grab items-center justify-center rounded-md',
          'text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        // ALWAYS tabbable so keyboard users can reach every widget's grip (focusing it
        // makes this widget active, exposing its roving toolbar controls).
        tabIndex={0}
        aria-label={`Move or resize ${title}. Use arrow keys to move, shift + arrow keys to resize.`}
        onKeyDown={onGripKeyDown}
        onFocus={onFocusWidget}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span className="min-w-0 flex-1 truncate text-2xs font-medium text-muted-foreground">
        {title}
      </span>

      {/* Non-drag move/resize buttons (explicit, always operable). */}
      <div className="flex items-center gap-0.5" role="group" aria-label={`Position ${title}`}>
        <IconBtn label="Move left" onClick={() => actions.onMove(widget, 'left')} tabbable={tabbable}>
          <ArrowLeft className="h-3 w-3" aria-hidden />
        </IconBtn>
        <IconBtn label="Move right" onClick={() => actions.onMove(widget, 'right')} tabbable={tabbable}>
          <ArrowRight className="h-3 w-3" aria-hidden />
        </IconBtn>
        <IconBtn label="Move up" onClick={() => actions.onMove(widget, 'up')} tabbable={tabbable}>
          <ArrowUp className="h-3 w-3" aria-hidden />
        </IconBtn>
        <IconBtn label="Move down" onClick={() => actions.onMove(widget, 'down')} tabbable={tabbable}>
          <ArrowDown className="h-3 w-3" aria-hidden />
        </IconBtn>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-6 min-h-6 w-6 min-w-6 items-center justify-center rounded-md',
              'text-muted-foreground hover:bg-muted hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
            tabIndex={tabbable ? 0 : -1}
            aria-label={`${title} widget options`}
          >
            <MoreVertical className="h-3.5 w-3.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel className="truncate">{title}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => actions.onConfigure(widget)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Configure
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.onResize(widget, 'wider')}>
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            Grow width
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.onResize(widget, 'narrower')}>
            <Minimize2 className="h-3.5 w-3.5" aria-hidden />
            Shrink width
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.onResize(widget, 'taller')}>
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            Grow height
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.onResize(widget, 'shorter')}>
            <Minimize2 className="h-3.5 w-3.5" aria-hidden />
            Shrink height
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => actions.onDuplicate(widget)}>
            <Copy className="h-3.5 w-3.5" aria-hidden />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => actions.onRemove(widget)}
            className="text-critical focus:text-critical"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  tabbable,
  children,
}: {
  label: string;
  onClick: () => void;
  tabbable: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      className={cn(
        'inline-flex h-6 min-h-6 w-6 min-w-6 items-center justify-center rounded-md',
        'text-muted-foreground hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------- //
// WidgetGrid: view (CSS grid, zero RGL) | edit (lazy RGL)
// --------------------------------------------------------------------------- //

export interface WidgetGridProps {
  /** The widgets to render (already reconciled + RBAC-filtered by the caller). */
  widgets: DashboardWidget[];
  /** Edit mode lazily loads react-grid-layout; view mode ships zero grid JS. */
  editing?: boolean;
  /** Grid column count (default 12). */
  cols?: number;
  /**
   * Edit mode's fixed row height in pixels (the RGL cell unit). View mode ignores it:
   * its rows are sized to their content (F3).
   */
  rowHeight?: number;
  /** Edit-mode: called on each RGL layout change (drag/resize); the caller debounces. */
  onLayoutChange?: (layout: GridItemShape[]) => void;
  /** Edit-mode per-widget actions (config/duplicate/remove/move/resize). */
  editActions?: WidgetEditActions;
  className?: string;
}

/**
 * Render a dashboard's widgets. In VIEW mode this is a content-sized CSS grid (no grid
 * lib); in EDIT mode it lazy-loads the RGL editable grid. An empty dashboard renders an
 * `EmptyState` in both modes. The grid is one rule-sheet host for every widget on it.
 */
export function WidgetGrid(props: WidgetGridProps) {
  return (
    <RuleSheetHost>
      <WidgetGridContent {...props} />
    </RuleSheetHost>
  );
}

function WidgetGridContent({
  widgets,
  editing = false,
  cols = GRID_COLS,
  rowHeight = 56,
  onLayoutChange,
  editActions,
  className,
}: WidgetGridProps) {
  // Roving tabindex across widgets in edit mode: the active widget's toolbar controls
  // are tab-reachable. Re-point `activeId` whenever it no longer names a present widget
  // (e.g. the operator removed the active widget) so a stale id can never strand the
  // keyboard user with zero reachable move/resize controls.
  const [activeId, setActiveId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (widgets.length) {
      if (!widgets.some((w) => widgetId(w) === activeId)) setActiveId(widgetId(widgets[0]));
    } else if (activeId !== null) {
      setActiveId(null);
    }
  }, [widgets, activeId]);

  if (!widgets.length) {
    return (
      <div className={className} data-testid="widget-grid-empty">
        <EmptyState
          icon={Pencil}
          title="No widgets yet"
          description={
            editing
              ? 'Add a widget from the gallery to start building this dashboard.'
              : 'This dashboard is empty.'
          }
        />
      </div>
    );
  }

  // ------- EDIT: lazily-loaded react-grid-layout. -------
  if (editing && onLayoutChange && editActions) {
    return (
      <div className={className} data-testid="widget-grid-edit">
        <React.Suspense
          fallback={
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {widgets.map((w) => (
                <Skeleton key={widgetId(w)} className="h-40 w-full rounded-lg" />
              ))}
            </div>
          }
        >
          <WidgetFrameContext.Provider value={EDIT_FRAME}>
            <EditableGrid
              widgets={widgets}
              cols={cols}
              rowHeight={rowHeight}
              onLayoutChange={onLayoutChange}
              renderItem={(w) => (
                <WidgetCard
                  widget={w}
                  editing
                  actions={editActions}
                  tabbable={widgetId(w) === activeId}
                  onFocusWidget={setActiveId}
                />
              )}
            />
          </WidgetFrameContext.Provider>
        </React.Suspense>
      </div>
    );
  }

  // ------- VIEW: a content-sized CSS grid, ZERO grid JS. -------
  return <ViewGrid widgets={widgets} cols={cols} className={className} />;
}

/** Where one widget sits in the view grid. */
export interface ViewGridItem {
  widget: DashboardWidget;
  /** 1-based column line and span on the `cols` tracks. */
  colStart: number;
  colSpan: number;
  /** 1-based row lines (end exclusive) on the content-sized row tracks. */
  rowStart: number;
  rowEnd: number;
  /**
   * Columns the widget spans on the two-column laptop grid (1024 to 1279 px): 2 for a
   * full-width widget, 1 for a half; see {@link laptopSpans}.
   */
  lgSpan: 1 | 2;
}

export interface ViewGridPlacement {
  /** In reading order: top to bottom, then left to right (the DOM and one-column order). */
  items: ViewGridItem[];
  /** How many `auto` row tracks the wide grid has. */
  rows: number;
}

/**
 * Place widgets on the content-sized view grid (F3). `packWidgets` first flow-packs an
 * unplaced default (every widget at 0,0) and repairs overlaps, exactly as edit mode
 * compacts it. Then each distinct top or bottom edge becomes a row line, and a row track
 * no widget covers (a vertical gap in a saved layout) is dropped, so it can never leave
 * an empty band. Every track is sized `auto`: a panel takes the height of its content,
 * and the panels that share a track share its height. Pure.
 */
export function viewGridPlacement(widgets: readonly DashboardWidget[], cols: number = GRID_COLS): ViewGridPlacement {
  const placed = packWidgets(widgets, cols).map((w) => {
    const g = w as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);
    const x = Math.max(0, Math.min(cols - 1, num(g.x, 0)));
    const width = Math.max(1, Math.min(cols - x, num(g.w, 4)));
    const y = Math.max(0, num(g.y, 0));
    const height = Math.max(1, num(g.h, 4));
    return { w, x, width, y, height };
  });
  // Row lines: every distinct edge, keeping only the intervals some widget covers.
  const edges = [...new Set(placed.flatMap((p) => [p.y, p.y + p.height]))].sort((a, b) => a - b);
  const covered: Array<[number, number]> = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const [lo, hi] = [edges[i], edges[i + 1]];
    if (placed.some((p) => p.y <= lo && p.y + p.height >= hi)) covered.push([lo, hi]);
  }
  const ordered = placed.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const spans = laptopSpans(ordered.map((p) => p.width >= cols));
  const items = ordered.map((p, i) => {
    const first = covered.findIndex(([lo]) => lo >= p.y);
    let last = first;
    while (last + 1 < covered.length && covered[last + 1][1] <= p.y + p.height) last += 1;
    return {
      widget: p.w,
      colStart: p.x + 1,
      colSpan: p.width,
      rowStart: first + 1,
      rowEnd: last + 2,
      lgSpan: spans[i],
    };
  });
  return { items, rows: covered.length };
}

/**
 * The spans on the two-column laptop grid, in reading order, so the grid never leaves a
 * hole and the DOM order stays the visual order (no `dense` packing). A widget as wide as
 * the board takes a full row; the others pair up two to a row. A half left without a
 * partner (before a full-width widget, or at the end) widens to the full row. Pure.
 */
export function laptopSpans(fullWidth: readonly boolean[]): Array<1 | 2> {
  const spans: Array<1 | 2> = fullWidth.map((full) => (full ? 2 : 1));
  let pending: number | null = null;
  fullWidth.forEach((full, i) => {
    if (full) {
      if (pending != null) spans[pending] = 2;
      pending = null;
    } else if (pending == null) {
      pending = i;
    } else {
      pending = null;
    }
  });
  if (pending != null) spans[pending] = 2;
  return spans;
}

/**
 * VIEW-mode grid, in reading order at every width: one column on a phone and a tablet,
 * two from `lg` (1024 px, the laptop widths where one column made every module a full
 * page wide), and from `xl` the 12 columns with content-sized rows. The wide placement
 * rides on CSS custom properties so the narrower layouts can ignore it (an inline
 * `grid-column` could not be undone at a breakpoint); the `xl` rules come later in the
 * stylesheet, so they override the two-column spans.
 */
function ViewGrid({
  widgets,
  cols,
  className,
}: {
  widgets: DashboardWidget[];
  cols: number;
  className?: string;
}) {
  const placement = React.useMemo(() => viewGridPlacement(widgets, cols), [widgets, cols]);
  return (
    <WidgetFrameContext.Provider value={VIEW_FRAME}>
      <div
        className={cn(
          // One panel gutter, equal to the panel padding (16, 20 from 1280, 24 from 1920
          // px), exactly as the Cyber Defence Center spaces its modules (SPEC §4.9.1).
          'grid w-full grid-cols-1 lg:grid-cols-2',
          PANEL_GAP,
          'xl:[grid-template-columns:var(--wg-cols)] xl:[grid-template-rows:var(--wg-rows)]',
          className,
        )}
        data-testid="widget-grid-view"
        style={
          {
            '--wg-cols': `repeat(${cols}, minmax(0, 1fr))`,
            '--wg-rows': `repeat(${Math.max(1, placement.rows)}, auto)`,
          } as React.CSSProperties
        }
      >
        {placement.items.map((it) => (
          <div
            key={widgetId(it.widget)}
            className={cn(
              'flex min-w-0 flex-col',
              it.lgSpan === 2 ? 'lg:col-span-2' : 'lg:col-span-1',
              'xl:[grid-column:var(--wg-col)] xl:[grid-row:var(--wg-row)]',
            )}
            data-grid-cell=""
            style={
              {
                '--wg-col': `${it.colStart} / span ${it.colSpan}`,
                '--wg-row': `${it.rowStart} / ${it.rowEnd}`,
              } as React.CSSProperties
            }
          >
            <WidgetCard widget={it.widget} editing={false} />
          </div>
        ))}
      </div>
    </WidgetFrameContext.Provider>
  );
}

export default WidgetGrid;
