/**
 * Tiny hash router for the SOC console.
 *
 * Routes are `#/<pageid>`; an unknown/empty hash resolves to `overview`, and an alias
 * (`#/dashboard`, `#/playbooks`, `#/catalog`, `#/scans`) is replaced by its destination
 * ({@link redirectRoute}). Most
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
  /**
   * Also ask before a navigation that stays on this page but changes its URL (a
   * dashboard board back to the library: `#/dashboards?board=x` to `#/dashboards`).
   * Off by default, so a page whose own state lives in the query (Settings sections)
   * keeps its draft through its own jumps without asking.
   */
  sameRoute?: boolean;
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

/*
 * Deep links: the durable keys each page owns in its hash (chat revamp SPEC §10.7, Round
 * 14 SPEC §2.2, §4.5.1, §4.6.6, §4.8.2, §4.10.12). Ids use the backend's plain-id grammar;
 * free text (a log query, an audit search, a rule) is bounded and has no control, format
 * (bidi, zero-width) or separator characters; time bounds are `now[-<n><unit>]` or an
 * ISO-8601 shape (the page re-validates the window). `newChat`, `topic` and the palette's
 * free-text `ask` are absent on purpose: they stay in memory so a refresh never starts
 * another chat or asks again. Kept compact: this module ships in the entry chunk.
 */
type Check = (value: string) => boolean;
const re = (pattern: RegExp): Check => (value) => pattern.test(value);
const text = (max: number) => re(new RegExp(`^[^\\p{C}\\u2028\\u2029]{1,${max}}$`, 'u'));
const NAV_ID = /^[\w.:-]{1,128}$/;
const navId = re(NAV_ID);
// No space: a hand-typed `+05:00` reaches URLSearchParams as a space and must fail
// closed (pageHash writes `+` as `%2B`, which round-trips).
const navTime = re(/^(now(-\d{1,5}[mhdw])?|\d{4}-\d\d-\d\d[\dTt:.Zz+-]{0,24})$/);
const severity = re(/^(info|low|medium|high|critical)$/);
/** "Rule is": the exact rule value, 256 characters, spaces and any letters allowed. */
const ruleValue = text(256);
/** An IPv4 dotted quad, or an IPv6 address the URL parser accepts. */
const ipAddress: Check = (value) => {
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(value)) return false;
  if (!value.includes(':')) return /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.|$)){4}$/.test(value) && !value.endsWith('.');
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
};
/** An audit record id (E12 as resolved for WP-A4a): opaque and store-prefixed, at most 947 characters. */
const auditRecord = re(/^(demo:)?(es:[a-z0-9._+-]{1,255}:[A-Za-z0-9_-]{2,683}|sql:-?[1-9]\d{0,18}|mem:\d{1,12})$/);
const DEEP_LINK_KEYS: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
  chat: { conversationId: navId, messageId: navId },
  reports: { reportId: navId },
  logs: {
    logQuery: text(512),
    from: navTime,
    to: navTime,
    sourceId: navId,
    rule: ruleValue,
    severity,
    severity_gte: severity,
  },
  // `builtin:<id>`, a personal board id, `u:<sha8>` or `new` (SPEC §2.2 item 4).
  dashboards: { board: navId },
  // `new` is reserved, so no runbook can carry it (SPEC §4.10.2).
  runbooks: { id: re(/^[a-z0-9][a-z0-9_-]{0,63}$/) },
  audit: {
    scope: re(/^(people|agent|all)$/),
    from: navTime,
    to: navTime,
    q: text(200),
    event: re(/^[a-z_]{1,32}(\.[a-z_]{1,32})?$/),
    actor: text(128),
    actor_contains: text(128),
    outcome: re(/^(success|failure|denied|partial|unknown)$/),
    case: navId,
    target: navId,
    ip: ipAddress,
    record: auditRecord,
  },
};

/** The Cases page's two virtual status facets (Overview drill-throughs write them). */
const isCasesStatus = (value: string) =>
  value === '__active__' || value === '__terminal__' || isSafeCaseResultStatus(value);

/**
 * Case keys are read trimmed; every other key must validate exactly (a log query and a
 * rule value are kept as typed, so a rule round-trips byte for byte).
 */
const trimsHashValue = (page: PageId, key: string) =>
  (page === 'cases' || page === 'case_manager') && key !== 'rule';

/** The query keys each page owns in its hash ({@link pageHash}), with their validators. */
function hashKeys(page: PageId): Readonly<Record<string, Check>> {
  if (page === 'cases') {
    return {
      caseId: isSafeCaseId,
      status: isCasesStatus,
      assignee: isSafeCaseResultAssignee,
      tag: isSafeCaseResultTag,
      rule: ruleValue,
    };
  }
  // The engine's closer values (the `closed_by` filter of GET /api/cases); `#/scans` uses `agent`.
  if (page === 'case_manager') return { caseId: isSafeCaseId, closedBy: re(/^(agent|analyst|analyst_policy|system)$/) };
  if (page === 'metrics') return { tab: (value) => value === 'effectiveness' };
  return DEEP_LINK_KEYS[page] ?? {};
}

/**
 * Build a page hash while preserving the operator context that must survive a refresh:
 * the exact case selected in Cases / Case Manager and every validated deep-link key
 * ({@link DEEP_LINK_KEYS}). Other transient list filters remain in memory; Settings
 * keeps its dedicated section hash above. Empty keys are omitted, never written as `k=`.
 */
export function pageHash(page: PageId, opts?: NavOpts): string {
  const params = new URLSearchParams();
  const values = (opts ?? {}) as Record<string, unknown>;
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
  const validated = { ...DEEP_LINK_KEYS[page] };
  if (page === 'cases') validated.rule = ruleValue;
  if (page === 'case_manager') validated.closedBy = hashKeys(page).closedBy;
  for (const [key, valid] of Object.entries(validated)) {
    const value = values[key];
    // A message anchor without its (valid) conversation would be unreadable on refresh.
    if (typeof value === 'string' && valid(value) && (key !== 'messageId' || NAV_ID.test(opts?.conversationId ?? ''))) {
      params.set(key, value);
    }
  }
  const query = params.toString().replace(/\+/g, '%20');
  return `#/${page}${query ? `?${query}` : ''}`;
}

/**
 * Round 14 page redirects (SPEC §2.2 item 3, D27, D44): an alias or a retired page id
 * and where it lands. `#/dashboard` is the landing page's old child URL; `#/playbooks`
 * and `#/catalog` open the one Runbooks feature for one release; `#/scans` opens Case
 * Manager filtered to the cases the AI agent closed. The router replaces the hash
 * (`history.replaceState`), so Back never bounces through an alias.
 */
const PAGE_REDIRECTS: Readonly<Partial<Record<PageId, { page: PageId; opts?: NavOpts }>>> = {
  dashboard: { page: 'overview' },
  playbooks: { page: 'runbooks' },
  catalog: { page: 'runbooks' },
  scans: { page: 'case_manager', opts: { closedBy: 'agent' } },
};

/** The Cyber Defence Center's card id: opened as a board it is the landing page itself. */
export const LANDING_BOARD_ID = 'builtin:cyber-defence-center';

/**
 * Apply {@link PAGE_REDIRECTS} and the landing-board rule to a route. Returns
 * `redirected: true` when the route changed, so the caller can replace the hash.
 */
export function redirectRoute(page: PageId, opts?: NavOpts): { page: PageId; opts?: NavOpts; redirected: boolean } {
  const hit = PAGE_REDIRECTS[page];
  if (hit) return { page: hit.page, opts: hit.opts ? { ...hit.opts } : undefined, redirected: true };
  if (page === 'dashboards' && opts?.board === LANDING_BOARD_ID) return { page: 'overview', redirected: true };
  return { page, opts, redirected: false };
}

/** The page id segment of a hash (`#/cases?x` gives `cases`). */
const rawPageOf = (hash: string) => hash.replace(/^#\/?/, '').split(/[?&/]/)[0];

/**
 * Parse whitelisted deep-link query opts for `page` from `hash`. Only known keys are
 * read; unknown, duplicate, or malformed keys fail closed (the whole query is dropped).
 */
function parseOpts(page: PageId, hash: string): NavOpts | undefined {
  const qi = hash.indexOf('?');
  if (qi < 0) return undefined;
  const rawQuery = hash.slice(qi + 1);
  if (!hasValidRouteEncoding(rawQuery)) return undefined;
  const params = new URLSearchParams(rawQuery);
  const keys = hashKeys(page);
  if (Array.from(params.keys()).some((key) => !Object.prototype.hasOwnProperty.call(keys, key) || params.getAll(key).length > 1)) return undefined;
  // Every key must validate ({@link trimsHashValue}); one bad key, or a message anchor
  // without its conversation, rejects the whole link.
  const out: Record<string, string> = {};
  for (const [key, raw] of params) {
    const value = trimsHashValue(page, key) ? raw.trim() : raw;
    if (!value || !keys[key](value)) return undefined;
    out[key] = value;
  }
  return Object.keys(out).length && (!out.messageId || out.conversationId) ? (out as NavOpts) : undefined;
}

/**
 * The route the location hash names: a retired standalone route (e.g. `#/roles`) is the
 * `settings` page (the RouterProvider rewrites the hash to `#/settings?s=<id>`), an
 * unknown or empty id is `overview`, and {@link redirectRoute} applies last.
 */
function routeFromLocation(): { page: PageId; opts?: NavOpts; redirected: boolean } {
  try {
    const hash = window.location.hash || '';
    const raw = rawPageOf(hash);
    if (isSettingsRedirect(raw)) return { page: 'settings', redirected: false };
    const page: PageId = isPageId(raw) ? raw : 'overview';
    return redirectRoute(page, parseOpts(page, hash));
  } catch {
    return { page: 'overview', redirected: false };
  }
}

/** Parse `#/<pageid>` from the location hash; unknown/empty → 'overview'; aliases redirect. */
export function pageFromHash(): PageId {
  return routeFromLocation().page;
}

/**
 * Parse whitelisted deep-link query opts from the location hash (e.g.
 * `#/cases?caseId=<id>`), so a FRESH tab / bookmark / refresh lands with the same opts an
 * in-app `navigate(page, opts)` would carry. This is what makes the CaseDetail "Open in
 * new tab" button work: the new tab boots straight into the case sheet. Returns
 * undefined when nothing valid is present.
 */
export function optsFromHash(): NavOpts | undefined {
  return routeFromLocation().opts;
}

/** Replace the hash without a history entry (and without a `hashchange`). */
function replaceHash(hash: string): void {
  try {
    window.history.replaceState(window.history.state, '', hash);
  } catch {
    /* a sandboxed frame may refuse; the in-memory route is already right */
  }
}

/** One-shot requests (a new chat, a question to ask or send): never re-applied by Back/Forward. */
const ONE_SHOT_KEYS = ['newChat', 'ask', 'topic', 'entity', 'resend'] as const;

/**
 * The opts after a hash change to `hash` that stays on `page`, decided key by key for the
 * keys the page owns in its hash ({@link hashKeys}):
 * - the hash still carries exactly what `current` writes ({@link pageHash}): keep it. It
 *   keeps values the strict parser in {@link optsFromHash} would refuse from a typed
 *   link, such as a tag with a `/`;
 * - the hash carries another valid value: take it (Forward to a report, row A to row B);
 * - the hash dropped the key, or carries a value that fails validation: remove it. Back
 *   from `#/reports?reportId=x` to `#/reports` shows the list again.
 * Keys the hash never carries (a severity drill-through, a Settings section) stay. Returns
 * `current` itself when nothing changed. The router calls this only for a change it did
 * not write itself (Back/Forward, a typed or pasted link; the echo of its own navigate
 * changes nothing): such a `traversal` also drops the one-shot requests
 * ({@link ONE_SHOT_KEYS}), so Forward never asks or sends a question again, and returns
 * a new object whenever the hash names a key the page owns, so a pasted link to the
 * conversation the opts still name (Chat cleared its link with `replaceState`) is applied.
 */
export function samePageOpts(
  page: PageId,
  current: NavOpts | undefined,
  hash: string,
  traversal = false,
): NavOpts | undefined {
  const qi = hash.indexOf('?');
  const query = qi < 0 ? '' : hash.slice(qi + 1);
  // A malformed escape makes the whole query unreadable: it says nothing about any key.
  if (!hasValidRouteEncoding(query)) return current;
  const incoming = new URLSearchParams(query);
  const written = new URLSearchParams(pageHash(page, current).split('?')[1] ?? '');
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, valid] of Object.entries(hashKeys(page))) {
    const all = incoming.getAll(key);
    const raw = all.length === 1 ? all[0] : undefined;
    if (raw !== undefined && raw === written.get(key)) continue;
    // Read exactly as optsFromHash reads it.
    const value = raw !== undefined && trimsHashValue(page, key) ? raw.trim() : raw;
    if (value && valid(value)) next[key] = value;
    else if (all.length || written.has(key)) delete next[key];
  }
  // A message anchor without its conversation is unreadable (optsFromHash refuses it).
  if (incoming.has('messageId') && !NAV_ID.test(String(next.conversationId ?? ''))) delete next.messageId;
  if (traversal) for (const key of ONE_SHOT_KEYS) delete next[key];
  const defined = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const keys = defined(next);
  const before = (current ?? {}) as Record<string, unknown>;
  const named = traversal && Object.keys(hashKeys(page)).some((key) => incoming.has(key));
  if (!named && keys.length === defined(before).length && keys.every((k) => next[k] === before[k])) return current;
  return keys.length ? (next as NavOpts) : undefined;
}

export const RouterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Seed the page and opts from the hash on first paint so a deep-link / new tab (e.g.
  // `#/cases?caseId=<id>`) lands with its opts, exactly like an in-app navigate would.
  const [boot] = React.useState(routeFromLocation);
  const [page, setPage] = React.useState<PageId>(boot.page);
  const [opts, setOpts] = React.useState<NavOpts | undefined>(boot.opts);

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
  /**
   * The hash this router last wrote, until its `hashchange` arrives: that event is the
   * echo of its own navigate and changes nothing. Every other change (Back/Forward, a
   * typed or pasted link, even one to the same hash) is a traversal ({@link samePageOpts}).
   */
  const echoRef = React.useRef<string | null>(null);

  const registerNavigationBlocker = React.useCallback<RegisterNavigationBlocker>((options) => {
    const token = Symbol('navigation-blocker');
    blockersRef.current.set(token, options);
    return () => blockersRef.current.delete(token);
  }, []);

  const resolveNavigation = React.useCallback((target: PageId, targetOpts?: NavOpts) => {
    const redirect = settingsRedirectHash(target);
    if (redirect) {
      return { page: 'settings' as PageId, opts: undefined, hash: redirect };
    }
    const { page: next, opts: nextOpts } = redirectRoute(target, targetOpts);
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
      if (window.location.hash !== target.hash) {
        window.location.hash = target.hash;
        // Read back: the browser may normalise what was written.
        echoRef.current = window.location.hash;
      }
    },
    [resolveNavigation],
  );

  const navigate = React.useCallback<Navigate>((next, nextOpts) => {
    const target = resolveNavigation(next, nextOpts);
    // A route leave is paused BEFORE state/hash mutation and resumed only after the
    // shared accessible ConfirmDialog resolves. Same-page transitions (notably Settings
    // section/anchor jumps) preserve the mounted draft, so they ask only when a guard
    // opted in with `sameRoute` and the URL actually changes (a board back to the
    // dashboards library).
    if (blockersRef.current.size > 0) {
      const leaving = target.page !== pageRef.current;
      const changing = target.hash !== window.location.hash;
      const blocker = Array.from(blockersRef.current.values())
        .filter((b) => leaving || (changing && b.sameRoute === true))
        .at(-1);
      if (blocker) {
        if (pendingRef.current) return;
        pendingRef.current = true;
        setPendingNavigation({ page: next, opts: nextOpts, blocker });
        return;
      }
    }
    commitNavigation(next, nextOpts);
  }, [commitNavigation, resolveNavigation]);

  React.useEffect(() => {
    const onHashChange = (event?: Event) => {
      // An event for a hash the location has already left (two navigations in one task,
      // or a change queued before a navigate) says nothing: the later one covers it.
      const url = (event as HashChangeEvent | undefined)?.newURL;
      const at = url ? url.indexOf('#') : -1;
      const fired = url ? (at < 0 ? '' : url.slice(at).replace(/^#$/, '')) : null;
      if (fired !== null && fired !== window.location.hash) return;
      // Normalise a retired standalone-route hash to its Settings section BEFORE
      // resolving the page (so `#/roles` → `#/settings?s=roles` before paint).
      const redirect = settingsRedirectHash(rawPageOf(window.location.hash || ''));
      if (redirect && window.location.hash !== redirect) {
        window.location.hash = redirect; // re-fires hashchange; the next pass settles
        return;
      }
      // An alias (`#/dashboard`, `#/scans`, ...) is replaced by its destination in place.
      const route = routeFromLocation();
      if (route.redirected) replaceHash(pageHash(route.page, route.opts));
      const next = route.page;
      const hash = window.location.hash || '';
      const own = hash === echoRef.current;
      echoRef.current = null;
      setPage((prev) => {
        if (prev === next) {
          // The echo of this router's own navigate changes nothing. Any other same-page
          // change (Case Manager row A → row B, Back from a report to the list, a pasted
          // link) changes only the query: the hash decides the durable options, durable
          // in-memory ones (a severity drill-through) stay, one-shot requests go.
          if (!own) setOpts((current) => samePageOpts(next, current, hash, true));
          return prev;
        }
        // Back/forward/direct navigation to a different page carries only durable
        // options represented in the hash; transient filter state is intentionally reset.
        setOpts(route.opts);
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
    const initialRaw = rawPageOf(window.location.hash || '');
    const initialRedirect = settingsRedirectHash(initialRaw);
    if (initialRedirect) {
      if (window.location.hash !== initialRedirect) window.location.hash = initialRedirect;
    } else if (boot.redirected) {
      // An alias in a bookmark or a typed link: its destination replaces it (one URL).
      replaceHash(pageHash(page, opts));
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
 * Browser Back and Forward change the hash directly and cannot be paused here. Pass
 * `sameRoute: true` when the unsaved state belongs to one URL of the page (a dashboard
 * board), so going back to the page's other URLs (the library) asks first too.
 */
export function useNavigationBlocker(
  enabled: boolean,
  options: NavigationBlockerOptions,
): void {
  const ctx = React.useContext(RouteContext);
  const { title, description, confirmLabel, cancelLabel, sameRoute } = options;
  React.useEffect(() => {
    if (!enabled || !ctx) return;
    return ctx.registerNavigationBlocker({
      title,
      description,
      confirmLabel,
      cancelLabel,
      sameRoute,
    });
  }, [
    enabled,
    ctx,
    title,
    description,
    confirmLabel,
    cancelLabel,
    sameRoute,
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
