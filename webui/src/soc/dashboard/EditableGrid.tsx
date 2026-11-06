/**
 * `EditableGrid`: the react-grid-layout EDIT surface (Round 5 / G7, CD3).
 *
 * ⚠ THIS IS THE ONLY MODULE THAT IMPORTS `react-grid-layout` (and its CSS). It is
 * pulled in EXCLUSIVELY through a dynamic `import()` from {@link WidgetGrid} when the
 * operator enters edit mode, so RGL (+ `react-draggable`/`react-resizable`, ~18.5 KB
 * gz) and its stylesheet never enter the entry chunk / first-paint graph. View mode
 * and first paint ship ZERO grid JS (keeps `bundle-first-paint.test` green: the entry
 * chunk statically imports neither this file nor RGL).
 *
 * WHERE: only on a board at least `NARROW_EDIT_MAX_WIDTH` (640 px) wide (a board already
 * editing as the list comes back here only from 664 px, `NARROW_EDIT_HYSTERESIS`); a
 * narrower board edits as WidgetGrid's one-column list and never loads this module.
 *
 * WHAT IT DOES: renders RGL's single-breakpoint `GridLayout` over the 12-column grid,
 * wired to the SAME `{i,x,y,w,h,minW,minH,static}` item shape we persist (no adapter),
 * with:
 *   - `useContainerWidth({ measureBeforeMount: true })` for width (the v2 hook: NOT
 *     the legacy `WidthProvider` HOC, which remounts/flickers).
 *   - a drag handle SCOPED to `.card-drag-handle` so dragging over a chart/link/button
 *     inside a widget never hijacks the interaction.
 *   - resize on the SE corner only (calm, dense-widget-safe).
 *   - `onLayoutChange` bubbled up so the builder can debounce-persist on settle.
 *
 * Each child is keyed by the widget's stable id (`i`): RGL positions a child by
 * matching its `key` to the `layout` item's `i`. The child bodies are rendered by the
 * caller and handed in via `renderItem` so this file stays purely the grid mechanic.
 *
 * NON-NEGOTIABLES: a layout is ADVISORY presentation only (#3: never feeds `decide()`);
 * widget titles/labels are the child's concern and render as plain text/SVG (#9).
 */
import * as React from 'react';
// The heavy import: reachable ONLY via the dynamic import in WidgetGrid.
import { GridLayout, useContainerWidth, type Layout } from 'react-grid-layout';

// Base RGL + resize CSS, then our token overrides. All three load lazily with this
// chunk (edit mode only), never on first paint.
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './rgl-theme.css';

import type { DashboardWidget } from '@/lib/types';
import { GRID_COLS, GRID_MARGIN, widgetsToLayout, type GridItemShape } from './layout-utils';

export interface EditableGridProps {
  /** The widgets to place (their geometry drives the RGL layout). */
  widgets: DashboardWidget[];
  /** Grid column count (default 12). */
  cols?: number;
  /** Row height in pixels (8px-grid friendly). */
  rowHeight?: number;
  /** Called on every RGL layout change (drag/resize tick): the caller debounces. */
  onLayoutChange: (layout: GridItemShape[]) => void;
  /** Render one widget's body (the caller owns the card chrome + toolbar). */
  renderItem: (widget: DashboardWidget) => React.ReactNode;
  className?: string;
}

/** Map RGL's readonly `Layout` back to our mutable persisted item shape. */
function toItems(layout: Layout): GridItemShape[] {
  return layout.map((it) => ({
    i: it.i,
    x: it.x,
    y: it.y,
    w: it.w,
    h: it.h,
    minW: it.minW,
    minH: it.minH,
    static: it.static,
  }));
}

/**
 * The lazily-loaded RGL editable grid. Default-exported so `React.lazy(() =>
 * import('./EditableGrid'))` in WidgetGrid picks it up directly.
 */
export default function EditableGrid({
  widgets,
  cols = GRID_COLS,
  rowHeight = 56,
  onLayoutChange,
  renderItem,
  className,
}: EditableGridProps) {
  // v2 width detection: measure before mount so the first paint of the grid is at the
  // real width (no SSR width=0 flash). `containerRef` goes on the wrapper.
  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
  });

  const layout = React.useMemo<GridItemShape[]>(
    () => widgetsToLayout(widgets, cols),
    [widgets, cols],
  );

  const handleLayoutChange = React.useCallback(
    (next: Layout) => onLayoutChange(toItems(next)),
    [onLayoutChange],
  );

  return (
    <div ref={containerRef as React.Ref<HTMLDivElement>} className={className}>
      {mounted && width > 0 ? (
        <GridLayout
          width={width}
          layout={layout}
          onLayoutChange={handleLayoutChange}
          gridConfig={{
            cols,
            rowHeight,
            // The same gutter `gridCellWidth` assumes when it sizes a widget's toolbar.
            margin: [GRID_MARGIN, GRID_MARGIN],
            containerPadding: [0, 0],
          }}
          dragConfig={{
            enabled: true,
            bounded: false,
            // Only the card's header grip starts a drag: never a click inside the body.
            handle: '.card-drag-handle',
            threshold: 4,
          }}
          resizeConfig={{
            enabled: true,
            handles: ['se'],
          }}
        >
          {widgets.map((w) => (
            <div key={(w as { i?: string; id?: string }).i ?? (w as { id?: string }).id}>
              {renderItem(w)}
            </div>
          ))}
        </GridLayout>
      ) : null}
    </div>
  );
}
