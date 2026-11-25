/**
 * Build-time What's new identity (Round 16 WP07, SPEC D7).
 *
 * Evaluated by Vite and Vitest in Node, never by the browser bundle. It reads the newest
 * release-notes update id from the generated notes (`scripts/build_release_notes.py`
 * writes `src/soc/whats-new/release-notes.gen.json`), and both configs inject it as
 * `__AGENTIC_SOC_WHATS_NEW_LATEST__`, so the entry chunk can compare a person's marker
 * with a few bytes and load the notes only when something is new.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The generated notes, relative to this file. */
export const WHATS_NEW_NOTES_PATH = path.resolve(__dirname, 'src/soc/whats-new/release-notes.gen.json');

/** The update-id grammar the backend normalises `misc.whats_new_seen` with. */
const UPDATE_ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/**
 * The newest update id. A missing or malformed notes file is a packaging error, so the
 * build fails rather than shipping a Console that can never announce an update.
 */
export function resolveWhatsNewLatest(file: string = WHATS_NEW_NOTES_PATH): string {
  const notes = JSON.parse(fs.readFileSync(file, 'utf8')) as { latest?: unknown };
  if (typeof notes.latest !== 'string' || !UPDATE_ID.test(notes.latest)) {
    throw new Error(`${file}: no valid newest update id; run scripts/build_release_notes.py`);
  }
  return notes.latest;
}
