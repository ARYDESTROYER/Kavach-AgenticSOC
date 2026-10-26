/**
 * The collapsed rail's interaction layer (Round 14, SPEC §4.8.1 and §3.4): the group
 * flyouts with their hover intent (`nav-hover-intent.ts`), the one rail tooltip
 * (`nav-rail-tip.tsx`) and the pointer, focus and key handlers that drive them.
 *
 * First paint never needs any of it: until the pointer or focus first reaches the
 * navigation, nothing can rest on an icon and nothing is open. So this module is a lazy
 * chunk that `nav-rail-loader.ts` imports on that first interaction and NavSidebar
 * renders through; the rows, the toggle and the stable morph stay in the entry. The
 * behaviour is the one `NavSidebar.tsx` documents; this file only holds its parts.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { ActivityGlyph } from '../chat-activity/glyph';
import { navDest, type PageId } from '../nav';
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
import { activityText, describedBy, followLink, hrefOf, type Destination, type NavActivity } from './nav-shared';

export { railTipHandlers, registerTrigger };

/** The handlers one rail control spreads onto its element. */
export type RailHandlers = Partial<
  Pick<React.DOMAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerLeave' | 'onFocus' | 'onBlur' | 'onKeyDown'>
>;

/**
 * A primary-button press on `el` landed before this layer did (`nav-rail-loader.ts`): on
 * a grouped icon it keeps the flyout away until the pointer leaves, as {@link rowHandlers}
 * does for a press it sees itself.
 */
export function pressedBeforeLoad(el: HTMLElement): void {
  const id = el.closest('[data-nav-item]')?.getAttribute('data-nav-item');
  if (id && el.getAttribute('aria-haspopup') === 'true') suppressAfterPress(id);
}

/** Close the open flyout and hide the tooltip, cancelling their pending rest timers. */
export function closeSurfaces(): void {
  closeFlyout();
  hideRailTip();
}

/**
 * The handlers of one destination row. In the 64 px rail a plain icon gets the rail
 * tooltip and a grouped icon (`trigger`) drives its flyout; in the labelled drawer
 * (`collapsed` false) a row needs neither and gets no handlers.
 */
export function rowHandlers(id: string, label: string, detail: string, collapsed: boolean, trigger: boolean): RailHandlers {
  if (!trigger) return railTipHandlers(id, label, detail, collapsed);
  return {
    onPointerDown: (event) => {
      if (event.button === 0) suppressAfterPress(id);
    },
    onPointerMove: (event) => pointerOverTrigger(id, { x: event.clientX, y: event.clientY }),
    onPointerLeave: (event) => pointerLeftTrigger(id, { x: event.clientX, y: event.clientY }),
    onFocus: (event) => {
      // Keyboard focus opens at once; a pointer focus never does.
      if (event.currentTarget.matches(':focus-visible')) keyboardOpen(id);
    },
    onBlur: (event) => {
      if ((event.relatedTarget as HTMLElement | null)?.closest('[data-nav-flyout]')) return;
      endFocusSuppression(id);
      if (navStore.getState().flyout === id) closeFlyout();
    },
    onKeyDown: (event) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (navStore.getState().flyout !== id) openFlyout(id);
        window.requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('[data-nav-flyout] [data-nav-fly-item]')?.focus(),
        );
      } else if (event.key === ' ') {
        // A grouped icon does what a click does on Space too (it opens its page).
        event.preventDefault();
        event.currentTarget.click();
      } else if (event.key === 'Escape' && navStore.getState().flyout === id) {
        // Dismissed: it stays closed while focus stays on the icon.
        event.preventDefault();
        closeFlyout();
        suppressFocusReopen(id);
      }
    },
  };
}

interface RailLayersProps {
  destinations: Destination[];
  page: PageId;
  activity: NavActivity;
  reducedMotion: boolean;
  go: (page: PageId) => void;
}

/** The collapsed rail's floating surfaces: the one group flyout and the one tooltip. */
export function RailLayers(props: RailLayersProps) {
  return (
    <>
      <RailFlyout {...props} />
      <RailTipLayer />
    </>
  );
}

/** The collapsed rail's one flyout, outside the clipping layer so nothing clips it. */
function RailFlyout({ destinations, page, activity, reducedMotion, go }: RailLayersProps) {
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
