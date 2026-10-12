/**
 * The one way the console saves a Blob as a file (re-exported by `lib/download.ts`, which
 * documents the export rules). It lives in its own small module because the first-paint
 * shell needs it too (job artifacts, MFA recovery codes): importing `lib/download.ts`
 * from the entry chunk would pull every export helper (file names, MIME types) into it.
 *
 * FEATURE-DETECTED, not assumed: `URL.createObjectURL` is absent in some environments
 * (jsdom implements no object-URL store at all), and an unguarded call there would throw
 * out of a click handler. The anchor is attached to the page for the click and removed
 * right after, and the object URL is revoked only after {@link REVOKE_DELAY_MS}
 * (FileSaver.js uses the same 40 s): revoking at once after `click()` is known to cancel
 * the download in Safari and older Firefox.
 */

/** How long a download's object URL stays alive after the click (ms). */
export const REVOKE_DELAY_MS = 40_000;

/** Save a Blob as a file. Returns false (and does nothing) where downloads are unavailable. */
export function downloadBlob(filename: string, blob: Blob): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Late revoke: the browser may still be reading the object URL after the click.
    setTimeout(() => {
      try {
        URL.revokeObjectURL?.(url);
      } catch {
        /* an environment without a revocable store: nothing to release */
      }
    }, REVOKE_DELAY_MS);
  }
  return true;
}
