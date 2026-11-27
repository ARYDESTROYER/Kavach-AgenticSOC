/**
 * CustomizationSection: Settings > Account > Appearance (Wave 7; renamed in Round 14).
 *
 * Two-store model surfaced in one panel:
 *  - PERSONAL (every signed-in user): the colour-mode theme, "Reduce transparency"
 *    (Round 12: the in-app override for browsers that never report
 *    `prefers-reduced-transparency`) + a manager for the user's saved views (delete +
 *    clone an org-shared one into the personal set).
 *  - ORG (admin-only, wrapped in <Can>): the terminology label editor. Edits go through
 *    `api.terminology.put`, then the cascade is refreshed so the change applies at once.
 *  - The organization default theme is Branding's `default_theme`, the only one (Round 16
 *    B45). This panel shows it read-only and links administrators to Branding; it never
 *    writes the legacy `customization.default_theme`.
 *
 * SECURITY (#9): every terminology key/label + saved-view name is user/operator DATA,
 * rendered as plain text, never markup, never an LLM-prompt input.
 *
 * IMPORTANT (React #310): every hook is declared at the top of the component, ABOVE
 * any conditional return.
 */
import * as React from 'react';
import { Sun, Moon, Monitor, Trash2, Copy, Save, Bookmark, Users } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { ThemeMode } from '@/lib/types';
import { usePrefs, DEFAULT_TERMS } from '@/soc/prefs';
import { useTheme } from '@/soc/theme';
import { effectiveBrandingTheme } from '@/soc/theme-tokens';
import { settingsSectionHash } from '@/soc/router';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';
import { Can, useCan } from '@/soc/components/Can';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { SectionTitle } from '@/soc/pages/settings/primitives';
import {
  applyTransparencyPreference,
  TRANSPARENCY_PREF_KEY,
  type TransparencyPreference,
} from '@/design-system/transparency';
import { toast } from 'sonner';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** The words for an organization default theme (Branding `default_theme`). */
const ORG_THEME_LABEL: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Branding, where the organization default theme is changed (Settings, Branding). */
const BRANDING_HREF = settingsSectionHash('appearance');

const TRANSPARENCY_OPTIONS: Array<{ value: TransparencyPreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'reduced', label: 'On' },
];

/**
 * The high-traffic terminology keys offered in the editor (each defaulted). Each field is
 * labelled by the word it renames, never by its stored key; the key is only the wire name.
 */
const TERM_KEYS: Array<{ key: string; label: string; help: string }> = [
  { key: 'cases', label: 'Cases (plural)', help: 'In navigation and page titles.' },
  { key: 'case', label: 'Case (singular)', help: 'In sentences, for example "this case".' },
  { key: 'alerts', label: 'Alerts (plural)', help: 'Where alerts are listed.' },
  { key: 'alert', label: 'Alert (singular)', help: 'In sentences, for example "this alert".' },
  { key: 'sources', label: 'Sources (plural)', help: 'In navigation and page titles.' },
  { key: 'source', label: 'Source (singular)', help: 'In sentences, for example "this source".' },
  { key: 'analyst', label: 'Analyst', help: 'The role of the people who triage cases.' },
];

export const CustomizationSection: React.FC = () => {
  const { prefs, themeMode, setThemeMode, savedViews, deleteView, cloneView, refresh, patchMisc } = usePrefs();
  const isAdmin = useCan('settings', 'manage');
  // The one organization default theme is Branding's (B45), read here, never written.
  const { branding } = useTheme();
  const orgDefault = effectiveBrandingTheme(branding);
  const brandingHref = safeRouteHref(BRANDING_HREF);
  const openBranding = useRouteLinkClick(brandingHref);

  // "Reduce transparency": start from what the page is showing right now (the pre-paint
  // stamp from this device's mirror, or the account value prefs.tsx already applied),
  // then follow the account's stored choice once the cascade hydrates.
  const [transparency, setTransparency] = React.useState<TransparencyPreference>(() =>
    document.documentElement.dataset.transparency === 'reduced' ? 'reduced' : 'system',
  );
  const storedTransparency = prefs.misc?.[TRANSPARENCY_PREF_KEY];
  React.useEffect(() => {
    if (storedTransparency === 'reduced' || storedTransparency === 'system') {
      setTransparency(storedTransparency);
    }
  }, [storedTransparency]);
  const changeTransparency = React.useCallback((next: TransparencyPreference) => {
    // Optimistic, like the theme: apply now, persist to the account in the background.
    // The device mirror keeps the choice here even if the save fails.
    setTransparency(next);
    applyTransparencyPreference(next);
    void api.prefs.putUser({ misc: { [TRANSPARENCY_PREF_KEY]: next } }).catch(() => {
      /* best-effort: the local apply already happened */
    });
  }, []);

  // ORG terminology draft (admin). Hydrated from the org prefs on mount.
  const [terms, setTerms] = React.useState<Record<string, string>>({});
  const [orgLoaded, setOrgLoaded] = React.useState(false);
  const [savingOrg, setSavingOrg] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const org = await api.prefs.getOrg();
        if (!alive) return;
        setTerms({ ...(org.terminology ?? {}) });
      } catch {
        /* non-admins may 403 on a future write; the GET is allowed, but be safe */
      } finally {
        if (alive) setOrgLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setTerm = (key: string, value: string) =>
    setTerms((t) => ({ ...t, [key]: value }));

  // Drop blank labels so they fall back to the built-in default.
  const cleanTerms = (raw: Record<string, string>): Record<string, string> => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && v.trim()) cleaned[k] = v;
    }
    return cleaned;
  };

  const saveTerminology = async () => {
    setSavingOrg(true);
    const cleaned = cleanTerms(terms);
    try {
      await api.terminology.put(cleaned);
      await refresh();
      toast.success('Terminology saved');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not save terminology';
      toast.error(msg);
    } finally {
      setSavingOrg(false);
    }
  };

  return (
    <div className="space-y-0" data-testid="customization-settings-surface">
      <SectionTitle
        title="Appearance"
        sub="Choose your personal theme and manage saved views. Administrators also set the organization's terminology."
      />

      {/* ---- Personal theme -------------------------------------------------- */}
      <section className="space-y-3 py-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Theme</h3>
          <p className="text-sm text-muted-foreground">
            Your personal colour mode, saved to your account so it follows you across
            devices. “System” follows the organization default theme when one is set,
            otherwise your device setting.
          </p>
        </div>
        <SegmentedControl
          aria-label="Personal colour mode"
          value={themeMode}
          onValueChange={setThemeMode}
          size="sm"
          options={THEME_OPTIONS.map(({ value, label, icon: Icon }) => ({
            value,
            // Keep the selector as compact as the reference control while retaining
            // a complete accessible name for each radio segment.
            label: <span className="sr-only">{label}</span>,
            icon: <Icon aria-hidden />,
          }))}
          className="max-w-full"
        />
        {orgDefault ? (
          <p className="text-sm text-muted-foreground" data-testid="org-default-theme">
            Organization default: {ORG_THEME_LABEL[orgDefault]}.
            {isAdmin && brandingHref ? (
              <>
                {' '}
                <a
                  href={brandingHref}
                  onClick={openBranding}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  Change it in Branding
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {/* ---- Reduce transparency (personal) --------------------------------- */}
      <section className="space-y-3 border-t border-border py-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Reduce transparency</h3>
          <p className="text-sm text-muted-foreground">
            Shows the top bar and sticky toolbars as solid surfaces instead of frosted
            glass. “System” follows your device’s Reduce transparency setting, but Safari
            and Firefox don’t pass that setting on, so choose “On” to apply it there.
            Saved to your account.
          </p>
        </div>
        <SegmentedControl
          aria-label="Reduce transparency"
          value={transparency}
          onValueChange={changeTransparency}
          size="sm"
          options={TRANSPARENCY_OPTIONS}
          className="max-w-full"
        />
      </section>

      {/* ---- What's new after updates (personal, Round 16 D7) ---------------- */}
      <section className="border-t border-border py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="whats-new-auto-label" className="text-sm font-semibold text-foreground">
              Show What&apos;s new after updates
            </h3>
            <p id="whats-new-auto-help" className="text-sm text-muted-foreground">
              After an update, a short welcome shows once with what changed. Every release
              stays in Communication, What&apos;s new. Saved to your account.
            </p>
          </div>
          <Switch
            aria-labelledby="whats-new-auto-label"
            aria-describedby="whats-new-auto-help"
            checked={prefs.misc?.whats_new_auto !== false}
            onCheckedChange={(on) => void patchMisc({ whats_new_auto: on })}
            className="mt-0.5"
            data-testid="whats-new-auto-switch"
          />
        </div>
      </section>

      {/* ---- Saved views (personal) ----------------------------------------- */}
      <section className="space-y-3 border-t border-border py-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Saved views</h3>
          <p className="text-sm text-muted-foreground">
            Reusable list configurations. Create them from a list’s “Save view”
            button; manage them here. Views shared with the organization are marked.
          </p>
        </div>
        {savedViews.length === 0 ? (
          <div className="flex items-center gap-2 border-y border-dashed border-border px-1 py-4 text-sm text-muted-foreground">
            <Bookmark className="size-4" aria-hidden />
            No saved views yet. Save one from the Cases list.
          </div>
        ) : (
          <ul className="divide-y divide-border border-y border-border" data-testid="saved-views-list">
            {savedViews.map((v) => (
              <li key={v.id} className="flex items-center gap-2 px-3 py-2">
                <Bookmark className="size-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{v.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {v.scope || 'cases'}
                  </span>
                </span>
                {v.shared ? (
                  <Badge variant="secondary" className="gap-1">
                    <Users className="size-3" aria-hidden />
                    Shared
                  </Badge>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Clone ${v.name}`}
                  onClick={() =>
                    void cloneView(v.id).then((c) =>
                      c
                        ? toast.success(`Cloned “${v.name}”`)
                        : toast.error(`Could not clone “${v.name}”`),
                    )
                  }
                >
                  <Copy className="size-4" aria-hidden />
                </Button>
                {!v.shared ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    // Neutral at rest; red only on hover and focus (SPEC §4.9.2 RowActions).
                    className="size-8 text-muted-foreground hover:bg-critical/10 hover:text-critical-text focus-visible:text-critical-text"
                    aria-label={`Delete ${v.name}`}
                    onClick={() =>
                      void deleteView(v.id).then((ok) =>
                        ok
                          ? toast.success(`Deleted “${v.name}”`)
                          : toast.error(`Could not delete “${v.name}”`),
                      )
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Terminology (admin only) ---------------------------------------- */}
      <Can resource="settings" action="manage">
        <section className="space-y-4 border-t border-border py-5">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Terminology <span className="text-xs font-normal text-muted-foreground">(organization default, administrators)</span>
            </h3>
            <p className="text-sm text-muted-foreground">
              Rename high-traffic labels organization-wide (for example, call a case an “incident”).
              Leave blank to use the built-in label. Plain text only.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {TERM_KEYS.map(({ key, label, help }) => (
              <div key={key} className="space-y-1">
                {/* Named by its visible label (WCAG 2.5.3); the built-in word is the
                    placeholder, and the help line says where the word appears. */}
                <Label htmlFor={`term-${key}`} className="text-sm font-medium text-foreground">
                  {label}
                </Label>
                <Input
                  id={`term-${key}`}
                  value={terms[key] ?? ''}
                  onChange={(e) => setTerm(key, e.target.value)}
                  placeholder={DEFAULT_TERMS[key] ?? key}
                  aria-describedby={`term-${key}-help`}
                  disabled={!orgLoaded}
                  maxLength={120}
                />
                <p id={`term-${key}-help`} className="text-xs text-muted-foreground">
                  {help}
                </p>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void saveTerminology()} disabled={savingOrg || !orgLoaded}>
              <Save className="mr-1.5 size-4" aria-hidden />
              Save terminology
            </Button>
          </div>

        </section>
      </Can>

      {!isAdmin ? (
        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Terminology is managed by an administrator.
        </p>
      ) : null}
    </div>
  );
};

export default CustomizationSection;
