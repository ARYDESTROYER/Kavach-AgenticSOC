/**
 * Measure a chart's WIDTH with a ResizeObserver (heights are fixed per chart kind, so a
 * streamed or restored transcript never jumps). jsdom has no layout engine and reports
 * 0; the fallback width is then used SILENTLY so tests get real geometry and
 * `npm run test:strict` stays clean. In static/print mode the width is fixed at the A4
 * content measure (680 px) and nothing is observed.
 */
import * as React from 'react';

export const STATIC_WIDTH = 680;
export const FALLBACK_WIDTH = 560;

export interface ChartSizeOptions {
  fallbackWidth?: number;
  /** Print/static rendering: a deterministic width, no observer. */
  staticMode?: boolean;
}

export function useChartSize<T extends HTMLElement>(
  ref: React.RefObject<T>,
  { fallbackWidth = FALLBACK_WIDTH, staticMode = false }: ChartSizeOptions = {},
): number {
  const [width, setWidth] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    if (staticMode) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth((cur) => (cur === w ? cur : w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, staticMode]);

  if (staticMode) return STATIC_WIDTH;
  return width ?? fallbackWidth;
}
