/**
 * Top bar fold: the content-aware half of how the top bar compacts.
 *
 * The bar's container tiers (`TOP_BAR_TIERS` in AppShell) read only the bar's width,
 * never what is in it. That holds for the usual chip set, but the chips vary with state:
 * a source notice, "Enable updates", "State store unreachable" and a long display name
 * can all be present at once, and then at 1280 with the rail pinned the search field was
 * squeezed to 26px with its shortcut hint drawn over the notification bell. A width tier
 * high enough for that worst case would strip every label at 1440 with the rail pinned,
 * where the usual set fits with room to spare.
 *
 * So the bar also measures itself. With every label the tiers allow, it works out the
 * room the search field would get; while that is under `TOP_BAR_SEARCH_MIN_REM`, chip
 * labels fold one at a time in `TOP_BAR_FOLD_ORDER`, least important first, each chip
 * keeping its icon, tooltip and full accessible name. The result is a list on the bar's
 * `data-fold` attribute, read by the literal classes in `TOP_BAR_FOLD_HIDDEN`. The
 * decision is a pure function of the labelled widths, never of the current fold, so it
 * cannot oscillate; it runs before paint (a layout effect, a ResizeObserver on the bar
 * and a MutationObserver on its contents) and never shows an overflowing frame.
 */
import * as React from 'react';

/**
 * Least important first: the product name (the rail carries the logo), the account
 * name (the avatar stays), the source notice, the update action's words, the platform
 * health words, and last the demo chip's words (a safety state).
 */
export const TOP_BAR_FOLD_ORDER = ['product', 'account', 'source', 'update', 'health', 'demo'] as const;

export type TopBarFoldItem = (typeof TOP_BAR_FOLD_ORDER)[number];

/** The search field keeps this much room (11rem) before any chip label folds. */
export const TOP_BAR_SEARCH_MIN_REM = 11;

/** The bar attribute that lists the folded items, space separated. */
export const TOP_BAR_FOLD_ATTRIBUTE = 'data-fold';

/**
 * Hide an element once its item folds. Literal strings, so Tailwind generates them, and
 * scoped to the bar (`group/topbar`): the same chips rendered in the Console controls
 * sheet sit outside the bar and never fold.
 */
export const TOP_BAR_FOLD_HIDDEN: Record<TopBarFoldItem, string> = {
  product: 'group-data-[fold~=product]/topbar:hidden',
  account: 'group-data-[fold~=account]/topbar:hidden',
  source: 'group-data-[fold~=source]/topbar:hidden',
  update: 'group-data-[fold~=update]/topbar:hidden',
  health: 'group-data-[fold~=health]/topbar:hidden',
  demo: 'group-data-[fold~=demo]/topbar:hidden',
};

/**
 * The fewest folds (in order) that leave the search field at least `minPx`. `measure`
 * applies a fold and returns the room the search field would then get, or `null` when
 * the wide field is not shown at all (the container tiers own the bar there).
 */
export function resolveTopBarFold(
  measure: (folded: readonly TopBarFoldItem[]) => number | null,
  minPx: number,
): TopBarFoldItem[] {
  for (let count = 0; count <= TOP_BAR_FOLD_ORDER.length; count += 1) {
    const folded = TOP_BAR_FOLD_ORDER.slice(0, count);
    const room = measure(folded);
    if (room === null) return [];
    if (room >= minPx) return folded;
  }
  return [...TOP_BAR_FOLD_ORDER];
}

const px = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The room the search field gets: the bar's content width less every other in-flow
 * item and the gaps between them. Item widths, not positions, so a bar that already
 * overflows still reports its true deficit. `null` while the bar has no layout or the
 * wide field is hidden.
 */
export function measureTopBarSearchRoom(header: HTMLElement, search: HTMLElement): number | null {
  if (!header.isConnected || header.clientWidth === 0) return null;
  if (getComputedStyle(search).display === 'none') return null;
  const style = getComputedStyle(header);
  const inner = header.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  const gap = px(style.columnGap);
  let used = 0;
  let items = 0;
  for (const child of Array.from(header.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const childStyle = getComputedStyle(child);
    if (childStyle.display === 'none') continue;
    if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
    items += 1;
    if (child !== search) used += child.getBoundingClientRect().width;
  }
  return inner - used - gap * Math.max(0, items - 1);
}

/** Keep the bar's `data-fold` current: on mount, on resize, and when its contents change. */
export function useTopBarFold(
  headerRef: React.RefObject<HTMLElement>,
  searchRef: React.RefObject<HTMLElement>,
): void {
  React.useLayoutEffect(() => {
    const header = headerRef.current;
    const search = searchRef.current;
    if (!header || !search) return undefined;
    let disposed = false;
    const write = (folded: readonly TopBarFoldItem[]) => {
      const value = folded.join(' ');
      if (value) {
        if (header.getAttribute(TOP_BAR_FOLD_ATTRIBUTE) !== value) {
          header.setAttribute(TOP_BAR_FOLD_ATTRIBUTE, value);
        }
      } else if (header.hasAttribute(TOP_BAR_FOLD_ATTRIBUTE)) {
        header.removeAttribute(TOP_BAR_FOLD_ATTRIBUTE);
      }
    };
    const fit = () => {
      if (disposed) return;
      const rootPx = px(getComputedStyle(document.documentElement).fontSize) || 16;
      const folded = resolveTopBarFold((candidate) => {
        write(candidate);
        return measureTopBarSearchRoom(header, search);
      }, TOP_BAR_SEARCH_MIN_REM * rootPx);
      write(folded);
    };
    fit();
    // The bar's own size (window, rail): folding never changes it, so no resize loop.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    resize?.observe(header);
    // What is in the bar: a chip appearing, a label or page name changing. The fold
    // attribute itself is not watched, so applying a fold never re-triggers a fit.
    const contents = typeof MutationObserver === 'undefined' ? null : new MutationObserver(fit);
    contents?.observe(header, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    // A web font arriving changes every label's width without changing the DOM.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', fit);
    void fonts?.ready?.then(fit, () => undefined);
    return () => {
      disposed = true;
      resize?.disconnect();
      contents?.disconnect();
      fonts?.removeEventListener?.('loadingdone', fit);
      write([]);
    };
  }, [headerRef, searchRef]);
}
