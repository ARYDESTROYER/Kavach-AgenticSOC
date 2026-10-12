import * as React from 'react';
import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';
import { ChevronRight, type LucideIcon } from 'lucide-react';

/** A single breadcrumb crumb (plain text; `href` optional for deep-linking). */
export interface Crumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  /**
   * `'dense'` (default) — a compact ~52-68px header band (breadcrumb over a
   * `text-2xl/3xl` title that outranks card titles, small icon chip, actions right,
   * a 2-line-clamped description).
   * `'hero'` — the SAME compact rhythm plus a rounded `border` + a whisper
   * `bg-hero-glow` accent wash (same `text-2xl/3xl` title, a 1-line-clamped
   * description). The
   * `actions` (right) + `meta` (beside title) are the ONLY control slots — no second
   * band. NOT the old ~176px marketing hero.
   */
  variant?: 'dense' | 'hero';
  /** Breadcrumb trail above the title (plain text). Preferred over `eyebrow`. */
  breadcrumb?: Crumb[];
  /**
   * @deprecated Small uppercase label above the title. Kept for the transition
   * wave; the Codemod migrates call sites to `breadcrumb`. Plain text (#9).
   */
  eyebrow?: string;
  /** Main page title (plain text). */
  title: string;
  /** Optional supporting description (plain text). */
  description?: string;
  /** Optional leading icon component from lucide-react. */
  icon?: LucideIcon;
  /** Status/severity badges (or a folded KPI summary) beside the title. Denser than prose. */
  meta?: React.ReactNode;
  /** Section tabs rendered on the header's bottom edge (no second band). */
  tabs?: React.ReactNode;
  /** Optional right-aligned actions (buttons, toggles, etc.). */
  actions?: React.ReactNode;
  /** Optional stick-to-top behavior (offset by `--header-h`). */
  sticky?: boolean;
  /**
   * Render as an active workspace section header instead of a page header. This keeps
   * standalone routes on one `<h1>` while allowing their reusable bodies to sit beneath
   * a host page's `<h1>` with a correctly-scaled `<h2>`.
   */
  embedded?: boolean;
  className?: string;
  /**
   * Extra content rendered below the header (hero variant). Kept for the
   * `HeroPanel` transition wrapper.
   */
  children?: React.ReactNode;
  /** Stable test anchor forwarded to the header root (e.g. `page-hero`). */
  'data-testid'?: string;
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
 * Only http(s), root-relative, or in-page fragment hrefs may become links (#9,
 * defense-in-depth). A `javascript:`/`data:` crumb href — React does NOT sanitize
 * href — would execute on click, so any other scheme is dropped to a plain `<span>`.
 * Mirrors `ThreatContextPanel.mitreUrl()`'s `^https?://` guard. Returns `undefined`
 * for an unsafe/absent href so the caller renders a non-interactive crumb.
 */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (/^\s*javascript:/i.test(href) || /^\s*data:/i.test(href)) return undefined;
  return /^(https?:|\/|#)/i.test(href.trim()) ? href : undefined;
}

/** Breadcrumb trail — plain text crumbs joined by chevrons (UNTRUSTED-safe, #9). */
function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
    >
      {crumbs.map((c, i) => {
        const href = safeHref(c.href);
        return (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 ? <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden /> : null}
            {href ? (
              <a href={href} className="truncate hover:text-foreground">
                {c.label}
              </a>
            ) : (
              <span className="truncate">{c.label}</span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Standard page header. `variant='dense'` (default) is a single compact band —
 * breadcrumb/eyebrow over the title, a small icon chip, meta beside the title, and
 * a right-aligned actions slot, with optional section `tabs` on the bottom edge.
 * `variant='hero'` is the SAME compact band plus a rounded border + a whisper
 * `bg-hero-glow` wash. Both variants share a `text-2xl sm:text-3xl` title that
 * outranks card titles (the single app-wide authority lever).
 *
 * All text renders as plain (UNTRUSTED-safe, #9); never `dangerouslySetInnerHTML`.
 */
export function PageHeader({
  variant = 'dense',
  breadcrumb,
  eyebrow,
  title,
  description,
  icon: Icon,
  meta,
  tabs,
  actions,
  sticky,
  embedded = false,
  className,
  children,
  'data-testid': dataTestId,
}: PageHeaderProps) {
  const hero = variant === 'hero';
  const Title = embedded ? 'h2' : 'h1';
  const crumbs = breadcrumb && breadcrumb.length > 0 ? breadcrumb : null;

  const overline = crumbs ? (
    <Breadcrumbs crumbs={crumbs} />
  ) : eyebrow ? (
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {eyebrow}
    </div>
  ) : null;

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
      className={cn(
        'relative',
        hero && 'overflow-hidden rounded-lg border border-border bg-card',
        embedded && 'border-b border-border/80 pb-5',
        stickyCls,
        className,
      )}
    >
      {/* Whisper-soft wash — decorative only (hero variant). */}
      {hero ? (
        <div className="pointer-events-none absolute inset-0 bg-hero-glow" aria-hidden />
      ) : null}

      <div
        className={cn(
          'relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
          hero && 'gap-3 px-5 py-3.5 sm:gap-4',
        )}
      >
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <span
              className={cn(
                'mt-0.5 inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary',
                hero ? 'h-8 w-8' : 'h-7 w-7',
              )}
            >
              <Icon className={hero ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0">
            {overline}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <Title
                className={cn(
                  'min-w-0 break-words font-semibold tracking-tight text-foreground',
                  embedded ? 'text-xl' : 'text-2xl sm:text-3xl',
                )}
              >
                {title}
              </Title>
              {meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
            </div>
            {description ? (
              <p
                className={cn(
                  'mt-1 max-w-2xl leading-relaxed text-muted-foreground',
                  hero ? 'line-clamp-1 text-sm' : 'line-clamp-2 text-xs sm:text-sm',
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
            {actions}
          </div>
        ) : null}
      </div>

      {tabs ? <div className={cn('relative', hero && 'px-5')}>{tabs}</div> : null}
      {hero && children ? <div className="relative px-5 pb-4">{children}</div> : null}
    </section>
  );
}

export default PageHeader;
