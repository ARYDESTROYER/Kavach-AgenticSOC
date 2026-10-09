/**
 * The one list of chat keyboard shortcuts (SPEC §10.4a). The shortcut sheet renders
 * it, tests pin it, and `aria-keyshortcuts` values come from the same source, so a
 * shortcut cannot exist without being documented. No entry uses Ctrl/Cmd+K or
 * Ctrl/Cmd+B: those belong to the console (command palette, navigation).
 */

/** A key token: `Mod` is Ctrl on Windows/Linux and ⌘ on macOS. */
export type ShortcutKey = 'Mod' | 'Shift' | 'Enter' | 'Esc' | '↑' | '/' | '@' | 'O' | 'S';

export interface ChatShortcut {
  id: string;
  /** What it does, as an imperative phrase. */
  label: string;
  keys: readonly ShortcutKey[];
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
  { id: 'shortcuts', label: 'Show keyboard shortcuts', keys: ['Mod', '/'], where: 'chat' },
];

/** True on Apple platforms (⌘ instead of Ctrl). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Display text for one key on this platform. */
export function keyLabel(key: ShortcutKey, apple = isApplePlatform()): string {
  if (key === 'Mod') return apple ? '⌘' : 'Ctrl';
  if (key === 'Shift') return apple ? '⇧' : 'Shift';
  return key;
}

/** "Ctrl+Shift+O" / "⌘⇧O" for menus and tooltips. */
export function shortcutLabel(keys: readonly ShortcutKey[], apple = isApplePlatform()): string {
  return keys.map((key) => keyLabel(key, apple)).join(apple ? '' : '+');
}
