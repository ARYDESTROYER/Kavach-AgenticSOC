/**
 * Edit mode on a narrow board and the toast clearance (Round 14 closing fixes, qa1-01 and
 * qa1-10; SPEC §4.4.5 Phone, §4.4.6). Pure parts only; the rendered list, the compact
 * toolbar and the builder's wiring are in `edit-list.test.tsx`.
 *
 *   - Under 640 px the board edits as one column; from 640 px it is the grid, and a cell
 *     too narrow for the whole toolbar gets the compact one (the widths measured live:
 *     a 4-column cell is 109 px on a 390 px phone, 373 px at 1440 px). A board already in
 *     the list goes back to the grid only from 664 px, so a classic scrollbar coming and
 *     going with the arrangement (632 px with it, 645 px without) cannot flip it.
 *   - Move up and Move down swap reading-order neighbours (exactly those two) on every
 *     built-in board and on random boards, keep every other widget's width and height,
 *     keep the widgets before the pair where they are, never overlap, and leave a layout
 *     the grid's compaction does not change, so a wider screen shows the same order. The
 *     pair keeps its sizes unless that would leave a gap on a wider screen; then the two
 *     trade places and sizes, so a move never opens a gap on a board without minimum
 *     sizes (every built-in board stays gap-free after any single move).
 *   - Add and Duplicate in the list put the new widget last without moving the others.
 *   - A sticky bar in the toasts' band lifts them by its distance from the viewport edge.
 */
import { describe, expect, it } from 'vitest';

import type { DashboardWidget } from '@/lib/types';
import { BUILTIN_BOARDS } from '@/soc/dashboard/builtins';
import {
  appendWidget,
  compactVertically,
  editGeometry,
  gridCellWidth,
  layoutGaps,
  readingOrder,
  readingPosition,
  reorderWidget,
  widgetId,
  widgetToItem,
  GRID_COLS,
} from '@/soc/dashboard/layout-utils';
import {
  editArrangement,
  gridToolbarVariant,
  FULL_TOOLBAR_MIN_WIDTH,
  NARROW_EDIT_HYSTERESIS,
  NARROW_EDIT_MAX_WIDTH,
} from '@/soc/dashboard/WidgetGrid';
import { toastClearance, TOAST_ZONE_PX } from '@/soc/hooks/useToastClearance';

function wg(i: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): DashboardWidget {
  return { i, type: 'kpi.needs_human', x, y, w, h, options: {}, ...extra } as unknown as DashboardWidget;
}

/** Reading order as widget ids. */
function orderIds(widgets: readonly DashboardWidget[]): string[] {
  return readingOrder(widgets).map((i) => widgetId(widgets[i]));
}

function geometry(w: DashboardWidget) {
  const { x, y, w: width, h } = widgetToItem(w);
  return { x, y, w: width, h };
}

function overlaps(widgets: readonly DashboardWidget[]): boolean {
  const r = widgets.map(geometry);
  return r.some((a, i) => r.some((b, j) => i < j && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y));
}

function deepSame(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  return a.w === b.w && a.h === b.h;
}

function swapped(ids: string[], at: number, to: number): string[] {
  const next = ids.slice();
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

describe('edit arrangement by board width', () => {
  it('is one column under 640 px and the grid from 640 px, the grid while the width is unknown', () => {
    expect(NARROW_EDIT_MAX_WIDTH).toBe(640);
    expect(editArrangement(358)).toBe('list'); // a 390 px phone
    expect(editArrangement(288)).toBe('list'); // a 320 px phone
    expect(editArrangement(480)).toBe('list'); // a 768 px tablet beside the docked rail
    expect(editArrangement(639)).toBe('list');
    expect(editArrangement(640)).toBe('grid');
    expect(editArrangement(1152)).toBe('grid');
    expect(editArrangement(null)).toBe('grid');
    expect(editArrangement(0)).toBe('grid');
  });

  it('keeps the list until the board is 24 px wider, so a scrollbar cannot flip it back', () => {
    expect(NARROW_EDIT_HYSTERESIS).toBe(24);
    // From the grid (or from nothing yet), the cut is 640 px.
    expect(editArrangement(639, 'grid')).toBe('list');
    expect(editArrangement(640, 'grid')).toBe('grid');
    expect(editArrangement(650, null)).toBe('grid');
    // In the list, the board stays there until 664 px.
    expect(editArrangement(645, 'list')).toBe('list'); // the list's width without a scrollbar
    expect(editArrangement(650, 'list')).toBe('list');
    expect(editArrangement(663, 'list')).toBe('list');
    expect(editArrangement(664, 'list')).toBe('grid');
    expect(editArrangement(665, 'list')).toBe('grid');
    // The grid, with a classic scrollbar, measured 632 px: the list; and the list then
    // measures 645 px without the scrollbar and stays the list.
    expect(editArrangement(632, 'grid')).toBe('list');
    expect(editArrangement(645, editArrangement(632, 'grid'))).toBe('list');
    // An unknown width keeps what there is.
    expect(editArrangement(null, 'list')).toBe('list');
    expect(editArrangement(0, 'list')).toBe('list');
    expect(editArrangement(null, 'grid')).toBe('grid');
  });

  it('sizes a cell the way the edit grid does', () => {
    // The live measurements of the finding: 109 px on a 358 px board, 373 px on 1152 px.
    expect(Math.round(gridCellWidth(4, 358))).toBe(109);
    expect(Math.round(gridCellWidth(4, 1152))).toBe(373);
    expect(Math.round(gridCellWidth(12, 1152))).toBe(1152);
    expect(Math.round(gridCellWidth(8, 1152))).toBe(763);
  });

  it('gives a cell narrower than the whole toolbar the compact toolbar', () => {
    const quarter = wg('q', 8, 3, 4, 6);
    const twoThirds = wg('t', 0, 3, 8, 6);
    expect(FULL_TOOLBAR_MIN_WIDTH).toBe(248);
    expect(gridToolbarVariant(quarter, 1152)).toBe('grid'); // 373 px at 1440
    expect(gridToolbarVariant(quarter, 736)).toBe('compact'); // 235 px at 1024
    expect(gridToolbarVariant(quarter, 652)).toBe('compact'); // 207 px at 940
    expect(gridToolbarVariant(twoThirds, 652)).toBe('grid');
    expect(gridToolbarVariant(quarter, null)).toBe('grid');
    expect(gridToolbarVariant(quarter, 0)).toBe('grid');
  });
});

describe('reading order and the edit geometry', () => {
  it('reads top to bottom, then left to right', () => {
    const widgets = [wg('c', 0, 6, 12, 2), wg('b', 8, 0, 4, 6), wg('a', 0, 0, 8, 6)];
    expect(orderIds(widgets)).toEqual(['a', 'b', 'c']);
  });

  it('repairs overlaps and compacts, idempotently, in the input order', () => {
    const widgets = [wg('a', 0, 0, 12, 3), wg('copy', 0, 1, 12, 3), wg('b', 0, 10, 12, 2)];
    const once = editGeometry(widgets);
    expect(once.map(widgetId)).toEqual(['a', 'copy', 'b']);
    expect(overlaps(once)).toBe(false);
    expect(once.map((w) => geometry(w).y)).toEqual([0, 3, 6]);
    expect(editGeometry(once)).toEqual(once);
    expect(compactVertically(once)).toEqual(once);
  });
});

/** A deterministic pseudo-random sequence (a linear congruential generator). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A random board of 2 to 12 widgets of any size anywhere, in Edit mode's geometry. With
 * `minimums`, about a third of the widgets cannot shrink below their size.
 */
function randomBoard(seed: number, minimums = false): DashboardWidget[] {
  const next = random(seed);
  const pick = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const count = pick(2, 12);
  return editGeometry(
    Array.from({ length: count }, (_, i) => {
      const w = pick(1, 12);
      const h = pick(1, 8);
      const fixed = minimums && next() < 0.34 ? { minW: w, minH: h } : {};
      return wg(`r${i}`, pick(0, GRID_COLS - w), pick(0, 30), w, h, fixed);
    }),
  );
}

/** Whether any widget of `widgets` has a minimum width or height. */
function hasMinimums(widgets: readonly DashboardWidget[]): boolean {
  return widgets.some((w) => widgetToItem(w).minW != null || widgetToItem(w).minH != null);
}

/** Every move of every widget on `base`, against the invariants the list relies on. */
function expectEveryMoveSound(base: readonly DashboardWidget[], label: string) {
  const ids = orderIds(base);
  ids.forEach((id, at) => {
    for (const [dir, to] of [['up', at - 1], ['down', at + 1]] as const) {
      const move = `${label}: ${id} ${dir}`;
      const next = reorderWidget(base, id, dir);
      expect(next.map(widgetId), `${move} keeps the input order`).toEqual(base.map(widgetId));
      if (to < 0 || to >= ids.length) {
        expect(next, `${move} at the end`).toEqual(base);
        continue;
      }
      // Exactly the two neighbours swap places in the reading order.
      expect(orderIds(next), move).toEqual(swapped(ids, at, to));
      // Every other widget keeps its own width and height. The pair keeps both sizes, or
      // trades them: each takes the other's, grown to its own minimum where that is larger.
      const pair = new Set([ids[at], ids[to]]);
      const indexOf = (id: string) => base.findIndex((w) => widgetId(w) === id);
      const size = (w: DashboardWidget) => ({ w: geometry(w).w, h: geometry(w).h });
      base.forEach((w, i) => {
        if (!pair.has(widgetId(w))) expect(size(next[i]), `${move}: size of ${widgetId(w)}`).toEqual(size(w));
      });
      const [a, b] = [indexOf(ids[at]), indexOf(ids[to])];
      const kept = deepSame(size(next[a]), size(base[a])) && deepSame(size(next[b]), size(base[b]));
      if (!kept) {
        const grown = (own: DashboardWidget, other: DashboardWidget) => ({
          w: Math.max(size(other).w, widgetToItem(own).minW ?? 1),
          h: Math.max(size(other).h, widgetToItem(own).minH ?? 1),
        });
        expect(size(next[a]), `${move}: ${ids[at]} takes the other's size`).toEqual(grown(base[a], base[b]));
        expect(size(next[b]), `${move}: ${ids[to]} takes the other's size`).toEqual(grown(base[b], base[a]));
      }
      // Without minimum sizes in the way, a move never opens a gap on a wider screen.
      if (!hasMinimums(base)) expect(layoutGaps(next), `${move} opens a gap`).toBeLessThanOrEqual(layoutGaps(base));
      expect(overlaps(next), `${move} overlaps`).toBe(false);
      for (const w of next) expect(geometry(w).x + geometry(w).w, `${move} inside the grid`).toBeLessThanOrEqual(GRID_COLS);
      // Already Edit mode's geometry: the grid's compaction changes nothing, so a wider
      // screen reads the board in the same order.
      expect(editGeometry(next).map(geometry), `${move} is settled`).toEqual(next.map(geometry));
      // The widgets before the pair stay where they are.
      const before = new Set(ids.slice(0, Math.min(at, to)));
      base.forEach((w, i) => {
        if (before.has(widgetId(w))) expect(geometry(next[i]), `${move}: ${widgetId(w)} moved`).toEqual(geometry(w));
      });
    }
  });
}

describe('reorderWidget (the one-column list)', () => {
  for (const board of BUILTIN_BOARDS) {
    it(`swaps exactly the two neighbours on ${board.name}, and never opens a gap`, () => {
      const base = editGeometry(board.widgets);
      expect(layoutGaps(base), `${board.name} starts without a gap`).toBe(0);
      expectEveryMoveSound(base, board.name);
      // Any single move keeps the wider layout's shape: no empty cell anywhere.
      for (const id of orderIds(base)) {
        for (const dir of ['up', 'down'] as const) {
          expect(layoutGaps(reorderWidget(base, id, dir)), `${board.name}: ${id} ${dir}`).toBe(0);
        }
      }
    });
  }

  it('holds on random boards of every shape', () => {
    for (let seed = 1; seed <= 150; seed += 1) expectEveryMoveSound(randomBoard(seed), `seed ${seed}`);
  });

  it('holds on random boards with minimum sizes', () => {
    for (let seed = 1; seed <= 150; seed += 1) expectEveryMoveSound(randomBoard(seed, true), `seed ${seed} (minimums)`);
  });

  it('trades places and sizes where keeping both would leave a column empty on a wider screen', () => {
    // SOC operations: Human vs AI (4 x 6, beside Arrivals) down past Needs attention now
    // (8 x 6, below Arrivals). Kept at their sizes, nothing could sit beside Arrivals and
    // the right third of the board would stay empty from there down.
    const base = [
      wg('strip', 0, 0, 12, 3),
      wg('arrivals', 0, 3, 8, 6),
      wg('hva', 8, 3, 4, 6),
      wg('attention', 0, 9, 8, 6),
      wg('workload', 8, 9, 4, 6),
      wg('backlog', 0, 15, 4, 5),
    ];
    const next = reorderWidget(base, 'hva', 'down');
    expect(orderIds(next)).toEqual(['strip', 'arrivals', 'attention', 'hva', 'workload', 'backlog']);
    expect(geometry(next[3])).toEqual({ x: 8, y: 3, w: 4, h: 6 }); // Needs attention, in Human vs AI's place
    expect(geometry(next[2])).toEqual({ x: 0, y: 9, w: 8, h: 6 }); // Human vs AI, in Needs attention's place
    for (const i of [0, 1, 4, 5]) expect(geometry(next[i])).toEqual(geometry(base[i]));
    // No new gap: only the space beside Backlog aging, there before the move, is empty.
    expect(layoutGaps(next)).toBe(layoutGaps(base));
  });

  it('keeps both sizes when the widgets after the pair can make room without a gap', () => {
    // Full-width bands of different heights: no trade is needed, so none happens.
    const base = [wg('a', 0, 0, 12, 3), wg('b', 0, 3, 12, 6), wg('c', 0, 9, 12, 2)];
    const next = reorderWidget(base, 'b', 'up');
    expect(orderIds(next)).toEqual(['b', 'a', 'c']);
    expect(geometry(next[1])).toEqual({ x: 0, y: 0, w: 12, h: 6 });
    expect(geometry(next[0])).toEqual({ x: 0, y: 6, w: 12, h: 3 });
    expect(geometry(next[2])).toEqual(geometry(base[2]));
  });

  it('lets two widgets side by side trade places and keep their sizes', () => {
    const base = [wg('strip', 0, 0, 12, 3), wg('arrivals', 0, 3, 8, 6), wg('hva', 8, 3, 4, 6)];
    const next = reorderWidget(base, 'hva', 'up');
    expect(geometry(next[2])).toEqual({ x: 0, y: 3, w: 4, h: 6 });
    expect(geometry(next[1])).toEqual({ x: 4, y: 3, w: 8, h: 6 });
    expect(geometry(next[0])).toEqual({ x: 0, y: 0, w: 12, h: 3 });
  });

  it('lets two widgets of the same size trade positions, and moves nothing else', () => {
    const base = [wg('a', 0, 0, 6, 4), wg('b', 6, 0, 6, 2), wg('c', 6, 2, 6, 2), wg('d', 0, 4, 12, 2)];
    expect(orderIds(base)).toEqual(['a', 'b', 'c', 'd']);
    const next = reorderWidget(base, 'c', 'up');
    expect(orderIds(next)).toEqual(['a', 'c', 'b', 'd']);
    expect(geometry(next[1])).toEqual({ x: 6, y: 2, w: 6, h: 2 });
    expect(geometry(next[2])).toEqual({ x: 6, y: 0, w: 6, h: 2 });
    expect(geometry(next[0])).toEqual(geometry(base[0]));
    expect(geometry(next[3])).toEqual(geometry(base[3]));
  });

  it('trades a full-width strip and the wider widget below it, so the row beside stays filled', () => {
    // The KPI strip moved below Arrivals. Kept at its 12 columns it would push Human vs AI
    // below it and leave the space beside Arrivals empty: the two trade places and sizes
    // (Arrivals 12 x 3 on top, the strip 8 x 6 beside Human vs AI).
    const base = [wg('strip', 0, 0, 12, 3), wg('arrivals', 0, 3, 8, 6), wg('hva', 8, 3, 4, 6)];
    const next = reorderWidget(base, 'strip', 'down');
    expect(geometry(next[1])).toEqual({ x: 0, y: 0, w: 12, h: 3 });
    expect(geometry(next[0])).toEqual({ x: 0, y: 3, w: 8, h: 6 });
    expect(geometry(next[2])).toEqual(geometry(base[2]));
    expect(orderIds(next)).toEqual(['arrivals', 'strip', 'hva']);
    expect(layoutGaps(next)).toBe(0);
  });

  it('places a moved widget where the compaction cannot lift it back past its neighbour', () => {
    // Q sits under the short B; P is wider and cannot be narrower than 8 columns, so the
    // two cannot trade places. A naive re-pack would put Q beside P, where compaction
    // lifts it under B again and the move would come undone.
    const base = [wg('a', 0, 0, 8, 6), wg('b', 8, 0, 4, 2), wg('q', 8, 2, 4, 4), wg('p', 0, 6, 8, 6, { minW: 8 })];
    expect(orderIds(base)).toEqual(['a', 'b', 'q', 'p']);
    const next = reorderWidget(base, 'p', 'up');
    expect(orderIds(next)).toEqual(['a', 'b', 'p', 'q']);
    expect(orderIds(compactVertically(next))).toEqual(['a', 'b', 'p', 'q']);
    expect(geometry(next[3])).toEqual({ x: 0, y: 6, w: 8, h: 6 });
    expect(geometry(next[2])).toEqual({ x: 0, y: 12, w: 4, h: 4 });
  });

  it('keeps both sizes when a minimum size does not fit the other widget\'s place', () => {
    // The chart cannot be shorter than 4 rows, so it cannot take the strip's 3-row place:
    // both keep their sizes and the widgets after them make room.
    const base = [wg('strip', 0, 0, 12, 3), wg('chart', 0, 3, 8, 6, { minW: 4, minH: 4 }), wg('side', 8, 3, 4, 6), wg('foot', 0, 9, 12, 2)];
    const next = reorderWidget(base, 'chart', 'up');
    expect(geometry(next[1])).toEqual({ x: 0, y: 0, w: 8, h: 6 });
    expect(geometry(next[0])).toEqual({ x: 0, y: 6, w: 12, h: 3 });
    expect(orderIds(next)).toEqual(['chart', 'strip', 'side', 'foot']);
    expect(overlaps(next)).toBe(false);
  });

  it('counts the empty cells a wider screen shows', () => {
    expect(layoutGaps([])).toBe(0);
    expect(layoutGaps([wg('a', 0, 0, 12, 3), wg('b', 0, 3, 8, 6)])).toBe(24);
    expect(layoutGaps([wg('a', 0, 0, 12, 3), wg('b', 0, 3, 8, 6), wg('c', 8, 3, 4, 6)])).toBe(0);
  });

  it('works on a draft that overlaps (a copy dropped on its original)', () => {
    const base = [wg('a', 0, 0, 12, 3), wg('b', 0, 3, 12, 3), wg('copy', 0, 1, 12, 3)];
    expect(orderIds(editGeometry(base))).toEqual(['a', 'copy', 'b']);
    const next = reorderWidget(base, 'copy', 'up');
    expect(orderIds(next)).toEqual(['copy', 'a', 'b']);
    expect(overlaps(next)).toBe(false);
  });

  it('changes nothing for an unknown widget', () => {
    const base = editGeometry([wg('a', 0, 0, 12, 3), wg('b', 0, 3, 12, 3)]);
    expect(reorderWidget(base, 'missing', 'up')).toEqual(base);
  });
});

describe('appendWidget (Add widget and Duplicate in the one-column list)', () => {
  for (const board of BUILTIN_BOARDS) {
    it(`puts a new widget last on ${board.name} and moves no other widget`, () => {
      const base = editGeometry(board.widgets);
      for (const size of [{ w: 4, h: 4 }, { w: 12, h: 3 }, { w: 8, h: 6 }, { w: 1, h: 1 }]) {
        const next = appendWidget(base, wg('new', 0, 0, size.w, size.h));
        expect(orderIds(next)).toEqual([...orderIds(base), 'new']);
        expect(next.slice(0, base.length).map(geometry)).toEqual(base.map(geometry));
        expect(geometry(next[base.length])).toMatchObject(size);
        expect(editGeometry(next).map(geometry), 'compaction keeps it last').toEqual(next.map(geometry));
      }
    });
  }

  it('rests the new widget under the lowest widget, so it cannot rise into a gap above', () => {
    // The last row holds one 4-wide widget on the right; a widget dropped at the left
    // would float up beside it and read before it.
    const base = editGeometry([wg('a', 0, 0, 12, 3), wg('b', 8, 3, 4, 4)]);
    const next = appendWidget(base, wg('new', 0, 0, 6, 2));
    expect(geometry(next[2])).toEqual({ x: 6, y: 7, w: 6, h: 2 });
    expect(orderIds(editGeometry(next))).toEqual(['a', 'b', 'new']);
  });

  it('starts an empty board at the top left', () => {
    expect(appendWidget([], wg('new', 5, 9, 4, 4)).map(geometry)).toEqual([{ x: 0, y: 0, w: 4, h: 4 }]);
  });

  it('reports a widget position in reading order, 1-based', () => {
    const base = [wg('b', 8, 3, 4, 6), wg('a', 0, 0, 12, 3), wg('c', 0, 3, 8, 6)];
    expect(readingPosition(base, 'a')).toEqual({ position: 1, total: 3 });
    expect(readingPosition(base, 'c')).toEqual({ position: 2, total: 3 });
    expect(readingPosition(base, 'b')).toEqual({ position: 3, total: 3 });
    expect(readingPosition(base, 'missing')).toBeNull();
  });
});

describe('toastClearance', () => {
  it('lifts the toasts by the distance from a bar in their band to the viewport edge', () => {
    // The dashboard bar stuck to the bottom at 1440 x 900 (58 px tall).
    expect(toastClearance({ top: 842, bottom: 900, height: 58 }, 900)).toBe(58);
    // Scrolled to the end, with page padding under the bar.
    expect(toastClearance({ top: 800, bottom: 858, height: 58 }, 900)).toBe(100);
    // Two lines on a phone.
    expect(toastClearance({ top: 756, bottom: 844, height: 88 }, 844)).toBe(88);
  });

  it('adds nothing for a bar above the band, off screen, or not laid out', () => {
    expect(toastClearance({ top: 400, bottom: 900 - TOAST_ZONE_PX, height: 58 }, 900)).toBe(0);
    expect(toastClearance({ top: 950, bottom: 1008, height: 58 }, 900)).toBe(0);
    expect(toastClearance({ top: 0, bottom: 0, height: 0 }, 900)).toBe(0);
    expect(toastClearance({ top: 842, bottom: 900, height: 58 }, 0)).toBe(0);
  });
});
