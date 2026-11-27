/**
 * Focus handed back by code without opening a tooltip (Round 13 polish).
 *
 * Radix opens a tooltip whenever its trigger receives focus without a pointer press. So
 * when code returns focus to a control (a sheet or panel closing, a rename ending) the
 * control's tooltip opened over whatever the analyst had just picked: on a phone the
 * History sheet closed onto "History (Ctrl+Shift+S)" covering the conversation.
 *
 * `focusQuietly` marks the element for the length of its synchronous `focus()` call; a
 * tooltip trigger whose `onFocus` runs `quietFocusGuard` then marks the focus event
 * default-prevented, which Radix's own focus handler skips. Focus the analyst moves
 * (Tab, arrow keys, a click) is never marked, so keyboard focus still shows the tooltip.
 * Nothing is kept after the call returns.
 */
import type * as React from 'react';

const quiet = new WeakSet<Element>();

/** Focus `element` (when present) without opening the tooltip of a guarded trigger. */
export function focusQuietly(element: HTMLElement | null | undefined, options?: FocusOptions): void {
  if (!element) return;
  quiet.add(element);
  try {
    element.focus(options);
  } finally {
    quiet.delete(element);
  }
}

/**
 * The `onFocus` of a tooltip trigger that code may hand focus back to. It runs before
 * Radix's handler (Slot calls the child's handler first), so a quiet focus never opens
 * the tooltip.
 */
export function quietFocusGuard(event: React.FocusEvent<HTMLElement>): void {
  if (quiet.has(event.currentTarget)) event.preventDefault();
}
