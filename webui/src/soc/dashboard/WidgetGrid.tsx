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
 *     bubbles to the builder to debounce-persist. A cell too narrow for the whole toolbar
 *     keeps the grip, the title and the options menu, and the menu takes the four moves,
 *     so no control is ever cut off.
 *
 *   - EDIT mode on a narrow board (under {@link NARROW_EDIT_MAX_WIDTH} px, a phone or a
 *     narrow window; once there, until the board is {@link NARROW_EDIT_HYSTERESIS} px
 *     wider, so a scrollbar that comes with one arrangement cannot flip it back): no grid
 *     and no react-grid-layout. The widgets stack one per row at full width, in the
 *     reading order view mode uses, each sized to its content, with 44 px Move up, Move
 *     down and options controls. The stored 12-column layout is only read and reordered
 *     there ({@link reorderWidget}: the wider layout keeps its shape), never replaced by
 *     one-column geometry, and `onLayoutChange` is never called. A moved widget's button
 *     stays where it was pressed, so the next tap moves the same widget.
 *
 * In both edit arrangements one polite status says what changed: a widget moved, added
 * ("added at position 4 of 10"), copied or removed; every message is a new node, so the
 * same words twice are announced twice. Removing a widget puts the focus on
 * the options button of the widget that takes its place in the reading order (the one
 * before it when it was last, the host's Add widget button when the board is empty),
 * never on the page.
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
import { bottomBarClearance } from '@/soc/hooks/useToastClearance';

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
  editGeometry,
  gridCellWidth,
  packWidgets,
  readingOrder,
  readingPosition,
  widgetId,
  widgetOptions,
  widgetToItem,
  type GridItemShape,
  type MoveDir,
  type ReorderDir,
  type ResizeDir,
} from './layout-utils';

// The ONE lazy boundary for react-grid-layout. Declared at module scope (created once)
// but the dynamic import only executes when <EditableGrid> is first rendered, i.e.
// when the operator enters edit mode. View mode never touches it.
const EditableGrid = React.lazy(() => import('./EditableGrid'));

/** What a body is told about its cell: content-sized (view) or fixed (edit). */
const VIEW_FRAME: WidgetFrameMode = 'view';
const EDIT_FRAME: WidgetFrameMode = 'edit';

/**
 * Below this board width (px) Edit mode is the one-column list, not the 12-column grid:
 * at 640 px a quarter-width widget is about 200 px wide, and under it widgets were
 * squeezed into columns too narrow for their own text (SPEC §4.4.5 Phone). Once the
 * board is the list it goes back to the grid only from this width plus
 * {@link NARROW_EDIT_HYSTERESIS}.
 */
export const NARROW_EDIT_MAX_WIDTH = 640;

/**
 * How much wider than {@link NARROW_EDIT_MAX_WIDTH} (px) a board in the one-column list
 * must grow before it is the grid again. The board's width depends on the arrangement:
 * with classic scrollbars (Windows, most Linux desktops) the grid's fixed-height cells can
 * make the page tall enough for a vertical scrollbar, the content-sized list can make it
 * short enough to drop one, and the board changes width by the scrollbar's (up to 17 px).
 * A single cut at 640 px then flipped grid, list, grid on every frame; inside this band the
 * board keeps the arrangement it has.
 */
export const NARROW_EDIT_HYSTERESIS = 24;

/**
 * The narrowest grid cell (px) that holds the whole edit toolbar: padding 16, grip 24,
 * four arrows 102, menu 24, three gaps 12 and at least 64 for the title. A narrower
 * cell shows the compact toolbar (grip, title, menu), whose menu takes the four moves.
 */
export const FULL_TOOLBAR_MIN_WIDTH = 248;

/** How Edit mode lays the widgets out: the 12-column grid, or one column on a narrow board. */
export type EditArrangement = 'grid' | 'list';

/** Which edit toolbar a widget gets: full, compact (narrow grid cell) or the list's. */
type ToolbarVariant = 'grid' | 'compact' | 'list';

/** A widget's edit control the board moves the focus to. */
export type WidgetControl = 'up' | 'down' | 'options';

/**
 * The `control` of the widget `id` under `root` (the list's Move up or Move down, or the
 * options button), or `null`. Matched by attribute value, never by a selector built from
 * the id (a stored id is untrusted text, #9).
 */
export function findWidgetControl(
  root: ParentNode | null | undefined,
  id: string,
  control: WidgetControl,
): HTMLElement | null {
  if (!root) return null;
  const card = Array.from(root.querySelectorAll<HTMLElement>('[data-widget-id]')).find(
    (el) => el.getAttribute('data-widget-id') === id,
  );
  if (!card) return null;
  return card.querySelector<HTMLElement>(control === 'options' ? '[data-widget-options]' : `[data-reorder="${control}"]`);
}

/** The shell's sticky top bar (`--header-h`, 56 px) that a control must stay below. */
function topBarHeight(): number {
  if (typeof window === 'undefined') return 0;
  const value = Number.parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--header-h'));
  return Number.isFinite(value) && value > 0 ? value : 56;
}

/** The space kept between a revealed control and the bars above and below it. */
const REVEAL_GAP_PX = 8;

/**
 * Scroll the page so `el` is in view between the shell's top bar and a pinned Save and
 * Discard bar (WCAG 2.4.11, Focus Not Obscured): at `preferredTop` (a viewport y) when that
 * is clear of both, else as close to it as they allow. Without a preference it scrolls
 * only when `el` is hidden. No-op where layout gives `el` no size. Returns the distance
 * scrolled.
 */
export function revealControl(el: HTMLElement, preferredTop?: number): number {
  if (typeof window === 'undefined') return 0;
  const rect = el.getBoundingClientRect();
  if (!(rect.height > 0)) return 0;
  const minTop = topBarHeight() + REVEAL_GAP_PX;
  const maxTop = Math.max(minTop, window.innerHeight - bottomBarClearance() - REVEAL_GAP_PX - rect.height);
  const want = Math.min(maxTop, Math.max(minTop, preferredTop ?? rect.top));
  const delta = Math.round(rect.top - want);
  if (delta === 0 || typeof window.scrollBy !== 'function') return 0;
  window.scrollBy({ top: delta, behavior: 'instant' });
  return delta;
}

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
  /**
   * The one-column list's Move up and Move down: one place along the reading order
   * ({@link reorderWidget}). Without it the list falls back to `onMove`.
   */
  onReorder?: (widget: DashboardWidget, dir: ReorderDir) => void;
}

interface WidgetCardProps {
  widget: DashboardWidget;
  editing: boolean;
  actions?: WidgetEditActions;
  /** Roving-tabindex: is THIS widget the currently keyboard-focusable one? */
  tabbable?: boolean;
  onFocusWidget?: (id: string) => void;
  /** The edit toolbar: full (default), compact (a narrow grid cell) or the list's. */
  toolbar?: ToolbarVariant;
  /** In the one-column list: whether the widget is first or last (its move ends). */
  first?: boolean;
  last?: boolean;
}

/** The title a widget's panel shows: the operator's override, else its type's default. */
function widgetTitle(widget: DashboardWidget): string {
  const def = getWidgetDef(widget.type ?? '');
  const override = titleOverride(widget);
  if (override) return override;
  return def ? defaultWidgetTitle(def, widgetOptions(widget) as WidgetProps['options']) : 'Unavailable widget';
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
  toolbar = 'grid',
  first = false,
  last = false,
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
          variant={toolbar}
          first={first}
          last={last}
        />
      ) : null}
      {/* VIEW and the one-column edit list: the body is as tall as its content (F3),
          never clipped. EDIT grid: the fixed RGL cell clips it, and `pt-8` reserves room
          for the toolbar over it (the list's toolbar sits above the body in the flow). */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          editing && toolbar !== 'list' && 'min-h-0 overflow-hidden pt-8',
        )}
      >
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
  /** Full (a wide grid cell), compact (a narrow one) or the one-column list's. */
  variant: ToolbarVariant;
  /** In the list: the first widget cannot move up, the last cannot move down. */
  first: boolean;
  last: boolean;
}

/** The grid's four moves, as buttons (full toolbar) or menu items (compact toolbar). */
const GRID_MOVES: ReadonlyArray<{ dir: MoveDir; label: string; Icon: LucideIcon }> = [
  { dir: 'left', label: 'Move left', Icon: ArrowLeft },
  { dir: 'right', label: 'Move right', Icon: ArrowRight },
  { dir: 'up', label: 'Move up', Icon: ArrowUp },
  { dir: 'down', label: 'Move down', Icon: ArrowDown },
];

function WidgetEditToolbar({
  widget,
  title,
  actions,
  tabbable,
  onFocusWidget,
  variant,
  first,
  last,
}: WidgetEditToolbarProps) {
  const list = variant === 'list';
  // The list has no roving tab stop (it has no grip): every control is in the tab order.
  const reachable = list || tabbable;
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
  const reorder = (dir: ReorderDir) => {
    if (actions.onReorder) actions.onReorder(widget, dir);
    else actions.onMove(widget, dir);
  };

  return (
    // Edit chrome over the widget body: the ONE Console material (solid under reduced
    // transparency or increased contrast), never a page-local blur. It never scrolls or
    // clips: a control that does not fit moves into the options menu. In the one-column
    // list (a phone) it sits above the body in the flow, and its controls are 44 px
    // targets 8 px apart: there they are the widget's primary controls.
    <div
      className={cn(
        'z-10 flex min-w-0 items-center rounded-t-lg border-b border-border px-2 py-1',
        list ? 'relative gap-2' : 'absolute inset-x-0 top-0 gap-1',
        materialBar,
      )}
      data-widget-toolbar={variant}
    >
      {list ? null : (
        // The drag grip: the ONLY drag-initiating surface (RGL `handle` selector). Also a
        // real, focusable button so keyboard users can move/resize with arrow keys.
        <button
          type="button"
          className={cn(
            'card-drag-handle inline-flex h-6 min-h-6 w-6 min-w-6 shrink-0 cursor-grab items-center justify-center rounded-md',
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
      )}
      <span className={cn('min-w-0 flex-1 truncate text-2xs font-medium text-muted-foreground', list && 'pl-1')}>
        {title}
      </span>

      {list ? (
        // The list's order is the board's reading order: up and down are the moves there.
        // Each is named for its widget, so a screen reader's list of buttons tells them apart.
        <div className="flex shrink-0 items-center gap-2" role="group" aria-label={`Position ${title}`}>
          <IconBtn label={`Move ${title} up`} onClick={() => reorder('up')} tabbable disabled={first} reorder="up" large>
            <ArrowUp className="h-4 w-4" aria-hidden />
          </IconBtn>
          <IconBtn
            label={`Move ${title} down`}
            onClick={() => reorder('down')}
            tabbable
            disabled={last}
            reorder="down"
            large
          >
            <ArrowDown className="h-4 w-4" aria-hidden />
          </IconBtn>
        </div>
      ) : variant === 'grid' ? (
        // Non-drag move buttons (explicit, always operable).
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={`Position ${title}`}>
          {GRID_MOVES.map(({ dir, label, Icon }) => (
            <IconBtn key={dir} label={label} onClick={() => actions.onMove(widget, dir)} tabbable={tabbable}>
              <Icon className="h-3 w-3" aria-hidden />
            </IconBtn>
          ))}
        </div>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-md',
              list ? 'h-11 min-h-11 w-11 min-w-11' : 'h-6 min-h-6 w-6 min-w-6',
              'text-muted-foreground hover:bg-muted hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
            tabIndex={reachable ? 0 : -1}
            aria-label={`${title} widget options`}
            data-widget-options=""
          >
            <MoreVertical className={list ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel className="truncate">{title}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => actions.onConfigure(widget)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Configure
          </DropdownMenuItem>
          {variant === 'compact' ? (
            <>
              <DropdownMenuSeparator />
              {GRID_MOVES.map(({ dir, label, Icon }) => (
                <DropdownMenuItem key={dir} onSelect={() => actions.onMove(widget, dir)}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  {label}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          {list ? null : (
            <>
              <DropdownMenuSeparator />
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
            </>
          )}
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
  disabled = false,
  reorder,
  large = false,
  children,
}: {
  label: string;
  onClick: () => void;
  tabbable: boolean;
  /**
   * Shown and focusable but inert (`aria-disabled`), so the focus stays on it when a move
   * takes the widget to the end of the list.
   */
  disabled?: boolean;
  /** The list's move this button makes (where focus returns after the list reorders). */
  reorder?: ReorderDir;
  /** A 44 px target (the one-column list on a phone), else 24 px in a grid cell. */
  large?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-reorder={reorder}
      className={cn(
        'inline-flex items-center justify-center rounded-md',
        large ? 'h-11 min-h-11 w-11 min-w-11' : 'h-6 min-h-6 w-6 min-w-6',
        'text-muted-foreground hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground',
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
  /**
   * Edit mode: told when the board switches between the 12-column grid and the
   * one-column list (a narrow board), so the host can word its hints for it.
   */
  onArrangementChange?: (arrangement: EditArrangement) => void;
  /**
   * Edit mode: the id of the widget the host just added from the gallery. The board says
   * where it landed ("<title> added at position 4 of 10."); the host moves the focus.
   */
  lastAddedId?: string | null;
  /**
   * Edit mode: where the focus goes when the last widget is removed (the host's Add
   * widget button), so it never falls back to the page.
   */
  focusWhenEmpty?: () => HTMLElement | null;
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

/**
 * The width of `ref`'s element while `active`, kept current with a ResizeObserver: `null`
 * until it is measured (and while inactive), `0` where layout gives no width (a test DOM).
 * Measured in a layout effect, so the first painted frame already uses it.
 */
function useMeasuredWidth(ref: React.RefObject<HTMLElement | null>, active: boolean): number | null {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setWidth(null);
      return undefined;
    }
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, active]);
  return width;
}

/**
 * How Edit mode lays a board `width` px wide out, given the `current` arrangement (`null`
 * when there is none yet): one column under {@link NARROW_EDIT_MAX_WIDTH}, else the grid,
 * except that a board already in the list stays there until it is
 * {@link NARROW_EDIT_HYSTERESIS} px wider than that, so a width that changes with the
 * arrangement (a scrollbar coming and going) cannot flip it back and forth. An unknown
 * width (`null` before it is measured, `0` where layout gives none) keeps the current
 * arrangement, else is the grid. Pure.
 */
export function editArrangement(width: number | null, current: EditArrangement | null = null): EditArrangement {
  if (width == null || !(width > 0)) return current ?? 'grid';
  const limit = current === 'list' ? NARROW_EDIT_MAX_WIDTH + NARROW_EDIT_HYSTERESIS : NARROW_EDIT_MAX_WIDTH;
  return width < limit ? 'list' : 'grid';
}

/**
 * The edit toolbar a widget gets in the grid on a board `width` px wide: compact when its
 * cell is narrower than {@link FULL_TOOLBAR_MIN_WIDTH}. An unknown width keeps the full
 * toolbar. Pure.
 */
export function gridToolbarVariant(widget: DashboardWidget, width: number | null, cols: number = GRID_COLS): ToolbarVariant {
  if (width == null || width <= 0) return 'grid';
  return gridCellWidth(widgetToItem(widget, cols).w, width, cols) < FULL_TOOLBAR_MIN_WIDTH ? 'compact' : 'grid';
}

/** A change whose outcome the board announces (and, for a removal, where focus goes). */
type PendingChange =
  | { kind: 'remove'; id: string; title: string; index: number }
  | { kind: 'duplicate'; title: string; before: ReadonlySet<string> };

function WidgetGridContent({
  widgets,
  editing = false,
  cols = GRID_COLS,
  rowHeight = 56,
  onLayoutChange,
  editActions,
  onArrangementChange,
  lastAddedId = null,
  focusWhenEmpty,
  className,
}: WidgetGridProps) {
  // Roving tabindex across widgets in edit mode: the active widget's toolbar controls
  // are tab-reachable. Re-point `activeId` whenever it no longer names a present widget
  // (e.g. the operator removed the active widget) so a stale id can never strand the
  // keyboard user with zero reachable move/resize controls.
  // (A functional update, so a removal that already handed the focus, and the roving
  // stop, to the next widget is not undone here.)
  const [activeId, setActiveId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setActiveId((current) =>
      widgets.length === 0
        ? null
        : widgets.some((w) => widgetId(w) === current)
          ? current
          : widgetId(widgets[0]),
    );
  }, [widgets]);

  // Edit mode measures the board: a narrow one edits as one column (no grid JS loads),
  // and a grid cell too narrow for the whole toolbar gets the compact one.
  const handlers = editing && onLayoutChange && editActions ? { onLayoutChange, editActions } : null;
  const edit = handlers !== null;
  const editRef = React.useRef<HTMLDivElement | null>(null);
  const width = useMeasuredWidth(editRef, edit);
  // The arrangement depends on the one before it (the hysteresis band), so it is state,
  // brought up to date during the render that sees a new width (React's "information
  // from previous renders" pattern): no commit ever shows a stale arrangement.
  const [shownArrangement, setShownArrangement] = React.useState<EditArrangement | null>(null);
  const arrangement = width == null ? null : editArrangement(width, shownArrangement);
  if (arrangement !== shownArrangement) setShownArrangement(arrangement);
  const arrangementRef = React.useRef(onArrangementChange);
  React.useEffect(() => {
    arrangementRef.current = onArrangementChange;
  }, [onArrangementChange]);
  // Before paint, so the host's first painted hint already fits the arrangement.
  React.useLayoutEffect(() => {
    if (arrangement) arrangementRef.current?.(arrangement);
  }, [arrangement]);

  // One polite status for Edit mode, in both arrangements: what the last change did. Each
  // message is a new node (keyed by a count), so a repeat of the same words ("Human vs AI
  // removed." for a copy, then for its original) is still a change a screen reader hears.
  const [status, setStatus] = React.useState<{ text: string; n: number }>({ text: '', n: 0 });
  const announce = React.useCallback((text: string) => setStatus((s) => ({ text, n: s.n + 1 })), []);
  const widgetsRef = React.useRef(widgets);
  React.useLayoutEffect(() => {
    widgetsRef.current = widgets;
  }, [widgets]);
  const focusWhenEmptyRef = React.useRef(focusWhenEmpty);
  React.useEffect(() => {
    focusWhenEmptyRef.current = focusWhenEmpty;
  }, [focusWhenEmpty]);
  const pendingRef = React.useRef<PendingChange | null>(null);
  const editActionsIn = handlers?.editActions;
  const boardActions = React.useMemo<WidgetEditActions | null>(() => {
    if (!editActionsIn) return null;
    return {
      ...editActionsIn,
      onRemove: (widget) => {
        // The widget's menu took the focus with it, so it would fall to the page: it moves
        // to the widget that takes the removed one's place in the reading order.
        const current = widgetsRef.current;
        const id = widgetId(widget);
        const index = (readingPosition(current, id, cols)?.position ?? 1) - 1;
        pendingRef.current = { kind: 'remove', id, title: widgetTitle(widget), index };
        editActionsIn.onRemove(widget);
      },
      onDuplicate: (widget) => {
        pendingRef.current = {
          kind: 'duplicate',
          title: widgetTitle(widget),
          before: new Set(widgetsRef.current.map(widgetId)),
        };
        editActionsIn.onDuplicate(widget);
      },
    };
  }, [editActionsIn, cols]);

  React.useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    if (pending.kind === 'remove') {
      if (widgets.some((w) => widgetId(w) === pending.id)) return;
      // The order the board reads in now (the widgets below may have risen into the gap).
      const geometry = editGeometry(widgets, cols);
      const order = readingOrder(geometry, cols).map((i) => widgetId(geometry[i]));
      const nextId = order.length ? order[Math.min(pending.index, order.length - 1)] : null;
      const target = nextId
        ? findWidgetControl(editRef.current, nextId, 'options')
        : (focusWhenEmptyRef.current?.() ?? null);
      if (target) {
        if (nextId) setActiveId(nextId);
        revealControl(target);
        target.focus({ preventScroll: true });
      }
      announce(`${pending.title} removed.`);
      return;
    }
    const copy = widgets.find((w) => !pending.before.has(widgetId(w)));
    const where = copy ? readingPosition(widgets, widgetId(copy), cols) : null;
    if (where) announce(`${pending.title} copied to position ${where.position} of ${where.total}.`);
  }, [widgets, cols, announce]);

  // A widget added from the gallery: say where it landed, once.
  const announcedAddRef = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    if (!edit || !lastAddedId || announcedAddRef.current === lastAddedId) return;
    const added = widgets.find((w) => widgetId(w) === lastAddedId);
    const where = added ? readingPosition(widgets, lastAddedId, cols) : null;
    if (!added || !where) return;
    announcedAddRef.current = lastAddedId;
    announce(`${widgetTitle(added)} added at position ${where.position} of ${where.total}.`);
  }, [edit, lastAddedId, widgets, cols, announce]);

  // A new Edit session starts with a quiet status.
  React.useEffect(() => {
    if (!edit) setStatus((s) => (s.text ? { text: '', n: s.n } : s));
  }, [edit]);

  const emptyState = (
    <EmptyState
      icon={Pencil}
      title="No widgets yet"
      description={
        edit ? 'Add a widget from the gallery to start building this dashboard.' : 'This dashboard is empty.'
      }
    />
  );

  if (!handlers || !boardActions) {
    if (!widgets.length) {
      return (
        <div className={className} data-testid="widget-grid-empty">
          {emptyState}
        </div>
      );
    }
    // ------- VIEW: a content-sized CSS grid, ZERO grid JS. -------
    return <ViewGrid widgets={widgets} cols={cols} className={className} />;
  }

  const skeleton = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      {widgets.map((w) => (
        <Skeleton key={widgetId(w)} className="h-40 w-full rounded-lg" />
      ))}
    </div>
  );

  let body: React.ReactNode;
  if (!widgets.length) {
    body = emptyState;
  } else if (arrangement === null) {
    // The board is measured before the first paint: this pass only holds the place.
    body = skeleton;
  } else if (arrangement === 'list') {
    // ------- EDIT, narrow board: one column, no grid library. -------
    body = <EditList widgets={widgets} cols={cols} actions={boardActions} onAnnounce={announce} />;
  } else {
    // ------- EDIT: lazily-loaded react-grid-layout. -------
    body = (
      <React.Suspense fallback={skeleton}>
        <WidgetFrameContext.Provider value={EDIT_FRAME}>
          <EditableGrid
            widgets={widgets}
            cols={cols}
            rowHeight={rowHeight}
            onLayoutChange={handlers.onLayoutChange}
            renderItem={(w) => (
              <WidgetCard
                widget={w}
                editing
                actions={boardActions}
                tabbable={widgetId(w) === activeId}
                onFocusWidget={setActiveId}
                toolbar={gridToolbarVariant(w, width, cols)}
              />
            )}
          />
        </WidgetFrameContext.Provider>
      </React.Suspense>
    );
  }

  return (
    <div
      ref={editRef}
      className={className}
      data-testid={widgets.length ? 'widget-grid-edit' : 'widget-grid-empty'}
      data-edit-arrangement={arrangement ?? undefined}
    >
      {body}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-edit-status="">
        <span key={status.n}>{status.text}</span>
      </div>
    </div>
  );
}

/**
 * Edit mode on a narrow board: every widget at full width, one per row, in the reading
 * order view mode stacks the board in (of the edit geometry, so a move always swaps the
 * neighbours shown). Bodies are content-sized, as in view mode, so nothing is squeezed or
 * cut off. Move up and Move down reorder ({@link reorderWidget} in the builder): the
 * pressed button stays where it was on the screen while its widget moves (the page
 * scrolls with it, clear of the top bar and the Save and Discard bar), it keeps the
 * focus, and the board's status says where the widget went. Widths and heights are
 * changed on a wider screen, where the grid is (a move only trades the two widgets' sizes
 * where keeping them would leave a gap there; see {@link reorderWidget}).
 */
function EditList({
  widgets,
  cols,
  actions,
  onAnnounce,
}: {
  widgets: DashboardWidget[];
  cols: number;
  actions: WidgetEditActions;
  onAnnounce: (message: string) => void;
}) {
  const ordered = React.useMemo(() => readingOrder(editGeometry(widgets, cols), cols).map((i) => widgets[i]), [widgets, cols]);
  const listRef = React.useRef<HTMLOListElement | null>(null);
  // The widget the person just moved, the button they pressed and where it was on the
  // screen: the reorder moves its node in the DOM (which drops the focus) and down the
  // page, so both are put back after the render.
  const pendingRef = React.useRef<{ id: string; dir: ReorderDir; top: number | undefined } | null>(null);

  React.useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const position = ordered.findIndex((w) => widgetId(w) === pending.id);
    if (position < 0) return;
    const button = findWidgetControl(listRef.current, pending.id, pending.dir);
    if (button) {
      revealControl(button, pending.top);
      button.focus({ preventScroll: true });
    }
    onAnnounce(`${widgetTitle(ordered[position])} moved to position ${position + 1} of ${ordered.length}.`);
  }, [ordered, onAnnounce]);

  const listActions = React.useMemo<WidgetEditActions>(
    () => ({
      ...actions,
      onReorder: (widget, dir) => {
        const id = widgetId(widget);
        const pressed = findWidgetControl(listRef.current, id, dir);
        const rect = pressed?.getBoundingClientRect();
        pendingRef.current = { id, dir, top: rect && rect.height > 0 ? rect.top : undefined };
        if (actions.onReorder) actions.onReorder(widget, dir);
        else actions.onMove(widget, dir);
      },
    }),
    [actions],
  );

  return (
    <WidgetFrameContext.Provider value={VIEW_FRAME}>
      <p className="mb-3 text-sm text-muted-foreground" data-edit-list-note="">
        One column on a narrow screen. Change widths and heights on a wider screen.
      </p>
      {/* No scroll anchoring inside the list: the move keeps the pressed button in place
          itself, and the browser's own adjustment would pin another widget there. */}
      <ol
        ref={listRef}
        className={cn('flex flex-col [overflow-anchor:none]', PANEL_GAP)}
        aria-label="Widgets, in reading order"
      >
        {ordered.map((w, index) => (
          <li key={widgetId(w)} className="min-w-0">
            <WidgetCard
              widget={w}
              editing
              actions={listActions}
              toolbar="list"
              first={index === 0}
              last={index === ordered.length - 1}
            />
          </li>
        ))}
      </ol>
    </WidgetFrameContext.Provider>
  );
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
