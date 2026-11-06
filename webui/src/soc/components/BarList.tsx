import * as React from 'react';
import { cn } from '@/lib/cn';

export interface BarListItem {
  /** Row label — UNTRUSTED, rendered as plain text. */
  label: string;
  /** Numeric value driving the bar width + displayed figure. */
  value: number;
  /**
   * Optional explicit bar color token class (e.g. 'bg-critical', 'bg-high').
   * When omitted, the shared `bg-accent-bar` gradient is used.
   */
  color?: string;
  /** Optional secondary line under the bar (plain text). */
  sub?: string;
}

export interface BarListProps {
  items: BarListItem[];
  /** Optional value formatter (defaults to locale integer). */
  format?: (value: number) => string;
  /** Show each row's percentage as a trailing figure (see `percentOf`). */
  showPercent?: boolean;
  /**
   * What the trailing percentage is a share of: `max` (default) is relative to the
   * largest row, `total` is the row's share of the sum of every row, which is what a
   * reader expects a percentage beside a count to mean. Bar lengths are relative to the
   * largest row either way. A share that rounds to nothing reads "<1%", never 0%.
   */
  percentOf?: 'max' | 'total';
  /** Show a 1-based rank index gutter on each row. */
  showRank?: boolean;
  /** Empty-state message when items is empty. */
  emptyLabel?: string;
  className?: string;
}

function defaultFormat(v: number): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  try {
    return v.toLocaleString();
  } catch {
    return String(v);
  }
}

/** A row's trailing percentage: whole numbers, "<1%" for a share that rounds to nothing. */
function percentText(share: number): string {
  if (share > 0 && share < 0.5) return '<1%';
  return `${Math.round(share)}%`;
}

/**
 * Ranked horizontal bar list — the dashboard "Product Category Signals" /
 * "Severity Pressure" look. Bars use the `bg-accent-bar` gradient by default or a
 * per-item token color. Labels are UNTRUSTED → rendered as plain text. Token-themed.
 * Figures are Inter with tabular numerals (Round 14, SPEC §3.1); the list has no title of
 * its own: the module around it names it (a `Panel` or `SectionTitle`).
 */
export const BarList = React.forwardRef<HTMLDivElement, BarListProps>(
  (
    {
      items,
      format = defaultFormat,
      showPercent = false,
      percentOf = 'max',
      showRank = false,
      emptyLabel = 'No data',
      className,
    },
    ref,
  ) => {
    const max = items.reduce((m, it) => Math.max(m, it.value || 0), 0) || 1;
    const total = items.reduce((sum, it) => sum + Math.max(0, it.value || 0), 0) || 1;

    return (
      <div ref={ref} className={cn('flex flex-col', className)}>
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          <ul className="flex flex-col gap-3.5">
            {items.map((it, i) => {
              const value = it.value || 0;
              const pct = Math.max(0, Math.min(100, (value / max) * 100));
              return (
                <li key={`${it.label}-${i}`} className="flex items-start gap-3">
                  {showRank ? (
                    <span className="mt-1.5 w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium text-foreground">
                        {it.label}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                        {format(value)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          it.color ?? 'bg-accent-bar',
                        )}
                        style={{ width: `${pct}%` }}
                        role="progressbar"
                        aria-valuenow={Math.round(pct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={it.label}
                      />
                    </div>
                    {/* Only render the footer row when there is something to show, so
                        bars without a sub or a percent don't accrue a stray 4px trailer. */}
                    {it.sub || showPercent ? (
                      <div className="mt-1 flex items-baseline justify-between gap-3">
                        {it.sub ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {it.sub}
                          </span>
                        ) : (
                          <span />
                        )}
                        {showPercent ? (
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {percentText(percentOf === 'total' ? (Math.max(0, value) / total) * 100 : pct)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  },
);
BarList.displayName = 'BarList';

export default BarList;
