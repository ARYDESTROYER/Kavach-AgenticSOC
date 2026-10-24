/**
 * useMoreBelow — whether a scroll box has more content below its visible bottom edge
 * (Round 13, SPEC-chat T23): a list shows a bottom fade mask only while it can scroll
 * further, so a cut-off row reads as "more below" and a list that fits never fades.
 *
 * Re-measured on scroll, on resize (ResizeObserver when present) and after every
 * render (the content may change without a resize). Returns the ref callback to put
 * on the scroll box and the flag.
 */
import * as React from 'react';

/** The bottom fade (the last 1.5rem of the box), applied while {@link useMoreBelow} is true. */
export const BOTTOM_FADE = '[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]';

export function useMoreBelow<T extends HTMLElement>(): { ref: React.RefCallback<T>; moreBelow: boolean } {
  const [node, setNode] = React.useState<T | null>(null);
  const [moreBelow, setMoreBelow] = React.useState(false);
  const ref = React.useCallback<React.RefCallback<T>>((el) => setNode(el), []);

  const measure = React.useCallback(() => {
    if (!node) return;
    const next = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setMoreBelow((prev) => (prev === next ? prev : next));
  }, [node]);

  React.useLayoutEffect(() => {
    measure();
  });

  React.useEffect(() => {
    if (!node) return undefined;
    node.addEventListener('scroll', measure, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => measure());
      observer.observe(node);
    }
    return () => {
      node.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [node, measure]);

  return { ref, moreBelow };
}

/** The fade's height in px (the `1.5rem` of {@link BOTTOM_FADE}). */
export const BOTTOM_FADE_PX = 24;

/**
 * Scroll `list` (only the list, never the page) so `row` sits inside its visible box and
 * clear of the bottom fade while the list can scroll further. Measured from the two
 * boxes, so it works while a popover is still being positioned.
 */
export function revealInList(list: HTMLElement, row: HTMLElement): void {
  const box = list.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
  const bottom = box.bottom - (atEnd ? 0 : BOTTOM_FADE_PX);
  if (rect.top < box.top) list.scrollTop -= box.top - rect.top;
  else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
}
