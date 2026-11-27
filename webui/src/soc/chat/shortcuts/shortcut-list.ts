/**
 * The one list of chat keyboard shortcuts (SPEC §10.4a). The shortcut sheet renders
 * it, tests pin it, and `aria-keyshortcuts` values come from the same source, so a
 * shortcut cannot exist without being documented. No entry uses Ctrl/Cmd+K or
 * Ctrl/Cmd+B: those belong to the console (command palette, navigation).
 */

// The platform rule lives in the entry-safe `lib/platform-keys` (Round 14, SPEC §3.4), so
// the shell can label Ctrl+B and Ctrl+K without importing this list.
import { isApplePlatform, keyLabel } from '@/lib/platform-keys';

export { isApplePlatform, keyLabel };

/** A key token: `Mod` is Ctrl on Windows/Linux and ⌘ on macOS. */
export type ShortcutKey =
  | 'Mod'
  | 'Shift'
  | 'Enter'
  | 'Esc'
  | 'Delete'
  | 'Backspace'
  | '↑'
  | '/'
  | '@'
  | 'C'
  | 'O'
  | 'S'
  | 'Z';

export interface ChatShortcut {
  id: string;
  /** What it does, as an imperative phrase. */
  label: string;
  keys: readonly ShortcutKey[];
  /** Another key (or combination) that does the same thing: "Delete or Backspace". */
  altKeys?: readonly ShortcutKey[];
  /** Where it applies. */
  where: 'composer' | 'chat';
  /** Extra condition copy ("in an empty composer"). */
  note?: string;
}

export const CHAT_SHORTCUTS: readonly ChatShortcut[] = [
  { id: 'send', label: 'Send', keys: ['Enter'], where: 'composer' },
  { id: 'newline', label: 'New line', keys: ['Shift', 'Enter'], where: 'composer' },
  { id: 'edit-last', label: 'Edit your last prompt', keys: ['↑'], where: 'composer', note: 'in an empty composer' },
  { id: 'stop', label: 'Stop the answer', keys: ['Esc'], where: 'composer', note: 'while it runs' },
  { id: 'commands', label: 'Commands and saved prompts', keys: ['/'], where: 'composer', note: 'at the start' },
  { id: 'scope', label: 'Limit to logs, cases, metrics…', keys: ['@'], where: 'composer' },
  { id: 'focus', label: 'Focus the composer', keys: ['Shift', 'Esc'], where: 'chat' },
  { id: 'new-chat', label: 'New chat', keys: ['Mod', 'Shift', 'O'], where: 'chat' },
  { id: 'toggle-history', label: 'Show or hide history', keys: ['Mod', 'Shift', 'S'], where: 'chat' },
  { id: 'copy-last', label: 'Copy the last answer', keys: ['Mod', 'Shift', 'C'], where: 'chat' },
  // SPEC-chat §5.6: on the new-chat start screen, the focused suggestion card hides for
  // a day and the card that takes its slot gets focus (the grid handles both keys).
  {
    id: 'hide-suggestion',
    label: 'Hide a suggestion for a day',
    keys: ['Delete'],
    altKeys: ['Backspace'],
    where: 'chat',
    note: 'on a focused suggestion',
  },
  // While the "Hidden for a day" toast still offers Undo, the start stack takes Ctrl+Z
  // (⌘Z) for it and focuses the card that came back (the composer keeps its text undo).
  {
    id: 'undo-hide-suggestion',
    label: 'Undo the last hidden suggestion',
    keys: ['Mod', 'Z'],
    where: 'chat',
    note: 'on the start screen',
  },
  { id: 'shortcuts', label: 'Show keyboard shortcuts', keys: ['Mod', '/'], where: 'chat' },
];


/** "Ctrl+Shift+O" / "⌘⇧O" for menus and tooltips. */
export function shortcutLabel(keys: readonly ShortcutKey[], apple = isApplePlatform()): string {
  return keys.map((key) => keyLabel(key, apple)).join(apple ? '' : '+');
}

/** Key names `aria-keyshortcuts` spells differently from the sheet. */
const ARIA_KEY_NAME: Partial<Record<ShortcutKey, string>> = { Esc: 'Escape', '↑': 'ArrowUp' };

/**
 * The `aria-keyshortcuts` value for these entries, from this list: each combination
 * (and its `altKeys`) separated by a space, and `Mod` written once as Control and once
 * as Meta ("Delete Backspace Control+Z Meta+Z").
 */
export function ariaKeyShortcuts(...ids: string[]): string {
  const combos: string[] = [];
  for (const id of ids) {
    const entry = CHAT_SHORTCUTS.find((shortcut) => shortcut.id === id);
    if (!entry) continue;
    for (const keys of entry.altKeys ? [entry.keys, entry.altKeys] : [entry.keys]) {
      const names = keys.map((key) => ARIA_KEY_NAME[key] ?? key);
      if (!keys.includes('Mod')) {
        combos.push(names.join('+'));
        continue;
      }
      for (const mod of ['Control', 'Meta']) combos.push(names.map((name) => (name === 'Mod' ? mod : name)).join('+'));
    }
  }
  return combos.join(' ');
}
