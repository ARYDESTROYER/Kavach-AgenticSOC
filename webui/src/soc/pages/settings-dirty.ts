/**
 * settings-dirty — pure helpers for the Round-3 Settings per-section dirty map.
 *
 * The Settings page buffers an editable `Preferences` draft against the last saved
 * snapshot. Instead of a whole-object diff (which forced a full PUT on any edit and
 * could clobber a concurrently-changed key), we compute the set of CHANGED TOP-LEVEL
 * keys and:
 *   - send ONLY those keys on Save (a minimal patch);
 *   - light a per-section "modified" dot when a section OWNS any changed key.
 *
 * Everything here is a pure function over plain data (no React, no DOM), so it is
 * unit-testable in isolation and shared by the page + its spec.
 *
 * SECURITY: this module never renders anything and never touches the network; it
 * only compares operator-entered preference values. Keys that are structurally
 * non-editable (`sources` / `setup_complete`) are excluded up front so they can
 * never appear in a patch.
 */

// Import from the COMPONENT-FREE metadata module (not `settings-sections.ts`) so this
// pure helper never drags the heavy Settings renderer tree into an eager import chain
// (Round-5 Coupling-A — keeps the first-paint entry chunk slim).
import { SECTION_KEYS } from './settings/settings-sections-meta';
import { deepEqual } from '@/lib/deep-equal';

/** A loose Preferences view — we only ever index it by string key here. */
export type PrefsRecord = Record<string, unknown>;

/** Top-level keys that are never part of an editable patch (server-owned / derived). */
export const NON_EDITABLE_KEYS: ReadonlySet<string> = new Set(['sources', 'setup_complete']);

/**
 * Map each Settings SECTION id → the top-level Preferences keys it OWNS. Used only to
 * decide which section shows a "modified" dot; the Save patch is derived from the raw
 * changed-key set (so an unmapped/new key is still saved, just without a section dot).
 *
 * A key may legitimately appear under more than one section (e.g. `rag` is edited from
 * both Knowledge › Retrieval and Advanced › Suppression) — both sections then light up,
 * which is the correct, honest signal.
 *
 * Round-5 Sett-A: this is no longer hand-maintained here — it is DERIVED from the
 * single-source section registry (`settings/settings-sections.ts`, the `ownedKeys` of
 * each section). Re-exported so the page + this module's spec keep importing it from
 * `settings-dirty` unchanged (kills the former 3-file hand-sync).
 */
export { SECTION_KEYS };

/**
 * Stable, order-insensitive structural equality for two JSON-able values. Lives in
 * `lib/deep-equal.ts` (dependency-free, so the eager draft hook can share it without this
 * module's Settings metadata); re-exported here for the page and this module's spec.
 */
export { deepEqual };

/**
 * The set of EDITABLE top-level keys whose value diverges from the saved snapshot.
 * Considers keys present on either side (so a removed key counts), excludes the
 * structurally non-editable keys, and ignores `undefined`-vs-absent noise.
 */
export function changedKeys(
  draft: PrefsRecord | null | undefined,
  saved: PrefsRecord | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!draft || !saved) return out;
  const keys = new Set<string>([...Object.keys(draft), ...Object.keys(saved)]);
  for (const k of keys) {
    if (NON_EDITABLE_KEYS.has(k)) continue;
    const dv = draft[k];
    const sv = saved[k];
    // Treat `undefined` on one side and absent on the other as equal (no real edit).
    if (dv === undefined && sv === undefined) continue;
    if (!deepEqual(dv, sv)) out.add(k);
  }
  return out;
}

/* ------------------------------------------------------ changed values ---- */

/**
 * Leaves a store stamps on every save (`created_at`, `updated_at`): bookkeeping, never a
 * change a person made. The audit log leaves them out (`backend/app/audit/changes.py`
 * `_BOOKKEEPING_KEYS`), so the count here does too.
 */
const BOOKKEEPING_LEAVES: ReadonlySet<string> = new Set(['created_at', 'updated_at']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list item's stable key: its `id`, else its `name` (non-empty text), else none. */
function itemKey(item: unknown): string | null {
  if (!isPlainObject(item)) return null;
  for (const name of ['id', 'name']) {
    const value = item[name];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** `key -> item` when every item of a non-empty list has a unique key, else null. */
function keyedItems(items: readonly unknown[]): Map<string, unknown> | null {
  if (items.length === 0) return null;
  const out = new Map<string, unknown>();
  for (const item of items) {
    const key = itemKey(item);
    if (key === null || out.has(key)) return null;
    out.set(key, item);
  }
  return out;
}

/** The last named segment of a path (`a.b[id].c` gives `c`). */
function leafName(path: string): string {
  const keys = path.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);
  return keys[keys.length - 1] ?? '';
}

/**
 * Every leaf under `value`, by path, exactly as the audit log walks a document: a plain
 * object recurses (an empty one is a leaf), a list whose items all carry a unique `id`
 * or `name` is walked item by item (`channels[pagerduty].type`), and any other list or
 * scalar is one value. An absent value (`undefined`) has no leaves.
 */
function flattenLeaves(value: unknown, path: string, out: Map<string, unknown>): void {
  if (value === undefined) return;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.set(path, {});
      return;
    }
    for (const key of keys) flattenLeaves(value[key], path ? `${path}.${key}` : key, out);
    return;
  }
  if (Array.isArray(value)) {
    const keyed = keyedItems(value);
    if (keyed) {
      for (const [key, item] of keyed) flattenLeaves(item, `${path}[${key}]`, out);
      return;
    }
  }
  out.set(path, value);
}

/** An empty list or object (`[]`, `{}`). */
function isEmptyContainer(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * How many VALUES differ between the draft and the saved snapshot: the number of
 * changes a person made, as the audit log counts them for the same save (one entry per
 * changed field, `backend/app/audit/changes.py`). Editing five fields of the Chat
 * assistant section counts five, although they all live under one top-level key.
 *
 * Mirrors the audit walk: missing and `null` read alike; store bookkeeping stamps are
 * left out; an empty list or object on one side whose other side holds keyed items is
 * counted through those items only. A top-level key that differs always counts at least
 * once, so the count is never zero while the page holds an unsaved change.
 */
export function changedValueCount(
  draft: PrefsRecord | null | undefined,
  saved: PrefsRecord | null | undefined,
): number {
  let total = 0;
  for (const key of changedKeys(draft, saved)) {
    const before = new Map<string, unknown>();
    const after = new Map<string, unknown>();
    flattenLeaves(saved?.[key], key, before);
    flattenLeaves(draft?.[key], key, after);
    let count = 0;
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const was = before.get(path) ?? null;
      const now = after.get(path) ?? null;
      if (deepEqual(was, now)) continue;
      if (BOOKKEEPING_LEAVES.has(leafName(path))) continue;
      // `channels: []` before and `channels[pd].type` after: the items carry the change.
      if (was === null || now === null) {
        const present = was ?? now;
        const other = was === null ? before : after;
        if (
          isEmptyContainer(present) &&
          [...other.keys()].some((p) => p.startsWith(`${path}[`) || p.startsWith(`${path}.`))
        ) {
          continue;
        }
      }
      count += 1;
    }
    total += Math.max(count, 1);
  }
  return total;
}

/**
 * Build the minimal Save patch: only the changed editable keys, taken from the draft.
 * A key changed to `undefined` is dropped (there is nothing to send), matching the
 * "additive fields are safe; omitted means unchanged" backend contract.
 */
export function changedPatch(
  draft: PrefsRecord | null | undefined,
  saved: PrefsRecord | null | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!draft) return patch;
  for (const k of changedKeys(draft, saved)) {
    const v = draft[k];
    if (v === undefined) continue;
    patch[k] = v;
  }
  return patch;
}

/** True when ANY editable top-level key differs from the saved snapshot. */
export function isDirty(
  draft: PrefsRecord | null | undefined,
  saved: PrefsRecord | null | undefined,
): boolean {
  return changedKeys(draft, saved).size > 0;
}

/** The subset of `changed` keys that belong to a given section (empty when none). */
export function sectionChangedKeys(sectionId: string, changed: ReadonlySet<string>): string[] {
  const owned = SECTION_KEYS[sectionId];
  if (!owned) return [];
  return owned.filter((k) => changed.has(k));
}

/** Whether a section owns at least one changed key (drives its "modified" dot). */
export function sectionIsDirty(sectionId: string, changed: ReadonlySet<string>): boolean {
  return sectionChangedKeys(sectionId, changed).length > 0;
}
