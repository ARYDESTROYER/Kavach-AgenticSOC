/**
 * CustomizationSection: Settings > Account > Appearance (Wave 7; renamed in Round 14).
 *
 * Two-store model surfaced in one panel:
 *  - PERSONAL (every signed-in user): the colour-mode theme, "Reduce transparency"
 *    (Round 12: the in-app override for browsers that never report
 *    `prefers-reduced-transparency`) + a manager for the user's saved views (delete +
 *    clone an org-shared one into the personal set).
 *  - ORG (admin-only, wrapped in <Can>): the terminology label editor + the org
 *    default theme. Org edits go through `api.prefs.putOrg` / `api.terminology.put`,
 *    then the cascade is refreshed so the change applies immediately.
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
import type { OrgCustomization, ThemeMode } from '@/lib/types';
import { usePrefs, DEFAULT_TERMS } from '@/soc/prefs';
import { Can, useCan } from '@/soc/components/Can';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { SectionTitle } from '@/soc/pages/settings/primitives';
import {
  applyTransparencyPreference,
  TRANSPARENCY_PREF_KEY,
  type TransparencyPreference,
} from '@/design-system/transparency';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import { toast } from 'sonner';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

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
  const { prefs, themeMode, setThemeMode, savedViews, deleteView, cloneView, refresh } = usePrefs();
  const isAdmin = useCan('settings', 'manage');

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
  const [orgTheme, setOrgTheme] = React.useState<ThemeMode>('system');
  // The FULL org customization as last loaded, so a partial save (e.g. "Save default"
  // theme) can round-trip the fields this panel has no editor for (org saved views,
  // pinned view ids, and per-role default dashboards). `PUT /api/prefs/org` REPLACES the
  // whole object (no server-side merge), so omitting them would silently wipe them.
  const [orgFull, setOrgFull] = React.useState<OrgCustomization>({});
  const [orgLoaded, setOrgLoaded] = React.useState(false);
  const [savingOrg, setSavingOrg] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const org = await api.prefs.getOrg();
        if (!alive) return;
        setOrgFull(org);
        setTerms({ ...(org.terminology ?? {}) });
        setOrgTheme((org.default_theme as ThemeMode) ?? 'system');
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
      setOrgFull((o) => ({ ...o, terminology: cleaned }));
      await refresh();
      toast.success('Terminology saved');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not save terminology';
      toast.error(msg);
    } finally {
      setSavingOrg(false);
    }
  };

  const saveOrgDefaults = async () => {
    setSavingOrg(true);
    try {
      // Spread the full loaded org so the REPLACE PUT preserves fields with no editor
      // here (saved views / pinned ids / default dashboards); override only the theme,
      // and carry the latest terminology draft so an unsaved rename isn't reverted.
      const patch: OrgCustomization = {
        ...orgFull,
        terminology: cleanTerms(terms),
        default_theme: orgTheme,
      };
      const saved = await api.prefs.putOrg(patch);
      setOrgFull(saved);
      await refresh();
      toast.success('Organization defaults saved');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not save organization defaults';
      toast.error(msg);
    } finally {
      setSavingOrg(false);
    }
  };

  return (
    <div className="space-y-0" data-testid="customization-settings-surface">
      <SectionTitle
        title="Appearance"
        sub="Choose your personal theme and manage saved views. Administrators also set the organization's terminology and default theme."
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

      {/* ---- Terminology + org defaults (admin only) ------------------------ */}
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

          <div className="space-y-2 pt-2">
            <Label id="org-default-theme-label" className="text-sm font-medium text-foreground">
              Organization default theme
            </Label>
            <div className="flex items-center gap-2">
              <Select value={orgTheme} onValueChange={(v) => setOrgTheme(v as ThemeMode)}>
                <SelectTrigger className="w-[12rem]" aria-labelledby="org-default-theme-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void saveOrgDefaults()}
                disabled={savingOrg || !orgLoaded}
              >
                Save default
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Applied to users who haven’t picked their own theme.
            </p>
          </div>
        </section>
      </Can>

      {!isAdmin ? (
        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Terminology &amp; organization defaults are managed by an administrator.
        </p>
      ) : null}
    </div>
  );
};

export default CustomizationSection;
