/**
 * Client-side file downloads (chat revamp SPEC §9.3, BLOCKS.md §7.1; Round 12 SPEC WP-REP
 * R4).
 *
 * The one `downloadText` / `downloadBlob` the console's exports share. It is
 * FEATURE-DETECTED, not assumed: `URL.createObjectURL` is absent in some environments
 * (jsdom implements no object-URL store at all), and an unguarded call there would throw
 * out of a click handler. It returns whether a download was started.
 *
 * The anchor is ATTACHED to the page for the click and removed right after, and the
 * object URL is revoked only after {@link REVOKE_DELAY_MS} (FileSaver.js uses the same
 * 40 s): revoking synchronously after `click()` on a detached anchor is known to cancel
 * the download in Safari and older Firefox.
 *
 * Filenames follow one rule: `agentic-soc-<kind>-<slug(title)>-<yyyymmdd-hhmm>Z.<ext>`,
 * with the KpiDrilldownPanel slug rule (lower-case ASCII words joined by `-`).
 */

/** How long a download's object URL stays alive after the click (ms). */
export const REVOKE_DELAY_MS = 40_000;

/** The UTF-8 byte order mark: Excel needs it to read a CSV file as UTF-8 (R15). */
export const UTF8_BOM = '﻿';

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

/** Save `text` as a file. Returns false (and does nothing) where downloads are unavailable. */
export function downloadText(filename: string, mime: string, text: string): boolean {
  return downloadBlob(filename, new Blob([text], { type: mime }));
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

/** The same name without its extension (a print dialog suggests `<document.title>.pdf`). */
export function exportFileStem(kind: string, title: string, now: Date = new Date()): string {
  return exportFileName(kind, title, 'pdf', now).replace(/\.pdf$/, '');
}

/** MIME types of the formats the console exports. */
export const EXPORT_MIME = {
  markdown: 'text/markdown;charset=utf-8',
  html: 'text/html;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
} as const;
