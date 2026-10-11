/**
 * useDirtyDraft / useUnsavedChanges — the reusable "editable draft vs saved snapshot"
 * state machine.
 *
 * Round-5 W0-B B5: lifts the buffer-a-draft-against-the-last-saved-snapshot pattern that
 * the Settings page implements ad-hoc (see `pages/settings-dirty.ts` for the pure diff
 * helpers; the shared `deepEqual` lives in `lib/deep-equal.ts`) into a general hook any
 * editor (rule editor, dashboard builder, profile form, …) can adopt.
 *
 * Model (identical to Settings):
 *   - `saved`  is the last-persisted value (the source of truth the server holds).
 *   - `draft`  is the operator's in-progress edit.
 *   - `dirty`  is true iff `draft` structurally differs from `saved` (order-insensitive
 *              deep equality — the SAME `deepEqual` the Settings dirty-map uses).
 *
 * API:
 *   - `draft`         — current draft (starts as a structural clone of `initial`).
 *   - `setDraft(next)`— replace the draft (value or updater fn, like `useState`).
 *   - `update(patch)` — shallow-merge a partial object into the draft (record drafts).
 *   - `dirty`         — draft ≠ saved.
 *   - `reset()`       — discard edits (draft ← saved).
 *   - `commit(next?)` — mark saved (saved ← next ?? draft; also snaps draft to it) after
 *                       a successful persist, so `dirty` clears.
 *   - `saved`         — the current saved snapshot.
 *
 * When the `initial` prop changes IDENTITY *and* is not structurally equal to the current
 * saved snapshot (e.g. a fresh fetch landed), the hook re-seeds both saved and draft —
 * unless the operator has local edits, in which case the saved baseline is updated but the
 * draft is preserved (so a background refresh never silently clobbers an in-progress edit).
 *
 * `useUnsavedChanges(dirty, enabled?)` wires the browser `beforeunload` guard so a page
 * with unsaved edits warns before a tab close / reload.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { deepEqual } from '@/lib/deep-equal';

/** Structural clone via JSON round-trip (drafts here are always JSON-able prefs data). */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export interface DirtyDraft<T> {
  draft: T;
  saved: T;
  dirty: boolean;
  setDraft: (next: T | ((prev: T) => T)) => void;
  update: (patch: Partial<T>) => void;
  reset: () => void;
  commit: (next?: T) => void;
}

const unsavedOwners = new Set<symbol>();
const unsavedSubscribers = new Set<() => void>();

function emitUnsavedState(): void {
  for (const subscriber of unsavedSubscribers) subscriber();
}

function subscribeToUnsavedState(subscriber: () => void): () => void {
  unsavedSubscribers.add(subscriber);
  return () => unsavedSubscribers.delete(subscriber);
}

function unsavedSnapshot(): boolean {
  return unsavedOwners.size > 0;
}

/** Shell-safe aggregate: true while any mounted editor has registered a dirty draft. */
export function useHasUnsavedChanges(): boolean {
  return useSyncExternalStore(subscribeToUnsavedState, unsavedSnapshot, () => false);
}

export function useDirtyDraft<T>(initial: T): DirtyDraft<T> {
  const [saved, setSaved] = useState<T>(() => clone(initial));
  const [draft, setDraftState] = useState<T>(() => clone(initial));

  // Track the identity of the last `initial` we seeded from, so we only re-seed when the
  // caller hands us a genuinely new object (not on every render).
  const seededRef = useRef<T>(initial);
  // Mirror the latest draft so `commit()` can read it without a stale closure — and
  // without nesting one setter inside another setter's updater (impure updaters are
  // double-invoked in React 18 StrictMode). Assigning a ref during render is safe.
  const draftRef = useRef<T>(draft);
  draftRef.current = draft;
  const dirty = !deepEqual(draft, saved);

  useEffect(() => {
    if (Object.is(initial, seededRef.current)) return;
    // Compare against the VALUE we last seeded from — a fresh object literal with the
    // same contents (or one that only differs because we just committed a local edit)
    // must NOT re-seed and clobber saved/draft. Only a genuinely new `initial` re-seeds.
    if (deepEqual(initial, seededRef.current)) return;
    seededRef.current = initial;
    setSaved(clone(initial));
    // Preserve in-progress edits: only snap the draft when it was clean.
    if (!dirty) setDraftState(clone(initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const setDraft = useCallback((next: T | ((prev: T) => T)) => {
    setDraftState((prev) =>
      typeof next === 'function' ? (next as (p: T) => T)(prev) : next,
    );
  }, []);

  const update = useCallback((patch: Partial<T>) => {
    setDraftState((prev) => {
      if (prev === null || typeof prev !== 'object' || Array.isArray(prev)) {
        return patch as T;
      }
      return { ...(prev as object), ...(patch as object) } as T;
    });
  }, []);

  const reset = useCallback(() => {
    setDraftState(clone(saved));
  }, [saved]);

  const commit = useCallback((next?: T) => {
    // Persist an explicit `next` OR the latest draft (read via ref, no stale-closure
    // snapshot): saved ← next ?? current-draft, and the draft snaps to that same value
    // so `dirty` clears. Both setters run at the top level (each updater stays pure).
    const value = clone(next === undefined ? draftRef.current : next);
    setSaved(value);
    setDraftState(clone(value));
  }, []);

  return { draft, saved, dirty, setDraft, update, reset, commit };
}

/**
 * Warn before leaving the page (tab close / reload) while there are unsaved edits.
 * Only active when `dirty && enabled`. In-app navigation is handled elsewhere (the
 * router/ConfirmDialog) — this covers the browser-level unload only.
 */
export function useUnsavedChanges(dirty: boolean, enabled = true): void {
  useEffect(() => {
    if (!dirty || !enabled) return;
    if (typeof window === 'undefined') return;
    const owner = Symbol('unsaved-draft');
    unsavedOwners.add(owner);
    emitUnsavedState();
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy Chrome requires a returnValue to trigger the native prompt.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      unsavedOwners.delete(owner);
      emitUnsavedState();
    };
  }, [dirty, enabled]);
}
