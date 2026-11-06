/**
 * `DashboardBuilder`: one personal board's body, in view mode and in Edit mode (Round 5 /
 * G7; Round 14, SPEC §2.2 item 8 and §4.4.5).
 *
 * The board page (`BoardView`) owns the page header: the name, the time range, the
 * refresh and the "Edit" action. This component owns what sits below it:
 *
 *   1. VIEW mode: the widgets on the content-sized view grid (zero grid JS).
 *   2. EDIT mode (controlled by the host through `editing`): a control band with the
 *      board's name and "Add widget", the lazily loaded react-grid-layout surface
 *      (keyboard move and resize, WCAG 2.5.7), the widget gallery and per-widget
 *      settings, and a sticky Save and Discard bar. On a narrow board (a phone) the
 *      widgets edit as one column with Move up and Move down ({@link reorderWidget}),
 *      and the bar's hint says so; there Add widget and Duplicate put the new widget
 *      last ({@link appendWidget}), so nothing already on the board changes its place,
 *      and the focus goes to the new widget's Move up. While the bar shows, the toasts
 *      stack above it (the bar's own `useToastClearance`), so "Copy created." never
 *      covers Discard and Save.
 *
 * The draft is buffered against the last saved snapshot (`useDirtyDraft`), so Discard
 * restores exactly what is stored and Save persists it (`api.dashboards.update`, or
 * `create` for the unsaved `board=new` draft). While a changed draft is open the board
 * asks before it is left: the router's guard (`useNavigationBlocker` with `sameRoute`, so
 * the "All dashboards" link, the breadcrumb and the navigation's Dashboards item ask too,
 * although they stay on `#/dashboards`) and the browser's unload prompt.
 *
 * "Reset to default layout" (My dashboard, once stored) and "Delete dashboard" (any other
 * board) share one confirm flow with the page header's More menu ({@link useBoardRemoval});
 * a reset drops the draft with the stored board, so the role's layout shows clean. A
 * layout report that changes no geometry (the grid restating what it was given) is not an
 * edit: opening Edit mode and leaving untouched never asks "Discard changes?".
 *
 * FOCUS: pressing "Edit" hands the focus to the board's name; each confirm dialog gives it
 * back to the control that opened it, or to the host's `returnFocusTarget` when that
 * control left with Edit mode. A widget's settings sheet gives it back to that widget's
 * options button (the menu item that opened it is gone).
 *
 * NON-NEGOTIABLES: a layout is presentation only and never feeds `decide()` (#3); board
 * and widget names are untrusted and render as plain text (#9). react-grid-layout loads
 * only in Edit mode (the WidgetGrid lazy boundary), never at first paint.
 */
import * as React from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { deepEqual } from '@/lib/deep-equal';
import { errorMessage } from '@/lib/errorMessage';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';
import type { DashboardWindow } from '@/lib/types-dashboards';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { ControlBar } from '@/soc/components/ControlBar';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
import { useDirtyDraft, useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';
import { useNavigationBlocker } from '@/soc/router';

import { WidgetGrid, findWidgetControl, revealControl, type EditArrangement, type WidgetEditActions } from './WidgetGrid';
import { WidgetGallery } from './WidgetGallery';
import { WidgetConfigSheet } from './WidgetConfigSheet';
import {
  DashboardDataProvider,
  DASHBOARD_AUTO_REFRESH_MS,
  useOptionalDashboardData,
} from './DashboardDataProvider';
import {
  appendWidget,
  applyLayout,
  compactVertically,
  editGeometry,
  moveWidget,
  reorderWidget,
  resizeWidget,
  packWidgets,
  widgetId,
  widgetOptions,
  freshId,
  normalizeWidget,
  type GridItemShape,
  type MoveDir,
  type ReorderDir,
  type ResizeDir,
} from './layout-utils';
import type { PermissionCheck } from './registry';
import { displayBoardName, MAX_BOARD_NAME_LENGTH, UNTITLED_BOARD_NAME } from './builtins';

export interface DashboardBuilderProps {
  /** The board (already reconciled and filtered by role by the host). */
  dashboard: DashboardLayout;
  /** Permission check for the widget gallery (default: allow all). */
  can?: PermissionCheck;
  /**
   * The per-role default board (id `overview`, "My dashboard"): its destructive action is
   * "Reset to default layout" (restore); any other board offers "Delete dashboard".
   * Default `true`.
   */
  isDefaultBoard?: boolean;
  /**
   * Whether a stored copy exists. The role default is not stored until its first Save, so
   * resetting it is a local revert. Default `true`.
   */
  persisted?: boolean;
  /** Edit mode (the host's "Edit" action turns it on; Save and Discard turn it off). */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Save creates the board instead of updating it (the unsaved `board=new` draft). */
  createOnSave?: boolean;
  /** The board window, when this builder mounts its own data provider. */
  window?: DashboardWindow;
  /** Bump to read every widget again, when this builder mounts its own data provider. */
  reloadNonce?: number;
  /** After a successful Save, with the stored board. */
  onSaved?: (dashboard: DashboardLayout) => void;
  /** After a reset to the default layout or a delete. */
  onReset?: () => void;
  /** After Discard (the unsaved `board=new` draft returns to the library). */
  onDiscard?: () => void;
  /**
   * Where the focus goes when a confirm dialog closes after its opener left with Edit
   * mode (the host's "Edit" button).
   */
  returnFocusTarget?: () => HTMLElement | null;
  /**
   * Why Save is not offered (the board limit, for a board not stored yet: a new draft, or
   * My dashboard before its first Save); shown in the save bar.
   */
  saveBlockedReason?: string;
  className?: string;
}

/** The pieces of a board the builder buffers as its editable draft. */
interface DashboardDraft {
  name: string;
  columns: number;
  widgets: DashboardWidget[];
}

/**
 * The vertical compaction react-grid-layout applies when Edit mode mounts (moved to
 * `layout-utils`, where the narrow one-column editor reuses it; re-exported here for the
 * callers that import it from the builder).
 */
export { compactVertically };

/**
 * The widgets as plain JSON (keys holding `undefined` dropped), the shape the saved
 * snapshot is kept in, so an edit that changes nothing compares equal to it.
 */
function plainWidgets(widgets: readonly DashboardWidget[]): DashboardWidget[] {
  return JSON.parse(JSON.stringify(widgets)) as DashboardWidget[];
}

/**
 * The control a dialog opens from: the focused one, or for a menu item the menu's trigger
 * (the item leaves with its menu). Null when the focus is on the page.
 */
function focusedOpener(): HTMLElement | null {
  const active = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
  if (!active || active === document.body) return null;
  const menu = active.closest('[role="menu"]');
  if (!menu) return active;
  const trigger = menu.getAttribute('aria-labelledby');
  return trigger ? document.getElementById(trigger) : null;
}

function toDraft(d: DashboardLayout): DashboardDraft {
  const columns = typeof d.columns === 'number' ? d.columns : 12;
  return {
    // The name a person sees ("My dashboard" for a role default saved as "Overview"), so
    // the next Save writes it (SPEC §4.4.1) without the draft reading as changed.
    name: displayBoardName(d),
    columns,
    // Flow-pack a role default (every widget at the origin), then compact the way the
    // Edit grid does, so view and Edit show one layout (no jump) and opening Edit is not
    // a change. The builder authors one breakpoint: the save sends `widgets` only and the
    // server keeps `layouts: {}`.
    widgets: compactVertically(packWidgets((d.widgets ?? []).map(normalizeWidget), columns)),
  };
}

// --------------------------------------------------------------------------- //
// Reset or delete: one confirm flow for the header menu and the edit band
// --------------------------------------------------------------------------- //

export interface BoardRemovalOptions {
  dashboard: DashboardLayout;
  /** The per-role default board (reset) rather than another board (delete). */
  isDefaultBoard: boolean;
  /** Whether a stored copy exists (an unsaved role default resets locally). */
  persisted: boolean;
  /**
   * The control the confirm dialog opens from (read when it opens). Default: the focused
   * control, or the trigger of the menu holding the focused item.
   */
  opener?: () => HTMLElement | null;
  /** Where the focus goes when the dialog closes and its opener is gone. */
  returnFocusFallback?: () => HTMLElement | null;
  /** Runs before a local revert of an unsaved role default (the builder resets its draft). */
  onLocalRevert?: () => void;
  /** After the reset or delete took effect. */
  onDone?: () => void;
}

export interface BoardRemoval {
  /** Open the confirm dialog. */
  request: () => void;
  /** The confirm dialog (render it once). */
  dialog: React.ReactNode;
  busy: boolean;
}

/**
 * "Reset to default layout" (the role default: drop the stored copy so the role's layout
 * returns) or "Delete dashboard" (any other board: delete it). Destructive only in its
 * confirm dialog. A 404 means the copy is already gone, which is the state asked for.
 */
export function useBoardRemoval({
  dashboard,
  isDefaultBoard,
  persisted,
  opener,
  returnFocusFallback,
  onLocalRevert,
  onDone,
}: BoardRemovalOptions): BoardRemoval {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const name = displayBoardName(dashboard);

  // Focus goes back to the control the dialog opened from; when that control is gone (a
  // reset from the edit band closes Edit mode), to the fallback. Read when the dialog
  // closes, so it names what is on the page then.
  const openerRef = React.useRef<HTMLElement | null>(null);
  const fallbackRef = React.useRef(returnFocusFallback);
  React.useEffect(() => {
    fallbackRef.current = returnFocusFallback;
  }, [returnFocusFallback]);
  const returnFocusRef = React.useMemo<React.RefObject<HTMLElement | null>>(
    () => ({
      get current(): HTMLElement | null {
        const from = openerRef.current;
        if (from?.isConnected) return from;
        const fallback = fallbackRef.current?.() ?? null;
        return fallback?.isConnected ? fallback : null;
      },
    }),
    [],
  );

  const confirm = React.useCallback(async () => {
    if (isDefaultBoard && !persisted) {
      // Nothing is stored yet: the role's layout is already what the board shows.
      onLocalRevert?.();
      setOpen(false);
      toast.success('Default layout restored');
      onDone?.();
      return;
    }
    const okMessage = isDefaultBoard ? 'Default layout restored' : 'Dashboard deleted';
    setBusy(true);
    try {
      await api.dashboards.remove(dashboard.id);
      toast.success(okMessage);
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.success(okMessage);
        onDone?.();
      } else {
        toast.error(
          isDefaultBoard ? 'The layout could not be reset.' : 'The dashboard could not be deleted.',
          { description: errorMessage(err, 'Try again in a moment.') },
        );
      }
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }, [dashboard.id, isDefaultBoard, persisted, onLocalRevert, onDone]);

  const dialog = (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      onConfirm={confirm}
      destructive
      title={isDefaultBoard ? `Reset ${name} to the default layout?` : `Delete ${name}?`}
      description={
        isDefaultBoard
          ? 'Your changes to this board are discarded and the default layout for your role comes back. Other dashboards and settings do not change.'
          : 'This permanently deletes the dashboard. Other dashboards and settings do not change.'
      }
      confirmLabel={isDefaultBoard ? 'Reset layout' : 'Delete dashboard'}
      returnFocusRef={returnFocusRef}
    />
  );

  const request = React.useCallback(() => {
    openerRef.current = opener ? opener() : focusedOpener();
    setOpen(true);
  }, [opener]);

  return { request, dialog, busy };
}

// --------------------------------------------------------------------------- //
// The builder
// --------------------------------------------------------------------------- //

export function DashboardBuilder({
  dashboard,
  can,
  isDefaultBoard = true,
  persisted = true,
  editing,
  onEditingChange,
  createOnSave = false,
  window: boardWindow,
  reloadNonce = 0,
  onSaved,
  onReset,
  onDiscard,
  returnFocusTarget,
  saveBlockedReason,
  className,
}: DashboardBuilderProps) {
  const initial = React.useMemo(() => toDraft(dashboard), [dashboard]);
  const { draft, setDraft, dirty, reset, commit } = useDirtyDraft<DashboardDraft>(initial);

  const [saving, setSaving] = React.useState(false);
  const [galleryOpen, setGalleryOpen] = React.useState(false);
  const [configWidget, setConfigWidget] = React.useState<DashboardWidget | null>(null);

  // Ask before a changed draft is left: in-app moves through the router (including the
  // ones that stay on #/dashboards) and a reload or tab close through the browser.
  // Browser Back and Forward change the hash directly and cannot be paused.
  const guarded = editing && dirty;
  const boardName = displayBoardName(dashboard);
  useNavigationBlocker(guarded, {
    title: `Discard changes to ${boardName}?`,
    description: 'Your changes to this dashboard have not been saved.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
    sameRoute: true,
  });
  useUnsavedChanges(dirty, editing);

  const cols = draft.columns || 12;

  // "Edit" leaves the page with Edit mode on: the board's name takes the focus.
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);
  const wasEditingRef = React.useRef(editing);
  React.useEffect(() => {
    if (editing && !wasEditingRef.current) nameInputRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing]);

  // ------- Draft changes (pure operations on the widget list) ------- //

  // Every change goes through plain JSON (the saved snapshot's shape) and keeps the draft
  // as it is when nothing changed, so a change that restates the layout is no edit.
  const setWidgets = React.useCallback(
    (next: DashboardWidget[]) =>
      setDraft((prev) => {
        const widgets = plainWidgets(next);
        return deepEqual(widgets, prev.widgets) ? prev : { ...prev, widgets };
      }),
    [setDraft],
  );

  const setName = React.useCallback((name: string) => setDraft((prev) => ({ ...prev, name })), [setDraft]);

  // Grid or one column, as the grid reports it for this board's width (the bar's hint, and
  // where a new widget goes).
  const [arrangement, setArrangement] = React.useState<EditArrangement>('grid');

  // The widget just added from the gallery: the board says where it landed, and in the
  // one-column list the focus goes to its Move up when the gallery closes.
  const [lastAddedId, setLastAddedId] = React.useState<string | null>(null);
  const focusAddedRef = React.useRef<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);

  // In the one-column list a new widget goes LAST, so no widget already on the board
  // changes its place in the order (the grid shows where it lands, at the top).
  const addWidget = React.useCallback(
    (w: DashboardWidget) => {
      const widget = normalizeWidget(w);
      const list = arrangement === 'list';
      setWidgets(list ? appendWidget(draft.widgets, widget, cols) : [...draft.widgets, widget]);
      setLastAddedId(widgetId(widget));
      focusAddedRef.current = list ? widgetId(widget) : null;
    },
    [arrangement, draft.widgets, setWidgets, cols],
  );

  // The gallery is closing: after an add in the list, the focus goes to the new widget's
  // Move up instead of back to Add widget. Its toolbar is scrolled up to just under the
  // shell's top bar, so the new widget's body shows below it, not under the Save and
  // Discard bar.
  const galleryCloseFocus = React.useCallback((event: Event) => {
    const id = focusAddedRef.current;
    focusAddedRef.current = null;
    const target = id ? findWidgetControl(rootRef.current, id, 'up') : null;
    if (!target) return;
    event.preventDefault();
    revealControl(target, 0);
    target.focus({ preventScroll: true });
  }, []);

  // Configure opens from a widget's options menu, whose item is gone by the time the sheet
  // closes (Esc, Cancel or Apply): the focus goes back to that widget's options button,
  // not to the page (SPEC §3.3).
  const configOpenerRef = React.useRef<string | null>(null);
  const configureWidget = React.useCallback((w: DashboardWidget) => {
    configOpenerRef.current = widgetId(w);
    setConfigWidget(w);
  }, []);
  const configCloseFocus = React.useCallback((event: Event) => {
    const id = configOpenerRef.current;
    configOpenerRef.current = null;
    const target = id ? findWidgetControl(rootRef.current, id, 'options') : null;
    if (!target) return;
    event.preventDefault();
    revealControl(target);
    target.focus({ preventScroll: true });
  }, []);

  // Each Edit session starts without a pending add.
  React.useEffect(() => {
    if (!editing) {
      setLastAddedId(null);
      focusAddedRef.current = null;
    }
  }, [editing]);

  // The widgets below move up into the space, as the grid compacts them. The one-column
  // list never reports a layout, so the removal compacts the draft itself: what is saved
  // is what the list showed (and the grid reports the same geometry back).
  const removeWidget = React.useCallback(
    (w: DashboardWidget) => setWidgets(editGeometry(draft.widgets.filter((x) => widgetId(x) !== widgetId(w)), cols)),
    [draft.widgets, setWidgets, cols],
  );

  const duplicateWidget = React.useCallback(
    (w: DashboardWidget) => {
      const copy = normalizeWidget({
        ...w,
        i: freshId('w-'),
        // In the grid one row down, so the copy does not sit exactly on the original; in
        // the one-column list last, so no other widget changes its place in the order.
        y: (w as { y?: number }).y != null ? (w as { y: number }).y + 1 : 0,
        options: { ...widgetOptions(w) },
      } as DashboardWidget);
      setWidgets(arrangement === 'list' ? appendWidget(draft.widgets, copy, cols) : [...draft.widgets, copy]);
    },
    [arrangement, draft.widgets, setWidgets, cols],
  );

  const moveOne = React.useCallback(
    (w: DashboardWidget, dir: MoveDir) =>
      setWidgets(draft.widgets.map((x) => (widgetId(x) === widgetId(w) ? moveWidget(x, dir, cols) : x))),
    [draft.widgets, setWidgets, cols],
  );

  const resizeOne = React.useCallback(
    (w: DashboardWidget, dir: ResizeDir) =>
      setWidgets(draft.widgets.map((x) => (widgetId(x) === widgetId(w) ? resizeWidget(x, dir, cols) : x))),
    [draft.widgets, setWidgets, cols],
  );

  // The one-column list's Move up and Move down: one place along the reading order, the
  // 12-column layout keeping its shape (the pair trades places, never one-column geometry).
  const reorderOne = React.useCallback(
    (w: DashboardWidget, dir: ReorderDir) => setWidgets(reorderWidget(draft.widgets, widgetId(w), dir, cols)),
    [draft.widgets, setWidgets, cols],
  );

  const applyConfig = React.useCallback(
    (w: DashboardWidget, options: Record<string, unknown>) =>
      setWidgets(draft.widgets.map((x) => (widgetId(x) === widgetId(w) ? ({ ...x, options } as DashboardWidget) : x))),
    [draft.widgets, setWidgets],
  );

  // A drag or resize reports its layout many times a second; the settle wins.
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel a pending settle so it cannot land after Discard or Save and re-apply the
  // layout that was just reverted or saved.
  const cancelLayoutSettle = React.useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);
  const onGridLayoutChange = React.useCallback(
    (layout: GridItemShape[]) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        // The grid restates every item (with `minW` and `minH` keys even when unset): only
        // a real move or resize changes the draft.
        setDraft((prev) => {
          const widgets = plainWidgets(applyLayout(prev.widgets, layout));
          return deepEqual(widgets, prev.widgets) ? prev : { ...prev, widgets };
        });
      }, 200);
    },
    [setDraft],
  );
  React.useEffect(() => () => cancelLayoutSettle(), [cancelLayoutSettle]);

  const editActions = React.useMemo<WidgetEditActions>(
    () => ({
      onConfigure: configureWidget,
      onDuplicate: duplicateWidget,
      onRemove: removeWidget,
      onMove: moveOne,
      onResize: resizeOne,
      onReorder: reorderOne,
    }),
    [configureWidget, duplicateWidget, removeWidget, moveOne, resizeOne, reorderOne],
  );

  // ------- Save, discard, reset ------- //

  const trimmedName = draft.name.trim();
  const nameInvalid = trimmedName.length > MAX_BOARD_NAME_LENGTH;

  const save = React.useCallback(async () => {
    cancelLayoutSettle();
    setSaving(true);
    try {
      const payload: DashboardLayout = {
        ...dashboard,
        id: createOnSave ? '' : dashboard.id,
        name: trimmedName || UNTITLED_BOARD_NAME,
        columns: draft.columns,
        widgets: draft.widgets,
      };
      // An explicit Save fires at once (a drag stream is the debounced path).
      const stored = createOnSave
        ? await api.dashboards.create(payload)
        : await api.dashboards.update(dashboard.id, payload, { immediate: true });
      const result = stored ?? payload;
      // Commit what was stored, so `dirty` clears against exactly that.
      commit(toDraft(result));
      onEditingChange(false);
      toast.success(createOnSave ? 'Dashboard created' : 'Dashboard saved');
      onSaved?.(result);
    } catch (err) {
      toast.error(createOnSave ? 'The dashboard could not be created.' : 'The dashboard could not be saved.', {
        description: errorMessage(err, 'Try again in a moment.'),
      });
    } finally {
      setSaving(false);
    }
  }, [dashboard, draft, trimmedName, createOnSave, commit, onEditingChange, onSaved, cancelLayoutSettle]);

  const discard = React.useCallback(() => {
    cancelLayoutSettle();
    reset();
    onEditingChange(false);
    onDiscard?.();
  }, [reset, onEditingChange, onDiscard, cancelLayoutSettle]);

  const removal = useBoardRemoval({
    dashboard,
    isDefaultBoard,
    persisted,
    returnFocusFallback: returnFocusTarget,
    onLocalRevert: () => {
      cancelLayoutSettle();
      reset();
    },
    onDone: () => {
      // Drop the draft with the stored board: a changed draft would otherwise outlive the
      // reset (the draft hook keeps edits when its source changes) and a later Save would
      // write back what was just reset. Batched with the host's list update, so the next
      // render seeds the draft from the role's layout.
      cancelLayoutSettle();
      reset();
      onEditingChange(false);
      onReset?.();
    },
  });

  // View mode shows the saved snapshot (the draft equals it); Edit mode the live draft.
  const shownWidgets = draft.widgets;

  // A host board page wraps the whole page (header and body) in one data provider so its
  // refresh control can read it; standing alone, the builder mounts its own. Either way
  // the provider names the placed widgets' reads up front and never the billing standup.
  const outerProvider = useOptionalDashboardData();
  const focusAddButton = React.useCallback(() => addButtonRef.current, []);
  const grid = (
    <WidgetGrid
      widgets={shownWidgets}
      editing={editing}
      cols={cols}
      onLayoutChange={onGridLayoutChange}
      editActions={editActions}
      onArrangementChange={setArrangement}
      lastAddedId={lastAddedId}
      focusWhenEmpty={focusAddButton}
    />
  );

  return (
    <div ref={rootRef} className={className} data-dashboard-builder={editing ? 'edit' : 'view'}>
      {editing ? (
        <ControlBar
          className="mb-4"
          title={
            <div className="flex min-w-0 items-center gap-2">
              <label htmlFor="dashboard-name-input" className="shrink-0 text-sm font-medium text-muted-foreground">
                Name
              </label>
              {/* The name is untrusted: stored and shown as plain text (#9). */}
              <Input
                ref={nameInputRef}
                id="dashboard-name-input"
                data-testid="dashboard-name-input"
                value={draft.name}
                onChange={(e) => setName(e.target.value)}
                placeholder={UNTITLED_BOARD_NAME}
                maxLength={MAX_BOARD_NAME_LENGTH}
                aria-invalid={nameInvalid || undefined}
                className="h-8 w-56 max-w-full"
              />
            </div>
          }
          label="Dashboard editing controls"
          controls={
            <Button ref={addButtonRef} type="button" variant="outline" size="sm" onClick={() => setGalleryOpen(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add widget
            </Button>
          }
          overflowLabel="More dashboard actions"
          overflowActions={
            // Nothing to reset on a board that is not stored (a new draft, or the role
            // default before its first Save, which Discard already puts back), as in the
            // page header's More menu.
            createOnSave || (isDefaultBoard && !persisted)
              ? []
              : [
                  {
                    id: 'reset-dashboard',
                    label: isDefaultBoard ? 'Reset to default layout' : 'Delete dashboard',
                    icon: isDefaultBoard ? RotateCcw : Trash2,
                    destructive: false,
                    disabled: saving || removal.busy,
                    onSelect: removal.request,
                  },
                ]
          }
        />
      ) : null}

      {outerProvider ? (
        grid
      ) : (
        <DashboardDataProvider
          widgets={shownWidgets}
          window={boardWindow}
          reloadNonce={reloadNonce}
          refreshIntervalMs={DASHBOARD_AUTO_REFRESH_MS}
        >
          {grid}
        </DashboardDataProvider>
      )}

      {editing ? (
        <StickySaveBar
          visible
          busy={saving}
          saveDisabled={nameInvalid || Boolean(saveBlockedReason)}
          onSave={save}
          onDiscard={discard}
          saveLabel="Save dashboard"
          discardLabel="Discard"
          message={
            saveBlockedReason ??
            (dirty
              ? 'You have unsaved changes to this dashboard.'
              : arrangement === 'list'
                ? 'Reorder, add or remove widgets, then save.'
                : 'Drag, resize, add or remove widgets, then save.')
          }
        />
      ) : null}

      <WidgetGallery
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        can={can}
        onAdd={addWidget}
        onCloseAutoFocus={galleryCloseFocus}
        arrangement={arrangement}
      />

      <WidgetConfigSheet
        widget={configWidget}
        onOpenChange={(o) => {
          if (!o) setConfigWidget(null);
        }}
        onApply={applyConfig}
        onCloseAutoFocus={configCloseFocus}
      />

      {removal.dialog}
    </div>
  );
}

export default DashboardBuilder;
