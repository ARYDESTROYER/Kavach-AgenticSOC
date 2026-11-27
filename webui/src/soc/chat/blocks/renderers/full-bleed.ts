/**
 * "Full width" for one answer block (Round 12 P0-8 / P0-10): a wide table or chart breaks
 * out of the conversation lane to the conversation's own gutters, whatever the viewer's
 * width preference (Comfortable 64rem, Wide 88rem). Display only, per block, not kept.
 *
 * It works WITH the lane model (`message/lane.ts`) rather than around it: it is offered
 * only inside a chat lane (the host sets `--chat-lane-max`; the Case Manager embed, a
 * report panel and the Reports library set none), only when there is real room beyond
 * the lane, and it keeps the lane's optical alignment — the card frame still hangs into
 * the gutter by its padding, so its text starts on the gutter edge just as it starts on
 * the prose edge in the lane.
 *
 * Geometry is MEASURED, not assumed: the conversation is the block's nearest scroll
 * container (the transcript), the gutter is the lane's `clamp(1rem, 2.5cqi, 2.5rem)` of
 * it, and the card gets negative inline margins up to those edges — re-measured on every
 * resize, so it follows the window, the side panels and the width preference.
 *
 * A COMPACT card (Round 13, SPEC-chat §5.1) rests in the 42rem reading column, narrower
 * than the lane: the room it gains is measured from its own resting width, and its
 * reading-column cap is lifted while it is shown full width.
 */
import * as React from 'react';

/** Less extra room than this (px per side, summed) is not worth a toggle. */
export const MIN_BLEED_GAIN = 32;

export interface BleedMargins {
  marginLeft: number;
  marginRight: number;
}

function scrollRoot(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const oy = window.getComputedStyle(node).overflowY;
    if (oy === 'auto' || oy === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/** Is the card inside a chat lane (a host that sets the lane cap)? */
export function inChatLane(figure: HTMLElement | null): boolean {
  if (!figure || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
  return window.getComputedStyle(figure).getPropertyValue('--chat-lane-max').trim() !== '';
}

/**
 * The inline margins that take `figure` out to the conversation's gutters, or null when
 * the card is not in a lane or there is no room to gain. `hang` is the card's own
 * resting (negative) inline margin, which the bleed keeps.
 */
export function measureBleed(figure: HTMLElement, hang: number, restWidth?: number | null): BleedMargins | null {
  if (!inChatLane(figure)) return null;
  const parent = figure.parentElement;
  const root = scrollRoot(figure);
  if (!parent || !root) return null;
  const rootRect = root.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  if (rootRect.width <= 0 || parentRect.width <= 0) return null;
  // The scroll box's content edges (a both-edges scrollbar gutter is symmetric).
  const symmetric = window.getComputedStyle(root).scrollbarGutter?.includes('both-edges') ?? false;
  const left = symmetric ? rootRect.left + (rootRect.width - root.clientWidth) / 2 : rootRect.left + root.clientLeft;
  const right = left + root.clientWidth;
  const gutter = Math.min(40, Math.max(16, rootRect.width * 0.025));
  const marginLeft = Math.min(hang, Math.round(left + gutter - parentRect.left + hang));
  const marginRight = Math.min(hang, Math.round(parentRect.right - (right - gutter) + hang));
  // The room gained: from the card's resting width when it is known (a compact card rests
  // narrower than the lane), else from the lane edges the hang already reaches.
  const bled = parentRect.width - marginLeft - marginRight;
  const gain = typeof restWidth === 'number' && restWidth > 0 ? bled - restWidth : hang - marginLeft + (hang - marginRight);
  if (gain < MIN_BLEED_GAIN) return null;
  return { marginLeft, marginRight };
}

export interface FullBleed {
  /** Whether the card is shown full width. */
  on: boolean;
  /** Whether the toggle should be offered right now (call {@link check} first). */
  available: boolean;
  /** Re-measure whether full width is possible (e.g. when the card's menu opens). */
  check: () => void;
  toggle: () => void;
  /** Inline margins while on (undefined while off). */
  style: React.CSSProperties | undefined;
}

export function useFullBleed(figureRef: React.RefObject<HTMLElement>, enabled: boolean): FullBleed {
  const [on, setOn] = React.useState(false);
  const [available, setAvailable] = React.useState(false);
  const [margins, setMargins] = React.useState<BleedMargins | null>(null);
  /** The card's resting inline margin (the lane hang), read while it is not bled. */
  const hang = React.useRef(0);
  /** The card's resting width (a compact card rests narrower than the lane). */
  const rest = React.useRef<number | null>(null);

  const readHang = React.useCallback(() => {
    const fig = figureRef.current;
    if (!fig) return;
    const m = Number.parseFloat(window.getComputedStyle(fig).marginLeft);
    hang.current = Number.isFinite(m) ? Math.min(0, m) : 0;
    const width = fig.getBoundingClientRect().width;
    rest.current = Number.isFinite(width) && width > 0 ? width : null;
  }, [figureRef]);

  const check = React.useCallback(() => {
    const fig = figureRef.current;
    if (!enabled || !fig) {
      setAvailable(false);
      return;
    }
    if (!on) readHang();
    setAvailable(on || measureBleed(fig, hang.current, rest.current) !== null);
  }, [enabled, figureRef, on, readHang]);

  const toggle = React.useCallback(() => {
    setOn((cur) => {
      if (!cur) readHang();
      return !cur;
    });
  }, [readHang]);

  React.useLayoutEffect(() => {
    const fig = figureRef.current;
    if (!on || !enabled || !fig) {
      setMargins(null);
      return undefined;
    }
    const measure = () => {
      const next = measureBleed(fig, hang.current, rest.current);
      setMargins((cur) =>
        cur && next && cur.marginLeft === next.marginLeft && cur.marginRight === next.marginRight ? cur : next,
      );
    };
    measure();
    const root = scrollRoot(fig);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (ro) {
      if (root) ro.observe(root);
      if (fig.parentElement) ro.observe(fig.parentElement);
    }
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [on, enabled, figureRef]);

  return {
    on: on && enabled,
    available: enabled && available,
    check,
    toggle,
    // `maxWidth: none` lifts a compact card's reading-column cap while it is bled.
    style: on && enabled && margins ? { marginLeft: margins.marginLeft, marginRight: margins.marginRight, maxWidth: 'none' } : undefined,
  };
}
