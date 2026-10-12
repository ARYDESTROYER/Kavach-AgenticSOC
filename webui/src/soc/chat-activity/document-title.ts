/**
 * The document title's BASE (Round 12, SPEC D13). Entry-safe and tiny.
 *
 * Branding sets the base (`theme.tsx`, org · product). Once the chat activity effects
 * load, `title-prefix.ts` composes "<prefix> <base>" ("●" while an answer is being
 * written, "✓" for an unread one) and takes the base over from here, so a branding
 * refresh never wipes the prefix and the prefix never leaks into a saved branding value.
 */
let base: string | null = null;
let composer: ((title: string) => void) | null = null;

export function setBaseDocumentTitle(title: string): void {
  base = title;
  if (composer) composer(title);
  else if (typeof document !== 'undefined') document.title = title;
}

/** The prefix composer takes the base over (`null` gives it back); returns the base so far. */
export function composeDocumentTitle(next: ((title: string) => void) | null): string | null {
  composer = next;
  return base;
}
