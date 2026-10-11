/**
 * NavSidebar — the SOC console's single left navigation surface (Round-3 Stage 2).
 *
 * ONE sidebar with TWO width states, toggled by the shell's hamburger button (and
 * Cmd/Ctrl+B):
 *   - EXPANDED (~248px): a labelled drawer. A top-level item WITH children renders
 *     as a WAI-ARIA DISCLOSURE — a `<button aria-expanded aria-controls>` with a
 *     rotating ChevronRight that expands/collapses a `<ul>` of child links. Tapping
 *     the parent label itself navigates to the host page (its primary destination)
 *     AND opens the group; the chevron is a separate toggle so the destination is
 *     never hidden behind the disclosure. An item WITHOUT children is a direct link.
 *   - COLLAPSED (64px): a locked icon rail. A childless item is a tooltip'd icon button;
 *     an item WITH children opens one compact, fixed-position flyout after deliberate
 *     pointer hover or immediately on keyboard focus. The rail itself never widens.
 *     Flyout children mount only while exposed, remain in the natural Tab order, and
 *     close on focus exit or Escape without replacing the trigger DOM.
 *     The active trail is marked on the collapsed parent (a primary side-bar + tint),
 *     and `aria-current="page"` rides the active leaf both in the rail and inside the
 *     fly-out.
 *
 * We deliberately use the DISCLOSURE pattern (button + aria-expanded), NOT
 * role="tree": these are page links, not a hierarchical data tree, so disclosure is
 * the correct, lower-friction a11y model.
 *
 * LOCKED-RAIL FLYOUT: the persisted collapsed preference is stable under hover. Group
 * flyouts are intent-delayed for pointers, immediate for focus, viewport-clamped, and
 * pointer-safe across the rail-to-panel gap. The explicit toggle and Cmd/Ctrl+B remain
 * the only ways to pin the full labelled drawer open.
 *
 * RBAC: items + children carry an optional `perm`; they are filtered out for users
 * lacking the grant (with auth/RBAC off, `hasPermission()` is always true → full nav).
 *
 * SECURITY: every label is a STATIC, in-repo string (nav.ts) — not user data — so
 * there is no #9 surface here; we still render everything as plain text.
 *
 * AGENT ACTIVITY (Round 12, SPEC D13): the chat destinations carry the activity glyph
 * on every form (collapsed rail badge, expanded parent and child rows, flyout, mobile
 * drawer): a small turning ring while an answer is being written, an accent dot for an
 * unread answer, amber when a question waits on the analyst, red when one failed. The
 * state is also text: a tooltip / flyout line and `aria-describedby` ("Chat: 1 answer in
 * progress: <title>", one hidden description per item, `nav-activity-<id>`); never
 * `aria-busy` on a nav button. Case-scoped turns mark Case
 * Manager the same way. With reduced motion the ring stands still and the text starts
 * with "Working". While any answer is being written a thin ring turns around the brand
 * tile (`ChatAgentConfig.animated_brand`); an operator's logo itself never moves.
 * Titles in that text are prompt- or model-derived and render as text only (#9).
 *
 * PERSISTENCE: the `{nav_collapsed, nav_open_groups}` state lives in the shell via
 * `useNavPrefs` (exported here): it hydrates SYNCHRONOUSLY from a localStorage mirror
 * (mirroring the theme pre-hydration approach to avoid a collapse flash on first
 * paint), then reconciles with the server-side UserPrefs.misc on mount and persists
 * every change to both localStorage and PUT /api/prefs/user.
 */
import * as React from 'react';
import { ChevronRight, Shield, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { Separator } from '@/ui/separator';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useAuth } from '../auth';
import { usePrefs } from '../prefs';
import {
  ActivityGlyph,
  BrandActivityRing,
  useChatActivitySummary,
  type ChatActivitySummary,
} from '../chat-activity/glyph';
import {
  NAV_FOOTER_ITEMS,
  NAV_GROUPS,
  navVisible,
  navParentOf,
  type NavChild,
  type NavGroup,
  type NavItem,
  type PageId,
} from '../nav';
import type { Navigate } from '../router';

/* -------------------------------------------------------------------------- */
/* Persistence: nav collapse + open-group state (shell-owned, exported hook).  */
/* -------------------------------------------------------------------------- */

const LS_COLLAPSED = 'soc.nav.collapsed';
const LS_OPEN_GROUPS = 'soc.nav.openGroups';
/** UserPrefs.misc keys the server mirror writes/reads (Round-3). */
const MISC_COLLAPSED = 'nav_collapsed';
const MISC_OPEN_GROUPS = 'nav_open_groups';

function readBool(key: string): boolean {
  try {
    return window.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function readStringList(key: string): string[] {
  try {
    const raw = window.localStorage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeMirror(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export interface NavPrefsValue {
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
  /** The set of currently-expanded disclosure-group ids (by host PageId). */
  openGroups: Set<string>;
  toggleGroup: (id: string) => void;
  /** Open a group without toggling (used when navigating into a child). */
  openGroup: (id: string) => void;
}

/**
 * Shell-owned nav collapse + open-group state. Reads the localStorage mirror
 * SYNCHRONOUSLY in the initializers (no first-paint flash), then — once the
 * effective prefs have hydrated — reconciles from the server `misc` bucket. Every
 * mutation writes BOTH the localStorage mirror and PUT /api/prefs/user (best-effort).
 */
export function useNavPrefs(): NavPrefsValue {
  const { prefs, ready } = usePrefs();
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => readBool(LS_COLLAPSED));
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(
    () => new Set(readStringList(LS_OPEN_GROUPS)),
  );
  // Reconcile from the server exactly once, after the cascade hydrates. The local
  // mirror is authoritative for the FIRST paint; the server value (if present) wins
  // once known, so the choice follows the user across devices — EXCEPT a key the user
  // deliberately toggled before hydration finished. Such an in-window toggle was ALSO
  // PUT to the server, so it is the value a later device load reconciles to anyway;
  // honouring it here just avoids snapping the local UI back to a stale snapshot.
  const reconciled = React.useRef(false);
  const touched = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!ready || reconciled.current) return;
    reconciled.current = true;
    const misc = (prefs.misc ?? {}) as Record<string, unknown>;
    if (!touched.current.has(MISC_COLLAPSED) && typeof misc[MISC_COLLAPSED] === 'boolean') {
      setCollapsedState(misc[MISC_COLLAPSED] as boolean);
    }
    if (!touched.current.has(MISC_OPEN_GROUPS)) {
      const groups = misc[MISC_OPEN_GROUPS];
      if (Array.isArray(groups)) {
        setOpenGroups(new Set(groups.filter((g): g is string => typeof g === 'string')));
      }
    }
  }, [ready, prefs.misc]);

  const persistMisc = React.useCallback((patch: Record<string, unknown>) => {
    void api.prefs
      .putUser({ misc: patch })
      .catch(() => undefined);
  }, []);

  const setCollapsed = React.useCallback(
    (v: boolean) => {
      touched.current.add(MISC_COLLAPSED);
      setCollapsedState(v);
      writeMirror(LS_COLLAPSED, v ? '1' : '0');
      persistMisc({ [MISC_COLLAPSED]: v });
    },
    [persistMisc],
  );

  const toggleCollapsed = React.useCallback(() => {
    touched.current.add(MISC_COLLAPSED);
    setCollapsedState((prev) => {
      const next = !prev;
      writeMirror(LS_COLLAPSED, next ? '1' : '0');
      persistMisc({ [MISC_COLLAPSED]: next });
      return next;
    });
  }, [persistMisc]);

  const commitGroups = React.useCallback(
    (next: Set<string>) => {
      touched.current.add(MISC_OPEN_GROUPS);
      const list = Array.from(next);
      writeMirror(LS_OPEN_GROUPS, JSON.stringify(list));
      persistMisc({ [MISC_OPEN_GROUPS]: list });
    },
    [persistMisc],
  );

  const toggleGroup = React.useCallback(
    (id: string) => {
      setOpenGroups((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        commitGroups(next);
        return next;
      });
    },
    [commitGroups],
  );

  const openGroup = React.useCallback(
    (id: string) => {
      setOpenGroups((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        commitGroups(next);
        return next;
      });
    },
    [commitGroups],
  );

  return React.useMemo<NavPrefsValue>(
    () => ({ collapsed, toggleCollapsed, setCollapsed, openGroups, toggleGroup, openGroup }),
    [collapsed, toggleCollapsed, setCollapsed, openGroups, toggleGroup, openGroup],
  );
}

/* -------------------------------------------------------------------------- */
/* RBAC filtering.                                                            */
/* -------------------------------------------------------------------------- */

type HasPerm = (resource: string, action: string) => boolean;

/** Filter a group's items + their children by the caller's grants; drop empties. */
function filterGroups(groups: NavGroup[], has: HasPerm): NavGroup[] {
  return groups
    .map((g) => ({
      ...g,
      items: filterItems(g.items, has),
    }))
    .filter((g) => g.items.length > 0);
}

/** Apply the registry's single visibility authority to items and their leaves. */
function filterItems(items: NavItem[], has: HasPerm): NavItem[] {
  return items
    .filter((item) => navVisible(item, has))
    .map((item) => ({
      ...item,
      children: (item.children ?? []).filter((child) => navVisible(child, has)),
    }));
}

/* -------------------------------------------------------------------------- */
/* Agent activity (SPEC D13).                                                 */
/* -------------------------------------------------------------------------- */

/** Nav item id → its chat activity (`chat`: Workspace chat; `case_manager`: case chat). */
type NavActivity = Partial<Record<string, ChatActivitySummary>>;

/** The visible state line: with reduced motion the ring stands still, so say "Working". */
function activityText(activity: ChatActivitySummary, reducedMotion: boolean): string {
  return reducedMotion && activity.status === 'running' ? `Working. ${activity.text}` : activity.text;
}

/**
 * The visually hidden description an item's buttons point at (`aria-describedby`; the
 * buttons keep their plain label as their name), or null when idle.
 */
const describe = (id: string, activity: ChatActivitySummary | undefined) =>
  activity?.text ? (
    <span id={`nav-activity-${id}`} className="sr-only">
      {activity.text}
    </span>
  ) : null;
const describedBy = (id: string, activity: ChatActivitySummary | undefined) =>
  activity?.text ? `nav-activity-${id}` : undefined;
/** The trailing glyph of a labelled row. */
const mark = (activity: ChatActivitySummary | undefined) =>
  activity?.status ? <ActivityGlyph status={activity.status} className="ml-auto" /> : null;

/* -------------------------------------------------------------------------- */
/* Leaf link primitives.                                                      */
/* -------------------------------------------------------------------------- */

/** A child row inside an expanded disclosure group. */
const ChildLink: React.FC<{
  child: NavChild;
  active: boolean;
  onSelect: () => void;
  /** The parent item's activity (its description element is the parent's). */
  activity?: ChatActivitySummary;
  parentId: string;
}> = ({ child, active, onSelect, activity, parentId }) => {
  const Icon = child.icon;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        aria-describedby={describedBy(parentId, activity)}
        data-testid={`nav-${child.id}`}
        className={cn(
          // min-h-8 (32px) keeps the leaf row ≥24px for WCAG 2.2 §2.5.8 (target size).
          'flex min-h-8 w-full items-center gap-2.5 rounded-md py-1.5 pl-9 pr-2 text-left text-sm transition-colors',
          // scroll-my-1 keeps a focused row off the scroll-container edge so its focus
          // ring is never clipped when keyboard focus scrolls it into view (§2.4.11).
          'scroll-my-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? 'bg-primary/10 font-medium text-primary dark:bg-accent'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        <span className="truncate">{child.label}</span>
        {mark(activity)}
      </button>
    </li>
  );
};

/* -------------------------------------------------------------------------- */
/* Expanded (labelled) rendering.                                            */
/* -------------------------------------------------------------------------- */

const ExpandedItem: React.FC<{
  item: NavItem;
  page: PageId;
  open: boolean;
  onNavigate: (id: PageId) => void;
  onToggleGroup: (id: string) => void;
  reducedMotion?: boolean;
  activity?: NavActivity;
}> = ({ item, page, open, onNavigate, onToggleGroup, reducedMotion = false, activity }) => {
  const Icon = item.icon as LucideIcon;
  const own = activity?.[item.id];
  // The row's tooltip while it has activity (assistive tech reads the description).
  const tip = own?.text ? activityText(own, reducedMotion) : undefined;
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  // Active when this item or any of its children is the current page.
  const childActive = children.some((c) => c.id === page);
  const selfActive = page === item.id;
  const trailActive = selfActive || childActive;
  // A host whose OWN id is ALSO one of its children (chat/metrics/inbox) renders the
  // shared-id child link as the single canonical `aria-current="page"` marker, so the
  // parent button must NOT also claim it (a nav landmark must have exactly one current
  // page). BUT the child <ul> is only mounted when the disclosure is OPEN — when the
  // group is collapsed the child marker doesn't exist, so the parent must carry
  // aria-current itself. Suppress the parent's marker ONLY when the child <ul> that
  // carries it is actually rendered (`idIsAlsoChild && open`); otherwise the current
  // page would have NO marker at all for a screen reader.
  const idIsAlsoChild = children.some((c) => c.id === item.id);
  const panelId = `nav-group-${item.id}`;

  if (!hasChildren) {
    return (
      <li>
        {describe(item.id, own)}
        <button
          type="button"
          onClick={() => onNavigate(item.id)}
          aria-current={selfActive ? 'page' : undefined}
          aria-describedby={describedBy(item.id, own)}
          title={tip}
          data-testid={`nav-${item.id}`}
          className={cn(
            'relative flex w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-2 text-left text-sm',
            reducedMotion ? 'transition-none' : 'transition-colors duration-150',
            // scroll-my-1: keep a focused leaf off the scroll edge (§2.4.11).
            'scroll-my-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selfActive
              ? 'bg-primary/10 font-medium text-primary dark:bg-accent'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {selfActive ? (
            <span className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-primary" aria-hidden />
          ) : null}
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{item.label}</span>
          {mark(own)}
        </button>
      </li>
    );
  }

  return (
    <li>
      <div
        className={cn(
          'relative flex items-center overflow-hidden rounded-md',
          reducedMotion ? 'transition-none' : 'transition-colors duration-150',
          trailActive && !open ? 'bg-primary/[0.06] dark:bg-accent/70' : '',
        )}
      >
        {trailActive ? (
          <span className="absolute inset-y-1 left-0 z-10 w-0.5 rounded-r bg-primary" aria-hidden />
        ) : null}
        {/* Primary destination — navigating ALSO opens the group (destinations are
            never hidden behind the disclosure). */}
        {describe(item.id, own)}
        <button
          type="button"
          onClick={() => onNavigate(item.id)}
          aria-current={selfActive && !(idIsAlsoChild && open) ? 'page' : undefined}
          aria-describedby={describedBy(item.id, own)}
          title={tip}
          data-active-trail={trailActive || undefined}
          data-testid={`nav-${item.id}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
            'scroll-my-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            trailActive
              ? 'font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon
            className={cn('h-4 w-4 shrink-0', trailActive ? 'text-primary' : '')}
            aria-hidden
          />
          <span className="truncate">{item.label}</span>
          {mark(own)}
        </button>
        {/* Disclosure toggle (WAI-ARIA): aria-expanded + aria-controls + rotating chevron. */}
        <button
          type="button"
          onClick={() => onToggleGroup(item.id)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label}`}
          className={cn(
            'mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <ChevronRight
            className={cn(
              'h-4 w-4',
              reducedMotion ? 'transition-none' : 'transition-transform duration-200 ease-premium',
              open ? 'rotate-90' : '',
            )}
            aria-hidden
          />
        </button>
      </div>
      {open ? (
        <ul id={panelId} className="mt-0.5 space-y-0.5">
          {children.map((c) => (
            <ChildLink
              key={`${item.id}-${c.id}`}
              child={c}
              active={page === c.id}
              onSelect={() => onNavigate(c.id)}
              activity={activity?.[c.id]}
              parentId={item.id}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
};

/* -------------------------------------------------------------------------- */
/* Collapsed (icon-rail) rendering.                                          */
/* -------------------------------------------------------------------------- */

export const NAV_FLYOUT_OPEN_DELAY_MS = 100;
export const NAV_FLYOUT_CLOSE_DELAY_MS = 180;

const NAV_FLYOUT_GAP_PX = 8;
const NAV_FLYOUT_VIEWPORT_MARGIN_PX = 8;
const NAV_FLYOUT_FALLBACK_WIDTH_PX = 224;
const NAV_FLYOUT_FALLBACK_HEIGHT_PX = 192;

/** @internal Pure geometry seam used by the browser interaction and its regressions. */
export function placeNavFlyout(
  trigger: Pick<DOMRect, 'top' | 'right'>,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const width = panel.width || NAV_FLYOUT_FALLBACK_WIDTH_PX;
  const height = panel.height || NAV_FLYOUT_FALLBACK_HEIGHT_PX;
  const maxLeft = Math.max(
    NAV_FLYOUT_VIEWPORT_MARGIN_PX,
    viewport.width - width - NAV_FLYOUT_VIEWPORT_MARGIN_PX,
  );
  const maxTop = Math.max(
    NAV_FLYOUT_VIEWPORT_MARGIN_PX,
    viewport.height - height - NAV_FLYOUT_VIEWPORT_MARGIN_PX,
  );

  return {
    left: Math.min(
      Math.max(NAV_FLYOUT_VIEWPORT_MARGIN_PX, trigger.right + NAV_FLYOUT_GAP_PX),
      maxLeft,
    ),
    top: Math.min(Math.max(NAV_FLYOUT_VIEWPORT_MARGIN_PX, trigger.top), maxTop),
  };
}

const CollapsedItem: React.FC<{
  item: NavItem;
  page: PageId;
  onNavigate: (id: PageId) => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  reducedMotion?: boolean;
  activity?: NavActivity;
}> = ({ item, page, onNavigate, open, onOpen, onClose, reducedMotion = false, activity }) => {
  const Icon = item.icon as LucideIcon;
  const own = activity?.[item.id];
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const childActive = children.some((c) => c.id === page);
  const selfActive = page === item.id;
  const trailActive = selfActive || childActive;
  // Same shared-id host case as the expanded rail: while the panel is open, its active
  // child owns aria-current. While closed, the parent trail owns it so the landmark
  // never loses the current-page marker merely because its destinations are hidden.
  const idIsAlsoChild = children.some((c) => c.id === item.id);
  const panelId = `nav-fly-${item.id}`;

  const btnRef = React.useRef<HTMLButtonElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const openTimerRef = React.useRef<number | null>(null);
  const closeTimerRef = React.useRef<number | null>(null);
  const suppressNextFocusOpenRef = React.useRef(false);
  const [pos, setPos] = React.useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const measure = React.useCallback(() => {
    const triggerRect = btnRef.current?.getBoundingClientRect();
    if (!triggerRect) return;
    const panelRect = panelRef.current?.getBoundingClientRect();
    const next = placeNavFlyout(
      triggerRect,
      {
        width: panelRect?.width ?? NAV_FLYOUT_FALLBACK_WIDTH_PX,
        height: panelRect?.height ?? NAV_FLYOUT_FALLBACK_HEIGHT_PX,
      },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((current) =>
      current.top === next.top && current.left === next.left ? current : next,
    );
  }, []);

  const cancelOpen = React.useCallback(() => {
    if (openTimerRef.current === null) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const openImmediately = React.useCallback(() => {
    cancelOpen();
    cancelClose();
    measure();
    onOpen();
  }, [cancelClose, cancelOpen, measure, onOpen]);

  const schedulePointerOpen = React.useCallback(() => {
    cancelClose();
    if (open || openTimerRef.current !== null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      measure();
      onOpen();
    }, NAV_FLYOUT_OPEN_DELAY_MS);
  }, [cancelClose, measure, onOpen, open]);

  const schedulePointerClose = React.useCallback(() => {
    cancelOpen();
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, NAV_FLYOUT_CLOSE_DELAY_MS);
  }, [cancelClose, cancelOpen, onClose]);

  React.useLayoutEffect(() => {
    if (open) measure();
  }, [measure, open]);

  // A fixed panel escapes the rail's overflow clip. Re-measure while exposed so it
  // remains aligned and clamped as the page scrolls or the viewport changes.
  React.useEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, measure]);

  React.useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelClose, cancelOpen],
  );

  const railButton = (
    <button
      ref={btnRef}
      type="button"
      onClick={() => onNavigate(item.id)}
      aria-label={item.label}
      aria-current={
        open
          ? selfActive && !idIsAlsoChild
            ? 'page'
            : undefined
          : trailActive
            ? 'page'
            : undefined
      }
      aria-expanded={hasChildren ? open : undefined}
      aria-controls={hasChildren ? panelId : undefined}
      aria-haspopup={hasChildren ? 'true' : undefined}
      aria-describedby={describedBy(item.id, own)}
      data-active-trail={trailActive ? 'true' : undefined}
      data-testid={`nav-${item.id}`}
      className={cn(
        'relative flex h-10 w-10 items-center justify-center rounded-md',
        reducedMotion ? 'transition-none' : 'transition-[color,background-color,transform] duration-150 ease-premium',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        trailActive
          ? 'bg-primary/10 text-primary dark:bg-accent'
          : open
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-5 w-5" aria-hidden />
      {/* Active-trail indicator for a collapsed PARENT whose child is current. */}
      {trailActive ? (
        <span
          className="absolute -left-2 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
      {/* Agent activity badge: top-right, knocked out of the rail surface. */}
      <ActivityGlyph status={own?.status ?? null} className="chat-activity-badge" />
    </button>
  );

  // Childless item → a simple tooltip'd icon button.
  if (!hasChildren) {
    return (
      <>
        {describe(item.id, own)}
        <Tooltip>
          <TooltipTrigger asChild>{railButton}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs break-words">
            {item.label}
            {own?.text ? <span className="block text-muted-foreground">{activityText(own, reducedMotion)}</span> : null}
          </TooltipContent>
        </Tooltip>
      </>
    );
  }

  // Grouped item → one compact panel. It stays inline in DOM ownership (rather than a
  // portal) so focus moves naturally from trigger to destinations, but only mounts
  // while exposed so hidden buttons never remain in the accessibility or Tab tree.
  return (
    <div
      ref={wrapRef}
      className="relative"
      onPointerEnter={schedulePointerOpen}
      onPointerLeave={schedulePointerClose}
      onFocusCapture={() => {
        if (suppressNextFocusOpenRef.current) return;
        openImmediately();
      }}
      onBlurCapture={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) {
          cancelOpen();
          cancelClose();
          onClose();
        }
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        cancelOpen();
        cancelClose();
        onClose();
        if (document.activeElement !== btnRef.current) {
          suppressNextFocusOpenRef.current = true;
          window.requestAnimationFrame(() => {
            btnRef.current?.focus();
            suppressNextFocusOpenRef.current = false;
          });
        }
      }}
    >
      {describe(item.id, own)}
      {railButton}
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          data-testid={`nav-flyout-${item.id}`}
          data-state="open"
          role="group"
          aria-label={`${item.label} destinations`}
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          onPointerEnter={() => {
            cancelOpen();
            cancelClose();
          }}
          onPointerLeave={schedulePointerClose}
          className={cn(
            "relative z-[60] w-56 before:absolute before:-left-2 before:top-0 before:h-full before:w-2 before:content-['']",
            reducedMotion
              ? 'transition-none'
              : 'animate-in fade-in-0 slide-in-from-left-1 duration-150 ease-premium',
          )}
        >
          <div className="max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-menu">
            <p className="px-2.5 py-1.5 text-xs font-semibold text-muted-foreground">
              {item.label}
            </p>
            {own?.text ? (
              <p className="break-words px-2.5 pb-1.5 text-xs text-muted-foreground">{activityText(own, reducedMotion)}</p>
            ) : null}
            <ul className="space-y-1">
              {children.map((c) => {
                const active = page === c.id;
                const childActivity = activity?.[c.id];
                return (
                  <li key={`fly-${item.id}-${c.id}`}>
                    <button
                      type="button"
                      onClick={() => onNavigate(c.id)}
                      aria-current={active ? 'page' : undefined}
                      aria-describedby={describedBy(item.id, childActivity)}
                      className={cn(
                        'flex h-9 w-full items-center rounded-sm px-2.5 text-left text-sm transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'bg-primary/10 font-medium text-primary dark:bg-accent'
                          : 'text-foreground hover:bg-muted',
                      )}
                    >
                      <span className="truncate">{c.label}</span>
                      {mark(childActivity)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* The sidebar.                                                              */
/* -------------------------------------------------------------------------- */

export interface NavSidebarProps {
  /** The current page id (drives the active trail + leaf highlight). */
  page: PageId;
  /** Navigate to a page (child or parent). */
  onNavigate: Navigate;
  /** Whether the rail is in the 64px icon state (true) or the 248px drawer. */
  collapsed: boolean;
  /** The expanded disclosure-group ids (host PageIds), shell-owned. */
  openGroups: Set<string>;
  /** Toggle one disclosure group's expanded state. */
  onToggleGroup: (id: string) => void;
  /** Ensure a group is expanded (called when navigating into one of its children). */
  onOpenGroup: (id: string) => void;
  /** A logo data: URL (trusted branding) for the brand mark; falls back to a shield. */
  logoUrl?: string;
  /** The product name (plain text) shown next to the mark when expanded. */
  productName?: string;
  /** A header slot for the hamburger toggle (the shell renders the button). */
  toggleSlot?: React.ReactNode;
  /** Layout override for hosts such as the mobile off-canvas Sheet. */
  className?: string;
  /** Disable width/fade/chevron transitions for an OS reduced-motion preference. */
  reducedMotion?: boolean;
}

/**
 * The single navigation surface. The shell owns `collapsed` + `openGroups` (so the
 * Cmd/Ctrl+B shortcut and persistence live in one place); this component is the
 * pure presentation of those states.
 */
export function NavSidebar({
  page,
  onNavigate,
  collapsed,
  openGroups,
  onToggleGroup,
  onOpenGroup,
  logoUrl,
  productName,
  toggleSlot,
  className,
  reducedMotion = false,
}: NavSidebarProps) {
  const { hasPermission } = useAuth();
  const groups = React.useMemo(
    () => filterGroups(NAV_GROUPS, hasPermission),
    [hasPermission],
  );
  const footerItems = React.useMemo(
    () => filterItems(NAV_FOOTER_ITEMS, hasPermission),
    [hasPermission],
  );
  const [openFlyoutId, setOpenFlyoutId] = React.useState<string | null>(null);
  // Workspace chat marks the Workspace parent and its Chat leaf (both id `chat`); case
  // chat marks Case Manager.
  const activity: NavActivity = {
    chat: useChatActivitySummary('workspace'),
    case_manager: useChatActivitySummary('case'),
  };

  React.useEffect(() => {
    if (!collapsed) setOpenFlyoutId(null);
  }, [collapsed]);

  const closeFlyout = React.useCallback((id: string) => {
    setOpenFlyoutId((current) => (current === id ? null : current));
  }, []);

  // Navigating ALSO opens the owning disclosure group — both when navigating into a
  // child (keep the trail visible) AND when tapping a parent host label itself (the
  // documented contract: "the parent label navigates to the host page AND opens the
  // group"). onOpenGroup is idempotent and only ever ADDS to the open set, so it never
  // collapses an already-open group — the chevron stays the sole explicit collapse.
  const navigate = React.useCallback(
    (id: PageId) => {
      setOpenFlyoutId(null);
      const parent = navParentOf(id);
      if (parent && (parent.children?.length ?? 0) > 0) onOpenGroup(parent.id);
      onNavigate(id);
    },
    [onNavigate, onOpenGroup],
  );

  return (
    <aside
      data-nav-state={collapsed ? 'collapsed' : 'expanded'}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      className={cn(
        // Springy `--motion-ease-premium` easing on the rail-width settle. motion.dev's
        // spring/`layoutId` continuity is deliberately NOT used here: NavSidebar is on the
        // eager AppShell first-paint graph, and statically importing motion.dev would drag
        // its runtime onto the entry chunk (breaking the <400 kB budget). Full spring/
        // shared-layout on the nav is deferred to a lazy-boundary follow-up.
        'sticky top-0 flex h-dvh shrink-0 flex-col border-r border-border bg-surface',
        reducedMotion
          ? 'transition-none'
          : 'transition-[width] duration-200 ease-premium',
        collapsed ? 'w-16 items-center' : 'w-60',
        className,
      )}
      aria-label="Primary navigation"
    >
      {/* Brand + hamburger header. */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-border',
          collapsed ? 'w-full justify-center px-2' : 'gap-2 px-3',
        )}
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary dark:bg-accent">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-6 w-6 rounded object-contain" />
          ) : (
            <Shield className="h-5 w-5" aria-hidden />
          )}
          {/* Turns while any answer is being written; the logo itself never moves. */}
          <BrandActivityRing />
        </span>
        {!collapsed ? (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {productName || 'Agentic SOC'}
          </span>
        ) : null}
        {!collapsed ? toggleSlot : null}
      </div>

      {/* When collapsed, the hamburger sits just under the brand mark. */}
      {collapsed && toggleSlot ? (
        <div className="flex w-full justify-center py-2">{toggleSlot}</div>
      ) : null}

      <nav className="flex min-h-0 flex-1 flex-col" aria-label="Console destinations">
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden py-3',
            collapsed ? 'items-center gap-1' : 'gap-3 px-2',
            !reducedMotion && 'animate-fade-in',
          )}
        >
          {groups.map((group, gi) =>
            collapsed ? (
              <React.Fragment key={group.id}>
                {gi > 0 ? <Separator className="my-1 w-6" /> : null}
                {group.items.map((item) => (
                  <CollapsedItem
                    key={item.id}
                    item={item}
                    page={page}
                    onNavigate={navigate}
                    open={openFlyoutId === item.id}
                    onOpen={() => setOpenFlyoutId(item.id)}
                    onClose={() => closeFlyout(item.id)}
                    reducedMotion={reducedMotion}
                    activity={activity}
                  />
                ))}
              </React.Fragment>
            ) : (
              <div key={group.id} className="space-y-0.5">
                <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <ExpandedItem
                      key={item.id}
                      item={item}
                      page={page}
                      open={openGroups.has(item.id)}
                      onNavigate={navigate}
                      onToggleGroup={onToggleGroup}
                      reducedMotion={reducedMotion}
                      activity={activity}
                    />
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>

        {footerItems.length > 0 ? (
          <div
            data-testid="nav-footer"
            className={cn(
              'shrink-0 border-t border-border bg-surface py-2',
              collapsed ? 'flex justify-center' : 'px-2',
              !reducedMotion && 'animate-fade-in',
            )}
          >
            {collapsed ? (
              footerItems.map((item) => (
                <CollapsedItem
                  key={item.id}
                  item={item}
                  page={page}
                  onNavigate={navigate}
                  open={openFlyoutId === item.id}
                  onOpen={() => setOpenFlyoutId(item.id)}
                  onClose={() => closeFlyout(item.id)}
                  reducedMotion={reducedMotion}
                  activity={activity}
                />
              ))
            ) : (
              <ul className="space-y-0.5">
                {footerItems.map((item) => (
                  <ExpandedItem
                    key={item.id}
                    item={item}
                    page={page}
                    open={false}
                    onNavigate={navigate}
                    onToggleGroup={onToggleGroup}
                    reducedMotion={reducedMotion}
                  />
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}

export default NavSidebar;
