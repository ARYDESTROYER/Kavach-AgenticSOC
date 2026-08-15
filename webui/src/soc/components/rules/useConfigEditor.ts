/**
 * useConfigEditor — a tiny load/draft/dirty/save hook for the per-feature typed config
 * editors wired into Baseline / Campaigns / BatchJobs (G6 R6, W0-F F5 endpoints).
 *
 * It mirrors the pattern already in Tuning.tsx (saved vs. draft + JSON dirty check +
 * deep-merge PUT that echoes the persisted config) so every Round-4 engine block gets a
 * consistent GET/PUT config editor without re-rolling the lifecycle four times.
 *
 * INVARIANTS: these blocks are ADVISORY (baseline/campaign/batch). The editor is a
 * CONFIG WRITER only — it never calls `decide()`, never sets a case status, and never
 * bills an LLM (#3/#6). The PUT deep-merges server-side (audited, RBAC-gated, #2).
 */
import * as React from 'react';

import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';

export interface ConfigClient<C> {
  getConfig: () => Promise<{ config: C }>;
  putConfig: (config: Partial<C>) => Promise<{ ok: boolean; config: C }>;
}

export interface ConfigEditorState<C> {
  /** The current editing draft (merged over defaults). */
  draft: C;
  /** The last-persisted config. */
  saved: C;
  /** True when the draft differs from saved. */
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error: unknown;
  /** Patch the draft (shallow-merged). */
  update: (patch: Partial<C>) => void;
  /** Replace the whole draft. */
  setDraft: (next: C) => void;
  /** Reset the draft back to the last-saved config. */
  discard: () => void;
  /** Re-fetch the config. */
  reload: () => Promise<void>;
  /** Persist the draft (deep-merge PUT); returns the persisted config or throws. */
  save: () => Promise<C>;
}

/**
 * Load a typed config from a `{getConfig, putConfig}` client, keep a draft + dirty
 * flag, and expose save/discard/reload. `defaults` fills any absent key so controls
 * always have a defined value.
 */
export function useConfigEditor<C extends object>(
  client: ConfigClient<C>,
  defaults: C,
  options?: { enabled?: boolean },
): ConfigEditorState<C> {
  const enabled = options?.enabled ?? true;
  const [saved, setSaved] = React.useState<C>(defaults);
  const [draft, setDraftState] = React.useState<C>(defaults);
  const [loading, setLoading] = React.useState(enabled);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const reload = React.useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await client.getConfig();
      const c = { ...defaults, ...(res.config ?? {}) };
      setSaved(c);
      setDraftState(c);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    // `defaults`/`client` are stable per feature; intentionally not deps to avoid a
    // reload loop from a fresh object literal each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const dirty = React.useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );
  // Baseline, Campaigns and Batch Jobs all share this editor lifecycle. Register at
  // this owner boundary so shell-level release activation cannot discard any of their
  // policy drafts, including invalid or failed-save states.
  useUnsavedChanges(dirty);

  const update = React.useCallback((patch: Partial<C>) => {
    setDraftState((d) => ({ ...d, ...patch }));
  }, []);

  const setDraft = React.useCallback((next: C) => setDraftState(next), []);
  const discard = React.useCallback(() => setDraftState(saved), [saved]);

  const save = React.useCallback(async () => {
    if (!enabled) throw new Error('This configuration is not available to the current user.');
    setSaving(true);
    try {
      const res = await client.putConfig(draft);
      const c = { ...defaults, ...(res.config ?? draft) };
      setSaved(c);
      setDraftState(c);
      return c;
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, enabled]);

  return {
    draft,
    saved,
    dirty,
    loading,
    saving,
    error,
    update,
    setDraft,
    discard,
    reload,
    save,
  };
}
