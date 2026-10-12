/**
 * `WidgetGrid` — renders a dashboard's widgets from its `DashboardLayout` (Round 5 /
 * G7, CD3). It has TWO modes that ship very different amounts of JavaScript:
 *
 *   • VIEW mode (default, read-only) — a plain CSS Grid. Each widget is positioned by
 *     inline `gridColumn`/`gridRow` from its persisted `{x,y,w,h}` (12-col units). This
 *     path imports NO react-grid-layout at all: view mode + first paint ship ZERO grid
 *     JS (the `bundle-first-paint` guardrail). This is the calm, read-only default (#10).
 *
 *   • EDIT mode — lazily `import()`s {@link EditableGrid} (the sole RGL importer) and
 *     hands it the same widgets. RGL + its CSS load ONLY here, on demand, wrapped in
 *     `<Suspense>`. Drag is scoped to the card header grip; resize is SE-corner only;
 *     `onLayoutChange` bubbles to the builder to debounce-persist.
 *
 * Each widget body comes from the widget registry (`registry.ts` — a `React.lazy`
 * component per type, RBAC-gated, reconcile-on-load already applied by the caller) and
 * is wrapped in a small card frame that carries, in edit mode, the drag handle plus a
 * keyboard-operable move/resize toolbar (WCAG 2.5.7 — a NON-drag alternative). All
 * widget titles/labels render as plain text/SVG (#9); a layout is advisory (#3).
 *
 * The heavy RGL chunk is behind `React.lazy(() => import('./EditableGrid'))` declared
 * at MODULE scope so it is created once, but the dynamic import only FIRES when edit
 * mode first renders it — so importing `WidgetGrid` itself pulls no grid JS.
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

import type { DashboardWidget } from '@/lib/types';
import { getWidgetDef } from './registry';
import type { WidgetProps } from './widgets/common';
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
// but the dynamic import only executes when <EditableGrid> is first rendered — i.e.
// when the operator enters edit mode. View mode never touches it.
const EditableGrid = React.lazy(() => import('./EditableGrid'));

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

/** Resolve the registry title override safely (plain text, #9). */
function resolveWidgetTitle(widget: DashboardWidget, fallback: string): string {
  const opts = widgetOptions(widget);
  const t = opts.title;
  const s = (typeof t === 'string' ? t : '').trim();
  return s || fallback;
}

/**
 * A single placed widget: the registry body (lazy, Suspense-fenced) plus, in edit
 * mode, a header with a drag grip and a move/resize/config/remove toolbar. An unknown
 * widget type (should be reconciled away before render) degrades to an EmptyState
 * rather than throwing.
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

  if (!def) {
    return (
      <div className="h-full">
        <EmptyState
          icon={AlertTriangle}
          title="Unavailable widget"
          description="This widget is no longer available."
          compact
        />
      </div>
    );
  }

  const Body = def.Component as React.ComponentType<WidgetProps>;
  const title = resolveWidgetTitle(widget, def.title);
  const options = widgetOptions(widget) as WidgetProps['options'];

  return (
    <div
      className="relative flex h-full flex-col"
      data-widget-id={id}
      data-widget-type={widget.type}
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
      {/* `overflow-hidden` clips a tall body to its cell so it can never spill over the
          widget below (the WidgetShell ChartCard is `h-full` and scroll-safe). In edit
          mode `pt-8` reserves room for the absolutely-positioned toolbar so it never
          occludes the widget's own card header. */}
      <div className={cn('min-h-0 flex-1 overflow-hidden', editing && 'pt-8')}>
        <React.Suspense
          fallback={
            <div className="space-y-2.5 p-4" aria-busy="true">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          }
        >
          {/* The widget body renders its OWN ChartCard chrome + plain-text title (#9). */}
          <Body id={id} title={title} options={options} />
        </React.Suspense>
      </div>
    </div>
  );
});

// --------------------------------------------------------------------------- //
// Edit toolbar — drag grip + keyboard-operable move/resize + config/remove.
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
  // keyboard-only user can Tab to any widget's grip and operate it — focusing a grip
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
      {/* The drag grip — the ONLY drag-initiating surface (RGL `handle` selector). Also
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
// WidgetGrid — view (CSS grid, zero RGL) | edit (lazy RGL)
// --------------------------------------------------------------------------- //

export interface WidgetGridProps {
  /** The widgets to render (already reconciled + RBAC-filtered by the caller). */
  widgets: DashboardWidget[];
  /** Edit mode lazily loads react-grid-layout; view mode ships zero grid JS. */
  editing?: boolean;
  /** Grid column count (default 12). */
  cols?: number;
  /** Row height in pixels for both modes (keeps view ↔ edit visually consistent). */
  rowHeight?: number;
  /** Edit-mode: called on each RGL layout change (drag/resize) — caller debounces. */
  onLayoutChange?: (layout: GridItemShape[]) => void;
  /** Edit-mode per-widget actions (config/duplicate/remove/move/resize). */
  editActions?: WidgetEditActions;
  className?: string;
}

/**
 * Render a dashboard's widgets. In VIEW mode this is a plain CSS grid (no grid lib);
 * in EDIT mode it lazy-loads the RGL editable grid. An empty dashboard renders an
 * `EmptyState` in both modes.
 */
export function WidgetGrid({
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
        </React.Suspense>
      </div>
    );
  }

  // ------- VIEW: plain CSS grid — ZERO grid JS. -------
  // Position each widget by its persisted {x,y,w,h} over a `cols`-track grid. Row
  // height is fixed so the CSS grid visually matches the RGL edit grid. `packWidgets`
  // is the view-mode analogue of RGL compaction: it flows an UNPLACED default (every
  // widget at 0,0 — the per-role landing dashboard) into a coherent grid and repairs
  // any overlap, while returning a valid saved layout unchanged (idempotent).
  return (
    <ViewGrid widgets={widgets} cols={cols} rowHeight={rowHeight} className={className} />
  );
}

/** VIEW-mode CSS grid (extracted so the packing memo has a stable hook position). */
function ViewGrid({
  widgets,
  cols,
  rowHeight,
  className,
}: {
  widgets: DashboardWidget[];
  cols: number;
  rowHeight: number;
  className?: string;
}) {
  const placed = React.useMemo(() => packWidgets(widgets, cols), [widgets, cols]);
  return (
    <div
      className={cn('w-full', className)}
      data-testid="widget-grid-view"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: `${rowHeight}px`,
        gap: '16px',
      }}
    >
      {placed.map((w) => {
        const anyW = w as Record<string, number | undefined>;
        const x = Math.max(0, Math.min(cols - 1, anyW.x ?? 0));
        const width = Math.max(1, Math.min(cols - x, anyW.w ?? 4));
        const y = Math.max(0, anyW.y ?? 0);
        const height = Math.max(1, anyW.h ?? 4);
        return (
          <div
            key={widgetId(w)}
            style={{
              gridColumn: `${x + 1} / span ${width}`,
              gridRow: `${y + 1} / span ${height}`,
              minWidth: 0,
            }}
          >
            <WidgetCard widget={w} editing={false} />
          </div>
        );
      })}
    </div>
  );
}

export default WidgetGrid;
