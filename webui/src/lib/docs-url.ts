/**
 * Same-origin URLs into the Help Center bundled with this Console (`/docs/<line>/`).
 *
 * Moved out of `pages/Docs.tsx` (Round 16 WP07) so a page that links to an article, such
 * as Communication, What's new, does not pull the Help Center page into its chunk.
 * `pages/Docs.tsx` re-exports both helpers, so existing imports keep working.
 */

/** A patch release shares the matching major.minor documentation line. */
export function docsVersionLine(version: string): string {
  const match = version.trim().match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : 'development';
}

/** Same-origin immutable article URL for the documentation bundled with this app. */
export function docsArticleUrl(path: string, version: string): string {
  const [page, anchor] = path.split('#', 2);
  const cleanPath = page.replace(/^\/+|\/+$/g, '');
  return `/docs/${docsVersionLine(version)}/${cleanPath}/${anchor ? `#${anchor}` : ''}`;
}

/** Same-origin URL of a file the Help Center bundle serves (`assets/releases/...`). */
export function docsAssetUrl(path: string, version: string): string {
  return `/docs/${docsVersionLine(version)}/${path.replace(/^\/+/, '')}`;
}
