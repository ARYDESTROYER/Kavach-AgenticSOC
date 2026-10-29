/**
 * useOverflowRight: whether a horizontally scrolling region has more content to its
 * right, for the right-edge fade every wide table draws (Round 14, SPEC §4.9.2).
 *
 * Re-measured on scroll, on a resize of the region or its first child, and whenever `deps`
 * change (rows or columns). Keyed on the element itself (held in state through a callback
 * ref), so the listeners follow the region when it remounts, for example when a table
 * comes back from its empty state.
 *
 * Its own small module so a table that is not a `DataTable` (the Logs sheet) shares the
 * measurement without importing `DataTable` and its module graph into its route chunk.
 */
import * as React from 'react';

export function useOverflowRight(el: HTMLElement | null, deps: readonly unknown[]): boolean {
  const [more, setMore] = React.useState(false);
  const measure = React.useCallback(() => {
    setMore(el ? el.scrollWidth - el.clientWidth - el.scrollLeft > 1 : false);
  }, [el]);
  React.useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's re-measure list
  }, [measure, ...deps]);
  React.useEffect(() => {
    if (!el) return undefined;
    el.addEventListener('scroll', measure, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure());
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [el, measure]);
  return more;
}
