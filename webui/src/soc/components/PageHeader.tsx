import * as React from 'react';
import { ArrowLeft, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { NavOpts } from '@/lib/types';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';

import { isPageId, type PageId } from '../nav';
import { redirectRoute, samePageOpts, useNavigateOptional } from '../router';
import { HelpTip } from './HelpTip';

/**
 * @deprecated Round 14 (C8): page headers carry no breadcrumb; the top bar owns the trail.
 * Kept so existing call sites compile while their pages migrate; nothing is rendered.
 */
export interface Crumb {
  label: string;
  href?: string;
}

/** The one sanctioned header extra: a link back to the list a page was opened from. */
export interface PageHeaderBack {
  /** The link text, for example "All dashboards" (plain text). */
  label: string;
  /**
   * An in-app hash route (`#/dashboards`, followed through the router so a route-leave
   * guard is asked first), a same-origin root-relative path, or an http(s) URL. Anything
   * else renders the label as plain text ({@link safeBackHref}).
   */
  href: string;
}

export interface PageHeaderProps {
  /** Main page title (plain text). The page's one `h1`. */
  title: string;
  /**
   * Help beside the title: the page's explanation, one or two plain sentences with no em
   * dash. Shown in a popover (reachable by touch and keyboard), never as a line under the
   * title (C8 option 1). Defaults to `description` on a routed page.
   */
  help?: string;
  /** Accessible name of the help trigger. Default `About <title>`. */
  helpLabel?: string;
  /**
   * The controls slot BESIDE the title: the time range, Live, Refresh. These scope the
   * numbers on the page, so they sit with its name.
   */
  controls?: React.ReactNode;
  /** @deprecated Alias of `controls` (the pre-Round 14 name). `controls` wins when both are set. */
  meta?: React.ReactNode;
  /** Right-aligned: the freshness stamp or the page's primary action. */
  actions?: React.ReactNode;
  /**
   * The one sanctioned C8 exception: a 13px link with a back arrow ABOVE the title, for a
   * page that is a child of a list it was opened from ("All dashboards"). A link, not a
   * breadcrumb.
   */
  back?: PageHeaderBack;
  /** Section tabs rendered on the header's bottom edge (no second band). */
  tabs?: React.ReactNode;
  /** Optional stick-to-top behavior (offset by `--header-h`). */
  sticky?: boolean;
  /**
   * Render as an active workspace section header instead of a page header. This keeps
   * standalone routes on one `<h1>` while allowing their reusable bodies to sit beneath
   * a host page's `<h1>` with a correctly-scaled `<h2>`. An embedded header still shows
   * its `description` as a line (it is not a routed page).
   */
  embedded?: boolean;
  /**
   * On a routed page: the explanation, rendered as the help tip text (see `help`). On an
   * `embedded` header: a muted line under the title.
   */
  description?: string;
  className?: string;
  /** @deprecated Content under a `variant="hero"` header; rendered below the title row. */
  children?: React.ReactNode;
  /** Stable test anchor forwarded to the header root (e.g. `page-hero`). */
  'data-testid'?: string;
  /**
   * @deprecated Round 14 (C8): every header is the Overview header. `hero` no longer draws
   * a border or a wash; it only keeps rendering `children` under the title row.
   */
  variant?: 'dense' | 'hero';
  /** @deprecated Round 14 (C8): no breadcrumb in a page header (the top bar owns it). Ignored. */
  breadcrumb?: Crumb[];
  /** @deprecated Round 14 (C8): no overline. Ignored. */
  eyebrow?: string;
  /** @deprecated Round 14 (C8): no icon chip beside the title. Ignored. */
  icon?: LucideIcon;
}

/**
 * The document scroller's `scroll-padding-top` while a sticky page band is pinned: the top
 * bar, the band's measured height and its 16px scroll-edge fade. Scroll padding is honoured
 * by every scroll-into-view (keyboard focus, in-page links, `scrollIntoView`, find-in-page),
 * so a focused control or a heading never ends up hidden under the band (WCAG 2.4.11).
 */
export function bandScrollPadding(height: number): string {
  return `calc(var(--header-h) + ${height}px + 1rem)`;
}

/**
 * Every pinned band and its height. The document root's scroll padding follows the tallest;
 * a route transition can briefly mount two pages, and the page leaving must not clear the
 * padding of the page arriving.
 */
const pinnedBands = new Map<HTMLElement, number>();

function applyBandScrollPadding() {
  const root = document.documentElement.style;
  if (pinnedBands.size === 0) {
    root.removeProperty('scroll-padding-top');
    return;
  }
  root.setProperty('scroll-padding-top', bandScrollPadding(Math.max(...pinnedBands.values())));
}

/**
 * Hold the document's scroll padding clear of a sticky band while it is mounted and pinned.
 * Measured, not assumed: the band wraps to two or three lines at tablet widths. Nothing is
 * held while the band is not actually pinned (a `max-sm:static` band scrolls away on a
 * phone and covers nothing). A resize can flip the band's position at a breakpoint without
 * changing its size, so the window's resize re-measures too. Never pair this with a
 * `scroll-margin-top` on the page's headings: margin and padding add up.
 */
function useBandScrollPadding(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  React.useEffect(() => {
    const band = ref.current;
    if (!enabled || !band) return undefined;
    const publish = () => {
      if (getComputedStyle(band).position === 'sticky') {
        pinnedBands.set(band, Math.ceil(band.getBoundingClientRect().height));
      } else {
        pinnedBands.delete(band);
      }
      applyBandScrollPadding();
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(band);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      pinnedBands.delete(band);
      applyBandScrollPadding();
    };
  }, [ref, enabled]);
}

/**
 * Only an in-app hash route, a same-origin root-relative path or an http(s) URL may become
 * the back link (#9, defense in depth): React does not sanitise `href`, so a `javascript:`
 * or `data:` value would run on click, and a value the browser reads as another origin
 * would leave the console. The check runs on what the browser will actually follow: the
 * URL parser drops ASCII tabs and newlines anywhere and controls and spaces at the ends,
 * and reads a backslash as a slash, so `/\evil.test`, `/<tab>/evil.test` and
 * `\\evil.test` are all protocol-relative and refused. Anything else renders the label as
 * plain text.
 */
export function safeBackHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  // eslint-disable-next-line no-control-regex -- exactly the characters the URL parser strips
  const value = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
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
 * The route an in-app back link names (`#/dashboards`, `#/settings?s=users`), read the way
 * the router reads a hash: the page id, its own query keys, and the page redirects.
 * `undefined` for anything else (an http(s) URL, a root-relative path, an unknown page),
 * which the browser follows natively.
 */
export function backRoute(href: string): { page: PageId; opts?: NavOpts } | undefined {
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
 * The page header, in the Overview's grammar on every page (Round 14, C8 option 1):
 *
 *   [back link, only for a page opened from a list]
 *   Title (?)  [controls: time range, Live, Refresh]          [actions: freshness or primary]
 *
 * The title is the page's `h1`: 24px, weight 650, tracking from its size step (-0.48px),
 * 30px from 1536px, 20px on a phone. No icon chip, no overline, no breadcrumb, no
 * description line: the explanation lives in the help tip beside the title. The title row
 * starts 8px below the content inset, so the title sits where the Overview's does and does
 * not jump between pages; `PageContainer` puts the first module 24px under it.
 *
 * All text renders as plain text (UNTRUSTED-safe, #9); never `dangerouslySetInnerHTML`.
 */
export function PageHeader({
  title,
  help,
  helpLabel,
  controls,
  meta,
  actions,
  back,
  tabs,
  sticky,
  embedded = false,
  description,
  className,
  children,
  'data-testid': dataTestId,
  variant = 'dense',
}: PageHeaderProps) {
  const Title = embedded ? 'h2' : 'h1';
  const controlsNode = controls ?? meta;
  // A routed page explains itself in the help tip; an embedded section keeps its line.
  const helpText = (help ?? (embedded ? undefined : description))?.trim() || undefined;
  const descriptionLine = embedded ? description?.trim() || undefined : undefined;
  const backHref = back ? safeBackHref(back.href) : undefined;
  // A plain click on an in-app back link goes through the router, like the navigation and
  // the top bar trail, so a page's route-leave guard (an unsaved draft) is asked first. A
  // modified click (new tab, new window) keeps the browser's own behaviour.
  const navigate = useNavigateOptional();
  const onBackClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!backHref) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const route = backRoute(backHref);
    if (!route) return;
    event.preventDefault();
    navigate(route.page, route.opts);
  };

  // Sticky = floating chrome: the ONE Console material, with the scroll-edge fade shown
  // only while content is scrolled under the pinned header (solid fallbacks in theme.css).
  // An embedded header's bottom hairline gives way to that fade when it pins.
  const bandRef = React.useRef<HTMLElement | null>(null);
  const edgeRef = useScrollEdgeRef<HTMLElement>(bandRef, Boolean(sticky));
  useBandScrollPadding(bandRef, Boolean(sticky));
  const stickyCls = sticky
    ? cn('sticky top-[var(--header-h)] z-20', materialBar, embedded && 'border-b-0')
    : undefined;

  return (
    <section
      ref={edgeRef}
      data-testid={dataTestId}
      data-page-header={embedded ? 'embedded' : 'page'}
      className={cn(
        'relative',
        embedded ? 'border-b border-border/80 pb-5' : 'pt-2',
        stickyCls,
        className,
      )}
    >
      {back ? (
        backHref ? (
          <a
            href={backHref}
            onClick={onBackClick}
            className={cn(
              'mb-1 inline-flex min-h-6 items-center gap-1 rounded-sm text-sm font-medium text-primary',
              'hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            )}
            data-page-header-back=""
          >
            <ArrowLeft className="size-[13px] shrink-0" aria-hidden />
            {back.label}
          </a>
        ) : (
          <span className="mb-1 inline-flex min-h-6 items-center text-sm text-muted-foreground" data-page-header-back="">
            {back.label}
          </span>
        )
      ) : null}

      {/* Top-aligned, with a 32px title row: the title sits at the same height on every
          page (measured 89px at 1440, 88px at 1920) whatever the actions on the right
          hold. Centring the row on a tall actions block pushed the title down 30px on
          Standup. 32px controls (the Overview's) centre on the title; short actions centre
          in the same 32px. */}
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-page-header-title-row="">
            <div className="flex min-w-0 items-center gap-1.5">
              <Title
                className={cn(
                  // The size steps carry the tracking (Inter's curve) and, from 24px up,
                  // the 650 weight: never `tracking-tight` on top (Round 14, C8).
                  'min-w-0 break-words font-semibold text-foreground',
                  embedded ? 'text-xl' : 'text-2xl sm:text-3xl 2xl:text-4xl',
                )}
              >
                {title}
              </Title>
              {helpText ? (
                <HelpTip
                  text={helpText}
                  label={helpLabel ?? `About ${title}`}
                  // Relocated explanation: it must open on touch and keyboard, so always
                  // the popover, never a hover-only tooltip.
                  alwaysPopover
                />
              ) : null}
            </div>
            {controlsNode ? (
              <div className="flex flex-wrap items-center gap-2" data-page-header-controls="">
                {controlsNode}
              </div>
            ) : null}
          </div>
          {descriptionLine ? (
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{descriptionLine}</p>
          ) : null}
        </div>
        {actions ? (
          <div
            className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:min-h-8 sm:w-auto sm:shrink-0 sm:justify-end"
            data-page-header-actions=""
          >
            {actions}
          </div>
        ) : null}
      </div>

      {tabs ? <div className="relative">{tabs}</div> : null}
      {variant === 'hero' && children ? <div className="relative mt-6">{children}</div> : null}
    </section>
  );
}

export default PageHeader;
