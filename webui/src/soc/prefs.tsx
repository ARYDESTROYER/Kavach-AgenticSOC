/**
 * PrefsContext — pervasive customization (Round-2 Wave 7).
 *
 * Hydrated ONCE from GET /api/prefs/effective on mount (the merged ORG ← USER
 * cascade). Exposes the user's saved views, terminology overrides, theme mode, and
 * per-table column state, plus the mutators that persist them. The no-auth profile
 * is fully supported — the backend keys everything to the 'default' bucket when no
 * principal is present, so customization works without auth turned on.
 *
 * Theme: this context OWNS the persisted-to-the-backend theme mode and drives the
 * actual `.dark` class via the existing ThemeProvider (theme.tsx). The local
 * localStorage theme remains the pre-hydration default (so the first paint is not
 * jarring); once the effective prefs land, the user's stored mode is applied.
 *
 * SECURITY (#9): every terminology label, saved-view name and filter value is
 * user/operator-influenceable DATA. It is rendered as plain text by the UI and is
 * NEVER interpolated unfenced into an LLM prompt. `t(key)` returns a plain string.
 */
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import type {
  ColumnState,
  EffectivePrefs,
  SavedView,
  Terminology,
  ThemeMode,
} from '@/lib/types';
import { useTheme } from './theme';
import { applyTransparencyPreference, TRANSPARENCY_PREF_KEY } from '@/design-system/transparency';

/**
 * The built-in default labels `t(key)` falls back to when an org/user terminology
 * override is absent. Keep this small + focused on high-traffic nouns; any key not
 * present here simply returns the caller-supplied fallback (or the key itself).
 */
export const DEFAULT_TERMS: Record<string, string> = {
  case: 'case',
  cases: 'Cases',
  case_plural: 'cases',
  alert: 'alert',
  alerts: 'Alerts',
  source: 'source',
  sources: 'Sources',
  analyst: 'analyst',
};

/** An empty effective-prefs object used before hydration + on failure. */
const EMPTY_EFFECTIVE: EffectivePrefs = {
  terminology: {},
  theme_mode: 'system',
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  misc: {},
  org: {
    terminology: {},
    default_theme: 'system',
    default_saved_views: [],
    default_pinned_view_ids: [],
  },
};

export interface PrefsContextValue {
  /** The merged ORG←USER effective prefs (empty until hydrated). */
  prefs: EffectivePrefs;
  /** The caller's + org-shared saved views (the cascade surfaces both). */
  savedViews: SavedView[];
  /** The active terminology override map (org ← user merged). */
  terminology: Terminology;
  /** The effective theme mode (light/dark/system) the user has chosen. */
  themeMode: ThemeMode;
  /** Whether the initial hydrate has settled (ok or failed). */
  ready: boolean;

  /** Set + persist the user's theme mode (applied via ThemeProvider; respects system). */
  setThemeMode: (mode: ThemeMode) => void;
  /**
   * Save the CURRENT list configuration as a named personal view. Returns the
   * created view (or null on failure). The view is appended to `savedViews`.
   */
  saveView: (
    name: string,
    config: { scope?: string; filters?: Record<string, unknown>; sort?: string; columns?: string[] | null },
  ) => Promise<SavedView | null>;
  /** Clone any view (org-shared or personal) into the personal set. */
  cloneView: (id: string) => Promise<SavedView | null>;
  /** Delete a personal saved view. */
  deleteView: (id: string) => Promise<boolean>;
  /**
   * "Apply" a saved view — a thin lookup helper the surfaces call to read a view's
   * stored config; the page maps it onto its own filter state. Returns null if gone.
   */
  applyView: (id: string) => SavedView | null;

  /** The stored column state for a table id (or undefined when none). */
  tableColumns: (tableId: string) => ColumnState | undefined;
  /** Persist a table's column state (show/hide/reorder/width). Empty clears it. */
  updateTableColumns: (tableId: string, state: ColumnState) => Promise<void>;

  /**
   * Terminology helper: the override for `key` (org ← user merged), else `fallback`,
   * else the built-in DEFAULT_TERMS label, else the key itself. Always a plain string.
   */
  t: (key: string, fallback?: string) => string;

  /** Re-fetch the effective cascade (e.g. after an org-terminology admin edit). */
  refresh: () => Promise<void>;

  /**
   * Set + persist keys of the user's `misc` bag (a presentation preference such as the
   * chat width). Optimistic: `prefs.misc` holds the new value at once, so a component
   * that mounts later in this session reads it instead of the copy loaded at start, and
   * a later hydrate cannot bring back an older value this session already replaced. The
   * server deep-merges `misc`, so other keys are kept. Best-effort: the local value
   * applies even if the save fails.
   */
  patchMisc: (patch: Record<string, unknown>) => void;
}

const PrefsContext = React.createContext<PrefsContextValue | null>(null);

export const PrefsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { setTheme } = useTheme();
  const [prefs, setPrefs] = React.useState<EffectivePrefs>(EMPTY_EFFECTIVE);
  const [ready, setReady] = React.useState(false);
  /** `misc` keys this session wrote (patchMisc): newer than any fetched copy. */
  const sessionMiscRef = React.useRef<Record<string, unknown>>({});

  const applyEffective = React.useCallback(
    (eff: EffectivePrefs) => {
      const fetched: EffectivePrefs = { ...EMPTY_EFFECTIVE, ...eff };
      // A fetch that started before this session's own misc writes landed must not bring
      // the older values back (a hydrate racing a first change, a later refresh()).
      const merged: EffectivePrefs = Object.keys(sessionMiscRef.current).length
        ? { ...fetched, misc: { ...(fetched.misc ?? {}), ...sessionMiscRef.current } }
        : fetched;
      setPrefs(merged);
      // Drive the actual colour mode from the resolved cascade (org default unless
      // the user chose their own). ThemeProvider resolves 'system' against the OS.
      if (merged.theme_mode) setTheme(merged.theme_mode);
      // The user's "Reduce transparency" choice (Round 12): a stored value wins over this
      // device's mirror; an absent one leaves the mirror (and the pre-paint stamp) alone.
      applyTransparencyPreference(merged.misc?.[TRANSPARENCY_PREF_KEY]);
    },
    [setTheme],
  );

  const refresh = React.useCallback(async () => {
    try {
      const eff = await api.prefs.effective();
      applyEffective(eff);
    } catch {
      // Legacy / unreachable backend → fall back to defaults but PRESERVE the resolved
      // `theme_mode` so the Appearance / account-menu picker keeps matching the colour
      // mode ThemeProvider is actually applying (owned by localStorage). Resetting it to
      // EMPTY_EFFECTIVE's 'system' desynced the control from the visible theme.
      setPrefs((p) => ({ ...EMPTY_EFFECTIVE, theme_mode: p.theme_mode, misc: { ...sessionMiscRef.current } }));
    }
  }, [applyEffective]);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      await refresh();
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const setThemeMode = React.useCallback(
    (mode: ThemeMode) => {
      // Optimistic: apply locally immediately, persist in the background.
      setTheme(mode);
      setPrefs((p) => ({ ...p, theme_mode: mode }));
      void api.prefs.putUser({ theme_mode: mode }).catch(() => {
        /* best-effort — the local apply already happened */
      });
    },
    [setTheme],
  );

  const patchMisc = React.useCallback((patch: Record<string, unknown>) => {
    if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) return;
    sessionMiscRef.current = { ...sessionMiscRef.current, ...patch };
    setPrefs((p) => ({ ...p, misc: { ...(p.misc ?? {}), ...patch } }));
    try {
      Promise.resolve(api.prefs.putUser({ misc: patch })).catch(() => {
        /* best-effort — the local apply already happened */
      });
    } catch {
      /* no preferences API (an embedding without it): the local value still applies */
    }
  }, []);

  const saveView = React.useCallback<PrefsContextValue['saveView']>(async (name, config) => {
    try {
      const created = await api.views.create({
        name,
        scope: config.scope ?? 'cases',
        filters: config.filters ?? {},
        sort: config.sort ?? '',
        columns: config.columns ?? null,
      });
      setPrefs((p) => ({ ...p, saved_views: [...p.saved_views, created] }));
      return created;
    } catch {
      return null;
    }
  }, []);

  const cloneView = React.useCallback(async (id: string): Promise<SavedView | null> => {
    try {
      const created = await api.views.clone(id);
      setPrefs((p) => ({ ...p, saved_views: [...p.saved_views, created] }));
      return created;
    } catch {
      return null;
    }
  }, []);

  const deleteView = React.useCallback(async (id: string): Promise<boolean> => {
    try {
      await api.views.remove(id);
      setPrefs((p) => ({
        ...p,
        saved_views: p.saved_views.filter((v) => v.id !== id),
        pinned_view_ids: p.pinned_view_ids.filter((pid) => pid !== id),
      }));
      return true;
    } catch (e) {
      // A 404 (already gone) still reconciles local state — treat it as a successful
      // removal so the caller confirms it (rather than showing a spurious error / nothing).
      if (e instanceof ApiError && e.status === 404) {
        setPrefs((p) => ({
          ...p,
          saved_views: p.saved_views.filter((v) => v.id !== id),
          pinned_view_ids: p.pinned_view_ids.filter((pid) => pid !== id),
        }));
        return true;
      }
      return false;
    }
  }, []);

  const applyView = React.useCallback(
    (id: string): SavedView | null => prefs.saved_views.find((v) => v.id === id) ?? null,
    [prefs.saved_views],
  );

  const tableColumns = React.useCallback(
    (tableId: string): ColumnState | undefined => prefs.tables[tableId],
    [prefs.tables],
  );

  const updateTableColumns = React.useCallback(
    async (tableId: string, state: ColumnState): Promise<void> => {
      // Optimistic local apply so the table re-renders instantly.
      setPrefs((p) => ({ ...p, tables: { ...p.tables, [tableId]: state } }));
      try {
        await api.prefs.tables.put(tableId, state);
      } catch {
        /* best-effort — the local apply already happened */
      }
    },
    [],
  );

  const t = React.useCallback(
    (key: string, fallback?: string): string => {
      const override = prefs.terminology[key];
      if (typeof override === 'string' && override.trim()) return override;
      if (fallback !== undefined) return fallback;
      return DEFAULT_TERMS[key] ?? key;
    },
    [prefs.terminology],
  );

  const value = React.useMemo<PrefsContextValue>(
    () => ({
      prefs,
      savedViews: prefs.saved_views,
      terminology: prefs.terminology,
      themeMode: prefs.theme_mode,
      ready,
      setThemeMode,
      saveView,
      cloneView,
      deleteView,
      applyView,
      tableColumns,
      updateTableColumns,
      t,
      refresh,
      patchMisc,
    }),
    [
      prefs,
      ready,
      setThemeMode,
      saveView,
      cloneView,
      deleteView,
      applyView,
      tableColumns,
      updateTableColumns,
      t,
      refresh,
      patchMisc,
    ],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
};

/**
 * The customization context, or `null` outside a <PrefsProvider> (a lazy chunk that is
 * also rendered on its own, e.g. the chat workspace in tests, falls back to its local
 * mirror instead of throwing).
 */
export function useOptionalPrefs(): PrefsContextValue | null {
  return React.useContext(PrefsContext);
}

/** Access the customization context. Throws if used outside <PrefsProvider>. */
export function usePrefs(): PrefsContextValue {
  const ctx = React.useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used within a <PrefsProvider>');
  return ctx;
}

/**
 * Convenience hook for the terminology helper alone (so a component that only needs
 * labels doesn't pull the whole context API surface).
 */
export function useTerm(): (key: string, fallback?: string) => string {
  return usePrefs().t;
}
