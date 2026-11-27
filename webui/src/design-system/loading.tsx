import * as React from 'react';

import { cn } from '@/lib/cn';

export type LoadingLayout = 'page' | 'panel' | 'table' | 'inline';
export type LoadingShapeKind = 'none' | 'page' | 'panel' | 'rows';

export interface LoadingGlyphProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: 'sm' | 'md' | 'lg';
}

const GLYPH_SIZE: Record<NonNullable<LoadingGlyphProps['size']>, string> = {
  sm: 'size-5',
  md: 'size-8',
  lg: 'size-10',
};

/**
 * The one blocking-load motion mark used by the Console. It is intentionally
 * familiar: one Fluent/Material-style indeterminate arc rotates and changes length
 * over a quiet track. Under `prefers-reduced-motion`, the same ring remains visible
 * as a static partial arc.
 */
export const LoadingGlyph = React.forwardRef<HTMLSpanElement, LoadingGlyphProps>(
  ({ size = 'md', className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('relative inline-flex shrink-0 items-center justify-center', GLYPH_SIZE[size], className)}
      aria-hidden="true"
      data-testid="console-loading-glyph"
      {...props}
    >
      <svg
        viewBox="0 0 32 32"
        className="console-progress-ring size-full"
        fill="none"
        aria-hidden="true"
        data-loading-motion="indeterminate-ring"
      >
        <circle
          cx="16"
          cy="16"
          r="12"
          className="stroke-border/45"
          strokeWidth="2.25"
          data-loading-track="true"
        />
        <circle
          cx="16"
          cy="16"
          r="12"
          pathLength="100"
          className="console-progress-ring__arc stroke-primary"
          strokeWidth="2.75"
          strokeLinecap="round"
          strokeDasharray="26 74"
          data-loading-arc="true"
        />
      </svg>
    </span>
  ),
);
LoadingGlyph.displayName = 'LoadingGlyph';

export interface LoadingShapeProps extends React.HTMLAttributes<HTMLDivElement> {
  kind: Exclude<LoadingShapeKind, 'none'>;
  rows?: number;
}

const StaticBlock = ({ className }: { className: string }) => (
  <span className={cn('block rounded-sm bg-muted/75', className)} />
);

/**
 * Motionless geometry reserved behind a blocking loader. It keeps the resolved
 * content footprint stable without layering several competing shimmer animations.
 */
export const LoadingShape: React.FC<LoadingShapeProps> = ({
  kind,
  rows = 4,
  className,
  ...props
}) => {
  if (kind === 'rows') {
    return (
      <div
        className={cn('pointer-events-none absolute inset-x-5 inset-y-4 flex flex-col justify-between opacity-35', className)}
        aria-hidden="true"
        data-loading-shape="rows"
        {...props}
      >
        {Array.from({ length: Math.max(2, Math.min(rows, 6)) }).map((_, index) => (
          <div key={index} className="grid grid-cols-[1.1fr_1.6fr_.8fr] gap-5">
            <StaticBlock className="h-3.5" />
            <StaticBlock className="h-3.5" />
            <StaticBlock className="h-3.5" />
          </div>
        ))}
      </div>
    );
  }

  if (kind === 'panel') {
    return (
      <div
        className={cn('pointer-events-none absolute inset-5 opacity-30', className)}
        aria-hidden="true"
        data-loading-shape="panel"
        {...props}
      >
        <StaticBlock className="h-4 w-36" />
        <StaticBlock className="mt-3 h-3 w-64 max-w-[70%]" />
        <div className="absolute inset-x-0 bottom-0 grid grid-cols-2 gap-4">
          <StaticBlock className="h-14" />
          <StaticBlock className="h-14" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('pointer-events-none absolute inset-0 opacity-30', className)}
      aria-hidden="true"
      data-loading-shape="page"
      {...props}
    >
      <div className="absolute left-0 top-0 space-y-2">
        <StaticBlock className="h-3 w-24" />
        <StaticBlock className="h-6 w-56" />
        <StaticBlock className="h-3 w-72 max-w-[70vw]" />
      </div>
      <div className="absolute inset-x-0 bottom-0 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StaticBlock className="h-20" />
        <StaticBlock className="h-20" />
        <StaticBlock className="h-20" />
      </div>
    </div>
  );
};

export interface LoadingStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Visible and accessible description of what is loading. */
  label: string;
  /** Optional secondary context; keep it brief and actionable. */
  description?: string;
  layout?: LoadingLayout;
  /** Static content geometry behind the central glyph. */
  shape?: LoadingShapeKind;
  /** Row count hint when `shape="rows"`. */
  shapeRows?: number;
}

const LAYOUT_CLASS: Record<LoadingLayout, string> = {
  page: 'min-h-[clamp(24rem,68vh,48rem)] w-full',
  panel: 'min-h-64 w-full',
  table: 'min-h-52 w-full',
  inline: 'min-h-0 w-auto py-1',
};

/**
 * Shared blocking loading state for pages, panels, and empty tables. Data refreshes
 * that already have usable content should keep that content mounted and use
 * `LoadingBar` instead.
 */
export const LoadingState = React.forwardRef<HTMLDivElement, LoadingStateProps>(
  (
    {
      label,
      description,
      layout = 'panel',
      shape = 'none',
      shapeRows,
      className,
      ...props
    },
    ref,
  ) => (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      aria-label={label}
      className={cn(
        'relative isolate flex items-center justify-center overflow-hidden text-center',
        LAYOUT_CLASS[layout],
        layout === 'inline' && 'gap-2 text-left',
        className,
      )}
      data-loading-layout={layout}
      {...props}
    >
      {shape !== 'none' ? <LoadingShape kind={shape} rows={shapeRows} /> : null}
      <div
        className={cn(
          'relative z-10 flex items-center justify-center',
          layout === 'inline' ? 'gap-2' : 'flex-col gap-3 px-5 py-4',
        )}
      >
        <LoadingGlyph size={layout === 'page' ? 'lg' : layout === 'inline' ? 'sm' : 'md'} />
        <div className={cn(layout === 'inline' ? 'space-y-0' : 'space-y-1')}>
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description ? (
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
    </div>
  ),
);
LoadingState.displayName = 'LoadingState';
