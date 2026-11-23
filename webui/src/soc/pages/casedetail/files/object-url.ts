/**
 * Round 15 (SPEC D5.12): object URLs that SHOW a case screenshot, never a download (a
 * download goes through `lib/download-blob.ts`, which keeps its URL alive past the
 * click). An `<img>` here reads the URL while it is on screen, so it is revoked the
 * moment the image is replaced or unmounted, which frees the bytes at once.
 *
 * The one other module allowed to make object URLs (the download guard,
 * `lib/__tests__/download-revoke.guard.test.ts`, names it). Feature-detected: jsdom has
 * no object-URL store, and a missing one reads as "cannot show".
 */

/** An object URL for `blob`, or `null` where the environment has none. */
export function showBlob(blob: Blob): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(blob);
}

/** Release a URL made by {@link showBlob}. */
export function releaseShownBlob(url: string | null | undefined): void {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* nothing to release */
  }
}
