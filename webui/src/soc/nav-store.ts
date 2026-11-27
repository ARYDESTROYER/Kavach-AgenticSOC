/**
 * The navigation state store (Round 14, SPEC §4.8.1 "State store").
 *
 * `collapsed` (64 px rail or 240 px drawer), `openGroups` (the drawer's open disclosure
 * groups), the collapsed rail's open flyout and a page's extra breadcrumb segments live
 * here, outside the 2,000-line AppShell, in a tiny external store read with
 * `useSyncExternalStore`. A toggle therefore re-renders the navigation only, never the
 * shell, the top bar or the routed page.
 *
 * PERSISTENCE (unchanged contract): the rail state hydrates SYNCHRONOUSLY from a
 * `localStorage` mirror on first read (no collapse flash on first paint), the shell's
 * {@link useNavPrefsSync} reconciles it once from the server-side `UserPrefs.misc` after
 * the preference cascade hydrates, and every change writes the mirror at once and
 * `PUT /api/prefs/user` (best effort) one frame later: the request starts right after the
 * toggle's first frame is painted, never inside its input task, and changes made within
 * that frame are merged into one write. Hiding or leaving the page sends a change that is
 * still waiting (best effort: an unload can cancel that request, which is why the wait is
 * one frame, not longer). A key the viewer changed before hydration finished
 * is not overwritten by the (older) server value: that change was also sent to the
 * server, so a later device load reconciles to it anyway. Open-group ids an earlier
 * release stored (`metrics` for the Analytics group) are read in today's ids and the
 * migrated list is written back to both copies.
 *
 * Entry-safe and dependency-light: this module ships in the first-paint chunk.
 */
import * as React from 'react';
import { api } from '@/lib/api';
import type { NavOpts } from './nav-types';
import { usePrefs } from './prefs';
import type { PageId } from './registry';

const LS_COLLAPSED = 'soc.nav.collapsed';
const LS_OPEN_GROUPS = 'soc.nav.openGroups';
/** UserPrefs.misc keys the server mirror writes and reads (Round 3). */
const MISC_COLLAPSED = 'nav_collapsed';
const MISC_OPEN_GROUPS = 'nav_open_groups';

/**
 * Group ids an earlier release stored for a group that now has another id. Round 14
 * gave the Analytics group its own id (`analytics`, finding 20); before that the group
 * WAS the Metrics page, so a viewer who had it open stored `metrics`. A stored list is
 * read through this map, de-duplicated, and the migrated list is written back, so an
 * open Analytics group stays open across the upgrade.
 */
const LEGACY_GROUP_IDS: ReadonlyMap<string, string> = new Map([['metrics', 'analytics']]);

/**
 * The stored open-group list in today's ids: strings only, legacy ids mapped, duplicates
 * dropped (first one wins). `changed` says whether the result differs from what was
 * stored, so a caller writes it back only when there is something to migrate.
 */
function migrateGroups(stored: readonly unknown[]): { list: string[]; changed: boolean } {
  const list = [
    ...new Set(
      stored.filter((id): id is string => typeof id === 'string').map((id) => LEGACY_GROUP_IDS.get(id) ?? id),
    ),
  ];
  return { list, changed: JSON.stringify(list) !== JSON.stringify(stored) };
}

/**
 * One extra breadcrumb segment: a link to `page` (with `opts`), or, last, the current
 * page (its `page` is ignored). The shell renders a link as `<a href>` and follows it
 * through the router, so a page's leave guard (unsaved edits) still asks first; a guard
 * that belongs to one URL of its page (a board's edits) registers with `sameRoute` so
 * the link back to the page's other URL (the library) asks too.
 */
export interface BreadcrumbItem {
  label: string;
  page?: PageId;
  opts?: NavOpts;
}

export interface NavState {
  /** The 64 px icon rail (true) or the 240 px labelled drawer. */
  collapsed: boolean;
  /** The drawer's expanded disclosure groups (host page ids). */
  openGroups: ReadonlySet<string>;
  /** The collapsed rail's open group flyout (its host id), or null. */
  flyout: string | null;
  /** The flyout trigger's top edge in viewport pixels (the panel aligns to it). */
  flyoutTop: number;
  /**
   * The segments a page adds after its own name in the top-bar breadcrumb (a dashboard
   * board: "Dashboards" as a link, then the board name), for that page only.
   */
  trail: { page: string; items: readonly BreadcrumbItem[] } | null;
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable: the state lasts for this page */
  }
}

function readGroups(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readLocal(LS_OPEN_GROUPS) ?? '[]');
    const { list, changed } = migrateGroups(Array.isArray(parsed) ? parsed : []);
    // The mirror is rewritten in today's ids; the server copy migrates in `reconcile`.
    if (changed) writeLocal(LS_OPEN_GROUPS, JSON.stringify(list));
    return new Set(list);
  } catch {
    return new Set();
  }
}

function hydrate(): NavState {
  return {
    collapsed: readLocal(LS_COLLAPSED) === '1',
    openGroups: readGroups(),
    flyout: null,
    flyoutTop: 0,
    trail: null,
  };
}

let state: NavState | null = null;
const listeners = new Set<() => void>();
/** misc keys the viewer changed in this shell session (reconcile leaves them alone). */
const touched = new Set<string>();

function current(): NavState {
  if (!state) state = hydrate();
  return state;
}

function update(patch: Partial<NavState>): void {
  const prev = current();
  const next = { ...prev, ...patch };
  if ((Object.keys(patch) as (keyof NavState)[]).every((key) => next[key] === prev[key])) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** Write `UserPrefs.misc` keys to the server (best effort). */
function putMisc(patch: Record<string, unknown>): void {
  void api.prefs.putUser({ misc: patch }).catch(() => undefined);
}

/**
 * The viewer's changes not yet written, merged into one batch. The write waits for the
 * batch's first frame (an animation-frame callback runs just before that frame paints) and
 * then one task (which runs after the paint), so the request leaves about one frame after
 * the change, outside the input task and its paint. Hiding or leaving the page writes a
 * waiting batch at once (a hidden page may never paint again), and a new session drops it.
 * Nothing is cancelled: the scheduled write sends only its own batch (one already sent or
 * dropped leaves a later batch to its own frame), and the two page listeners do nothing
 * while nothing waits, so they are never removed (a listener added again is still one).
 */
let pending: Record<string, unknown> | null = null;

/** Write the waiting changes now (the scheduled task, or the page being hidden or left). */
function flushPersist(): void {
  const patch = pending;
  pending = null;
  if (patch) putMisc(patch);
}

const flushWhenHidden = () => document.hidden && flushPersist();

function persist(patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) touched.add(key);
  if (!pending) {
    const batch = (pending = {});
    addEventListener('pagehide', flushPersist);
    document.addEventListener('visibilitychange', flushWhenHidden);
    requestAnimationFrame(() => setTimeout(() => batch === pending && flushPersist()));
  }
  Object.assign(pending, patch);
}

function commitGroups(next: Set<string>): void {
  const list = Array.from(next);
  writeLocal(LS_OPEN_GROUPS, JSON.stringify(list));
  persist({ [MISC_OPEN_GROUPS]: list });
  update({ openGroups: next });
}

const sameTrail = (a: readonly BreadcrumbItem[], b: readonly BreadcrumbItem[]) =>
  JSON.stringify(a) === JSON.stringify(b);

export const navStore = {
  getState: current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setCollapsed(collapsed: boolean): void {
    writeLocal(LS_COLLAPSED, collapsed ? '1' : '0');
    persist({ [MISC_COLLAPSED]: collapsed });
    // A flyout belongs to the rail: switching state closes it.
    update({ collapsed, flyout: null });
  },
  toggleCollapsed(): void {
    navStore.setCollapsed(!current().collapsed);
  },
  toggleGroup(id: string): void {
    navStore.setGroupOpen(id, !current().openGroups.has(id));
  },
  /**
   * Show or hide one group's pages. The phone sheet sets the state it shows rather than
   * flipping the stored one: it may show a group open that the stored state has closed
   * (it opens the current page's group without saving that).
   */
  setGroupOpen(id: string, open: boolean): void {
    if (current().openGroups.has(id) === open) return;
    const next = new Set(current().openGroups);
    if (open) next.add(id);
    else next.delete(id);
    commitGroups(next);
  },
  openGroup(id: string): void {
    navStore.setGroupOpen(id, true);
  },
  setFlyout(id: string | null, top = current().flyoutTop): void {
    update({ flyout: id, flyoutTop: top });
  },
  /** A page's extra breadcrumb segments; `null` clears them (only that page's). */
  setTrail(page: string, items: readonly BreadcrumbItem[] | null): void {
    const trail = current().trail;
    if (!items) {
      if (trail?.page === page) update({ trail: null });
      return;
    }
    if (trail?.page === page && sameTrail(trail.items, items)) return;
    update({ trail: { page, items: [...items] } });
  },
  /**
   * Reconcile once from the server's `UserPrefs.misc` (the cascade has hydrated). Keys the
   * viewer changed in this session keep their value.
   */
  reconcile(misc: Record<string, unknown>): void {
    const patch: Partial<NavState> = {};
    const collapsed = misc[MISC_COLLAPSED];
    if (!touched.has(MISC_COLLAPSED) && typeof collapsed === 'boolean') {
      patch.collapsed = collapsed;
      writeLocal(LS_COLLAPSED, collapsed ? '1' : '0');
    }
    const groups = misc[MISC_OPEN_GROUPS];
    if (!touched.has(MISC_OPEN_GROUPS) && Array.isArray(groups)) {
      const { list, changed } = migrateGroups(groups);
      patch.openGroups = new Set(list);
      writeLocal(LS_OPEN_GROUPS, JSON.stringify(list));
      // The store owns this key: a list stored in an earlier release's ids is migrated
      // on the server once, so every other device reads today's ids too. The viewer did
      // not change anything, so the key is not marked as touched.
      if (changed) putMisc({ [MISC_OPEN_GROUPS]: list });
    }
    update(patch);
  },
  /**
   * A new shell session (the shell mounts after a sign-in): re-read the mirror and forget
   * earlier changes. Silent on purpose: it runs while the shell renders, before any
   * navigation subscribes, so there is nobody to notify (and notifying during another
   * component's render is not allowed).
   */
  beginSession(): void {
    // A change still waiting belongs to the session that just ended: it is not sent
    // under the new one.
    pending = null;
    touched.clear();
    state = hydrate();
  },
};

/** Read one slice of the navigation state; re-renders only when that slice changes. */
export function useNavState<T>(selector: (s: NavState) => T): T {
  const read = () => selector(current());
  return React.useSyncExternalStore(navStore.subscribe, read, read);
}

/**
 * The shell's one persistence hook: starts a session on mount and reconciles the rail
 * state from the server's `UserPrefs.misc` once the preference cascade has hydrated.
 */
export function useNavPrefsSync(): void {
  const { prefs, ready } = usePrefs();
  const reconciled = React.useRef(false);
  React.useState(() => {
    navStore.beginSession();
    return true;
  });
  React.useEffect(() => {
    if (!ready || reconciled.current) return;
    reconciled.current = true;
    navStore.reconcile((prefs.misc ?? {}) as Record<string, unknown>);
  }, [ready, prefs.misc]);
}

/**
 * Give the top-bar breadcrumb a page's extra segments while it is mounted (SPEC §2.2
 * item 6): a dashboard board passes `[{ label: 'Dashboards', page: 'dashboards' },
 * { label: boardName }]`, so the bar reads "Agentic SOC / Dashboards / SOC operations".
 * The segments REPLACE the page's own label; the last one is the current page and the
 * others are links. They show only while `page` is the current page, and clear on unmount.
 */
export function useBreadcrumbTrail(page: string, items: readonly BreadcrumbItem[] | null): void {
  const key = items ? JSON.stringify(items) : '';
  React.useEffect(() => {
    navStore.setTrail(page, key ? (JSON.parse(key) as BreadcrumbItem[]) : null);
  }, [page, key]);
  React.useEffect(() => () => navStore.setTrail(page, null), [page]);
}

/** The imperative form of {@link useBreadcrumbTrail} (`null` clears the page's segments). */
export function setBreadcrumbTrail(page: string, items: readonly BreadcrumbItem[] | null): void {
  navStore.setTrail(page, items);
}
