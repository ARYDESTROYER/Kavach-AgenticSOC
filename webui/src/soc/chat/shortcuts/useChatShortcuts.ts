/**
 * useChatShortcuts — Workspace Chat keyboard shortcuts (SPEC §10.4a).
 *
 * INTERFACE STUB (orchestrator). WP-I2b owns and replaces the body; keep the exports.
 * Registered only while Workspace Chat is mounted; never Ctrl/Cmd+K or Ctrl/Cmd+B.
 */
import * as React from 'react';

export interface ChatShortcutHandlers {
  /** Ctrl/Cmd+Shift+O */
  newChat: () => void;
  /** Ctrl/Cmd+Shift+S */
  toggleHistory: () => void;
  /** Shift+Esc */
  focusComposer: () => void;
  /** Ctrl/Cmd+/ */
  openShortcuts: () => void;
}

/** `aria-keyshortcuts` values for the controls that own these actions. */
export const CHAT_KEYSHORTCUTS = {
  newChat: 'Control+Shift+O Meta+Shift+O',
  toggleHistory: 'Control+Shift+S Meta+Shift+S',
  focusComposer: 'Shift+Escape',
  openShortcuts: 'Control+/ Meta+/',
} as const;

export function useChatShortcuts(handlers: ChatShortcutHandlers, enabled = true): void {
  const ref = React.useRef(handlers);
  ref.current = handlers;
  React.useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && event.shiftKey && key === 'o') {
        event.preventDefault();
        ref.current.newChat();
      } else if (mod && event.shiftKey && key === 's') {
        event.preventDefault();
        ref.current.toggleHistory();
      } else if (mod && key === '/') {
        event.preventDefault();
        ref.current.openShortcuts();
      } else if (!mod && event.shiftKey && key === 'escape') {
        event.preventDefault();
        ref.current.focusComposer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
