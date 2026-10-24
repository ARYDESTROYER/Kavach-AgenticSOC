/**
 * A wide table's horizontal scroll edges (Round 13 polish, third re-shoot PW4-2).
 *
 * A block table wider than its frame scrolls inside it (`ui/table`'s `overflow-auto`
 * box), but with overlay scrollbars (a phone, a touch screen, macOS) nothing showed that
 * it did: at 390 px the Status column simply ended at the frame's edge and read as cut
 * off. The scroll box now fades out on each side that holds more columns, the same
 * treatment as the start screen's scrolling pill row (`CategoryPills`, a 1.5rem mask):
 * `data-x-scroll` on the box says which side ("start", "end" or "both"), and the
 * table's root class turns that into the mask. A table that fits has no attribute and
 * no mask. The attribute is set on the element directly (no React state), so scrolling
 * never re-renders the table.
 */
import * as React from 'react';

export type ScrollEdges = 'start' | 'end' | 'both' | null;

/** Which sides of a horizontal scroll box hold more content (1 px of slack for sub-pixel widths). */
export function scrollEdges(box: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): ScrollEdges {
  const more = box.scrollWidth - box.clientWidth;
  if (!(more > 1)) return null;
  const before = box.scrollLeft > 1;
  const after = box.scrollLeft < more - 1;
  return before && after ? 'both' : before ? 'start' : after ? 'end' : null;
}

/**
 * The fade on each side with more: a literal per state, so Tailwind's compiler sees them.
 * The box also keeps a sideways scroll from turning into the browser's back gesture.
 */
export const TABLE_SCROLL_FADE = [
  '[&_[data-x-scroll]]:overscroll-x-contain',
  '[&_[data-x-scroll=end]]:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]',
  '[&_[data-x-scroll=start]]:[mask-image:linear-gradient(to_left,black_calc(100%-1.5rem),transparent)]',
  '[&_[data-x-scroll=both]]:[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]',
].join(' ');

/**
 * Keep `data-x-scroll` on the table's scroll box (the `<table>`'s parent under `root`)
 * in step with its scroll position and size. A change of `watch` (the block) finds the
 * box again: a render with no visible column has no table.
 */
export function useTableScrollEdges(root: React.RefObject<HTMLElement>, enabled: boolean, watch?: unknown): void {
  React.useLayoutEffect(() => {
    if (!enabled) return undefined;
    const box = root.current?.querySelector('table')?.parentElement ?? null;
    if (!box) return undefined;
    const update = () => {
      const edges = scrollEdges(box);
      if (edges) box.setAttribute('data-x-scroll', edges);
      else box.removeAttribute('data-x-scroll');
    };
    update();
    box.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(box);
    const table = box.querySelector('table');
    if (table) observer?.observe(table);
    return () => {
      box.removeEventListener('scroll', update);
      observer?.disconnect();
      box.removeAttribute('data-x-scroll');
    };
  }, [root, enabled, watch]);
}
