/**
 * Series legend (BLOCKS.md "Legend"): shown only for ≥ 2 series. Each item is a toggle
 * button (`aria-pressed` = the series is shown) with a hit target of at least 24×24
 * (WCAG 2.5.8). At least one series always stays visible — the last visible toggle
 * refuses to hide and says so. Swatches mirror the mark (a rect for bars, a line for
 * lines) and carry the semantic glyph when the series is semantic (WCAG 1.4.1). Labels
 * are plain text; untrusted ones render mono (G7). Colours stay bound to the series.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { useAnnouncer } from '@/soc/components/announcer';

import type { SeriesStyle } from './series';

export interface LegendProps {
  items: SeriesStyle[];
  /** `hidden[k]` → series k is hidden. Omit for a static (non-toggle) legend. */
  hidden?: ReadonlyArray<boolean>;
  onToggle?: (index: number) => void;
  shape: 'rect' | 'line';
  untrusted?: boolean;
  /** Optional value + share text per item (donut legends are the direct label). */
  values?: ReadonlyArray<string>;
  className?: string;
  ariaLabel?: string;
}

function Swatch({ color, shape }: { color: string; shape: 'rect' | 'line' }) {
  return shape === 'line' ? (
    <span className="h-0.5 w-3 shrink-0 rounded-full forced-colors:border" style={{ backgroundColor: color }} aria-hidden />
  ) : (
    <span className="size-2.5 shrink-0 rounded-[2px] forced-colors:border" style={{ backgroundColor: color }} aria-hidden />
  );
}

export function Legend({ items, hidden, onToggle, shape, untrusted, values, className, ariaLabel = 'Series' }: LegendProps) {
  const announce = useAnnouncer();
  const toggleable = Boolean(onToggle && hidden);
  const visibleCount = hidden ? hidden.filter((h) => !h).length : items.length;

  const toggle = (index: number) => {
    if (!onToggle || !hidden) return;
    const willHide = !hidden[index];
    if (willHide && visibleCount <= 1) {
      announce('At least one series must stay visible');
      return;
    }
    onToggle(index);
    const nextVisible = visibleCount + (willHide ? -1 : 1);
    announce(`Showing ${nextVisible} of ${items.length} series`);
  };

  return (
    <ul aria-label={ariaLabel} className={cn('flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs', className)}>
      {items.map((it, i) => {
        const Icon = it.icon;
        const shown = hidden ? !hidden[i] : true;
        const body = (
          <>
            <Swatch color={it.color} shape={shape} />
            {Icon ? <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
            <span className={cn('min-w-0 truncate', untrusted && 'font-mono')} title={it.label}>
              {it.label}
            </span>
            {values?.[i] ? <span className="shrink-0 tabular-nums text-muted-foreground">{values[i]}</span> : null}
          </>
        );
        return (
          <li key={it.key} className="min-w-0 max-w-full">
            {toggleable ? (
              <button
                type="button"
                aria-pressed={shown}
                onClick={() => toggle(i)}
                className={cn(
                  'inline-flex min-h-6 min-w-6 max-w-full items-center gap-1.5 rounded-sm px-1.5 py-0.5',
                  'text-foreground hover:bg-muted',
                  !shown && 'text-muted-foreground line-through decoration-muted-foreground/60',
                  focusRing,
                )}
              >
                {body}
              </button>
            ) : (
              <span className="inline-flex min-h-6 max-w-full items-center gap-1.5 px-1.5 py-0.5 text-foreground">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Legend visibility state with the "at least one visible" invariant. */
export function useSeriesVisibility(count: number): [boolean[], (index: number) => void] {
  const [hidden, setHidden] = React.useState<boolean[]>(() => Array.from({ length: count }, () => false));
  React.useEffect(() => {
    setHidden((cur) => (cur.length === count ? cur : Array.from({ length: count }, () => false)));
  }, [count]);
  const toggle = React.useCallback((index: number) => {
    setHidden((cur) => {
      const next = cur.slice();
      next[index] = !next[index];
      if (next.every(Boolean)) return cur;
      return next;
    });
  }, []);
  return [hidden.length === count ? hidden : Array.from({ length: count }, () => false), toggle];
}
