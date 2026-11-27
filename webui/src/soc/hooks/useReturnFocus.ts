/**
 * useReturnFocus: hand keyboard focus back to whatever opened a controlled sheet or
 * dialog (Round 14, SPEC §3.3: "Esc closes the topmost layer and returns focus to the
 * element that opened it").
 *
 * A Radix dialog returns focus on close only to its own `Dialog.Trigger`. A sheet or
 * dialog opened from state (a row click, a row menu item, a button outside its root) has
 * none, so Radix sends focus to `<body>` and a keyboard or screen-reader user loses their
 * place in the list.
 *
 * Call `remember()` in the handler that opens the layer (or pass the opener, or a finder
 * that locates it when the layer closes), then wire `onCloseAutoFocus` into the
 * `SheetContent` or `DialogContent`. `ref` is a ref-shaped view of the same opener for
 * `ConfirmDialog returnFocusRef`.
 *
 * A row menu item unmounts with its menu, so an opener inside a `role="menu"` resolves to
 * the menu's trigger (Radix labels the menu by its trigger).
 *
 * A confirmed delete takes the opener off the page with its row. `remember(target,
 * fallback)` names where focus goes then: `peers` lists the same control in every row (in
 * order), so focus lands on the row that took the deleted one's place, else the last row
 * left, else `empty` (the list's heading). Without a fallback, an opener that has left the
 * page keeps Radix's default.
 *
 * When the list reloads only after the layer has closed (focus already went back to the
 * opener, and the opener then leaves with its row), call `expectRemoval()` when the
 * removal is confirmed: once the opener leaves the page, focus that fell to `<body>`
 * moves to the fallback. Focus the reader has since moved elsewhere is never taken.
 */
import * as React from 'react';

type Finder = () => HTMLElement | null | undefined;
type OpenerTarget = HTMLElement | null | undefined | Finder;

/** Where focus goes when the opener has left the page with its row. */
export interface ReturnFocusFallback {
  /** The opener's peers: the same control in every row, in list order. */
  peers?: () => Iterable<Element> | ArrayLike<Element>;
  /** The last resort when no peer is left (the list's heading or panel). */
  empty?: Finder;
}

export interface ReturnFocus {
  /**
   * Record the opener: an element, a finder run at close time, or (no argument) the
   * focused element. `fallback` says where focus goes if the opener has left the page.
   */
  remember: (target?: OpenerTarget, fallback?: ReturnFocusFallback) => void;
  /** Wire into `onCloseAutoFocus`: focuses the opener (or its fallback) when it can. */
  onCloseAutoFocus: (event: Event) => void;
  /** The opener (or its fallback) as a ref; `null` when neither is on the page. */
  ref: React.RefObject<HTMLElement | null>;
  /**
   * The removal of the opener's row is confirmed but lands after the layer closes (the
   * list reloads). Once the opener leaves the page, focus that fell to `<body>` moves to
   * the fallback. The watch ends then, on the next `remember`, on unmount or after a while.
   */
  expectRemoval: () => void;
}

/** How long `expectRemoval` waits for the row to leave (a slow API and reload included). */
export const REMOVAL_WATCH_MS = 30_000;

/** The element that opened a layer, given the focused element at that moment. */
export function openerFromElement(element: Element | null | undefined): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  const menu = element.closest('[role="menu"]');
  if (menu) {
    // A menu item leaves with its menu: hand focus to the button that opened the menu.
    const id = menu.getAttribute('aria-labelledby');
    const trigger = id ? document.getElementById(id) : null;
    return trigger instanceof HTMLElement ? trigger : null;
  }
  return element;
}

/**
 * A list's heading inside its panel, else the panel itself: the `empty` fallback when no
 * row is left to take focus.
 */
export function headingOf(container: HTMLElement | null | undefined): HTMLElement | null {
  if (!container) return null;
  return container.querySelector<HTMLElement>('h1, h2, h3') ?? container;
}

function connected(element: HTMLElement | null | undefined): HTMLElement | null {
  return element && element.isConnected ? element : null;
}

function listOf(peers: ReturnFocusFallback['peers']): HTMLElement[] {
  if (!peers) return [];
  return Array.from(peers()).filter((el): el is HTMLElement => el instanceof HTMLElement);
}

/** Focus an element; a heading or panel that is not focusable becomes a script-only stop. */
function focusElement(element: HTMLElement): void {
  if (element.tabIndex < 0 && !element.hasAttribute('tabindex')) {
    element.setAttribute('tabindex', '-1');
  }
  element.focus();
}

/** Focus was lost: nothing, or the page body, holds it. */
function focusDropped(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

interface Memory {
  finder: Finder;
  fallback: ReturnFocusFallback | null;
  /** The opener's place among its peers when it was remembered (-1: not among them). */
  index: number;
}

function resolveFallback(memory: Memory, opener: HTMLElement | null): HTMLElement | null {
  const fallback = memory.fallback;
  if (!fallback) return null;
  const peers = listOf(fallback.peers).filter((el) => el.isConnected && el !== opener);
  if (peers.length) {
    // The row below moved up into the deleted row's place; at the end, take the last one.
    return peers[Math.min(Math.max(memory.index, 0), peers.length - 1)];
  }
  return connected(fallback.empty?.());
}

/** The opener when it is still on the page, else its fallback. */
function resolveMemory(memory: Memory | null): HTMLElement | null {
  if (!memory) return null;
  const opener = memory.finder() ?? null;
  return connected(opener) ?? resolveFallback(memory, opener);
}

export function useReturnFocus(): ReturnFocus {
  const memory = React.useRef<Memory | null>(null);
  const watch = React.useRef<{ stop: () => void } | null>(null);

  const stopWatching = React.useCallback(() => {
    watch.current?.stop();
    watch.current = null;
  }, []);

  React.useEffect(() => stopWatching, [stopWatching]);

  const remember = React.useCallback(
    (target?: OpenerTarget, fallback?: ReturnFocusFallback) => {
      stopWatching();
      let finder: Finder | null;
      if (typeof target === 'function') {
        finder = target;
      } else {
        const element =
          target === undefined
            ? openerFromElement(typeof document === 'undefined' ? null : document.activeElement)
            : target;
        finder = element ? () => element : null;
      }
      if (!finder) {
        memory.current = null;
        return;
      }
      const opener = finder() ?? null;
      memory.current = {
        finder,
        fallback: fallback ?? null,
        index: opener && fallback ? listOf(fallback.peers).indexOf(opener) : -1,
      };
    },
    [stopWatching],
  );

  const onCloseAutoFocus = React.useCallback((event: Event) => {
    const target = resolveMemory(memory.current);
    if (!target) return;
    event.preventDefault();
    focusElement(target);
  }, []);

  const ref = React.useMemo<React.RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        const target = resolveMemory(memory.current);
        // A fallback heading must be focusable when a caller focuses it through the ref.
        if (target && target.tabIndex < 0 && !target.hasAttribute('tabindex')) {
          target.setAttribute('tabindex', '-1');
        }
        return target;
      },
    }),
    [],
  );

  const expectRemoval = React.useCallback(() => {
    stopWatching();
    const recorded = memory.current;
    if (!recorded || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const opener = recorded.finder() ?? null;
    if (!opener) return;
    const settle = () => {
      if (opener.isConnected) return false;
      // Focus is not taken from wherever the reader has moved it since.
      if (focusDropped()) {
        const target = resolveFallback(recorded, opener);
        if (target) focusElement(target);
      }
      return true;
    };
    if (settle()) return;
    const observer = new MutationObserver(() => {
      if (settle()) stopWatching();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(stopWatching, REMOVAL_WATCH_MS);
    watch.current = {
      stop: () => {
        observer.disconnect();
        window.clearTimeout(timer);
      },
    };
  }, [stopWatching]);

  return React.useMemo(
    () => ({ remember, onCloseAutoFocus, ref, expectRemoval }),
    [remember, onCloseAutoFocus, ref, expectRemoval],
  );
}
