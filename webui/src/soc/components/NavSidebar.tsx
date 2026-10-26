/**
 * NavSidebar: the console's left navigation (Round 14, SPEC §4.8, C6 A "docked rail with
 * a stable morph").
 *
 * TWO STATES, ONE DOM. A 64 px icon rail or a 240 px labelled drawer, switched only by
 * one explicit toggle (the control under the brand, Ctrl+B or ⌘B, or the 6 px strip just
 * past the panel's right edge, clear of the scrollbar). Hover never expands it. Every row is
 * `[40 px icon cell at x 12][fixed-width label]`: the 18 px icons sit at the same x and y
 * in both states and nothing is swapped. The panel is fixed and 240 px wide in both
 * states; the in-flow spacer (`desktop-navigation-frame`) changes width once, at the
 * click, so the page moves once. The motion lives in `styles/nav.css`.
 *
 * DESTINATIONS ARE LINKS (SPEC §3.3): every row that navigates is an `<a href>` (so a
 * modified click opens a new tab natively); a plain click calls the router, so route
 * guards still apply. A group row opens its target page (the Overview row opens the
 * Dashboards library, §2.2 item 2) and never changes the group's open state (E13); the
 * chevron beside it is a separate 28 px button that only shows or hides the pages.
 *
 * THE COLLAPSED RAIL. A grouped icon opens its page on a click with no flyout flash; its
 * pages appear in a flyout after a 300 ms pointer rest (`nav-hover-intent.ts`) or at once
 * on keyboard focus. ArrowRight enters the flyout; arrows, Home and End move inside;
 * Escape, ArrowLeft or Shift+Tab return to the icon; Tab moves on to the next rail
 * destination (flyout items are out of the tab order). A flyout opened by the pointer
 * also closes on Escape. Other icons get the one rail tooltip (`nav-rail-tip.tsx`). Hit
 * boxes match the visible state: 48 px around the icon in the rail, the full row in the
 * drawer. Collapsing never strands focus: a focused chevron or page hands it to its row.
 *
 * ARIA-CURRENT (SPEC §2.2 item 9): exactly one element in the navigation landmark
 * ("Console destinations", which holds the flyout too) carries `aria-current="page"`:
 * the current child while its list is shown (drawer group open, flyout open, phone
 * sheet), otherwise its group row or rail icon. In forced colours (Windows high
 * contrast), where the tints are dropped, the current pill is drawn as a system outline
 * (`.nav-tint` in `styles/nav.css`) and focus keeps the system focus outline.
 *
 * STATE lives in `nav-store.ts` (collapsed, open groups, the open flyout), so a toggle
 * re-renders the navigation only. The phone variant (`variant="sheet"`, inside the
 * shell's Radix Sheet) has 44 px rows (40 px inside a group), no inner fade, and keeps its
 * open groups still for one open and close cycle.
 *
 * AGENT ACTIVITY (Round 12, SPEC D13): the chat destinations carry the activity glyph on
 * every form (rail badge, drawer rows, flyout, phone sheet) plus the same state as text
 * (`aria-describedby` "nav-activity-<id>", the rail tooltip, the flyout line). Never
 * `aria-busy` on a nav control. Titles in that text are prompt- or model-derived and
 * render as text only (#9). Every other label is a static, in-repository string.
 */
import * as React from 'react';
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Shield, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { comboLabel } from '@/lib/platform-keys';
import '@/styles/nav.css';
import { useAuth } from '../auth';
import { ActivityGlyph, BrandActivityRing } from '../chat-activity/glyph';
import { useChatActivity, type ChatActivitySummary } from '../chat-activity/store';
import {
  NAV_FOOTER_ITEMS,
  NAV_GROUPS,
  navDest,
  navTarget,
  navVisible,
  type NavChild,
  type NavGroup,
  type NavItem,
  type PageId,
} from '../nav';
import { navStore, useNavState } from '../nav-store';
import {
  closeFlyout,
  endFocusSuppression,
  keyboardOpen,
  openFlyout,
  pointerEnterPanel,
  pointerLeavePanel,
  pointerLeftTrigger,
  pointerOverTrigger,
  pointerTrack,
  registerPanel,
  registerTrigger,
  suppressAfterPress,
  suppressFocusReopen,
} from './nav-hover-intent';
import { RailTipLayer, hideRailTip, railTipHandlers } from './nav-rail-tip';

/** One vocabulary for the toggle (ui-standard "Navigation and information architecture"). */
export const NAV_COPY = {
  collapse: 'Collapse navigation',
  expand: 'Expand navigation',
} as const;

/** "Ctrl+B", or "⌘B" on Apple platforms. */
export const navToggleShortcut = (apple?: boolean) => comboLabel(['Mod', 'B'], apple);

/** The destination list the toggle controls (`aria-controls`). */
const DESTINATIONS_ID = 'nav-destinations';

/* -------------------------------------------------------------------------- */
/* Destinations, filtered for the viewer.                                     */
/* -------------------------------------------------------------------------- */

/** A visible top-level destination: the row, the page it opens and its visible pages. */
interface Destination {
  item: NavItem;
  /** The page the row opens ({@link navTarget}). */
  target: PageId;
  /** The group's pages; empty for a plain destination (no chevron, no flyout). */
  pages: NavChild[];
}

interface DestinationGroup {
  group: NavGroup;
  items: Destination[];
}

type HasPerm = (resource: string, action: string) => boolean;

function toDestinations(items: NavItem[], has: HasPerm): Destination[] {
  return items
    .filter((item) => navVisible(item, has))
    .map((item) => {
      const pages = (item.children ?? []).filter((child) => navVisible(child, has));
      // A group whose only page is the row's own page (Notifications > Inbox) is a plain
      // destination: a disclosure that reveals the page you are pointing at adds nothing.
      const plain = pages.length === 1 && navDest(pages[0]) === item.id;
      return { item, target: navTarget(item, has), pages: plain ? [] : pages };
    });
}

function useDestinations(): { groups: DestinationGroup[]; footer: Destination[] } {
  const { hasPermission } = useAuth();
  return React.useMemo(
    () => ({
      groups: NAV_GROUPS.map((group) => ({ group, items: toDestinations(group.items, hasPermission) })).filter(
        (g) => g.items.length > 0,
      ),
      footer: toDestinations(NAV_FOOTER_ITEMS, hasPermission),
    }),
    [hasPermission],
  );
}

/** Where `page` sits in a destination: its trail and the current page in its list. */
function placeOf(dest: Destination, page: PageId): { trail: boolean; current: NavChild | undefined } {
  const current = dest.pages.find((child) => navDest(child) === page);
  return { trail: page === dest.item.id || page === dest.target || Boolean(current), current };
}

/* -------------------------------------------------------------------------- */
/* Agent activity (SPEC D13).                                                 */
/* -------------------------------------------------------------------------- */

/** Nav item id → its chat activity (`chat`: Workspace chat; `case_manager`: case chat). */
type NavActivity = Partial<Record<string, ChatActivitySummary>>;

function useNavActivity(): NavActivity {
  const workspace = useChatActivity((snapshot) => snapshot.workspace);
  const caseChat = useChatActivity((snapshot) => snapshot.case);
  return React.useMemo(() => ({ chat: workspace, case_manager: caseChat }), [workspace, caseChat]);
}

/** The visible state line: with reduced motion the ring stands still, so say "Working". */
function activityText(activity: ChatActivitySummary | undefined, reducedMotion: boolean): string {
  if (!activity?.text) return '';
  return reducedMotion && activity.status === 'running' ? `Working. ${activity.text}` : activity.text;
}

/** The id of the hidden description a destination points at (`aria-describedby`). */
const describedBy = (id: string, activity: ChatActivitySummary | undefined) =>
  activity?.text ? `nav-activity-${id}` : undefined;

/** The hidden descriptions the chat destinations point at (one per destination). */
function ActivityDescriptions({ activity }: { activity: NavActivity }) {
  return (
    <>
      {Object.entries(activity).map(([id, own]) =>
        own?.text ? (
          <span key={id} id={`nav-activity-${id}`} className="sr-only">
            {own.text}
          </span>
        ) : null,
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared parts.                                                              */
/* -------------------------------------------------------------------------- */

/** A plain left click navigates in-app; a modified click keeps the browser's own behaviour. */
function followLink(event: React.MouseEvent<HTMLAnchorElement>, go: () => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  go();
}

const hrefOf = (page: PageId) => `#/${page}`;

/** A page's test id; a host's own page in its list (Workspace > Chat) gets a suffix. */
const childTestId = (host: string, child: string) => (child === host ? `nav-${child}-page` : `nav-${child}`);

/** `inert` for React 18 (a plain attribute there, not a typed prop). */
const inert = (on: boolean): Record<string, string> => (on ? { inert: '' } : {});

/** The brand tile: 36 px, centred on the icon column; the operator's logo never moves. */
function BrandTile({ logoUrl }: { logoUrl?: string }) {
  return (
    // Below `sm` (the phone sheet) only the Chat item's own glyph turns (SPEC-chat T32).
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary dark:bg-accent max-sm:[&>.chat-brand-ring]:hidden">
      {logoUrl ? <img src={logoUrl} alt="" className="h-6 w-6 rounded object-contain" /> : <Shield className="h-5 w-5" aria-hidden />}
      <BrandActivityRing />
    </span>
  );
}

/**
 * The slot above a group (never above the first). A group of several destinations names
 * itself in the drawer and shows a short divider in the rail, cross-faded in one 24 px
 * slot. A group holding one destination of the same name (Intelligence, Analytics,
 * Notifications) repeats nothing: a hairline in both states.
 */
const repeatsItsItem = (group: DestinationGroup) =>
  group.items.length === 1 && group.items[0].item.label === group.group.label;

function GroupSlot({ group, headingId, collapsed }: { group: DestinationGroup; headingId: string; collapsed?: boolean }) {
  if (repeatsItsItem(group)) {
    return (
      <div aria-hidden className="relative my-2 h-px">
        <span className="nav-label absolute inset-y-0 left-3 right-3 bg-border" />
        <span className="nav-railmark absolute inset-y-0 left-3 w-6 bg-border" />
      </div>
    );
  }
  return (
    <div className="relative mt-2 flex h-6 items-center">
      <span id={headingId} aria-hidden={collapsed || undefined} className="nav-label pl-3 text-xs font-medium text-muted-foreground">
        {group.group.label}
      </span>
      <span aria-hidden className="nav-railmark absolute left-3 top-1/2 h-px w-6 bg-border" />
    </div>
  );
}

/**
 * The row tints. On the desktop: the 224 px drawer row and the 40 px rail square,
 * cross-faded. In the phone sheet: the whole row (there is no rail).
 */
function RowTints({ active, open = false, sheet = false }: { active: boolean; open?: boolean; sheet?: boolean }) {
  const tone = active
    ? 'bg-primary/10 dark:bg-accent'
    : open
      ? 'bg-muted'
      : sheet
        ? 'group-active/row:bg-muted'
        : 'group-hover/row:bg-muted';
  const ring = 'group-focus-visible/row:ring-2 group-focus-visible/row:ring-inset group-focus-visible/row:ring-ring';
  // `nav-tint` + `data-active`: forced colours draw the current pill as an outline.
  const current = active ? { 'data-active': '' } : {};
  return (
    <>
      <span
        aria-hidden
        {...current}
        className={cn('nav-tint nav-label pointer-events-none absolute inset-y-0 left-0 rounded-md', sheet ? 'right-0' : 'w-56', tone, ring)}
      />
      {sheet ? null : (
        <span
          aria-hidden
          {...current}
          className={cn('nav-tint nav-railmark pointer-events-none absolute inset-y-0 left-1 w-10 rounded-md', tone, ring)}
        />
      )}
    </>
  );
}

/** The brand link: it opens the Cyber Defence Center. */
function Brand({
  product,
  logoUrl,
  go,
  sheet = false,
  collapsed = false,
}: {
  product: string;
  logoUrl?: string;
  go: (page: PageId) => void;
  sheet?: boolean;
  collapsed?: boolean;
}) {
  return (
    <a
      href={hrefOf('overview')}
      onClick={(event) => followLink(event, () => go('overview'))}
      aria-label={`${product} home`}
      data-nav-rail-focus={sheet ? undefined : ''}
      {...railTipHandlers('brand', `${product} home`, '', collapsed)}
      className="nav-brand flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BrandTile logoUrl={logoUrl} />
      <span className="nav-label min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{product}</span>
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* One row for the rail, the drawer and the phone sheet.                      */
/* -------------------------------------------------------------------------- */

interface RowProps {
  dest: Destination;
  page: PageId;
  /** The phone sheet: 44 px rows (40 px pages), no rail, flyout or tooltip. */
  sheet: boolean;
  collapsed: boolean;
  open: boolean;
  flyoutOpen: boolean;
  activity: NavActivity;
  reducedMotion: boolean;
  go: (page: PageId) => void;
  onToggle: (id: string) => void;
}

const Row = React.memo(function Row({
  dest,
  page,
  sheet,
  collapsed,
  open,
  flyoutOpen,
  activity,
  reducedMotion,
  go,
  onToggle,
}: RowProps) {
  const { item, target, pages } = dest;
  const Icon = item.icon as LucideIcon;
  const grouped = pages.length > 0;
  const { trail, current } = placeOf(dest, page);
  const shown = grouped && !collapsed && open;
  const trigger = grouped && collapsed;
  const own = activity[item.id];
  const ref = React.useRef<HTMLAnchorElement>(null);

  React.useEffect(() => {
    if (!trigger) return undefined;
    registerTrigger(item.id, ref.current);
    return () => registerTrigger(item.id, null);
  }, [trigger, item.id]);

  const tip = railTipHandlers(item.id, item.label, activityText(own, reducedMotion), collapsed && !trigger);
  const listId = `nav-group-${item.id}`;
  const hover = sheet ? '' : 'hover:text-foreground';

  return (
    <li data-nav-item={item.id}>
      <div className="relative flex items-center">
        <a
          ref={ref}
          href={hrefOf(target)}
          onClick={(event) => followLink(event, () => go(target))}
          onPointerDown={(event) => {
            tip.onPointerDown?.();
            if (trigger && event.button === 0) suppressAfterPress(item.id);
          }}
          onPointerMove={(event) => {
            tip.onPointerMove?.(event);
            if (trigger) pointerOverTrigger(item.id, { x: event.clientX, y: event.clientY });
          }}
          onPointerLeave={(event) => {
            tip.onPointerLeave?.();
            if (trigger) pointerLeftTrigger(item.id, { x: event.clientX, y: event.clientY });
          }}
          onFocus={(event) => {
            tip.onFocus?.(event);
            // Keyboard focus opens at once; a pointer focus never does.
            if (trigger && event.currentTarget.matches(':focus-visible')) keyboardOpen(item.id);
          }}
          onBlur={(event) => {
            tip.onBlur?.();
            if (!trigger) return;
            if ((event.relatedTarget as HTMLElement | null)?.closest('[data-nav-flyout]')) return;
            endFocusSuppression(item.id);
            if (navStore.getState().flyout === item.id) closeFlyout();
          }}
          onKeyDown={
            trigger
              ? (event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    if (navStore.getState().flyout !== item.id) openFlyout(item.id);
                    window.requestAnimationFrame(() =>
                      document.querySelector<HTMLElement>('[data-nav-flyout] [data-nav-fly-item]')?.focus(),
                    );
                  } else if (event.key === ' ') {
                    // A grouped icon does what a click does on Space too (it opens its page).
                    event.preventDefault();
                    event.currentTarget.click();
                  } else if (event.key === 'Escape' && navStore.getState().flyout === item.id) {
                    // Dismissed: it stays closed while focus stays on the icon.
                    event.preventDefault();
                    closeFlyout();
                    suppressFocusReopen(item.id);
                  }
                }
              : undefined
          }
          aria-current={trail && !((shown || flyoutOpen) && current) ? 'page' : undefined}
          aria-haspopup={trigger ? 'true' : undefined}
          aria-expanded={trigger ? flyoutOpen : undefined}
          aria-controls={trigger ? `nav-fly-${item.id}` : undefined}
          aria-describedby={describedBy(item.id, own)}
          title={!collapsed && own?.text ? activityText(own, reducedMotion) : undefined}
          data-active-trail={trail || undefined}
          data-testid={`nav-${item.id}`}
          data-nav-rail-focus={sheet ? undefined : ''}
          className={cn(
            'nav-row group/row relative flex min-w-0 flex-1 items-center rounded-md text-left text-sm focus-visible:outline-none',
            sheet ? 'h-11' : 'h-9',
            trail || flyoutOpen ? 'text-foreground' : `text-muted-foreground ${hover}`,
            trail && 'font-medium',
          )}
        >
          <RowTints active={trail && !(shown && current)} open={flyoutOpen} sheet={sheet} />
          <span className={cn('relative ml-1 flex w-10 shrink-0 items-center justify-center', sheet ? 'h-11' : 'h-9')}>
            <Icon className={cn('h-[1.125rem] w-[1.125rem]', trail && 'text-primary')} aria-hidden />
            {/* The rail badge (top right of the icon); the drawer shows the trailing glyph. */}
            {own?.status && !sheet ? (
              <span className="nav-railmark absolute right-1 top-0.5">
                <ActivityGlyph status={own.status} className="block" />
              </span>
            ) : null}
          </span>
          <span
            className={cn(
              'nav-label relative ml-1 flex items-center gap-2',
              sheet ? 'min-w-0 flex-1' : 'w-44 shrink-0',
              grouped ? (sheet ? 'pr-11' : 'pr-9') : 'pr-2',
            )}
          >
            <span className="truncate">{item.label}</span>
            {own?.status ? <ActivityGlyph status={own.status} className="ml-auto" /> : null}
          </span>
        </a>
        {grouped ? (
          <button
            type="button"
            onClick={() => onToggle(item.id)}
            aria-expanded={shown}
            aria-controls={listId}
            aria-label={`${open ? 'Hide' : 'Show'} ${item.label} pages`}
            data-nav-chevron=""
            tabIndex={collapsed ? -1 : undefined}
            {...inert(collapsed)}
            className={cn(
              'nav-label absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              sheet ? 'right-0.5 h-10 w-10' : 'right-1 h-7 w-7 hover:bg-muted hover:text-foreground',
            )}
          >
            <ChevronRight className={cn('nav-chevron h-4 w-4', open && 'rotate-90')} aria-hidden />
          </button>
        ) : null}
      </div>
      {grouped ? (
        <div className="nav-children" data-open={shown ? 'true' : 'false'} aria-hidden={!shown || undefined} {...inert(!shown)}>
          <div className="relative">
            <span aria-hidden className="absolute bottom-1 left-6 top-1 w-px bg-border" />
            <ul id={listId} aria-label={`${item.label} pages`} className="space-y-0.5 py-0.5">
              {pages.map((child) => {
                const childPage = navDest(child);
                const active = page === childPage;
                const childActivity = activity[child.id];
                return (
                  <li key={`${item.id}-${child.id}`}>
                    <a
                      href={hrefOf(childPage)}
                      onClick={(event) => followLink(event, () => go(childPage))}
                      tabIndex={shown ? undefined : -1}
                      aria-current={shown && active ? 'page' : undefined}
                      aria-describedby={describedBy(item.id, childActivity)}
                      title={childActivity?.text ? activityText(childActivity, reducedMotion) : undefined}
                      data-testid={childTestId(item.id, child.id)}
                      className={cn(
                        'group/row relative flex w-full items-center rounded-md pl-[3.25rem] pr-2 text-left text-sm focus-visible:outline-none',
                        sheet ? 'h-10' : 'h-8',
                        active ? 'font-medium text-primary' : `text-muted-foreground ${hover}`,
                      )}
                    >
                      <span
                        aria-hidden
                        data-active={shown && active ? '' : undefined}
                        className={cn(
                          'nav-tint pointer-events-none absolute inset-y-0 left-8 right-0 rounded-md transition-colors duration-150',
                          active ? 'bg-primary/10 dark:bg-accent' : sheet ? 'group-active/row:bg-muted' : 'group-hover/row:bg-muted',
                          'group-focus-visible/row:ring-2 group-focus-visible/row:ring-inset group-focus-visible/row:ring-ring',
                        )}
                      />
                      <span className="relative truncate">{child.label}</span>
                      {childActivity?.status ? <ActivityGlyph status={childActivity.status} className="relative ml-auto" /> : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </li>
  );
});

/** The destinations: the groups (scrolling) and the footer (pinned). */
function DestinationList({
  groups,
  footer,
  row,
  collapsed = false,
  id,
  scrollClassName,
}: {
  groups: DestinationGroup[];
  footer: Destination[];
  row: (dest: Destination) => React.ReactNode;
  collapsed?: boolean;
  id?: string;
  scrollClassName: string;
}) {
  return (
    <div id={id} className="flex min-h-0 flex-1 flex-col">
      <div className={cn('nav-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden', scrollClassName)}>
        {groups.map((group, index) => {
          const headingId = `nav-heading-${group.group.id}`;
          const named = index > 0 && !repeatsItsItem(group);
          return (
            <div key={group.group.id}>
              {index > 0 ? <GroupSlot group={group} headingId={headingId} collapsed={collapsed} /> : null}
              <ul aria-labelledby={named ? headingId : undefined} className="space-y-0.5">
                {group.items.map(row)}
              </ul>
            </div>
          );
        })}
      </div>
      {footer.length > 0 ? (
        <div data-testid="nav-footer" className="shrink-0 border-t border-border px-2 py-2">
          <ul className="space-y-0.5">{footer.map(row)}</ul>
        </div>
      ) : null}
    </div>
  );
}

/** The navigation landmark's one label (the rail and the phone sheet). */
const LANDMARK_LABEL = 'Console destinations';

/* -------------------------------------------------------------------------- */
/* The collapsed rail's flyout.                                               */
/* -------------------------------------------------------------------------- */

/** The collapsed rail's one flyout, outside the clipping layer so nothing clips it. */
function RailFlyout({
  destinations,
  page,
  activity,
  reducedMotion,
  go,
}: {
  destinations: Destination[];
  page: PageId;
  activity: NavActivity;
  reducedMotion: boolean;
  go: (page: PageId) => void;
}) {
  const flyout = useNavState((s) => s.flyout);
  const top = useNavState((s) => s.flyoutTop);
  // A flyout belongs to the 64 px rail: never over the labelled drawer (a rest timer that
  // fires after a keyboard expand finds no flyout to show).
  const collapsed = useNavState((s) => s.collapsed);
  const ref = React.useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = React.useState<number | null>(null);
  const dest = (collapsed && destinations.find((d) => d.item.id === flyout && d.pages.length > 0)) || null;

  React.useLayoutEffect(() => {
    registerPanel(ref.current);
    if (!dest || !ref.current) {
      setPlaced(null);
      return;
    }
    const height = ref.current.offsetHeight || 200;
    setPlaced(Math.max(8, Math.min(top - 8, window.innerHeight - height - 8)));
  }, [dest, top]);

  // One surface at a time: the open flyout hides the rail tooltip.
  React.useEffect(() => {
    if (dest) hideRailTip();
  }, [dest]);

  // Track the pointer while open (the safe triangle), close on a press elsewhere, and
  // close on Escape wherever focus is (WCAG 1.4.13: content opened by hover can be
  // dismissed without moving the pointer); it then stays closed until the pointer leaves
  // the icon. With focus in the flyout or on its icon, their own handlers take Escape
  // (they also hand focus back).
  React.useEffect(() => {
    if (!dest) return undefined;
    const id = dest.item.id;
    const owns = (node: Node | null) =>
      Boolean(node && (ref.current?.contains(node) || document.querySelector(`[data-nav-item="${id}"]`)?.contains(node)));
    const onMove = (event: PointerEvent) => pointerTrack({ x: event.clientX, y: event.clientY });
    const onDown = (event: PointerEvent) => {
      if (owns(event.target as Node | null)) return;
      closeFlyout();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || owns(event.target as Node | null)) return;
      event.preventDefault();
      suppressAfterPress(id);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dest]);

  if (!dest) return null;
  const { item, pages } = dest;
  const own = activity[item.id];
  const trigger = () => document.querySelector<HTMLElement>(`[data-nav-item="${item.id}"] [data-nav-rail-focus]`);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const links = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-nav-fly-item]') ?? []);
    const index = links.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape' || event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      closeFlyout();
      suppressFocusReopen(item.id);
      trigger()?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      links[(index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      links[event.key === 'Home' ? 0 : links.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      // Tab moves on to the next rail destination, as if the flyout were not there.
      event.preventDefault();
      const rail = Array.from(document.querySelectorAll<HTMLElement>('[data-nav-rail-focus]'));
      const from = trigger();
      const next = from ? rail[rail.indexOf(from) + 1] : undefined;
      closeFlyout();
      (next ?? from)?.focus();
    }
  };

  return (
    // A list of links with roving focus: arrows, Home, End, Escape and Tab are handled here.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={ref}
      data-nav-flyout=""
      data-testid={`nav-flyout-${item.id}`}
      onPointerEnter={pointerEnterPanel}
      onPointerLeave={(event) => pointerLeavePanel({ x: event.clientX, y: event.clientY })}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && (ref.current?.contains(next) || trigger()?.contains(next))) return;
        closeFlyout();
      }}
      style={{ top: placed ?? top - 8, visibility: placed === null ? 'hidden' : undefined }}
      className="nav-flyout pointer-events-auto fixed left-[4.5rem] z-[60] w-56 before:absolute before:-left-2 before:top-0 before:h-full before:w-2 before:content-['']"
    >
      <div className="max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-menu">
        <p aria-hidden className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
          {item.label}
        </p>
        {own?.text ? <p className="break-words px-2.5 pb-1.5 text-xs text-muted-foreground">{activityText(own, reducedMotion)}</p> : null}
        <ul id={`nav-fly-${item.id}`} aria-label={`${item.label} pages`} className="space-y-0.5">
          {pages.map((child) => {
            const childPage = navDest(child);
            const active = page === childPage;
            const childActivity = activity[child.id];
            return (
              <li key={`fly-${item.id}-${child.id}`}>
                <a
                  href={hrefOf(childPage)}
                  tabIndex={-1}
                  data-nav-fly-item=""
                  onClick={(event) =>
                    followLink(event, () => {
                      closeFlyout();
                      go(childPage);
                    })
                  }
                  aria-current={active ? 'page' : undefined}
                  aria-describedby={describedBy(item.id, childActivity)}
                  className={cn(
                    'relative flex h-8 w-full items-center gap-2 rounded-sm px-2.5 text-left text-sm transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'bg-primary/10 font-medium text-primary dark:bg-accent' : 'text-foreground hover:bg-muted',
                  )}
                >
                  {active ? <span aria-hidden data-active="" className="nav-tint pointer-events-none absolute inset-0 rounded-sm" /> : null}
                  <span className="relative truncate">{child.label}</span>
                  {childActivity?.status ? <ActivityGlyph status={childActivity.status} className="relative ml-auto" /> : null}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * Collapsing is about to make the chevrons and the group pages inert. If one of them has
 * focus, hand it to its row's link (the group icon in the rail), so it is never dropped.
 */
function keepFocusThroughCollapse(root: HTMLElement | null): void {
  const active = document.activeElement;
  if (!root || !(active instanceof HTMLElement) || !root.contains(active)) return;
  if (!active.closest('.nav-children, [data-nav-chevron]')) return;
  active.closest('li[data-nav-item]')?.querySelector<HTMLElement>('[data-nav-rail-focus]')?.focus({ preventScroll: true });
}

interface SurfaceProps {
  page: PageId;
  onNavigate: (page: PageId) => void;
  logoUrl?: string;
  productName?: string;
  reducedMotion: boolean;
}

function NavRail({ page, onNavigate, logoUrl, productName, reducedMotion }: SurfaceProps) {
  const { groups, footer } = useDestinations();
  const activity = useNavActivity();
  const collapsed = useNavState((s) => s.collapsed);
  const openGroups = useNavState((s) => s.openGroups);
  const flyout = useNavState((s) => s.flyout);
  const asideRef = React.useRef<HTMLElement>(null);
  const hint = React.useMemo(() => navToggleShortcut(), []);
  const product = productName || 'Agentic SOC';
  const everything = React.useMemo(() => [...groups.flatMap((g) => g.items), ...footer], [groups, footer]);

  const go = React.useCallback(
    (target: PageId) => {
      closeFlyout();
      hideRailTip();
      onNavigate(target);
    },
    [onNavigate],
  );
  const toggle = React.useCallback(() => {
    closeFlyout();
    hideRailTip();
    navStore.toggleCollapsed();
  }, []);

  // Whichever path switched the state (the toggle, the strip, Ctrl+B in the shell), the
  // rail's floating surfaces and their pending rest timers go: a flyout or tooltip timer
  // armed in the rail must not fire over the drawer. Expanding reveals open groups with
  // the labels (60 ms in): the flag is set before paint.
  const wasCollapsed = React.useRef(collapsed);
  React.useLayoutEffect(() => {
    const entering = wasCollapsed.current && !collapsed;
    const changed = wasCollapsed.current !== collapsed;
    wasCollapsed.current = collapsed;
    if (changed) {
      closeFlyout();
      hideRailTip();
    }
    const el = asideRef.current;
    if (!entering || !el) return undefined;
    el.dataset.navEntering = 'true';
    const timer = window.setTimeout(() => delete el.dataset.navEntering, 320);
    return () => window.clearTimeout(timer);
  }, [collapsed]);

  // Collapsing makes the chevrons and the open groups' pages inert, and a browser drops
  // focus on an inert element to <body>. Before that happens (the store notifies before
  // React renders), a focused chevron or page hands focus to its row, which stays.
  React.useEffect(() => {
    let was = navStore.getState().collapsed;
    return navStore.subscribe(() => {
      const now = navStore.getState().collapsed;
      if (now && !was) keepFocusThroughCollapse(asideRef.current);
      was = now;
    });
  }, []);

  React.useEffect(
    () => () => {
      closeFlyout();
      hideRailTip();
    },
    [],
  );

  const row = (dest: Destination) => (
    <Row
      key={dest.item.id}
      dest={dest}
      page={page}
      sheet={false}
      collapsed={collapsed}
      open={openGroups.has(dest.item.id)}
      flyoutOpen={flyout === dest.item.id}
      activity={activity}
      reducedMotion={reducedMotion}
      go={go}
      onToggle={navStore.toggleGroup}
    />
  );

  return (
    // The in-flow spacer: 64 or 240 px, changed once at the click, never animated.
    <div data-testid="desktop-navigation-frame" className={cn('relative shrink-0', collapsed ? 'w-16' : 'w-60')}>
      <aside
        ref={asideRef}
        aria-label="Primary navigation"
        data-nav-state={collapsed ? 'collapsed' : 'expanded'}
        data-reduced-motion={reducedMotion ? 'true' : 'false'}
        className="nav-root pointer-events-none fixed inset-y-0 left-0 z-40 w-60"
      >
        {/* The landmark holds the panel AND the flyout: the flyout sits outside the
            clipping layer (nothing clips it) but inside the navigation. */}
        <nav aria-label={LANDMARK_LABEL} className="absolute inset-0">
          <div className="nav-clip pointer-events-auto absolute inset-y-0 left-0 w-60 border-r border-border bg-surface">
            <div className="nav-content flex h-full w-60 flex-col">
              <div className="flex h-14 shrink-0 items-center border-b border-border pl-3.5 pr-2">
                <Brand product={product} logoUrl={logoUrl} go={go} collapsed={collapsed} />
              </div>
              {/* The toggle: one quiet 28 px control in one fixed slot, never remounted, so
                  focus and the pointer stay on it; 8 px of air before the first destination. */}
              <div className="flex shrink-0 items-center px-2 py-2">
                <button
                  type="button"
                  onClick={toggle}
                  {...railTipHandlers('toggle', NAV_COPY.expand, hint, collapsed)}
                  aria-label={collapsed ? NAV_COPY.expand : NAV_COPY.collapse}
                  aria-controls={DESTINATIONS_ID}
                  aria-keyshortcuts="Control+B Meta+B"
                  data-nav-rail-focus=""
                  data-testid="nav-toggle"
                  className="nav-row group/row relative flex h-7 min-w-0 flex-1 items-center rounded-md text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none"
                >
                  <RowTints active={false} />
                  <span className="relative ml-1 flex h-7 w-10 shrink-0 items-center justify-center">
                    <PanelLeftClose className="nav-label absolute h-4 w-4" aria-hidden />
                    <PanelLeftOpen className="nav-railmark absolute h-4 w-4" aria-hidden />
                  </span>
                  {/* Visible only in the drawer, so it always names the drawer's action. */}
                  <span className="nav-label relative ml-1 flex w-44 shrink-0 items-center gap-2 pr-2">
                    <span className="truncate">{NAV_COPY.collapse}</span>
                    <kbd className="ml-auto rounded border border-border bg-muted px-1 font-sans text-2xs text-muted-foreground">
                      {hint}
                    </kbd>
                  </span>
                </button>
              </div>
              <DestinationList
                id={DESTINATIONS_ID}
                groups={groups}
                footer={footer}
                row={row}
                collapsed={collapsed}
                scrollClassName="pb-3 pl-2 pr-0.5"
              />
            </div>
          </div>
          {/* A 6 px click strip just past the panel's visible edge (one more way to toggle;
              the toggle itself is the keyboard path, so the strip stays out of the tab
              order). Outside the panel, so it never covers the destination scrollbar; it
              follows the edge with the clipping layer (styles/nav.css). */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={toggle}
            data-testid="nav-strip"
            className={cn(
              'nav-strip pointer-events-auto absolute inset-y-0 left-60 w-1.5',
              collapsed ? 'cursor-e-resize' : 'cursor-w-resize',
            )}
          />
          <RailFlyout destinations={everything} page={page} activity={activity} reducedMotion={reducedMotion} go={go} />
          <RailTipLayer />
          <ActivityDescriptions activity={activity} />
        </nav>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The phone sheet.                                                           */
/* -------------------------------------------------------------------------- */

function NavSheet({ page, onNavigate, logoUrl, productName, reducedMotion }: SurfaceProps) {
  const { groups, footer } = useDestinations();
  const activity = useNavActivity();
  const product = productName || 'Agentic SOC';
  // The current page's group opens with the sheet (so its one current-page marker is
  // rendered and focus can land on it), and the groups then stay still for this open and
  // close cycle (the Sheet mounts its content when it opens): choosing a page never
  // collapses a group and makes the list jump while the sheet slides out.
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(() => {
    const open = new Set(navStore.getState().openGroups);
    for (const dest of [...groups.flatMap((g) => g.items), ...footer]) {
      if (dest.pages.length > 0 && placeOf(dest, page).current) open.add(dest.item.id);
    }
    return open;
  });
  const openGroupsRef = React.useRef(openGroups);
  openGroupsRef.current = openGroups;
  // The chevron saves the state the sheet SHOWS, not a flip of the stored one: the sheet
  // may show the current page's group open while the stored state has it closed.
  const onToggle = React.useCallback((id: string) => {
    const open = !openGroupsRef.current.has(id);
    navStore.setGroupOpen(id, open);
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const row = (dest: Destination) => (
    <Row
      key={dest.item.id}
      dest={dest}
      page={page}
      sheet
      collapsed={false}
      open={openGroups.has(dest.item.id)}
      flyoutOpen={false}
      activity={activity}
      reducedMotion={reducedMotion}
      go={onNavigate}
      onToggle={onToggle}
    />
  );
  return (
    <aside aria-label="Primary navigation" data-nav-state="expanded" data-nav-variant="sheet" className="flex h-full w-full flex-col bg-surface">
      <nav aria-label={LANDMARK_LABEL} className="flex min-h-0 flex-1 flex-col">
        {/* pr-12 keeps a long product name clear of the Sheet's close button. */}
        <div className="flex h-14 shrink-0 items-center border-b border-border pl-3.5 pr-12">
          <Brand product={product} logoUrl={logoUrl} go={onNavigate} sheet />
          <ActivityDescriptions activity={activity} />
        </div>
        <DestinationList groups={groups} footer={footer} row={row} scrollClassName="px-2 py-2" />
      </nav>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* The component.                                                             */
/* -------------------------------------------------------------------------- */

export interface NavSidebarProps {
  /** The current page (drives the current marker and the active trail). */
  page: PageId;
  /** Navigate to a page (a row's target or a child's page). */
  onNavigate: (page: PageId) => void;
  /** `rail`: the docked desktop rail and drawer. `sheet`: inside the phone's Sheet. */
  variant?: 'rail' | 'sheet';
  /** A logo data URL (trusted branding) for the brand tile; falls back to a shield. */
  logoUrl?: string;
  /** The product name (plain text) beside the brand tile. */
  productName?: string;
  /** Instant layout changes and opacity-only fades (`prefers-reduced-motion`). */
  reducedMotion?: boolean;
}

/** The single navigation surface; the desktop rail or the phone sheet's content. */
export function NavSidebar({ variant = 'rail', reducedMotion = false, ...props }: NavSidebarProps) {
  return variant === 'sheet' ? (
    <NavSheet {...props} reducedMotion={reducedMotion} />
  ) : (
    <NavRail {...props} reducedMotion={reducedMotion} />
  );
}

export default NavSidebar;
