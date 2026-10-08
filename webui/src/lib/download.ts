/**
 * Client-side file downloads (chat revamp SPEC §9.3, BLOCKS.md §7.1).
 *
 * The one `downloadText` the console's exports share. It is FEATURE-DETECTED, not
 * assumed: `URL.createObjectURL` is absent in some environments (jsdom implements no
 * object-URL store at all), and an unguarded call there would throw out of a click
 * handler. It returns whether a download was started, and revokes the object URL at once.
 *
 * Filenames follow one rule: `agentic-soc-<kind>-<slug(title)>-<yyyymmdd-hhmm>Z.<ext>`,
 * with the KpiDrilldownPanel slug rule (lower-case ASCII words joined by `-`).
 */

/** Save `text` as a file. Returns false (and does nothing) where downloads are unavailable. */
export function downloadText(filename: string, mime: string, text: string): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  URL.revokeObjectURL?.(url);
  return true;
}

/** A filename-safe slug: lower-case ASCII words joined by `-`, at most 60 characters. */
export function fileSlug(value: string, fallback = 'export'): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || fallback
  );
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `yyyymmdd-hhmm` in UTC. */
export function utcFileStamp(now: Date = new Date()): string {
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
  );
}

/**
 * `agentic-soc-<kind>-<slug(title)>-<yyyymmdd-hhmm>Z.<ext>` — e.g.
 * `agentic-soc-report-shift-handoff-20261008-1405Z.md`.
 */
export function exportFileName(kind: string, title: string, ext: string, now: Date = new Date()): string {
  return `agentic-soc-${fileSlug(kind, 'export')}-${fileSlug(title)}-${utcFileStamp(now)}Z.${ext.replace(/[^a-z0-9]/gi, '') || 'txt'}`;
}

/** MIME types of the formats the console exports. */
export const EXPORT_MIME = {
  markdown: 'text/markdown;charset=utf-8',
  html: 'text/html;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
} as const;
