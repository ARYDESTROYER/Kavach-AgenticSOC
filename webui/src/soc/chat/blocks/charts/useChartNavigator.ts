/**
 * The one keyboard + pointer interaction model for every answer-block chart (BLOCKS.md
 * §6), generalised from `CloseAttributionChart`:
 *
 *   - the plot is ONE tab stop (never a stop per mark); arrow keys move a cursor;
 *   - `i` is the primary position (an x slot, a row, a segment, a column), `j` the
 *     secondary one (a series in a slot, a stacked segment, a heatmap row) or -1 for
 *     "the whole slot";
 *   - ←/→ and ↑/↓ map to i/j by orientation; Home/End jump; Enter activates a drill;
 *     Esc dismisses the tooltip (and keeps it dismissed until the target changes);
 *   - hover shows the tooltip with a 160 ms hide delay, so the pointer can travel into
 *     the (hoverable, WCAG 1.4.13) tooltip; Esc anywhere and a press outside close it;
 *   - while it is open the tooltip is the TOPMOST layer (SPEC §10.4a): one Esc closes
 *     only the tooltip, never the Expand sheet or dialog the chart sits in;
 *   - every keyboard move is announced through the SHELL announcer — a long transcript
 *     must not grow one live region per chart.
 */
import * as React from 'react';

import { useAnnouncer } from '@/soc/components/announcer';

export type NavOrientation = 'horizontal' | 'vertical' | 'grid';

export interface ChartCursor {
  i: number;
  j: number;
}

export interface ChartNavigatorOptions {
  /** Number of primary positions (slots / rows / segments / columns). */
  count: number;
  /** Number of secondary positions (series / segments / rows); 0 or 1 disables ↑/↓. */
  secondary?: number;
  /**
   * `horizontal`: ←/→ move i, ↑/↓ move j (columns, lines, stacks).
   * `vertical`:   ↑/↓ move i, ←/→ move j (horizontal bars, funnels).
   * `grid`:       ←/→ move i (x), ↑/↓ move j (y), j always ≥ 0 (heatmaps).
   */
  orientation: NavOrientation;
  /** Plain-text reading of a position for the announcer. */
  summarize: (cursor: ChartCursor) => string;
  /** Enter / click on a position (drill-through). */
  onActivate?: (cursor: ChartCursor) => void;
  /** Where focus lands first (default: the last position — the newest bucket). */
  initial?: ChartCursor;
  disabled?: boolean;
}

export interface ChartNavigator {
  cursor: ChartCursor | null;
  open: boolean;
  focusRing: boolean;
  /** Pointer hover on a position (null = outside every hit target). */
  hover: (cursor: ChartCursor | null) => void;
  /** Keep the tooltip open while the pointer is over it. */
  cancelHide: () => void;
  scheduleHide: () => void;
  /** Spread onto the focusable plot element. */
  plotProps: {
    tabIndex: number | undefined;
    onFocus: () => void;
    onBlur: (e: React.FocusEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onMouseDown: () => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
  };
  /** Register the elements a press must hit to keep the tooltip open. */
  plotRef: React.RefObject<HTMLDivElement>;
  tipRef: React.RefObject<HTMLDivElement>;
}

const HIDE_DELAY_MS = 160;

const LAYER_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/**
 * Is the chart's tooltip the topmost layer? Yes unless focus sits inside an overlay
 * layer (dialog, menu, listbox) that does not itself contain the chart.
 */
export function tooltipOnTop(plot: Element | null): boolean {
  if (typeof document === 'undefined') return true;
  const focused = document.activeElement;
  const layer = focused instanceof Element ? focused.closest(LAYER_SELECTOR) : null;
  return !layer || (plot !== null && layer.contains(plot));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function useChartNavigator({
  count,
  secondary = 0,
  orientation,
  summarize,
  onActivate,
  initial,
  disabled = false,
}: ChartNavigatorOptions): ChartNavigator {
  const announce = useAnnouncer();
  const plotRef = React.useRef<HTMLDivElement>(null);
  const tipRef = React.useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = React.useState<ChartCursor | null>(null);
  const [open, setOpen] = React.useState(false);
  const [focusRing, setFocusRing] = React.useState(false);
  const pointerDown = React.useRef(false);
  const hideTimer = React.useRef<number | null>(null);
  /** Esc dismissed the tooltip for this position; it stays hidden until the target changes. */
  const dismissedFor = React.useRef<string | null>(null);
  const interactive = !disabled && count > 0;
  const minJ = orientation === 'grid' ? 0 : -1;
  const maxJ = Math.max(minJ, secondary - 1);

  const valid = cursor && cursor.i < count && cursor.j <= maxJ ? cursor : null;

  const cancelHide = React.useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);
  const scheduleHide = React.useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setOpen(false);
    }, HIDE_DELAY_MS);
  }, [cancelHide]);
  React.useEffect(() => cancelHide, [cancelHide]);

  const key = (c: ChartCursor) => `${c.i}:${c.j}`;

  const show = React.useCallback(
    (next: ChartCursor, speak: boolean) => {
      cancelHide();
      setCursor(next);
      setOpen(true);
      if (speak) announce(summarize(next));
    },
    [announce, cancelHide, summarize],
  );

  const hover = React.useCallback(
    (next: ChartCursor | null) => {
      if (!interactive) return;
      if (next === null) {
        scheduleHide();
        return;
      }
      if (dismissedFor.current === key(next)) return;
      dismissedFor.current = null;
      if (!valid || key(valid) !== key(next) || !open) show(next, false);
      else cancelHide();
    },
    [cancelHide, interactive, open, scheduleHide, show, valid],
  );

  const start = (): ChartCursor => {
    if (valid) return valid;
    if (initial) return { i: clamp(initial.i, 0, count - 1), j: clamp(initial.j, minJ, maxJ) };
    return { i: count - 1, j: orientation === 'grid' ? 0 : -1 };
  };

  const onFocus = () => {
    const fromPointer = pointerDown.current;
    pointerDown.current = false;
    if (!interactive || fromPointer) return; // a click: hover already owns the tooltip
    setFocusRing(true);
    show(start(), true);
  };
  const onBlur = (e: React.FocusEvent) => {
    // Focus moving INTO the tooltip (never focusable today) or within the plot keeps it.
    const next = e.relatedTarget as Node | null;
    if (next && (plotRef.current?.contains(next) || tipRef.current?.contains(next))) return;
    setFocusRing(false);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return;
    const from = start();
    let next: ChartCursor | null = null;
    const moveI = (d: number) => ({ i: clamp(from.i + d, 0, count - 1), j: from.j });
    const moveJ = (d: number) => ({ i: from.i, j: clamp(from.j + d, minJ, maxJ) });
    const horizontalI = orientation !== 'vertical';
    switch (e.key) {
      case 'ArrowRight':
        next = horizontalI ? moveI(1) : maxJ > minJ ? moveJ(1) : moveI(1);
        break;
      case 'ArrowLeft':
        next = horizontalI ? moveI(-1) : maxJ > minJ ? moveJ(-1) : moveI(-1);
        break;
      case 'ArrowDown':
        if (orientation === 'vertical') next = moveI(1);
        else if (orientation === 'grid') next = moveJ(1);
        else if (maxJ > minJ) next = moveJ(-1);
        break;
      case 'ArrowUp':
        if (orientation === 'vertical') next = moveI(-1);
        else if (orientation === 'grid') next = moveJ(-1);
        else if (maxJ > minJ) next = moveJ(1);
        break;
      case 'Home':
        next = { i: 0, j: from.j };
        break;
      case 'End':
        next = { i: count - 1, j: from.j };
        break;
      case 'Enter':
        if (onActivate && valid) {
          e.preventDefault();
          onActivate(valid);
        }
        return;
      case 'Escape':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          dismissedFor.current = key(from);
        }
        return;
      default:
        return;
    }
    if (!next) return;
    e.preventDefault();
    setFocusRing(true);
    dismissedFor.current = null;
    show(next, true);
  };

  const shown = interactive && open && valid !== null;

  // Esc anywhere dismisses a HOVER tooltip too (WCAG 1.4.13), and a press outside the
  // plot or the tooltip closes it on touch.
  //
  // Esc is caught in the WINDOW CAPTURE phase: Radix layers (the Expand sheet, a dialog)
  // listen on `document` in the capture phase, which runs before any handler on the plot,
  // so a plot-level handler could never stop one Esc from closing the sheet as well. When
  // the tooltip is on top — focus is on the page or inside the same layer as the chart —
  // the event stops here. When focus sits in ANOTHER layer above the chart (a menu opened
  // from the keyboard while the pointer rests on a chart), the tooltip still closes but
  // that layer gets its Esc too.
  React.useEffect(() => {
    if (!shown) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (tooltipOnTop(plotRef.current)) {
        e.preventDefault();
        e.stopPropagation();
      }
      setOpen(false);
      if (valid) dismissedFor.current = key(valid);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (plotRef.current?.contains(t) || tipRef.current?.contains(t))) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [shown, valid]);

  return {
    cursor: valid,
    open: shown,
    focusRing: focusRing && interactive && valid !== null,
    hover,
    cancelHide,
    scheduleHide,
    plotRef,
    tipRef,
    plotProps: {
      tabIndex: interactive ? 0 : undefined,
      onFocus,
      onBlur,
      onKeyDown,
      onMouseDown: () => {
        pointerDown.current = true;
        setFocusRing(false);
      },
      onMouseUp: () => {
        pointerDown.current = false;
      },
      onMouseLeave: () => {
        dismissedFor.current = null;
        if (!focusRing) scheduleHide();
      },
    },
  };
}
