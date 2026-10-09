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
 */
import * as React from 'react';

export interface OpenerFocus {
  capture: () => void;
  restore: (event: Event) => void;
}

export function useOpenerFocus(): OpenerFocus {
  const openerRef = React.useRef<HTMLElement | null>(null);
  const capture = React.useCallback(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
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
