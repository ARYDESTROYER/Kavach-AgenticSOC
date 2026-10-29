/**
 * Account — self-service profile for the signed-in user (Round-2 Wave 2).
 *
 * Edit display name, alias, avatar, secondary email, timezone and locale. The
 * username + role are shown read-only (identity is managed by an admin / SSO).
 * A "Security & two-factor" link jumps to the MFA/SSO page.
 *
 * Backed by GET/PUT /api/account/me + PUT /api/me/avatar. The avatar is cropped &
 * resized to a 256×256 WebP in the browser (see lib/avatar) BEFORE upload, so the
 * stored string stays tiny; the backend validates it again. Secrets are never part
 * of this surface (#10), and every value rendered (display_name/alias/alt_email…)
 * is user-entered → PLAIN text (#9).
 *
 * When auth is OFF, or the principal is the env single-admin (`env_managed`), the
 * profile is read-only and we surface a gentle note instead of editable fields.
 */
import * as React from 'react';
import {
  UserCircle2,
  Save,
  Loader2,
  Upload,
  Trash2,
  ShieldCheck,
  Mail,
  Globe,
  Languages,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { AccountProfile, AccountProfileBody } from '@/lib/types';
import { resizeAvatar, initialsFrom } from '@/lib/avatar';
import { humanizeToken, formatTimestamp, DASH } from '@/lib/format';
import { useAuth } from '@/soc/auth';
import { AuditLogLink } from '@/soc/components/audit/AuditLink';
import { useNavigateOptional } from '@/soc/router';
import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';
import { PageHeader } from '@/soc/components/PageHeader';
import { SettingsCard } from '@/soc/components/SettingsGrid';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Card, CardContent } from '@/ui/card';
import { Separator } from '@/ui/separator';
import { LoadingState } from '@/design-system';
import { Alert, AlertDescription } from '@/ui/alert';
import { LoadError } from '@/soc/components/LoadError';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

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

/** A short, curated locale list (BCP-47) — operators can still see their stored value. */
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
  size = 80,
}) => {
  const [broken, setBroken] = React.useState(false);
  const dim = { width: size, height: size };
  if (src && !broken) {
    return (
      // onError is a broken-image fallback (swap to initials), not a user
      // interaction — the rule flags any handler on a non-interactive element.
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
      className="flex items-center justify-center rounded-full border border-border bg-primary/10 text-xl font-semibold text-primary"
      aria-hidden
    >
      {initialsFrom(name)}
    </div>
  );
};

export default function Account({ onNavigate }: AccountPageProps) {
  // Standalone route (cutover-safe; `#/account` normally redirects into Settings): the
  // "Security & two-factor" button navigates to the Security page. Coupling-A — an
  // explicit prop still wins, else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  return <AccountInner onNavigateToSecurity={() => navigate('security')} />;
}

export interface AccountInnerProps {
  /**
   * Called by the "Security & two-factor" button. When embedded in Settings this
   * jumps to the embedded Security section; standalone it navigates to /security.
   * When omitted the button is hidden.
   */
  onNavigateToSecurity?: () => void;
  /** True when this body is hosted beneath the Settings page header. */
  embedded?: boolean;
}

interface AccountSurfaceProps {
  embedded: boolean;
  title: string;
  description: string;
  testId: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

/**
 * Profile is both a standalone page and a Settings-hosted section. Keep the established
 * card presentation on the standalone route, but let Settings inherit its divider-led
 * section grammar instead of nesting framed cards inside the active workspace.
 */
function AccountSurface({
  embedded,
  title,
  description,
  testId,
  bodyClassName,
  children,
}: AccountSurfaceProps) {
  if (embedded) {
    return (
      <SettingsCard
        title={title}
        description={description}
        data-testid={testId}
        data-surface="embedded"
      >
        <div className={bodyClassName}>{children}</div>
      </SettingsCard>
    );
  }

  return (
    <Card data-testid={testId} data-surface="standalone">
      <CardContent className={bodyClassName ? `pt-6 ${bodyClassName}` : 'pt-6'}>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The self-service profile body, without the page wrapper. Exported so Settings can
 * embed it under the Account (Personal) group. No `<Can>` gate: every signed-in user
 * edits their OWN profile (the backend scopes it to the caller).
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

  // Avatar state — a pending (browser-cropped) data URL not yet persisted.
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

  return (
    <div className="space-y-6">
      <PageHeader
        embedded={embedded}
        eyebrow="Personal account"
        title="Profile"
        description="How you appear across the console. Identity (username, role) is managed by your administrator."
        icon={UserCircle2}
        actions={
          onNavigateToSecurity ? (
            <Button type="button" variant="outline" onClick={onNavigateToSecurity}>
              <ShieldCheck aria-hidden />
              Security &amp; two-factor
            </Button>
          ) : null
        }
      />

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
            <Alert>
              <Info aria-hidden />
              <AlertDescription>
                Authentication is disabled, so there is no signed-in account to edit. Profiles
                become available once auth is enabled.
              </AlertDescription>
            </Alert>
          ) : envManaged ? (
            <Alert>
              <Info aria-hidden />
              <AlertDescription>
                This is the environment-provisioned administrator. Its profile is managed via
                configuration and cannot be edited here.
              </AlertDescription>
            </Alert>
          ) : null}

          {/* ---- Identity + avatar ----------------------------------------- */}
          <AccountSurface
            embedded={embedded}
            title="Identity & photo"
            description="Your operator identity, role, and console avatar."
            testId="profile-identity-surface"
          >
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <AvatarBlock src={previewAvatar} name={shownName} size={80} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-lg font-semibold text-foreground">
                      {shownName || shownUser || DASH}
                    </span>
                    {shownRole ? (
                      <Badge variant="outline" className="font-normal">
                        {humanizeToken(String(shownRole))}
                      </Badge>
                    ) : null}
                    {profile?.mfa_enabled ? (
                      // Semantic success badge → AA-tuned `text-success-text` (the plain
                      // `text-success` FILL fails 4.5:1 as small text on the card).
                      <Badge variant="success" className="gap-1 font-normal">
                        <ShieldCheck className="h-3 w-3" aria-hidden />
                        2FA on
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    @{shownUser || DASH}
                  </p>
                  {authEnabled && shownUser ? (
                    <AuditLogLink opts={{ scope: 'all', actor: shownUser }} className="mt-1 inline-block text-sm">
                      Your recent activity in the audit log
                    </AuditLogLink>
                  ) : null}

                  {editable ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="hidden"
                        aria-label="Upload avatar image"
                        onChange={(e) => void onPickAvatar(e.target.files?.[0])}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileRef.current?.click()}
                        disabled={avatarBusy}
                      >
                        <Upload aria-hidden />
                        {previewAvatar ? 'Change photo' : 'Upload photo'}
                      </Button>
                      {avatarPending != null ? (
                        <Button type="button" size="sm" onClick={() => void onSaveAvatar()} disabled={avatarBusy}>
                          {avatarBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                          Save photo
                        </Button>
                      ) : null}
                      {previewAvatar ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          onClick={() => void onRemoveAvatar()}
                          disabled={avatarBusy}
                        >
                          <Trash2 aria-hidden />
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Square images look best. Photos are resized to 256×256 in your browser before upload.
                  </p>
                </div>
              </div>
          </AccountSurface>

          {/* ---- Editable fields ------------------------------------------- */}
          <form onSubmit={onSave}>
            <AccountSurface
              embedded={embedded}
              title="Personal details"
              description="Choose how the console addresses you and formats account activity."
              testId="profile-details-surface"
              bodyClassName="space-y-5"
            >
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="acct-display">Display name</Label>
                    <Input
                      id="acct-display"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder={shownUser}
                      maxLength={120}
                      disabled={!editable || saving}
                    />
                    <p className="text-xs text-muted-foreground">Shown across the console instead of your username.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="acct-alias">Alias / handle</Label>
                    <Input
                      id="acct-alias"
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                      placeholder="e.g. nightshift"
                      maxLength={64}
                      disabled={!editable || saving}
                    />
                    <p className="text-xs text-muted-foreground">A short handle used in mentions &amp; assignments.</p>
                  </div>
                </div>

                <Separator />

                <div className="grid gap-5 sm:grid-cols-2">
                  {/* Username (read-only identity). A readOnly Input (not a bare div)
                      so the Label associates via htmlFor and AT announces it as a
                      labelled, read-only field the user can still select/copy. */}
                  <div className="space-y-1.5">
                    <Label htmlFor="acct-username">Username</Label>
                    <Input
                      id="acct-username"
                      value={shownUser || DASH}
                      readOnly
                      className="bg-muted/40 text-muted-foreground"
                    />
                    <p className="text-xs text-muted-foreground">Managed by your administrator.</p>
                  </div>

                  {/* Secondary email. */}
                  <div className="space-y-1.5">
                    <Label htmlFor="acct-alt-email">
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        Secondary email
                      </span>
                    </Label>
                    <Input
                      id="acct-alt-email"
                      type="email"
                      value={altEmail}
                      onChange={(e) => setAltEmail(e.target.value)}
                      placeholder="you@example.com"
                      maxLength={254}
                      disabled={!editable || saving}
                    />
                    <p className="text-xs text-muted-foreground">For notifications &amp; account recovery.</p>
                  </div>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  {/* Timezone. */}
                  <div className="space-y-1.5">
                    <Label htmlFor="acct-tz">
                      <span className="inline-flex items-center gap-1.5">
                        <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        Timezone
                      </span>
                    </Label>
                    <Select
                      value={timezone || NONE}
                      onValueChange={(v) => setTimezone(v === NONE ? '' : v)}
                      disabled={!editable || saving}
                    >
                      <SelectTrigger id="acct-tz">
                        <SelectValue placeholder="System default" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value={NONE}>System default</SelectItem>
                        {/* Surface a stored, off-list zone so it's never silently lost
                            (mirrors the Locale handling below) — e.g. a valid IANA zone
                            on a runtime without Intl.supportedValuesOf. */}
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
                  </div>

                  {/* Locale. */}
                  <div className="space-y-1.5">
                    <Label htmlFor="acct-locale">
                      <span className="inline-flex items-center gap-1.5">
                        <Languages className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        Language
                      </span>
                    </Label>
                    <Select
                      value={locale || NONE}
                      onValueChange={(v) => setLocale(v === NONE ? '' : v)}
                      disabled={!editable || saving}
                    >
                      <SelectTrigger id="acct-locale">
                        <SelectValue placeholder="System default" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value={NONE}>System default</SelectItem>
                        {/* Surface a stored, off-list locale so it's never silently lost. */}
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
                  </div>
                </div>

                {editable ? (
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <span className="mr-auto text-xs text-muted-foreground">
                      {profile?.last_login_at
                        ? `Last sign-in ${formatTimestamp(profile.last_login_at)}`
                        : null}
                    </span>
                    <Button type="submit" disabled={saving || !dirty}>
                      {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                      {saving ? 'Saving…' : 'Save changes'}
                    </Button>
                  </div>
                ) : null}
            </AccountSurface>
          </form>
        </>
      )}
    </div>
  );
}
