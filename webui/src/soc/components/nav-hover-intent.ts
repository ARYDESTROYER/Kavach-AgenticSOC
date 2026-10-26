/**
 * Hover intent for the collapsed rail's group flyouts (Round 14, SPEC §4.8.1 "Flyouts").
 *
 * - A flyout opens only when the pointer has RESTED on a grouped icon for 300 ms (rest,
 *   not dwell: a move of more than 3 px restarts the clock), so sweeping down the rail on
 *   the way to Settings opens nothing. Once one is open, a neighbour opens after 120 ms.
 * - It closes 400 ms after the pointer has left both the icon and the flyout. While the
 *   pointer travels from the icon toward the flyout it is inside a safe triangle (the
 *   point where it left the icon and the flyout's near edge), so a neighbour icon crossed
 *   on the way never steals the flyout.
 * - Keyboard `:focus-visible` opens at once; a pointer focus never does, and the press
 *   that navigates suppresses the flyout until the pointer leaves the icon (no flash).
 *
 * One controller for the whole rail (one open flyout at a time); the open flyout itself
 * lives in the navigation store so only the navigation re-renders. References: NN/g
 * "Timing exposing content", Floating UI `useHover({ restMs })` and `safePolygon`.
 */
import { navStore } from '../nav-store';

export const NAV_REST_MS = 300;
export const NAV_SWITCH_REST_MS = 120;
export const NAV_GRACE_MS = 400;
const REST_SLOP_PX = 3;

export interface Point {
  x: number;
  y: number;
}

/** Is `p` inside the triangle a-b-c (edges included)? A point without coordinates never is. */
export function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  if (![p.x, p.y].every(Number.isFinite)) return false;
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/** The safe triangle from a leave point to the flyout's near (left) edge, padded 4 px. */
export function safeTriangle(from: Point, panel: Pick<DOMRect, 'left' | 'top' | 'bottom'>): (p: Point) => boolean {
  const a = { x: from.x - 4, y: from.y };
  const b = { x: panel.left + 2, y: panel.top - 4 };
  const c = { x: panel.left + 2, y: panel.bottom + 4 };
  return (p) => pointInTriangle(p, a, b, c);
}

let openTimer: number | null = null;
let closeTimer: number | null = null;
let anchorId: string | null = null;
let anchor: Point | null = null;
let last: Point | null = null;
/** A trigger whose flyout must not open: after a press (until the pointer leaves) or after
 *  focus was handed back to it (until focus leaves). */
let suppressed: { id: string; by: 'pointer' | 'focus' } | null = null;
let safe: ((p: Point) => boolean) | null = null;
let panel: HTMLElement | null = null;
const triggers = new Map<string, HTMLElement>();

const flyoutId = () => navStore.getState().flyout;

function clearOpen(): void {
  if (openTimer !== null) window.clearTimeout(openTimer);
  openTimer = null;
}

function clearClose(): void {
  if (closeTimer !== null) window.clearTimeout(closeTimer);
  closeTimer = null;
}

/** Open `id`'s flyout now, aligned to its trigger. */
export function openFlyout(id: string): void {
  clearOpen();
  clearClose();
  safe = null;
  navStore.setFlyout(id, triggers.get(id)?.getBoundingClientRect().top ?? 0);
}

/** Close the open flyout now (Escape, a press elsewhere, focus leaving it). */
export function closeFlyout(): void {
  clearOpen();
  clearClose();
  safe = null;
  if (flyoutId() !== null) navStore.setFlyout(null);
}

function armClose(): void {
  clearClose();
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    safe = null;
    navStore.setFlyout(null);
  }, NAV_GRACE_MS);
}

/** Remember a grouped icon's element (for the flyout's position). */
export function registerTrigger(id: string, el: HTMLElement | null): void {
  if (el) triggers.set(id, el);
  else triggers.delete(id);
}

/** Remember the open flyout's element (for the safe triangle). */
export function registerPanel(el: HTMLElement | null): void {
  panel = el;
}

/** The pointer moved over a grouped icon: (re)start the rest clock. */
export function pointerOverTrigger(id: string, p: Point): void {
  last = p;
  const open = flyoutId();
  if (open === id) {
    clearClose();
    return;
  }
  if (suppressed?.id === id) return;
  const moved = anchorId !== id || !anchor || Math.hypot(p.x - anchor.x, p.y - anchor.y) > REST_SLOP_PX;
  if (!moved && openTimer !== null) return;
  anchorId = id;
  anchor = p;
  clearOpen();
  openTimer = window.setTimeout(function fire() {
    openTimer = null;
    const shown = flyoutId();
    // Travelling toward the open flyout: never steal it, look again shortly.
    if (shown && shown !== id && safe && last && safe(last)) {
      openTimer = window.setTimeout(fire, NAV_SWITCH_REST_MS);
      return;
    }
    openFlyout(id);
  }, open ? NAV_SWITCH_REST_MS : NAV_REST_MS);
}

/** The pointer left a grouped icon. */
export function pointerLeftTrigger(id: string, p: Point): void {
  last = p;
  if (anchorId === id) {
    clearOpen();
    anchorId = null;
    anchor = null;
  }
  if (suppressed?.id === id && suppressed.by === 'pointer') suppressed = null;
  if (flyoutId() === id) {
    const rect = panel?.getBoundingClientRect();
    safe = rect ? safeTriangle(p, rect) : null;
    armClose();
  }
}

/** Track the pointer while a flyout is open (the safe triangle reads it). */
export function pointerTrack(p: Point): void {
  last = p;
}

export function pointerEnterPanel(): void {
  clearClose();
  safe = null;
}

export function pointerLeavePanel(p: Point): void {
  last = p;
  armClose();
}

/** Keyboard focus-visible on a grouped icon opens its flyout at once. */
export function keyboardOpen(id: string): void {
  if (suppressed?.id === id) return;
  openFlyout(id);
}

/** A pointer press on a grouped icon navigates: no flyout until the pointer leaves. */
export function suppressAfterPress(id: string): void {
  suppressed = { id, by: 'pointer' };
  closeFlyout();
}

/** Focus handed back to a trigger (Escape, ArrowLeft): do not reopen until focus leaves. */
export function suppressFocusReopen(id: string): void {
  suppressed = { id, by: 'focus' };
}

/** Focus left a trigger: a focus hand-back suppression ends (a pointer one does not). */
export function endFocusSuppression(id: string): void {
  if (suppressed?.id === id && suppressed.by === 'focus') suppressed = null;
}

/** Test seam: forget every timer and element. */
export function resetNavHoverIntent(): void {
  clearOpen();
  clearClose();
  anchorId = null;
  anchor = null;
  last = null;
  suppressed = null;
  safe = null;
  panel = null;
  triggers.clear();
}
