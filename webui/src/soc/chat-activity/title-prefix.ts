/**
 * The document-title prefix (Round 12, SPEC D13): "<prefix> <base>". Lazy: only
 * `ActivityEffects` loads it; the base comes from `document-title.ts` (branding).
 *
 * While someone else holds the title (the print export names the PDF through it) a
 * change waits until the title is ours again, and takes it back after half a minute.
 */
import { composeDocumentTitle } from './document-title';

let base: string | null = null;
let prefix = '';
let written: string | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let waits = 0;
let composing = false;

function apply(force = false): void {
  if (typeof document === 'undefined') return;
  base ??= document.title;
  if (!force && written !== null && document.title !== written) {
    // Borrowed: look again in a second.
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

function take(): void {
  if (composing) return;
  composing = true;
  base = composeDocumentTitle((title) => {
    if (title === base) return;
    base = title;
    apply();
  });
}

export function setDocumentTitlePrefix(next: string): void {
  take();
  if (next === prefix) return;
  prefix = next;
  apply();
}
