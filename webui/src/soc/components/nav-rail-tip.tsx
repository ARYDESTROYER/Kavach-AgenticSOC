/**
 * The collapsed rail's one tooltip surface (Round 14, SPEC §4.8.1 "One rail tooltip
 * surface").
 *
 * Instead of a Radix tooltip per icon (each with its own timer and exit animation, so two
 * or three overlapped during a sweep), the rail has ONE label that moves to the icon the
 * pointer rests on:
 *   - it shows after 300 ms of pointer REST (any movement restarts the clock), at once on
 *     keyboard `:focus-visible`, never on a press, never while a group flyout is open;
 *   - one timer and one element, so two tooltips can never show at the same time;
 *   - it is decorative (`aria-hidden`): every rail control carries its own name.
 *
 * Content on hover or focus (WCAG 2.2 SC 1.4.13):
 *   - dismissible: Escape hides it without moving the pointer or focus, and it stays
 *     hidden for that control until the pointer leaves it or focus moves on;
 *   - hoverable: the pointer may move onto it (a 100 ms grace and an 8 px bridge carry it
 *     across the gap from the icon), and it stays while the pointer is over it;
 *   - persistent: it stays until the pointer or focus leaves, or Escape dismisses it.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { navStore } from '../nav-store';

export const RAIL_TIP_REST_MS = 300;
/** How long the tooltip waits for the pointer to cross from its icon onto it. */
export const RAIL_TIP_GRACE_MS = 100;

interface Tip {
  id: string | null;
  label: string;
  detail: string;
  top: number;
}

const HIDDEN: Tip = { id: null, label: '', detail: '', top: 0 };
let tip: Tip = HIDDEN;
let timer: number | null = null;
let grace: number | null = null;
/** The control whose tooltip Escape dismissed: not again until the pointer leaves it or focus moves. */
let dismissed: string | null = null;
const listeners = new Set<() => void>();

function set(next: Tip): void {
  if (next.id === tip.id && next.top === tip.top && next.label === tip.label && next.detail === tip.detail) return;
  tip = next;
  listeners.forEach((listener) => listener());
}

function clearTimer(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

function clearGrace(): void {
  if (grace !== null) window.clearTimeout(grace);
  grace = null;
}

/** Hide the tooltip now (a press, a flyout opening, the drawer opening). */
export function hideRailTip(): void {
  clearTimer();
  clearGrace();
  set(HIDDEN);
}

/** Hide the tooltip after the grace period, unless the pointer reaches it or its icon first. */
function hideSoon(): void {
  clearGrace();
  grace = window.setTimeout(() => {
    grace = null;
    set(HIDDEN);
  }, RAIL_TIP_GRACE_MS);
}

/**
 * Escape: dismiss the tooltip that is showing (WCAG 1.4.13). Returns whether one was
 * dismissed, so the caller consumes the key only then.
 */
export function dismissRailTip(): boolean {
  if (!tip.id) return false;
  dismissed = tip.id;
  hideRailTip();
  return true;
}

function show(id: string, el: HTMLElement, label: string, detail: string): void {
  // One surface at a time: a group flyout already names its group.
  if (navStore.getState().flyout !== null || dismissed === id) return;
  clearGrace();
  const rect = el.getBoundingClientRect();
  set({ id, label, detail, top: rect.top + rect.height / 2 });
}

/**
 * Pointer and focus handlers for one rail control; `enabled` false (the labelled drawer,
 * a grouped icon whose flyout names it) returns no handlers.
 */
export function railTipHandlers(id: string, label: string, detail: string, enabled: boolean) {
  if (!enabled) return {};
  return {
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (dismissed === id) return;
      if (tip.id === id) {
        // Back on the icon from the tooltip: keep it.
        clearGrace();
        return;
      }
      const el = event.currentTarget;
      clearTimer();
      if (tip.id) hideRailTip();
      timer = window.setTimeout(() => show(id, el, label, detail), RAIL_TIP_REST_MS);
    },
    onPointerLeave: () => {
      clearTimer();
      if (dismissed === id) dismissed = null;
      // The pointer may be on its way onto the tooltip (it is hoverable).
      if (tip.id === id) hideSoon();
    },
    onPointerDown: hideRailTip,
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(':focus-visible')) show(id, event.currentTarget, label, detail);
    },
    onBlur: () => {
      if (dismissed === id) dismissed = null;
      if (tip.id === id) hideRailTip();
    },
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => tip;

/** The single tooltip element, 8 px past the 64 px rail. */
export function RailTipLayer() {
  const current = React.useSyncExternalStore(subscribe, read, read);
  const shown = current.id !== null;

  // Escape dismisses the tooltip wherever focus is (it is the topmost layer while shown).
  // Capture phase, like a Radix layer, so a handler below cannot swallow it first; the key
  // is consumed only when a tooltip was actually dismissed.
  React.useEffect(() => {
    if (!shown) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && dismissRailTip()) event.preventDefault();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [shown]);

  if (!current.id) return null;
  return (
    <div
      aria-hidden
      data-testid="nav-rail-tip"
      key={current.id}
      style={{ top: current.top }}
      onPointerEnter={clearGrace}
      onPointerLeave={hideSoon}
      className={cn(
        // `pointer-events-auto`: the navigation around it passes the pointer through.
        'nav-tip pointer-events-auto fixed left-[4.5rem] z-[70] max-w-xs rounded-lg border border-border bg-popover px-2.5 py-1.5',
        'text-xs leading-snug text-popover-foreground shadow-overlay',
        // An 8 px bridge back to the rail, so the pointer can cross onto the tooltip.
        "before:absolute before:-left-2 before:top-0 before:h-full before:w-2 before:content-['']",
      )}
    >
      {current.label}
      {current.detail ? <span className="block text-muted-foreground">{current.detail}</span> : null}
    </div>
  );
}

/** Test seam. */
export function resetRailTip(): void {
  clearTimer();
  clearGrace();
  dismissed = null;
  tip = HIDDEN;
}
