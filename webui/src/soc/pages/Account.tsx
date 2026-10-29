/**
 * Profile: the signed-in user's own account (Round-2 Wave 2; Round 14 grouped panels).
 *
 * Edit display name, alias, avatar, secondary email, timezone and language. The username
 * and role are shown read-only (an administrator or SSO manages identity). A
 * "Two-factor authentication" row opens the Security and two-factor section.
 *
 * Backed by GET/PUT /api/account/me and PUT /api/me/avatar. The avatar is cropped and
 * resized to a 256 by 256 WebP in the browser (see lib/avatar) before upload, so the
 * stored string stays small; the backend validates it again. Secrets are never part of
 * this surface (#10), and every value rendered (display_name, alias, alt_email) is
 * user-entered, so it renders as plain text (#9).
 *
 * When auth is off, or the principal is the environment single admin (`env_managed`),
 * the profile is read-only and a note says why instead of editable fields.
 *
 * Round 14 (SPEC §4.9.6, D28): one `SettingsSection` ("Profile") inside Settings, the
 * page header on the standalone route, and two `SettingsGroup`s of `SettingRow`s.
 */
import * as React from 'react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { AccountProfile, AccountProfileBody } from '@/lib/types';
import { resizeAvatar, initialsFrom } from '@/lib/avatar';
import { humanizeToken, formatTimestamp, DASH } from '@/lib/format';
import { useAuth } from '@/soc/auth';
import { AuditLogLink } from '@/soc/components/audit/AuditLink';
import { useNavigateOptional } from '@/soc/router';
import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';
import { Field } from '@/soc/components/Field';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Callout, LoadingGlyph, LoadingState, StatusDot } from '@/design-system';
import { LoadError } from '@/soc/components/LoadError';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  SettingRow,
  SettingsGroup,
  SettingsPageSection,
} from '@/soc/pages/settings/primitives';
import { SECTION_META_BY_ID } from '@/soc/pages/settings/settings-sections-meta';

/** The section's help tip: the registry's `profile` help, the one source. */
const PROFILE_HELP = SECTION_META_BY_ID.profile?.help;

/**
 * Fired on `window` after a successful profile save, with the saved flat profile as its
 * detail, so a chat start screen loaded earlier in this tab greets by the new display
 * name at once (`chat/starters/greeting.ts` listens for the same name). A window event,
 * not a shared module: nothing on first paint changes for it.
 */
const ACCOUNT_PROFILE_SAVED_EVENT = 'soc:account-profile-saved';

function announceProfileSaved(profile: AccountProfile): void {
  window.dispatchEvent(new CustomEvent(ACCOUNT_PROFILE_SAVED_EVENT, { detail: profile }));
}

export interface AccountPageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (page: any, opts?: any) => void;
}

function errMsg(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** IANA timezone list (Intl when available; a small fallback otherwise). */
function timezoneOptions(): string[] {
  try {
    // Intl.supportedValuesOf is widely available; guard for older runtimes.
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (typeof fn === 'function') {
      const tz = fn('timeZone');
      if (Array.isArray(tz) && tz.length) return tz;
    }
  } catch {
    /* fall through to the static list */
  }
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Sao_Paulo',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Moscow',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
  ];
}

/** A short, curated locale list (BCP-47); a stored value off the list is still shown. */
const LOCALE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'German' },
  { value: 'fr-FR', label: 'French' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'nl-NL', label: 'Dutch' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'ar-SA', label: 'Arabic' },
];

const NONE = '__none__';

/** A round avatar with image + initials fallback (no Radix dependency on load). */
const AvatarBlock: React.FC<{ src?: string; name: string; size?: number }> = ({
  src,
  name,
  size = 64,
}) => {
  const [broken, setBroken] = React.useState(false);
  const dim = { width: size, height: size };
  if (src && !broken) {
    return (
      // onError is a broken-image fallback (swap to initials), not a user
      // interaction; the rule flags any handler on a non-interactive element.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      <img
        src={src}
        alt=""
        style={dim}
        onError={() => setBroken(true)}
        className="rounded-full border border-border object-cover"
      />
    );
  }
  return (
    <div
      style={dim}
      className="flex items-center justify-center rounded-full border border-border bg-primary/10 text-lg font-semibold text-primary"
      aria-hidden
    >
      {initialsFrom(name)}
    </div>
  );
};

export default function Account({ onNavigate }: AccountPageProps) {
  // Standalone route (`#/account` normally redirects into Settings): the two-factor row
  // opens the Security page. An explicit prop wins, else navigate from the router
  // context. The hook is called unconditionally (rules of hooks).
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  return <AccountInner onNavigateToSecurity={() => navigate('security')} />;
}

export interface AccountInnerProps {
  /**
   * Called by the two-factor row's "Manage" button. Embedded in Settings it opens the
   * Security and two-factor section; standalone it navigates to the Security page.
   * When omitted the button is hidden.
   */
  onNavigateToSecurity?: () => void;
  /** True when this body is hosted beneath the Settings page header. */
  embedded?: boolean;
}

/**
 * The self-service profile body. Exported so Settings can embed it as the Profile
 * section. No `<Can>` gate: every signed-in user edits their own profile (the backend
 * scopes it to the caller).
 */
export function AccountInner({ onNavigateToSecurity, embedded = false }: AccountInnerProps) {
  const { authEnabled, username: sessionUser, role: sessionRole } = useAuth();

  const [profile, setProfile] = React.useState<AccountProfile | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);

  // Editable form state (mirrors the editable subset of the profile).
  const [displayName, setDisplayName] = React.useState('');
  const [alias, setAlias] = React.useState('');
  const [altEmail, setAltEmail] = React.useState('');
  const [timezone, setTimezone] = React.useState('');
  const [locale, setLocale] = React.useState('');

  // Avatar state: a pending (browser-cropped) data URL not yet persisted.
  const [avatar, setAvatar] = React.useState('');
  const [avatarPending, setAvatarPending] = React.useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  // `api.account.*` return the flat profile (the route nests it under `user`).
  const hydrate = React.useCallback((p: AccountProfile) => {
    setProfile(p);
    setDisplayName(p.display_name ?? '');
    setAlias(p.alias ?? '');
    setAltEmail(p.alt_email ?? '');
    setTimezone(p.timezone ?? '');
    setLocale(p.locale ?? '');
    setAvatar(p.avatar ?? '');
    setAvatarPending(null);
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const p = await api.account.get();
      hydrate(p);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const envManaged = Boolean(profile?.env_managed);
  const editable = authEnabled && !envManaged && Boolean(profile);

  // The name shown in headers / the avatar fallback (display name wins).
  const shownName =
    (displayName || profile?.display_name || profile?.username || sessionUser || '').trim();
  const shownUser = (profile?.username || sessionUser || '').trim();
  const shownRole = profile?.role ?? sessionRole ?? '';

  const dirty = React.useMemo(() => {
    if (!profile) return false;
    return (
      displayName !== (profile.display_name ?? '') ||
      alias !== (profile.alias ?? '') ||
      altEmail !== (profile.alt_email ?? '') ||
      timezone !== (profile.timezone ?? '') ||
      locale !== (profile.locale ?? '')
    );
  }, [profile, displayName, alias, altEmail, timezone, locale]);
  // Account is self-saving even when embedded in Settings. Include a staged avatar:
  // it is already cropped in memory but is not durable until "Save photo" succeeds.
  useUnsavedChanges(dirty || avatarPending !== null, editable);

  const onSave = React.useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!editable || saving) return;
      // Light client-side email shape check (the backend validates authoritatively).
      if (altEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(altEmail.trim())) {
        toast.error('Enter a valid secondary email, or leave it blank.');
        return;
      }
      setSaving(true);
      const patch: AccountProfileBody = {
        display_name: displayName,
        alias,
        alt_email: altEmail,
        timezone,
        locale,
      };
      try {
        const next = await api.account.put(patch);
        hydrate(next);
        announceProfileSaved(next);
        toast.success('Profile saved.');
      } catch (err) {
        toast.error(errMsg(err, 'Could not save your profile.'));
      } finally {
        setSaving(false);
      }
    },
    [editable, saving, altEmail, displayName, alias, timezone, locale, hydrate],
  );

  // Pick + crop/resize an avatar; stage it for an explicit "Save photo".
  const onPickAvatar = React.useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await resizeAvatar(file);
      setAvatarPending(dataUrl);
    } catch (err) {
      toast.error(errMsg(err, 'Could not process that image.'));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }, []);

  const onSaveAvatar = React.useCallback(async () => {
    if (avatarPending == null || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const next = await api.account.avatar(avatarPending);
      hydrate(next);
      announceProfileSaved(next);
      toast.success('Photo updated.');
    } catch (err) {
      toast.error(errMsg(err, 'Could not update your photo.'));
    } finally {
      setAvatarBusy(false);
    }
  }, [avatarPending, avatarBusy, hydrate]);

  const onRemoveAvatar = React.useCallback(async () => {
    if (avatarBusy) return;
    // If only a pending (unsaved) crop exists, just discard it.
    if (avatarPending != null && !avatar) {
      setAvatarPending(null);
      return;
    }
    setAvatarBusy(true);
    try {
      const next = await api.account.avatar('');
      hydrate(next);
      announceProfileSaved(next);
      toast.success('Photo removed.');
    } catch (err) {
      toast.error(errMsg(err, 'Could not remove your photo.'));
    } finally {
      setAvatarBusy(false);
    }
  }, [avatarBusy, avatarPending, avatar, hydrate]);

  const tzOptions = React.useMemo(timezoneOptions, []);
  const previewAvatar = avatarPending ?? avatar;

  const busyLabel = saving ? 'Saving' : 'Save changes';

  return (
    <SettingsPageSection embedded={embedded} title="Profile" help={PROFILE_HELP}>
      {loading ? (
        <LoadingState
          layout="panel"
          shape="panel"
          label="Loading profile"
          description="Preparing your identity and personal preferences."
        />
      ) : loadError ? (
        <LoadError
          error={loadError}
          title="Couldn't load your profile"
          fallback="Could not load your profile."
          onRetry={() => void load()}
        />
      ) : (
        <>
          {!authEnabled ? (
            <Callout intent="warning" title="Sign-in is off">
              Authentication is disabled, so there is no signed-in account to edit. Profiles
              become available once sign-in is turned on.
            </Callout>
          ) : envManaged ? (
            <Callout intent="warning" title="Managed in configuration">
              This is the environment-provisioned administrator. Its profile is managed in
              configuration and cannot be edited here.
            </Callout>
          ) : null}

          <SettingsGroup
            title="Identity & photo"
            caption="Your username and role, and the photo the Console shows for you."
            data-testid="profile-identity-surface"
          >
            <SettingRow variant="block">
              <div className="flex min-w-0 items-center gap-4">
                <AvatarBlock src={previewAvatar} name={shownName} size={64} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-md font-semibold text-foreground">
                    {shownName || shownUser || DASH}
                  </p>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    <span>@{shownUser || DASH}</span>
                    {shownRole ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span>{humanizeToken(String(shownRole))}</span>
                      </>
                    ) : null}
                  </p>
                  {authEnabled && shownUser ? (
                    <AuditLogLink opts={{ scope: 'all', actor: shownUser }} className="mt-1 inline-block text-sm">
                      Your recent activity in the audit log
                    </AuditLogLink>
                  ) : null}
                </div>
              </div>
            </SettingRow>
            {editable ? (
              <SettingRow
                variant="action"
                label="Photo"
                help="Square images look best. Photos are resized to 256 by 256 pixels in your browser before upload."
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      aria-label="Upload avatar image"
                      onChange={(e) => void onPickAvatar(e.target.files?.[0])}
                    />
                    {previewAvatar ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void onRemoveAvatar()}
                        disabled={avatarBusy}
                      >
                        Remove
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileRef.current?.click()}
                      disabled={avatarBusy}
                    >
                      {previewAvatar ? 'Change photo' : 'Upload photo'}
                    </Button>
                    {avatarPending != null ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void onSaveAvatar()}
                        disabled={avatarBusy}
                        aria-busy={avatarBusy || undefined}
                      >
                        {avatarBusy ? <LoadingGlyph size="sm" className="size-4" aria-hidden /> : null}
                        Save photo
                      </Button>
                    ) : null}
                  </div>
                }
              />
            ) : null}
            {authEnabled && profile ? (
              <SettingRow
                variant="status"
                label="Two-factor authentication"
                help="A code from an authenticator app each time you sign in."
                status={
                  <StatusDot tone={profile.mfa_enabled ? 'success' : 'neutral'} data-testid="profile-mfa-status">
                    {profile.mfa_enabled ? 'On' : 'Off'}
                  </StatusDot>
                }
                action={
                  onNavigateToSecurity ? (
                    <Button type="button" variant="outline" size="sm" onClick={onNavigateToSecurity}>
                      {profile.mfa_enabled ? 'Manage' : 'Turn on'}
                    </Button>
                  ) : null
                }
              />
            ) : null}
          </SettingsGroup>

          <form onSubmit={onSave}>
            <SettingsGroup
              title="Personal details"
              caption="How the Console addresses you and formats your account activity."
              data-testid="profile-details-surface"
            >
              <SettingRow variant="field">
                <Field label="Display name" description="Shown across the Console instead of your username.">
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={shownUser}
                    maxLength={120}
                    disabled={!editable || saving}
                  />
                </Field>
              </SettingRow>
              <SettingRow variant="field">
                <Field label="Alias / handle" description="A short handle used in mentions and assignments.">
                  <Input
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    placeholder="nightshift"
                    maxLength={64}
                    disabled={!editable || saving}
                  />
                </Field>
              </SettingRow>
              <SettingRow variant="field">
                {/* A read-only input (not a bare div) so the label names it and assistive
                    technology announces a labelled, read-only field the user can copy. */}
                <Field label="Username" description="Managed by your administrator.">
                  <Input value={shownUser || DASH} readOnly className="bg-muted/40 text-muted-foreground" />
                </Field>
              </SettingRow>
              <SettingRow variant="field">
                <Field label="Secondary email" description="For notifications and account recovery.">
                  <Input
                    type="email"
                    value={altEmail}
                    onChange={(e) => setAltEmail(e.target.value)}
                    placeholder="you@example.com"
                    maxLength={254}
                    disabled={!editable || saving}
                  />
                </Field>
              </SettingRow>
              <SettingRow variant="field">
                <Field label="Timezone" description="Times in the Console show in this zone.">
                  {({ id, labelledBy, describedBy }) => (
                    <Select
                      value={timezone || NONE}
                      onValueChange={(v) => setTimezone(v === NONE ? '' : v)}
                      disabled={!editable || saving}
                    >
                      <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy} className="w-full">
                        <SelectValue placeholder="System default" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value={NONE}>System default</SelectItem>
                        {/* A stored zone missing from the list is still offered, so it is
                            never lost (a valid IANA zone on a runtime without
                            Intl.supportedValuesOf, for example). */}
                        {timezone && !tzOptions.includes(timezone) ? (
                          <SelectItem value={timezone}>{timezone}</SelectItem>
                        ) : null}
                        {tzOptions.map((tz) => (
                          <SelectItem key={tz} value={tz}>
                            {tz}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </SettingRow>
              <SettingRow variant="field">
                <Field label="Language" description="The language and number format the Console uses.">
                  {({ id, labelledBy, describedBy }) => (
                    <Select
                      value={locale || NONE}
                      onValueChange={(v) => setLocale(v === NONE ? '' : v)}
                      disabled={!editable || saving}
                    >
                      <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy} className="w-full">
                        <SelectValue placeholder="System default" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value={NONE}>System default</SelectItem>
                        {/* A stored locale missing from the list is still offered. */}
                        {locale && !LOCALE_OPTIONS.some((o) => o.value === locale) ? (
                          <SelectItem value={locale}>{locale}</SelectItem>
                        ) : null}
                        {LOCALE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </SettingRow>
              {editable ? (
                <SettingRow variant="block">
                  <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                    {profile?.last_login_at ? (
                      <span className="mr-auto text-sm text-muted-foreground">
                        Last sign-in {formatTimestamp(profile.last_login_at)}
                      </span>
                    ) : null}
                    <Button type="submit" disabled={saving || !dirty} aria-busy={saving || undefined}>
                      {saving ? <LoadingGlyph size="sm" className="size-4" aria-hidden /> : null}
                      {busyLabel}
                    </Button>
                  </div>
                </SettingRow>
              ) : null}
            </SettingsGroup>
          </form>
        </>
      )}
    </SettingsPageSection>
  );
}
