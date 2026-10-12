/**
 * Case Manager keyboard model — the ONE guard for single-key shortcuts (Round 12, CM-4).
 *
 * The Case Manager listens on the document for single letters (A/C/E/H/R/M/T in the case,
 * / and ? in the queue). A letter typed into a control that consumes letters itself must
 * never ALSO fire a shortcut: text entry, a Radix Select trigger or open listbox (both
 * change the value by typeahead without calling preventDefault), a menu (typeahead moves
 * the highlight), a radio group (the disposition picker's own number keys). Before this
 * guard, "c" on the Severity filter both picked Critical and opened the Close dialog.
 */

const LETTER_CONSUMERS = [
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="radiogroup"]',
  '[role="slider"]',
  '[role="spinbutton"]',
].join(',');

/** True when focus is in a control that consumes letter keys itself. */
export function isLetterConsumer(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
  return Boolean(target.closest(LETTER_CONSUMERS));
}

/** True while an open menu or listbox (a Select, a dropdown) owns the keyboard. */
export function hasOpenPicker(root: ParentNode | null = typeof document === 'undefined' ? null : document): boolean {
  if (!root) return false;
  return Boolean(root.querySelector('[role="menu"][data-state="open"],[role="listbox"][data-state="open"]'));
}

/** A single-key shortcut must yield: focus is in a letter consumer or a picker is open. */
export function shortcutBlocked(event: Pick<KeyboardEvent, 'target'>): boolean {
  return isLetterConsumer(event.target) || hasOpenPicker();
}
