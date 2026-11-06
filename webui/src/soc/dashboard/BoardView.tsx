/**
 * One dashboard board page (`#/dashboards?board=...`; Round 14, SPEC §2.2 items 6 to 8 and
 * §4.4.5). Lazy: the library host loads it only when a board is opened.
 *
 * HEADER (C8): an "All dashboards" link back to the library (the one sanctioned header
 * extra), the board's name as the page title, its badge, a help tip ("For SOC managers and
 * shift leads. Is the team keeping up today?"), the board's time range (the last 24 hours,
 * 7, 30 or 90 days; no custom range, because every board read takes a whole window) and the
 * refresh beside the title, and the board's actions on the right:
 *
 *   - a built-in board: "Duplicate to customise" and a More menu ("Hide from my list", or
 *     "Show in my list" when hidden; "Built-in boards cannot be edited", disabled);
 *   - a personal board: "Edit" and a More menu ("Duplicate", "Rename", and "Reset to default
 *     layout" for My dashboard or "Delete dashboard" for any other, destructive only in its
 *     confirm dialog);
 *   - the unsaved `board=new` draft opens straight in Edit mode.
 *
 * LIMIT: a board that is not stored yet (the `board=new` draft, or My dashboard before its
 * first Save) is created by its first Save or Rename, which the server refuses once the
 * viewer holds 24 boards. At the limit Save is turned off and the save bar says why, and
 * the Rename dialog says the same and cannot be confirmed, so no edit is made that cannot
 * be kept.
 *
 * The top bar's breadcrumb reads "Agentic SOC / Dashboards / <board>", its "Dashboards"
 * segment a link to the library (`useBreadcrumbTrail`).
 *
 * A personal board keeps every panel it holds: one the viewer's role cannot read shows
 * "No access" (as on a built-in board) and is saved back with the board, so a temporary
 * role never deletes it. Only a widget type the Console no longer knows is dropped.
 *
 * FOCUS: each dialog (Duplicate, Rename, the Reset or Delete confirm) gives the focus back
 * to the control that opened it ("Duplicate to customise" or the More menu's trigger);
 * leaving Edit mode (Save, Discard, a reset) gives it to "Edit".
 *
 * DATA: the whole page sits in ONE `DashboardDataProvider` (the placed widgets, the board
 * window, the 60 s visible-tab refresh), so the header's refresh can read and drive it.
 * Changing the window reads every windowed panel again. The provider gates every read by
 * role and by row-level scope and keys its cache on the Demo identity (§3.5); it never
 * calls the billing standup (#6, #7).
 *
 * Names are untrusted and render as plain text (#9). A layout never feeds `decide()` (#3).
 */
import * as React from 'react';
import { Copy, Eye, EyeOff, Lock, MoreHorizontal, Pencil, RotateCcw, Trash2, TextCursorInput } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';
import type { DashboardWindow } from '@/lib/types-dashboards';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Field } from '@/soc/components/Field';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { TimeRangePicker, type TimeRange } from '@/soc/components/TimeRangePicker';
import { useAuth } from '@/soc/auth';
import { useBreadcrumbTrail } from '@/soc/nav-store';
import { useNavigateOptional } from '@/soc/router';

import { DashboardBuilder, useBoardRemoval } from './DashboardBuilder';
import { DashboardDataProvider, DASHBOARD_AUTO_REFRESH_MS, useDashboardData } from './DashboardDataProvider';
import { WidgetGrid } from './WidgetGrid';
import {
  BOARD_LIMIT_TEXT,
  MAX_BOARD_NAME_LENGTH,
  MAX_PERSONAL_BOARDS,
  MY_DASHBOARD_ID,
  NEW_BOARD_ID,
  UNTITLED_BOARD_NAME,
  builtinName,
  copyName,
  displayBoardName,
  unavailableNote,
  type BuiltinBoard,
} from './builtins';
import { ALLOW_ALL, canUseWidget, getWidgetDef, reconcileWidgets, unavailableWidgetCount } from './registry';
import { BOARD_WINDOWS, DEFAULT_BOARD_WINDOW, isDashboardWindow } from './widgets/requests';

// --------------------------------------------------------------------------- //
// Shapes
// --------------------------------------------------------------------------- //

/** The board a `board=` value resolved to. */
export type BoardTarget =
  | { kind: 'builtin'; board: BuiltinBoard; hidden: boolean }
  | { kind: 'personal'; layout: DashboardLayout; persisted: boolean }
  | { kind: 'new' };

export interface BoardViewProps {
  target: BoardTarget;
  /** How many personal boards are stored (the limit is {@link MAX_PERSONAL_BOARDS}). */
  savedCount: number;
  /** Open in Edit mode (a copy just made by Duplicate). */
  startInEdit?: boolean;
  /** Called once when the board opened in Edit mode for `startInEdit`. */
  onStartedInEdit?: () => void;
  /** Hide a built-in from the library (the host writes the preference and navigates). */
  onHide: (board: BuiltinBoard) => void;
  /** Show a hidden built-in in the library again. */
  onUnhide: (board: BuiltinBoard) => void;
  /** A board was created: a copy (`duplicate`) or the saved `board=new` draft (`new`). */
  onCreated: (layout: DashboardLayout, how: 'duplicate' | 'new') => void;
  /** A personal board was saved or renamed. */
  onSaved: (layout: DashboardLayout) => void;
  /** My dashboard was reset to the role default, or a board was deleted. */
  onRemoved: (layout: DashboardLayout, how: 'reset' | 'delete') => void;
}

/** The four windows a board offers, in the time-range picker's shape. */
export const BOARD_RANGES: readonly TimeRange[] = (Object.keys(BOARD_WINDOWS) as DashboardWindow[]).map((w) => ({
  from: w,
  to: 'now',
  label: BOARD_WINDOWS[w].label,
}));

function rangeOf(boardWindow: DashboardWindow): TimeRange {
  return BOARD_RANGES.find((r) => r.from === boardWindow) ?? BOARD_RANGES[0];
}

/** The window a board opens on: the built-in's, the personal board's, else 24 hours. */
export function initialBoardWindow(target: BoardTarget): DashboardWindow {
  if (target.kind === 'builtin') return target.board.defaultWindow;
  if (target.kind === 'personal' && isDashboardWindow(target.layout.default_window)) {
    return target.layout.default_window;
  }
  return DEFAULT_BOARD_WINDOW;
}

/** The empty draft `board=new` opens on. */
const NEW_DRAFT: DashboardLayout = {
  id: NEW_BOARD_ID,
  name: UNTITLED_BOARD_NAME,
  schema_version: 1,
  columns: 12,
  widgets: [],
};

/** The help tip of a board (C8: the explanation lives beside the title, never a line). */
function boardHelp(target: BoardTarget): string {
  if (target.kind === 'builtin') return `For ${target.board.audience}. ${target.board.purpose}`;
  if (target.kind === 'new') return 'A new board of your own. Add widgets from the gallery, arrange them, then save.';
  const copied = builtinName(target.layout.derived_from);
  const own =
    target.layout.id === MY_DASHBOARD_ID
      ? 'Your own board, started from the default for your role. Edit it to add, arrange and resize widgets.'
      : 'Your own board. Edit it to add, arrange and resize widgets.';
  return copied ? `Copied from ${copied}. ${own}` : own;
}

// --------------------------------------------------------------------------- //
// Header controls (inside the provider, so the refresh reads it)
// --------------------------------------------------------------------------- //

function BoardControls({
  badge,
  boardWindow,
  onWindowChange,
}: {
  badge: React.ReactNode;
  boardWindow: DashboardWindow;
  onWindowChange: (next: DashboardWindow) => void;
}) {
  const { loading, refresh } = useDashboardData();
  // Spin only for a reload the person asked for (the 60 s tick is quiet): `requested` until
  // the read starts, `reading` until it ends.
  const [phase, setPhase] = React.useState<'idle' | 'requested' | 'reading'>('idle');
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (phase === 'requested' && loading) setPhase('reading');
    else if (phase === 'reading' && !loading) {
      setPhase('idle');
      // The button is disabled while it spins; give the focus back if it fell to the page.
      if (document.activeElement === document.body) buttonRef.current?.focus();
    }
  }, [phase, loading]);
  React.useEffect(() => {
    if (phase !== 'requested') return undefined;
    // A board with nothing to read never starts a read: stop waiting for one.
    const timer = setTimeout(() => setPhase((p) => (p === 'requested' ? 'idle' : p)), 1000);
    return () => clearTimeout(timer);
  }, [phase]);

  return (
    <>
      {badge}
      <TimeRangePicker
        value={rangeOf(boardWindow)}
        onChange={(range) => {
          if (isDashboardWindow(range.from)) onWindowChange(range.from);
        }}
        presets={BOARD_RANGES}
        size="sm"
        chrome="command"
      />
      <RefreshButton
        ref={buttonRef}
        display="icon"
        label="Refresh dashboard"
        refreshing={phase !== 'idle' && loading}
        onClick={() => {
          setPhase('requested');
          refresh();
        }}
      />
    </>
  );
}

/** "2 panels need permissions your role does not have." for the widgets a viewer cannot see whole. */
function BoardAccessNote({ widgets }: { widgets: readonly DashboardWidget[] }) {
  const { can, objectScoped } = useDashboardData();
  const note = unavailableNote(unavailableWidgetCount(widgets, { can, objectScoped }));
  if (!note) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="dashboard-access-note">
      {note}
    </p>
  );
}

function BuiltinBadge() {
  return (
    <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-2xs">
      <Lock className="size-3" aria-hidden />
      Built-in
    </Badge>
  );
}

function YoursBadge() {
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-2xs font-normal">
      Yours
    </Badge>
  );
}

// --------------------------------------------------------------------------- //
// Dialogs
// --------------------------------------------------------------------------- //

/** A name is 1 to 120 characters after trimming (the server's limit). */
function nameError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed.length > MAX_BOARD_NAME_LENGTH) return `Use at most ${MAX_BOARD_NAME_LENGTH} characters.`;
  return undefined;
}

/**
 * Give the focus back to the control that opened a dialog (a controlled dialog has no
 * trigger of its own, so it would otherwise fall to the page). When that control is gone
 * the dialog's default applies.
 */
function returnFocusTo(ref: React.RefObject<HTMLElement | null> | undefined) {
  if (!ref) return undefined;
  return (event: Event) => {
    const target = ref.current;
    if (target?.isConnected) {
      event.preventDefault();
      target.focus();
    }
  };
}

interface DuplicateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the focus returns when the dialog closes. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  sourceName: string;
  builtin: boolean;
  windowPhrase: string;
  atLimit: boolean;
  onDuplicate: (name: string) => Promise<boolean>;
}

/** "Duplicate SOC operations?" (SPEC §4.4.5). */
function DuplicateDialog({
  open,
  onOpenChange,
  returnFocusRef,
  sourceName,
  builtin,
  windowPhrase,
  atLimit,
  onDuplicate,
}: DuplicateDialogProps) {
  const [name, setName] = React.useState(() => copyName(sourceName));
  const [busy, setBusy] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setName(copyName(sourceName));
      setTouched(false);
    }
  }, [open, sourceName]);
  const error = nameError(name);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (error || atLimit || busy) return;
    setBusy(true);
    try {
      if (await onDuplicate(name.trim())) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md" onCloseAutoFocus={returnFocusTo(returnFocusRef)}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{`Duplicate ${sourceName}?`}</DialogTitle>
            <DialogDescription>
              {builtin
                ? 'You get an editable copy in your dashboards, opened in Edit mode. A copy does not update with new releases; the built-in board stays as it is.'
                : 'You get a copy in your dashboards, opened in Edit mode. The original stays as it is.'}
            </DialogDescription>
          </DialogHeader>
          {atLimit ? (
            <p className="text-sm text-foreground" role="status" data-testid="dashboard-limit-note">
              {BOARD_LIMIT_TEXT}
            </p>
          ) : (
            <>
              <Field label="Name" error={touched ? error : undefined}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched(true)}
                  maxLength={MAX_BOARD_NAME_LENGTH}
                  autoComplete="off"
                />
              </Field>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{`Copies every panel, its position and the default window (${windowPhrase}).`}</li>
                {builtin ? <li>Panels your role cannot read are left out of the copy.</li> : null}
              </ul>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={atLimit || busy || Boolean(touched && error)} aria-busy={busy || undefined}>
              Duplicate and edit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the focus returns when the dialog closes. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  current: string;
  /**
   * Why the board cannot be renamed (a rename that would create a board at the limit):
   * the dialog says so in place of the name field and cannot be confirmed.
   */
  blockedReason?: string;
  onRename: (name: string) => Promise<boolean>;
}

function RenameDialog({ open, onOpenChange, returnFocusRef, current, blockedReason, onRename }: RenameDialogProps) {
  const [name, setName] = React.useState(current);
  const [busy, setBusy] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setName(current);
      setTouched(false);
    }
  }, [open, current]);
  const error = nameError(name);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (error || blockedReason || busy) return;
    setBusy(true);
    try {
      if (await onRename(name.trim())) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-md" onCloseAutoFocus={returnFocusTo(returnFocusRef)}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Rename dashboard</DialogTitle>
            <DialogDescription>{`The new name shows in your dashboards and on the board.`}</DialogDescription>
          </DialogHeader>
          {blockedReason ? (
            <p className="text-sm text-foreground" role="status" data-testid="dashboard-limit-note">
              {blockedReason}
            </p>
          ) : (
            <Field label="Name" error={touched ? error : undefined}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
                maxLength={MAX_BOARD_NAME_LENGTH}
                autoComplete="off"
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={Boolean(blockedReason) || busy || Boolean(touched && error)}
              aria-busy={busy || undefined}
            >
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// The board page
// --------------------------------------------------------------------------- //

export function BoardView({
  target,
  savedCount,
  startInEdit = false,
  onStartedInEdit,
  onHide,
  onUnhide,
  onCreated,
  onSaved,
  onRemoved,
}: BoardViewProps) {
  const { hasPermission: can } = useAuth();
  const navigate = useNavigateOptional();
  const [boardWindow, setBoardWindow] = React.useState<DashboardWindow>(() => initialBoardWindow(target));
  const [editing, setEditing] = React.useState(() => target.kind === 'new' || (target.kind === 'personal' && startInEdit));
  const [leaving, setLeaving] = React.useState(false);
  const [duplicateOpen, setDuplicateOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  // The controls dialogs open from, and the one that opened the dialog now showing.
  const duplicateButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const moreTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const editButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const openFrom = React.useCallback((opener: HTMLElement | null, open: (next: boolean) => void) => {
    openerRef.current = opener;
    open(true);
  }, []);

  // Leaving Edit mode (Save, Discard, a reset) removes the control that was pressed:
  // "Edit" takes the focus back when it fell to the page.
  const wasEditingRef = React.useRef(editing);
  React.useEffect(() => {
    const was = wasEditingRef.current;
    wasEditingRef.current = editing;
    if (!was || editing) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) editButtonRef.current?.focus();
  }, [editing]);

  const name =
    target.kind === 'builtin'
      ? target.board.name
      : target.kind === 'personal'
        ? displayBoardName(target.layout)
        : UNTITLED_BOARD_NAME;

  // The edit intent of a fresh copy is used once, at mount.
  const startedRef = React.useRef(startInEdit);
  React.useEffect(() => {
    if (startedRef.current) {
      startedRef.current = false;
      onStartedInEdit?.();
    }
  }, [onStartedInEdit]);

  // "Agentic SOC / Dashboards / <board>": the middle segment links to the library.
  useBreadcrumbTrail('dashboards', [{ label: 'Dashboards', page: 'dashboards' }, { label: name }]);

  // Discard on the unsaved new draft returns to the library, after the draft's guard is off.
  React.useEffect(() => {
    if (leaving) navigate('dashboards');
  }, [leaving, navigate]);

  // A personal board keeps every panel it holds (one the role cannot read shows "No
  // access" and is saved back as it is); only a widget type the Console no longer knows is
  // dropped on load.
  const layout = React.useMemo<DashboardLayout | null>(() => {
    if (target.kind === 'new') return NEW_DRAFT;
    if (target.kind !== 'personal') return null;
    return {
      ...target.layout,
      name: displayBoardName(target.layout),
      widgets: reconcileWidgets(target.layout.widgets as DashboardWidget[], { can: ALLOW_ALL }),
    };
  }, [target]);

  const widgets: DashboardWidget[] = target.kind === 'builtin' ? target.board.widgets : (layout?.widgets ?? []);
  const isRoleDefault = target.kind === 'personal' && target.layout.id === MY_DASHBOARD_ID;
  const persisted = target.kind === 'personal' && target.persisted;
  const atLimit = savedCount >= MAX_PERSONAL_BOARDS;
  // A board that is not stored yet (the new draft, or My dashboard before its first Save)
  // is created by Save or Rename, which the server refuses at the limit: say so up front.
  const createBlockedReason = target.kind !== 'builtin' && !persisted && atLimit ? BOARD_LIMIT_TEXT : undefined;

  const removal = useBoardRemoval({
    dashboard: layout ?? NEW_DRAFT,
    isDefaultBoard: isRoleDefault,
    persisted,
    opener: () => moreTriggerRef.current,
    returnFocusFallback: () => editButtonRef.current,
    onDone: () => {
      if (target.kind === 'personal') onRemoved(target.layout, isRoleDefault ? 'reset' : 'delete');
    },
  });

  const duplicate = React.useCallback(
    async (copy: string): Promise<boolean> => {
      let body: DashboardLayout;
      if (target.kind === 'builtin') {
        body = {
          id: '',
          name: copy,
          schema_version: 1,
          columns: 12,
          // A copy holds only what the viewer's role can read (SPEC §4.4.1).
          widgets: target.board.widgets.filter((w) => {
            const def = getWidgetDef(w.type);
            return Boolean(def && canUseWidget(def, can));
          }),
          default_window: target.board.defaultWindow,
          derived_from: target.board.id,
        };
      } else if (target.kind === 'personal' && layout) {
        body = {
          id: '',
          name: copy,
          schema_version: 1,
          columns: typeof layout.columns === 'number' ? layout.columns : 12,
          widgets: layout.widgets ?? [],
          default_window: isDashboardWindow(layout.default_window) ? layout.default_window : null,
          derived_from: layout.derived_from ?? null,
        };
      } else {
        return false;
      }
      try {
        const stored = await api.dashboards.create(body);
        toast.success('Copy created. Your changes are saved to the copy only.');
        onCreated(stored ?? body, 'duplicate');
        return true;
      } catch (err) {
        toast.error('The copy could not be created.', { description: errorMessage(err, 'Try again in a moment.') });
        return false;
      }
    },
    [target, layout, can, onCreated],
  );

  const rename = React.useCallback(
    async (next: string): Promise<boolean> => {
      if (!layout || target.kind !== 'personal' || createBlockedReason) return false;
      try {
        const stored = await api.dashboards.update(layout.id, { ...target.layout, name: next }, { immediate: true });
        toast.success('Dashboard renamed');
        onSaved(stored ?? { ...target.layout, name: next });
        return true;
      } catch (err) {
        toast.error('The dashboard could not be renamed.', { description: errorMessage(err, 'Try again in a moment.') });
        return false;
      }
    },
    [layout, target, createBlockedReason, onSaved],
  );

  const badge =
    target.kind === 'builtin' ? (
      <span className="flex items-center gap-1.5">
        <BuiltinBadge />
        {target.hidden ? (
          <Badge variant="outline" className="px-1.5 py-0 text-2xs font-normal">
            Hidden
          </Badge>
        ) : null}
      </span>
    ) : (
      <YoursBadge />
    );

  const moreTrigger = (
    <DropdownMenuTrigger asChild>
      <Button
        ref={moreTriggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="More dashboard actions"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
  );

  let actions: React.ReactNode = null;
  if (target.kind === 'builtin') {
    actions = (
      <>
        <Button
          ref={duplicateButtonRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => openFrom(duplicateButtonRef.current, setDuplicateOpen)}
        >
          <Copy className="size-3.5" aria-hidden />
          Duplicate to customise
        </Button>
        <DropdownMenu modal={false}>
          {moreTrigger}
          <DropdownMenuContent align="end" className="w-64">
            {target.hidden ? (
              <DropdownMenuItem className="gap-2" onSelect={() => onUnhide(target.board)}>
                <Eye className="size-4" aria-hidden />
                Show in my list
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem className="gap-2" onSelect={() => onHide(target.board)}>
                <EyeOff className="size-4" aria-hidden />
                Hide from my list
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="gap-2">
              <Lock className="size-4" aria-hidden />
              Built-in boards cannot be edited
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
  } else if (target.kind === 'personal' && !editing) {
    actions = (
      <>
        <Button
          ref={editButtonRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          data-testid="dashboard-edit-btn"
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
        <DropdownMenu modal={false}>
          {moreTrigger}
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem className="gap-2" onSelect={() => openFrom(moreTriggerRef.current, setDuplicateOpen)}>
              <Copy className="size-4" aria-hidden />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onSelect={() => openFrom(moreTriggerRef.current, setRenameOpen)}>
              <TextCursorInput className="size-4" aria-hidden />
              Rename
            </DropdownMenuItem>
            {isRoleDefault && !persisted ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2" disabled={removal.busy} onSelect={removal.request}>
                  {isRoleDefault ? <RotateCcw className="size-4" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                  {isRoleDefault ? 'Reset to default layout' : 'Delete dashboard'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
  }

  return (
    <DashboardDataProvider widgets={widgets} window={boardWindow} refreshIntervalMs={DASHBOARD_AUTO_REFRESH_MS}>
      <PageContainer variant="wide" data-testid="dashboard-board" data-board-kind={target.kind}>
        <PageHeader
          back={{ label: 'All dashboards', href: '#/dashboards' }}
          title={name}
          help={boardHelp(target)}
          controls={<BoardControls badge={badge} boardWindow={boardWindow} onWindowChange={setBoardWindow} />}
          actions={actions}
          data-testid="dashboard-board-header"
        />
        <BoardAccessNote widgets={widgets} />
        {target.kind === 'builtin' ? (
          <WidgetGrid widgets={target.board.widgets} />
        ) : layout ? (
          <DashboardBuilder
            dashboard={layout}
            can={can}
            isDefaultBoard={isRoleDefault}
            persisted={persisted}
            editing={editing}
            onEditingChange={setEditing}
            createOnSave={target.kind === 'new'}
            onSaved={(stored) => (target.kind === 'new' ? onCreated(stored, 'new') : onSaved(stored))}
            onDiscard={target.kind === 'new' ? () => setLeaving(true) : undefined}
            onReset={() => {
              if (target.kind === 'personal') onRemoved(target.layout, isRoleDefault ? 'reset' : 'delete');
            }}
            returnFocusTarget={() => editButtonRef.current}
            // A board not stored yet could never be stored at the limit: say so, and do not offer Save.
            saveBlockedReason={createBlockedReason}
          />
        ) : null}
      </PageContainer>

      {target.kind !== 'new' ? (
        <DuplicateDialog
          open={duplicateOpen}
          onOpenChange={setDuplicateOpen}
          returnFocusRef={openerRef}
          sourceName={name}
          builtin={target.kind === 'builtin'}
          windowPhrase={BOARD_WINDOWS[initialBoardWindow(target)].phrase}
          atLimit={atLimit}
          onDuplicate={duplicate}
        />
      ) : null}
      {target.kind === 'personal' ? (
        <RenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          returnFocusRef={openerRef}
          current={name}
          blockedReason={createBlockedReason}
          onRename={rename}
        />
      ) : null}
      {removal.dialog}
    </DashboardDataProvider>
  );
}

export default BoardView;
