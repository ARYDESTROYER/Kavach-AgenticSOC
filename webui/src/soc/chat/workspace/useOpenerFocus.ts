/**
 * useOpenerFocus — return focus to whatever opened a CONTROLLED Radix Sheet.
 *
 * A Radix dialog returns focus on close only to its own `Dialog.Trigger`; a Sheet
 * opened from a button outside its root (the toolbar's Report toggle, History, the
 * icon strip) has none, so Radix sends focus to `<body>` and a keyboard or screen-reader
 * user loses their place. SPEC §10.9: an overlay "returns [focus] on close".
 *
 * Wire `capture` into `onOpenAutoFocus` (it runs before focus moves into the content,
 * so `document.activeElement` is still the opener) and `restore` into
 * `onCloseAutoFocus`. An opener that is no longer in the document (the layout changed
 * while the Sheet was open) leaves Radix's default in place.
 *
 * Round 13 (SPEC-chat T27): passed the open event, `capture` also moves focus to an
 * element marked `data-autofocus` inside the content instead of Radix's first focusable
 * one (the History sheet's search field, so the New chat tooltip never opens over it).
 */
import * as React from 'react';

export interface OpenerFocus {
  /** Record the opener; with the open event, focus the content's `[data-autofocus]`. */
  capture: (event?: Event) => void;
  restore: (event: Event) => void;
}

export function useOpenerFocus(): OpenerFocus {
  const openerRef = React.useRef<HTMLElement | null>(null);
  const capture = React.useCallback((event?: Event) => {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    const content = event?.target;
    if (!(content instanceof Element)) return;
    const preferred = content.querySelector<HTMLElement>('[data-autofocus]');
    if (!preferred) return;
    event?.preventDefault();
    preferred.focus();
  }, []);
  const restore = React.useCallback((event: Event) => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (!opener || !opener.isConnected) return;
    event.preventDefault();
    opener.focus();
  }, []);
  return React.useMemo(() => ({ capture, restore }), [capture, restore]);
}
