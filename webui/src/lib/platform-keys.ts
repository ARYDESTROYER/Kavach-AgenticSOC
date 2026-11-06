/**
 * Platform key labels (Round 14, SPEC §3.4 and §4.8.1).
 *
 * The shell shows keyboard shortcuts in the platform's own spelling: "Ctrl+B" and
 * "Ctrl+K" on Windows and Linux, "⌘B" and "⌘K" on Apple platforms. This module is
 * entry-safe and dependency-free: the navigation and the top bar import it directly,
 * never the chat shortcut list (which would pull `CHAT_SHORTCUTS` into the first-paint
 * chunk). The chat shortcut list re-exports `isApplePlatform` and `keyLabel` from here,
 * so there is one platform rule.
 */

/** True on Apple platforms (⌘ instead of Ctrl). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Display text for one key on this platform (`Mod` is Ctrl or ⌘, `Shift` is Shift or ⇧). */
export function keyLabel(key: string, apple = isApplePlatform()): string {
  if (key === 'Mod') return apple ? '⌘' : 'Ctrl';
  if (key === 'Shift') return apple ? '⇧' : 'Shift';
  return key;
}

/** "Ctrl+B" or "⌘B": a key combination as this platform writes it. */
export function comboLabel(keys: readonly string[], apple = isApplePlatform()): string {
  return keys.map((key) => keyLabel(key, apple)).join(apple ? '' : '+');
}
