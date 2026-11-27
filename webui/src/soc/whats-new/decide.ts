/**
 * What the What's new dialog shows, as a pure decision (Round 16 SPEC D7, [wn] §4.2).
 *
 * The marker is `UserPrefs.misc.whats_new_seen`: the id of the newest release-notes
 * update this person has seen. The decision table (no server eligibility route):
 *
 * | Marker                                   | Result                                      |
 * |------------------------------------------|---------------------------------------------|
 * | the newest bundled update id             | nothing                                     |
 * | an older bundled id                      | the updates newer than it, newest first     |
 * | an unknown id (a newer build wrote it)   | nothing: treated as having seen everything  |
 * | absent (the account predates What's new) | a welcome to the newest version             |
 * | the personal switch is off               | nothing (the entry gate never loads)        |
 *
 * New accounts start with the marker stamped by the backend, and a fresh install's wizard
 * stamps it on completion, so neither reaches the "absent" row.
 *
 * The dialog offers at most {@link MAX_DIALOG_HIGHLIGHTS} highlights: the featured ones of
 * the shown updates, or, when none is featured, their first highlights in order. A
 * highlight that names a grant the viewer lacks is left out of the dialog; it stays on the
 * Communication page.
 */
import {
  allUpdates,
  highlightUsable,
  type HasPermission,
  type NotesHighlight,
  type NotesRelease,
  type NotesUpdate,
  type ReleaseNotes,
} from './notes';

export const MAX_DIALOG_HIGHLIGHTS = 5;

export interface WhatsNewPlan {
  /** `welcome`: the marker is absent (or a forced re-open); `updates`: an older marker. */
  kind: 'welcome' | 'updates';
  /** The newest release shown (the dialog names it). */
  release: NotesRelease;
  /** The updates the dialog covers, newest first. */
  updates: NotesUpdate[];
  /** The highlights the dialog lists, at most {@link MAX_DIALOG_HIGHLIGHTS}. */
  highlights: NotesHighlight[];
}

export interface DecideOptions {
  /** The viewer's grants (true for everything while role-based access is off). */
  has: HasPermission;
  /** A re-open from the page or the release badge: show even when the marker is current. */
  force?: boolean;
}

function pick(updates: NotesUpdate[], has: HasPermission): NotesHighlight[] {
  const usable = updates.flatMap((update) => update.highlights).filter((h) => highlightUsable(h, has));
  const featured = usable.filter((h) => h.featured);
  return (featured.length ? featured : usable).slice(0, MAX_DIALOG_HIGHLIGHTS);
}

/** The dialog's content for `marker`, or `null` when nothing should be shown. */
export function decideWhatsNew(
  notes: ReleaseNotes,
  marker: unknown,
  { has, force = false }: DecideOptions,
): WhatsNewPlan | null {
  const newest = notes.releases[0];
  if (!newest?.updates.length) return null;
  const ordered = allUpdates(notes);
  const seenAt = typeof marker === 'string' ? ordered.findIndex(({ update }) => update.id === marker) : -1;

  if (typeof marker === 'string' && seenAt > 0) {
    // An older marker: everything newer than it, possibly across releases.
    const newer = ordered.slice(0, seenAt);
    const updates = newer.map(({ update }) => update);
    const highlights = pick(updates, has);
    if (highlights.length) return { kind: 'updates', release: newer[0].release, updates, highlights };
    if (!force) return null;
  } else if (!force && (seenAt === 0 || typeof marker === 'string')) {
    // Current, or an id this build does not know (written by a newer build).
    return null;
  }

  // Absent marker, or a forced re-open: a welcome to the newest version.
  const highlights = pick(newest.updates, has);
  return { kind: 'welcome', release: newest, updates: newest.updates, highlights };
}
