/**
 * The frame every interactive answer-block chart shares (BLOCKS.md "Accessibility"):
 *
 *   - the plot is a labelled `role="group"` and ONE tab stop, with its keyboard
 *     instructions in `aria-describedby` (a `role="img"` would make the keyboard model
 *     presentational);
 *   - the marks are an `aria-hidden` SVG — assistive tech reads the always-present
 *     sr-only data table and the shell announcer, never the drawing;
 *   - the tooltip is portalled beside the active mark (into the enclosing dialog when
 *     the chart is in the Expand sheet, so it stays hoverable inside that layer);
 *   - in `forced-colors: active` every mark gains a 1px CanvasText outline
 *     ({@link MARK_FORCED}) so bars and segments stay distinguishable without colour;
 *     "not measured" keeps its hatch.
 *
 * Nothing animates: a restored transcript must look identical to a fresh one, so there
 * is nothing to reduce under `prefers-reduced-motion`.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { token } from '@/soc/components/palette';

import { ChartTooltipPortal, type AnchorRect } from './ChartTooltipPortal';
import { DataTableFallback, type DataTableFallbackProps } from './DataTableFallback';
import type { ChartNavigator } from './useChartNavigator';

export interface ChartShellProps {
  nav: ChartNavigator;
  ariaLabel: string;
  instructions: string;
  height: number;
  /** The SVG (or DOM) marks; `aria-hidden` is applied by the caller's element. */
  children: React.ReactNode;
  /** Pointer position → hit target (in plot-local coordinates). */
  onPointerAt?: (x: number, y: number) => void;
  onClick?: () => void;
  clickable?: boolean;
  tooltip: React.ReactNode;
  /** Viewport rect of the active mark, computed from the plot's own rect. */
  anchorFor: (plot: DOMRect) => AnchorRect | null;
  anchorKey: string;
  fallback: DataTableFallbackProps;
  legend?: React.ReactNode;
  footer?: React.ReactNode;
  testId: string;
  staticMode?: boolean;
  className?: string;
}

export function ChartShell({
  nav,
  ariaLabel,
  instructions,
  height,
  children,
  onPointerAt,
  onClick,
  clickable,
  tooltip,
  anchorFor,
  anchorKey,
  fallback,
  legend,
  footer,
  testId,
  staticMode = false,
  className,
}: ChartShellProps) {
  const rawId = React.useId();
  const instructionsId = `chart-help-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const interactive = !staticMode && nav.plotProps.tabIndex !== undefined;

  const getAnchor = React.useCallback(() => {
    const el = nav.plotRef.current;
    if (!el) return null;
    const plot = el.getBoundingClientRect();
    const anchor = anchorFor(plot);
    if (!anchor) return null;
    return { anchor, plot: { left: plot.left, right: plot.right, top: plot.top, bottom: plot.bottom } };
  }, [anchorFor, nav.plotRef]);

  // The enclosing dialog (the Expand sheet), so the tooltip stays inside its layer.
  const getContainer = React.useCallback(() => nav.plotRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null, [nav.plotRef]);

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || !onPointerAt) return;
    const r = e.currentTarget.getBoundingClientRect();
    onPointerAt(e.clientX - r.left, e.clientY - r.top);
  };

  /* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events --
     The plot is ONE tab stop (Chartability: never a stop per mark) driven by the arrow
     keys; Enter activates a drill through the navigator's key handler, so the click
     handler has a keyboard equivalent. Its role is a labelled group with instructions. */
  return (
    <div className={cn('relative min-w-0', className)} data-testid={testId}>
      <div
        ref={nav.plotRef}
        role="group"
        aria-label={ariaLabel}
        aria-describedby={interactive ? instructionsId : undefined}
        {...(interactive ? nav.plotProps : {})}
        onMouseMove={interactive ? onMouseMove : undefined}
        onClick={interactive ? onClick : undefined}
        className={cn(
          'relative select-none rounded-sm outline-none',
          interactive && 'focus-visible:ring-2 focus-visible:ring-ring',
          clickable && 'cursor-pointer',
        )}
        style={{ height }}
        data-testid={`${testId}-plot`}
      >
        {interactive ? (
          <p id={instructionsId} className="sr-only">
            {instructions}
          </p>
        ) : null}
        {children}
      </div>
      {legend}
      {footer}
      <DataTableFallback {...fallback} visible={staticMode} />
      {interactive ? (
        <ChartTooltipPortal
          open={nav.open}
          getAnchor={getAnchor}
          anchorKey={anchorKey}
          tipRef={nav.tipRef}
          getContainer={getContainer}
          onMouseEnter={nav.cancelHide}
          onMouseLeave={nav.scheduleHide}
          testId={`${testId}-tooltip`}
        >
          {tooltip}
        </ChartTooltipPortal>
      ) : null}
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */
}

/** Forced-colors fallback for every mark: a 1px system-ink outline. */
export const MARK_FORCED = 'forced-colors:stroke-[CanvasText]';

/** The hatch pattern for "not measured" marks (one per chart; id from useId, G2). */
export function HatchPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1={0} y1={0} x2={0} y2={6} stroke={token('muted-foreground', 0.3)} strokeWidth={1.5} />
    </pattern>
  );
}

/** A DOM-safe id fragment from React.useId(). */
export function useSvgId(prefix: string): string {
  const raw = React.useId();
  return `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
