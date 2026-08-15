/**
 * Tiny hash router for the SOC console.
 *
 * Routes are `#/<pageid>`; an unknown/empty hash resolves to `overview`. Most
 * navigation options (`{ status?, severity?, ... }`) live only in React state
 * next to the page id, so a KPI drill-through can pre-seed Cases without turning
 * every ephemeral filter into URL state. The selected `caseId` is the deliberate
 * exception: it is serialized so a Cases → Case Manager handoff, refresh, or
 * browser-history navigation reopens the exact case. A `hashchange` listener keeps
 * those durable deep-links and in-memory navigation in sync.
 *
 * Usage:
 *   <RouterProvider><AppShell/></RouterProvider>
 *   const { page, opts, navigate } = useRoute();
 *   navigate('cases', { status: 'open' });
 */
import * as React from 'react';
import { isPageId, type PageId } from './nav';
import type { NavOpts } from '@/lib/types';
import { ConfirmDialog } from './components/ConfirmDialog';
import {
  hasValidRouteEncoding,
  isSafeCaseId,
  isSafeCaseResultAssignee,
  isSafeCaseResultStatus,
  isSafeCaseResultTag,
} from './case-result-route';

export type { PageId } from './nav';

/** Navigation function: switch page, optionally pre-seeding destination state. */
export type Navigate = (page: PageId, opts?: NavOpts) => void;

export interface NavigationBlockerOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type RegisterNavigationBlocker = (options: NavigationBlockerOptions) => () => void;

interface RouteState {
  page: PageId;
  opts?: NavOpts;
  navigate: Navigate;
  registerNavigationBlocker: RegisterNavigationBlocker;
}

const RouteContext = React.createContext<RouteState | null>(null);

/**
 * Round-5 Sett-B — the six formerly-standalone admin/account homes collapsed INTO
 * Settings sections. This map redirects each retired standalone route (and its legacy
 * in-app `navigate('<id>')` call) onto its Settings section. A hit rewrites the hash to
 * `#/settings?s=<sectionId>` and resolves to the `settings` page, so:
 *   - a bookmarked `#/users` / `#/security` / `#/sessions` / `#/account` / `#/roles` /
 *     `#/admin_sessions` deep-link keeps working (lands inside Settings), and
 *   - an in-app `navigate('account')` (the top-bar user menu) / `navigate('security')`
 *     (Account → 2FA hand-off) does the same — one home, not two.
 *
 * Only the STANDALONE PAGE ids are aliased (not the `settings` page itself). Section ids
 * stay stable, so no `?s=<old>` → `?s=<new>` aliasing is needed; if a section id ever
 * changes, add its old→new mapping to {@link SECTION_ALIASES} below.
 */
export const SETTINGS_REDIRECTS: Readonly<Record<string, string>> = {
  // Personal: `#/account` and the top-bar "Profile" item → the Profile section.
  account: 'profile',
  // The retired `#/security` standalone page LED with self-service 2FA (its admin
  // SSO block was `settings:manage`-gated below), and the top-bar "Security &
  // two-factor" item is personal — so it lands on the PERSONAL 2FA section, not the
  // org SSO section (reachable via Settings › Security & access › Single sign-on).
  security: 'account_security',
  sessions: 'sessions',
  // Org (Security & access group):
  users: 'admin_users',
  roles: 'roles',
  admin_sessions: 'admin_sessions',
};

/**
 * Legacy Settings section id → current section id. Empty today (Sett-B renamed display
 * LABELS only, keeping every section `id` stable). Kept as the single place to add an
 * alias should a section id ever change, so `#/settings?s=<old>` never dead-ends.
 */
export const SECTION_ALIASES: Readonly<Record<string, string>> = {};

/** True when `id` is a retired standalone route that now lives inside Settings. */
export function isSettingsRedirect(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REDIRECTS, id);
}

/**
 * Rewrite a retired standalone-route hash (or a bare page id) into its Settings-section
 * hash. Returns the canonical `#/settings?s=<sectionId>` string when `id` is a
 * redirect target, else `null` (no rewrite). Pure — does not touch `window`.
 */
export function settingsRedirectHash(id: string): string | null {
  const section = SETTINGS_REDIRECTS[id];
  return section ? `#/settings?s=${section}` : null;
}

/**
 * Build the canonical Settings-section hash `#/settings?s=<section>[&a=<anchor>]`.
 *
 * This is the SINGLE place the `?s=`/`&a=` query is assembled, so a Cmd-K jump, a
 * card-level deep-link, and the Settings page's own hash writer all agree on the exact
 * shape. `section`/`anchor` are id-shaped (`[a-z0-9_-]`), but we still
 * `encodeURIComponent` defensively so an unexpected value can never break the hash.
 * Pure — does not touch `window`.
 */
export function settingsSectionHash(section: string, anchor?: string): string {
  const s = encodeURIComponent(section);
  const a = anchor ? `&a=${encodeURIComponent(anchor)}` : '';
  return `#/settings?s=${s}${a}`;
}

/**
 * Build a page hash while preserving the one operator context that must survive a
 * refresh: the exact case selected in Cases / Case Manager. Other transient list
 * filters remain in memory; Settings keeps its dedicated section hash above.
 */
export function pageHash(page: PageId, opts?: NavOpts): string {
  const params = new URLSearchParams();
  if ((page === 'cases' || page === 'case_manager') && opts?.caseId) {
    params.set('caseId', opts.caseId);
  }
  if (page === 'cases') {
    if (opts?.status) params.set('status', opts.status);
    if (opts?.assignee) params.set('assignee', opts.assignee);
    if (opts?.tag) params.set('tag', opts.tag);
  }
  if (page === 'metrics' && opts?.tab === 'effectiveness') {
    params.set('tab', opts.tab);
  }
  const query = params.toString().replace(/\+/g, '%20');
  return `#/${page}${query ? `?${query}` : ''}`;
}

/** Parse `#/<pageid>` from the location hash; unknown/empty → 'overview'. */
export function pageFromHash(): PageId {
  try {
    const raw = (window.location.hash || '').replace(/^#\/?/, '').split(/[?&/]/)[0];
    // A retired standalone route (e.g. `#/roles`) resolves to the `settings` page —
    // the hash is normalised to `#/settings?s=<id>` in the RouterProvider effect so the
    // Settings sub-router picks the right section.
    if (isSettingsRedirect(raw)) return 'settings';
    return isPageId(raw) ? raw : 'overview';
  } catch {
    return 'overview';
  }
}

/**
 * Parse whitelisted deep-link query opts from the location hash (e.g.
 * `#/cases?caseId=<id>`), so a FRESH tab / bookmark / refresh lands with the same opts an
 * in-app `navigate(page, opts)` would carry. This is what makes the CaseDetail "Open in
 * new tab" button work: the new tab boots straight into the case sheet. Only known keys
 * are read; unknown, duplicate, or malformed keys fail closed. Returns undefined
 * when nothing valid is present.
 */
export function optsFromHash(): NavOpts | undefined {
  try {
    const hash = window.location.hash || '';
    const qi = hash.indexOf('?');
    if (qi < 0) return undefined;
    const page = pageFromHash();
    const rawQuery = hash.slice(qi + 1);
    if (!hasValidRouteEncoding(rawQuery)) return undefined;
    const params = new URLSearchParams(rawQuery);
    const allowed =
      page === 'cases'
        ? new Set(['caseId', 'status', 'assignee', 'tag'])
        : page === 'case_manager'
          ? new Set(['caseId'])
          : page === 'metrics'
            ? new Set(['tab'])
            : new Set<string>();
    if (Array.from(params.keys()).some((key) => !allowed.has(key))) return undefined;
    if (Array.from(allowed).some((key) => params.getAll(key).length > 1)) return undefined;
    const read = (key: string, validator: (value: string) => boolean): string | undefined => {
      const value = params.get(key)?.trim();
      return value && validator(value) ? value : undefined;
    };
    if (page === 'metrics') {
      return params.get('tab') === 'effectiveness' ? { tab: 'effectiveness' } : undefined;
    }
    const caseId = read('caseId', isSafeCaseId);
    const status = read('status', isSafeCaseResultStatus);
    const assignee = read('assignee', isSafeCaseResultAssignee);
    const tag = read('tag', isSafeCaseResultTag);
    if (params.has('caseId') && !caseId) return undefined;
    if (params.has('status') && !status) return undefined;
    if (params.has('assignee') && !assignee) return undefined;
    if (params.has('tag') && !tag) return undefined;
    return caseId || status || assignee || tag ? { caseId, status, assignee, tag } : undefined;
  } catch {
    return undefined;
  }
}

export const RouterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [page, setPage] = React.useState<PageId>(() => pageFromHash());
  // Seed opts from the hash query on first paint so a deep-link / new tab (e.g.
  // `#/cases?caseId=<id>`) lands with its opts, exactly like an in-app navigate would.
  const [opts, setOpts] = React.useState<NavOpts | undefined>(() => optsFromHash());

  // Route-leave guards are registered by the currently mounted page. Keeping the
  // registry in refs avoids re-rendering the whole shell as a form becomes dirty,
  // while the token/cleanup contract makes the hook safe across lazy-route unmounts.
  const blockersRef = React.useRef(new Map<symbol, NavigationBlockerOptions>());
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const [pendingNavigation, setPendingNavigation] = React.useState<{
    page: PageId;
    opts?: NavOpts;
    blocker: NavigationBlockerOptions;
  } | null>(null);
  const pendingRef = React.useRef(false);

  const registerNavigationBlocker = React.useCallback<RegisterNavigationBlocker>((options) => {
    const token = Symbol('navigation-blocker');
    blockersRef.current.set(token, options);
    return () => blockersRef.current.delete(token);
  }, []);

  const resolveNavigation = React.useCallback((next: PageId, nextOpts?: NavOpts) => {
    const redirect = settingsRedirectHash(next);
    if (redirect) {
      return { page: 'settings' as PageId, opts: undefined, hash: redirect };
    }
    if (next === 'settings' && nextOpts?.section) {
      return {
        page: next,
        opts: nextOpts,
        hash: settingsSectionHash(nextOpts.section, nextOpts.anchor),
      };
    }
    return { page: next, opts: nextOpts, hash: pageHash(next, nextOpts) };
  }, []);

  const commitNavigation = React.useCallback(
    (next: PageId, nextOpts?: NavOpts) => {
      const target = resolveNavigation(next, nextOpts);
      // Update the ref synchronously so a rapid second activation sees the accepted
      // destination even before React commits the state update.
      pageRef.current = target.page;
      setPage(target.page);
      setOpts(target.opts);
      if (window.location.hash !== target.hash) window.location.hash = target.hash;
    },
    [resolveNavigation],
  );

  const navigate = React.useCallback<Navigate>((next, nextOpts) => {
    const target = resolveNavigation(next, nextOpts);
    // Same-page transitions (notably Settings section/anchor jumps) preserve the
    // mounted draft, so they must not nag. A route leave is paused BEFORE state/hash
    // mutation and resumed only after the shared accessible ConfirmDialog resolves.
    if (target.page !== pageRef.current && blockersRef.current.size > 0) {
      if (pendingRef.current) return;
      const blocker = Array.from(blockersRef.current.values()).at(-1);
      if (blocker) {
        pendingRef.current = true;
        setPendingNavigation({ page: next, opts: nextOpts, blocker });
        return;
      }
    }
    commitNavigation(next, nextOpts);
  }, [commitNavigation, resolveNavigation]);

  React.useEffect(() => {
    const onHashChange = () => {
      // Normalise a retired standalone-route hash to its Settings section BEFORE
      // resolving the page (so `#/roles` → `#/settings?s=roles` before paint).
      const raw = (window.location.hash || '').replace(/^#\/?/, '').split(/[?&/]/)[0];
      const redirect = settingsRedirectHash(raw);
      if (redirect && window.location.hash !== redirect) {
        window.location.hash = redirect; // re-fires hashchange; the next pass settles
        return;
      }
      const next = pageFromHash();
      setPage((prev) => {
        if (prev === next) {
          // A same-page case change (e.g. Case Manager queue row A → row B)
          // changes only the query. Reconcile that explicit durable option, but do
          // not erase in-memory list filters such as a severity drill-through when
          // their navigate() hash change settles on the already-updated page.
          const hashOpts = optsFromHash();
          if (hashOpts) setOpts(hashOpts);
          return prev;
        }
        // Back/forward/direct navigation to a different page carries only durable
        // options represented in the hash; transient filter state is intentionally reset.
        setOpts(optsFromHash());
        return next;
      });
    };
    window.addEventListener('hashchange', onHashChange);
    // Normalise the initial hash. A retired standalone deep-link rewrites to its Settings
    // section; a bare `#` / unknown id reflects the resolved page. CRUCIALLY, when the
    // hash's page id ALREADY resolves to the current page we leave the hash UNTOUCHED, so
    // any `?s=<section>&a=<anchor>` query on a bookmarked/refreshed `#/settings?s=...` is
    // preserved (previously the effect collapsed it to the bare `#/settings`, stripping
    // the section deep-link before the lazy Settings chunk could read it).
    const initialRaw = (window.location.hash || '').replace(/^#\/?/, '').split(/[?&/]/)[0];
    const initialRedirect = settingsRedirectHash(initialRaw);
    if (initialRedirect) {
      if (window.location.hash !== initialRedirect) window.location.hash = initialRedirect;
    } else if (initialRaw !== page) {
      // Only rewrite when the current hash's page id differs from the resolved page
      // (e.g. a bare `#`, an unknown id, or a trailing slash) — never when it merely
      // carries a query for the same page.
      window.location.hash = '#/' + page;
    }
    return () => window.removeEventListener('hashchange', onHashChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo<RouteState>(
    () => ({ page, opts, navigate, registerNavigationBlocker }),
    [page, opts, navigate, registerNavigationBlocker],
  );

  return (
    <RouteContext.Provider value={value}>
      {children}
      {pendingNavigation ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              pendingRef.current = false;
              setPendingNavigation(null);
            }
          }}
          title={pendingNavigation.blocker.title}
          description={pendingNavigation.blocker.description}
          confirmLabel={pendingNavigation.blocker.confirmLabel ?? 'Leave page'}
          cancelLabel={pendingNavigation.blocker.cancelLabel ?? 'Keep editing'}
          onConfirm={() => {
            const target = pendingNavigation;
            pendingRef.current = false;
            setPendingNavigation(null);
            commitNavigation(target.page, target.opts);
          }}
        />
      ) : null}
    </RouteContext.Provider>
  );
};

/** Access the current route (page + opts) and the navigate function. */
export function useRoute(): RouteState {
  const ctx = React.useContext(RouteContext);
  if (!ctx) {
    throw new Error('useRoute must be used within a <RouterProvider>');
  }
  return ctx;
}

/** Convenience hook returning just the navigate function. */
export function useNavigate(): Navigate {
  return useRoute().navigate;
}

/**
 * Pause in-app route leaves while a mounted editor owns unsaved state. Browser
 * reload/tab-close protection remains the responsibility of `useUnsavedChanges`;
 * this hook covers the Console's programmatic hash navigation without `window.confirm`.
 */
export function useNavigationBlocker(
  enabled: boolean,
  options: NavigationBlockerOptions,
): void {
  const ctx = React.useContext(RouteContext);
  const { title, description, confirmLabel, cancelLabel } = options;
  React.useEffect(() => {
    if (!enabled || !ctx) return;
    return ctx.registerNavigationBlocker({
      title,
      description,
      confirmLabel,
      cancelLabel,
    });
  }, [
    enabled,
    ctx,
    title,
    description,
    confirmLabel,
    cancelLabel,
  ]);
}

/**
 * A no-op {@link Navigate} used as the fallback when a component renders OUTSIDE a
 * {@link RouterProvider} (e.g. a page mounted standalone in a unit test that does not
 * wrap the router). Stable identity so it never re-triggers effects.
 */
const NOOP_NAVIGATE: Navigate = () => undefined;

/**
 * Round-5 Coupling-A — the navigation seam for pages that no longer receive an
 * `onNavigate` prop from `App`. Unlike {@link useNavigate}, this SOFT-reads the router
 * context and NEVER throws when there is no provider: it returns the real `navigate`
 * when mounted under `<RouterProvider>` (the app), and a stable no-op otherwise (a
 * standalone unit-test render). Pages resolve navigation as `onNavigate ?? useNavigateOptional()`
 * so an explicit prop (host/embed/test) still wins, App-mounted pages get the real
 * navigate from context, and a provider-less test render degrades to a harmless no-op
 * instead of crashing. Keeps deep-links + drill-throughs working without prop-drilling.
 */
export function useNavigateOptional(): Navigate {
  const ctx = React.useContext(RouteContext);
  return ctx ? ctx.navigate : NOOP_NAVIGATE;
}
