/**
 * The one document-title composer (Round 12, SPEC D13): `<prefix> <base>`.
 *
 * Branding sets the BASE (`theme.tsx`, org · product); the chat activity monitor sets
 * the PREFIX ("●" while an answer is being written, "✓" for an unread one). Neither
 * writes `document.title` directly, so a branding refresh never wipes the prefix and
 * the prefix never leaks into a saved branding value.
 *
 * While someone else holds the title (the print export names the PDF through it) a
 * change waits until the title is ours again.
 */
let base: string | null = null;
let prefix = '';
let written: string | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let waits = 0;

function apply(force = false): void {
  if (typeof document === 'undefined') return;
  base ??= document.title;
  if (!force && written !== null && document.title !== written) {
    // Borrowed: look again in a second, and take it back after half a minute.
    retry ??= setTimeout(() => {
      retry = null;
      waits += 1;
      apply(waits > 30);
    }, 1000);
    return;
  }
  waits = 0;
  const next = prefix ? `${prefix} ${base}` : base;
  written = next;
  if (document.title !== next) document.title = next;
}

export function setBaseDocumentTitle(title: string): void {
  if (title === base) return;
  base = title;
  apply();
}

export function setDocumentTitlePrefix(next: string): void {
  if (next === prefix) return;
  prefix = next;
  apply();
}
