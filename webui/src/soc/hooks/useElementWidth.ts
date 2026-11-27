/**
 * useElementWidth: the measured inline size of an element (SPEC §10.1: chat zones
 * respond to the measured container, not viewport breakpoints; the Audit list picks its
 * columns the same way). Returns `null` until a ResizeObserver reports, so callers render
 * their default layout first.
 *
 * Takes a ref, or the element itself (a state-held callback ref) for an element that mounts
 * after the first render: a ref's later `current` is never seen, an element in state is.
 */
import * as React from 'react';

export function useElementWidth<T extends HTMLElement>(target: React.RefObject<T> | T | null): number | null {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = target && 'current' in target ? target.current : target;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const size = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect?.width;
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
        setWidth((prev) => (prev === Math.round(size) ? prev : Math.round(size)));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [target]);
  return width;
}
