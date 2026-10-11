/**
 * Ctrl/⌘+Shift+C copies the last answer (Round 12 SYNTHESIS-chat P1-6, the shortcut
 * analysts know from ChatGPT). Only the newest settled answer registers it, so the
 * shortcut always means "the answer at the bottom of this conversation".
 *
 * The key is matched by the chat's ONE shortcut matcher (`matchChatShortcut`), so it
 * follows every rule the other chat shortcuts follow: the character the layout typed
 * decides (the physical C key only on a non-Latin layout, so Dvorak's Ctrl+Shift+J on the
 * physical C stays the browser's); never while an input method is composing, on key
 * repeat, with Alt, or when another handler already consumed the event; and never while
 * a modal dialog or sheet (the step inspector, "Add to case") owns the keyboard.
 *
 * The copy goes through `copyText` (it also works over plain HTTP) and is announced
 * through the shell announcer only when it happened.
 */
import * as React from 'react';

import { copyText } from '@/lib/clipboard';
import { useAnnouncer } from '@/soc/components/announcer';
import { matchChatShortcut, modalLayerOpen } from '../shortcuts/useChatShortcuts';

/** The shortcut in `aria-keyshortcuts` form. */
export const COPY_LAST_ANSWER_KEYS = 'Control+Shift+C Meta+Shift+C';
export const COPY_LAST_ANSWER_DONE = 'Copied the last answer';

type CopyKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> &
  Partial<Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'repeat' | 'defaultPrevented'>>;

/** Whether `event` is Ctrl/⌘+Shift+C under the shared chat shortcut rules. */
export function isCopyLastAnswer(event: CopyKeyEvent): boolean {
  // Field by field: a KeyboardEvent's properties are prototype getters (a spread copies none).
  return (
    matchChatShortcut({
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      isComposing: event.isComposing ?? false,
      keyCode: event.keyCode ?? 0,
      repeat: event.repeat ?? false,
      defaultPrevented: event.defaultPrevented ?? false,
    }) === 'copyLastAnswer'
  );
}

/** Register the shortcut while `text` is the newest settled answer (`null` = off). */
export function useCopyLastAnswer(text: string | null): void {
  const announce = useAnnouncer();
  const textRef = React.useRef(text);
  textRef.current = text;
  const enabled = !!text;
  React.useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // The topmost layer owns the keyboard (as for every chat shortcut).
      if (!isCopyLastAnswer(event) || modalLayerOpen()) return;
      const value = textRef.current;
      if (!value) return;
      event.preventDefault();
      void copyText(value).then((ok) => {
        if (ok) announce(COPY_LAST_ANSWER_DONE);
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [announce, enabled]);
}
