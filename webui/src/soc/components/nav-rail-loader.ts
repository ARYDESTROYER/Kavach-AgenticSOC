/**
 * Loads the collapsed rail's interaction layer on first use (Round 14, SPEC §3.4 and
 * §4.8.1). Entry-safe and tiny: it ships with NavSidebar.
 *
 * The flyouts, their hover intent and the one rail tooltip (`nav-rail-interactions.tsx`)
 * are not needed to paint the navigation: nothing can be open, and no pointer can rest
 * on an icon, before the pointer or focus first reaches it. So NavSidebar primes the
 * load from the rail's first `pointermove` or `focus` ({@link railPrimers}) and renders
 * the layer once it arrives ({@link useRailInteractions}).
 *
 * NO WAIT. Once the browser is idle the desktop rail warms the chunk into the HTTP cache
 * ({@link warmRailInteractionsWhenIdle}: a prefetch, never an import, as `lazy-retry.ts`
 * requires), so the first interaction's load is a cache read, well inside the 300 ms rest
 * that shows a tooltip or a flyout.
 *
 * NO LOST FIRST INTERACTION. In case the pointer comes to rest, or keyboard focus lands on
 * an icon, before it does, the primer remembers that control, and once the layer's
 * handlers are attached ({@link replayFirstInteraction}, from NavRail's layout effect,
 * before paint) the event is dispatched to it again, so the rest clock or the keyboard
 * open starts exactly as if the handlers had been there all along. A grouped icon
 * registers itself (its flyout's position) in its own layout effect, which runs before
 * its parent's, so a replayed keyboard open finds it. A control the pointer or focus has
 * already left is forgotten, never replayed.
 *
 * A FAILED LOAD WAITS. It is retried on a later interaction once a pause has passed (5 s,
 * doubling after each further failure, at most a minute), never on every pointer move: a
 * stale tab whose chunk is gone, or a link that is down, sends one request per pause, not
 * one per move. Until then the rail still navigates and toggles, without tooltips or
 * flyouts.
 */
import * as React from 'react';
import { prefetchChunks, retryingLoader } from '../lazy-retry';

type RailInteractions = typeof import('./nav-rail-interactions');

/** Where the layer comes from: its lazy chunk (a test stands in a failing one here). */
export const railLayerSource = { load: () => import('./nav-rail-interactions') };

const newLoader = () => retryingLoader(() => railLayerSource.load());
let load = newLoader();

let loaded: RailInteractions | null = null;
const listeners = new Set<() => void>();

/**
 * Load the rail's interaction layer (once; after a failure the next call tries again, and
 * the primers pace those calls, {@link prime}).
 */
export function loadRailInteractions(): Promise<RailInteractions> {
  return load().then((mod) => {
    if (!loaded) {
      loaded = mod;
      listeners.forEach((listener) => listener());
    }
    return mod;
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => loaded;

/** The rail's interaction layer once it has loaded, else null (re-renders when it lands). */
export function useRailInteractions(): RailInteractions | null {
  return React.useSyncExternalStore(subscribe, read, read);
}

/** The layer's chunks, written in by the build (vite.config.ts `chunkListPlugin`). */
const RAIL_LAYER_CHUNKS = '__CHUNK_LIST:src/soc/components/nav-rail-interactions.tsx__';

/**
 * Prefetch the layer's chunks once the browser is idle, without loading them (nothing
 * runs, nothing re-renders). Returns the cleanup, for an effect. Offline, or in a browser
 * without `requestIdleCallback`, the first interaction loads the chunk instead.
 */
export function warmRailInteractionsWhenIdle(): () => void {
  const idle = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof idle.requestIdleCallback !== 'function') return () => undefined;
  const handle = idle.requestIdleCallback(
    () => {
      if (navigator.onLine !== false) prefetchChunks(RAIL_LAYER_CHUNKS, import.meta.url);
    },
    { timeout: 15_000 },
  );
  return () => idle.cancelIdleCallback?.(handle);
}

/** Close the rail's open flyout and tooltip; nothing can be open before the layer loads. */
export function closeRailSurfaces(): void {
  loaded?.closeSurfaces();
}

/** The control the pointer rests on, or keyboard focus is on, while the layer loads. */
let first: { el: HTMLElement; focus: boolean; x: number; y: number } | null = null;
/** A control pressed (primary button) while the layer loads, with the pointer still on it. */
let pressed: HTMLElement | null = null;

/** The rail control an event belongs to (the brand, the toggle or a destination row). */
const controlOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>('[data-nav-rail-focus]') : null;

/** The first pause after a failed load; it doubles after each further failure. */
export const RAIL_RETRY_PAUSE_MS = 5_000;
const RAIL_RETRY_PAUSE_MAX_MS = 60_000;
/** A load the primers started is in flight (one at a time). */
let priming = false;
/** No load is primed before this time (`Date.now()`), after a failure. */
let retryAt = 0;
let pause = RAIL_RETRY_PAUSE_MS;

/** Start the load, unless it is loaded, in flight, or pausing after a failure. */
function prime(): void {
  if (loaded || priming || Date.now() < retryAt) return;
  priming = true;
  loadRailInteractions().then(
    () => {
      priming = false;
    },
    () => {
      priming = false;
      retryAt = Date.now() + pause;
      pause = Math.min(pause * 2, RAIL_RETRY_PAUSE_MAX_MS);
    },
  );
}

/**
 * The handlers the rail's root carries until the layer has loaded: they start the load
 * and remember the control a first interaction is on (pointer and focus events bubble
 * to the root from every control).
 */
export const railPrimers = {
  onPointerMove(event: React.PointerEvent) {
    const el = controlOf(event.target);
    if (el) first = { el, focus: false, x: event.clientX, y: event.clientY };
    else if (first && !first.focus) first = null;
    prime();
  },
  onPointerOut(event: React.PointerEvent) {
    const el = controlOf(event.target);
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (!el || (next && el.contains(next))) return;
    if (first && !first.focus && first.el === el) first = null;
    if (pressed === el) pressed = null;
  },
  /** A press cancels a pending rest (as the layer's own handlers do) and is replayed too. */
  onPointerDown(event: React.PointerEvent) {
    if (first && !first.focus) first = null;
    const el = controlOf(event.target);
    if (el && event.button === 0) pressed = el;
  },
  onFocus(event: React.FocusEvent) {
    const el = controlOf(event.target);
    first = el ? { el, focus: true, x: 0, y: 0 } : null;
    prime();
  },
  onBlur(event: React.FocusEvent) {
    if (first?.focus && first.el === controlOf(event.target)) first = null;
  },
};

/**
 * Hand the remembered first interaction to the handlers that have just been attached:
 * a press on a grouped icon the pointer has not left keeps its flyout away until the
 * pointer leaves (as a press with the layer loaded does), then the pointer still resting
 * on its control, or the control still holding focus, gets the same event again. Called
 * once the layer's handlers are committed.
 */
export function replayFirstInteraction(): void {
  const press = pressed;
  const record = first;
  pressed = null;
  first = null;
  if (press?.isConnected) loaded?.pressedBeforeLoad(press);
  if (!record || !record.el.isConnected) return;
  if (record.focus) {
    // React's onFocus listens to `focusin`; `:focus-visible` still tells keyboard focus.
    if (document.activeElement === record.el) record.el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    return;
  }
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  record.el.dispatchEvent(new Pointer('pointermove', { bubbles: true, clientX: record.x, clientY: record.y }));
}

/** Test seam: forget the loaded layer, the loader, any failure pause and any remembered interaction. */
export function resetRailInteractions(): void {
  load = newLoader();
  loaded = null;
  priming = false;
  retryAt = 0;
  pause = RAIL_RETRY_PAUSE_MS;
  first = null;
  pressed = null;
}
