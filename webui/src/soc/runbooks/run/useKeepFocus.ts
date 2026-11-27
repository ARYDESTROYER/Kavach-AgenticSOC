/**
 * Keeps keyboard focus on the page when a change takes away the element that held it
 * (Round 14, SPEC §4.10.11; WCAG 2.4.3 focus order). When a step's AI draft lands, Draft
 * note leaves the step (and so does the note field, while the draft waits): focus inside
 * the step would fall to the page body, so it moves to `land()` instead.
 *
 * Spread the returned handlers on the part's root. Focus counts as inside from the moment
 * it enters until the reader moves it out: React holds its own events while it commits,
 * so the blur of an element it removes never reads as leaving, and a dialog the part
 * opened counts as inside (its events reach the part through React). Nothing moves while
 * focus is still on the page, and focus the reader moved elsewhere is never taken.
 */
import * as React from 'react';

/** Focus was lost: nothing, or the page body, holds it. */
export function focusDropped(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

export interface KeepFocusHandlers {
  onFocus: React.FocusEventHandler<HTMLElement>;
  onBlur: React.FocusEventHandler<HTMLElement>;
}

/**
 * `change` names the change to watch (a step's draft waiting or not); when it changes and
 * focus that was inside the part fell to the page body, `land` runs once.
 */
export function useKeepFocus(change: string | number | boolean, land: () => void): KeepFocusHandlers {
  const inside = React.useRef(false);
  const landRef = React.useRef(land);
  landRef.current = land;
  const last = React.useRef(change);
  React.useLayoutEffect(() => {
    if (Object.is(last.current, change)) return;
    last.current = change;
    if (inside.current && focusDropped()) landRef.current();
  }, [change]);
  const onFocus = React.useCallback(() => {
    inside.current = true;
  }, []);
  const onBlur = React.useCallback((event: React.FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    inside.current = false;
  }, []);
  return { onFocus, onBlur };
}
