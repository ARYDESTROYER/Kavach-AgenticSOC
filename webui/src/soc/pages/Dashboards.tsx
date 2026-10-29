/**
 * Dashboards: the library and its boards (Round 14, SPEC §2.2 and §4.4, operator choice C2).
 *
 * The landing route still opens the Cyber Defence Center; the left navigation's "Overview"
 * row opens this page, `#/dashboards`, the library of boards:
 *
 *   `#/dashboards`                         the library ("Built-in" and "Yours")
 *   `#/dashboards?board=builtin:<id>`      a built-in widget board
 *   `#/dashboards?board=<personal id>`     a personal board (`overview` is "My dashboard")
 *   `#/dashboards?board=u:<sha8>`          a personal board stored under an id a link cannot
 *                                          carry (resolved against the loaded list)
 *   `#/dashboards?board=new`               the builder on an unsaved draft
 *
 * (`builtin:cyber-defence-center` is the landing page itself; the router sends it to
 * `#/overview`.) A `board` value that names no board the viewer can open (unknown, hidden
 * by role, deleted) shows the library with a toast, and the address is replaced with
 * `#/dashboards`. Opening a board is a history entry, so Back returns to the library.
 *
 * This host owns the viewer's personal board list (`GET /api/dashboards`, the role default
 * "My dashboard" offered until its first Save), the built-ins the viewer hid
 * (`UserPrefs.misc.dashboards_hidden`, written through `PUT /api/prefs/user`, which the
 * server audits before it shows), and the navigation after a board is created, renamed,
 * reset, deleted or hidden. An address that depends on the list (a saved draft's new id,
 * the library after a delete) is replaced only once the list holds the change, so the new
 * address never resolves against the old list. The board page itself is lazy
 * (`BoardView`), and react-grid-layout loads only in a board's Edit mode.
 *
 * Keyboard focus: when an in-page move removes the control that was pressed (a card, "All
 * dashboards", a saved draft, a delete or a hide), a board hands focus to the main
 * landmark and the library to the card of the board just left (else the main landmark),
 * as the shell does after a navigation. The first view (a fresh load, a link from another
 * page) moves nothing.
 *
 * Gate: `metrics:view` (the same grant every dashboards route requires); without it the
 * page says so and the navigation sends the viewer to the Cyber Defence Center instead.
 *
 * NON-NEGOTIABLES: boards are presentation only and never feed `decide()` (#3); nothing here
 * calls a model (#6); names are untrusted and render as plain text (#9).
 */
import * as React from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';
import type { BuiltinBoardId } from '@/lib/types-dashboards';
import { LoadingState } from '@/design-system';
import { Button } from '@/ui/button';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { LoadError } from '@/soc/components/LoadError';
import { Unauthorized } from '@/soc/components/Can';
import { useAuth } from '@/soc/auth';
import { useOptionalPrefs } from '@/soc/prefs';
import { useRouteLinkClick } from '@/soc/route-link';
import { pageHash, useNavigateOptional, useRoute } from '@/soc/router';

import type { BoardTarget } from '@/soc/dashboard/BoardView';
import { DashboardsLibrary, NEW_BOARD_HREF, builtinVisible, type PersonalBoardEntry } from '@/soc/dashboard/Library';
import {
  BOARD_LIMIT_TEXT,
  MAX_PERSONAL_BOARDS,
  MY_DASHBOARD_ID,
  MY_DASHBOARD_NAME,
  NEW_BOARD_ID,
  boardRouteId,
  builtinBoard,
  hiddenBuiltinIds,
  type BuiltinBoard,
} from '@/soc/dashboard/builtins';
import { buildDefaultWidgets, type PermissionCheck } from '@/soc/dashboard/registry';

const BoardView = React.lazy(() => import('@/soc/dashboard/BoardView'));

/** The library's help tip (C8: the screenshot's description line moved here, E1). */
export const LIBRARY_HELP =
  'Built-in boards for each role, and the ones you made. Built-in boards are read-only; duplicate one to make it your own.';

// --------------------------------------------------------------------------- //
// Route helpers
// --------------------------------------------------------------------------- //

/**
 * Replace the address without a history entry and tell the router, so its route follows
 * (an unknown board becomes the library; a saved new board becomes its own id). The
 * router reads a hash change it did not write as a traversal of the same page.
 */
function replaceRoute(hash: string): void {
  try {
    const oldURL = window.location.href;
    window.history.replaceState(window.history.state, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
  } catch {
    /* a sandboxed frame may refuse; the page still shows the right content */
  }
}

/** True when keyboard focus fell to the page (its control went with the view it lived in). */
function focusDropped(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/** Hand focus to the routed main landmark, as the shell does after a navigation. */
function focusMain(): void {
  document.getElementById('socMain')?.focus({ preventScroll: true });
}

/** The library card of a board (by its `board` value), when it is listed. */
function libraryCard(board: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-board-card]')) {
    if (el.getAttribute('data-board-card') === board) return el;
  }
  return null;
}

/** The per-role default board, offered as "My dashboard" until its first Save. */
function roleDefaultBoard(role: string | null | undefined, can: PermissionCheck): DashboardLayout {
  return {
    id: MY_DASHBOARD_ID,
    name: MY_DASHBOARD_NAME,
    schema_version: 1,
    columns: 12,
    widgets: buildDefaultWidgets(role, { can }) as DashboardWidget[],
  };
}

type Resolution =
  | { status: 'library' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'missing' }
  | { status: 'board'; key: string; target: BoardTarget };

/** What a `board` value opens, against the loaded personal list. */
export function resolveBoard(
  param: string | undefined,
  ctx: {
    boards: readonly DashboardLayout[] | null;
    failed: boolean;
    roleDefault: DashboardLayout;
    hidden: readonly BuiltinBoardId[];
    can: PermissionCheck;
  },
): Resolution {
  if (!param) return { status: 'library' };
  if (param === NEW_BOARD_ID) return { status: 'board', key: NEW_BOARD_ID, target: { kind: 'new' } };
  const builtin = builtinBoard(param);
  if (builtin) {
    return builtinVisible(builtin, ctx.can)
      ? { status: 'board', key: param, target: { kind: 'builtin', board: builtin, hidden: ctx.hidden.includes(builtin.id) } }
      : { status: 'missing' };
  }
  if (!ctx.boards) return ctx.failed ? { status: 'error' } : { status: 'loading' };
  const stored = ctx.boards.find((b) => boardRouteId(b.id) === param);
  if (stored) return { status: 'board', key: param, target: { kind: 'personal', layout: stored, persisted: true } };
  if (param === MY_DASHBOARD_ID) {
    return { status: 'board', key: param, target: { kind: 'personal', layout: ctx.roleDefault, persisted: false } };
  }
  return { status: 'missing' };
}

// --------------------------------------------------------------------------- //
// Data
// --------------------------------------------------------------------------- //

/**
 * The viewer's personal boards (`null` until the first answer), kept in step with edits.
 * The list is only ever what the server returned plus the edits made on top of it: a
 * change made while no list is held (it failed or is still loading) reads the list again
 * instead of inventing a one-item list, and the new read supersedes any older one.
 */
function usePersonalBoards(enabled: boolean) {
  const [boards, setBoards] = React.useState<DashboardLayout[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const seq = React.useRef(0);
  // The list as last set, for the edits (kept beside the state, never written in render).
  const listRef = React.useRef<DashboardLayout[] | null>(null);
  const setList = React.useCallback((next: DashboardLayout[] | null) => {
    listRef.current = next;
    setBoards(next);
  }, []);

  const load = React.useCallback(async () => {
    const n = (seq.current += 1);
    setError(null);
    try {
      const res = await api.dashboards.list();
      if (n === seq.current) setList(res?.dashboards ?? []);
    } catch (err) {
      if (n === seq.current) setError(err ?? new Error('The dashboards could not be loaded.'));
    }
  }, [setList]);

  React.useEffect(() => {
    if (enabled) void load();
    return () => {
      seq.current += 1;
    };
  }, [enabled, load]);

  const upsert = React.useCallback(
    (layout: DashboardLayout) => {
      const list = listRef.current;
      if (!list) {
        // No list to add to: the next read includes the board just stored.
        void load();
        return;
      }
      setList(
        list.some((b) => b.id === layout.id) ? list.map((b) => (b.id === layout.id ? layout : b)) : [...list, layout],
      );
    },
    [load, setList],
  );

  const remove = React.useCallback(
    (id: string) => {
      const list = listRef.current;
      if (list) setList(list.filter((b) => b.id !== id));
    },
    [setList],
  );

  return { boards, error, reload: load, upsert, remove };
}

/**
 * Whether row-level data scope applies to the viewer (`GET /api/auth/me` `object_scoped`),
 * for the library's "N panels need permissions" note. Unknown (`undefined`) while it loads
 * or when it cannot be read: the note then counts only the panels the role cannot read.
 */
function useObjectScoped(): boolean | undefined {
  const auth = useAuth();
  const signedIn = Boolean(auth.authEnabled && auth.isAuthenticated);
  const [scoped, setScoped] = React.useState<boolean | undefined>(undefined);
  React.useEffect(() => {
    if (!signedIn) {
      setScoped(false);
      return undefined;
    }
    let alive = true;
    Promise.resolve()
      .then(() => api.auth.me())
      .then(
        (me) => {
          if (alive) setScoped(me?.object_scoped === true);
        },
        () => {
          if (alive) setScoped(undefined);
        },
      );
    return () => {
      alive = false;
    };
  }, [signedIn, auth.username, auth.role]);
  return scoped;
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * The built-ins the viewer hid, and the write that changes them. The write is
 * `PUT /api/prefs/user` (audited before it shows); the list updates at once and goes back
 * if the write fails.
 */
function useHiddenBuiltins() {
  const prefs = useOptionalPrefs();
  const stored = React.useMemo(
    () => hiddenBuiltinIds((prefs?.prefs.misc as Record<string, unknown> | undefined)?.dashboards_hidden),
    [prefs?.prefs.misc],
  );
  const [override, setOverride] = React.useState<BuiltinBoardId[] | null>(null);
  const hidden = override ?? stored;
  React.useEffect(() => {
    if (override && sameIds(override, stored)) setOverride(null);
  }, [override, stored]);

  const refresh = prefs?.refresh;
  const write = React.useCallback(
    async (next: BuiltinBoardId[], previous: BuiltinBoardId[]): Promise<boolean> => {
      setOverride(next);
      try {
        await api.prefs.putUser({ misc: { dashboards_hidden: next } });
        // Bring the shared preferences up to date (the write is already stored).
        void Promise.resolve(refresh?.()).catch(() => undefined);
        return true;
      } catch (err) {
        setOverride(previous);
        toast.error('Your dashboard list could not be updated.', {
          description: errorMessage(err, 'Try again in a moment.'),
        });
        return false;
      }
    },
    [refresh],
  );

  return { hidden, write };
}

// --------------------------------------------------------------------------- //
// The page
// --------------------------------------------------------------------------- //

/**
 * The header's "New dashboard" (a link to the draft, styled as an outline button). At the
 * board limit it is a disabled button: a draft there could never be saved, and the Yours
 * tile says why.
 */
function NewDashboardLink({ atLimit }: { atLimit: boolean }) {
  const onClick = useRouteLinkClick(NEW_BOARD_HREF);
  if (atLimit) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-sm:h-9"
        disabled
        aria-label="New dashboard"
        title={BOARD_LIMIT_TEXT}
        data-testid="dashboards-new"
      >
        <Plus className="size-3.5" aria-hidden />
        <span className="sm:hidden">New</span>
        <span className="max-sm:hidden">New dashboard</span>
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" size="sm" className="max-sm:h-9">
      <a href={NEW_BOARD_HREF} onClick={onClick} aria-label="New dashboard" data-testid="dashboards-new">
        <Plus className="size-3.5" aria-hidden />
        <span className="sm:hidden">New</span>
        <span className="max-sm:hidden">New dashboard</span>
      </a>
    </Button>
  );
}

function BoardLoading() {
  return <LoadingState label="Loading dashboard" layout="page" shape="page" />;
}

export function Dashboards() {
  const { role, hasPermission, loading: authLoading } = useAuth();
  // Nothing is read until the viewer's grants are known (no 403 to explain).
  const allowed = !authLoading && hasPermission('metrics', 'view');
  const { opts } = useRoute();
  const navigate = useNavigateOptional();
  const boardParam = typeof opts?.board === 'string' && opts.board ? opts.board : undefined;

  const { boards, error, reload, upsert, remove } = usePersonalBoards(allowed);
  const objectScoped = useObjectScoped();
  const { hidden, write } = useHiddenBuiltins();
  const [editIntent, setEditIntent] = React.useState<string | null>(null);
  // An address to take once the list holds the change that names it (see the effect).
  const [pendingHash, setPendingHash] = React.useState<string | null>(null);
  const atLimit = (boards?.length ?? 0) >= MAX_PERSONAL_BOARDS;

  const roleDefault = React.useMemo(() => roleDefaultBoard(role, hasPermission), [role, hasPermission]);

  // Yours: My dashboard first (saved or the role default), then the rest as stored.
  const personal = React.useMemo<PersonalBoardEntry[] | null>(() => {
    if (!boards) return null;
    const mine = boards.find((b) => b.id === MY_DASHBOARD_ID);
    const rest = boards.filter((b) => b.id !== MY_DASHBOARD_ID).map((layout) => ({ layout, persisted: true }));
    return [mine ? { layout: mine, persisted: true } : { layout: roleDefault, persisted: false }, ...rest];
  }, [boards, roleDefault]);

  const resolution = resolveBoard(boardParam, {
    boards,
    failed: Boolean(error),
    roleDefault,
    hidden,
    can: hasPermission,
  });

  // Take the pending address only now, after the commit that holds the list change: the
  // router renders a replaced address at once (inside the hashchange), so changing it in
  // the same tick as the list would resolve the new id against the old list ("not
  // available" for a board just created, the deleted board for one frame).
  React.useEffect(() => {
    if (pendingHash === null) return;
    setPendingHash(null);
    replaceRoute(pendingHash);
  }, [pendingHash]);

  // A board no one can open here: say so once and show the library at its own address.
  // (Not while an address change is pending: a board just deleted is not "unavailable".)
  const reportedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (resolution.status !== 'missing' || !boardParam || pendingHash !== null) return;
    if (reportedRef.current === boardParam) return;
    reportedRef.current = boardParam;
    toast.error('That dashboard is not available.');
    replaceRoute(pageHash('dashboards'));
  }, [resolution.status, boardParam, pendingHash]);
  React.useEffect(() => {
    if (!boardParam) reportedRef.current = null;
  }, [boardParam]);

  // Keyboard focus after an in-page move (see the module note). Loading and error states
  // are not views: the move completes when the board or the library shows.
  const viewKey =
    resolution.status === 'board'
      ? `board:${resolution.key}`
      : resolution.status === 'library' || resolution.status === 'missing'
        ? 'library'
        : null;
  const lastViewRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (viewKey === null) return;
    const previous = lastViewRef.current;
    lastViewRef.current = viewKey;
    if (previous === null || previous === viewKey || !focusDropped()) return;
    const card = viewKey === 'library' && previous.startsWith('board:') ? libraryCard(previous.slice(6)) : null;
    if (card) card.focus();
    else focusMain();
  }, [viewKey]);

  const hide = React.useCallback(
    async (board: BuiltinBoard) => {
      const previous = [...hidden];
      const next = [...previous.filter((id) => id !== board.id), board.id];
      if (!(await write(next, previous))) return;
      navigate('dashboards');
      toast.success(`${board.name} is hidden.`, {
        action: { label: 'Undo', onClick: () => void write(previous, next) },
      });
    },
    [hidden, write, navigate],
  );

  const unhide = React.useCallback(
    async (board: BuiltinBoard) => {
      const previous = [...hidden];
      const next = previous.filter((id) => id !== board.id);
      if (await write(next, previous)) toast.success(`${board.name} is back in your list.`);
    },
    [hidden, write],
  );

  const onCreated = React.useCallback(
    (layout: DashboardLayout, how: 'duplicate' | 'new') => {
      upsert(layout);
      const board = boardRouteId(layout.id);
      if (how === 'duplicate') {
        // The copy opens in Edit mode (SPEC §4.4.6); a history entry, so Back returns.
        // (The router's own navigate renders with the list update, in one batch.)
        setEditIntent(board);
        navigate('dashboards', { board });
      } else {
        // The saved draft takes its own address in place of `board=new`, once the list
        // holds it.
        setPendingHash(pageHash('dashboards', { board }));
      }
    },
    [upsert, navigate],
  );

  const onRemoved = React.useCallback(
    (layout: DashboardLayout, how: 'reset' | 'delete') => {
      remove(layout.id);
      // A reset leaves My dashboard on its role default; a deleted board is gone.
      if (how === 'delete') setPendingHash(pageHash('dashboards'));
    },
    [remove],
  );

  if (authLoading) {
    return (
      <PageContainer variant="wide">
        <BoardLoading />
      </PageContainer>
    );
  }

  if (!allowed) {
    return (
      <PageContainer variant="wide">
        <Unauthorized message="You do not have access to dashboards." />
      </PageContainer>
    );
  }

  if (resolution.status === 'board') {
    const { key, target } = resolution;
    return (
      <React.Suspense fallback={<BoardLoading />}>
        <BoardView
          key={key}
          target={target}
          savedCount={boards?.length ?? 0}
          startInEdit={editIntent === key}
          onStartedInEdit={() => setEditIntent(null)}
          onHide={hide}
          onUnhide={unhide}
          onCreated={onCreated}
          onSaved={upsert}
          onRemoved={onRemoved}
        />
      </React.Suspense>
    );
  }

  if (resolution.status === 'loading') {
    return (
      <PageContainer variant="wide">
        <BoardLoading />
      </PageContainer>
    );
  }

  if (resolution.status === 'error') {
    return (
      <PageContainer variant="wide">
        <PageHeader back={{ label: 'All dashboards', href: '#/dashboards' }} title="Dashboard" />
        <LoadError error={error} title="This dashboard could not be loaded." onRetry={() => void reload()} />
      </PageContainer>
    );
  }

  return (
    <PageContainer variant="wide">
      <PageHeader
        title="Dashboards"
        help={LIBRARY_HELP}
        actions={<NewDashboardLink atLimit={atLimit} />}
        data-testid="dashboards-header"
      />
      <DashboardsLibrary
        personal={personal}
        error={error}
        onRetry={() => void reload()}
        hidden={hidden}
        onUnhide={(id) => {
          const board = builtinBoard(id);
          if (board) void unhide(board);
        }}
        can={hasPermission}
        objectScoped={objectScoped}
        atLimit={atLimit}
      />
    </PageContainer>
  );
}

export default Dashboards;
