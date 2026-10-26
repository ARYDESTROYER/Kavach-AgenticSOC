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
 * the preference cascade hydrates, and every change writes both the mirror and
 * `PUT /api/prefs/user` (best effort). A key the viewer changed before hydration finished
 * is not overwritten by the (older) server value: that change was also sent to the
 * server, so a later device load reconciles to it anyway.
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
    return new Set(Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : []);
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

function persist(patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) touched.add(key);
  void api.prefs.putUser({ misc: patch }).catch(() => undefined);
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
      const list = groups.filter((g): g is string => typeof g === 'string');
      patch.openGroups = new Set(list);
      writeLocal(LS_OPEN_GROUPS, JSON.stringify(list));
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
