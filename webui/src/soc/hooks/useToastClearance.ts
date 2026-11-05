/**
 * Toast clearance: bottom toasts stack above a sticky action bar instead of covering it
 * (Round 14, SPEC §4.4.6: the Duplicate toast confirms the copy without blocking the
 * editor).
 *
 * The Console's toasts stack up from the bottom edge of the viewport (sonner, bottom
 * right; full width on a phone). Every Save and Discard bar (`StickySaveBar`: Settings,
 * Baseline, Campaigns, Tuning and the dashboard editor) pins itself to that same edge, so
 * a toast covered its buttons: the confirmation that opens a copied dashboard in Edit
 * mode ("Copy created. Your changes are saved to the copy only.") the moment the person
 * arrived, and a failed Save's error ("Could not save settings.") the Save button they
 * would press again.
 *
 * `StickySaveBar` registers itself here while it shows. While a registered bar sits where
 * the toasts are, the document root carries `--soc-toast-clearance`: the distance from
 * the bar's top edge to the bottom of the viewport. `theme.css` lifts the toaster by it (a
 * transform, so the toasts glide rather than jump while a loading board pushes the bar
 * down; desktop and phone), so the toasts stack just above the bar. A bar higher
 * up the page (a short page) is already clear and adds nothing. The distance follows the
 * bar as the page scrolls, the window resizes and the content above it grows; with
 * several bars the largest wins, and the variable is removed when the last one goes.
 *
 * Presentation only: nothing here reads or writes data.
 */
import * as React from 'react';

/** The custom property the toaster's bottom offset reads (`theme.css`). */
export const TOAST_CLEARANCE_VAR = '--soc-toast-clearance';

/**
 * How far up from the viewport's bottom edge the toasts reach: the 32 px offset, one toast
 * with a description and the peek of the stack behind it. A bar wholly above this band
 * cannot be covered.
 */
export const TOAST_ZONE_PX = 160;

/**
 * The clearance a bar at `rect` needs in a viewport `viewportHeight` px tall: the distance
 * from its top edge to the viewport's bottom while any of it is in the toasts' band, else
 * 0 (off screen below, above the band, or not laid out). Pure.
 */
export function toastClearance(
  rect: { top: number; bottom: number; height: number },
  viewportHeight: number,
): number {
  if (!(rect.height > 0) || !(viewportHeight > 0)) return 0;
  if (rect.top >= viewportHeight || rect.bottom <= viewportHeight - TOAST_ZONE_PX) return 0;
  return Math.ceil(viewportHeight - Math.max(0, rect.top));
}

/** Each registered bar's current clearance; the root carries the largest. */
const clearances = new Map<symbol, number>();

/**
 * How much of the viewport's bottom edge a registered bar covers right now, in px (the
 * value `--soc-toast-clearance` carries; 0 when no bar sits there). A control moved into
 * view is kept above it (WCAG 2.4.11, Focus Not Obscured).
 */
export function bottomBarClearance(): number {
  let largest = 0;
  for (const value of clearances.values()) largest = Math.max(largest, value);
  return largest;
}

function publish(): void {
  if (typeof document === 'undefined') return;
  const largest = bottomBarClearance();
  const root = document.documentElement;
  if (largest > 0) root.style.setProperty(TOAST_CLEARANCE_VAR, `${largest}px`);
  else root.style.removeProperty(TOAST_CLEARANCE_VAR);
}

/**
 * Keep the bottom toasts clear of `ref`'s bar while `active`. Re-measured on scroll (any
 * scroller: scroll events do not bubble, so the listener captures), on a window resize,
 * and when the bar or the content around it changes size (a board's widgets loading
 * push a short page's bar down to the viewport's edge).
 */
export function useToastClearance(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
  React.useLayoutEffect(() => {
    const bar = ref.current;
    if (!active || !bar || typeof window === 'undefined') return undefined;
    const key = Symbol('toast-clearance');
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = toastClearance(bar.getBoundingClientRect(), window.innerHeight);
      if (clearances.get(key) === next) return;
      clearances.set(key, next);
      publish();
    };
    const schedule = () => {
      if (frame) return;
      if (typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(update);
      else update();
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(bar);
    if (bar.parentElement) observer?.observe(bar.parentElement);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    return () => {
      if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      clearances.delete(key);
      publish();
    };
  }, [ref, active]);
}
