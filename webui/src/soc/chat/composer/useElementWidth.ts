/**
 * useElementWidth — the measured inline size of an element (SPEC §10.1: chat zones
 * respond to the measured container, not viewport breakpoints). Returns `null` until
 * a ResizeObserver reports, so callers render their roomy layout by default.
 */
import * as React from 'react';

export function useElementWidth<T extends HTMLElement>(ref: React.RefObject<T>): number | null {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
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
  }, [ref]);
  return width;
}
