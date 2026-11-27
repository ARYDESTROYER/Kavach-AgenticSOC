/**
 * Top bar fold (top-bar-fold.ts): labels fold by what is actually in the bar.
 *
 * Live tour, 1280 with the rail pinned and every chip present (a source notice, "Enable
 * updates", "State store unreachable", "Christopher Richardson", "Agent effectiveness"):
 * the width tiers kept every label, so the search field squeezed to 26px and its shortcut
 * hint drew over the bell. These specs model the bar's geometry (jsdom has no layout) and
 * pin the order labels fold in, that the decision never depends on the current fold (so
 * it cannot oscillate), and that the hook follows resizes and content changes.
 */
import * as React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import {
  TOP_BAR_FOLD_ATTRIBUTE,
  TOP_BAR_FOLD_HIDDEN,
  TOP_BAR_FOLD_ORDER,
  TOP_BAR_SEARCH_MIN_REM,
  measureTopBarSearchRoom,
  resolveTopBarFold,
  useTopBarFold,
  type TopBarFoldItem,
} from '../top-bar-fold';

const MIN = TOP_BAR_SEARCH_MIN_REM * 16;

/** Room the field gets when each listed item has folded, saving the given widths. */
function roomModel(base: number, savings: Partial<Record<TopBarFoldItem, number>>) {
  const calls: string[] = [];
  const measure = (folded: readonly TopBarFoldItem[]) => {
    calls.push(folded.join(' '));
    return base + folded.reduce((sum, item) => sum + (savings[item] ?? 0), 0);
  };
  return { measure, calls };
}

describe('resolveTopBarFold', () => {
  it('folds nothing while the field keeps 11rem', () => {
    const { measure, calls } = roomModel(MIN, { account: 150 });
    expect(resolveTopBarFold(measure, MIN)).toEqual([]);
    expect(calls).toEqual(['']);
  });

  it('folds the fewest items, least important first, until the field has its room', () => {
    // The live worst case at 1280: 26px of room. Product (absent below 72rem) saves
    // nothing, the account name 165px; that is not enough, the source label 50px is.
    const { measure } = roomModel(26, { product: 0, account: 120, source: 40, update: 100 });
    expect(resolveTopBarFold(measure, MIN)).toEqual(['product', 'account', 'source']);
  });

  it('keeps the order: health and the demo chip are the last words to go', () => {
    expect(TOP_BAR_FOLD_ORDER).toEqual(['product', 'account', 'source', 'update', 'health', 'demo']);
    const { measure } = roomModel(0, { health: 100, demo: 100 });
    expect(resolveTopBarFold(measure, MIN)).toEqual([...TOP_BAR_FOLD_ORDER]);
  });

  it('folds nothing while the wide field is not shown (the width tiers own that bar)', () => {
    expect(resolveTopBarFold(() => null, MIN)).toEqual([]);
  });

  it('decides from the labelled widths every time, never from the fold it is in', () => {
    // Called twice in a row it starts from no fold and lands on the same answer, so
    // applying a fold can never flip the next decision back.
    const model = roomModel(100, { product: 0, account: 90 });
    const first = resolveTopBarFold(model.measure, MIN);
    const second = resolveTopBarFold(model.measure, MIN);
    expect(first).toEqual(['product', 'account']);
    expect(second).toEqual(first);
    expect(model.calls.filter((call) => call === '')).toHaveLength(2);
  });
});

describe('TOP_BAR_FOLD_HIDDEN', () => {
  it('is a literal, bar-scoped class per item', () => {
    for (const item of TOP_BAR_FOLD_ORDER) {
      expect(TOP_BAR_FOLD_HIDDEN[item]).toBe(`group-data-[fold~=${item}]/topbar:hidden`);
    }
  });
});

/**
 * A modelled bar: 24px of padding a side, 12px gaps, a 120px page name, and a cluster
 * whose width depends on which labels the bar's `data-fold` hides, as the CSS would.
 */
function modelBar(options: { width: number; labels: Partial<Record<TopBarFoldItem, number>> }) {
  const header = document.createElement('header');
  header.style.paddingLeft = '24px';
  header.style.paddingRight = '24px';
  header.style.columnGap = '12px';
  let width = options.width;
  Object.defineProperty(header, 'clientWidth', { configurable: true, get: () => width });
  const nav = document.createElement('nav');
  const search = document.createElement('button');
  const cluster = document.createElement('div');
  const sr = document.createElement('span');
  sr.style.position = 'absolute';
  const rect = (w: number) => DOMRect.fromRect({ width: w, height: 28 });
  nav.getBoundingClientRect = () => rect(120);
  search.getBoundingClientRect = () => rect(999);
  let labels = { ...options.labels };
  cluster.getBoundingClientRect = () => {
    const folded = (header.getAttribute(TOP_BAR_FOLD_ATTRIBUTE) ?? '').split(' ');
    const shown = Object.entries(labels)
      .filter(([item]) => !folded.includes(item))
      .reduce((sum, [, w]) => sum + (w ?? 0), 0);
    return rect(300 + shown);
  };
  header.append(sr, nav, search, cluster);
  document.body.append(header);
  return {
    header,
    search,
    cluster,
    setWidth: (next: number) => {
      width = next;
    },
    setLabels: (next: Partial<Record<TopBarFoldItem, number>>) => {
      labels = { ...next };
    },
    cleanup: () => header.remove(),
  };
}

describe('measureTopBarSearchRoom', () => {
  it('is the content width less every other in-flow item and the gaps', () => {
    const bar = modelBar({ width: 1000, labels: { account: 100 } });
    // 1000 - 48 padding - 120 nav - 400 cluster - 2 x 12 gaps (the sr-only span is out of flow).
    expect(measureTopBarSearchRoom(bar.header, bar.search)).toBe(408);
    bar.cleanup();
  });

  it('reports the true deficit of a bar that already overflows', () => {
    const bar = modelBar({ width: 600, labels: { account: 200 } });
    expect(measureTopBarSearchRoom(bar.header, bar.search)).toBe(600 - 48 - 120 - 500 - 24);
    bar.cleanup();
  });

  it('is null without layout or while the wide field is hidden', () => {
    const bar = modelBar({ width: 0, labels: {} });
    expect(measureTopBarSearchRoom(bar.header, bar.search)).toBeNull();
    bar.setWidth(1000);
    bar.search.style.display = 'none';
    expect(measureTopBarSearchRoom(bar.header, bar.search)).toBeNull();
    bar.cleanup();
  });
});

function Harness({ header, search }: { header: HTMLElement; search: HTMLElement }) {
  const headerRef = React.useRef<HTMLElement>(header);
  const searchRef = React.useRef<HTMLElement>(search);
  useTopBarFold(headerRef, searchRef);
  return null;
}

describe('useTopBarFold', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('folds before first paint, follows resizes and content changes, and cleans up', async () => {
    let resize: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // 1040 - 48 padding - 120 nav - 24 gaps = 848 for the field and the cluster, and the
    // cluster is 300 plus whatever labels show.
    const bar = modelBar({ width: 1040, labels: { account: 165, source: 50, update: 100, health: 150 } });
    const view = render(<Harness header={bar.header} search={bar.search} />);
    // 848 - 765 = 83px of room: folding the account name (165) is enough.
    expect(bar.header.getAttribute(TOP_BAR_FOLD_ATTRIBUTE)).toBe('product account');

    // A wider bar: everything fits again and the attribute goes.
    bar.setWidth(1400);
    act(() => resize?.([], {} as ResizeObserver));
    expect(bar.header.hasAttribute(TOP_BAR_FOLD_ATTRIBUTE)).toBe(false);

    // A narrower bar: the source and update labels fold too, health stays.
    bar.setWidth(900);
    act(() => resize?.([], {} as ResizeObserver));
    expect(bar.header.getAttribute(TOP_BAR_FOLD_ATTRIBUTE)).toBe('product account source update');

    // A content change without a resize (a label shrinks): the MutationObserver refits.
    bar.setLabels({ account: 40, health: 60 });
    await act(async () => {
      bar.cluster.textContent = 'Healthy';
      await Promise.resolve();
    });
    expect(bar.header.hasAttribute(TOP_BAR_FOLD_ATTRIBUTE)).toBe(false);

    view.unmount();
    expect(bar.header.hasAttribute(TOP_BAR_FOLD_ATTRIBUTE)).toBe(false);
    bar.cleanup();
  });

  it('never refits on its own attribute, so applying a fold cannot loop', async () => {
    const bar = modelBar({ width: 1040, labels: { account: 400 } });
    const measured = vi.spyOn(bar.cluster, 'getBoundingClientRect');
    const view = render(<Harness header={bar.header} search={bar.search} />);
    expect(bar.header.getAttribute(TOP_BAR_FOLD_ATTRIBUTE)).toBe('product account');
    const after = measured.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    // Writing the fold attribute queued no mutation the hook listens to.
    await act(async () => {
      await Promise.resolve();
    });
    expect(measured.mock.calls.length).toBe(after);
    view.unmount();
    bar.cleanup();
  });
});
