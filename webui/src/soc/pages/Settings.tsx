/**
 * Settings — the full Preferences console, driven by a data-driven section registry.
 *
 * Round-5 Sett-A: the former 2673-line god-file was decomposed into a single-source
 * section registry (`settings/settings-sections.ts`) + one extracted renderer per
 * section under `settings/*`. This page now:
 *   - loads GET /api/settings (`prefs` + `configured` + `read_only`) + GET /api/models;
 *   - buffers an editable `prefs` draft against the last saved snapshot;
 *   - lights a per-section "modified" dot from the DERIVED `SECTION_KEYS` map;
 *   - saves via PUT /api/settings sending ONLY the changed top-level keys (a minimal
 *     deep-merge-safe patch, never a full-doc replace — a sibling block is never wiped);
 *   - pushes write-only secret keys separately via the dedicated secrets route (the
 *     console only ever sees whether a key is configured — a boolean, never a value).
 *
 * The section rail, group structure, id union, and per-section keys are all DERIVED
 * from the ONE registry (kills the former 3-file hand-sync). The Save/Discard bar is
 * the single StickySaveBar for the whole page (no more parallel save mechanisms).
 *
 * Security: every preference value here is operator-entered (trusted); the only
 * displayed externally-derived values are model ids (plain text). No secrets are shown.
 */
import * as React from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Lock,
  Menu,
  Search,
  Settings as SettingsIcon,
  Wand2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type {
  ConfiguredStatus,
  ModelsResponse,
  Preferences,
} from '@/lib/types';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/ui/sheet';
import { LoadingState } from '@/design-system';

import { PageHeader } from '@/soc/components/PageHeader';
import { AskAboutThis } from '@/soc/components/AskAboutThis';
import { settingsTopic } from '@/soc/components/ask-topics';
import { PageContainer } from '@/soc/components/PageContainer';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { Can } from '@/soc/components/Can';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
import {
  changedKeys as computeChangedKeys,
  changedPatch,
  sectionIsDirty,
} from '@/soc/pages/settings-dirty';
import {
  SECTION_BY_ID,
  SECTION_GROUPS,
  GRID_SECTIONS,
  isSectionId,
  sectionMatchesQuery,
  matchedAnchorsForSection,
  type SectionId,
  type SectionRenderContext,
  type SettingsSectionDef,
} from '@/soc/pages/settings/settings-sections';
import { errMsg } from '@/soc/pages/settings/primitives';
import { useNavigate, useNavigationBlocker, settingsSectionHash } from '@/soc/router';
import { useAuth } from '@/soc/auth';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';
import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';

/* -------------------------------------------------------------------- page -- */

export interface SettingsPageProps {
  /** Re-launch the first-run setup wizard. */
  onRerunWizard?: () => void;
  onNavigate?: (page: any, opts?: any) => void;
}

interface VisibleSettingsGroup {
  id: string;
  label: string;
  sections: SettingsSectionDef[];
}

interface SettingsSectionListProps {
  groups: VisibleSettingsGroup[];
  activeSection: SectionId;
  changed: ReadonlySet<string>;
  query: string;
  onSelect: (id: SectionId, anchor?: string) => void;
  pendingSecretChanges?: boolean;
  compact?: boolean;
}

/**
 * The registry-derived Settings navigation shared by the desktop rail and the
 * narrow-screen chooser. The compact copy receives distinct test ids and only mounts
 * while its Sheet is open, so there is one settings landmark in the accessibility tree
 * during routine page use.
 */
function SettingsSectionList({
  groups,
  activeSection,
  changed,
  query,
  onSelect,
  pendingSecretChanges = false,
  compact = false,
}: SettingsSectionListProps) {
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`settings-group-${compact ? 'compact-' : ''}${group.id}`}>
          <div className="mb-1 flex items-center justify-between gap-3 px-2">
            <div
              id={`settings-group-${compact ? 'compact-' : ''}${group.id}`}
              className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {group.label}
            </div>
            <span className="font-mono text-2xs tabular-nums text-muted-foreground/70" aria-hidden>
              {group.sections.length}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            {group.sections.map((item) => {
              const Icon = item.icon;
              const active = activeSection === item.id;
              const modified =
                sectionIsDirty(item.id, changed) || (item.id === 'keys' && pendingSecretChanges);
              const subMatches = matchedAnchorsForSection(item.id, query);
              return (
                <React.Fragment key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id as SectionId)}
                    aria-current={active ? 'page' : undefined}
                    data-testid={`${compact ? 'settings-mobile-section' : 'settings-section'}-${item.id}`}
                    title={modified ? `${item.blurb} (unsaved changes)` : item.blurb}
                    className={cn(
                      'group inline-flex min-h-9 items-center gap-2.5 border-l-2 px-2.5 py-1.5 text-left text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      active
                        ? 'border-primary bg-accent/50 font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:bg-accent/30 hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {modified ? (
                      <span
                        className="inline-flex h-2 w-2 shrink-0 rounded-full bg-warning"
                        aria-label="Unsaved changes in this section"
                        title="Unsaved changes"
                      />
                    ) : null}
                  </button>

                  {subMatches.length > 0 ? (
                    <div className="ml-7 flex flex-col gap-0.5 border-l border-border pl-2">
                      {subMatches.map((anchor) => (
                        <button
                          key={anchor.anchor}
                          type="button"
                          onClick={() => onSelect(item.id as SectionId, anchor.anchor)}
                          data-testid={`${compact ? 'settings-mobile-anchor' : 'settings-anchor'}-${anchor.anchor}`}
                          title={`Jump to “${anchor.label}” in ${item.title}`}
                          className="truncate px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          {anchor.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

interface SettingsSearchProps {
  value: string;
  onChange: (value: string) => void;
  id: string;
}

function SettingsSearch({ value, onChange, id }: SettingsSearchProps) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search settings…"
        aria-label="Search settings sections"
        className="h-9 pl-8 pr-8 shadow-none"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear settings search"
          className="absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** Read the active section from the hash query (`#/settings?s=<id>`). */
function sectionFromHash(): SectionId | null {
  try {
    // Allow underscores so deep-links like `#/settings?s=admin_users` resolve.
    const m = (window.location.hash || '').match(/[?&]s=([a-z0-9_]+)/i);
    const id = m?.[1];
    return id && isSectionId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Read the in-section card anchor from the hash query (`#/settings?s=<id>&a=<anchor>`),
 * decoded. Returns `null` when absent. Used to scroll+highlight a specific `SettingsCard`
 * on a card-level deep-link. Anchor ids are `[a-z0-9_-]`-shaped.
 */
function anchorFromHash(): string | null {
  try {
    const m = (window.location.hash || '').match(/[?&]a=([a-z0-9_-]+)/i);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

export default function Settings({ onRerunWizard, onNavigate: onNavigateProp }: SettingsPageProps) {
  const navigate = useNavigate();
  const onNavigate = onNavigateProp ?? navigate;
  const { hasPermission } = useAuth();

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [prefs, setPrefs] = React.useState<Preferences | null>(null);
  const [savedPrefs, setSavedPrefs] = React.useState<Preferences | null>(null);
  const [configured, setConfigured] = React.useState<ConfiguredStatus>({});
  const [readOnly, setReadOnly] = React.useState(false);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);
  const [section, setSectionState] = React.useState<SectionId>(() => sectionFromHash() ?? 'general');
  const [query, setQuery] = React.useState('');
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // The pending card anchor to scroll+highlight (from `#/settings?s=<id>&a=<anchor>`).
  // Set on mount + on any hashchange carrying an `a=`; cleared once consumed by the
  // scroll/highlight effect so a re-render never re-scrolls.
  const [pendingAnchor, setPendingAnchor] = React.useState<string | null>(() => anchorFromHash());
  const reducedMotion = usePrefersReducedMotion();

  // Persist the active section (and optional card anchor) in the hash query
  // (`#/settings?s=<id>[&a=<anchor>]`) via the ONE shared hash builder, WITHOUT disturbing
  // the router (which keys on the bare page id before `?`). Writing the FULL hash directly
  // is the fix for the historical strip-bug where a bare `#/settings` dropped `?s=`/`&a=`.
  const setSection = React.useCallback((id: SectionId, anchor?: string) => {
    setSectionState(id);
    setPendingAnchor(anchor ?? null);
    try {
      const next = settingsSectionHash(id, anchor);
      if (window.location.hash !== next) window.location.hash = next;
    } catch {
      /* hash is best-effort */
    }
  }, []);

  // Keep the active section + pending anchor in sync with back/forward navigation and
  // with an external deep-link (e.g. a Cmd-K jump that wrote the full hash).
  React.useEffect(() => {
    const onHash = () => {
      const id = sectionFromHash();
      if (id) setSectionState(id);
      const a = anchorFromHash();
      if (a) setPendingAnchor(a);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Scroll to + briefly highlight the deep-linked card once the active section is
  // rendered. Reduced-motion-safe: `scrollIntoView` uses `auto` (no smooth scroll) under
  // reduced motion, and the highlight is a ring flash (box-shadow only, no transform) that
  // the global reduced-motion reset collapses to ~0 duration; either way it self-clears.
  React.useEffect(() => {
    if (!pendingAnchor || loading || !prefs) return;
    // Defer to the next frame so the freshly-rendered section body is in the DOM.
    const raf = window.requestAnimationFrame(() => {
      let el: HTMLElement | null = null;
      try {
        el = document.getElementById(pendingAnchor);
      } catch {
        el = null;
      }
      if (el) {
        el.scrollIntoView({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
        el.classList.add('animate-settings-highlight');
        window.setTimeout(() => el?.classList.remove('animate-settings-highlight'), 1800);
      }
      setPendingAnchor(null);
    });
    return () => window.cancelAnimationFrame(raf);
    // Re-run when the section changes (a deep-link switches section then anchors).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnchor, section, loading, prefs, reducedMotion]);

  // buffered secret entries (write-only)
  const [secretDraft, setSecretDraft] = React.useState<Record<string, string>>({});

  // Per-section dirty map: the set of CHANGED top-level editable keys (vs the saved
  // snapshot). Drives the sticky save bar, per-section "modified" dots, and a MINIMAL
  // Save patch (only the changed keys, never the whole object). `sources`/
  // `setup_complete` are excluded as non-editable.
  const changed = React.useMemo(
    () =>
      computeChangedKeys(
        prefs as Record<string, unknown> | null,
        savedPrefs as Record<string, unknown> | null,
      ),
    [prefs, savedPrefs],
  );
  const dirty = changed.size > 0;
  const changedCount = changed.size;
  const pendingSecretCount = React.useMemo(
    () => Object.values(secretDraft).filter((value) => value.trim().length > 0).length,
    [secretDraft],
  );
  // Settings holds both ordinary preference drafts and write-only secret drafts.
  // Neither may disappear silently on reload/tab close; keep this hook above every
  // loading/error early return so the hook order remains stable through first load.
  useUnsavedChanges(dirty || pendingSecretCount > 0);
  useNavigationBlocker(dirty || pendingSecretCount > 0, {
    title: 'Leave Settings with unsaved changes?',
    description:
      'Your preference and secret drafts have not been saved. Leave this page and discard them?',
    confirmLabel: 'Leave Settings',
    cancelLabel: 'Keep editing',
  });

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, mdl] = await Promise.all([
        api.getSettings(),
        api.getModels().catch(() => null),
      ]);
      setPrefs(settings.prefs);
      setSavedPrefs(settings.prefs);
      setConfigured(settings.configured);
      setReadOnly(settings.read_only);
      setModels(mdl);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const update = React.useCallback(
    (patch: Partial<Preferences>) => setPrefs((p) => (p ? { ...p, ...patch } : p)),
    [],
  );

  const save = React.useCallback(async () => {
    if (!prefs) return;
    // Send ONLY the changed top-level keys (a minimal patch) rather than the whole
    // object — additive/omitted fields are safe, and we never clobber a key the user
    // did not touch (the backend PUT deep-merges). `sources`/`setup_complete` are
    // excluded inside `changedPatch`.
    const patch = changedPatch(
      prefs as Record<string, unknown>,
      savedPrefs as Record<string, unknown> | null,
    );
    const secretPatch: Record<string, string> = {};
    for (const [key, value] of Object.entries(secretDraft)) {
      if (value && value.trim()) secretPatch[key] = value;
    }
    const preferenceCount = Object.keys(patch).length;
    const secretCount = Object.keys(secretPatch).length;
    if (!preferenceCount && !secretCount) {
      toast.message('No changes to save.');
      return;
    }
    setSaving(true);
    let preferencesSaved = false;
    if (preferenceCount) {
      try {
        const res = await api.putSettings(patch as Partial<Preferences>);
        setPrefs(res.prefs);
        setSavedPrefs(res.prefs);
        // Re-derive the settings lock from the saved response (mirrors the backend's
        // `read_only` = `read_only_settings_mode`), so toggling the lock ON/OFF takes
        // effect immediately instead of only after a full reload.
        setReadOnly(Boolean((res.prefs as Record<string, unknown>).read_only_settings_mode));
        preferencesSaved = true;
      } catch (e) {
        toast.error(errMsg(e, 'Could not save settings.'));
        setSaving(false);
        return;
      }
    }

    if (secretCount) {
      try {
        const res = await api.updateSecrets(secretPatch);
        setConfigured(res.configured);
        // Clear only the values that were actually submitted. This keeps a newer value
        // recoverable if an input event landed while the request was being scheduled.
        setSecretDraft((current) => {
          const next = { ...current };
          for (const [key, submitted] of Object.entries(secretPatch)) {
            if (next[key] === submitted) delete next[key];
          }
          return next;
        });
      } catch (e) {
        toast.error(
          preferencesSaved
            ? `Preferences were saved, but secret keys still need attention. ${errMsg(e, 'Could not update keys.')}`
            : errMsg(e, 'Could not update keys.'),
        );
        setSaving(false);
        return;
      }
    }

    toast.success(
      preferenceCount && secretCount
        ? 'Settings and secret keys saved.'
        : secretCount
          ? 'Secret keys updated.'
          : 'Settings saved.',
    );
    setSaving(false);
  }, [prefs, savedPrefs, secretDraft]);

  // Discard: revert the working draft to the last saved snapshot (a clean revert,
  // not a re-fetch, so an in-flight server change is not pulled in mid-edit).
  const discard = React.useCallback(() => {
    setPrefs(savedPrefs);
    setSecretDraft({});
  }, [savedPrefs]);

  // Filtered, RBAC-aware grouped section list for the rail. A section with a `perm`
  // is hidden from users without the grant; the search matches title/blurb/keywords.
  // RULES OF HOOKS: these hooks MUST run unconditionally — i.e. ABOVE the
  // `if (loading)` / `if (!prefs)` early returns below. If they sit after a return,
  // the hook count changes once `loading` flips false on the first data load and React
  // throws #310 ("Rendered more hooks than during the previous render"). They read only
  // query/hasPermission/section state (never `prefs`), so hoisting is safe. Do NOT move
  // them back down, and do not add early returns between hooks.
  const visibleGroups = React.useMemo(() => {
    return SECTION_GROUPS.map((g) => ({
      ...g,
      sections: g.sections.filter((s) => {
        if (s.perm && !hasPermission(s.perm.resource, s.perm.action)) return false;
        // Round-5 Sett-C: deepened section- AND setting-level match — a hit on any card
        // within a section (e.g. "auto-close", "kill switch") keeps the section visible.
        return sectionMatchesQuery(s, query);
      }),
    })).filter((g) => g.sections.length > 0);
  }, [hasPermission, query]);

  const flatVisible = React.useMemo(
    () => visibleGroups.flatMap((g) => g.sections),
    [visibleGroups],
  );

  // If a search/RBAC change hides the active section, jump to the first visible one.
  // Use `setSection` (the hash-writing callback) — NOT the bare `setSectionState` — so
  // the `#/settings?s=<id>` hash stays in sync with the auto-selected section (otherwise
  // a reload / back-forward would snap back to the now-hidden section id).
  React.useEffect(() => {
    if (flatVisible.length && !flatVisible.some((s) => s.id === section)) {
      setSection(flatVisible[0].id as SectionId);
    }
  }, [flatVisible, section, setSection]);

  /* ------------------------------------------------------------- states ---- */

  if (loading) {
    return (
      <PageContainer variant="wide" className="space-y-6">
        <PageHeader icon={SettingsIcon} eyebrow="Platform" title="Settings" />
        <LoadingState
          label="Loading settings"
          description="Retrieving your preferences and access controls."
          layout="page"
          shape="panel"
        />
      </PageContainer>
    );
  }

  if (!prefs) {
    return (
      <PageContainer variant="wide" className="space-y-6">
        <PageHeader icon={SettingsIcon} eyebrow="Platform" title="Settings" />
        <LoadError
          error={error}
          fallback="The backend did not return preferences. Check connectivity and try again."
          title="Could not load settings"
          onRetry={() => void load()}
        />
      </PageContainer>
    );
  }

  // The single render context handed to whichever section is active. `prefs` is
  // guaranteed non-null here (past the early returns above).
  const renderCtx: SectionRenderContext = {
    prefs,
    persistedPrefs: savedPrefs ?? prefs,
    update,
    models,
    configured,
    readOnly,
    onNavigate: onNavigate as SectionRenderContext['onNavigate'],
    setSection,
    secretDraft,
    setSecretDraft,
    saving,
  };

  /**
   * Render the active section from the registry. Perm-gated sections are wrapped in a
   * <Can> guard so a direct deep-link (`#/settings?s=admin_users`) that bypasses the
   * rail filter still degrades to a "restricted" notice rather than the body. The
   * no-perm personal sections (profile/account_security/sessions/customization/
   * general/models/keys/standup/enrichment) render unguarded (auth-off back-compat).
   */
  const renderSection = (def: SettingsSectionDef): React.ReactNode => {
    const body = def.Component(renderCtx);
    if (!def.perm) return body;
    const { resource, action } = def.perm;
    return (
      <Can
        resource={resource}
        action={action}
        fallback={
          <EmptyState
            icon={def.icon}
            title="Restricted"
            description={`${def.title} is managed by administrators.`}
          />
        }
      >
        {body}
      </Can>
    );
  };

  const activeDef = SECTION_BY_ID[section] ?? SECTION_BY_ID.general;
  const ActiveSectionIcon = activeDef.icon;
  const isGrid = GRID_SECTIONS.has(activeDef.id);
  const activeGroup = SECTION_GROUPS.find((group) =>
    group.sections.some((candidate) => candidate.id === activeDef.id),
  );
  const activeSectionDirty =
    sectionIsDirty(activeDef.id, changed) || (activeDef.id === 'keys' && pendingSecretCount > 0);
  const pendingChangeCount = changedCount + pendingSecretCount;

  const selectFromCompactNav = (id: SectionId, anchor?: string) => {
    setSection(id, anchor);
    setMobileNavOpen(false);
  };

  // When the settings lock is ON, Save is disabled — EXCEPT when the operator's pending
  // draft turns the lock itself back OFF. That is the one PUT the backend explicitly
  // permits while locked (`read_only_settings_mode: false`), so blocking it would make
  // the lock a one-way trap only recoverable via a raw API call.
  const unlockingNow =
    readOnly && (prefs as Record<string, unknown>).read_only_settings_mode === false;
  const saveLocked = readOnly && !unlockingNow;

  return (
    <PageContainer variant="wide" className="space-y-5">
      <PageHeader
        icon={SettingsIcon}
        breadcrumb={[{ label: 'Platform' }]}
        title="Settings"
        description="Configure how Agentic SOC ingests, investigates, automates, and governs your workspace."
        meta={
          <div aria-live="polite">
            {readOnly ? (
              <Badge variant="warning">
                <Lock className="h-3 w-3" aria-hidden />
                Read-only
              </Badge>
            ) : dirty || pendingSecretCount > 0 ? (
              <Badge variant="warning">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                {pendingChangeCount} pending {pendingChangeCount === 1 ? 'change' : 'changes'}
              </Badge>
            ) : (
              <Badge variant="outline">
                <CheckCircle2 className="h-3 w-3 text-success-text" aria-hidden />
                Preferences saved
              </Badge>
            )}
          </div>
        }
        actions={
          onRerunWizard ? (
            <Button variant="outline" size="sm" onClick={onRerunWizard}>
              <Wand2 className="h-4 w-4" aria-hidden />
              Re-run setup wizard
            </Button>
          ) : null
        }
      />

      {readOnly ? (
        <Alert variant="warning">
          <Lock className="h-4 w-4" aria-hidden />
          <AlertTitle>Read-only mode</AlertTitle>
          <AlertDescription>
            Settings are read-only in this deployment. Edits cannot be saved — turn the
            lock off in Advanced › Settings lock to make changes again.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Narrow layouts use a single contextual chooser instead of stacking the entire
          25-section rail above the active editor. The full grouped/searchable list mounts
          inside the Sheet only while open. */}
      <div className="lg:hidden">
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-auto w-full justify-between px-3 py-2 text-left"
              data-testid="settings-mobile-nav-trigger"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Menu className="h-4 w-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {activeGroup?.label ?? 'Settings'}
                  </span>
                  <span className="block truncate text-sm text-foreground">{activeDef.title}</span>
                </span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" size="sm" className="gap-0">
            <SheetHeader>
              <SheetTitle>Settings</SheetTitle>
              <SheetDescription>Choose a configuration section.</SheetDescription>
            </SheetHeader>
            <div className="border-b border-border p-4">
              <SettingsSearch id="settings-search-compact" value={query} onChange={setQuery} />
            </div>
            <nav
              aria-label="Settings categories"
              data-testid="settings-compact-section-scroll"
              className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-4"
            >
              {flatVisible.length === 0 ? (
                <p className="px-2 py-4 text-sm text-muted-foreground">No sections match “{query}”.</p>
              ) : (
                <SettingsSectionList
                  groups={visibleGroups}
                  activeSection={section}
                  changed={changed}
                  query={query}
                  onSelect={selectFromCompactNav}
                  pendingSecretChanges={pendingSecretCount > 0}
                  compact
                />
              )}
            </nav>
          </SheetContent>
        </Sheet>
      </div>

      <div className="grid border-t border-border lg:grid-cols-[248px_minmax(0,1fr)]">
        {/* Desktop section rail: one quiet, sticky configuration index with the search
            fixed above a separately scrolling registry-derived section list. */}
        <aside className="hidden border-r border-border pr-5 pt-5 lg:block">
          <nav
            aria-label="Settings categories"
            className="sticky top-[calc(var(--header-h)+1rem)] flex max-h-[calc(100dvh-var(--header-h)-2rem)] min-h-0 flex-col"
          >
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Configuration
              </span>
              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                {flatVisible.length} sections
              </span>
            </div>
            <SettingsSearch id="settings-search-desktop" value={query} onChange={setQuery} />
            <div
              data-testid="settings-desktop-section-scroll"
              className="mt-4 min-h-0 overflow-y-auto overscroll-y-contain pr-1"
            >
              {flatVisible.length === 0 ? (
                <p className="px-2 py-4 text-sm text-muted-foreground">No sections match “{query}”.</p>
              ) : (
                <SettingsSectionList
                  groups={visibleGroups}
                  activeSection={section}
                  changed={changed}
                  query={query}
                  onSelect={setSection}
                  pendingSecretChanges={pendingSecretCount > 0}
                />
              )}
            </div>
          </nav>
        </aside>

        {/* The renderer owns the one visible section heading. This compact context line
            supplies location and draft status without repeating that title as another h2. */}
        <div className="min-w-0 space-y-5 pt-5 lg:pl-8">
          <div
            data-testid="settings-active-context"
            className="flex min-h-9 flex-wrap items-center justify-between gap-3 border-b border-border pb-3"
          >
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <ActiveSectionIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="truncate text-muted-foreground">{activeGroup?.label ?? 'Settings'}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
              <span className="truncate font-medium text-foreground">{activeDef.title}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {/* "Ask about this" (SPEC §10.7): a new chat asks this section's templated
                  question; shown only to a caller who can use chat. */}
              <AskAboutThis topic={settingsTopic(activeDef.id)} subject={activeDef.title} />
              <span className={cn('text-xs', activeSectionDirty ? 'text-warning-text' : 'text-muted-foreground')}>
                {activeSectionDirty ? 'Modified in this section' : 'No unsaved changes in this section'}
              </span>
            </div>
          </div>

          <section className={cn('min-w-0', !isGrid && 'border-b border-border pb-6')}>
            {renderSection(activeDef)}
          </section>

          {/* One Settings-wide save/discard bar for ordinary preferences and write-only
              secret drafts. Each API keeps its narrow partial-update contract. */}
          <StickySaveBar
            visible={dirty || pendingSecretCount > 0}
            busy={saving}
            saveDisabled={saveLocked}
            onSave={() => void save()}
            onDiscard={discard}
            saveLabel={unlockingNow ? 'Unlock & save' : 'Save changes'}
            message={
              saveLocked
                ? 'Settings are read-only — turn the lock off (Advanced › Settings lock) to save.'
                : unlockingNow
                  ? `Saving will unlock settings and apply ${pendingChangeCount} pending ${pendingChangeCount === 1 ? 'change' : 'changes'}.`
                  : changedCount > 0 && pendingSecretCount > 0
                    ? `${pendingChangeCount} unsaved changes: ${changedCount} ${changedCount === 1 ? 'preference' : 'preferences'} and ${pendingSecretCount} secret ${pendingSecretCount === 1 ? 'value' : 'values'}.`
                    : pendingSecretCount > 0
                      ? `${pendingSecretCount} unsaved secret ${pendingSecretCount === 1 ? 'value' : 'values'}.`
                      : `${changedCount} unsaved ${changedCount === 1 ? 'change' : 'changes'}.`
            }
          />

          <p className="flex items-start gap-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Preference changes take effect after Save. Secret values stay write-only; the
              Console only reports whether a key is configured.
            </span>
          </p>
        </div>
      </div>
    </PageContainer>
  );
}
