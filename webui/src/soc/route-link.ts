/**
 * Links that navigate inside the Console (Round 14, SPEC §3.3: "a control that navigates
 * is an `<a href>`, never a `button` that changes the hash").
 *
 * Two jobs every in-app link shares:
 *
 *  1. **Only a safe target becomes a link** ({@link safeRouteHref}, #9 defense in depth).
 *     React does not sanitise `href`, so a `javascript:` or `data:` value would run on
 *     click, and a value the browser reads as another origin would leave the Console. A
 *     caller-supplied or record-derived href goes through this check; anything it refuses
 *     renders as plain text (or a disabled control) instead of a link.
 *  2. **A plain click goes through the router** ({@link useRouteLinkClick}), so a page's
 *     route-leave guard (`useNavigationBlocker`: an unsaved Settings draft, a dashboard
 *     being edited) is asked first. The router's `hashchange` handler cannot pause a
 *     navigation, so a bare `<a href="#/sources">` would skip the "Discard unsaved
 *     changes?" confirmation and drop the draft. A modified click (new tab, new window)
 *     and a middle click keep the browser's own behaviour.
 *
 * Entry-safe: no module-level work, and it imports only the router and the page ids,
 * which the entry already holds (SPEC §3.4).
 */
import type * as React from 'react';

import type { NavOpts } from '@/lib/types';

import { isPageId, type PageId } from './nav';
import { redirectRoute, samePageOpts, useNavigateOptional } from './router';

/**
 * The href a link may carry: an in-app hash route, a same-origin root-relative path or an
 * http(s) URL. `undefined` for anything else (`javascript:`, `data:`, a protocol-relative
 * `//host`, a path the browser reads as another host).
 *
 * The check runs on what the browser will actually follow: the URL parser drops ASCII
 * tabs and newlines anywhere and controls and spaces at the ends, and reads a backslash
 * as a slash, so `/\evil.test`, `/<tab>/evil.test` and `\\evil.test` are all
 * protocol-relative and refused.
 */
export function safeRouteHref(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  // eslint-disable-next-line no-control-regex -- exactly the characters the URL parser strips
  const value = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  if (!value) return undefined;
  if (value.startsWith('#')) return value;
  // Two leading slashes in any mix of `/` and `\` start another host.
  if (/^[\\/]{2}/.test(value)) return undefined;
  const rootRelative = value.startsWith('/');
  if (!rootRelative && !/^https?:\/\//i.test(value)) return undefined;
  if (typeof window === 'undefined') return undefined;
  let url: URL;
  try {
    url = new URL(value, window.location.href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (rootRelative && url.origin !== window.location.origin) return undefined;
  return value;
}

/**
 * The route an in-app link names (`#/sources`, `#/settings?s=users`), read the way the
 * router reads a hash: the page id, its own query keys and the page redirects.
 * `undefined` for anything else (an http(s) URL, a root-relative path, an unknown page),
 * which the browser follows natively.
 */
export function hashRoute(href: string): { page: PageId; opts?: NavOpts } | undefined {
  if (!href.startsWith('#/')) return undefined;
  const raw = href.slice(2).split(/[?&/]/)[0];
  if (!isPageId(raw)) return undefined;
  if (raw === 'settings') {
    const query = new URLSearchParams(href.split('?')[1] ?? '');
    const section = query.get('s') ?? undefined;
    const anchor = query.get('a') ?? undefined;
    return { page: 'settings', opts: section ? { section, ...(anchor ? { anchor } : {}) } : undefined };
  }
  const route = redirectRoute(raw, samePageOpts(raw, undefined, href));
  return { page: route.page, opts: route.opts };
}

/**
 * The click handler for an in-app link. A plain primary click on a link to a Console
 * route is taken over: the browser's default hash change is prevented and the router
 * navigates, asking any route-leave guard first. A click the caller already handled, a
 * modified click (Ctrl, Cmd, Shift, Alt), a non-primary button, or a link that is not a
 * Console route keeps the browser's behaviour. Pass the href the link renders (after
 * {@link safeRouteHref}); `undefined` gives a no-op handler.
 */
export function useRouteLinkClick(
  href: string | undefined,
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void,
): (event: React.MouseEvent<HTMLAnchorElement>) => void {
  const navigate = useNavigateOptional();
  return (event) => {
    onClick?.(event);
    if (!href) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const route = hashRoute(href);
    if (!route) return;
    event.preventDefault();
    navigate(route.page, route.opts);
  };
}
