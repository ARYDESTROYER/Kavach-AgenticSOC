/**
 * Ctrl/⌘+Shift+C copies the last answer (Round 12 SYNTHESIS-chat P1-6, the shortcut
 * analysts know from ChatGPT). Only the newest settled answer registers it, so the
 * shortcut always means "the answer at the bottom of this conversation".
 *
 * The copy goes through `copyText` (it also works over plain HTTP) and is announced
 * through the shell announcer only when it happened. A key event something else already
 * handled (`defaultPrevented`) is left alone.
 */
import * as React from 'react';

import { copyText } from '@/lib/clipboard';
import { useAnnouncer } from '@/soc/components/announcer';

/** The shortcut in `aria-keyshortcuts` form. */
export const COPY_LAST_ANSWER_KEYS = 'Control+Shift+C Meta+Shift+C';
export const COPY_LAST_ANSWER_DONE = 'Copied the last answer';

/** Whether `event` is Ctrl/⌘+Shift+C (no Alt). */
export function isCopyLastAnswer(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  if (!event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return false;
  return event.code === 'KeyC' || event.key === 'C' || event.key === 'c';
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
      if (event.defaultPrevented || !isCopyLastAnswer(event)) return;
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
