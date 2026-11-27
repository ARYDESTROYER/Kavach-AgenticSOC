/**
 * Pure layout helpers for the custom-dashboard grid (Round 5 / G7, CD3/CD4).
 *
 * These are the dependency-free, side-effect-free adapters between the three shapes
 * the same data wears at different layers:
 *
 *   1. PERSISTED (`DashboardWidget` from `@/lib/types`, mirroring the backend
 *      `models.DashboardWidget`): the wire/store shape. Its stable id is `i` and its
 *      grid geometry is `{x,y,w,h,minW,minH,static}` (12-col grid units). This IS the
 *      react-grid-layout item shape, so persistence and the grid library share ONE
 *      contract (no translation of the geometry itself).
 *   2. IN-MEMORY / registry shape: what `registry.ts` produces (`buildDefaultWidgets`
 *      / `reconcileWidgets`) using `id` as the stable key. The CD-core registry writes
 *      `id`, the backend writes `i`; these helpers read EITHER so a widget from either
 *      producer round-trips.
 *   3. RGL `LayoutItem` (`{i,x,y,w,h,minW,minH,static}`): the array RGL's `GridLayout`
 *      reads/writes via `layout` / `onLayoutChange`.
 *
 * Everything here is PURE (no React, no fetch, no `decide()`: a layout is advisory,
 * #3). No import of react-grid-layout: these helpers must be safe to load in VIEW mode,
 * where zero grid JS ships.
 */
import type { DashboardWidget } from '@/lib/types';

/** The fixed grid column count (matches backend `DashboardLayout.columns=12`). */
export const GRID_COLS = 12;

/** A hard ceiling on row index / height so a tampered/keyboard-driven y never runs away. */
export const MAX_ROWS = 1000;

/** The RGL `LayoutItem` subset we persist (byte-identical to `DashboardWidget` geometry). */
export interface GridItemShape {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  static?: boolean;
}

/** A stable widget id: reads `i` (backend/RGL) OR `id` (registry), whichever is set. */
export function widgetId(w: DashboardWidget): string {
  const anyW = w as Record<string, unknown>;
  const i = typeof anyW.i === 'string' ? anyW.i : '';
  const id = typeof anyW.id === 'string' ? anyW.id : '';
  return i || id || '';
}

/** The widget's declarative options bag, reading `options` (backend) OR `config` (types). */
export function widgetOptions(w: DashboardWidget): Record<string, unknown> {
  const anyW = w as Record<string, unknown>;
  const opts = anyW.options ?? anyW.config;
  return opts && typeof opts === 'object' && !Array.isArray(opts)
    ? (opts as Record<string, unknown>)
    : {};
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Project a persisted widget onto an RGL `LayoutItem`, clamping geometry into the
 * 12-col grid (defense against a tampered layout: the server also clamps, #9). `i`
 * is the stable id RGL uses as the child key.
 */
export function widgetToItem(w: DashboardWidget, cols = GRID_COLS): GridItemShape {
  const anyW = w as Record<string, unknown>;
  const width = clampInt(anyW.w, 1, cols, Math.min(4, cols));
  const height = clampInt(anyW.h, 1, MAX_ROWS, 4);
  const x = clampInt(anyW.x, 0, Math.max(0, cols - width), 0);
  const y = clampInt(anyW.y, 0, MAX_ROWS, 0);
  const minW =
    anyW.minW == null ? undefined : clampInt(anyW.minW, 1, cols, 1);
  const minH =
    anyW.minH == null ? undefined : clampInt(anyW.minH, 1, MAX_ROWS, 1);
  return {
    i: widgetId(w),
    x,
    y,
    w: width,
    h: height,
    minW,
    minH,
    static: Boolean(anyW.static),
  };
}

/** Build the RGL layout array (clamped) for a widget list. */
export function widgetsToLayout(
  widgets: readonly DashboardWidget[],
  cols = GRID_COLS,
): GridItemShape[] {
  return widgets.map((w) => widgetToItem(w, cols));
}

/**
 * Apply an RGL layout array back onto a widget list, matching by id (`i`). Returns a
 * NEW widget array with updated geometry; the widget `type`/`options` are preserved.
 * Items absent from `layout` keep their prior geometry (RGL always emits all items, so
 * this is just defensive). Pure: no mutation of the inputs.
 */
export function applyLayout(
  widgets: readonly DashboardWidget[],
  layout: readonly GridItemShape[],
): DashboardWidget[] {
  const byId = new Map(layout.map((it) => [it.i, it]));
  return widgets.map((w) => {
    const it = byId.get(widgetId(w));
    if (!it) return w;
    return {
      ...w,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      // Preserve any prior minW/minH when the layout item omits them.
      minW: it.minW ?? (w as Record<string, unknown>).minW as number | undefined,
      minH: it.minH ?? (w as Record<string, unknown>).minH as number | undefined,
    } as DashboardWidget;
  });
}

// --------------------------------------------------------------------------- //
// Deterministic packing: the VIEW-mode analogue of RGL's compaction.
// VIEW mode is a plain CSS grid that renders each widget's persisted {x,y} verbatim,
// so it has NO negative-gravity compaction of its own. A per-role DEFAULT dashboard
// (and the reconcile-append path) seeds every widget at (0,0) expecting RGL to pack
// them: but RGL never runs in view mode, so without this they all collide in the
// top-left cell (an unusable pile). `packWidgets` is that missing packer: pure,
// side-effect-free, and safe to load in view mode (no RGL import).
// --------------------------------------------------------------------------- //

interface PackRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned rectangle overlap test (touching edges do NOT count as overlap). */
function rectsIntersect(a: PackRect, b: PackRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Return a NEW widget list with non-overlapping geometry, preserving the ORIGINAL
 * array order (so React keys stay stable). Two regimes, chosen by the input:
 *
 *   • UNPLACED (every widget at the origin: the per-role default / freshly-seeded
 *     case): FLOW-pack left→right in reading order, wrapping at the column edge and
 *     advancing rows by the tallest widget in the row. Turns the (0,0) pile into a
 *     coherent grid without needing curated coordinates.
 *   • PLACED (a real saved/RGL layout): COLLISION-resolve only: keep each widget's
 *     x/w/h and push y DOWN until it no longer overlaps an already-placed widget.
 *     A valid non-overlapping layout is returned byte-for-byte (idempotent), so a
 *     user's saved arrangement is respected; only genuine overlaps are repaired.
 *
 * O(n²), deterministic. Clamps geometry via `widgetToItem` first (defense, #9).
 */
export function packWidgets(
  widgets: readonly DashboardWidget[],
  cols = GRID_COLS,
): DashboardWidget[] {
  if (widgets.length <= 1) return widgets.map((w) => ({ ...w }));

  const geo = widgets.map((w, i) => ({ w, i, g: widgetToItem(w, cols) }));
  const out = new Array<DashboardWidget>(widgets.length);

  const allAtOrigin = geo.every(({ g }) => g.x === 0 && g.y === 0);
  if (allAtOrigin) {
    let cx = 0; // running x cursor within the current row
    let rowY = 0; // top of the current row
    let rowH = 0; // tallest widget placed in the current row
    for (const { w, i, g } of geo) {
      const ww = Math.min(g.w, cols);
      if (cx + ww > cols) {
        // wrap to a new row below the tallest widget of the row just filled
        rowY += rowH;
        cx = 0;
        rowH = 0;
      }
      out[i] = { ...w, x: cx, y: rowY, w: ww, h: g.h } as DashboardWidget;
      cx += ww;
      rowH = Math.max(rowH, g.h);
    }
    return out;
  }

  // Collision-resolve: process in reading order (y, then x, then original index for a
  // stable tie-break) and push each widget's y down until it clears prior placements.
  const order = [...geo].sort((a, b) => a.g.y - b.g.y || a.g.x - b.g.x || a.i - b.i);
  const placed: PackRect[] = [];
  for (const { w, i, g } of order) {
    let y = g.y;
    const rect: PackRect = { x: g.x, y, w: g.w, h: g.h };
    while (placed.some((p) => rectsIntersect(rect, p))) {
      y += 1;
      rect.y = y;
    }
    placed.push({ ...rect });
    out[i] = { ...w, x: g.x, y, w: g.w, h: g.h } as DashboardWidget;
  }
  return out;
}

/**
 * Move every widget up as far as it goes without overlapping one above it, in reading
 * order: the vertical compaction react-grid-layout applies when Edit mode mounts. Seeding
 * the draft with the same geometry means the grid's first layout report changes nothing,
 * so opening Edit mode never reads as an unsaved change (and never asks "Discard
 * changes?" on the way out). A layout saved from Edit mode is already compact and comes
 * back unchanged. Pure; keeps the input order.
 */
export function compactVertically(widgets: readonly DashboardWidget[]): DashboardWidget[] {
  const geo = widgets.map((w, index) => ({ w, index }));
  const order = [...geo].sort(
    (a, b) => (Number(a.w.y) || 0) - (Number(b.w.y) || 0) || (Number(a.w.x) || 0) - (Number(b.w.x) || 0) || a.index - b.index,
  );
  const placed: PackRect[] = [];
  const out = new Array<DashboardWidget>(widgets.length);
  const collides = (r: PackRect) => placed.find((p) => rectsIntersect(r, p));
  for (const { w, index } of order) {
    const rect = { x: Number(w.x) || 0, y: Number(w.y) || 0, w: Number(w.w) || 1, h: Number(w.h) || 1 };
    const bottom = placed.reduce((max, p) => Math.max(max, p.y + p.h), 0);
    rect.y = Math.min(bottom, rect.y);
    while (rect.y > 0 && !collides({ ...rect, y: rect.y - 1 })) rect.y -= 1;
    for (let hit = collides(rect); hit; hit = collides(rect)) rect.y = hit.y + hit.h;
    placed.push({ ...rect });
    out[index] = { ...w, y: rect.y } as DashboardWidget;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Edit mode on a narrow board: one column in reading order (Round 14, SPEC §4.4.5).
// The 12-column geometry stays the stored layout; these helpers only read it in order
// and reorder it, so a narrow screen never writes one-column geometry.
// --------------------------------------------------------------------------- //

/** The gutter between grid cells, in px (the edit grid's `margin`, both axes). */
export const GRID_MARGIN = 16;

/**
 * The geometry Edit mode works on: overlaps repaired (`packWidgets`), then compacted the
 * way react-grid-layout compacts it. Idempotent; keeps the input order.
 */
export function editGeometry(widgets: readonly DashboardWidget[], cols = GRID_COLS): DashboardWidget[] {
  return compactVertically(packWidgets(widgets, cols));
}

/**
 * The indices of `widgets` in reading order: top to bottom, then left to right, ties in
 * array order. This is the order view mode stacks a board in on a phone. Pure.
 */
export function readingOrder(widgets: readonly DashboardWidget[], cols = GRID_COLS): number[] {
  const items = widgets.map((w) => widgetToItem(w, cols));
  return items.map((_, i) => i).sort((a, b) => items[a].y - items[b].y || items[a].x - items[b].x || a - b);
}

/**
 * The pixel width the edit grid gives a widget `w` columns wide on a board `width` px
 * wide: react-grid-layout's column arithmetic with {@link GRID_MARGIN} gutters and no
 * outer padding.
 */
export function gridCellWidth(w: number, width: number, cols = GRID_COLS, margin = GRID_MARGIN): number {
  const span = Math.max(1, Math.min(cols, Math.round(w) || 1));
  const column = (width - margin * (cols - 1)) / cols;
  return column * span + margin * (span - 1);
}

/** A reorder step in the one-column list. */
export type ReorderDir = 'up' | 'down';

/**
 * Where `id` sits in the reading order of the board's {@link editGeometry}: its 1-based
 * `position` of `total`, or `null` when no widget has that id. Pure.
 */
export function readingPosition(
  widgets: readonly DashboardWidget[],
  id: string,
  cols = GRID_COLS,
): { position: number; total: number } | null {
  const geometry = editGeometry(widgets, cols);
  const index = readingOrder(geometry, cols).findIndex((i) => widgetId(geometry[i]) === id);
  return index < 0 ? null : { position: index + 1, total: geometry.length };
}

/** Whether `a` comes before `b` in reading order: higher up, or on the same row to its left. */
function readsBefore(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.y < b.y || (a.y === b.y && a.x < b.x);
}

/**
 * Whether a widget `w` wide at (`x`, `y`) rests on one of `placed`: at the top, or with a
 * placed widget's bottom edge right under some of its columns. Edit mode compacts the board
 * upwards (react-grid-layout and {@link compactVertically}), so a widget that does not rest
 * on something rises until it does, past the widgets beside it in the reading order.
 */
function restsOn(placed: readonly PackRect[], x: number, y: number, w: number): boolean {
  return y === 0 || placed.some((p) => p.y + p.h === y && p.x < x + w && p.x + p.w > x);
}

/**
 * Place the widgets of `base` (each at its own size) in the reading order `sequence`,
 * keeping the first `from` of them where they are. Every widget after that goes to the
 * first free spot after the one before it in that order that rests on what is already
 * placed, so compaction moves nothing and the board reads exactly in `sequence`. A
 * widget from `keepFrom` on stays where it is when that spot still qualifies; the moved
 * pair (before `keepFrom`) always takes the first spot. Pure; keeps the input order.
 */
function placeInOrder(
  base: readonly DashboardWidget[],
  sequence: readonly number[],
  from: number,
  keepFrom: number,
  cols: number,
): DashboardWidget[] {
  const items = base.map((w) => widgetToItem(w, cols));
  const placed: PackRect[] = sequence.slice(0, from).map((i) => ({ ...items[i] }));
  const next = base.slice();
  let prev: { x: number; y: number } | null = from > 0 ? items[sequence[from - 1]] : null;
  for (let k = from; k < sequence.length; k += 1) {
    const index = sequence[k];
    const { x: ownX, y: ownY, w, h } = items[index];
    const free = (x: number, y: number) =>
      (prev === null || readsBefore(prev, { x, y })) &&
      !placed.some((p) => rectsIntersect({ x, y, w, h }, p)) &&
      restsOn(placed, x, y, w);
    let spot: { x: number; y: number } | null = k >= keepFrom && free(ownX, ownY) ? { x: ownX, y: ownY } : null;
    if (!spot) {
      // A spot that rests on something is at the top or on a placed widget's bottom edge.
      const rows = [...new Set([0, ...placed.map((p) => p.y + p.h)])]
        .filter((y) => prev === null || y >= prev.y)
        .sort((a, b) => a - b);
      for (const y of rows) {
        for (let x = 0; x + w <= cols && !spot; x += 1) if (free(x, y)) spot = { x, y };
        if (spot) break;
      }
    }
    // Unreachable: the lowest bottom edge always has a spot under its widget's columns.
    const at = spot ?? { x: 0, y: placed.reduce((max, p) => Math.max(max, p.y + p.h), 0) };
    placed.push({ x: at.x, y: at.y, w, h });
    next[index] = { ...base[index], x: at.x, y: at.y } as DashboardWidget;
    prev = at;
  }
  return next;
}

/** The widget ids of `widgets` in reading order. */
function orderOfIds(widgets: readonly DashboardWidget[], cols: number): string[] {
  return readingOrder(widgets, cols).map((i) => widgetId(widgets[i]));
}

/**
 * Whether `widgets` is settled: Edit mode's own geometry ({@link editGeometry} changes no
 * widget), and reading in the order `ids`.
 */
function settledInOrder(widgets: readonly DashboardWidget[], ids: readonly string[], cols: number): boolean {
  const again = editGeometry(widgets, cols);
  const same = widgets.every((w, i) => {
    const a = widgetToItem(w, cols);
    const b = widgetToItem(again[i], cols);
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  });
  const order = orderOfIds(widgets, cols);
  return same && order.length === ids.length && order.every((id, i) => id === ids[i]);
}

/**
 * The empty cells above the lowest widget's bottom edge: the gaps a wider screen shows in
 * the board. Counts cells, so `widgets` must not overlap (Edit mode's geometry never
 * does). Pure.
 */
export function layoutGaps(widgets: readonly DashboardWidget[], cols = GRID_COLS): number {
  const rects = widgets.map((w) => widgetToItem(w, cols));
  const floor = rects.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  return floor * cols - rects.reduce((sum, r) => sum + r.w * r.h, 0);
}

/** Whether no two of `widgets` overlap. */
function overlapFree(widgets: readonly DashboardWidget[], cols: number): boolean {
  const rects = widgets.map((w) => widgetToItem(w, cols));
  return rects.every((a, i) => rects.every((b, j) => j <= i || !rectsIntersect(a, b)));
}

/**
 * The pair at `aIdx` and `bIdx` of `base` trading places AND sizes: each takes the other's
 * `{x, y, w, h}`, grown to its own `minW` and `minH` where those are larger. `null` when a
 * minimum does not fit inside the grid there. With no minimum in the way the two cover
 * exactly the cells they covered before, so no other widget has to move.
 */
function slotTrade(base: readonly DashboardWidget[], aIdx: number, bIdx: number, cols: number): DashboardWidget[] | null {
  const a = widgetToItem(base[aIdx], cols);
  const b = widgetToItem(base[bIdx], cols);
  const into = (item: GridItemShape, slot: GridItemShape): PackRect | null => {
    const w = Math.max(slot.w, item.minW ?? 1);
    const h = Math.max(slot.h, item.minH ?? 1);
    return slot.x + w > cols ? null : { x: slot.x, y: slot.y, w, h };
  };
  const aAt = into(a, b);
  const bAt = into(b, a);
  if (!aAt || !bAt) return null;
  const next = base.slice();
  next[aIdx] = { ...base[aIdx], ...aAt } as DashboardWidget;
  next[bIdx] = { ...base[bIdx], ...bAt } as DashboardWidget;
  return next;
}

/**
 * Move one widget a place up or down the reading order (the one-column list's Move up and
 * Move down). A phone never writes one-column geometry: the stored 12-column layout keeps
 * its shape, in this order of preference:
 *
 *   1. Two neighbours side by side in one row (same top, same height, touching) trade
 *      places, so "Arrivals (8) | Human vs AI (4)" becomes "Human vs AI (4) | Arrivals
 *      (8)", and two of the same size trade positions; nothing else moves.
 *   2. Any other pair keeps both sizes when it can: the board is laid out again from the
 *      pair on, each widget after it keeping its place when it can or moving to make room.
 *   3. Where keeping both sizes would leave more empty space on a wider screen (a module
 *      row with nothing beside the moved widget, and every row below shifted), the two
 *      trade places and sizes instead ({@link slotTrade}), so every other widget stays and
 *      the board keeps its shape. When a widget's minimum size does not fit the other's
 *      place, 2 stands.
 *
 * Every other widget keeps its own width and height. The result reads exactly as before
 * with the two swapped, and is already compact, so the grid on a wider screen shows that
 * same order. Returns the whole board in Edit mode's geometry, in the input order; at
 * either end of the order nothing moves. Pure.
 */
export function reorderWidget(
  widgets: readonly DashboardWidget[],
  id: string,
  dir: ReorderDir,
  cols = GRID_COLS,
): DashboardWidget[] {
  const base = editGeometry(widgets, cols);
  const order = readingOrder(base, cols);
  const at = order.findIndex((i) => widgetId(base[i]) === id);
  const to = dir === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= order.length) return base;
  // `first` comes before `second` now; after the move `second` comes first.
  const lo = Math.min(at, to);
  const [firstIdx, secondIdx] = [order[lo], order[lo + 1]];
  const sequence = [...order.slice(0, lo), secondIdx, firstIdx, ...order.slice(lo + 2)];
  const wanted = sequence.map((i) => widgetId(base[i]));
  const first = widgetToItem(base[firstIdx], cols);
  const second = widgetToItem(base[secondIdx], cols);
  // The two simple trades cover the same cells as before, so nothing else needs to move.
  const trade = base.slice();
  if (first.y === second.y && first.h === second.h && first.x + first.w === second.x) {
    trade[secondIdx] = { ...base[secondIdx], x: first.x } as DashboardWidget;
    trade[firstIdx] = { ...base[firstIdx], x: first.x + second.w } as DashboardWidget;
  } else if (first.w === second.w && first.h === second.h) {
    trade[secondIdx] = { ...base[secondIdx], x: first.x, y: first.y } as DashboardWidget;
    trade[firstIdx] = { ...base[firstIdx], x: second.x, y: second.y } as DashboardWidget;
  }
  // A side-by-side trade can leave one of the pair resting on nothing (its support was
  // under the other's columns); then the pair is laid out like any other.
  if (trade[firstIdx] !== base[firstIdx] && settledInOrder(trade, wanted, cols)) return trade;
  const kept = placeInOrder(base, sequence, lo, lo + 2, cols);
  const keptGaps = layoutGaps(kept, cols);
  if (keptGaps <= layoutGaps(base, cols)) return kept;
  const swapped = slotTrade(base, firstIdx, secondIdx, cols);
  return swapped &&
    overlapFree(swapped, cols) &&
    settledInOrder(swapped, wanted, cols) &&
    layoutGaps(swapped, cols) < keptGaps
    ? swapped
    : kept;
}

/**
 * Add `widget` (at its own size) as the LAST widget of the board's reading order: on the
 * lowest bottom edge, under that edge's widget, so compaction cannot lift it past the
 * widgets above. The one-column list adds and duplicates this way, so nothing already on
 * the board changes its place in the order. Returns the board in Edit mode's geometry with
 * the widget appended. Pure.
 */
export function appendWidget(
  widgets: readonly DashboardWidget[],
  widget: DashboardWidget,
  cols = GRID_COLS,
): DashboardWidget[] {
  const base = editGeometry(widgets, cols);
  const { w } = widgetToItem(widget, cols);
  const rects = base.map((b) => widgetToItem(b, cols));
  const floor = rects.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  // Leftmost widget ending on the floor; the new one sits under its first column.
  const under = rects.filter((r) => r.y + r.h === floor).sort((a, b) => a.x - b.x)[0];
  const x = under ? Math.min(under.x, cols - w) : 0;
  return [...base, { ...widget, x, y: floor } as DashboardWidget];
}

// --------------------------------------------------------------------------- //
// Keyboard move / resize (WCAG 2.5.7: a non-drag alternative to the pointer).
// Pure functions over ONE widget's geometry; the caller re-packs via RGL compaction.
// --------------------------------------------------------------------------- //

export type MoveDir = 'left' | 'right' | 'up' | 'down';
export type ResizeDir = 'wider' | 'narrower' | 'taller' | 'shorter';

/**
 * Return a copy of `w` moved ONE grid cell in `dir`, clamped so it stays inside the
 * `cols`-wide grid and never goes negative. A no-op at an edge returns an equal (but
 * new) object so React re-renders predictably.
 */
export function moveWidget(
  w: DashboardWidget,
  dir: MoveDir,
  cols = GRID_COLS,
): DashboardWidget {
  const item = widgetToItem(w, cols);
  let { x, y } = item;
  if (dir === 'left') x = Math.max(0, x - 1);
  else if (dir === 'right') x = Math.min(cols - item.w, x + 1);
  else if (dir === 'up') y = Math.max(0, y - 1);
  else if (dir === 'down') y = Math.min(MAX_ROWS, y + 1);
  return { ...w, x, y } as DashboardWidget;
}

/**
 * Return a copy of `w` resized ONE grid cell in `dir`, honouring `minW`/`minH` and the
 * grid bounds (width can never exceed the columns remaining to the right; a shrink can
 * never go below the minimum or 1).
 */
export function resizeWidget(
  w: DashboardWidget,
  dir: ResizeDir,
  cols = GRID_COLS,
): DashboardWidget {
  const item = widgetToItem(w, cols);
  const minW = item.minW ?? 1;
  const minH = item.minH ?? 1;
  let { w: width, h: height } = item;
  if (dir === 'wider') width = Math.min(cols - item.x, width + 1);
  else if (dir === 'narrower') width = Math.max(minW, width - 1);
  else if (dir === 'taller') height = Math.min(MAX_ROWS, height + 1);
  else if (dir === 'shorter') height = Math.max(minH, height - 1);
  return { ...w, w: width, h: height } as DashboardWidget;
}

// --------------------------------------------------------------------------- //
// Fresh widget-instance ids (dep-free; crypto.randomUUID when available).
// --------------------------------------------------------------------------- //

let _seq = 0;
/** A short, collision-resistant widget/dashboard id (no nanoid dep). */
export function freshId(prefix = 'w-'): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return `${prefix}${g.randomUUID()}`;
  _seq += 1;
  return `${prefix}${Date.now().toString(36)}-${_seq.toString(36)}`;
}

/**
 * Normalise a widget so it always carries a concrete `i` (its stable id). The builder
 * works in the `i`-keyed shape end-to-end so save maps 1:1 onto the persisted/RGL
 * contract; a registry-produced widget (which may only set `id`) is upgraded here.
 */
export function normalizeWidget(w: DashboardWidget): DashboardWidget {
  const id = widgetId(w) || freshId();
  const item = widgetToItem({ ...w, i: id } as DashboardWidget);
  return {
    ...w,
    i: id,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.minW,
    minH: item.minH,
    static: item.static,
    options: widgetOptions(w),
  } as DashboardWidget;
}
