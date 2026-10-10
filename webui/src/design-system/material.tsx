/**
 * Material — the Console's ONE translucent surface, for floating chrome only.
 *
 * Apple uses a translucent material as a floating functional layer that brings
 * structure without stealing focus. Here that is reserved for chrome that content
 * scrolls UNDER: the top bar, sticky page / control / filter bars, a sticky record
 * header. Tables, charts, transcripts and evidence always sit on an opaque canvas or
 * card, and menus, popovers and dialogs are solid, so translucent never stacks on
 * translucent (ui-standard "Materials").
 *
 * - `materialBar` / `materialThick` are the two thicknesses of the one recipe
 *   (lib/ui-recipes.ts). Both carry the `material-surface` marker, which theme.css
 *   turns solid under `prefers-reduced-transparency`, `data-transparency="reduced"` and
 *   `prefers-contrast: more` (the last also restores a real bottom rule).
 * - `useScrollEdge` replaces a hard divider under sticky chrome with the scroll-edge
 *   fade: it sets `data-scrolled="true"` only while the bar is pinned AND content has
 *   scrolled beneath it.
 * - `MaterialBar` is the ready-made sticky bar that wires both together.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { materialBar, materialThick } from '@/lib/ui-recipes';

export { materialBar, materialThick };

/** Overflow values that make an element its own scroll container. */
const SCROLLING = /(auto|scroll|overlay)/;

/**
 * The element whose scroll moves content under `el`: the nearest ancestor that can
 * ACTUALLY scroll vertically, else the document.
 *
 * "Can actually scroll" is two facts, not one. A computed `overflow-y: auto` alone is
 * not enough: CSS turns `overflow-x: hidden` into `overflow-y: auto` (a lone `hidden`
 * axis forces the other off `visible`), so the shell's `overflow-x-hidden` wrappers
 * report `auto` while growing with their content and never scrolling — the WINDOW
 * scrolls. Picking one of them pinned the measurement to a scrollTop that never moves.
 * So an ancestor counts only when its content also overflows it (`scrollHeight >
 * clientHeight`). Resolved on every measurement, because a region that starts short
 * can become scrollable once its data arrives.
 */
function scrollContainerOf(el: HTMLElement): Element {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if (SCROLLING.test(overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

export interface UseScrollEdgeOptions {
  /** Turn the observation off (e.g. a bar that is not sticky right now). Default `true`. */
  enabled?: boolean;
}

/**
 * Show the scroll-edge fade under a sticky material bar exactly while content is
 * scrolled beneath it. Writes `data-scrolled="true"` on the element (no re-render per
 * scroll) and removes it otherwise; the fade itself is CSS (`.material-surface`).
 *
 * "Pinned" is measured, not assumed: the bar's top edge sits AT its own computed sticky
 * `top` (within a pixel), and its scroll container has actually moved. A bar that merely
 * starts at the top of an unscrolled page never shows the fade, and neither does one that
 * has been pushed up and out by the end of its containing block (it is no longer chrome
 * over content, it is leaving with it).
 */
export function useScrollEdge(
  ref: React.RefObject<HTMLElement | null>,
  { enabled = true }: UseScrollEdgeOptions = {},
): void {
  React.useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof window === 'undefined') return undefined;

    let frame = 0;

    const measure = () => {
      frame = 0;
      const scroller = scrollContainerOf(el);
      const offset = Number.parseFloat(window.getComputedStyle(el).top);
      const stickyTop = Number.isFinite(offset) ? offset : 0;
      const containerTop =
        scroller !== document.scrollingElement && scroller !== document.documentElement
          ? scroller.getBoundingClientRect().top
          : 0;
      const pinned = Math.abs(el.getBoundingClientRect().top - containerTop - stickyTop) <= 1;
      const scrolled = scroller.scrollTop > 0;
      if (pinned && scrolled) el.dataset.scrolled = 'true';
      else delete el.dataset.scrolled;
    };
    const schedule = () => {
      if (frame) return;
      if (typeof window.requestAnimationFrame === 'function') {
        frame = window.requestAnimationFrame(measure);
      } else {
        measure();
      }
    };

    measure();
    // Scroll events do not bubble, so listen in the capture phase: one listener sees the
    // document AND any nested scroll container.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
      delete el.dataset.scrolled;
    };
  }, [ref, enabled]);
}

/**
 * `useScrollEdge` for a component that also FORWARDS its ref: returns one callback ref
 * that both feeds the scroll-edge observation and the caller's ref. The shared sticky
 * bars (PageHeader, ControlBar, FilterBar, TableHeader) and `MaterialBar` all use it, so
 * every sticky surface that wears the material shows the same fade.
 */
export function useScrollEdgeRef<T extends HTMLElement>(
  forwardedRef: React.ForwardedRef<T> | undefined,
  enabled: boolean,
): React.RefCallback<T> {
  const local = React.useRef<T | null>(null);
  useScrollEdge(local, { enabled });
  return React.useCallback(
    (node: T | null) => {
      local.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
}

export interface MaterialBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Pin under the top bar (`sticky top-[var(--header-h)]`). Default `true`. */
  sticky?: boolean;
  /** `regular` for bars; `thick` for large floating panes. Default `regular`. */
  thickness?: 'regular' | 'thick';
}

/**
 * A sticky bar on the Console material with the scroll-edge fade wired in. Children
 * are plain content; on a material, prefer `text-foreground` / `text-secondary-foreground`
 * at `font-medium` for small text, and put colour on solid chips.
 */
export const MaterialBar = /*#__PURE__*/ React.forwardRef<HTMLDivElement, MaterialBarProps>(
  function MaterialBar({ sticky = true, thickness = 'regular', className, ...rest }, forwardedRef) {
    const setRef = useScrollEdgeRef(forwardedRef, sticky);
    return (
      <div
        ref={setRef}
        className={cn(
          thickness === 'thick' ? materialThick : materialBar,
          sticky && 'sticky top-[var(--header-h)] z-20',
          className,
        )}
        {...rest}
      />
    );
  },
);
