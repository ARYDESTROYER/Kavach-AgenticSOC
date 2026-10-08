/**
 * The chart tooltip: portalled out of the transcript so no overflow clips it,
 * anchored BESIDE the active mark (preferring the side away from the plot centre so it
 * never covers what is being read), and clamped 8 px inside the viewport on every side.
 *
 * The portal target is `document.body`, or the enclosing dialog when the chart sits in
 * one (the Expand sheet): a modal Radix layer turns off pointer events outside itself
 * and treats a press outside as a dismissal, so a body-level tooltip there could be
 * neither hovered nor clicked without closing the sheet.
 *
 * It is hoverable (WCAG 1.4.13: the pointer can move into it without it vanishing) and
 * `aria-hidden` — assistive tech hears the same reading through the shell announcer and
 * reads every value in the sr-only data table. Rows read: line-key swatch, VALUE
 * (semibold, tabular), label.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartTooltipPortalProps {
  open: boolean;
  /**
   * Viewport rects of the active mark/slot and of the plot (to pick the side away from
   * its centre). Called at placement time — on open, on a cursor move and on every
   * scroll/resize — so the tooltip follows the mark, never a stale snapshot.
   */
  getAnchor: () => { anchor: AnchorRect; plot: AnchorRect | null } | null;
  /** Changes whenever the active position changes (re-places the tooltip). */
  anchorKey: string;
  tipRef: React.RefObject<HTMLDivElement>;
  /** The element to portal into (the enclosing dialog); `document.body` when null. */
  getContainer?: () => HTMLElement | null;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: React.ReactNode;
  testId?: string;
}

const MARGIN = 8;
const GAP = 6;

/** Pure placement: beside the anchor (preferred side first), else below/above, then clamped. */
export function placeTooltip(
  anchor: AnchorRect,
  plot: AnchorRect | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const { width: tw, height: th } = size;
  const centre = plot ? (plot.left + plot.right) / 2 : viewport.width / 2;
  const preferRight = (anchor.left + anchor.right) / 2 <= centre;
  const fitsRight = anchor.right + GAP + tw <= viewport.width - MARGIN;
  const fitsLeft = anchor.left - GAP - tw >= MARGIN;
  let left: number;
  let top: number;
  if ((preferRight && fitsRight) || (!preferRight && !fitsLeft && fitsRight)) {
    left = anchor.right + GAP;
    top = anchor.top;
  } else if (fitsLeft) {
    left = anchor.left - GAP - tw;
    top = anchor.top;
  } else {
    // A full-width row (horizontal bars): below it, else above it.
    left = Math.min(anchor.left, viewport.width - MARGIN - tw);
    top = anchor.bottom + GAP + th <= viewport.height - MARGIN ? anchor.bottom + GAP : anchor.top - GAP - th;
  }
  return {
    left: Math.round(Math.max(MARGIN, Math.min(left, viewport.width - MARGIN - tw))),
    top: Math.round(Math.max(MARGIN, Math.min(top, viewport.height - MARGIN - th))),
  };
}

export function ChartTooltipPortal({
  open,
  getAnchor,
  anchorKey,
  tipRef,
  getContainer,
  onMouseEnter,
  onMouseLeave,
  children,
  testId = 'chart-tooltip',
}: ChartTooltipPortalProps) {
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  const getAnchorRef = React.useRef(getAnchor);
  getAnchorRef.current = getAnchor;

  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const place = () => {
      const tip = tipRef.current;
      const at = getAnchorRef.current();
      if (!tip || !at) return;
      const next = placeTooltip(
        at.anchor,
        at.plot,
        { width: tip.offsetWidth, height: tip.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorKey, tipRef]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={tipRef}
      aria-hidden
      data-testid={testId}
      className={cn(
        'fixed z-50 w-64 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-popover px-3 py-2',
        'text-xs text-popover-foreground shadow-elev2',
      )}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    getContainer?.() ?? document.body,
  );
}

export interface TooltipRow {
  key: string;
  /** Mark colour for the line-key swatch (a token string, never block data). */
  color?: string;
  /** Swatch shape mirrors the mark. */
  shape?: 'rect' | 'line';
  value: string;
  label: string;
  muted?: boolean;
  /** The label is log/source-derived: mono (G7). */
  untrusted?: boolean;
}

/** Tooltip body: a heading, then value-first rows, then optional notes. */
export function TooltipBody({
  heading,
  rows,
  notes,
}: {
  heading: React.ReactNode;
  rows: TooltipRow[];
  notes?: React.ReactNode[];
}) {
  return (
    <>
      <p className="break-words font-medium text-foreground">{heading}</p>
      {rows.length ? (
        <div className="mt-1.5 grid grid-cols-[0.75rem_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          {rows.map((r) => (
            <React.Fragment key={r.key}>
              {r.color ? (
                r.shape === 'line' ? (
                  <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />
                ) : (
                  <span className="size-2 rounded-[1px]" style={{ backgroundColor: r.color }} aria-hidden />
                )
              ) : (
                <span aria-hidden />
              )}
              <span
                className={cn(
                  'text-right font-semibold tabular-nums',
                  r.muted ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {r.value}
              </span>
              <span className={cn('min-w-0 break-words text-muted-foreground', r.untrusted && 'font-mono')}>
                {r.label}
              </span>
            </React.Fragment>
          ))}
        </div>
      ) : null}
      {notes?.filter(Boolean).map((n, i) => (
        <p key={i} className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">
          {n}
        </p>
      ))}
    </>
  );
}
