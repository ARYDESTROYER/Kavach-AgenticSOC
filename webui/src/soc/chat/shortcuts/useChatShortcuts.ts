/**
 * useChatShortcuts — Workspace Chat keyboard shortcuts (SPEC §10.4a).
 *
 * Registered only while Workspace Chat is mounted (the host passes `enabled`), on
 * `window` so they work from anywhere on the page:
 *
 * - Ctrl/Cmd+Shift+O — new chat
 * - Ctrl/Cmd+Shift+S — show or hide the history rail
 * - Shift+Esc        — focus the composer
 * - Ctrl/Cmd+/       — the shortcut sheet
 *
 * Never Ctrl/Cmd+K or Ctrl/Cmd+B in any combination (the console owns them). Events
 * are ignored while an input method is composing (`isComposing` / keyCode 229), when
 * another handler already consumed them (a Radix layer closing on Escape calls
 * `preventDefault`), on key repeat, with Alt (AltGr layouts), and while a modal
 * dialog or sheet is open — the topmost layer owns the keyboard then.
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

export type ChatShortcutAction = keyof ChatShortcutHandlers;

const OPEN_DIALOGS = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
const OPEN_LAYERS = `${OPEN_DIALOGS}, [role="menu"][data-state="open"], [role="listbox"][data-state="open"]`;

/**
 * True while a modal dialog, alert dialog or sheet is open, or while focus sits in
 * any dialog or menu: the topmost layer owns the keyboard then. Radix renders modal
 * dialogs outside a popper wrapper and popovers inside one, which tells them apart
 * (Radix does not set `aria-modal`).
 */
export function modalLayerOpen(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (active && active !== doc.body && active.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) {
    return true;
  }
  for (const el of Array.from(doc.querySelectorAll(OPEN_DIALOGS))) {
    if (!el.closest('[data-radix-popper-content-wrapper]')) return true;
  }
  return false;
}

/** True while ANY menu, popover, listbox, sheet or dialog is open (SPEC §10.4a Esc rule). */
export function anyLayerOpen(doc: Document = document): boolean {
  return Boolean(doc.querySelector(OPEN_LAYERS));
}

/** One printable ASCII character: the key a Latin layout reports. */
const LATIN_KEY_RE = /^[\x20-\x7e]$/;

/**
 * True when `key` is one character outside printable ASCII — what a non-Latin layout
 * (Cyrillic, Greek, Hebrew…) reports for a letter key. Only then may the physical key
 * (`event.code`) stand in for the character. On a Latin layout the character IS the
 * shortcut: the physical "/" position types "-" on German/Nordic layouts (Ctrl+-
 * is browser zoom-out) and "z" on Dvorak (Ctrl+Z is undo), and Dvorak's physical O
 * types "r" (Ctrl+Shift+R is hard reload); matching `code` there would hijack them.
 * Named keys ("Dead", "Unidentified") never fall back either.
 */
function nonLatinCharacter(key: string): boolean {
  return Array.from(key).length === 1 && !LATIN_KEY_RE.test(key);
}

/**
 * Which chat shortcut a keydown means, or null. Pure, so the matching rules (and the
 * K/B exclusion) are unit-tested without a DOM.
 */
export function matchChatShortcut(event: Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode' | 'repeat' | 'defaultPrevented'
>): ChatShortcutAction | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return null;
  const mod = event.ctrlKey || event.metaKey;
  const raw = event.key || '';
  const key = raw.toLowerCase();
  if (mod && (key === 'k' || key === 'b')) return null;
  // The physical key only when the layout typed no Latin character (see above).
  const code = nonLatinCharacter(raw) ? event.code : '';
  if (mod && (code === 'KeyK' || code === 'KeyB')) return null;
  if (mod && event.shiftKey && (key === 'o' || code === 'KeyO')) return 'newChat';
  if (mod && event.shiftKey && (key === 's' || code === 'KeyS')) return 'toggleHistory';
  if (mod && (key === '/' || code === 'Slash')) return 'openShortcuts';
  if (!mod && event.shiftKey && key === 'escape') return 'focusComposer';
  return null;
}

export function useChatShortcuts(handlers: ChatShortcutHandlers, enabled = true): void {
  const ref = React.useRef(handlers);
  ref.current = handlers;
  React.useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const action = matchChatShortcut(event);
      if (!action || modalLayerOpen()) return;
      event.preventDefault();
      ref.current[action]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
